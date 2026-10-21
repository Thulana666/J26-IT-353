"""Rules-based article classifier: the transparent baseline for Component 1's
event intelligence. A fine-tuned language model will later produce the same
result shape so the two can be compared on the same labelled articles.

Method (no trained model):
1. Text quality. Decide what evidence the article really has:
     full_text / short_text   prose content
     structured_alert         machine-generated alert lines (GDACS)
     truncated                cut-off text (e.g. NewsAPI's 200-character limit)
     metadata_only            only source metadata (e.g. ReliefWeb infographics:
                              format, themes, PDF link) - not treated as an article
     title_only               nothing but a title
2. Category. Each category has a keyword lexicon (lexicons.py). Every
   distinct keyword counts once, weighted by where it was found
   (title 3, text 1, metadata 1); each disease found adds public-health
   evidence (title 3, text 2); official event types from GDACS / ReliefWeb
   add structured evidence. The highest score wins if it reaches
   MIN_CATEGORY_SCORE, otherwise "other". Only the first LEAD_CHARS of long
   texts are scored, so a passing mention deep in a report does not decide it.
3. Scope. Sri Lanka gazetteer (country, provinces, districts) versus other
   country names, title first, then text. Sources whose results are already
   filtered to Sri Lanka (ReliefWeb, GDACS) count as Sri Lanka.
4. Relevance for Sri Lanka (a candidate, never a final judgement):
     relevant               the event is in Sri Lanka
     possibly_relevant      foreign, global or unlocated event with an explicit
                            link rule (neighbouring country, key supplier,
                            shipping route, global scope, WHO global risk
                            moderate or higher, or Sri Lanka mentioned)
     uncertain              foreign or unlocated event with no link rule
     not_relevant           no category evidence in usable text, or a foreign
                            natural disaster with no link to Sri Lanka
     insufficient_evidence  too little text to decide
5. Nothing is invented: severity is not rated, figures and alert levels are
   only quoted from the source, and links are possible channels, not causes.
   Uncertain outcomes are marked for human review.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date

from . import lexicons as lx
from .countries import COUNTRY_CODES

RULES_NAME = "rules-baseline"
RULES_VERSION = "0.1.0"

TITLE_WEIGHT = 3
TEXT_WEIGHT = 1
METADATA_WEIGHT = 1
DISEASE_TITLE_WEIGHT = 3
DISEASE_TEXT_WEIGHT = 2
STRUCTURED_EVENT_WEIGHT = 5   # GDACS "Event type: Flood"
OFFICIAL_TYPE_WEIGHT = 3      # ReliefWeb "Disaster type: Epidemic"
MIN_CATEGORY_SCORE = 3
AMBIGUOUS_MARGIN = 1
LEAD_CHARS = 2000             # text used for category scoring and diseases
EXTRACT_CHARS = 4000          # text used for dates and figures
FULL_TEXT_MIN_CHARS = 600
TRUNCATED_MAX_CHARS = 260
MAX_DATES = 10
MAX_FIGURES = 8

# Sources whose API results are already limited to Sri Lanka.
COUNTRY_FILTERED_SOURCES = ("ReliefWeb", "GDACS")

SUFFICIENT_QUALITY = {"full_text", "short_text", "structured_alert"}

# ReliefWeb / GDACS official event types -> category.
OFFICIAL_TYPES = {
    "epidemic": "public_health",
    "insect infestation": "public_health",
    "flood": "natural_disaster",
    "flash flood": "natural_disaster",
    "land slide": "natural_disaster",
    "landslide": "natural_disaster",
    "tropical cyclone": "natural_disaster",
    "storm surge": "natural_disaster",
    "severe local storm": "natural_disaster",
    "drought": "natural_disaster",
    "earthquake": "natural_disaster",
    "tsunami": "natural_disaster",
    "cold wave": "natural_disaster",
    "heat wave": "natural_disaster",
    "wild fire": "natural_disaster",
    "wildfire": "natural_disaster",
    "volcano": "natural_disaster",
}


def _compile(pattern: str, case_sensitive: bool = False) -> re.Pattern:
    """Whole-word match (hyphens count as separators: "flood-affected" matches "flood")."""
    return re.compile(rf"(?<!\w)(?:{pattern})(?!\w)", 0 if case_sensitive else re.IGNORECASE)


CATEGORY_PATTERNS = {
    category: [(label, _compile(pattern)) for label, pattern in terms.items()]
    for category, terms in lx.CATEGORY_TERMS.items()
}
DISEASE_PATTERNS = [(name, _compile(pattern)) for name, pattern in lx.DISEASES.items()]

# Sri Lanka: English names as whole words; Sinhala/Tamil names may carry case endings.
SRI_LANKA_PATTERN = re.compile(
    r"(?<!\w)(?:Sri Lanka|Sri Lankans?|Ceylon)(?!\w)|ශ්‍රී ලංකා|ලංකාව|இலங்கை", re.IGNORECASE
)
DISTRICT_TO_PROVINCE = {
    district: province for province, districts in lx.SRI_LANKA_PROVINCES.items() for district in districts
}
DISTRICT_PATTERN = _compile(
    "|".join(re.escape(d) for d in sorted([*DISTRICT_TO_PROVINCE, *lx.DISTRICT_ALIASES], key=len, reverse=True)),
    case_sensitive=True,
)
PROVINCE_PATTERN = _compile(
    "|".join(
        rf"{re.escape(p)} Province" if p in lx.PROVINCES_NEED_SUFFIX else rf"{re.escape(p)}(?: Province)?"
        for p in sorted(lx.SRI_LANKA_PROVINCES, key=len, reverse=True)
    ),
    case_sensitive=True,
)
# Country names are proper nouns: match case-sensitively, longest first.
COUNTRY_PATTERN = _compile(
    "|".join(re.escape(name) for name in sorted(COUNTRY_CODES, key=len, reverse=True)) + r"|Indian(?! Ocean)",
    case_sensitive=True,
)
GLOBAL_PATTERN = _compile(lx.GLOBAL_SCOPE)
ROUTE_PATTERN = _compile(lx.SHIPPING_ROUTES)

METADATA_LINE = re.compile(r"^(Format|Themes?|Related disasters?|Attachment|Disaster type|GLIDE|Status): ", re.I)
STRUCTURED_LINE = re.compile(r"^(Event type|Alert level|Affected countries|Severity|Period|GLIDE): ", re.I)

WHO_RISK_PATTERNS = [
    re.compile(r"\b(very high|high|moderate|low) at the (national|regional|global) levels?", re.I),
    re.compile(
        r"\b(national|regional|global) (?:level )?risk (?:is |was |as )?(?:assessed as |considered )?"
        r"(very high|high|moderate|low)\b",
        re.I,
    ),
]
FIGURE_PATTERN = re.compile(
    r"\b(\d{1,3}(?:,\d{3})+|\d+)\s+(?:new |confirmed |suspected |probable |reported |additional )?"
    r"(cases|deaths|fatalities|patients|people|persons|families|individuals|houses|homes)"
    r"(?:\s+(?:affected|displaced|injured|dead|died|hospitali[sz]ed|evacuated))?",
    re.I,
)

_MONTH_NAMES = sorted(
    {m.capitalize() for m in lx.MONTHS} | {"Sept"}, key=len, reverse=True
)
_MONTH_ALT = "|".join(_MONTH_NAMES)
DATE_PATTERNS = [
    ("dmy", re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({_MONTH_ALT})\.?,?\s+(\d{{4}})\b")),
    ("mdy", re.compile(rf"\b({_MONTH_ALT})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})\b")),
    ("iso", re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")),
    # Day first (Sri Lankan / British convention), e.g. "04.10.2026".
    ("numeric", re.compile(r"\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b")),
    ("month", re.compile(rf"\b({_MONTH_ALT})\.?\s+(\d{{4}})\b")),
]


# --- Input and output -----------------------------------------------------------------


@dataclass(frozen=True)
class ArticleInput:
    """An event_articles row (plus its source). Only read, never modified."""

    title: str
    id: str | None = None
    summary: str | None = None
    content: str | None = None
    url: str | None = None
    published_at: str | None = None
    language: str | None = None
    country_code: str | None = None
    source_name: str | None = None
    source_type: str | None = None

    @classmethod
    def from_record(cls, record: dict) -> "ArticleInput":
        source = record.get("source") or {}
        return cls(
            id=record.get("id"),
            title=record.get("title") or "",
            summary=record.get("summary"),
            content=record.get("content"),
            url=record.get("url"),
            published_at=record.get("published_at"),
            language=record.get("language"),
            country_code=record.get("country_code"),
            source_name=record.get("source_name") or source.get("name"),
            source_type=record.get("source_type") or source.get("source_type"),
        )


@dataclass
class TextQuality:
    level: str
    prose_characters: int
    used_fields: list[str]
    note: str


@dataclass
class ClassificationResult:
    article_id: str | None
    model: dict
    category: str
    category_label: str
    secondary_categories: list[str]
    category_scores: dict[str, int]
    relevance: str
    event_scope: str
    mentions_sri_lanka: bool
    sri_lanka_links: list[dict]
    matched_keywords: dict[str, list[dict]]
    entities: dict
    text_quality: TextQuality
    explanation: list[str]
    review_reasons: list[str]
    processing_status: str
    reference_date: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


# --- Text assessment ------------------------------------------------------------------


@dataclass
class _Text:
    title: str
    prose: str
    metadata: list[str] = field(default_factory=list)
    structured: list[str] = field(default_factory=list)
    quality: TextQuality | None = None


def _assess_text(article: ArticleInput) -> _Text:
    title = (article.title or "").strip()
    content = (article.content or "").strip()
    summary = (article.summary or "").strip()

    lines = [line.strip() for line in content.splitlines() if line.strip()]
    metadata, structured, prose = [], [], ""
    if lines and all(METADATA_LINE.match(line) for line in lines):
        metadata = lines
    elif lines and all(STRUCTURED_LINE.match(line) for line in lines):
        structured = lines
    else:
        prose = content

    # A summary made of "Key: value · Key: value" parts is metadata, not prose.
    summary_parts = [part.strip() for part in summary.split(" · ") if part.strip()]
    if summary_parts and all(METADATA_LINE.match(part) for part in summary_parts):
        metadata += [part for part in summary_parts if part not in metadata]
    elif summary and summary[:120] not in prose:
        prose = f"{summary}\n{prose}".strip() if prose else summary

    used = ["title"] + (["text"] if prose else []) + (["metadata"] if metadata else []) + (
        ["structured alert"] if structured else []
    )
    truncated = (
        0 < len(content) <= TRUNCATED_MAX_CHARS
        and not metadata
        and not structured
        and (content.endswith(("…", "...")) or (article.source_name or "").lower() == "newsapi")
    )
    if structured:
        level, note = "structured_alert", "Machine-generated alert fields (event type, alert level, dates)."
    elif truncated:
        level, note = "truncated", "Text is cut off at the source; decisions rely mostly on the title."
    elif prose:
        level = "full_text" if len(prose) >= FULL_TEXT_MIN_CHARS else "short_text"
        note = "Prose text available." if level == "full_text" else "Only a short text is available."
    elif metadata:
        level, note = "metadata_only", "No article text: only the title and source metadata were used."
    else:
        level, note = "title_only", "No text or metadata: only the title was used."

    return _Text(
        title=title,
        prose=prose,
        metadata=metadata,
        structured=structured,
        quality=TextQuality(level=level, prose_characters=len(prose), used_fields=used, note=note),
    )


# --- Extraction -------------------------------------------------------------------------


def _find_diseases(text: _Text) -> list[dict]:
    lead = text.prose[:LEAD_CHARS]
    meta = "\n".join(text.metadata + text.structured)
    found = []
    for name, pattern in DISEASE_PATTERNS:
        for where, source in (("title", text.title), ("text", lead), ("metadata", meta)):
            match = pattern.search(source)
            if match:
                found.append({"name": name, "matched": match.group(0), "field": where})
                break
    return found


def _find_sri_lanka_locations(source: str) -> list[dict]:
    locations, seen = [], set()
    for match in SRI_LANKA_PATTERN.finditer(source):
        if "Sri Lanka" not in seen:
            seen.add("Sri Lanka")
            locations.append({"name": "Sri Lanka", "type": "country", "matched": match.group(0)})
    for match in PROVINCE_PATTERN.finditer(source):
        name = match.group(0).replace(" Province", "")
        if name not in seen:
            seen.add(name)
            locations.append({"name": name, "type": "province", "matched": match.group(0)})
    for match in DISTRICT_PATTERN.finditer(source):
        name = lx.DISTRICT_ALIASES.get(match.group(0), match.group(0))
        if name not in seen:
            seen.add(name)
            locations.append(
                {"name": name, "type": "district", "province": DISTRICT_TO_PROVINCE[name], "matched": match.group(0)}
            )
    return locations


def _find_countries(source: str) -> list[dict]:
    countries, seen = [], set()
    for match in COUNTRY_PATTERN.finditer(source):
        name = match.group(0)
        code = "IN" if name == "Indian" else COUNTRY_CODES[name]
        if code not in seen:
            seen.add(code)
            countries.append({"name": name, "code": code})
    return countries


def _iso(year: int, month: int, day: int | None = None) -> str | None:
    try:
        return date(year, month, day).isoformat() if day else date(year, month, 1).isoformat()[:7]
    except ValueError:
        return None


def _find_dates(source: str) -> list[dict]:
    dates, spans = [], []
    for kind, pattern in DATE_PATTERNS:
        for match in pattern.finditer(source):
            if any(start <= match.start() < end for start, end in spans):
                continue
            g = match.groups()
            if kind == "dmy":
                value = _iso(int(g[2]), lx.MONTHS[g[1].lower()], int(g[0]))
            elif kind == "mdy":
                value = _iso(int(g[2]), lx.MONTHS[g[0].lower()], int(g[1]))
            elif kind == "iso":
                value = _iso(int(g[0]), int(g[1]), int(g[2]))
            elif kind == "numeric":
                value = _iso(int(g[2]), int(g[1]), int(g[0]))
            else:
                value = _iso(int(g[1]), lx.MONTHS[g[0].lower()])
            if value:
                spans.append((match.start(), match.end()))
                dates.append({"text": match.group(0), "date": value, "_pos": match.start()})
    dates.sort(key=lambda d: d["_pos"])
    unique, seen = [], set()
    for d in dates:
        if d["date"] not in seen:
            seen.add(d["date"])
            unique.append({"text": d["text"], "date": d["date"]})
    return unique[:MAX_DATES]


def _find_severity_indicators(text: _Text) -> list[dict]:
    """Quoted from the source only - the rules never rate severity themselves."""
    indicators = []
    for line in text.structured:
        if re.match(r"^(Alert level|Severity): ", line, re.I):
            indicators.append({"type": "source alert", "text": line})
    source = text.prose[:EXTRACT_CHARS]
    for pattern in WHO_RISK_PATTERNS:
        for match in pattern.finditer(source):
            groups = [g.lower() for g in match.groups()]
            level = next(g for g in groups if g in ("national", "regional", "global"))
            rating = next(g for g in groups if g not in ("national", "regional", "global"))
            item = {"type": "WHO risk assessment", "level": level, "rating": rating, "text": match.group(0)}
            if not any(i.get("level") == level and i["type"] == item["type"] for i in indicators):
                indicators.append(item)
    seen = set()
    for match in FIGURE_PATTERN.finditer(f"{text.title}\n{source}"):
        if len(seen) >= MAX_FIGURES:
            break
        if re.fullmatch(r"(19|20)\d\d", match.group(1)):
            continue  # a year ("2026 cases"), not a count
        if match.group(0).lower() not in seen:
            seen.add(match.group(0).lower())
            indicators.append({"type": "reported figure", "text": match.group(0)})
    return indicators


# --- Scoring ----------------------------------------------------------------------------


def _score_categories(text: _Text, diseases: list[dict]) -> tuple[dict, dict]:
    lead = text.prose[:LEAD_CHARS]
    meta = "\n".join(text.metadata)
    scores = {category: 0 for category in lx.CATEGORY_TERMS}
    keywords = {category: [] for category in lx.CATEGORY_TERMS}

    for category, patterns in CATEGORY_PATTERNS.items():
        for label, pattern in patterns:
            for where, source, weight in (
                ("title", text.title, TITLE_WEIGHT),
                ("text", lead, TEXT_WEIGHT),
                ("metadata", meta, METADATA_WEIGHT),
            ):
                match = pattern.search(source)
                if match:
                    scores[category] += weight
                    keywords[category].append({"term": label, "matched": match.group(0), "field": where})
                    break

    for disease in diseases:
        weight = {"title": DISEASE_TITLE_WEIGHT, "text": DISEASE_TEXT_WEIGHT}.get(disease["field"], METADATA_WEIGHT)
        scores["public_health"] += weight
        keywords["public_health"].append(
            {"term": f"disease: {disease['name']}", "matched": disease["matched"], "field": disease["field"]}
        )

    # Official classifications from the source (structured evidence).
    for line in text.structured + text.metadata:
        key, _, value = line.partition(": ")
        if key.lower() == "event type":
            category = OFFICIAL_TYPES.get(value.strip().lower())
            if category:
                scores[category] += STRUCTURED_EVENT_WEIGHT
                keywords[category].append({"term": f"GDACS event type: {value.strip()}", "matched": line, "field": "structured"})
        elif key.lower() == "disaster type":
            for part in value.split(","):
                category = OFFICIAL_TYPES.get(part.strip().lower())
                if category:
                    scores[category] += OFFICIAL_TYPE_WEIGHT
                    keywords[category].append(
                        {"term": f"ReliefWeb disaster type: {part.strip()}", "matched": line, "field": "metadata"}
                    )
        elif key.lower() in ("related disaster", "related disasters"):
            # ReliefWeb links the report to an officially recorded disaster,
            # e.g. "Tropical Cyclone Ditwah - Nov 2025": categorise by its name.
            for category, patterns in CATEGORY_PATTERNS.items():
                hit = next((label for label, pattern in patterns if pattern.search(value)), None)
                if hit:
                    scores[category] += OFFICIAL_TYPE_WEIGHT
                    keywords[category].append(
                        {"term": f"ReliefWeb related disaster ({hit})", "matched": line, "field": "metadata"}
                    )
            for name, pattern in DISEASE_PATTERNS:
                if pattern.search(value) and not any(d["name"] == name for d in diseases):
                    scores["public_health"] += OFFICIAL_TYPE_WEIGHT
                    keywords["public_health"].append(
                        {"term": f"ReliefWeb related disaster (disease: {name})", "matched": line, "field": "metadata"}
                    )
        elif key.lower() in ("themes", "theme") and re.search(r"\bhealth\b", value, re.I):
            scores["public_health"] += METADATA_WEIGHT
            keywords["public_health"].append({"term": "ReliefWeb theme: Health", "matched": line, "field": "metadata"})

    return scores, {c: k for c, k in keywords.items() if k}


# --- Main entry point --------------------------------------------------------------------


def classify_article(article: ArticleInput | dict) -> ClassificationResult:
    if isinstance(article, dict):
        article = ArticleInput.from_record(article)

    text = _assess_text(article)
    quality = text.quality
    explanation, review = [f"Text quality: {quality.level} - {quality.note}"], []

    # Entities
    diseases = _find_diseases(text)
    meta_text = "\n".join(text.metadata + text.structured)
    body = f"{text.prose}\n{meta_text}"
    lk_title = _find_sri_lanka_locations(text.title)
    lk_all = _find_sri_lanka_locations(f"{text.title}\n{body}")
    foreign_title = _find_countries(text.title)
    foreign_body = _find_countries(body)
    foreign_all = foreign_title + [c for c in foreign_body if c["code"] not in {f["code"] for f in foreign_title}]
    global_in_title = bool(GLOBAL_PATTERN.search(text.title))
    scope_terms = sorted({m.group(0) for m in GLOBAL_PATTERN.finditer(f"{text.title}\n{text.prose[:EXTRACT_CHARS]}")})
    dates = _find_dates(f"{text.title}\n{text.prose[:EXTRACT_CHARS]}\n{meta_text}")
    severity = _find_severity_indicators(text)

    # Category
    scores, keywords = _score_categories(text, diseases)
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    (best, best_score), (second, second_score) = ranked[0], ranked[1]
    if best_score >= MIN_CATEGORY_SCORE:
        category = best
        secondary = [c for c, s in ranked[1:] if s >= MIN_CATEGORY_SCORE]
        terms = ", ".join(f"'{k['term']}' ({k['field']})" for k in keywords.get(category, [])[:6])
        explanation.append(f"Category {category} (score {best_score}): matched {terms}.")
        if second_score >= MIN_CATEGORY_SCORE and best_score - second_score <= AMBIGUOUS_MARGIN:
            review.append(f"Ambiguous category: {best} ({best_score}) vs {second} ({second_score}).")
    else:
        category, secondary = "other", []
        explanation.append(
            f"No category reached the minimum score of {MIN_CATEGORY_SCORE} "
            f"(highest: {best} = {best_score}); classified as other."
        )

    # Scope: where is the event?
    source_filtered = any((article.source_name or "").startswith(s) for s in COUNTRY_FILTERED_SOURCES)
    mentions_sri_lanka = bool(lk_all)
    if lk_title:
        scope = "sri_lanka"
        explanation.append(f"Scope: Sri Lanka - '{lk_title[0]['matched']}' in the title.")
    elif source_filtered and article.country_code == "LK":
        scope = "sri_lanka"
        explanation.append(f"Scope: Sri Lanka - {article.source_name} results are filtered to Sri Lanka.")
    elif foreign_title:
        scope = "foreign"
        explanation.append(f"Scope: foreign - {', '.join(c['name'] for c in foreign_title)} in the title.")
    elif global_in_title:
        scope = "global"
        explanation.append("Scope: global - the title describes a global or multi-country event.")
    elif lk_all and not foreign_body:
        scope = "sri_lanka"
        explanation.append(f"Scope: Sri Lanka - '{lk_all[0]['matched']}' in the text (not the title).")
        if category != "other":
            review.append("Sri Lanka is named only in the text, not the title.")
    elif foreign_body:
        scope = "foreign"
        explanation.append(f"Scope: foreign - {', '.join(c['name'] for c in foreign_body[:3])} in the text.")
    else:
        scope = "unknown"
        explanation.append("Scope: unknown - no country or region found.")

    # Possible links from a foreign / global event to Sri Lanka (channels, not causes).
    links = []
    if scope in ("foreign", "global", "unknown"):
        codes = {c["code"] for c in (foreign_title or foreign_all)}
        neighbours = sorted(codes & lx.NEIGHBOURING_COUNTRIES)
        if neighbours:
            links.append({"rule": "neighbouring_country", "detail": ", ".join(neighbours)})
        suppliers = sorted(codes & lx.KEY_SUPPLIER_COUNTRIES)
        if suppliers and category in ("pharma_supply", "geopolitical_trade", "logistics"):
            links.append({"rule": "key_supplier_country", "detail": ", ".join(suppliers)})
        route = ROUTE_PATTERN.search(f"{text.title}\n{text.prose[:LEAD_CHARS]}")
        if route and category in ("logistics", "geopolitical_trade"):
            links.append({"rule": "shipping_route", "detail": route.group(0)})
        if scope == "global":
            links.append({"rule": "global_scope", "detail": "global or multi-country event"})
        # Only WHO's *global* rating: "regional" means the outbreak's own WHO region.
        elevated = [i for i in severity if i["type"] == "WHO risk assessment" and i["level"] == "global"
                    and i["rating"] in ("moderate", "high", "very high")]
        if elevated:
            links.append({"rule": "who_risk", "detail": "; ".join(i["text"] for i in elevated)})
        if mentions_sri_lanka:
            links.append({"rule": "mentions_sri_lanka", "detail": lk_all[0]["matched"]})

    # Relevance (a candidate for review, not a final judgement).
    if category == "other":
        if quality.level in SUFFICIENT_QUALITY:
            relevance = "not_relevant"
            explanation.append("Relevance: not relevant - usable text but no event-category evidence.")
        else:
            relevance = "insufficient_evidence"
            explanation.append("Relevance: insufficient evidence - too little text to decide.")
    elif scope == "sri_lanka":
        relevance = "relevant"
        explanation.append("Relevance: candidate relevant - the event appears to be in Sri Lanka.")
    elif links:
        relevance = "possibly_relevant"
        explanation.append(
            "Relevance: possibly relevant - event outside Sri Lanka (or unlocated) with possible link(s): "
            + "; ".join(f"{l['rule']} ({l['detail']})" for l in links)
            + ". This is a channel to check, not a confirmed impact."
        )
        review.append("Event outside Sri Lanka: check whether the link to Sri Lanka is real.")
    elif scope == "foreign" and category == "natural_disaster":
        relevance = "not_relevant"
        explanation.append("Relevance: not relevant - foreign natural disaster with no link to Sri Lanka found.")
    else:
        relevance = "uncertain"
        explanation.append("Relevance: uncertain - no rule links this event to Sri Lanka either way.")
        review.append("No link rule applies: needs a human decision.")

    if category != "other" and quality.level not in SUFFICIENT_QUALITY:
        review.append(f"Limited text ({quality.level}): the category relies on the title or metadata.")
    if severity:
        explanation.append("Severity is not rated by the rules; indicators are quoted from the source.")

    if relevance == "insufficient_evidence":
        status = "insufficient_evidence"
    elif review:
        status = "needs_review"
    else:
        status = "classified"

    return ClassificationResult(
        article_id=article.id,
        model={"name": RULES_NAME, "version": RULES_VERSION},
        category=category,
        category_label=lx.CATEGORY_LABELS[category],
        secondary_categories=secondary,
        category_scores=scores,
        relevance=relevance,
        event_scope=scope,
        mentions_sri_lanka=mentions_sri_lanka,
        sri_lanka_links=links,
        matched_keywords=keywords,
        entities={
            "diseases": diseases,
            "sri_lanka_locations": lk_all,
            "foreign_countries": foreign_all,
            "scope_terms": scope_terms,
            "dates": dates,
            "severity_indicators": severity,
        },
        text_quality=quality,
        explanation=explanation,
        review_reasons=review,
        processing_status=status,
        reference_date=article.published_at,
    )


def classify_many(records: list[dict]) -> list[ClassificationResult]:
    return [classify_article(record) for record in records]
