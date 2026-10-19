"""Label-sheet columns and allowed values (label guide v1.1).

Category, scope and text-sufficiency values use the same keys as the rules
baseline so every field can be compared directly. The guide itself is
ai-service/data/labels/LABEL_GUIDE.md.
"""

from __future__ import annotations

from ..lexicons import CATEGORY_LABELS

GUIDE_VERSION = "1.1"  # rows with an older guide_version are rejected until re-reviewed under 1.1

CATEGORIES = tuple(CATEGORY_LABELS)  # the original six; never merged in the source labels
RELEVANCE = ("yes", "possibly", "no", "cannot_tell")
SCOPES = ("sri_lanka", "foreign", "global", "unknown")
TEXT_SUFFICIENT = ("yes", "no")
FLAGS = ("no_actual_event", "follow_up", "duplicate", "metadata_only", "non_english", "ambiguous_category")

LIST_SEPARATOR = ";"      # flags, diseases
EVIDENCE_SEPARATOR = "|"  # several short quotes

# Filled by the labeller. The four core labels must all be present on a labelled row.
CORE_LABELS = ("category", "relevance", "scope", "text_sufficient")
LABEL_COLUMNS = (*CORE_LABELS, "evidence", "flags", "diseases", "notes")

# Pre-filled from the snapshot for reading only. No rules predictions are ever written.
DISPLAY_COLUMNS = ("source", "published_at", "title", "text_chars", "text_excerpt")

SHEET_COLUMNS = ("article_id", "source", "published_at", "title", "url", "text_chars", "text_excerpt",
                 *LABEL_COLUMNS, "annotator", "guide_version")
REQUIRED_COLUMNS = ("article_id", "url", *LABEL_COLUMNS, "annotator", "guide_version")
# Labels-only file that is committed (no article text: the repository is public).
EXPORT_COLUMNS = ("article_id", "url", "title", *LABEL_COLUMNS, "annotator", "guide_version")

# Binary "worth investigating" experiment. cannot_tell is excluded and counted.
BINARY_RELEVANCE = {"yes": True, "possibly": True, "no": False}

SPLITS = ("train", "validation", "test")
