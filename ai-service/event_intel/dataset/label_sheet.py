"""Generate blank label sheets from an article snapshot.

    python -m event_intel.dataset.label_sheet --snapshot data/snapshots/articles_<UTC>.jsonl

Writes to data/labels/ (refuses to overwrite):
    article_labels_<v>.sheet.csv    main sample: English articles with usable text,
                                    at most --family-cap per title family
    metadata_review_<v>.sheet.csv   separate sample of metadata-only records
                                    (never part of the main model evaluation)
    agreement_review_<v>.sheet.csv  blank copy of --agreement-size main articles
                                    for an independent second reviewer
    label_sheets_<v>.manifest.json  settings, snapshot hash and article ids

The sheets show only stored article data. No rules predictions (category,
relevance, scope, keywords) are written anywhere, so labellers are not biased
by them. The frozen rules' text-quality check is used only to decide which
pool an article belongs to (usable text vs metadata-only).
"""

from __future__ import annotations

import argparse
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

from ..classifier import RULES_NAME, RULES_VERSION, SUFFICIENT_QUALITY, classify_article
from .common import (DatasetError, ensure_new, git_commit, normalise_space, safe_cell, source_name,
                     stored_text, utc_now, write_csv, write_json)
from .grouping import duplicate_text_key, title_family
from .schema import GUIDE_VERSION, SHEET_COLUMNS
from .snapshot import load_snapshot

TOOL = {"name": "label_sheet", "version": "1.0"}
EXCERPT_CHARS = 2000
DEFAULT_OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "labels"


def text_quality_level(record: dict) -> str:
    """Only the text-quality level is used; the rest of the rules output is discarded."""
    return classify_article(record).text_quality.level


