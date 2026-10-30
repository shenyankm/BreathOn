from pydantic import BaseModel, ConfigDict, field_validator


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid')

    @field_validator('*', mode='before')
    @classmethod
    def trim_labels(cls, value, info):
        return value.strip() if isinstance(value, str) and info.field_name != 'password' else value

