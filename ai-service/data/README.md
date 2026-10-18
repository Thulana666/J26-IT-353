# Component 1 NLP dataset (Stage 2 preparation)

Data for training and evaluating the event classifier: rules-only vs model-only
vs hybrid. No model is trained by these tools.

## Workflow

Commands run from `ai-service/` unless noted.

```bash
# 1. Read-only snapshot of event_articles (run from backend/; uses backend/.env)
node --use-system-ca scripts/export-article-snapshot.js

# 2. Blank label sheets (no rules predictions shown)
python -m event_intel.dataset.label_sheet --snapshot data/snapshots/articles_<UTC>.jsonl --annotator TL

# 3. Validate while labelling (read-only); export labels-only CSV when clean
python -m event_intel.dataset.validate_labels data/labels/article_labels_v1.sheet.csv \
    --snapshot data/snapshots/articles_<UTC>.jsonl --export data/labels/article_labels_v1.labels.csv

# 4. After labels are frozen: group-based split
python -m event_intel.dataset.split --snapshot data/snapshots/articles_<UTC>.jsonl \
    --labels data/labels/article_labels_v1.labels.csv --out data/splits/split_v1.json \
    --metadata-review data/labels/metadata_review_v1.labels.csv
```

A pilot of 60 articles: add `--version pilot --max-main 60` to step 2.

## Files

| File | What | Committed? |
|---|---|---|
| `snapshots/articles_<UTC>.jsonl` | Raw `event_articles` rows, sorted by id | **No**: full article text, and the repository is public |
| `snapshots/articles_<UTC>.manifest.json` | Row count, SHA-256, fields, git commit (no credentials) | Yes |
| `labels/LABEL_GUIDE.md` | Label guide v1.0 | Yes |
| `labels/*_v1.sheet.csv` | Working sheets with ≤2,000-character excerpts | **No**: back them up privately |
| `labels/*_v1.labels.csv` | Labels-only export: ids, URLs, titles, labels, short evidence quotes | Yes |
| `labels/label_sheets_v1.manifest.json` | Sampling settings, seed, snapshot hash, article ids per sheet | Yes |
| `splits/split_v1.json` | Article → group → split, with hashes and counts | Yes |

Model weights (`ai-service/models/`) are never committed.

## Sampling (label_sheet)

- **Main sheet:** English articles with usable text. Usable text means the frozen
  rules' text-quality check says full text, short text or a structured alert.
  At most 3 per title family, so templated series don't dominate. Exact
  duplicate texts are labelled once.
- **Metadata review sheet:** 40 metadata-only records, at most 2 per family.
  This set is kept **separate** from the main text-based evaluation.
- **Agreement sheet:** a blank copy of 60 main articles for an independent
  second reviewer. If no second reviewer is available, relabel them yourself
  at least a week later. Document that delayed self-relabelling measures
  consistency, not independent agreement.
- Not sampled: non-English articles, truncated NewsAPI text, title-only records.

## Grouping and split

Articles join one group if they share a title family, a ReliefWeb related
disaster, a GLIDE number, a GDACS event id, identical text, or a WHO outbreak
disease (see `event_intel/dataset/grouping.py`). Whole groups go to
train/validation/test (70/15/15, balanced by gold category, seed 42), so
follow-up reports can't leak across splits.

## Rules that protect the evaluation

- Rules predictions are **never** used as labels. The sheets don't show them.
- The **test split is used once**, for the final comparison. It is never used
  for rule tuning, model selection or threshold selection.
- The rules baseline is **frozen at v0.1.0** (commit `bd3d449`, see
  `event_intel/rules_baseline_v0.1.0.json`). `tests/test_rules_frozen.py`
  fails if a rules file changes. The rules' accuracy has not been validated.
- The six original categories are kept in the labels. If a combined
  supply-disruption class is used in a secondary experiment, document the
  mapping (`pharma_supply`, `geopolitical_trade`, `logistics` →
  `supply_disruption`) in that experiment and leave the labels unchanged.
- `cannot_tell` labels are kept. Every binary relevance result must report how
  many were excluded. The validator and split manifest count them.
- Original article records and URLs are only read, never changed.
