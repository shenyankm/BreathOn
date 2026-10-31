"""Failure classification, one bounded retry for transient provider errors, and process-local counters.

A failed model call never produces invented content: callers get the real result, a typed error, or (live practice
only) the doctor's reply without the coach panel.
"""
import asyncio
import logging
from collections import Counter

from openai import APIConnectionError, APIStatusError, APITimeoutError

logger = logging.getLogger('medvisit.agents')

TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504, 529}
RETRY_DELAY = 0.5
COUNTS: Counter = Counter()      # process-local; exposed through snapshot() on the admin metrics endpoint


def count(name: str, amount: int = 1) -> None:
    COUNTS[name] += amount


def classify_error(error: BaseException) -> str:
    """Stable failure kind: provider/transient problems are kept apart from bad model output."""
    if isinstance(error, asyncio.CancelledError):
        return 'cancelled'
    if isinstance(error, (TimeoutError, APITimeoutError)):
        return 'timeout'
    if isinstance(error, APIStatusError):
        return 'rate_limited' if error.status_code == 429 else 'provider_error'
    if isinstance(error, APIConnectionError):
        return 'provider_error'
    if isinstance(error, (ValueError, TypeError, KeyError, IndexError)):
        return 'invalid_output'
    return 'service_error'


def transient(error: BaseException) -> bool:
    if isinstance(error, APITimeoutError):
        return False        # the client deadline already spent its budget; waiting again would break the turn deadline
    if isinstance(error, APIStatusError):
        return error.status_code in TRANSIENT_STATUS
    return isinstance(error, APIConnectionError)


async def call_with_retry(call, *, purpose: str):
    """Run `call()` once, and once more after a short pause when the first failure was transient."""
    try:
        return await call()
    except Exception as exc:
        if not transient(exc):
            raise
        count(f'retry.{purpose}')
        logger.warning('model_retry purpose=%s kind=%s', purpose, classify_error(exc))
        await asyncio.sleep(RETRY_DELAY)
        return await call()


def record_failure(purpose: str, error: BaseException) -> str:
    kind = classify_error(error)
    count(f'failed.{purpose}.{kind}')
    logger.warning('agent_failed purpose=%s kind=%s error_type=%s', purpose, kind, type(error).__name__)
    return kind


def snapshot() -> dict:
    return dict(sorted(COUNTS.items()))
