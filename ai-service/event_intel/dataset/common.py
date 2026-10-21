"""Small shared helpers for the dataset tools (files, hashes, CSV, text)."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


class DatasetError(Exception):
    """A problem the user must fix (bad file, hash mismatch, refused overwrite)."""


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def git_commit() -> str | None:
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                                cwd=Path(__file__).parent, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def ensure_new(*paths: Path) -> None:
    """Refuse to overwrite: label sheets and manifests may hold hours of manual work."""
    existing = [str(p) for p in paths if Path(p).exists()]
    if existing:
        raise DatasetError("Refusing to overwrite existing file(s): " + ", ".join(existing))


def write_json(path: Path, data: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def normalise_space(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def stored_text(record: dict) -> str:
    """The article text as stored: content, or the summary when there is no content."""
    content = (record.get("content") or "").strip()
    return content if content else (record.get("summary") or "").strip()


def source_name(record: dict) -> str:
    return (record.get("source") or {}).get("name") or record.get("source_name") or ""


def safe_cell(text: str) -> str:
    """Stop spreadsheets from treating text that starts with = + - @ as a formula."""
    return "'" + text if text.startswith(FORMULA_PREFIXES) else text


def unsafe_cell(text: str) -> str:
    return text[1:] if text.startswith("'") and text[1:].startswith(FORMULA_PREFIXES) else text


def write_csv(path: Path, columns: tuple[str, ...], rows: list[dict], *, exclusive: bool = True) -> None:
    """UTF-8 with BOM so Excel shows Sinhala, Tamil and accented text correctly."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x" if exclusive else "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    try:
        with Path(path).open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            rows = [dict(row) for row in reader]
            columns = [c.strip() for c in (reader.fieldnames or [])]
    except UnicodeDecodeError as exc:
        raise DatasetError(
            f"{path} is not UTF-8. In Excel use File > Save As > 'CSV UTF-8 (Comma delimited)'."
        ) from exc
    cleaned = [{(k or "").strip(): (v or "") for k, v in row.items() if k is not None} for row in rows]
    return columns, cleaned
