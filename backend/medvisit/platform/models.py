from datetime import date, datetime, timezone
from typing import Literal
from pydantic import Field, field_validator, model_validator
from .input import Input
from .departments import DRUG_DEPARTMENTS, department
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


class Policy(Content):
    text_is_summary: bool = False
    issuer: str = Field(default='', max_length=200)
    document_number: str = Field(default='', max_length=100)
    level: str = Field(default='', max_length=40)
    jurisdiction: str = Field(default='', max_length=200)
    effective_date: date | None = None
    end_date: date | None = None
    legal_status: Literal['draft', 'pending', 'effective', 'expired', 'unknown'] = 'unknown'
    supersedes: str = Field(default='', max_length=200)

    @model_validator(mode='after')
    def valid_dates(self):
        if self.effective_date and self.end_date and self.end_date < self.effective_date:
            raise ValueError('失效日期不能早于施行日期。')
        return self


class PolicyEdit(Policy):
    version: int = Field(ge=1)


class PolicyRule(Input):
    name: str = Field(min_length=1, max_length=150)
    policy_id: str = Field(min_length=1, max_length=80)
    article: str = Field(min_length=1, max_length=200)
    quote: str = Field(min_length=1, max_length=1000)
    scope: str = Field(min_length=1, max_length=1000)
    risk: Literal['low', 'medium', 'high']
    action: Literal['warn', 'pause'] = 'warn'
    examples: list[str] = Field(default_factory=list, max_length=20)


class PolicyRuleEdit(PolicyRule):
    version: int = Field(ge=1)


class DrugComparison(Input):
    drug_id: str = Field(min_length=1, max_length=80)
    relation: Literal['mechanism', 'indication']
    reason: str = Field(min_length=1, max_length=1000)
    source_url: str = Field(min_length=1, max_length=8192)

    @field_validator('source_url')
    @classmethod
    def source(cls, value):
        if not public_url(value):
            raise ValueError('来源必须为公开 HTTP(S) 链接。')
        return value


class Drug(Input):
    practice_departments: list[str] = Field(default_factory=list, max_length=30)

    @model_validator(mode='before')
    @classmethod
    def default_departments(cls, data):
        if isinstance(data, dict) and 'practice_departments' not in data:
            data = {**data, 'practice_departments': DRUG_DEPARTMENTS.get(str(data.get('name', '')).strip(), [])}
        return data

    @field_validator('practice_departments')
    @classmethod
    def valid_departments(cls, values):
        if any(not value.strip() or len(value) > 80 for value in values):
            raise ValueError('科室名称必须为1至80字符。')
        return list(dict.fromkeys(department(value) for value in values))

    name: str = Field(min_length=1, max_length=120)
    brand: str = Field(default='', max_length=120)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    company: str = Field(default='', max_length=200)
    manufacturer: str = Field(default='', max_length=200)
    overview: str = Field(default='', max_length=4000)
    source_url: str = Field(default='', max_length=8192)
    ownership: Literal['company', 'competitor', 'unknown'] = 'unknown'
    category: str = Field(default='', max_length=100)
    diseases: list[str] = Field(default_factory=list, max_length=30)
    mechanism: str = Field(default='', max_length=200)
    dosage_form: str = Field(default='', max_length=100)
    regions: list[str] = Field(default_factory=list, max_length=30)
    indications: list[str] = Field(default_factory=list, max_length=30)
    content_ids: list[str] = Field(default_factory=list, max_length=30)
    comparisons: list[DrugComparison] = Field(default_factory=list, max_length=30)

    @field_validator('aliases', 'diseases', 'regions', 'indications', 'content_ids')
    @classmethod
    def bounded_values(cls, values):
        if any(not value.strip() or len(value) > 500 for value in values):
            raise ValueError('列表内容必须为1至500字符。')
        return values

    @field_validator('source_url')
    @classmethod
    def source(cls, value):
        if value and not public_url(value):
            raise ValueError('来源必须为公开 HTTP(S) 链接。')
        return value


class DrugEdit(Drug):
    version: int = Field(ge=1)


class TaxonomyTerm(Input):
    value: str = Field(min_length=1, max_length=200)
    status: Literal['active', 'pending']


class TaxonomyEdit(Input):
    version: int = Field(ge=1)
    terms: list[TaxonomyTerm] = Field(max_length=1000)

    @model_validator(mode='after')
    def unique_terms(self):
        if len({term.value.casefold() for term in self.terms}) != len(self.terms):
            raise ValueError('分类词不能重复。')
        return self


class Transition(Input):
    version: int = Field(ge=1)
    action: Literal['submit', 'approve', 'reject', 'retire']
    reason: str = Field(min_length=1, max_length=2000)


class Doctor(Input):
    name: str = Field(min_length=1, max_length=60)
    specialty: str = Field(min_length=1, max_length=80)
    hospital: str = Field(default='', max_length=200)
    professional_title: str = Field(default='', max_length=100)
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
    drug_id: str | None = Field(default=None, max_length=80)
    competitor_id: str | None = Field(default=None, max_length=80)
    policy_ids: list[str] = Field(default_factory=list, max_length=12)
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


def policy_usable(item, current=None):
    if not content_usable(item, current) or item.get('legal_status') != 'effective':
        return False
    today = (current or datetime.now(timezone.utc)).date()
    return (not item.get('effective_date') or date.fromisoformat(item['effective_date']) <= today) and (
        not item.get('end_date') or date.fromisoformat(item['end_date']) >= today)






