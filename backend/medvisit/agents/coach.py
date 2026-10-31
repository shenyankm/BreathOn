"""Doctor and coach inference through AgentScope, one stateless request per turn.

generate_reply() is the only entry point. It runs four steps: build_coach_prompt() -> run_agents() ->
score_with_repair() -> summarise_usage(). Prompt wording lives in prompts.py, skill routing in routing.py.
"""
import asyncio
import json
from pathlib import Path
from time import monotonic

from agentscope.agent import Agent, InjectionConfig, ReActConfig
from agentscope.credential import OpenAICredential
from agentscope.message import Msg, TextBlock
from agentscope.model import OpenAIChatModel
from agentscope.skill import LocalSkillLoader
from openai import APIError

from ..voice.protocol import BridgeError
from .doctor import OPENING  # noqa: F401  re-exported
from .outputs import clip_reply, parse_doctor_reply  # noqa: F401  parse_reply is defined here for existing callers
from .quotes import apply_quote_check
from .reliability import call_with_retry, count, record_failure
from .routing import coaching_skill_names  # noqa: F401  re-exported
from . import prompts
from .prompts import (  # noqa: F401  re-exported
    ANALYSIS_PROMPT, COACH_SCHEMA, NO_REVIEWED_SOURCE, PRACTICE_PROMPT,
)
from ..platform.training import context as training_context, doctor_instructions
from ..platform.evaluation import ASSESSMENT_PROMPT, APPLICABILITY_PROMPT, validate_assessment, apply_applicability
from .web_search import WebSearch

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
SKILL_ROOT = Path(__file__).resolve().parent / "skills"
HUMANIZER_SKILL = LocalSkillLoader(str(SKILL_ROOT / "humanizer"))
COACHING_SKILLS = {name: LocalSkillLoader(str(SKILL_ROOT / name)) for name in (
    "medical-rep-academic-visit", "medical-rep-evidence-communication", "medical-rep-promotion-compliance",
)}
MAX_HISTORY = 16        # live replies see only the latest turns; a full review sees everything
MAX_MESSAGE_CHARS = 4000
MAX_TOTAL_CHARS = 64000
COACH_TEMPERATURE = 0   # scoring and coaching must be repeatable
JSON_ONLY = {"response_format": {"type": "json_object"}, "thinking": {"type": "disabled"}}


def interaction_summary(interactions) -> str:
    ended = next((item.get("status") for item in reversed(interactions) if item.get("type") == "capture_end"), None)
    ending = "采集完整结束。" if ended == "completed" else "未提供结束状态，完整性未知。" if ended is None else "采集未完整结束，仅覆盖已收到内容。"
    clicks = sum(item.get("type") == "manual_interrupt" for item in interactions)
    return f"记录了{clicks}次点击打断按钮。{ending}按钮事件和播放重叠不能证明学员插话，插话证据不足。"



class CoachModel(OpenAIChatModel):
    def __init__(self, *args, concurrency, **kwargs):
        self.concurrency = concurrency
        super().__init__(*args, **kwargs)

    async def _call_api(self, *args, **kwargs):
        async with self.concurrency:
            return await call_with_retry(lambda: super(CoachModel, self)._call_api(*args, **kwargs), purpose='agent_call')

    def _parse_completion_response(self, started, response, audio_format="wav"):
        # AgentScope 2.0.11 drops finish_reason; reject truncated JSON before parsing.
        if response.choices and response.choices[0].finish_reason == "length":
            raise ValueError("模型输出未完成")
        return super()._parse_completion_response(started, response, audio_format)



def make_model(settings, *, temperature: float, timeout: float, max_tokens: int, extra: dict | None = None, model: str = "") -> "CoachModel":
    """One construction point for every DeepSeek-backed agent: same credential, concurrency gate and JSON mode."""
    return CoachModel(
        concurrency=settings._deepseek_slots,
        credential=OpenAICredential(api_key=settings.deepseek_api_key, base_url=settings.deepseek_endpoint.removesuffix("/chat/completions")),
        model=model or settings.deepseek_model, stream=False, max_retries=0, context_size=1_000_000,
        parameters=CoachModel.Parameters(temperature=temperature),
        client_kwargs={"timeout": timeout, "max_retries": 0},
        extra_body={**JSON_ONLY, "max_tokens": max_tokens, **(extra or {})},
    )


def parse_reply(content: str, *, speak=True) -> dict:
    """Validate the coach JSON. Over-long prose is clipped instead of failing the turn; structure errors still raise."""
    return clip_reply(json.loads(content), speak=speak)


