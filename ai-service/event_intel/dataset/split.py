"""Group-based, reproducible train / validation / test split.

    python -m event_intel.dataset.split --snapshot data/snapshots/articles_<UTC>.jsonl \
        --labels data/labels/article_labels_v1.labels.csv --out data/splits/split_v1.json \
        [--metadata-review data/labels/metadata_review_v1.labels.csv]

1. Related articles are grouped over the whole snapshot (grouping.py).
2. Only valid, labelled rows are split. Rows flagged "duplicate" are excluded.
   The label file must pass validation first.
3. Whole groups are taken in a seeded random order and each goes to the
   split furthest below its target share, balancing the gold category
   (stratify=category). Random rather than largest-first order, so follow-up
   series can land in any split and the test set looks like the real data.
   The same inputs and seed always give the same split.
4. The manifest records hashes of the snapshot and label file, the seed, the
   counts per split and category, how many cannot_tell rows a binary
   relevance experiment would exclude, and any metadata-review articles whose
   group also appears in the training data.

The test split is for one final evaluation only: never for rule tuning,
model selection or threshold selection.
"""

from __future__ import annotations

import argparse
import random
import sys
from collections import Counter
from pathlib import Path

from .common import DatasetError, file_sha256, git_commit, read_csv, utc_now, write_json
from .grouping import GROUPING_VERSION, build_groups
from .schema import CATEGORIES, GUIDE_VERSION, SPLITS
from .snapshot import load_snapshot
from .validate_labels import split_list, validate_rows

TOOL = {"name": "split", "version": "1.0"}
DEFAULT_RATIOS = (0.70, 0.15, 0.15)


def assign_groups(groups: dict[str, list[str]], strata: dict[str, str], ratios=DEFAULT_RATIOS,
                  seed: int = 42) -> dict[str, str]:
    """groups: group id -> article ids; strata: article id -> stratum ("" for none)."""
    if len(ratios) != len(SPLITS) or abs(sum(ratios) - 1) > 1e-6 or min(ratios) <= 0:
        raise DatasetError("Ratios must be three positive numbers that add up to 1.")
    target = dict(zip(SPLITS, ratios))
    stratum_total = Counter(strata[a] for members in groups.values() for a in members)
    stratum_size = {s: Counter() for s in SPLITS}

    order = sorted(groups)
    random.Random(f"{seed}:groups").shuffle(order)

    assignment = {}
    for group_id in order:
        members = groups[group_id]
        counts = Counter(strata[a] for a in members)

        def score(split: str) -> float:
            # How far this split is below its target share, for the group's strata.
            # With stratify=none every article has the same stratum, so this is the overall share.
            return sum(n * (target[split] - stratum_size[split][s] / stratum_total[s])
                       for s, n in counts.items()) / len(members)

        best = max(SPLITS, key=score)  # ties go to the earlier split (train)
        assignment[group_id] = best
        stratum_size[best].update(counts)
    return assignment


