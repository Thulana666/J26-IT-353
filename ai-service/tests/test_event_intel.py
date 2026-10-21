"""Tests for the rules-based event classifier (Component 1). Run from ai-service/:
python -m unittest discover tests
"""

import copy
import unittest

from event_intel import classify_article
from event_intel.evaluate import binary_report, classification_report

LONG = " Health teams continue surveillance and awareness programmes in the affected areas."


def article(title, content=None, summary=None, source="Daily News (Sri Lanka)", country="LK", **extra):
    return dict(
        id=extra.pop("id", "a1"), title=title, content=content, summary=summary, url="https://example.org/a",
        published_at="2026-10-08T00:00:00Z", language="en", country_code=country,
        source={"name": source, "source_type": "news"}, **extra,
    )


def keyword_terms(result, category):
    return {k["term"] for k in result.matched_keywords.get(category, [])}


class HealthTests(unittest.TestCase):
    def test_sri_lankan_dengue_outbreak(self):
        r = classify_article(article(
            "Dengue cases rise sharply in Colombo and Gampaha districts",
            "The National Dengue Control Unit reported 4,200 new cases in the Western Province during the "
            "first week of October 2026. Hospital admissions rose and mosquito breeding sites were cleared "
            "on 3 October 2026 in Colombo." + LONG * 6,
        ))
        self.assertEqual(r.category, "public_health")
        self.assertEqual(r.event_scope, "sri_lanka")
        self.assertEqual(r.relevance, "relevant")
        self.assertEqual(r.processing_status, "classified")
        self.assertEqual(r.text_quality.level, "full_text")
        self.assertEqual([d["name"] for d in r.entities["diseases"]], ["dengue"])
        districts = {l["name"]: l.get("province") for l in r.entities["sri_lanka_locations"] if l["type"] == "district"}
        self.assertEqual(districts, {"Colombo": "Western", "Gampaha": "Western"})
        self.assertIn({"text": "3 October 2026", "date": "2026-10-03"}, r.entities["dates"])
        self.assertIn("4,200 new cases", [i["text"] for i in r.entities["severity_indicators"]])

    def test_neighbouring_country_outbreak_is_possibly_relevant(self):
        r = classify_article(article(
            "Nipah virus disease - India",
            "On 11 June 2026, the Kerala State Health Department confirmed one laboratory-confirmed case of "
            "Nipah virus infection in Kozhikode district, India. WHO assesses the risk as moderate at the "
            "national level, low at the regional level and low at the global level." + LONG * 5,
            source="WHO Disease Outbreak News", country="IN",
        ))
        self.assertEqual(r.category, "public_health")
        self.assertEqual(r.event_scope, "foreign")
        self.assertEqual(r.relevance, "possibly_relevant")
        self.assertIn("neighbouring_country", [l["rule"] for l in r.sri_lanka_links])
        self.assertEqual(r.processing_status, "needs_review")
        risks = {i["level"]: i["rating"] for i in r.entities["severity_indicators"] if i["type"] == "WHO risk assessment"}
        self.assertEqual(risks, {"national": "moderate", "regional": "low", "global": "low"})

    def test_distant_outbreak_is_not_auto_decided(self):
        r = classify_article(article(
            "Ebola disease caused by Bundibugyo virus - Democratic Republic of the Congo",
            "Since the last Disease Outbreak News, additional confirmed cases and deaths have been reported in "
            "the Democratic Republic of the Congo. WHO assesses the risk as high at the national level, "
            "moderate at the regional level and low at the global level." + LONG * 5,
            source="WHO Disease Outbreak News", country="CD",
        ))
        self.assertEqual(r.category, "public_health")
        self.assertEqual(r.event_scope, "foreign")
        # Neither relevant nor irrelevant by default: left for a human.
        self.assertEqual(r.relevance, "uncertain")
        self.assertEqual(r.processing_status, "needs_review")
        self.assertEqual([c["code"] for c in r.entities["foreign_countries"]], ["CD"])

    def test_metadata_only_record_is_not_treated_as_full_article(self):
        r = classify_article(article(
            "Sri Lanka National Dengue Control Unit: Current Status of Dengue in Sri Lanka (As of 04.10.2026 midnight)",
            "Format: Infographic\nThemes: Health\nRelated disaster: Sri Lanka: Dengue Outbreak - May 2026\n"
            "Attachment: https://reliefweb.int/attachments/x/Daily-Update-2026.-10.-04.pdf",
            summary="Format: Infographic · Themes: Health · Related disaster: Sri Lanka: Dengue Outbreak - May 2026",
            source="ReliefWeb (UN OCHA)",
        ))
        self.assertEqual(r.text_quality.level, "metadata_only")
        self.assertEqual(r.text_quality.prose_characters, 0)
        self.assertEqual(r.category, "public_health")
        self.assertEqual(r.relevance, "relevant")
        self.assertEqual(r.processing_status, "needs_review")
        self.assertTrue(any("Limited text" in reason for reason in r.review_reasons))
        self.assertIn({"text": "04.10.2026", "date": "2026-10-04"}, r.entities["dates"])


