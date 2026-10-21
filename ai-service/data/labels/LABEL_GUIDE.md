# Article Label Guide — version 1.1

> Adopted 2026-10-18, replacing version 1.0 (still available in Git history).
> Decisions O1–O6 from the pilot review are marked "Decision O1" … "O6".
> Rows labelled under 1.0 must be re-reviewed under this guide before their
> `guide_version` is changed to `1.1`.

Use this guide to label articles for the Component 1 event classifier. These
labels are the **ground truth** for comparing the rules baseline, the
fine-tuned model and the hybrid, so consistency matters more than speed.

## Changes from version 1.0

| # | Section | Change | Why (pilot finding) |
|---|---|---|---|
| 1 | Category, Flags | `no_actual_event` means the content describes **no specific event** that happened or is happening. A real event outside the six categories is `other` **without** the flag. The content decides the flag, not the article type | The flag was applied to every non-event row, including real events (pest spread, rights campaign), and unevenly to similar reports |
| 2 | Category (Decision O1) | Institutional actions (funding approvals, donations, workshops, programme or plan launches) are **not events by themselves**. Label the situation the article describes | Funding, programme and donation articles were labelled by article type |
| 3 | Flags (Decision O3) | `follow_up` = the title and excerpt show the **continuing status, progression or cumulative situation of the same identifiable ongoing event**. An explicit reference to an earlier report is enough but not required. A date, number or "situation report" alone is not enough | The flag was missing on explicit and cumulative updates, and present on some series reports without a stated link |
| 4 | Text sufficiency | `yes` = the title and excerpt are enough to identify and categorise the event, **including structured alerts**. Rules for brief alerts and one-sentence texts added | GDACS alerts, a one-sentence infographic description and an agenda-only text were treated inconsistently |
| 5 | Diseases (new section) | Record diseases **explicitly reported as occurring**, using the source's name. Not required when no disease is named. Unknown names are a vocabulary warning, not an error | Filled on 3 of 13 public-health rows; `Sudan virus disease` triggered a warning |
| 6 | Category: medicine supply (new) | `pharma_supply` needs a **documented** shortage, stock-out, recall, manufacturing disruption or supply interruption | Two donation articles were labelled `pharma_supply` without a documented shortage |
| 7 | Donations (Decision O2) | A medicine donation with no documented shortage is `other`, relevance `possibly` when the text supports a plausible link to medicine supply or health needs in Sri Lanka. A donation for a qualifying disaster is labelled by that disaster | As above |
| 8 | Relevance (Decisions O2, O6) | `yes` / `possibly` / `no` restated around **what the text supports**. `possibly` now also covers Sri Lankan situations the text explicitly links to health or medicine, and O2 donations. An outbreak abroad is not `possibly` just because spread is theoretically possible | Imported-case, distant-outbreak and food-insecurity articles needed a clearer boundary |
| 9 | Category: natural disasters | `natural_disaster` only for a qualifying disaster or severe-weather event. Chronic groundwater pollution or a water-quality problem is not a disaster by itself | A groundwater-pollution article was labelled `natural_disaster` |
| 10 | Category: forecasts (Decision O4) | A forecast or outlook is not itself an event. It counts only when the text also reports **current observed conditions** that meet a category | A drought outlook mixed forecast and observed conditions |
| 11 | Category: bulletins (Decision O5) | A bulletin with several events is labelled by the **first event in its substantive content**, never a later one chosen for relevance. This takes precedence over the "title" rule | A regional bulletin whose first reported event was a Sri Lankan outbreak was labelled by its introduction |
| 12 | Working with the CSV | One value per cell; open the CSV as text so Excel does not change dates or `guide_version` | The pilot sheet had 19 shifted rows, reformatted dates and `1.0` saved as `1` |