def excerpt(record: dict) -> tuple[str, int]:
    text = normalise_space(stored_text(record))
    if len(text) <= EXCERPT_CHARS:
        return text, len(text)
    cut = text.rfind(" ", 0, EXCERPT_CHARS)
    return text[: cut if cut > EXCERPT_CHARS // 2 else EXCERPT_CHARS] + " […]", len(text)


def sheet_row(record: dict, annotator: str = "") -> dict:
    text, length = excerpt(record)
    return {
        "article_id": record["id"],
        "source": source_name(record),
        "published_at": (record.get("published_at") or "")[:10],
        "title": safe_cell(record.get("title") or ""),
        "url": record.get("url") or "",
        "text_chars": length,
        "text_excerpt": safe_cell(text),
        "annotator": annotator,
        "guide_version": GUIDE_VERSION,
    }


def _cap_by_family(records: list[dict], cap: int, rng: random.Random) -> list[dict]:
    families: dict[str, list[dict]] = defaultdict(list)
    for record in sorted(records, key=lambda r: r["id"]):
        families[title_family(record.get("title")) or f"id:{record['id']}"].append(record)
    kept = []
    for key in sorted(families):
        members = families[key]
        rng.shuffle(members)
        kept += members[:cap]
    return sorted(kept, key=lambda r: r["id"])


def select_samples(records: list[dict], *, seed: int = 42, family_cap: int = 3, max_main: int | None = None,
                   metadata_size: int = 40, metadata_family_cap: int = 2, agreement_size: int = 60) -> dict:
    """Deterministic for the same snapshot and settings."""
    excluded: Counter = Counter()

    # Keep one article per duplicate text (the earliest), so copies are not labelled twice.
    first_by_text: dict[str, dict] = {}
    unique = []
    for record in sorted(records, key=lambda r: ((r.get("published_at") or ""), r["id"])):
        key = duplicate_text_key(record)
        if key and key in first_by_text:
            excluded["duplicate_text"] += 1
            continue
        if key:
            first_by_text[key] = record
        unique.append(record)

    main_pool, metadata_pool = [], []
    for record in unique:
        level = text_quality_level(record)
        english = (record.get("language") or "").lower() == "en"
        if not english:
            excluded["non_english"] += 1
        elif level == "metadata_only":
            metadata_pool.append(record)
        elif level in SUFFICIENT_QUALITY:
            main_pool.append(record)
        else:
            excluded[f"limited_text_{level}"] += 1

    main = _cap_by_family(main_pool, family_cap, random.Random(f"{seed}:main-family"))
    excluded["main_family_cap"] = len(main_pool) - len(main)
    if max_main is not None and len(main) > max_main:
        main = random.Random(f"{seed}:main-limit").sample(main, max_main)
    main = sorted(main, key=lambda r: r["id"])
    random.Random(f"{seed}:main-order").shuffle(main)  # mixed order: no long runs of one source

    metadata = _cap_by_family(metadata_pool, metadata_family_cap, random.Random(f"{seed}:metadata-family"))
    metadata = random.Random(f"{seed}:metadata").sample(metadata, min(metadata_size, len(metadata)))

    agreement = random.Random(f"{seed}:agreement").sample(main, min(agreement_size, len(main)))

    return {
        "main": main,
        "metadata_review": metadata,
        "agreement_review": agreement,
        "pools": {"english_usable_text": len(main_pool), "metadata_only": len(metadata_pool)},
        "excluded": dict(sorted(excluded.items())),
    }


def output_paths(out_dir: Path, version: str) -> dict[str, Path]:
    return {
        "main": out_dir / f"article_labels_{version}.sheet.csv",
        "metadata_review": out_dir / f"metadata_review_{version}.sheet.csv",
        "agreement_review": out_dir / f"agreement_review_{version}.sheet.csv",
        "manifest": out_dir / f"label_sheets_{version}.manifest.json",
    }


def generate(snapshot_path: Path, out_dir: Path, version: str = "v1", annotator: str = "", **settings) -> dict:
    snapshot = load_snapshot(snapshot_path)
    paths = output_paths(Path(out_dir), version)
    ensure_new(*paths.values())

    samples = select_samples(snapshot.records, **settings)
    write_csv(paths["main"], SHEET_COLUMNS, [sheet_row(r, annotator) for r in samples["main"]])
    write_csv(paths["metadata_review"], SHEET_COLUMNS, [sheet_row(r, annotator) for r in samples["metadata_review"]])
    write_csv(paths["agreement_review"], SHEET_COLUMNS, [sheet_row(r) for r in samples["agreement_review"]])

    manifest = {
        "manifest_version": 1,
        "created_at": utc_now(),
        "tool": TOOL,
        "guide_version": GUIDE_VERSION,
        "settings": {"version": version, **settings, "excerpt_chars": EXCERPT_CHARS},
        "snapshot": snapshot.describe(),
        "git_commit": git_commit(),
        "text_gate": {"rules": RULES_NAME, "version": RULES_VERSION,
                      "used_for": "pool selection only (usable text vs metadata-only); no predictions are shown"},
        "pools": samples["pools"],
        "excluded": samples["excluded"],
        "sheets": {
            name: {"file": paths[name].name, "rows": len(samples[name]),
                   "article_ids": [r["id"] for r in samples[name]]}
            for name in ("main", "metadata_review", "agreement_review")
        },
    }
    write_json(paths["manifest"], manifest)
    return {"paths": paths, "manifest": manifest}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate blank label sheets (no rules predictions).")
    parser.add_argument("--snapshot", type=Path, required=True, help="articles_<UTC>.jsonl from the exporter")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--version", default="v1", help="sheet version tag, e.g. v1 or pilot")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--family-cap", type=int, default=3, help="max articles per title family (main)")
    parser.add_argument("--max-main", type=int, help="limit the main sample (e.g. a pilot of 60)")
    parser.add_argument("--metadata-size", type=int, default=40)
    parser.add_argument("--agreement-size", type=int, default=60)
    parser.add_argument("--annotator", default="", help="pre-fill your initials in the main sheets")
    args = parser.parse_args(argv)

    try:
        result = generate(args.snapshot, args.out_dir, args.version, args.annotator, seed=args.seed,
                          family_cap=args.family_cap, max_main=args.max_main,
                          metadata_size=args.metadata_size, agreement_size=args.agreement_size)
    except DatasetError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    manifest = result["manifest"]
    print(f"Snapshot {manifest['snapshot']['file']} ({manifest['snapshot']['row_count']} articles)")
    print(f"  pools: {manifest['pools']}")
    print(f"  excluded: {manifest['excluded']}")
    for name, sheet in manifest["sheets"].items():
        print(f"  {name}: {sheet['rows']} rows -> {result['paths'][name]}")
    print(f"  manifest -> {result['paths']['manifest']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
