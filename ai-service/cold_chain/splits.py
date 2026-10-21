"""Chronological, trip-level train/validation/test split.

Trips are ordered by start time: the earliest go to training, later ones to
validation and the latest to test. All windows and snapshots of a trip stay in
the trip's set, so no trip leaks between sets, and the test trips are never
seen during training or model selection.

Trips running at the same time as trips of an earlier set (same day, roads,
weather) are reported as overlaps; purge_overlap drops them from the later set.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime

SETS = ("train", "validation", "test")


class InsufficientDataError(ValueError):
    pass


@dataclass(frozen=True)
class SplitConfig:
    train: float = 0.70
    validation: float = 0.15
    test: float = 0.15
    purge_overlap: bool = False

    def __post_init__(self):
        if abs(self.train + self.validation + self.test - 1) > 1e-9 or min(self.train, self.validation, self.test) <= 0:
            raise ValueError("train, validation and test must be positive and add up to 1")

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class TripSpan:
    trip_id: str
    start: datetime
    end: datetime


@dataclass
class Split:
    members: dict[str, list[str]]
    boundaries: dict[str, dict[str, str]]
    overlapping: dict[str, list[str]] = field(default_factory=dict)
    purged: dict[str, list[str]] = field(default_factory=dict)

    def set_of(self, trip_id: str) -> str | None:
        return next((name for name, ids in self.members.items() if trip_id in ids), None)

    def to_dict(self) -> dict:
        return asdict(self)


def chronological_split(trips: list[TripSpan], config: SplitConfig = SplitConfig()) -> Split:
    ordered = sorted(trips, key=lambda t: (t.start, t.trip_id))
    n = len(ordered)
    if n < len(SETS):
        raise InsufficientDataError(f"{n} trip(s): at least one trip per set (train, validation, test) is needed")
    n_test = max(1, round(n * config.test))
    n_validation = max(1, round(n * config.validation))
    n_train = n - n_validation - n_test
    if n_train < 1:
        raise InsufficientDataError(f"{n} trips are too few for this split")
    groups = {"train": ordered[:n_train], "validation": ordered[n_train : n_train + n_validation], "test": ordered[n_train + n_validation :]}

    overlapping: dict[str, list[str]] = {}
    purged: dict[str, list[str]] = {}
    for position, name in enumerate(SETS[1:], start=1):
        earlier = [t for previous in SETS[:position] for t in groups[previous]]
        latest_end = max(t.end for t in earlier)
        overlaps = [t for t in groups[name] if t.start < latest_end]
        overlapping[name] = [t.trip_id for t in overlaps]
        if config.purge_overlap and overlaps:
            purged[name] = overlapping[name]
            groups[name] = [t for t in groups[name] if t.start >= latest_end]
            if not groups[name]:
                raise InsufficientDataError(f"no {name} trips left after removing overlapping trips")

    return Split(
        members={name: [t.trip_id for t in groups[name]] for name in SETS},
        boundaries={
            name: {"first_start": groups[name][0].start.isoformat(), "last_start": groups[name][-1].start.isoformat()} for name in SETS
        },
        overlapping=overlapping,
        purged=purged,
    )
