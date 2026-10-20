"""Load an article snapshot written by backend/scripts/export-article-snapshot.js.

The snapshot is JSON Lines (one event_articles row per line). If the matching
.manifest.json exists, its SHA-256 and row count are checked so every later
step is tied to exactly the same articles.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .common import DatasetError, file_sha256


@dataclass
class Snapshot:
    path: Path
    sha256: str
    records: list[dict]
    manifest: dict | None

    @property
    def by_id(self) -> dict[str, dict]:
        return {record["id"]: record for record in self.records}

    def describe(self) -> dict:
        return {"file": self.path.name, "sha256": self.sha256, "row_count": len(self.records),
                "manifest_verified": self.manifest is not None}


def manifest_path(path: Path) -> Path:
    return path.with_name(path.name.removesuffix(".jsonl") + ".manifest.json")


def load_snapshot(path: Path | str, verify: bool = True) -> Snapshot:
    path = Path(path)
    if not path.exists():
        raise DatasetError(f"Snapshot not found: {path}")
    digest = file_sha256(path)
    records = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise DatasetError(f"{path.name} line {number} is not valid JSON") from exc

    manifest = None
    if verify and manifest_path(path).exists():
        manifest = json.loads(manifest_path(path).read_text(encoding="utf-8"))
        if manifest.get("sha256") != digest:
            raise DatasetError(f"{path.name} does not match its manifest hash: the snapshot was changed.")
        if manifest.get("row_count") != len(records):
            raise DatasetError(f"{path.name} has {len(records)} rows but its manifest says {manifest.get('row_count')}.")

    ids = [record.get("id") for record in records]
    if None in ids or len(set(ids)) != len(ids):
        raise DatasetError(f"{path.name} has missing or duplicate article ids.")
    return Snapshot(path=path, sha256=digest, records=records, manifest=manifest)
