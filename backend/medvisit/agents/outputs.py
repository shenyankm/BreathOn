"""Typed validation of the coach and doctor JSON.

Structure errors (missing or wrongly typed fields, empty text, point count) still reject the reply, because they mean
the model did not follow the task. Length overruns are clipped with an ellipsis instead: a 1,300-character analysis is
still a usable analysis, and discarding the whole turn for it costs the trainee a reply.
"""
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError, field_validator
from typing import Annotated

TEXT_LIMIT = 1200
POINT_LIMIT = 300
DELIVERY_KEYS = ('tone', 'fluency', 'logic', 'turn_taking')
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Delivery(BaseModel):
    model_config = ConfigDict(extra='ignore')
    tone: Text
    fluency: Text
    logic: Text
    turn_taking: Text


class Coach(BaseModel):
    model_config = ConfigDict(extra='ignore')
    focus: Text
    analysis: Text
    reply: Text
    points: list[Text]
    risk: Annotated[str, StringConstraints(strip_whitespace=True)] = ''
    delivery: Delivery

    @field_validator('points')
    @classmethod
    def point_count(cls, value):
        if not 1 <= len(value) <= 4:
            raise ValueError('1 to 4 points are required')
        return value


class Reply(BaseModel):
    model_config = ConfigDict(extra='ignore')
    coach: Coach
    doctor_reply: str = ''


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def _clipped(data):
    """Clip string leaves of the coach object before validation; structure is left for pydantic to judge."""
    coach = data.get('coach') if isinstance(data, dict) else None
    if not isinstance(coach, dict):
        return data
    fixed = {**coach}
    for key in ('focus', 'analysis', 'reply', 'risk'):
        if isinstance(fixed.get(key), str):
            fixed[key] = _clip(fixed[key].strip(), TEXT_LIMIT)
    if isinstance(fixed.get('points'), list):
        fixed['points'] = [_clip(p.strip(), POINT_LIMIT) if isinstance(p, str) else p for p in fixed['points']]
    if isinstance(fixed.get('delivery'), dict):
        fixed['delivery'] = {k: _clip(v.strip(), TEXT_LIMIT) if isinstance(v, str) else v for k, v in fixed['delivery'].items()}
    return {**data, 'coach': fixed}


def clip_reply(data, *, speak: bool) -> dict:
    if not isinstance(data, dict):
        raise ValueError('无效的医生/教练结构')
    try:
        reply = Reply.model_validate(_clipped(data))
    except ValidationError as exc:
        raise ValueError('无效的医生/教练文字或结构') from exc
    doctor = reply.doctor_reply.strip()
    if speak and not doctor:
        raise ValueError('无效的医生文字')
    return {'doctor_reply': _clip(doctor, TEXT_LIMIT) if speak else '', 'coach': reply.coach.model_dump()}


def parse_doctor_reply(data) -> str:
    """The doctor agent returns {"doctor_reply": text}; empty or non-string text is rejected, long text is clipped."""
    value = data.get('doctor_reply') if isinstance(data, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise ValueError('无效的医生文字')
    return _clip(value.strip(), TEXT_LIMIT)
