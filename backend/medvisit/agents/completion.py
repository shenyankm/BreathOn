"""One call path for single-shot JSON completions (no tools, no agent loop).

Agents built on AgentScope go through coach.make_model(). Services that only need one JSON answer use this instead, so
timeout, the shared DeepSeek concurrency gate, truncation handling and usage accounting are written once.
"""
import asyncio
import json

from openai import AsyncOpenAI

USAGE_FIELDS = {'prompt_tokens', 'completion_tokens', 'total_tokens'}


class IncompleteCompletion(ValueError):
    """The model stopped before finishing (finish_reason != 'stop'); the JSON cannot be trusted."""


async def json_completion(settings, record, *, purpose: str, system: str, user: dict, max_tokens: int,
                          timeout: float = 15, client_timeout: float = 12) -> dict:
    """Ask the configured model for one JSON object; usage is appended to record.data['usage'].

    Raises asyncio.TimeoutError, openai.APIError, IncompleteCompletion or json.JSONDecodeError (a ValueError).
    Callers decide the fallback; this function never invents a result.
    """
    client = AsyncOpenAI(api_key=settings.deepseek_api_key, base_url=settings.deepseek_endpoint.removesuffix('/chat/completions'),
                         timeout=client_timeout, max_retries=0)
    try:
        async with asyncio.timeout(timeout), settings._deepseek_slots:
            response = await client.chat.completions.create(
                model=settings.deepseek_model, temperature=0, max_tokens=max_tokens,
                response_format={'type': 'json_object'}, extra_body={'thinking': {'type': 'disabled'}},
                messages=[{'role': 'system', 'content': system},
                          {'role': 'user', 'content': json.dumps(user, ensure_ascii=False)}])
            if response.usage:
                record.data['usage'].append({'provider': 'deepseek', 'purpose': purpose, 'model': settings.deepseek_model,
                                             **response.usage.model_dump(include=USAGE_FIELDS)})
            if response.choices[0].finish_reason != 'stop':
                raise IncompleteCompletion(f'{purpose}: model output incomplete')
            return json.loads(response.choices[0].message.content or '')
    finally:
        await client.close()
