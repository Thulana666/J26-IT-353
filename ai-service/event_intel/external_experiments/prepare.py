"""Stage 1-2: audit the cleaned external datasets, apply the versioned mappings and write adapted,
leakage-annotated datasets with provenance. Reads only; refuses to overwrite.

    python -m event_intel.external_experiments.prepare [--out data/external_experiments/v2]

Outputs (git-ignored under data/**):
  adapted/<dataset>_adapted_v2.csv   one row per cleaned record: provenance, original label and its meaning,
                                      own-task split, leakage group, cross-dataset / news duplicate flags,
                                      language flag, mapped_category + mapping_rule + label_source
  splits/<dataset>_splits_v2.json    split counts per label, groups, and leakage checks
  audit_v2.json                      dataset audit, cross-dataset duplicates, news-event overlap, mapping counts
  prepare_run_v2.json                inputs with hashes, versions, output hashes
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from ..dataset.common import normalise_space, stored_text, utc_now
from ..dataset.snapshot import load_snapshot
from . import mapping as M
from . import sources as S

NEWS_DATASET = S.DATA / "dataset_v1/event_dataset_v1.csv"
SNAPSHOT = S.DATA / "snapshots/articles_20261018T122253Z.jsonl"
OWN_SPLIT_COLUMN = {"humaid": "split_event_heldout_proposal", "disaster_tweets": "split_proposal", "bbc_news": "split_proposal"}
_URL = re.compile(r"https?://\S+|www\.\S+", re.I)
_MENTION = re.compile(r"@\w+")
_NONWORD = re.compile(r"[^\w\s]")


def norm_key(text: str) -> str:
    t = _URL.sub(" ", (text or "").lower())
    t = _MENTION.sub(" ", t)
    t = re.sub(r"^\s*rt\b[:\s]*", " ", t)
    t = _NONWORD.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def shingle_hashes(key: str, k: int) -> set[int]:
    words = key.split()
    if len(words) < k:
        return {hash(" ".join(words))} if words else set()
    return {int.from_bytes(hashlib.blake2b(" ".join(words[i:i + k]).encode(), digest_size=8).digest(), "little")
            for i in range(len(words) - k + 1)}


class UnionFind:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[max(a, b)] = min(a, b)


def news_index(k: int = 4):
    """Shingle index over the whole news snapshot (titles and texts) with each article's split, if any."""
    snap = load_snapshot(SNAPSHOT)
    split_of = {}
    with NEWS_DATASET.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            split_of[r["article_id"]] = r["split"]
    keys, inv = {}, defaultdict(set)
    for rec in snap.records:
        title_key = norm_key(rec.get("title") or "")
        text_key = norm_key(normalise_space(stored_text(rec)))
        keys[rec["id"]] = (title_key, text_key)
        for h in shingle_hashes(text_key, k) | shingle_hashes(title_key, k):
            inv[h].add(rec["id"])
    exact = {}
    for aid, (t, x) in keys.items():
        for key in (t, x):
            if len(key.split()) >= 5:
                exact.setdefault(key, aid)
    return {"inv": inv, "exact": exact, "split_of": split_of, "k": k}


def news_match(key: str, idx: dict) -> tuple[str | None, str]:
    """News article whose title/text equals the record, or contains >= 80% of its 4-word shingles."""
    if key in idx["exact"]:
        return idx["exact"][key], "exact"
    sh = shingle_hashes(key, idx["k"])
    if len(sh) < 4:
        return None, ""
    hits = Counter(a for h in sh for a in idx["inv"].get(h, ()))
    if hits:
        aid, n = hits.most_common(1)[0]
        if n / len(sh) >= 0.8:
            return aid, "containment>=0.8"
    return None, ""


def cross_dataset_groups(data: dict[str, list[dict]], k: int = 3, threshold: float = 0.8) -> dict:
    """Union within-dataset leakage groups with cross-dataset exact and near duplicates (verified Jaccard)."""
    uf = UnionFind()
    keys = {}
    for name, rows in data.items():
        for r in rows:
            node = f"{name}:{r['source_row']}"
            uf.union(node, f"{name}:{r['leakage_group']}")
            keys[node] = norm_key(r["text_clean"])
    by_key = defaultdict(list)
    for node, key in keys.items():
        if key:
            by_key[key].append(node)
    exact_cross = 0
    for nodes in by_key.values():
        if len({n.split(":")[0] for n in nodes}) > 1:
            exact_cross += 1
        for n in nodes[1:]:
            uf.union(nodes[0], n)
    # near duplicates across the two tweet datasets (BBC articles are compared exactly only: different genre)
    sh = {n: shingle_hashes(keys[n], k) for n in keys if not n.startswith("bbc_news")}
    inv = defaultdict(list)
    for n, s in sh.items():
        for h in s:
            inv[h].append(n)
    pairs = Counter()
    for h, nodes in inv.items():
        ds = {n.split(":")[0] for n in nodes}
        if len(ds) > 1 and len(nodes) <= 50:
            for i, a in enumerate(nodes):
                for b in nodes[i + 1:]:
                    if a.split(":")[0] != b.split(":")[0]:
                        pairs[(a, b)] += 1
    near_cross = []
    for (a, b), n in pairs.items():
        j = n / len(sh[a] | sh[b])
        if j >= threshold:
            near_cross.append((a, b, round(j, 3)))
            uf.union(a, b)
    return {"find": uf.find, "exact_cross_dataset_key_groups": exact_cross, "near_cross_dataset_pairs": near_cross}


