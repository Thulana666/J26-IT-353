"""Request model for POST /pharmacy-demand/train (camelCase or snake_case JSON accepted)."""

from __future__ import annotations

from datetime import date as Date

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

MAX_SERIES = 200
MAX_DAYS = 800


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class DemandDay(CamelModel):
    date: Date
    sold: float = Field(ge=0)
    # null on days before the product was first stocked at the pharmacy.
    closing_on_hand: float | None = Field(None, ge=0)


class DemandSeries(CamelModel):
    id: str = Field(min_length=1, max_length=100)
    days: list[DemandDay] = Field(max_length=MAX_DAYS)


class TrainRequest(CamelModel):
    # Each series ends on the last recorded day; forecasts start the day after.
    series: list[DemandSeries] = Field(min_length=1, max_length=MAX_SERIES)
    test_days: int = Field(28, ge=7, le=90)
    # Ridge penalty ("lambda" in JSON; not applied to the intercept).
    penalty: float = Field(1.0, ge=0, le=1000, alias="lambda")
    horizon_days: int = Field(30, ge=1, le=90)
    # Training window (target days); default the whole series.
    train_from: Date | None = None
    train_to: Date | None = None

    @model_validator(mode="after")
    def _window(self):
        if self.train_from and self.train_to and self.train_from > self.train_to:
            raise ValueError("trainFrom must not be after trainTo")
        return self

    def series_dicts(self) -> list[dict]:
        """The plain {id, days: [{date, sold, closingOnHand}]} shape model.train() expects."""
        return [{"id": s.id, "days": [{"date": d.date, "sold": d.sold, "closingOnHand": d.closing_on_hand} for d in s.days]}
                for s in self.series]
