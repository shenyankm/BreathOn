from datetime import date, datetime, timezone
from typing import Literal
from pydantic import Field, field_validator, model_validator
from .input import Input
from ..agents.web_search import public_url


class Page(Input):
    number: int = Field(ge=1, le=2000)
    text: str = Field(min_length=1, max_length=20000)


class Content(Input):
    title: str = Field(min_length=1, max_length=180)
    version_label: str = Field(min_length=1, max_length=40)
    scope: str = Field(min_length=1, max_length=1000)
    source_url: str = Field(default='', max_length=8192)
    publication_date: date | None = None
    expires_at: datetime | None = None
    pages: list[Page] = Field(min_length=1, max_length=200)
    asset_id: str | None = Field(default=None, max_length=80)

    @field_validator('source_url')
    @classmethod
    def source(cls, value):
        if value and not public_url(value):
            raise ValueError('来源必须为不含凭据的公开 HTTP(S) 链接')
        return value

    @model_validator(mode='after')
    def pages_valid(self):
        numbers = [p.number for p in self.pages]
        if len(numbers) != len(set(numbers)) or sum(len(p.text) for p in self.pages) > 1_000_000:
            raise ValueError('页码必须唯一，正文总计不超过100万字符')
        if self.expires_at and self.expires_at.tzinfo is None:
            raise ValueError('到期时间必须含时区')
        return self


class ContentEdit(Content):
    version: int = Field(ge=1)


class Transition(Input):
    version: int = Field(ge=1)
    action: Literal['submit', 'approve', 'reject', 'retire']
    reason: str = Field(min_length=1, max_length=2000)


class Doctor(Input):
    name: str = Field(min_length=1, max_length=60)
    specialty: str = Field(min_length=1, max_length=80)
    background_type: Literal['fictional', 'public'] = 'fictional'
    public_facts: str = Field(default='', max_length=3000)
    sources: list[str] = Field(default_factory=list, max_length=8)
    population: str = Field(min_length=1, max_length=1000)
    focus: str = Field(min_length=1, max_length=1000)
    training_style: str = Field(min_length=1, max_length=1000)
    mood: Literal['neutral', 'busy', 'skeptical', 'friendly'] = 'neutral'
    opening: str = Field(min_length=1, max_length=400)
    research_job_id: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode='after')
    def sources_valid(self):
        if any(not public_url(url) for url in self.sources):
            raise ValueError('来源必须为公开 HTTP(S) 链接')
        if self.background_type == 'public' and (not self.sources or not self.public_facts):
            raise ValueError('公开人物背景必须提供事实与来源')
        return self


class DoctorEdit(Doctor):
    version: int = Field(ge=1)


STAGES = ('full', 'opening', 'needs', 'evidence', 'objections', 'safety', 'closing')
STAGE_LABELS = dict(zip(STAGES, ('完整拜访', '开场', '需求探询', '研究介绍', '异议处理', '安全沟通', '收尾')))


class Dimension(Input):
    key: str = Field(pattern=r'^[a-z][a-z_]{1,40}$')
    label: str = Field(min_length=1, max_length=60)
    weight: int = Field(ge=1, le=100)
    anchors: list[str] = Field(min_length=5, max_length=5)
    requires_content: bool = False

    @field_validator('anchors')
    @classmethod
    def bounded_anchors(cls, values):
        if any(not value.strip() or len(value) > 500 for value in values):
            raise ValueError('每个评分锚点需为1至500字符')
        return values


class Rubric(Input):
    name: str = Field(min_length=1, max_length=100)
    dimensions: list[Dimension] = Field(min_length=1, max_length=10)

    @model_validator(mode='after')
    def weights_valid(self):
        if sum(d.weight for d in self.dimensions) != 100 or len({d.key for d in self.dimensions}) != len(self.dimensions):
            raise ValueError('权重合计必须为100，维度标识不能重复')
        return self


class RubricEdit(Rubric):
    version: int = Field(ge=1)


class Scenario(Input):
    title: str = Field(min_length=1, max_length=160)
    product: str = Field(min_length=1, max_length=120)
    disease: str = Field(min_length=1, max_length=120)
    objective: str = Field(min_length=1, max_length=1500)
    doctor_id: str = Field(min_length=1, max_length=80)
    rubric_id: str = Field(min_length=1, max_length=80)
    content_ids: list[str] = Field(default_factory=list, max_length=12)
    stages: list[Literal['opening', 'needs', 'evidence', 'objections', 'safety', 'closing']] = Field(min_length=1, max_length=6)
    duration_seconds: int = Field(default=300, ge=30, le=600)
    difficulty: Literal['basic', 'intermediate', 'advanced'] = 'basic'
    situation: Literal['first_visit', 'follow_up', 'time_pressure', 'evidence_challenge'] = 'first_visit'
    background: str = Field(default='', max_length=2000)
    opening: str = Field(default='', max_length=400)
    objections: list[str] = Field(default_factory=list, max_length=8)
    success_criteria: list[str] = Field(default_factory=list, max_length=8)

    @field_validator('objections', 'success_criteria')
    @classmethod
    def bounded_points(cls, values):
        if any(not value.strip() or len(value) > 500 for value in values):
            raise ValueError('每条训练要点需为1至500字符')
        return values

    @model_validator(mode='after')
    def unique_bindings(self):
        if len(set(self.content_ids)) != len(self.content_ids) or len(set(self.stages)) != len(self.stages):
            raise ValueError('资料和环节不得重复')
        return self


class ScenarioEdit(Scenario):
    version: int = Field(ge=1)


class Publish(Input):
    version: int = Field(ge=1)


def content_usable(item, current=None):
    if not item or item.get('status') != 'approved':
        return False
    expiry = item.get('expires_at')
    return not expiry or datetime.fromisoformat(expiry) > (current or datetime.now(timezone.utc))