def adapt(name: str, rows: list[dict], idx: dict, cross: dict) -> list[dict]:
    cfg = S.DATASETS[name]
    meanings = S.LABEL_MEANINGS[name]
    out = []
    for r in rows:
        node = f"{name}:{r['source_row']}"
        category, rule = M.MAPPERS[name](r)
        en = M.english_likely(r["text_clean"])
        if category and not en:
            category, rule = None, "excluded_not_english_likely"
        match, how = news_match(norm_key(r["text_clean"]), idx)
        news_split = idx["split_of"].get(match, "not_in_pool") if match else ""
        if category and match:
            category, rule = None, f"excluded_duplicates_news_article ({how})"
        label = r[cfg["label"]]
        out.append({
            "source_dataset": name, "source_file": r["source_file"], "source_row": r["source_row"],
            "source_id": r[cfg["id"]] if cfg["id"] else "",
            "text": r["text_clean"],
            "original_label": label, "original_label_meaning": meanings.get(label, ""),
            "event_block_inferred": r.get("inferred_event_block", ""), "keyword": r.get("keyword_decoded", ""),
            "english_likely": int(en),
            "dedup_recommendation": r["dedup_recommendation"],
            "own_task_split": r[OWN_SPLIT_COLUMN[name]] if r[OWN_SPLIT_COLUMN[name]] != "excluded_duplicate" else "excluded",
            "humaid_in_event_split": r.get("split_in_event_proposal", ""),
            "leakage_group": r["leakage_group"], "global_leakage_group": "G_" + hashlib.sha1(cross["find"](node).encode()).hexdigest()[:10],
            "duplicates_news_article": match or "", "duplicates_news_how": how, "duplicated_news_article_split": news_split,
            "mapped_category": category or "", "mapping_rule": rule, "mapping_status": "mapped" if category else "excluded",
            "rule_accepted_for_training": int(bool(category) and rule in M.ACCEPTED_RULES),
            "training_eligible_mapped": int(bool(category) and rule in M.ACCEPTED_RULES and en and not match
                                            and r["dedup_recommendation"] == "keep"
                                            and r[OWN_SPLIT_COLUMN[name]] == "train"),
            "label_source_original": "original_dataset_label",
            "label_source_mapped": M.MAPPING_VERSION if category else "",
        })
    return out


def _rel(p: Path) -> str:
    for base in (S.ROOT, S.ROOT.resolve()):
        try:
            return str(Path(p).relative_to(base)).replace("\\", "/")
        except ValueError:
            continue
    return str(p)


