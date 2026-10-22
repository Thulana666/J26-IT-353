"""Group related articles so they never cross train / validation / test.

Two articles are in the same group when they share any of these keys. Groups
are the connected sets (union-find) over the WHOLE snapshot, so a link through
an unlabelled article still counts.

    family   same normalised title: dates, numbers, months and "Update N"
             removed ("Situation Report - Sri Lanka 26th January 2025 at
             0900hrs" and "... 02nd August 2024 ..." are one templated series)
    related  same ReliefWeb "Related disaster" (e.g. "Tropical Cyclone Ditwah - Nov 2025")
    glide    same GLIDE disaster number (e.g. FL-2025-000218)
    gdacs    same GDACS event id (alert updates for one flood or cyclone)
    text     same stored text (a duplicate published under another URL)
    who      WHO Disease Outbreak News about the same disease (follow-up
             reports on one outbreak use slightly different titles)

The grouping is deliberately conservative: it may join reports about different
events that share a template, which costs some balance but keeps near-copies
from appearing on both sides of the split.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlparse

from ..classifier import DISEASE_PATTERNS
from .common import normalise_space, source_name, stored_text

GROUPING_VERSION = "1.0"

MONTHS = {
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
}
FILLER = {"st", "nd", "rd", "th", "update", "updates", "flash", "no", "nr"}
FAMILY_MAX_TOKENS = 10
FAMILY_MIN_TOKENS = 2
DUPLICATE_MIN_CHARS = 200

_BRACKETS = re.compile(r"\([^)]*\)|\[[^\]]*\]")
_NON_LETTERS = re.compile(r"[^a-z]+")
_RELATED = re.compile(r"^Related disasters?:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_RELATED_SPLIT = re.compile(r"(?<=\d{4}),\s+")
_GLIDE = re.compile(r"\b([A-Z]{2}-\d{4}-\d{6})\b")


def title_family(title: str | None) -> str | None:
    text = _BRACKETS.sub(" ", (title or "").lower())
    tokens = [t for t in _NON_LETTERS.split(text) if t and t not in MONTHS and t not in FILLER]
    if len(tokens) < FAMILY_MIN_TOKENS:
        return None
    return " ".join(tokens[:FAMILY_MAX_TOKENS])


def related_disasters(record: dict) -> list[str]:
    text = (record.get("content") or "") + "\n" + (record.get("summary") or "").replace(" · ", "\n")
    names = []
    for line in _RELATED.findall(text):
        names += [normalise_space(name).lower() for name in _RELATED_SPLIT.split(line) if name.strip()]
    return sorted(set(names))


def gdacs_event(record: dict) -> str | None:
    url = record.get("url") or ""
    if "gdacs.org" not in url:
        return None
    query = parse_qs(urlparse(url).query)
    event_id = (query.get("eventid") or [None])[0]
    return f"{(query.get('eventtype') or [''])[0]}:{event_id}" if event_id else None


def duplicate_text_key(record: dict) -> str | None:
    text = normalise_space(stored_text(record)).casefold()
    if len(text) < DUPLICATE_MIN_CHARS:
        return None
    return hashlib.sha1(text[:1000].encode("utf-8")).hexdigest()[:16]


def article_keys(record: dict) -> list[str]:
    keys = []
    family = title_family(record.get("title"))
    if family:
        keys.append(f"family:{family}")
    keys += [f"related:{name}" for name in related_disasters(record)]
    text = " ".join((record.get("title") or "", record.get("summary") or "", record.get("content") or ""))
    keys += sorted({f"glide:{number}" for number in _GLIDE.findall(text)})
    event = gdacs_event(record)
    if event:
        keys.append(f"gdacs:{event}")
    duplicate = duplicate_text_key(record)
    if duplicate:
        keys.append(f"text:{duplicate}")
    if source_name(record).startswith("WHO"):
        title = record.get("title") or ""
        keys += [f"who:{name}" for name, pattern in DISEASE_PATTERNS if pattern.search(title)]
    return keys


@dataclass
class Grouping:
    group_of: dict[str, str] = field(default_factory=dict)        # article id -> group id
    members: dict[str, list[str]] = field(default_factory=dict)   # group id -> article ids
    keys: dict[str, list[str]] = field(default_factory=dict)      # group id -> shared keys


def build_groups(records: list[dict]) -> Grouping:
    parent = {record["id"]: record["id"] for record in records}

    def find(item: str) -> str:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    first_with_key: dict[str, str] = {}
    keys_of_article: dict[str, list[str]] = {}
    for record in sorted(records, key=lambda r: r["id"]):
        article_id = record["id"]
        keys_of_article[article_id] = article_keys(record)
        for key in keys_of_article[article_id]:
            if key in first_with_key:
                a, b = find(article_id), find(first_with_key[key])
                if a != b:
                    parent[max(a, b)] = min(a, b)
            else:
                first_with_key[key] = article_id

    roots: dict[str, list[str]] = {}
    for article_id in sorted(parent):
        roots.setdefault(find(article_id), []).append(article_id)

    grouping = Grouping()
    for root, members in roots.items():
        group_id = "g_" + hashlib.sha1(min(members).encode("utf-8")).hexdigest()[:10]
        grouping.members[group_id] = members
        # Keep only keys that actually join two or more articles (the reason for the group).
        counts: dict[str, int] = {}
        for article_id in members:
            grouping.group_of[article_id] = group_id
            for key in keys_of_article[article_id]:
                counts[key] = counts.get(key, 0) + 1
        grouping.keys[group_id] = sorted(key for key, count in counts.items() if count > 1)
    return grouping
