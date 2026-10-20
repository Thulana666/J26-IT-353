"""Transparent lexicons for the rules-based event classifier.

Everything the rules use is listed here so it can be read, reviewed and
tuned. Patterns are regular expressions matched case-insensitively and as
whole words (see classifier._compile). Labels on the left are what appears in
results as "matched keywords".
"""

# --- Categories -----------------------------------------------------------------

CATEGORY_LABELS = {
    "public_health": "Public health and disease outbreaks",
    "natural_disaster": "Natural disasters and severe weather",
    "pharma_supply": "Pharmaceutical manufacturing and medicine shortages",
    "geopolitical_trade": "Geopolitical, trade and sanctions-related disruptions",
    "logistics": "Shipping, port and transportation disruptions",
    "other": "Other or insufficient evidence",
}

CATEGORY_TERMS = {
    "public_health": {
        "outbreak": r"outbreaks?",
        "epidemic": r"epidemics?",
        "pandemic": r"pandemics?",
        "disease": r"diseases?",
        "infection": r"infections?|infected",
        "virus": r"virus(?:es)?|viral",
        "reported cases": r"(?:confirmed|suspected|probable|new|reported) cases",
        "vaccination": r"vaccines?|vaccinations?|immuni[sz]ations?",
        "public health": r"public health",
        "health emergency": r"health emergenc(?:y|ies)|PHEIC",
        "transmission": r"transmission|contact tracing",
        "mosquito / vector": r"mosquito(?:es)?|vector[- ]borne|breeding sites?",
        "hospital admissions": r"hospitali[sz](?:ed|ations?)|admitted to hospitals?|hospital admissions?",
        "health authority": r"ministry of health|health ministry|epidemiology unit|dengue control unit",
    },
    "natural_disaster": {
        "flood": r"floods?|flooding|flooded|inundat\w*",
        "landslide": r"landslides?|land slides?|mudslides?",
        "cyclone / storm": r"cyclones?|tropical (?:storm|depression)s?|typhoons?|hurricanes?|storms?",
        "heavy rain / monsoon": r"heavy (?:rain|rains|rainfall)|torrential rains?|monsoons?",
        "drought": r"droughts?|dry spells?|water scarcity",
        "earthquake / tsunami": r"earthquakes?|tsunamis?",
        "heatwave": r"heat ?waves?|extreme heat",
        "severe weather": r"(?:extreme|severe) weather",
        "disaster": r"disasters?|disaster-affected",
        "evacuation / displacement": r"evacuat\w+|displaced|relief camps?",
        "wildfire": r"wildfires?|forest fires?",
    },
    "pharma_supply": {
        "medicine shortage": (
            r"(?:medicine|drug|medication|pharmaceutical|vaccine|insulin|antibiotic)s? "
            r"(?:shortages?|stock-?outs?|scarcity)"
            r"|shortages? of (?:essential )?(?:medicines|drugs|medications|vaccines|insulin|antibiotics)"
        ),
        "essential medicines": r"essential (?:medicines|drugs)",
        "pharmaceutical industry": r"pharmaceuticals?|drug ?makers?|drug manufactur\w+",
        "active ingredients": r"active pharmaceutical ingredients?",
        "manufacturing site": r"manufacturing (?:plants?|facilit(?:y|ies)|sites?)|good manufacturing practice",
        "recall / quality": (
            r"(?:product|drug|medicine|batch|vaccine) recalls?|recalled|substandard"
            r"|falsified|counterfeit (?:medicines|drugs)"
        ),
        "regulator / procurement": (
            r"NMRA|National Medicines Regulatory Authority|State Pharmaceuticals Corporation"
            r"|Medical Supplies Division"
        ),
        "medical supplies": r"medical supplies|surgical supplies",
    },
    "geopolitical_trade": {
        "sanctions": r"sanctions?|embargo(?:es)?",
        "trade restriction": (
            r"(?:export|import|trade) (?:bans?|restrictions?)|tariffs?|trade wars?"
            r"|customs (?:delays?|clearance)"
        ),
        "foreign exchange": r"foreign (?:exchange|currency)|forex|letters? of credit|dollar shortage",
        "economic crisis": r"economic crisis|debt crisis|currency crisis|sovereign default",
        # Active disruption only: bare "war" mostly appears in post-war justice reports.
        "conflict": (
            r"armed conflicts?|blockades?|hostilities|geopolitical (?:tensions?|risks?|crisis)"
            r"|military (?:escalation|strikes?|attacks?)|war (?:in|between|on)|outbreak of war"
        ),
    },
    "logistics": {
        "port": r"ports?|harbou?rs?|port congestion",
        "shipping": r"shipping|shipments?|vessels?|ships?|containers?|freight|cargo",
        "supply chain": r"supply chains?|logistics|distribution networks?",
        "transport disruption": (
            r"(?:road|rail|railway|bridge)s? (?:closed|closures?|blocked|damaged|washed away)"
            r"|transport(?:ation)? (?:disruptions?|strikes?)|flights? (?:cancell?ed|suspended)"
            r"|airports? (?:closed|closures?)"
        ),
        "fuel shortage": r"fuel shortages?|fuel crisis|diesel shortages?",
        "shipping route": (
            r"Red Sea|Suez Canal|Strait of Hormuz|Strait of Malacca|Bab[- ]el[- ]Mandeb"
        ),
        "port / transport strike": r"(?:port|dock|transport) (?:workers'? )?strikes?",
    },
}