def _visible_history(messages: list[dict], speak: bool):
    """Clip the transcript to the size limits; returns (history, visible, selected, remaining)."""
    selected = messages[-MAX_HISTORY:] if speak else messages
    history, visible, remaining = [], [], MAX_TOTAL_CHARS
    for m in selected:
        text = m["text"][:min(MAX_MESSAGE_CHARS, remaining)]
        if not text:
            break
        remaining -= len(text)
        visible.append({"role": m["role"], "text": text})
        history.append({"id": m.get('id', f'm{len(history)}'), "speaker": m["role"], "text": text, "final": m.get("final", False), "capture": m.get("speech", {})})
    return history, visible, selected, remaining


async def _load_skills(visible: list[dict], speak: bool) -> list[str]:
    names = coaching_skill_names(visible, speak=speak)
    lists = await asyncio.gather(HUMANIZER_SKILL.list_skills(), *(COACHING_SKILLS[name].list_skills() for name in names))
    humanizer, = lists[0]
    parts = [humanizer.markdown]
    for name, skills in zip(names, lists[1:]):
        skill, = skills
        parts.append(f'<coaching_skill name="{name}">\n{skill.markdown}\n</coaching_skill>')
    return parts


def build_coach_prompt(skill_parts, *, speak, training, medical_checks, free_context, reference_context, interactions,
                       history, visible, selected, remaining, search_enabled) -> tuple[str, dict]:
    """Assemble the coach system prompt and the JSON schema the model must fill in."""
    has_source = training or reference_context and reference_context.get("evidence")
    prompt = "\n\n".join(skill_parts) + prompts.SKILL_EMBEDDING + PRACTICE_PROMPT + ANALYSIS_PROMPT + ("" if has_source else NO_REVIEWED_SOURCE)
    if reference_context:
        prompt += prompts.REFERENCE_CONTEXT
    if free_context:
        prompt += prompts.FREE_PRACTICE + json.dumps(free_context, ensure_ascii=False)
    if not speak:
        prompt += prompts.FINAL_REVIEW
    if remaining == 0 or any(len(m["text"]) > MAX_MESSAGE_CHARS for m in selected):
        prompt += prompts.TRUNCATED_INPUT
    prompt += (
        f'\n本次可见输入：医生消息{sum(m["role"] == "doctor" for m in visible)}条，'
        f'学员消息{sum(m["role"] == "trainee" for m in visible)}条；分句不等于轮次，不猜总轮数。'
        f'{interaction_summary(interactions)}未提供可听音频。'
    )
    if medical_checks:
        prompt += prompts.MEDICAL_CHECKS
    if training:
        prompt += prompts.TRAINING_SCENARIO + ASSESSMENT_PROMPT
    if search_enabled:
        prompt += prompts.WEB_SEARCH
    schema = json.loads(json.dumps(COACH_SCHEMA))
    if training:
        schema['assessment'] = {'dimensions': [{'key': d['key'], 'score': None, 'reason': '按锚点评价；未观察或资料不足则说明原因',
            'utterances': [], 'citations': []} for d in training['rubric']['dimensions']]}
    return prompt + prompts.SCHEMA_INSTRUCTION + json.dumps(schema, ensure_ascii=False), schema


def build_agents(model, doctor_model, web, settings, *, prompt, skill_parts, training, free_context, speak) -> list:
    """Coach first; the doctor agent is added for live replies only."""
    agents = [Agent(
        name="doctor_coach", system_prompt=prompt, model=model,
        toolkit=web.toolkit() if settings.deepseek_search_enabled else None,
        injection_config=InjectionConfig(inject_runtime_state=False),
        react_config=ReActConfig(max_iters=3 if settings.deepseek_search_enabled else 1, interruption_raise_cancelled_error=True),
    )]
    if speak:
        doctor_prompt = "\n\n".join(skill_parts) + "\n" + doctor_instructions(training, with_evidence=False, **({'free_context': free_context} if free_context else {})) + prompts.DOCTOR_TURN
        agents.append(Agent(
            name="scenario_doctor" if training else "free_practice_doctor" if free_context else "li_xiaoying_doctor", system_prompt=doctor_prompt, model=doctor_model,
            injection_config=InjectionConfig(inject_runtime_state=False),
            react_config=ReActConfig(max_iters=1, interruption_raise_cancelled_error=True),
        ))
    return agents


async def run_agents(agents, record: str, coach_record: str, *, coach_deadline: float | None = None) -> list:
    """Run coach and doctor concurrently on the same record and return one outcome per agent (reply or exception).

    The caller decides what a failure means: a live turn can still deliver the doctor without the coach, but a review
    cannot. Cancellation is never swallowed.
    """
    async def run(index, agent):
        text = coach_record if index == 0 else record
        async with asyncio.timeout(coach_deadline if index == 0 else None):
            return await agent.reply(Msg(name="practice_record", role="user", content=[TextBlock(text=text)]))

    replies = await asyncio.gather(*[run(index, agent) for index, agent in enumerate(agents)], return_exceptions=True)
    if asyncio.current_task().cancelling():
        raise asyncio.CancelledError
    for reply in replies:
        if isinstance(reply, asyncio.CancelledError):
            raise reply
    return replies


