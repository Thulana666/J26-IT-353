"""Request model for POST /event-intel/classify (camelCase or snake_case JSON accepted)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

MAX_TITLE_CHARS = 1_000
MAX_SUMMARY_CHARS = 20_000
MAX_CONTENT_CHARS = 100_000  # the model reads the first 2,000 characters; the rules up to 4,000


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class ClassifyRequest(CamelModel):
    article_id: str | None = Field(None, max_length=100)
    title: str = Field("", max_length=MAX_TITLE_CHARS)
    summary: str | None = Field(None, max_length=MAX_SUMMARY_CHARS)
    content: str | None = Field(None, max_length=MAX_CONTENT_CHARS)
    url: str | None = Field(None, max_length=2_000)
    published_at: str | None = Field(None, max_length=40)
    language: str | None = Field(None, max_length=10)
    country_code: str | None = Field(None, max_length=2)
    source_name: str | None = Field(None, max_length=200)
    source_type: str | None = Field(None, max_length=50)
    # When true, a missing or invalid model is an error (501) instead of a rules-only result.
    require_model: bool = False

    @model_validator(mode="after")
    def _has_text(self):
        if not any((v or "").strip() for v in (self.title, self.summary, self.content)):
            raise ValueError("title, summary or content must contain text")
        return self

    def record(self) -> dict:
        """The event_articles-shaped record the rules classifier and model text builder expect."""
        return {"id": self.article_id, "title": self.title, "summary": self.summary, "content": self.content,
                "url": self.url, "published_at": self.published_at, "language": self.language,
                "country_code": self.country_code,
                "source": {"name": self.source_name, "source_type": self.source_type}}