# --- Diseases (canonical name -> pattern) ------------------------------------------
# Every disease found also counts as public-health evidence.

DISEASES = {
    "dengue": r"dengue|DHF",
    "chikungunya": r"chikungunya",
    "malaria": r"malaria",
    "leptospirosis": r"leptospirosis|rat fever",
    "cholera": r"cholera",
    "typhoid": r"typhoid|enteric fever",
    "diarrhoeal disease": r"diarrh(?:o)?eal? diseases?|diarrh(?:o)?ea|acute watery diarrh\w+|gastroenteritis",
    "hepatitis": r"hepatitis(?: [A-E])?",
    "influenza": r"influenza|flu|H1N1|H3N2|H5N1|H5N8|H7N9|H9N2|bird flu",
    "COVID-19": r"COVID(?:-?19)?|SARS-CoV-2|coronavirus disease 2019",
    "MERS": r"MERS(?:-CoV)?|Middle East respiratory syndrome",
    "measles": r"measles",
    "rubella": r"rubella",
    "mumps": r"mumps",
    "polio": r"polio(?:myelitis|virus)?",
    "diphtheria": r"diphtheria",
    "pertussis": r"pertussis|whooping cough",
    "tuberculosis": r"tuberculosis|TB",
    "mpox": r"mpox|monkeypox|MPXV",
    "Ebola disease": r"ebola|Bundibugyo virus",
    "Marburg virus disease": r"marburg",
    "Nipah virus": r"nipah",
    "Zika": r"zika",
    "yellow fever": r"yellow fever",
    "rabies": r"rabies",
    "hantavirus": r"hantavirus",
    "Japanese encephalitis": r"Japanese encephalitis",
    "scrub typhus": r"scrub typhus",
    "chickenpox": r"chickenpox|varicella",
    "hand, foot and mouth disease": r"hand,? foot,? and mouth disease|HFMD",
    "meningitis": r"meningitis|meningococcal",
    "anthrax": r"anthrax",
    "plague": r"plague",
    "Lassa fever": r"lassa fever",
    "Rift Valley fever": r"Rift Valley fever",
    "Crimean-Congo haemorrhagic fever": r"Crimean-Congo ha?emorrhagic fever|CCHF",
    "chronic kidney disease": r"chronic kidney disease|CKDu",
    "food poisoning": r"food poisoning|foodborne illness",
}

# --- Sri Lanka gazetteer ---------------------------------------------------------

SRI_LANKA_COUNTRY = r"Sri Lanka|Sri Lankans?|Ceylon|ශ්‍රී ලංකා|இலங்கை"

# Province -> districts (25 districts, 9 provinces).
SRI_LANKA_PROVINCES = {
    "Western": ["Colombo", "Gampaha", "Kalutara"],
    "Central": ["Kandy", "Matale", "Nuwara Eliya"],
    "Southern": ["Galle", "Matara", "Hambantota"],
    "Northern": ["Jaffna", "Kilinochchi", "Mannar", "Vavuniya", "Mullaitivu"],
    "Eastern": ["Batticaloa", "Ampara", "Trincomalee"],
    "North Western": ["Kurunegala", "Puttalam"],
    "North Central": ["Anuradhapura", "Polonnaruwa"],
    "Uva": ["Badulla", "Monaragala"],
    "Sabaragamuwa": ["Ratnapura", "Kegalle"],
}

# Alternative spellings of district names.
DISTRICT_ALIASES = {
    "Moneragala": "Monaragala",
    "Kegalla": "Kegalle",
    "Nuwara-Eliya": "Nuwara Eliya",
    "Mullaithivu": "Mullaitivu",
}

# Provinces with common-word names only count when followed by "Province".
PROVINCES_NEED_SUFFIX = {"Western", "Central", "Southern", "Northern", "Eastern", "North Western", "North Central"}

# --- Possible links from a foreign event to Sri Lanka ----------------------------
# A foreign event is never relevant or irrelevant by default. It becomes
# "possibly relevant" (always for review) only when one of these links holds.

# Neighbouring South Asian countries (cross-border spread, shared weather systems,
# trade and travel).
NEIGHBOURING_COUNTRIES = {"IN", "MV", "BD", "PK", "NP", "BT", "AF"}

# ASSUMPTION (to confirm with sources in the report): India and China are major
# suppliers of finished medicines / active ingredients to Sri Lanka, so supply,
# trade and logistics events there may matter.
KEY_SUPPLIER_COUNTRIES = {"IN", "CN"}

# Shipping lanes and ports on Sri Lanka's import routes.
SHIPPING_ROUTES = (
    r"Red Sea|Suez Canal|Strait of Hormuz|Strait of Malacca|Bab[- ]el[- ]Mandeb"
    r"|Indian Ocean|Bay of Bengal|Arabian Sea|Port of Colombo|Colombo Port|Hambantota Port"
)

# Words that make an event global in scope.
GLOBAL_SCOPE = (
    r"global(?:ly)?|worldwide|multi-?country|multi-?locations?|multiple countries"
    r"|international spread|pandemic|PHEIC|South[- ]?East Asia|South Asia|Asia-Pacific"
)

# --- Months (date extraction) -----------------------------------------------------

MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sept": 9, "sep": 9, "october": 10,
    "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
