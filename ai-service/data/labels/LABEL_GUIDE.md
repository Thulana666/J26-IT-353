# Article Label Guide — version 1.0

Use this guide to label articles for the Component 1 event classifier. These
labels are the **ground truth** for comparing the rules baseline, the
fine-tuned model and the hybrid, so consistency matters more than speed.

## Golden rules

1. **Label only from the title and the text shown in the sheet.** Do not open
   the URL to fill gaps: the models never see that extra information.
2. **Judge the article, not the world.** Do not add what you know from other
   news. If the text does not say it, it does not count.
3. **No rules predictions are shown, and none should be copied.** Rules output
   is never ground truth.
4. **Do not edit** `article_id`, `url`, `title` or the excerpt. Do not rename,
   add or delete columns.
5. When unsure, pick the most cautious value and explain in `notes`.

## Fields

| Column | Values | Question |
|---|---|---|
| `category` | `public_health`, `natural_disaster`, `pharma_supply`, `geopolitical_trade`, `logistics`, `other` | What event is the article **mainly** about? |
| `relevance` | `yes`, `possibly`, `no`, `cannot_tell` | Should an analyst check this article for possible effects on medicine demand or supply in Sri Lanka? |
| `scope` | `sri_lanka`, `foreign`, `global`, `unknown` | Where is the event happening? |
| `text_sufficient` | `yes`, `no` | Does the stored text alone let you decide? |
| `evidence` | short quotes copied from the text, separated by `\|` | Which words support the category and relevance? |
| `flags` | see below, separated by `;` | Anything unusual? |
| `diseases` | disease names, separated by `;` | Diseases **reported as occurring** (cases, deaths, outbreak) |
| `notes` | free text | Reasons for difficult decisions |
| `annotator` | your initials | |
| `guide_version` | `1.0` (pre-filled) | |

**Evidence is required** unless the category is `other` and relevance is
`no` or `cannot_tell`. Keep each quote short (under 25 words) and copy it
exactly, so the validator can find it.

## Category

An **event** is something that happened or is happening at a stated time and
place: cases, deaths, a declared outbreak, a rising trend, an alert, damage,
displacement, a shortage, a disruption or an emergency response.

| Category | Use for |
|---|---|
| `public_health` | Disease outbreaks, epidemics, case surges, health emergencies |
| `natural_disaster` | Floods, cyclones, landslides, drought, extreme weather, earthquakes |
| `pharma_supply` | Medicine shortages, manufacturing problems, recalls, stock-outs |
| `geopolitical_trade` | Sanctions, export or import restrictions, trade disputes, conflict blocking trade |
| `logistics` | Shipping, port, air-freight or road transport disruption |
| `other` | No actual event, or an event outside these categories |

- Pick the event the **title and first paragraphs** focus on. "Leptospirosis
  cases rise after floods" is about disease cases, so it's `public_health`.
- If two events are truly equal, use the one in the title and add
  `ambiguous_category`.
- A disaster report that only *warns* about disease risk stays
  `natural_disaster`.
- **Mentioning a disease is not an event.** Prevention tips, vaccine research,
  awareness days, hospital openings and funding announcements are `other`, with
  the flag `no_actual_event`.

## Relevance to Sri Lanka

| Value | When |
|---|---|
| `yes` | A health event in Sri Lanka; a disaster in Sri Lanka affecting people (injuries, displacement, water or sanitation problems, disease risk); a medicine supply problem in Sri Lanka |
| `possibly` | A foreign or global event where **the article itself** suggests a plausible route to Sri Lanka: a neighbouring country (India, Maldives, Bangladesh, Pakistan, Nepal, Bhutan, Afghanistan), a supplier Sri Lanka relies on, a shipping route, international spread, or a WHO *global* alert |
| `no` | No actual event; programme, funding, policy or annual reports; distant events where the article gives no route to Sri Lanka; sport or politics |
| `cannot_tell` | The text is too thin to decide (usually with `text_sufficient = no`) |

`possibly` does not mean "impact confirmed". It only means "worth checking".

## Scope

- `sri_lanka`: Sri Lanka is among the affected places, even if other countries are too.
- `foreign`: a specific country or countries, not including Sri Lanka.
- `global`: worldwide, multi-region or a WHO global situation.
- `unknown`: the text gives no location.

Where the publisher or donor is located does not matter. A Japanese grant for
Sri Lankan flood victims is `sri_lanka`.

## Text sufficiency

- `yes`: there is real article text describing the event.
- `no`: title only, metadata only (format, themes, PDF link), or text cut off
  after a sentence or two.

You may still label category and relevance from the title when the title alone
makes them clear, but set `text_sufficient = no`.

## Flags

| Flag | Meaning |
|---|---|
| `no_actual_event` | Mentions a disease or hazard but describes no actual event |
| `follow_up` | An update to an earlier report (Situation Report #12, WHO update) |
| `duplicate` | Same article as another row. Leave the core labels blank and write the kept `article_id` in `notes` |
| `metadata_only` | Only metadata, no article text |
| `non_english` | Not in English |
| `ambiguous_category` | Two categories are equally strong |

## Examples (illustrations only; always decide from the actual text)

| Article | category | relevance | scope | Why |
|---|---|---|---|---|
| NDCU weekly dengue update with case counts | public_health | yes | sri_lanka | Occurring cases in Sri Lanka |
| Cyclone flash update: families displaced, clinics damaged | natural_disaster | yes | sri_lanka | Disaster affecting people in Sri Lanka |
| Nipah virus disease – India | public_health | possibly | foreign | Neighbouring country |
| India restricts export of medicine ingredients | geopolitical_trade | possibly | foreign | Key supplier; trade restriction (use `pharma_supply` if the article is mainly about the resulting shortages) |
| Red Sea shipping attacks delay container ships | logistics | possibly | foreign | Shipping route used for imports |
| Ebola in DR Congo, global risk rated low | public_health | no | foreign | Distant, no route stated |
| Flood in Mexico | natural_disaster | no | foreign | Distant, no route stated |
| Funding launch for a farming project in Sri Lanka | other | no | sri_lanka | No actual event |
| World Mosquito Day: tips to prevent dengue | other (`no_actual_event`) | no | sri_lanka | Disease mentioned, no event |
| "NDCU: Current Status of Dengue" with only a PDF link | public_health | yes | sri_lanka | Title is clear; `text_sufficient = no`, `metadata_only` |

## Working with the CSV

- Open the `.sheet.csv` in Excel, LibreOffice or Google Sheets.
- When saving from Excel use **File > Save As > CSV UTF-8 (Comma delimited)**.
- Run the validator often. It never changes your file.
- Back up the working sheet (for example on a private drive). The working
  sheets contain article text and are not committed to the public repository.
  The labels-only export is committed.