async def score_with_repair(coach_agent, model, replies, result, training, training_view, history, settings) -> tuple[dict, bool]:
    """Validate scoring evidence, repair once within the request deadline, then have a second agent check admissibility.

    Evidence checks are never relaxed. Returns (assessment, repair_usage_unknown).
    """
    raw = json.loads(replies[0].get_text_content() or '{}')
    assessment = validate_assessment(raw.get('assessment'), training_view, history, settings.deepseek_model)
    repair_usage_unknown = False
    if assessment['validation_errors']:
        initial_errors = assessment['validation_errors']
        repair_usage_unknown = True
        try:
            async with asyncio.timeout(8):
                repaired = await coach_agent.reply(Msg(name='assessment_validation', role='user', content=[TextBlock(text=json.dumps({
                    'validation_errors': initial_errors, 'instruction': prompts.REPAIR_INSTRUCTION,
                }, ensure_ascii=False))]))
                replies.append(repaired)
                repair_usage_unknown = repaired.usage is None
                repaired_text = repaired.get_text_content() or ''
                repaired_result = parse_reply(repaired_text, speak=False)
                repaired_assessment = validate_assessment(json.loads(repaired_text).get('assessment'), training_view, history, settings.deepseek_model)
                if not repaired_assessment['validation_errors']:
                    result.update(repaired_result)
                    assessment = repaired_assessment
        except (APIError, TimeoutError, ValueError, TypeError, KeyError, RuntimeError):
            pass
        assessment['initial_validation_errors'] = initial_errors
    required = {d['key'] for d in training['rubric']['dimensions'] if d['requires_content']}
    candidates = [d for d in assessment['dimensions'] if d['key'] in required and d['score'] is not None]
    if candidates:
        # A different model family decorrelates review errors from scoring errors; empty config reuses the scorer.
        reviewer = make_model(settings, temperature=COACH_TEMPERATURE, timeout=settings.model_timeout, max_tokens=800,
            model=settings.deepseek_review_model) if settings.deepseek_review_model else model
        review_agent = Agent(name='evidence_admissibility_reviewer', system_prompt=APPLICABILITY_PROMPT, model=reviewer,
            injection_config=InjectionConfig(inject_runtime_state=False),
            react_config=ReActConfig(max_iters=1, interruption_raise_cancelled_error=True))
        review_input = [{'key': d['key'], 'label': d['label'], 'utterances': d['utterances'], 'materials': d['citations']} for d in candidates]
        keys = {d['key'] for d in candidates}
        try:
            reviewed = await review_agent.reply(Msg(name='evidence_check', role='user', content=[TextBlock(text=json.dumps(review_input, ensure_ascii=False))]))
            replies.append(reviewed)
            assessment = apply_applicability(assessment, json.loads(reviewed.get_text_content() or '{}'), keys)
        except (APIError, ValueError, TypeError, KeyError) as exc:
            record_failure('applicability_review', exc)
            assessment = apply_applicability(assessment, {}, keys, available=False)
        finally:
            if reviewer is not model:
                await reviewer.client.close()
        assessment['review_model'] = settings.deepseek_review_model or settings.deepseek_model
    return assessment, repair_usage_unknown


def summarise_usage(replies, web, settings, started, repair_usage_unknown) -> dict:
    usage = [reply.usage for reply in replies if reply.usage]
    totals = {"prompt_tokens": sum(item.input_tokens for item in usage),
              "completion_tokens": sum(item.output_tokens for item in usage),
              "total_tokens": sum(item.input_tokens + item.output_tokens for item in usage)} if usage else {}
    if repair_usage_unknown:
        totals['incomplete'] = True
    if sum(web.calls.values()):
        totals.update(search_requests=web.calls["search"], fetch_requests=web.calls["fetch"])
    totals.update(model=settings.deepseek_model, elapsed_seconds=round(monotonic() - started, 3))
    return totals


def degraded_coach(kind: str) -> dict:
    """Shown when only the coach failed during a live turn: no invented analysis, just an honest placeholder."""
    return {"focus": "本轮教练分析暂未完成", "analysis": "医生已回应，本轮教练提示暂时不可用；你可以继续发言，最终复盘不受影响。",
            "points": ["继续按原计划回应医生的问题。"], "risk": "", "reply": "本轮暂无参考话术。",
            "delivery": {"tone": "本轮未分析；声音语调未评估。", "fluency": "本轮未分析。", "logic": "本轮未分析。",
                         "turn_taking": "本轮未分析。"},
            "degraded": kind}