def make_split(snapshot_path: Path | str, labels_path: Path | str, *, seed: int = 42, ratios=DEFAULT_RATIOS,
               stratify: str = "category", include_unlabelled: bool = False,
               metadata_review_path: Path | str | None = None) -> dict:
    if include_unlabelled and stratify != "none":
        raise DatasetError("--include-unlabelled (dry runs only) needs --stratify none: there are no gold labels.")
    snapshot = load_snapshot(snapshot_path)
    labels_path = Path(labels_path)
    columns, rows = read_csv(labels_path)
    report = validate_rows(columns, rows, labels_path.name, snapshot.by_id)
    if report.errors:
        raise DatasetError(f"{labels_path.name} has {len(report.errors)} validation error(s); "
                           "run validate_labels and fix them first.")

    selected, excluded = [], Counter()
    for row in report.rows:
        if row.status == "duplicate" or "duplicate" in split_list(row.values["flags"]):
            excluded["duplicate"] += 1
        elif row.status == "labelled" or (include_unlabelled and row.status == "unlabelled"):
            selected.append(row)
        else:
            excluded[row.status] += 1
    if not selected:
        raise DatasetError("No labelled rows to split yet.")

    grouping = build_groups(snapshot.records)
    groups: dict[str, list[str]] = {}
    for row in selected:
        groups.setdefault(grouping.group_of[row.article_id], []).append(row.article_id)
    values = {row.article_id: row.values for row in selected}
    strata = {a: (values[a]["category"] if stratify == "category" else "") for a in values}
    assignment = assign_groups(groups, strata, ratios, seed)
    split_of = {a: assignment[g] for g, members in groups.items() for a in members}

    def per_split(column: str) -> dict:
        return {s: dict(Counter(values[a][column] for a in split_of if split_of[a] == s and values[a][column])
                        .most_common()) for s in SPLITS}

    counts = {s: sum(1 for a in split_of if split_of[a] == s) for s in SPLITS}
    warnings = []
    if stratify == "category":
        for category in CATEGORIES:
            present = {s: per_split("category")[s].get(category, 0) for s in SPLITS}
            if sum(present.values()) and not all(present.values()):
                warnings.append(f"Category '{category}' is missing from some splits: {present}")
    largest = max(len(m) for m in groups.values())
    if largest > 0.1 * len(split_of):
        warnings.append(f"Largest group has {largest} of {len(split_of)} articles; split shares may be uneven.")

    metadata = None
    if metadata_review_path:
        _, meta_rows = read_csv(Path(metadata_review_path))
        meta_ids = [r.get("article_id", "").strip() for r in meta_rows if r.get("article_id", "").strip()]
        overlap_main = sorted(set(meta_ids) & set(split_of))
        if overlap_main:
            raise DatasetError(f"{len(overlap_main)} metadata-review article(s) are also in the main labels.")
        shared = sorted(a for a in meta_ids if a in grouping.group_of
                        and assignment.get(grouping.group_of[a]) in ("train", "validation"))
        metadata = {"file": Path(metadata_review_path).name, "sha256": file_sha256(Path(metadata_review_path)),
                    "articles": len(meta_ids), "kept_out_of_split": True,
                    "sharing_a_group_with_train_or_validation": len(shared), "article_ids_sharing": shared}

    return {
        "manifest_version": 1,
        "created_at": utc_now(),
        "tool": TOOL,
        "git_commit": git_commit(),
        "seed": seed,
        "ratios": dict(zip(SPLITS, ratios)),
        "stratify_by": stratify,
        "labelled_only": not include_unlabelled,
        "snapshot": snapshot.describe(),
        "labels": {"file": labels_path.name, "sha256": file_sha256(labels_path), "guide_version": GUIDE_VERSION},
        "grouping": {"version": GROUPING_VERSION,
                     "keys": ["family", "related", "glide", "gdacs", "text", "who"]},
        "counts": {"articles": counts, "groups": dict(Counter(assignment.values())), "excluded": dict(excluded)},
        "category_counts": per_split("category"),
        "relevance_counts": per_split("relevance"),
        "binary_relevance_excluded_cannot_tell": {
            s: sum(1 for a in split_of if split_of[a] == s and values[a]["relevance"] == "cannot_tell") for s in SPLITS},
        "warnings": warnings,
        "metadata_review": metadata,
        "groups": {g: {"split": assignment[g], "articles": len(groups[g]), "keys": grouping.keys[g][:10]}
                   for g in sorted(groups)},
        "articles": [{"article_id": a, "group_id": grouping.group_of[a], "split": split_of[a]}
                     for a in sorted(split_of)],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Group-based reproducible train/validation/test split.")
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True, help="label sheet or labels-only export")
    parser.add_argument("--out", type=Path, required=True, help="e.g. data/splits/split_v1.json")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--ratios", type=float, nargs=3, default=list(DEFAULT_RATIOS), metavar=("TRAIN", "VAL", "TEST"))
    parser.add_argument("--stratify", choices=("category", "none"), default="category")
    parser.add_argument("--metadata-review", type=Path, help="kept out of the split; overlap is reported")
    parser.add_argument("--include-unlabelled", action="store_true", help="dry run before labelling (needs --stratify none)")
    args = parser.parse_args(argv)

    try:
        if args.out.exists():
            raise DatasetError(f"Refusing to overwrite {args.out}")
        manifest = make_split(args.snapshot, args.labels, seed=args.seed, ratios=tuple(args.ratios),
                              stratify=args.stratify, include_unlabelled=args.include_unlabelled,
                              metadata_review_path=args.metadata_review)
        write_json(args.out, manifest)
    except DatasetError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    counts = manifest["counts"]
    print(f"Split of {sum(counts['articles'].values())} article(s) in {sum(counts['groups'].values())} group(s), "
          f"seed {manifest['seed']}, stratify {manifest['stratify_by']}")
    for split in SPLITS:
        print(f"  {split}: {counts['articles'][split]} articles, {counts['groups'].get(split, 0)} groups, "
              f"cannot_tell {manifest['binary_relevance_excluded_cannot_tell'][split]}")
    if counts["excluded"]:
        print(f"  excluded: {counts['excluded']}")
    if manifest["metadata_review"]:
        m = manifest["metadata_review"]
        print(f"  metadata review: {m['articles']} kept out; {m['sharing_a_group_with_train_or_validation']} "
              "share a group with train/validation")
    for warning in manifest["warnings"]:
        print(f"  warning: {warning}")
    print(f"  manifest -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
