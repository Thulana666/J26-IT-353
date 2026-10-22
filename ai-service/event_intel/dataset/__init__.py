"""Dataset preparation for the trained NLP classifier (Component 1, Stage 2).

Snapshot (backend/scripts/export-article-snapshot.js, read-only)
  -> label_sheet      blank sheets, no rules predictions
  -> validate_labels  checks labels against guide v1.1; labels-only export
  -> split            group-based reproducible train / validation / test

See ai-service/data/README.md for the workflow.
"""
