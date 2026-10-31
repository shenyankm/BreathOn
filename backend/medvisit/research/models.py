from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..platform.input import Input

ResearchKind = Literal['doctor', 'drug']


class DoctorResearchRequest(Input):
    name: str = Field(min_length=1, max_length=60)
    hospital: str = Field(min_length=1, max_length=80)
    department: str = Field(min_length=1, max_length=50)

    @property
    def kind(self):
        return 'doctor'

    @property
    def query(self):
        return f'{self.name} {self.hospital} {self.department}'


class ResearchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: ResearchKind
    query: str = Field(min_length=2, max_length=200)

    @field_validator('query')
    @classmethod
    def clean_query(cls, value):
        if len(value.strip()) < 2:
            raise ValueError('请输入公开检索主题。')
        return value.strip()


class WatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool


class DoctorDraftRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    finding_index: int = Field(ge=0, le=4)
    confirmed_name: str = Field(min_length=1, max_length=60)
    confirmed_identity: Literal[True]


class PolicyDraftRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    source_version: str = Field(pattern=r'^[a-f0-9]{64}$')


class FindingDetail(BaseModel):
    model_config = ConfigDict(extra='forbid')
    label: str = Field(min_length=1, max_length=40)
    value: str = Field(min_length=1, max_length=600)
    source_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    evidence_id: str = Field(pattern=r'^E[1-9][0-9]{0,5}-[a-f0-9]{12}$')


class Finding(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=200)
    details: list[FindingDetail] = Field(min_length=1, max_length=12)
    caveats: list[str] = Field(max_length=5)


class ResearchResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    findings: list[Finding] = Field(max_length=5)
    further_checks: list[str] = Field(max_length=8)

    @field_validator('further_checks')
    @classmethod
    def bounded_notes(cls, values):
        if any(not value.strip() or len(value) > 600 for value in values):
            raise ValueError('待核对说明过长或为空。')
        return values