**Text from guide 1.0 revised to remove conflicts:**
- The 1.0 category bullet listed "funding announcements" as automatically `other` + `no_actual_event`. It now refers to the content rule (Decision O1).
- The 1.0 relevance row "`no`: No actual event; programme, funding, policy or annual reports" now excludes O2 donations and O6 situations.
- The 1.0 flag meaning "Mentions a disease or hazard but describes no actual event" is replaced by the general definition.
- The 1.0 `follow_up` meaning "An update to an earlier report" is replaced by Decision O3.

**Unchanged:** the six category names, the four relevance values, the scope rules, the evidence rule, the other flags and the golden rules.

## Golden rules

1. **Label only from the title and the text shown in the sheet.** Do not open
   the URL to fill gaps: the models never see that extra information.
2. **Judge the article, not the world.** Do not add what you know from other
   news. If the text does not say it, it does not count. Do not infer causes
   or effects the text does not state.
3. **No rules predictions are shown, and none should be copied.** Rules output
   is never ground truth.
4. **Do not edit** `article_id`, `url`, `title` or the excerpt. Do not rename,
   add or delete columns.
5. When unsure, pick the most cautious value and explain in `notes`.
6. **Category and relevance are separate decisions.** Decide what the event
   is, then decide whether it matters for Sri Lanka.

## Fields

| Column | Values | Question |
|---|---|---|
| `category` | `public_health`, `natural_disaster`, `pharma_supply`, `geopolitical_trade`, `logistics`, `other` | What event is the article **mainly** about? |
| `relevance` | `yes`, `possibly`, `no`, `cannot_tell` | Should an analyst check this article for possible effects on medicine demand or supply in Sri Lanka? |
| `scope` | `sri_lanka`, `foreign`, `global`, `unknown` | Where is the event happening? |
| `text_sufficient` | `yes`, `no` | Do the title and excerpt let you identify and categorise the event? |
| `evidence` | short quotes copied from the text, separated by `\|` | Which words support the category and relevance? |
| `flags` | see below, separated by `;` | Anything unusual? |
| `diseases` | disease names, separated by `;` | Which diseases does the text **explicitly report as occurring**? |
| `notes` | free text | Reasons for difficult decisions |
| `annotator` | your initials | |
| `guide_version` | `1.1` (pre-filled) | |

**Evidence is required** unless the category is `other` and relevance is
`no` or `cannot_tell`. Keep each quote short (under 25 words) and copy it
exactly, including the source's own typos, so the validator can find it.
Quote **observed facts**, not predictions (Decision O4). For a bulletin, quote
the first reported event (Decision O5).

## Category

### What counts as an event

An **event** is something specific that happened or is happening at an
identifiable time and place. Examples: cases, deaths, a declared outbreak, a
rising trend, an alert, damage, displacement, a shortage, a disruption or an
emergency response. Events outside the six categories also count, for example
a crop-pest infestation, a reported rights campaign or worsening food
insecurity.

An article **describes no specific event** when its content is only about
plans, strategies, programme descriptions, organisational profiles, policy
positions, general commentary, advice, research, awareness or predictions.
Use `other` + `no_actual_event`.

**Decision O1: institutional actions.** Funding approvals, donations,
workshops, meetings, programme launches and plan launches are **not events by
themselves**. Look at the situation the article describes:
- If it reports a real underlying event in one of the categories, use that
  category. Example: aid "for the flood disaster" is `natural_disaster`.
- If it reports a real situation outside the categories, use `other`
  **without** the flag. Example: a programme article that also reports worsening
  food insecurity.
- If it reports only the institutional activity, use `other` +
  `no_actual_event`, because no specific event is described.

Never add `no_actual_event` just because the article is a funding
announcement, report or programme description. Apply the definition to the
content.

