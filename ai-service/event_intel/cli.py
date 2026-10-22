"""Run the rules baseline over exported articles (read-only; no database access).

    python -m event_intel.cli articles.json                  # summary only
    python -m event_intel.cli articles.json -o results.jsonl # also save results

Input: a JSON array (or JSON Lines) of event_articles rows, optionally with a
nested "source": {"name", "source_type"} or flat source_name/source_type.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .classifier import RULES_NAME, RULES_VERSION, classify_article


def _load(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Classify articles with the rules baseline.")
    parser.add_argument("input", type=Path, help="JSON array or JSON Lines file of articles")
    parser.add_argument("-o", "--output", type=Path, help="write one JSON result per line")
    args = parser.parse_args(argv)

    records = _load(args.input)
    results = [classify_article(record) for record in records]

    if args.output:
        with args.output.open("w", encoding="utf-8") as out:
            for result in results:
                out.write(json.dumps(result.to_dict(), ensure_ascii=False) + "\n")

    print(f"{RULES_NAME} {RULES_VERSION}: {len(results)} article(s)")
    for name, key in (
        ("Category", lambda r: r.category),
        ("Relevance", lambda r: r.relevance),
        ("Scope", lambda r: r.event_scope),
        ("Text quality", lambda r: r.text_quality.level),
        ("Status", lambda r: r.processing_status),
    ):
        counts = Counter(key(r) for r in results)
        print(f"  {name}: " + ", ".join(f"{k} {v}" for k, v in counts.most_common()))


if __name__ == "__main__":
    main()