class DisasterTests(unittest.TestCase):
    def test_gdacs_structured_flood_alert(self):
        r = classify_article(article(
            "Flood in Sri Lanka – Orange alert, 28 Nov 2025 to 5 Dec 2025",
            "Event type: Flood\nAlert level: Orange\nAffected countries: Sri Lanka\nPeriod: 28 Nov 2025 to 5 Dec 2025",
            summary="Orange Flood in Sri Lanka from: 28 Nov 2025 to: 05 Dec 2025.",
            source="GDACS (Global Disaster Alert and Coordination System)",
        ))
        self.assertEqual(r.text_quality.level, "structured_alert")
        self.assertEqual(r.category, "natural_disaster")
        self.assertIn("GDACS event type: Flood", keyword_terms(r, "natural_disaster"))
        self.assertEqual(r.relevance, "relevant")
        self.assertEqual(r.processing_status, "classified")
        # The alert level is quoted from the source, never invented.
        self.assertIn({"type": "source alert", "text": "Alert level: Orange"}, r.entities["severity_indicators"])
        self.assertIn("2025-11-28", [d["date"] for d in r.entities["dates"]])

    def test_relief_report_naming_a_donor_country_stays_in_sri_lanka(self):
        r = classify_article(article(
            "Qatar Charity Delivers New Relief Aid to Flood-Affected Families in Sri Lanka",
            "As part of its ongoing response to Cyclone Ditwah and the resulting floods in Sri Lanka, relief "
            "teams distributed food and hygiene kits to displaced families in Kandy and Badulla." + LONG * 5,
            source="ReliefWeb (UN OCHA)",
        ))
        self.assertEqual(r.category, "natural_disaster")
        self.assertEqual(r.event_scope, "sri_lanka")
        self.assertEqual(r.relevance, "relevant")
        self.assertIn("QA", [c["code"] for c in r.entities["foreign_countries"]])

    def test_metadata_only_report_uses_reliefweb_related_disaster(self):
        r = classify_article(article(
            "Situation Report - Sri Lanka 25th March 2026 at 1000hrs",
            "Format: Situation Report\nRelated disaster: Tropical Cyclone Ditwah - Nov 2025\n"
            "Attachment: https://reliefweb.int/attachments/y/sitrep.pdf",
            source="ReliefWeb (UN OCHA)",
        ))
        self.assertEqual(r.text_quality.level, "metadata_only")
        self.assertEqual(r.category, "natural_disaster")
        self.assertTrue(any(t.startswith("ReliefWeb related disaster") for t in keyword_terms(r, "natural_disaster")))
        # Still only metadata: categorised, but flagged for a human check.
        self.assertEqual(r.processing_status, "needs_review")

    def test_distant_foreign_disaster_without_link_is_not_relevant(self):
        r = classify_article(article(
            "Flood in Mexico – Green alert, 2 Aug 2026 to 4 Aug 2026",
            "Heavy rainfall caused flooding in several states of Mexico; hundreds of people were evacuated." + LONG * 6,
            source="Regional News", country=None,
        ))
        self.assertEqual(r.category, "natural_disaster")
        self.assertEqual(r.event_scope, "foreign")
        self.assertEqual(r.relevance, "not_relevant")


class SupplyChainTests(unittest.TestCase):
    def test_medicine_shortage_in_sri_lanka(self):
        r = classify_article(article(
            "Shortage of essential medicines reported at state hospitals",
            "Several state hospitals in Sri Lanka reported a shortage of essential medicines, including insulin "
            "and antibiotics. The NMRA and the Medical Supplies Division said new stocks are expected." + LONG * 5,
        ))
        self.assertEqual(r.category, "pharma_supply")
        self.assertEqual(r.event_scope, "sri_lanka")
        self.assertEqual(r.relevance, "relevant")

    def test_red_sea_shipping_disruption_is_possibly_relevant(self):
        r = classify_article(article(
            "Container shipping delays grow as vessels avoid the Red Sea",
            "Shipping lines diverted container vessels around the Cape of Good Hope, adding two weeks to "
            "freight routes between Europe and Asia and pushing up cargo costs at ports." + LONG * 5,
            source="NewsAPI", country=None,
        ))
        self.assertEqual(r.category, "logistics")
        self.assertIn("shipping_route", [l["rule"] for l in r.sri_lanka_links])
        self.assertEqual(r.relevance, "possibly_relevant")
        self.assertEqual(r.processing_status, "needs_review")

    def test_supplier_country_trade_restriction(self):
        r = classify_article(article(
            "China tightens export restrictions and tariffs on chemical intermediates",
            "New export restrictions and tariffs announced by China could affect manufacturers that depend on "
            "imported intermediates, according to trade analysts." + LONG * 5,
            source="NewsAPI", country=None,
        ))
        self.assertEqual(r.category, "geopolitical_trade")
        self.assertIn("key_supplier_country", [l["rule"] for l in r.sri_lanka_links])
        self.assertEqual(r.relevance, "possibly_relevant")


