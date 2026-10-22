"""Versioned rules that map a SMALL, audited subset of external records to project categories.

Every mapped label is label_source = MAPPING_VERSION ("auto_mapped_v2"): an automatic, rule-based weak label, never a
human label. Records the rules cannot assign defensibly are excluded with a reason, not forced.

Guide v1.1 `natural_disaster` = floods, cyclones, landslides, drought, extreme weather, earthquakes.
Wildfires, volcanoes and avalanches are not listed, so records about them are excluded.
"""

from __future__ import annotations

import re

MAPPING_VERSION = "auto_mapped_v2"  # v2: the outbreak rule needs a named disease (v1 accepted "outbreak of violence")

# ---------------- HumAID ----------------
# All HumAID tweets were collected during natural-disaster events, but the LABEL is an information type.
# Only labels that report the disaster's impact describe the disaster event itself.
HUMAID_TO_NATURAL_DISASTER = {
    "infrastructure_and_utility_damage", "injured_or_dead_people",
    "displaced_people_and_evacuations", "missing_or_found_people",
}
HUMAID_EXCLUDED = {
    "rescue_volunteering_or_donation_effort": "excluded_aid_or_donation: Decision O1 labels aid by the disaster only when the text names it; not verifiable automatically",
    "requests_or_urgent_needs": "excluded_needs: need statements are not events by themselves (guide: medicine supply / O1)",
    "caution_and_advice": "excluded_warning: warnings about future hazards are forecasts (Decision O4)",
    "sympathy_and_support": "excluded_no_event: sympathy or prayers describe no event",
    "other_relevant_information": "excluded_ambiguous: catch-all information type",
    "not_humanitarian": "excluded_ambiguous: not humanitarian; content unknown",
}
# Forecast / anticipation cues: Decision O4 says a prediction is not an event.
FORECAST_TEXT = re.compile(r"\b(will|would|may|might|could|expected|expect\w*|forecast\w*|predict\w*|approach\w*|"
                           r"await\w*|warning\w*|watch(es)?|likely|possible|possibly|path of|heads? (for|to|toward)\w*|"
                           r"brac\w*|prepar\w*|ahead of|before)\b", re.I)
HUMAID_UNLISTED_HAZARD_BLOCKS = {"canada_wildfires_2016", "greece_wildfires_2018", "california_wildfires_2018"}

# ---------------- Disaster Tweets ----------------
NATURAL_KEYWORDS = {
    "flood", "floods", "flooding", "inundated", "inundation", "deluge", "deluged",
    "cyclone", "typhoon", "hurricane", "tornado", "twister", "whirlwind",
    "storm", "rainstorm", "thunderstorm", "hailstorm", "hail", "snowstorm", "blizzard", "windstorm",
    "violent storm", "sandstorm", "dust storm", "heat wave", "lightning", "thunder",
    "landslide", "mudslide", "drought", "earthquake", "seismic", "aftershock", "epicentre", "tsunami",
}
NATURAL_TEXT = re.compile(r"\b(flood\w*|inundat\w*|deluge\w*|cyclone\w*|typhoon\w*|hurricane\w*|tornado\w*|twister\w*|"
                          r"\w*storm\w*|blizzard\w*|hail\w*|heat ?wave\w*|lightning|thunder\w*|landslide\w*|mudslide\w*|"
                          r"drought\w*|earthquake\w*|quake\w*|seismic|aftershock\w*|tsunami\w*|monsoon\w*|rainfall|heavy rain\w*)\b", re.I)
HEALTH_KEYWORDS = {"outbreak", "quarantine", "quarantined"}
# Broad health mention (v1 regex, unchanged): used only to EXCLUDE target=0 tweets from `other`.
HEALTH_MENTION = re.compile(r"\b(ebola|mers|legionnaire\w*|measles|virus\w*|flu|influenza|cholera|disease\w*|infect\w*|"
                            r"outbreak\w*|epidemic\w*|pandemic\w*|quarantin\w*|salmonella|e\.? ?coli|hepatitis|meningitis)\b", re.I)
# Disease evidence must name a disease or infection: 'outbreak' / 'quarantine' alone is not enough.
HEALTH_TEXT = re.compile(r"\b(ebola|mers|legionnaire\w*|measles|virus\w*|flu|influenza|cholera|disease\w*|infect\w*|"
                         r"salmonella|e\.? ?coli|hepatitis|meningitis|anthrax|plague|tuberculosis|malaria|dengue)\b", re.I)
