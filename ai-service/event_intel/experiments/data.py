"""Load dataset v1, keep label provenance, filter eligible examples and guard against leakage."""

from __future__ import annotations

import csv
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from ..dataset.common import normalise_space, stored_text
from ..dataset.label_sheet import excerpt
from ..dataset.snapshot import load_snapshot

SUPPORTED_CATEGORIES = ("natural_disaster", "public_health", "other")
UNSUPPORTED_CATEGORIES = ("pharma_supply", "geopolitical_trade", "logistics")  # 0-1 examples: not trainable
SPLITS = ("train", "validation", "test")

# Which label statuses each training tier admits. Confirmed = human; proposed_* = AI silver labels.
TIERS = {
    "confirmed": ("confirmed_human",),
    "confirmed_high": ("confirmed_human", "proposed_high"),
    "confirmed_high_medium": ("confirmed_human", "proposed_high", "proposed_medium"),
}
HUMAN = "human_confirmed"
SILVER = "ai_proposed_silver"
RELEVANCE_BINARY = {"yes": 1, "possibly": 1, "no": 0}  # cannot_tell is excluded and counted


class LeakageError(RuntimeError):
    """Raised when the same article, report group or text appears on both sides of a split."""


@dataclass(frozen=True)
class Example:
    article_id: str
    split: str
    group_id: str
    label_status: str
    exclusion_reason: str
    text_sufficient: str
    category: str | None
    relevance: str | None
    text: str           # model input: title + the excerpt the labeller saw
    record: dict        # snapshot row for the rules baseline (read-only)

    @property
    def label_kind(self) -> str:
        if self.label_status == "confirmed_human":
            return HUMAN
        if self.label_status.startswith("proposed_") and self.label_status != "proposed_duplicate":
            return SILVER
        return "none"


def model_text(record: dict) -> str:
    return normalise_space((record.get("title") or "") + " . " + excerpt(record)[0])


def load_examples(dataset_csv: Path | str, snapshot_jsonl: Path | str) -> list[Example]:
    by_id = load_snapshot(snapshot_jsonl).by_id
    examples = []
    with Path(dataset_csv).open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            confirmed = row["label_status"] == "confirmed_human"
            suffix = "confirmed" if confirmed else "proposed"
            record = by_id[row["article_id"]]
            examples.append(Example(
                article_id=row["article_id"], split=row["split"], group_id=row["leakage_group_id"],
                label_status=row["label_status"], exclusion_reason=row["exclusion_reason"],
                text_sufficient=row["text_sufficient_any"],
                category=row[f"category_{suffix}"] or None, relevance=row[f"relevance_{suffix}"] or None,
                text=model_text(record), record=record))
    return examples


def eligible(examples: list[Example], tier: str, split: str, field: str = "category") -> list[Example]:
    """Examples usable for `field` in `split` under `tier`. Never mixes in unlabelled or excluded rows."""
    statuses = TIERS[tier]
    out = []
    for e in examples:
        if e.split != split or e.label_status not in statuses or e.exclusion_reason or e.text_sufficient != "yes":
            continue
        if field == "category" and e.category not in SUPPORTED_CATEGORIES:
            continue
        if field == "relevance" and e.relevance not in RELEVANCE_BINARY:
            continue
        out.append(e)
    return out


def gold(example: Example, field: str):
    return example.category if field == "category" else RELEVANCE_BINARY[example.relevance]


def _norm_text(text: str) -> str:
    return re.sub(r"\W+", " ", text.casefold()).strip()


def assert_disjoint(fit: list[Example], held_out: list[Example]) -> None:
    """Training/selection data must share no article, leakage group or normalised text with held-out data."""
    ids = {e.article_id for e in fit} & {e.article_id for e in held_out}
    groups = {e.group_id for e in fit} & {e.group_id for e in held_out}
    texts = {_norm_text(stored_text(e.record)) for e in fit if stored_text(e.record)} & \
            {_norm_text(stored_text(e.record)) for e in held_out if stored_text(e.record)}
    if ids or groups or texts:
        raise LeakageError(f"shared articles={len(ids)} groups={len(groups)} texts={len(texts)}")


def audit(examples: list[Example]) -> dict:
    """Pre-training audit: split sizes, label provenance, leakage checks and eligible counts."""
    by_split = {s: [e for e in examples if e.split == s] for s in SPLITS}
    groups: dict[str, set] = {}
    for e in examples:
        groups.setdefault(e.group_id, set()).add(e.split)
    for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")):
        assert_disjoint(by_split[a], by_split[b])
    report = {
        "articles": len(examples),
        "split_sizes": {s: len(v) for s, v in by_split.items()},
        "label_status_by_split": {s: dict(Counter(e.label_status for e in v)) for s, v in by_split.items()},
        "groups_crossing_splits": sum(1 for v in groups.values() if len(v) > 1),
        "eligible_category": {t: {s: dict(Counter(e.category for e in eligible(examples, t, s))) for s in SPLITS} for t in TIERS},
        "eligible_relevance": {t: {s: dict(Counter(e.relevance for e in eligible(examples, t, s, "relevance"))) for s in SPLITS} for t in TIERS},
        "unsupported_category_rows_excluded": dict(Counter(
            e.category for e in examples if e.category in UNSUPPORTED_CATEGORIES)),
        "cannot_tell_excluded": sum(1 for e in examples if e.relevance == "cannot_tell"),
        "human_confirmed_test": dict(Counter(e.category for e in eligible(examples, "confirmed", "test"))),
    }
    return report
