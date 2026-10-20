"""Check a label sheet against label guide v1.1. Never modifies the sheet.

    python -m event_intel.dataset.validate_labels data/labels/article_labels_v1.sheet.csv \
        --snapshot data/snapshots/articles_<UTC>.jsonl [--export data/labels/article_labels_v1.labels.csv]

Errors (exit code 1) must be fixed before a split or training run:
    missing columns, duplicate or unknown article ids, edited URLs, invalid
    values, partly labelled rows, missing evidence, annotator or guide version.
Warnings are worth a look but do not block:
    evidence quotes not found in the stored text, edited titles, unknown
    disease names, combinations the guide calls unusual.

Rows with no labels yet are simply counted as unlabelled. --export writes a
labels-only CSV (no article text) that is safe to commit; it is refused while
errors remain.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..lexicons import DISEASES
from .common import DatasetError, normalise_space, read_csv, unsafe_cell, write_csv
from .schema import (BINARY_RELEVANCE, CATEGORIES, CORE_LABELS, EVIDENCE_SEPARATOR, EXPORT_COLUMNS, FLAGS,
                     GUIDE_VERSION, LIST_SEPARATOR, RELEVANCE, REQUIRED_COLUMNS, SCOPES, SHEET_COLUMNS,
                     TEXT_SUFFICIENT)
from .snapshot import load_snapshot

ALLOWED = {"category": CATEGORIES, "relevance": RELEVANCE, "scope": SCOPES, "text_sufficient": TEXT_SUFFICIENT}
KNOWN_DISEASES = {name.lower() for name in DISEASES}
MAX_QUOTE_WORDS = 40
_QUOTE_CHARS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                              "–": "-", "—": "-", " ": " "})


@dataclass
class Issue:
    level: str            # "error" or "warning"
    line: int | None      # spreadsheet row number (header is row 1)
    article_id: str | None
    column: str | None
    message: str


@dataclass
class LabelRow:
    line: int
    article_id: str
    status: str           # "labelled", "unlabelled" or "duplicate"
    values: dict


@dataclass
class Report:
    file: str
    rows: list[LabelRow] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "warning"]

    @property
    def labelled(self) -> list[LabelRow]:
        return [r for r in self.rows if r.status == "labelled"]

    def summary(self) -> dict:
        labelled = self.labelled
        relevance = Counter(r.values["relevance"] for r in labelled)
        return {
            "file": self.file,
            "rows": len(self.rows),
            "labelled": len(labelled),
            "unlabelled": sum(1 for r in self.rows if r.status == "unlabelled"),
            "duplicates_flagged": sum(1 for r in self.rows if r.status == "duplicate"),
            "errors": len(self.errors),
            "warnings": len(self.warnings),
            "distributions": {
                column: dict(Counter(r.values[column] for r in labelled).most_common()) for column in CORE_LABELS
            },
            "flags": dict(Counter(f for r in labelled for f in split_list(r.values["flags"])).most_common()),
            "binary_relevance": {
                "positive_yes_or_possibly": sum(n for k, n in relevance.items() if BINARY_RELEVANCE.get(k) is True),
                "negative_no": sum(n for k, n in relevance.items() if BINARY_RELEVANCE.get(k) is False),
                "excluded_cannot_tell": relevance.get("cannot_tell", 0),
            },
            "annotators": dict(Counter(r.values["annotator"] for r in labelled)),
        }


def split_list(value: str, separator: str = LIST_SEPARATOR) -> list[str]:
    return [part.strip() for part in (value or "").split(separator) if part.strip()]


def _normalise_for_match(text: str) -> str:
    text = normalise_space((text or "").translate(_QUOTE_CHARS)).casefold()
    return text.strip(" \"'.…")


def evidence_found(quote: str, haystack: str) -> bool:
    return _normalise_for_match(quote) in haystack


def validate_rows(columns: list[str], rows: list[dict], file: str = "",
                  snapshot_by_id: dict[str, dict] | None = None) -> Report:
    report = Report(file=file)

    def add(level, line, article_id, column, message):
        report.issues.append(Issue(level, line, article_id, column, message))

    missing = [c for c in REQUIRED_COLUMNS if c not in columns]
    if missing:
        add("error", 1, None, None, f"Missing column(s): {', '.join(missing)}. Do not rename or delete columns.")
        return report
    extra = [c for c in columns if c not in SHEET_COLUMNS]
    if extra:
        add("warning", 1, None, None, f"Extra column(s) ignored: {', '.join(extra)}")

    seen: dict[str, int] = {}
    for line, raw in enumerate(rows, start=2):
        values = {key: str(raw.get(key) or "").strip() for key in SHEET_COLUMNS}
        for key in ALLOWED:
            values[key] = values[key].lower()
        values["flags"] = LIST_SEPARATOR.join(f.lower() for f in split_list(values["flags"]))
        article_id = values["article_id"]

        if not article_id:
            if any(values[c] for c in (*CORE_LABELS, "evidence", "flags", "diseases", "notes")):
                add("error", line, None, "article_id", "Row has labels but no article_id.")
            continue
        if article_id in seen:
            add("error", line, article_id, "article_id", f"Duplicate article_id (also on row {seen[article_id]}).")
            continue
        seen[article_id] = line

        record = None
        if snapshot_by_id is not None:
            record = snapshot_by_id.get(article_id)
            if record is None:
                add("error", line, article_id, "article_id", "article_id is not in the snapshot.")
            else:
                if values["url"] != (record.get("url") or ""):
                    add("error", line, article_id, "url", "URL differs from the snapshot. Do not edit URLs.")
                if "title" in columns and unsafe_cell(values["title"]) != (record.get("title") or "").strip():
                    add("warning", line, article_id, "title", "Title differs from the snapshot.")

        flags = split_list(values["flags"])
        has_labels = any(values[c] for c in (*CORE_LABELS, "evidence", "flags", "diseases"))
        if not has_labels:
            if values["notes"]:
                add("warning", line, article_id, "notes", "Notes but no labels: row counted as unlabelled.")
            report.rows.append(LabelRow(line, article_id, "unlabelled", values))
            continue

        for flag in flags:
            if flag not in FLAGS:
                hint = " Separate flags with ';'." if "," in flag else ""
                add("error", line, article_id, "flags", f"Unknown flag '{flag}'.{hint} Allowed: {', '.join(FLAGS)}")

        filled_core = [c for c in CORE_LABELS if values[c]]
        if "duplicate" in flags and not filled_core:
            if not values["notes"]:
                add("warning", line, article_id, "notes", "Duplicate: name the kept article_id in notes.")
            report.rows.append(LabelRow(line, article_id, "duplicate", values))
            continue

        errors_before = len(report.errors)
        for column in CORE_LABELS:
            if not values[column]:
                add("error", line, article_id, column, f"Missing {column} (all four core labels are required).")
            elif values[column] not in ALLOWED[column]:
                add("error", line, article_id, column,
                    f"Invalid {column} '{values[column]}'. Allowed: {', '.join(ALLOWED[column])}")

        quotes = split_list(values["evidence"], EVIDENCE_SEPARATOR)
        needs_evidence = values["category"] != "other" or values["relevance"] in ("yes", "possibly")
        if needs_evidence and not quotes:
            add("error", line, article_id, "evidence",
                "Evidence quote required (category is not 'other' or relevance is yes/possibly).")
        if not values["annotator"]:
            add("error", line, article_id, "annotator", "Annotator initials are required on labelled rows.")
        if values["guide_version"] != GUIDE_VERSION:
            add("error", line, article_id, "guide_version",
                f"guide_version is '{values['guide_version']}', expected '{GUIDE_VERSION}'.")

        if record is not None and quotes:
            haystack = _normalise_for_match(" ".join(
                (record.get("title") or "", record.get("summary") or "", record.get("content") or "")))
            for quote in quotes:
                if not evidence_found(quote, haystack):
                    add("warning", line, article_id, "evidence", f"Quote not found in the stored text: '{quote[:60]}'")
        for quote in quotes:
            if len(quote.split()) > MAX_QUOTE_WORDS:
                add("warning", line, article_id, "evidence", f"Quote is longer than {MAX_QUOTE_WORDS} words.")
        for disease in split_list(values["diseases"]):
            if disease.lower() not in KNOWN_DISEASES:
                add("warning", line, article_id, "diseases", f"'{disease}' is not in the disease list (allowed, check spelling).")

        if values["relevance"] == "cannot_tell" and values["text_sufficient"] == "yes":
            add("warning", line, article_id, "relevance", "cannot_tell although text_sufficient is yes.")
        if "no_actual_event" in flags and values["category"] not in ("", "other"):
            add("warning", line, article_id, "category", "Flag no_actual_event but category is not 'other'.")
        if "metadata_only" in flags and values["text_sufficient"] == "yes":
            add("warning", line, article_id, "text_sufficient", "Flag metadata_only but text_sufficient is yes.")
        # Guide 1.1: 'other' + 'possibly' is valid (Decision O2 medicine donations, O6 indirect
        # health links). 'yes' needs a health event, disaster or documented supply problem in
        # Sri Lanka, which always has its own category.
        if values["category"] == "other" and values["relevance"] == "yes":
            add("warning", line, article_id, "relevance",
                "Category 'other' but relevance is yes: under guide 1.1 'yes' needs a health event, "
                "disaster or documented medicine supply problem, which has its own category.")

        status = "labelled" if len(report.errors) == errors_before else "invalid"
        report.rows.append(LabelRow(line, article_id, status, values))
    return report


def validate_file(path: Path | str, snapshot_path: Path | str | None = None) -> Report:
    columns, rows = read_csv(Path(path))
    snapshot_by_id = load_snapshot(snapshot_path).by_id if snapshot_path else None
    return validate_rows(columns, rows, Path(path).name, snapshot_by_id)


def export_labels(report: Report, path: Path | str, source_path: Path | str | None = None) -> int:
    """Labels-only CSV (no article text). Includes labelled and duplicate rows."""
    path = Path(path)
    if report.errors:
        raise DatasetError("Fix the errors before exporting labels.")
    if path.name.endswith(".sheet.csv") or (source_path and path.resolve() == Path(source_path).resolve()):
        raise DatasetError("Refusing to export over a working label sheet.")
    rows = [{**r.values, "title": unsafe_cell(r.values["title"])} for r in report.rows
            if r.status in ("labelled", "duplicate")]
    write_csv(path, EXPORT_COLUMNS, rows, exclusive=False)
    return len(rows)


def print_report(report: Report, show_all: bool = False) -> None:
    summary = report.summary()
    print(f"{summary['file']}: {summary['rows']} rows | labelled {summary['labelled']} | "
          f"unlabelled {summary['unlabelled']} | duplicates {summary['duplicates_flagged']} | "
          f"errors {summary['errors']} | warnings {summary['warnings']}")
    if summary["labelled"]:
        for column, counts in summary["distributions"].items():
            print(f"  {column}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
        binary = summary["binary_relevance"]
        print(f"  binary relevance experiment: {binary['positive_yes_or_possibly']} positive, "
              f"{binary['negative_no']} negative, {binary['excluded_cannot_tell']} excluded (cannot_tell)")
    issues = report.issues if show_all else report.issues[:40]
    for issue in issues:
        where = f"row {issue.line}" if issue.line else "file"
        print(f"  [{issue.level}] {where} {issue.column or ''}: {issue.message}")
    if len(report.issues) > len(issues):
        print(f"  ... {len(report.issues) - len(issues)} more (use --all)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a label sheet (read-only).")
    parser.add_argument("labels", type=Path)
    parser.add_argument("--snapshot", type=Path, help="check ids, URLs and evidence against the snapshot")
    parser.add_argument("--json", type=Path, help="write the full report as JSON")
    parser.add_argument("--export", type=Path, help="write a labels-only CSV (refused while errors remain)")
    parser.add_argument("--all", action="store_true", help="print every issue")
    args = parser.parse_args(argv)

    try:
        report = validate_file(args.labels, args.snapshot)
        print_report(report, args.all)
        if args.json:
            args.json.write_text(json.dumps({"summary": report.summary(),
                                             "issues": [asdict(i) for i in report.issues]},
                                            ensure_ascii=False, indent=2), encoding="utf-8")
        if args.export:
            count = export_labels(report, args.export, args.labels)
            print(f"  exported {count} labelled row(s) -> {args.export}")
    except DatasetError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
