"""Guards for the coach/doctor agents: quoted text is real, routing is a table, prompt wording is pinned."""
import json
from pathlib import Path

import pytest

from medvisit.agents import prompts
from medvisit.agents.quotes import MARKER, apply_quote_check, verify_quotes
from medvisit.agents.routing import BASE_SKILL, ROUTES, coaching_skill_names, messages_in_scope

TRANSCRIPT = [
    {'speaker': 'doctor', 'text': '你说的改善，具体指哪个指标？'},
    {'speaker': 'trainee', 'text': '我们的研究显示   体重 下降了 12%。'},
]


def test_verbatim_quotes_survive_including_layout_whitespace():
    text, removed = verify_quotes('你说“体重下降了12%”，医生问「具体指哪个指标」。', TRANSCRIPT)
    assert removed == [] and '体重下降了12%' in text and '具体指哪个指标' in text


def test_invented_quote_is_replaced_not_the_whole_review():
    text, removed = verify_quotes('你说“所有患者都有效”，但“体重下降了12%”缺少对照。', TRANSCRIPT)
    assert removed == ['所有患者都有效']
    assert MARKER in text and '“体重下降了12%”' in text


def test_ascii_quotes_and_short_quotes_are_ignored():
    text, removed = verify_quotes('JSON 里的 "abc" 与“好”不是引文。', TRANSCRIPT)
    assert removed == [] and text == 'JSON 里的 "abc" 与“好”不是引文。'


def test_apply_quote_check_covers_prose_points_and_delivery_but_not_the_rewrite_example():
    coach = {'focus': '关注“编造的话”', 'analysis': '原话“体重下降了12%”', 'risk': '', 'reply': '可以说“我会先核对原文”',
             'points': ['不要说“保证有效”', '回应“具体指哪个指标”'],
             'delivery': {'fluency': '“凭空引用”', 'logic': '正常', 'tone': '“不检查的字段”', 'turn_taking': ''}}
    removed = apply_quote_check(coach, TRANSCRIPT)
    assert sorted(removed) == sorted(['编造的话', '保证有效', '凭空引用'])
    assert coach['reply'] == '可以说“我会先核对原文”'          # example wording is not a claim about the transcript
    assert coach['delivery']['tone'] == '“不检查的字段”'
    assert coach['points'][1] == '回应“具体指哪个指标”'


@pytest.mark.parametrize('text,extra', [
    ('我只有30秒。', []),
    ('NNT 是多少？', ['medical-rep-evidence-communication']),
    ('给一点好处费。', ['medical-rep-promotion-compliance']),
    ('所有患者都能获益。', ['medical-rep-evidence-communication', 'medical-rep-promotion-compliance']),
])
def test_routing_table_matches_the_documented_behaviour(text, extra):
    assert coaching_skill_names([{'role': 'trainee', 'text': text}]) == [BASE_SKILL, *extra]


def test_every_route_points_at_a_real_skill_directory():
    root = Path(prompts.__file__).parent / 'skills'
    assert BASE_SKILL in {p.name for p in root.iterdir()}
    assert all((root / skill / 'SKILL.md').is_file() for skill, _ in ROUTES)


def test_live_reply_scope_is_the_latest_message_per_role_and_review_is_everything():
    messages = [{'role': 'trainee', 'text': 'a'}, {'role': 'doctor', 'text': 'b'}, {'role': 'trainee', 'text': 'c'}, {'role': 'trainee', 'text': 'd'}]
    assert [m['text'] for m in messages_in_scope(messages, speak=True)] == ['d', 'b']
    assert messages_in_scope(messages, speak=False) == messages


def test_prompt_constants_are_nonempty_text_and_the_schema_is_json_serialisable():
    for name in ('SKILL_EMBEDDING', 'REFERENCE_CONTEXT', 'FREE_PRACTICE', 'FINAL_REVIEW', 'TRUNCATED_INPUT', 'MEDICAL_CHECKS',
                 'TRAINING_SCENARIO', 'WEB_SEARCH', 'SCHEMA_INSTRUCTION', 'DOCTOR_TURN', 'REPAIR_INSTRUCTION', 'PRACTICE_PROMPT', 'ANALYSIS_PROMPT'):
        assert isinstance(getattr(prompts, name), str) and getattr(prompts, name).strip(), name
    assert json.dumps(prompts.COACH_SCHEMA, ensure_ascii=False)


async def test_doctor_samples_with_variety_while_the_coach_stays_deterministic(tmp_path):
    import httpx2 as httpx
    from unittest.mock import patch
    from openai import AsyncClient
    from medvisit.agents.coach import generate_reply
    from test_bridge import settings
    from test_practice import REPLY

    seen = []
    def handler(request):
        payload = json.loads(request.content)
        seen.append(payload)
        is_doctor = '本次只扮演医生' in json.dumps(payload['messages'][0], ensure_ascii=False)
        body = {'doctor_reply': REPLY['doctor_reply']} if is_doctor else REPLY
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(body)}, 'finish_reason': 'stop', 'index': 0}]})

    messages = [{'id': 'd1', 'role': 'doctor', 'text': '你想先讨论哪项研究？', 'final': True},
                {'id': 'u1', 'role': 'trainee', 'text': '先看研究人群。', 'final': True}]
    cfg = settings(tmp_path)
    real = httpx.AsyncClient
    with patch('openai.AsyncClient', lambda **kw: AsyncClient(http_client=real(transport=httpx.MockTransport(handler)), **kw)):
        await generate_reply(cfg, messages, speak=True)
    by_role = {('doctor' if '本次只扮演医生' in json.dumps(p['messages'][0], ensure_ascii=False) else 'coach'): p for p in seen}
    assert by_role['coach']['temperature'] == 0
    assert by_role['doctor']['temperature'] == cfg.doctor_temperature == 0.3