class IrrelevantAndIncompleteTests(unittest.TestCase):
    def test_irrelevant_full_text_article(self):
        r = classify_article(article(
            "St. Peter's College old boys celebrate centenary",
            "The old boys' union unveiled a year-long programme of celebrations, including sports meets, "
            "a musical evening and a book launch to mark the school's centenary." + " Alumni gathered." * 40,
            source="Sunday Observer (Sri Lanka)",
        ))
        self.assertEqual(r.category, "other")
        self.assertEqual(r.relevance, "not_relevant")
        self.assertEqual(r.processing_status, "classified")

    def test_post_war_justice_report_is_not_a_trade_disruption(self):
        r = classify_article(article(
            "Victims of Sri Lanka's Civil War Seek Justice",
            "Sixteen years after the war ended, families of the disappeared continue to call for accountability "
            "and truth-seeking, rights groups said in a statement." + " Families gathered in Jaffna." * 30,
            source="ReliefWeb (UN OCHA)",
        ))
        self.assertNotEqual(r.category, "geopolitical_trade")
        self.assertEqual(r.relevance, "not_relevant")

    def test_truncated_irrelevant_article_needs_more_evidence(self):
        r = classify_article(article(
            "Report Finds Global Deterioration in Democracy",
            "An annual report released Tuesday found that key indicators of strong democracies have fallen to "
            "record lows globally, including judicial independence and freedom of expression…",
            source="NewsAPI",
        ))
        self.assertEqual(r.text_quality.level, "truncated")
        self.assertEqual(r.category, "other")
        self.assertEqual(r.relevance, "insufficient_evidence")
        self.assertEqual(r.processing_status, "insufficient_evidence")

    def test_title_only_article(self):
        r = classify_article(article("Grievance Redress Mechanism", None, source="Ministry of Health Sri Lanka"))
        self.assertEqual(r.text_quality.level, "title_only")
        self.assertEqual(r.category, "other")
        self.assertEqual(r.processing_status, "insufficient_evidence")

    def test_empty_title_does_not_crash(self):
        r = classify_article({"title": None, "content": None})
        self.assertEqual(r.category, "other")


class RuleDetailTests(unittest.TestCase):
    def test_indian_ocean_is_not_india(self):
        r = classify_article(article("Cyclone forms over the Indian Ocean", "A deep depression formed." + LONG * 6, country=None))
        self.assertNotIn("IN", [c["code"] for c in r.entities["foreign_countries"]])

    def test_common_word_provinces_need_the_word_province(self):
        r = classify_article(article("Western nations pledge aid", "Southern Province officials met." + LONG * 6))
        names = [l["name"] for l in r.entities["sri_lanka_locations"]]
        self.assertIn("Southern", names)
        self.assertNotIn("Western", names)

    def test_years_are_not_reported_figures(self):
        r = classify_article(article("Dengue in Sri Lanka", "In 2026 cases rose; 35,000 cases were recorded." + LONG * 6))
        figures = [i["text"] for i in r.entities["severity_indicators"] if i["type"] == "reported figure"]
        self.assertEqual(figures, ["35,000 cases"])

    def test_input_record_is_not_modified(self):
        record = article("Dengue cases rise in Sri Lanka", "Dengue cases rose in Colombo." + LONG * 6)
        before = copy.deepcopy(record)
        classify_article(record)
        self.assertEqual(record, before)

    def test_result_has_the_shared_output_shape(self):
        d = classify_article(article("Dengue cases rise in Sri Lanka", "Dengue cases rose." + LONG * 6)).to_dict()
        for key in ("category", "relevance", "matched_keywords", "entities", "text_quality", "explanation",
                    "processing_status", "model", "review_reasons", "event_scope"):
            self.assertIn(key, d)
        self.assertEqual(d["model"]["name"], "rules-baseline")
        self.assertNotIn("severity", d)  # the rules never rate severity


class EvaluateTests(unittest.TestCase):
    def test_classification_report(self):
        report = classification_report(["a", "a", "b", "b"], ["a", "b", "b", "b"])
        self.assertEqual(report["per_class"]["a"], {"precision": 1.0, "recall": 0.5, "f1": 0.6667, "support": 2})
        self.assertEqual(report["per_class"]["b"]["precision"], 0.6667)
        self.assertEqual(report["accuracy"], 0.75)

    def test_binary_report(self):
        report = binary_report([True, True, False, False], [True, False, True, False])
        self.assertEqual((report["precision"], report["recall"], report["f1"]), (0.5, 0.5, 0.5))


if __name__ == "__main__":
    unittest.main()
