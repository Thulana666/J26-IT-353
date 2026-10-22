"""Component 1 event intelligence: article classification.

rules-baseline (this package, v0.1): transparent keyword/gazetteer rules that
classify an article's event category, estimate its candidate relevance for
Sri Lanka and extract diseases, locations, dates and quoted figures. It is the
baseline that a fine-tuned language model will later be compared against
(same result shape, same labelled articles, evaluate.py for the metrics).

Stateless and read-only: it never writes to the database.
"""

from .classifier import RULES_NAME, RULES_VERSION, ArticleInput, ClassificationResult, classify_article, classify_many

__all__ = ["RULES_NAME", "RULES_VERSION", "ArticleInput", "ClassificationResult", "classify_article", "classify_many"]
