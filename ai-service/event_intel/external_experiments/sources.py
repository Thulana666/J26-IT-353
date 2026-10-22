"""Paths, input verification and loading of the cleaned external datasets (read-only)."""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # ai-service/
DATA = ROOT / "data"
CLEAN = DATA / "external_clean"
INVENTORY = CLEAN / "external_data_inventory_v2.json"
OUT = DATA / "external_experiments"
VERSION = "v2"  # v1 superseded: outbreak-rule bug (see data/external_experiments/superseded/README.md)

DATASETS = {
    "humaid": {"clean": CLEAN / "humaid/humaid_train.clean.csv", "split": CLEAN / "humaid/humaid_train.split_proposal_v1.csv",
               "original_text": "tweet_text", "label": "class_label", "id": None},
    "disaster_tweets": {"clean": CLEAN / "disaster_tweets/disaster_tweets_train.clean.csv",
                        "split": CLEAN / "disaster_tweets/disaster_tweets_train.split_proposal_v1.csv",
                        "original_text": "text", "label": "target", "id": "id"},
    "bbc_news": {"clean": CLEAN / "bbc_news/bbc_news_train.clean.csv", "split": CLEAN / "bbc_news/bbc_news_train.split_proposal_v1.csv",
                 "original_text": "Text", "label": "Category", "id": "ArticleId"},
}

# Meaning of every original label (from the dataset documentation; see EXTERNAL_DATA_CLEANING_REPORT.md).
LABEL_MEANINGS = {
    "humaid": {
        "caution_and_advice": "warnings or advice about a disaster",
        "displaced_people_and_evacuations": "people displaced or evacuated",
        "infrastructure_and_utility_damage": "damage to buildings, roads, power, water or other infrastructure",
        "injured_or_dead_people": "reports of casualties",
        "missing_or_found_people": "missing or found persons",
        "not_humanitarian": "posted during the event but not humanitarian information",
        "other_relevant_information": "other disaster-related information",
        "requests_or_urgent_needs": "requests for help or urgent needs",
        "rescue_volunteering_or_donation_effort": "rescue, volunteering, donations, relief efforts",
        "sympathy_and_support": "prayers, sympathy, emotional support",
    },
    "disaster_tweets": {"1": "tweet is about a real disaster (Kaggle data description, mirrored)",
                        "0": "tweet is not about a real disaster (figurative or unrelated use of a hazard word)"},
    "bbc_news": {c: f"BBC editorial topic section '{c}' (2004-2005)" for c in ("business", "entertainment", "politics", "sport", "tech")},
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify_inputs() -> dict:
    """Compare the cleaned files and split proposals with the hashes recorded in inventory v2."""
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    out = {}
    for d in inv["datasets"]:
        for kind in ("original", "cleaned", "split_proposal"):
            rel = d[kind]["path"].split("/", 1)[1] if d[kind]["path"].startswith("ai-service/") else d[kind]["path"]
            path = ROOT / rel
            out[f"{d['id']}:{kind}"] = {"path": d[kind]["path"], "exists": path.exists(),
                                       "sha256_matches_inventory": path.exists() and sha256(path) == d[kind]["sha256"]}
    return out


def load(name: str) -> list[dict]:
    """Cleaned rows merged with their split-proposal columns (joined on source_row)."""
    cfg = DATASETS[name]
    with cfg["clean"].open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    with cfg["split"].open(encoding="utf-8", newline="") as f:
        split = {r["source_row"]: r for r in csv.DictReader(f)}
    for r in rows:
        s = split[r["source_row"]]
        for k, v in s.items():
            if k.startswith("split") and k not in r:
                r[k] = v
    return rows
