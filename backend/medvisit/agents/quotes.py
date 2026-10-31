"""Code-level check for the prompt rule "text in quotation marks must be verbatim from the transcript".

Coach prose may quote the trainee or the doctor. A quote that is not found in the transcript is replaced by a neutral
paraphrase marker instead of failing the whole reply, so one misquoted phrase cannot discard a useful review.
"""
import re

# Chinese curly quotes and corner brackets only. Straight ASCII quotes are left alone: they appear in JSON-like text.
QUOTE = re.compile(r'[“「『]([^”」』]{2,200})[”」』]')
MARKER = '（引文未能与原话核对，已省略）'
# Fields in the coach object that are prose and may quote the transcript.
PROSE_FIELDS = ('focus', 'analysis', 'risk')


def _squash(text: str) -> str:
    # Same normalisation as the assessment validator: layout whitespace is not content.
    return re.sub(r'\s+', '', text)


def verify_quotes(text: str, transcript: list[dict]) -> tuple[str, list[str]]:
    """Return (text with unverifiable quotes replaced, the quotes that were removed)."""
    haystack = _squash(''.join(m['text'] for m in transcript))
    removed: list[str] = []

    def check(match: re.Match) -> str:
        if _squash(match.group(1)) in haystack:
            return match.group(0)
        removed.append(match.group(1))
        return MARKER

    return QUOTE.sub(check, text), removed


def apply_quote_check(coach: dict, transcript: list[dict]) -> list[str]:
    """Check the prose fields and the suggestion points in place; returns every removed quote."""
    removed: list[str] = []
    for key in PROSE_FIELDS:
        if isinstance(coach.get(key), str):
            coach[key], found = verify_quotes(coach[key], transcript)
            removed += found
    points = []
    for point in coach.get('points', []):
        point, found = verify_quotes(point, transcript)
        points.append(point)
        removed += found
    coach['points'] = points
    delivery = coach.get('delivery')
    if isinstance(delivery, dict):
        for key in ('fluency', 'logic'):
            if isinstance(delivery.get(key), str):
                delivery[key], found = verify_quotes(delivery[key], transcript)
                removed += found
    return removed