def test_doctor_temperature_is_validated(monkeypatch):
    from medvisit.core.config import Settings
    monkeypatch.setenv('DOCTOR_TEMPERATURE', '1.5')
    with pytest.raises(ValueError, match='DOCTOR_TEMPERATURE'):
        Settings()


# --- the live evaluation set -------------------------------------------------------------------------------------
def test_every_live_case_has_machine_checks_and_every_check_has_a_case():
    import live_coaching
    from agent_eval import CHECKS
    ids = {case['id'] for case in live_coaching.CASES + live_coaching.DOCTOR_CASES}
    assert ids == set(CHECKS), (ids ^ set(CHECKS))


def test_eval_checks_fail_on_bad_output_and_pass_on_good_output():
    from agent_eval import score_case
    good = {'doctor_reply': '', 'coach': {'analysis': 'ARR 是 3 个百分点，RRR 为 25%，NNT 向上取整为 34。'}}
    bad = {'doctor_reply': '', 'coach': {'analysis': '下降了不少。'}}
    assert score_case('absolute_benefit', good)['passed']
    assert not score_case('absolute_benefit', bad)['passed']
    assert not score_case('absolute_benefit', None)['passed']
    assert not score_case('no_such_case', good)['passed']
    forbidden = {'doctor_reply': '我已经使用过玛仕度肽，我保证有效。', 'coach': {'analysis': '本人模拟'}}
    assert not score_case('doctor_identity_and_endorsement', forbidden)['passed']


def test_replaying_a_failed_generation_counts_as_a_failure_not_a_skip():
    from agent_eval import score_report
    summary = score_report({'model': 'm', 'results': [{'id': 'absolute_benefit', 'schema_valid': False, 'error_type': 'BridgeError'}]})
    assert summary['passed'] == 0 and summary['total'] == 1


E, C = 'medical-rep-evidence-communication', 'medical-rep-promotion-compliance'


@pytest.mark.parametrize('text,extra', [
    ('随机双盲三期的数据', [E]), ('p值是多少', [E]), ('显著性差异', [E]), ('随访52周的数据', [E]), ('头对头研究有吗', [E]),
    ('请你多开一些', [C]), ('我给您点辛苦费', [C]), ('给您拿点样品', [C]), ('加个微信私聊', [C]), ('适应症之外也能用', [C]),
    ('孕妇能不能吃', [C]), ('儿童剂量怎么算', [C]), ('肝肾功能不全怎么调整', [C]), ('禁忌症有哪些', [C]),
    ('把姓名电话和完整病历都发过来', [C]),
    # Small talk must not pull in a skill: these words used to trigger compliance on their own.
    ('我想了解一下您的姓名', []), ('请问怎么称呼您', []), ('我的电话是', []), ('所有人都知道', []),
    ('您好我是某公司的代表', []), ('我先介绍一下产品特点', []),
])
def test_routing_catches_common_rephrasings_and_ignores_small_talk(text, extra):
    assert coaching_skill_names([{'role': 'trainee', 'text': text}]) == [BASE_SKILL, *extra]


def test_routing_hits_are_counted_so_misses_show_up_in_the_metrics():
    from medvisit.agents import reliability
    reliability.COUNTS.clear()
    coaching_skill_names([{'role': 'trainee', 'text': '您好'}])
    coaching_skill_names([{'role': 'trainee', 'text': '孕妇能不能吃'}])
    assert reliability.snapshot() == {'routing.none': 1, 'routing.promotion-compliance': 1}


# --- offline regression gate over recorded outputs ---------------------------------------------------------------
GOLDEN = Path(__file__).parent / 'fixtures' / 'coaching-golden.json'


def test_golden_outputs_still_satisfy_the_machine_checks():
    """Fails when a check (or the output schema) changes in a way that no longer accepts known-good answers."""
    from agent_eval import score_case
    from medvisit.agents.outputs import clip_reply
    cases = json.loads(GOLDEN.read_text(encoding='utf-8'))['cases']
    assert len(cases) >= 10
    for case in cases:
        assert score_case(case['id'], case['output'])['passed'], case['id']
        clip_reply(case['output'], speak=bool(case['output'].get('doctor_reply')))     # recorded output is still valid under the live schema


def test_every_golden_case_has_a_live_case_and_the_pass_rate_floor_holds():
    import live_coaching
    from agent_eval import score_report
    golden = json.loads(GOLDEN.read_text(encoding='utf-8'))['cases']
    live_ids = {case['id'] for case in live_coaching.CASES + live_coaching.DOCTOR_CASES}
    assert {case['id'] for case in golden} <= live_ids
    summary = score_report({'model': 'golden', 'results': [{'id': c['id'], 'schema_valid': True, 'output': c['output']} for c in golden]})
    assert summary['rate'] == 1.0, [row for row in summary['cases'] if not row['passed']]


def test_replay_gate_rejects_a_report_below_the_floor():
    from agent_eval import REGRESSION_FLOOR, gate
    assert gate({'rate': REGRESSION_FLOOR, 'total': 14}) is True
    assert gate({'rate': REGRESSION_FLOOR - 0.01, 'total': 14}) is False
    assert gate({'rate': 1.0, 'total': 0}) is False          # an empty report is not a pass