# Transport incidents could be `logistics` (road/rail/air/shipping disruption) or an accident (`other`):
# undecidable from a keyword, so excluded.
AMBIGUOUS_TRANSPORT_KEYWORDS = {
    "derailment", "derailed", "derail", "bridge collapse", "airplane accident", "collision", "collided", "collide",
    "crash", "crashed", "wreck", "wreckage", "wrecked", "sinking", "sunk", "oil spill", "hijack", "hijacker", "hijacking",
}
UNLISTED_HAZARD_KEYWORDS = {"wildfire", "wild fires", "forest fire", "forest fires", "bush fires", "volcano", "lava",
                            "avalanche", "sinkhole", "natural disaster"}


def map_humaid(row: dict) -> tuple[str | None, str]:
    """Return (category or None, rule/status). `row` is a cleaned HumAID row with inferred_event_block."""
    if row.get("dedup_recommendation", "keep") != "keep":
        return None, "excluded_duplicate_" + row["dedup_recommendation"]
    if row.get("inferred_event_block") in HUMAID_UNLISTED_HAZARD_BLOCKS:
        return None, "excluded_hazard_not_in_guide (wildfire)"
    label = row["class_label"]
    if label in HUMAID_TO_NATURAL_DISASTER:
        if FORECAST_TEXT.search(row.get("text_clean", "")):
            return None, "excluded_forecast_or_anticipation_wording (Decision O4)"
        return "natural_disaster", "humaid_impact_label_during_natural_disaster_event"
    return None, HUMAID_EXCLUDED.get(label, "excluded_unknown_label")


def map_disaster_tweet(row: dict) -> tuple[str | None, str]:
    """Return (category or None, rule/status) for a cleaned Disaster Tweets row."""
    if row.get("dedup_recommendation", "keep") != "keep":
        return None, "excluded_duplicate_" + row["dedup_recommendation"]
    kw, text, target = row.get("keyword_decoded", "").strip().lower(), row.get("text_clean", ""), row["target"]
    if kw in AMBIGUOUS_TRANSPORT_KEYWORDS:
        return None, "excluded_possible_logistics_or_accident"
    if kw in UNLISTED_HAZARD_KEYWORDS:
        return None, "excluded_hazard_not_in_guide"
    if target == "1":
        if not kw:
            return None, "excluded_no_keyword_unknown_event_type"
        if kw in NATURAL_KEYWORDS:
            if NATURAL_TEXT.search(text):
                return "natural_disaster", "dt_real_disaster_natural_hazard_keyword_and_text"
            return None, "excluded_natural_keyword_without_hazard_text"
        if kw in HEALTH_KEYWORDS:
            if HEALTH_TEXT.search(text):
                return "public_health", "dt_real_disaster_outbreak_keyword_and_disease_text"
            return None, "excluded_health_keyword_without_disease_text"
        return "other", "dt_real_event_outside_categories (accident, fire, violence)"
    if HEALTH_MENTION.search(text):
        return None, "excluded_not_real_disaster_but_mentions_disease"
    return "other", "dt_not_real_disaster (figurative or unrelated; no specific event)"


def map_bbc(row: dict) -> tuple[str | None, str]:
    """BBC topic sections are not event categories: no mapping (prior audit, section 4)."""
    return None, "not_mapped_topic_label"


# Rules whose mapped labels may be used for training: precision >= 0.80 in the recorded spot-check
# (spotcheck.py / mapping_spot_check_v2.json; reviewer = AI assistant, NOT a human). Others are kept in
# the adapted files for transparency but never trained on.
ACCEPTED_RULES = {
    "humaid_impact_label_during_natural_disaster_event",          # 44/50 = 0.88
    "dt_not_real_disaster (figurative or unrelated; no specific event)",  # 39/40 = 0.975
    "dt_real_disaster_outbreak_keyword_and_disease_text",          # see mapping_spot_check_v2.json; low diversity
}
REJECTED_RULES = {
    "dt_real_disaster_natural_hazard_keyword_and_text": "13/40 = 0.33: jokes, insurance, forecasts and warnings",
    "dt_real_event_outside_categories (accident, fire, violence)": "31/40 = 0.78: includes natural disasters and transport disruption (logistics)",
}

MAPPERS = {"humaid": map_humaid, "disaster_tweets": map_disaster_tweet, "bbc_news": map_bbc}

_NON_LATIN_EXEMPT = re.compile(r"[ἀ-῿]")  # HumAID corrupted-emoji artefacts (see cleaning report)
_STOP = re.compile(r"\b(the|and|of|to|in|is|for|on|a|are|with|at|by|from|this|that|was|be)\b", re.I)


def english_likely(text: str) -> bool:
    """Cheap language screen: mostly Latin letters (ignoring known emoji artefacts) and an English stopword."""
    letters = [c for c in _NON_LATIN_EXEMPT.sub("", text) if c.isalpha()]
    if not letters:
        return False
    latin = sum(1 for c in letters if c.isascii()) / len(letters)
    return latin >= 0.8 and bool(_STOP.search(text))