async def generate_reply(settings, messages: list[dict], *, speak=True, interactions=(), training=None, medical_checks=(), free_context=None, reference_context=None) -> tuple[dict, dict]:
    started = monotonic()
    history, visible, selected, remaining = _visible_history(messages, speak)
    skill_parts = await _load_skills(visible, speak)
    prompt, _ = build_coach_prompt(skill_parts, speak=speak, training=training, medical_checks=medical_checks,
        free_context=free_context, reference_context=reference_context, interactions=interactions, history=history,
        visible=visible, selected=selected, remaining=remaining, search_enabled=settings.deepseek_search_enabled)
    training_view = training_context(training, history) if training else None
    max_tokens = 4000 if training else 2000
    model = make_model(settings, temperature=COACH_TEMPERATURE, timeout=settings.model_timeout, max_tokens=max_tokens)
    # The doctor speaks, so it gets a little sampling variety; the coach scores, so it stays at 0. Everything else is shared.
    doctor_model = make_model(settings, temperature=settings.doctor_temperature, timeout=settings.model_timeout, max_tokens=max_tokens) if speak else model
    web = WebSearch(model.client, settings)
    agents = build_agents(model, doctor_model, web, settings, prompt=prompt, skill_parts=skill_parts, training=training, free_context=free_context, speak=speak)
    turn_budget = settings.model_timeout + (25 if settings.deepseek_search_enabled else 5)
    purpose = "practice_turn" if speak else "review"
    try:
        async with asyncio.timeout(turn_budget):
            record = json.dumps({"transcript": history, "interaction_events": list(interactions[-30:]),
                **({'medical_checks': list(medical_checks)[-12:]} if medical_checks else {}),
                **({'training': training_view} if training_view else {}),
                **({'free_context': free_context} if free_context else {})}, ensure_ascii=False)
            coach_record = json.dumps({**json.loads(record), 'reference_context': reference_context}, ensure_ascii=False) if reference_context else record
            # A live coach that overruns is dropped so the doctor still answers; a review has no such fallback.
            replies = await run_agents(agents, record, coach_record, coach_deadline=turn_budget - 10 if speak else None)
            doctor_reply = None
            if speak:
                if isinstance(replies[1], BaseException):
                    raise replies[1]
                doctor_reply = parse_doctor_reply(json.loads(replies[1].get_text_content() or ""))
            coach_failure = replies[0] if isinstance(replies[0], BaseException) else None
            if coach_failure is not None and not speak:
                raise coach_failure
            repair_usage_unknown = False
            if coach_failure is not None:
                kind = record_failure("coach_degraded", coach_failure)
                result = {"doctor_reply": "", "coach": degraded_coach(kind)}
                replies = [replies[1]]
            else:
                try:
                    result = parse_reply(replies[0].get_text_content() or "", speak=False)
                    if training:
                        assessment, repair_usage_unknown = await score_with_repair(agents[0], model, replies, result, training, training_view, history, settings)
                        result['coach']['assessment'] = assessment
                        if assessment['validation_errors']:
                            result['coach'].update(analysis='本轮评价的原话或资料引用未通过完整校验，暂不展示未经核对的纠错结论。',
                                reply='我会先核对研究原文和适用范围，再回应这个问题。',
                                points=['核对原话、资料版本与引用页码后重练。'], risk='本轮结构化评分存在校验问题，暂不形成能力结论。')
                            count("assessment.validation_failed")
                except (APIError, TimeoutError, ValueError, KeyError, IndexError, TypeError, RuntimeError) as exc:
                    if not speak:
                        raise
                    kind = record_failure("coach_degraded", exc)
                    result = {"doctor_reply": "", "coach": degraded_coach(kind)}
                    replies = [replies[1]]
            if speak:
                result["doctor_reply"] = doctor_reply
            # Quotation marks in the review must come from the transcript, not from the model's memory.
            removed = apply_quote_check(result["coach"], history)
            if removed:
                result["coach"]["quotes_removed"] = len(removed)
                count("quotes.removed", len(removed))
            # These are captured facts, not model judgments about the generated dialogue.
            result["coach"]["delivery"]["turn_taking"] = interaction_summary(interactions)
            if "声音语调未评估" not in result["coach"]["delivery"]["tone"]:
                result["coach"]["delivery"]["tone"] += "；声音语调未评估。"
            if web.sources:
                result["coach"]["sources"] = web.sources
            count(f"ok.{purpose}")
            return result, summarise_usage(replies, web, settings, started, repair_usage_unknown)
    except (APIError, TimeoutError, ValueError, KeyError, IndexError, TypeError, RuntimeError) as exc:
        record_failure(purpose, exc)
        raise BridgeError("practice_model_error", "AI 分析暂时未完成，请重试或继续发言，并核对 DeepSeek 模型权限和配置。") from exc
    finally:
        await model.client.close()
        if doctor_model is not model:
            await doctor_model.client.close()