def split_audit(name: str, rows: list[dict]) -> dict:
    groups = defaultdict(set)
    gl = defaultdict(set)
    for r in rows:
        if r["own_task_split"] in ("train", "validation", "test"):
            groups[r["leakage_group"]].add(r["own_task_split"])
            gl[r["global_leakage_group"]].add(r["own_task_split"])
    return {
        "dataset": name, "split_column": OWN_SPLIT_COLUMN[name],
        "rows_by_split": dict(Counter(r["own_task_split"] for r in rows)),
        "original_label_by_split": {s: dict(Counter(r["original_label"] for r in rows if r["own_task_split"] == s))
                                    for s in ("train", "validation", "test")},
        "mapped_category_by_split": {s: dict(Counter(r["mapped_category"] for r in rows if r["own_task_split"] == s and r["mapped_category"]))
                                     for s in ("train", "validation", "test")},
        "within_dataset_leakage_groups_spanning_splits": sum(1 for v in groups.values() if len(v) > 1),
        "global_groups_spanning_splits_within_this_dataset": sum(1 for v in gl.values() if len(v) > 1),
        "rows_duplicating_a_news_article": sum(1 for r in rows if r["duplicates_news_article"]),
        "rows_duplicating_news_validation_or_test": sum(1 for r in rows if r["duplicated_news_article_split"] in ("validation", "test")),
        "grouping_limitation": {
            "humaid": "No event/user ids in the file; splits use INFERRED event blocks (row order + keywords) plus text near-duplicates.",
            "disaster_tweets": "No event/user/time metadata; only text near-duplicates are grouped. Topic/event overlap across splits is NOT prevented.",
            "bbc_news": "No grouping metadata; only text near-duplicates are grouped.",
        }[name],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Prepare adapted external datasets (v2).")
    ap.add_argument("--out", type=Path, default=S.OUT / S.VERSION)
    args = ap.parse_args(argv)
    out = args.out
    if out.exists() and any(out.iterdir()):
        print(f"Refusing to overwrite non-empty {out}", file=sys.stderr)
        return 1
    verification = S.verify_inputs()
    bad = [k for k, v in verification.items() if not v["sha256_matches_inventory"]]
    if bad:
        print(f"Inputs differ from inventory v2: {bad}", file=sys.stderr)
        return 1
    data = {n: S.load(n) for n in S.DATASETS}
    idx = news_index()
    cross = cross_dataset_groups(data)
    adapted = {n: adapt(n, rows, idx, cross) for n, rows in data.items()}
    (out / "adapted").mkdir(parents=True, exist_ok=True)
    (out / "splits").mkdir(parents=True, exist_ok=True)
    hashes = {}
    for n, rows in adapted.items():
        p = out / "adapted" / f"{n}_adapted_{S.VERSION}.csv"
        with p.open("x", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        hashes[_rel(p)] = S.sha256(p)
        sp = out / "splits" / f"{n}_splits_{S.VERSION}.json"
        sp.open("x", encoding="utf-8").write(json.dumps({
            **split_audit(n, rows),
            "assignment": [{"source_row": r["source_row"], "split": r["own_task_split"], "leakage_group": r["leakage_group"],
                            "global_leakage_group": r["global_leakage_group"]} for r in rows]}, indent=0) + "\n")
        hashes[_rel(sp)] = S.sha256(sp)
    audit = {"created_at": utc_now(), "mapping_version": M.MAPPING_VERSION, "datasets": {}}
    for n, rows in adapted.items():
        audit["datasets"][n] = {
            "rows": len(rows), "label_meanings": S.LABEL_MEANINGS[n],
            "original_label_distribution": dict(Counter(r["original_label"] for r in rows).most_common()),
            "english_likely": sum(r["english_likely"] for r in rows),
            "not_english_likely_examples_count": sum(1 for r in rows if not r["english_likely"]),
            "empty_text": sum(1 for r in rows if not r["text"].strip()),
            "dedup_recommendation": dict(Counter(r["dedup_recommendation"] for r in rows)),
            "mapping_rules": dict(Counter(r["mapping_rule"] for r in rows).most_common()),
            "training_eligible_mapped_by_category": dict(Counter(r["mapped_category"] for r in rows if r["training_eligible_mapped"])),
            "mapped_by_category_and_split": {c: dict(Counter(r["own_task_split"] for r in rows if r["mapped_category"] == c))
                                             for c in sorted({r["mapped_category"] for r in rows if r["mapped_category"]})},
            "mapped_by_original_label": {lab: dict(Counter(r["mapped_category"] or "excluded" for r in rows if r["original_label"] == lab))
                                         for lab in sorted({r["original_label"] for r in rows})},
            "split_audit": split_audit(n, rows),
        }
    audit["cross_dataset"] = {"exact_normalised_text_groups_spanning_datasets": cross["exact_cross_dataset_key_groups"],
                              "near_duplicate_pairs_humaid_disaster_tweets": len(cross["near_cross_dataset_pairs"]),
                              "near_duplicate_pair_examples": cross["near_cross_dataset_pairs"][:20],
                              "rows_duplicating_news_articles": {n: sum(1 for r in rows if r["duplicates_news_article"]) for n, rows in adapted.items()}}
    (out / f"audit_{S.VERSION}.json").open("x", encoding="utf-8").write(json.dumps(audit, indent=1) + "\n")
    hashes[_rel(out / f"audit_{S.VERSION}.json")] = S.sha256(out / f"audit_{S.VERSION}.json")
    (out / f"prepare_run_{S.VERSION}.json").open("x", encoding="utf-8").write(json.dumps({
        "created_at": utc_now(), "tool": "event_intel.external_experiments.prepare", "mapping_version": M.MAPPING_VERSION,
        "python": sys.version.split()[0], "inputs_verified_against_inventory_v2": verification,
        "news_inputs": {p.name: S.sha256(p) for p in (NEWS_DATASET, SNAPSHOT)}, "outputs": hashes}, indent=1) + "\n")
    print(json.dumps({n: {k: v for k, v in a.items() if k in ("rows", "mapped_by_category_and_split")} for n, a in audit["datasets"].items()}, indent=1))
    print("cross-dataset:", {k: v for k, v in audit["cross_dataset"].items() if k != "near_duplicate_pair_examples"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