**Decision O4: forecasts and outlooks.** A forecast or outlook is **not
itself an event**.
- If the text also reports **current observed conditions** that meet a
  category definition ("several provinces … are recording below average
  rainfall"), label that observed event. Quote the observed conditions as
  evidence, not the forecast.
- If the text only predicts a possible future event ("Seasonal forecast
  indicates below-normal rainfall"), use `other` + `no_actual_event`.
- Do not treat a prediction as evidence that something has happened.
- An **alert** counts as an event when it reports a hazard that has been
  detected or is occurring (e.g. a GDACS alert stating the event type, the
  affected country and the period). A warning about a hazard that may happen
  later is a forecast.

### Categories

| Category | Use for |
|---|---|
| `public_health` | Disease outbreaks, epidemics, case surges, health emergencies |
| `natural_disaster` | Floods, cyclones, landslides, drought, extreme weather, earthquakes |
| `pharma_supply` | A **documented** medicine shortage, stock-out, recall, manufacturing problem or supply interruption |
| `geopolitical_trade` | Sanctions, export or import restrictions, trade disputes, conflict blocking trade |
| `logistics` | Shipping, port, air-freight or road transport disruption |
| `other` | No specific event, **or** a real event outside these categories |

- Pick the event the **title and first paragraphs** focus on. "Leptospirosis
  cases rise after floods" is about disease cases, so it's `public_health`.
- If two events are truly equal, use the one in the title and add
  `ambiguous_category`. This rule does not apply to bulletins; see below.
- A disaster report that only *warns* about disease risk stays
  `natural_disaster`.
- **Mentioning a disease is not an event.** Prevention tips, vaccine research,
  awareness days and hospital openings are `other` + `no_actual_event`, unless
  the text also reports an actual outbreak or case surge.
- **`geopolitical_trade` needs a documented trade measure or disruption.**
  Food insecurity, price rises or economic hardship linked to a foreign crisis
  are `other` unless the text describes a qualifying sanction, trade
  restriction or trade-related disruption.

### Bulletins with several events (Decision O5)

Some bulletins and digests report several events.
- Label the **first event in the substantive content**. Skip introductory
  boilerplate such as the bulletin's purpose, method or contact details.
- **Do not choose a later event because it seems more relevant to Sri
  Lanka.** Relevance, scope and diseases follow the first event too.
- Quote evidence that supports the first event.
- For bulletins, this rule replaces the "title" and "two events are equal"
  rules above, because bulletin titles usually name no event. You may add
  `ambiguous_category` when a later event of another category is equally
  prominent, but the labels still follow the first event.

### Natural disasters versus chronic problems

Use `natural_disaster` only for a qualifying disaster or severe-weather event:
flood, cyclone, landslide, drought, extreme weather or earthquake.

- **Chronic groundwater pollution, salinity, over-extraction or an ongoing
  water-quality problem is not a natural disaster by itself.** If the text
  reports it as a current situation, use `other` (a real event outside the
  categories, no flag). If the text only describes a project to address it,
  apply Decision O1.
- If the text reports disease cases caused by the water problem, use
  `public_health`.
- Water shortage *caused by a drought* stays `natural_disaster`.

### Medicine supply

`pharma_supply` needs the text to **state the supply problem itself**:

- a shortage or stock-out of medicines or medical supplies ("hospitals have run
  out of insulin");
- a recall or quality withdrawal;
- a manufacturing stoppage or production problem;
- an interruption of medicine imports or distribution.

The `evidence` quote must be the sentence that states the problem.

**Do not infer a shortage** from an article that only mentions medicines, aid,
donations or "urgent" supplies. Words like "urgent medicines" or "supplies
are imperative" describe need or importance. They are not a documented
shortage unless the text says medicines are unavailable or running out.

### Medicine donations and aid (Decisions O1, O2)

Categorise a donation or aid article by **what the text reports**, not by the
fact that medicines are involved:

| The text reports | category | relevance | flag |
|---|---|---|---|
| A documented medicine shortage in Sri Lanka that the donation responds to | `pharma_supply` (quote the shortage, not the donation) | `yes` | |
| A qualifying disaster or outbreak that the aid responds to | the category of that event (e.g. `natural_disaster`) | by the usual rules (usually `yes` for Sri Lanka) | |
| A medicine donation only, with no shortage, disaster or outbreak stated | `other` | `possibly` if the text supports a plausible link to medicine supply or health needs in Sri Lanka; otherwise `no` | `no_actual_event` |
| A non-medical donation or funding only, no situation described | `other` | `no` unless Decision O6 applies | `no_actual_event` |

Never infer a shortage, stock-out, recall or manufacturing disruption from the
donation alone.

## Relevance to Sri Lanka

The question stays the same: *should an analyst check this article for
possible effects on medicine demand or supply in Sri Lanka?* Answer from what
the **text supports**, separately from the category.

| Value | When |
|---|---|
| `yes` | The event directly affects Sri Lanka: a health event in Sri Lanka; a disaster in Sri Lanka affecting people (injuries, displacement, water or sanitation problems, disease risk); a documented medicine supply problem in Sri Lanka |
| `possibly` | The text supports a **plausible but uncertain** connection to Sri Lanka or its pharmaceutical supply chain. See the three cases below |
| `no` | The text supports no plausible connection: no specific event (except O2 donations); programme, funding, policy or annual reports with no O2 or O6 link; a distant event with no stated route to Sri Lanka; sport or politics |
| `cannot_tell` | The text is too thin to decide (usually with `text_sufficient = no`) |

**The three cases for `possibly`:**
1. **Foreign or global events with a route the text supports:** a neighbouring
   country (India, Maldives, Bangladesh, Pakistan, Nepal, Bhutan,
   Afghanistan); a supplier Sri Lanka relies on; a shipping route; spread
   **towards Sri Lanka or South Asia** described in the text; or a WHO *global*
   alert.
2. **Decision O6: indirect effects the text links to health or medicine.**
   The article **explicitly** links a situation to health or medicine-related
   consequences, even without documenting a medicine shortage or demand
   increase. Example: food insecurity with households "reducing expenditure on
   education and health". Do not infer a link the article does not state; a
   food-insecurity article that never mentions health is `no`.
3. **Decision O2: medicine donations with no documented shortage**, when the
   text supports a plausible link to medicine supply or health needs in Sri
   Lanka.

**More rules:**
- **International spread is not automatically `possibly`.** An outbreak or an
  imported case in a distant country is `no` unless the text describes spread
  towards Sri Lanka or its region, a stated route, or a WHO global alert.
  Theoretical spread is not enough.
- `possibly` does not mean "impact confirmed". It only means "worth checking".
- A `possibly` label needs evidence: quote the words that support the
  connection.

## Scope

Unchanged from 1.0.

- `sri_lanka`: Sri Lanka is among the affected places, even if other countries are too.
- `foreign`: a specific country or countries, not including Sri Lanka.
- `global`: worldwide, multi-region or a WHO global situation.
- `unknown`: the text gives no location.

Where the publisher or donor is located does not matter. A Japanese grant for
Sri Lankan flood victims is `sri_lanka`. Scope follows the event chosen for
`category`, so a bulletin whose first reported event is in Sri Lanka is
`sri_lanka` (Decision O5).

## Text sufficiency

- `yes`: the title and excerpt contain enough to **identify and categorise the
  event**, or to tell that there is no event. This includes structured alerts.
- `no`: metadata only (format, themes, PDF link); a title without enough
  detail; or text too incomplete to classify reliably.

**Brief structured alerts** (e.g. GDACS: "Event type: Flood / Alert level /
Affected countries / Period"):
- `yes` when the alert states the **event type, the affected country and a
  date or period**;
- `no` when the event type or the affected country is missing.

**Very short texts:**
- One sentence that names the event is `yes`. Example: an infographic described
  as showing the response "for Cyclone Ditwah".
- Text that identifies no event is `no`. Example: a meeting agenda with no
  event named. If the event cannot be identified, relevance is usually
  `cannot_tell`.

You may still label category and relevance from the title when the title alone
makes them clear, but set `text_sufficient = no`.

## Diseases

- Record a disease only when the text **explicitly reports it as occurring**:
  cases, deaths, infections or a declared outbreak. Do not record diseases
  that are only mentioned as risks, background or prevention.
- **Use the name as stated in the source.** Where the source gives a full name
  and an abbreviation, use the full name: `Sudan virus disease`, not `SVD`.
  Separate several diseases with `;`.
- Record diseases whatever the category. A flood report that reports
  leptospirosis cases lists `leptospirosis`.
- **Not required** when the article names no disease, e.g. a bulletin about
  "infectious diseases" in general, or "pneumonia of undetermined etiology"
  (record that phrase only if the source presents it as the condition).
- For a bulletin, record the diseases of the first reported event (Decision O5).
- Names missing from the tool's disease list (e.g. `Sudan virus disease`,
  `Oropouche`) are **valid**. The validator shows a vocabulary warning, not an
  error. Do not change a correct name just to remove the warning.

## Flags

| Flag | Meaning |
|---|---|
| `no_actual_event` | The content describes **no specific event** that happened or is happening (see "What counts as an event", Decisions O1 and O4). Never used for a real event outside the categories |
| `follow_up` | The title and excerpt show the **continuing status, progression or cumulative situation of the same identifiable ongoing event** (Decision O3) |
| `duplicate` | Same article as another row. Leave the core labels blank and write the kept `article_id` in `notes` |
| `metadata_only` | Only metadata, no article text |
| `non_english` | Not in English |
| `ambiguous_category` | Two categories are equally strong |

**`follow_up` (Decision O3).** The same ongoing event must be identifiable from
the title and excerpt. Signals that count:
- an explicit reference to an earlier report: "Since the first disease outbreak
  news on this event…", "second update", "previous situation report". This is
  **sufficient but not required**;
- a continuing or cumulative status of an event that started earlier: "The
  outbreak … was declared on 4 September 2025. As of 30 November, a total of 64
  cases…";
- "Update", "Operational Update" or a numbered report **together with** the
  same named event ("Sri Lanka – Flood 2023, DREF Operational Update");
- a comparison with the previous report on the same situation ("in comparison
  to … during week 29").

**Not enough on its own:** a date, a report number or a generic phrase such as
"situation report" ("Situation Report – Sri Lanka 26th January 2025") when the
title and excerpt do not identify the ongoing event. A first report about a new
event is not `follow_up`. Do not open the URL to check.

## Examples (illustrations only; always decide from the actual text)

Examples from guide 1.0 that are still valid:

| Article | category | relevance | scope | Why |
|---|---|---|---|---|
| NDCU weekly dengue update with case counts | public_health | yes | sri_lanka | Occurring cases in Sri Lanka; `diseases = dengue`; `follow_up` if it compares with the previous week |
| Nipah virus disease – India | public_health | possibly | foreign | Neighbouring country |
| India restricts export of medicine ingredients | geopolitical_trade | possibly | foreign | Key supplier; trade restriction (`pharma_supply` if mainly about the resulting shortages) |
| Red Sea shipping attacks delay container ships | logistics | possibly | foreign | Shipping route used for imports |
| Ebola in DR Congo, global risk rated low | public_health | no | foreign | Distant, no route stated |
| World Mosquito Day: tips to prevent dengue | other (`no_actual_event`) | no | sri_lanka | Disease mentioned, no event |

New examples, based on situations seen in the pilot:

| Article (as the text describes it) | category | relevance | scope | flags / other fields | Why |
|---|---|---|---|---|---|
| Second WHO update: "Since the first disease outbreak news on this event…", Sudan virus disease in Uganda | public_health | no | foreign | `follow_up`; diseases `Sudan virus disease` | Explicit reference to an earlier report; distant, no route stated |
| WHO report: outbreak "declared on 4 September 2025. As of 30 November…" cumulative cases | public_health | by the usual rules | foreign | `follow_up` | Cumulative status of the same ongoing outbreak (O3) |
| "Sri Lanka – Flood 2023, DREF Operational Update" describing flood impacts | natural_disaster | yes | sri_lanka | `follow_up` | Title links the update to the same named flood |
| "Situation Report – Sri Lanka 26th January 2025" whose excerpt names no ongoing event | by content | by content | sri_lanka | no `follow_up` | Date and "situation report" alone are not enough (O3) |
| Mpox case imported into Sweden from Africa | public_health | no | foreign | diseases `mpox` | Spread to a distant country; the text gives no route to Sri Lanka |
| Pest infestation that "had spread to Sri Lanka", damaging crops | other | no | sri_lanka | no flag | A real event outside the categories; Sri Lanka is among the affected places |
| Victims of trafficking rescued and repatriated to Sri Lanka | other | no | sri_lanka | no flag | A real event outside the categories |
| A bank approves financing for a reform programme, no crisis described | other | no | sri_lanka | `no_actual_event` | Only institutional activity (O1) |
| Government aid "for the flood disaster in Sri Lanka" | natural_disaster | yes | sri_lanka | | Aid responds to a reported disaster (O1) |
| Consignment of donated "urgent medicines" for Sri Lankan hospitals, no shortage stated | other | possibly | sri_lanka | `no_actual_event`; quote the donation sentence | Plausible link to medicine supply; need is not a documented shortage (O2) |
| Donation sent after hospitals "ran out of" a named medicine | pharma_supply | yes | sri_lanka | quote the shortage sentence | Documented shortage |
| Food insecurity rising in Sri Lanka due to a foreign crisis; households "reducing expenditure on education and health" | other | possibly | sri_lanka | no flag; quote the health link | Real situation outside the categories; health link stated (O6); not `geopolitical_trade` without a trade measure |
| The same food-insecurity report with no mention of health | other | no | sri_lanka | no flag | No stated health link (O6) |
| Groundwater in a district "deteriorating" from pollution | other | possibly only if the text links it to health (O6) | sri_lanka | no flag | Chronic water problem, not a natural disaster |
| Drought outlook: provinces "are recording … below average rainfall", plus a seasonal forecast | natural_disaster | by the usual rules | sri_lanka | quote the observed rainfall, not the forecast | Observed conditions meet the category (O4) |
| Seasonal forecast of below-normal rainfall only | other | no | sri_lanka | `no_actual_event` | A prediction is not an event (O4) |
| GDACS: event type Flood, affected country Sri Lanka, period given | natural_disaster | yes | sri_lanka | `text_sufficient = yes` | Structured alert with type, country and date |
| Meeting minutes showing only an agenda | other | cannot_tell | from the title (e.g. sri_lanka) | `text_sufficient = no` | No event identifiable |
| Regional WHO bulletin: introduction, then a leptospirosis outbreak in a Sri Lankan district, then other events | public_health | yes | sri_lanka | diseases `leptospirosis`; quote the outbreak | First event in the substantive content (O5) |
| "NDCU: Current Status of Dengue" with only a PDF link | public_health | yes | sri_lanka | `text_sufficient = no`; `metadata_only` | Title is clear, no text |

## Working with the CSV

- **One value per cell.** Type or paste each value into its own cell. Never
  type or paste whole rows as comma-separated text: one extra or missing comma
  shifts every later column.
- **Open the CSV as text, not by double-clicking.** In Excel use **Data > From
  Text/CSV > Transform Data** and set every column to **Text**. Otherwise Excel
  changes dates (`2025-10-28` becomes `10/28/2025`) and can change
  `guide_version`. In Google Sheets, untick "Convert text to numbers, dates and
  formulas" when importing.
- When saving from Excel use **File > Save As > CSV UTF-8 (Comma delimited)**.
- Run the validator often. It never changes your file.
- Back up the working sheet (for example on a private drive). The working
  sheets contain article text and are not committed to the public repository.
  The labels-only export is committed.
