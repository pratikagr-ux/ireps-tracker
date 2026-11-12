"""Static lookup tables for decoding IREPS railway/production-unit codes and
common depot abbreviations into human-readable names and locations.

The `RAILWAY_LOCATIONS` keys match exactly the railway unit display names
IREPS exposes in its own `railUnitName` dropdown (see
`ireps_core.parse_railway_options`), so every railway value a scan can
produce is covered.
"""
from __future__ import annotations

RAILWAY_LOCATIONS: dict[str, tuple[str, str]] = {
    "BLW": ("Banaras Locomotive Works", "Varanasi, Uttar Pradesh"),
    "CENTRAL RLY": ("Central Railway", "Mumbai (CSMT), Maharashtra"),
    "CLW": ("Chittaranjan Locomotive Works", "Chittaranjan, West Bengal"),
    "CORE": ("Central Organisation for Railway Electrification", "Prayagraj, Uttar Pradesh"),
    "CRIS": ("Centre for Railway Information Systems", "New Delhi"),
    "DFC CORPORATE OFFICE": ("Dedicated Freight Corridor Corporation of India Ltd.", "New Delhi"),
    "DMRC": ("Delhi Metro Rail Corporation", "New Delhi"),
    "EAST CENTRAL RLY": ("East Central Railway", "Hajipur, Bihar"),
    "EASTERN RLY": ("Eastern Railway", "Kolkata, West Bengal"),
    "ECOR": ("East Coast Railway", "Bhubaneswar, Odisha"),
    "ICF": ("Integral Coach Factory", "Chennai (Perambur), Tamil Nadu"),
    "IREPS": ("Indian Railways E-Procurement System", "New Delhi"),
    "IREPS TESTING2": ("IREPS internal test unit", "sandbox entry, no real location"),
    "IREPS-TESTING": ("IREPS internal test unit", "sandbox entry, no real location"),
    "KRCL": ("Konkan Railway Corporation Ltd.", "CBD Belapur, Navi Mumbai, Maharashtra"),
    "MCF/ RBL": ("Modern Coach Factory", "Raebareli, Uttar Pradesh"),
    "METRO RAILWAY": ("Metro Railway Kolkata", "Kolkata, West Bengal"),
    "N F RLY": ("Northeast Frontier Railway", "Maligaon, Guwahati, Assam"),
    "N F RLY CONSTRUCTION": ("Northeast Frontier Railway Construction Organisation", "Guwahati, Assam"),
    "NORTH CENTRAL RLY": ("North Central Railway", "Prayagraj, Uttar Pradesh"),
    "NORTH EASTERN RLY": ("North Eastern Railway", "Gorakhpur, Uttar Pradesh"),
    "NORTH WESTERN RLY": ("North Western Railway", "Jaipur, Rajasthan"),
    "NORTHERN RLY": ("Northern Railway", "New Delhi"),
    "PLW": ("Patiala Locomotive Works", "Patiala, Punjab"),
    "RCF": ("Rail Coach Factory", "Kapurthala, Punjab"),
    "RWF": ("Rail Wheel Factory", "Yelahanka, Bengaluru, Karnataka"),
    "RWP/BELA": ("Rail Wheel Plant", "Bela, Chhapra, Bihar"),
    "SOUTH CENTRAL RLY": ("South Central Railway", "Secunderabad, Telangana"),
    "SOUTH COAST RAILWAY": ("South Coast Railway", "Visakhapatnam, Andhra Pradesh"),
    "SOUTH EAST CENTRAL RLY": ("South East Central Railway", "Bilaspur, Chhattisgarh"),
    "SOUTH EASTERN RLY": ("South Eastern Railway", "Garden Reach, Kolkata, West Bengal"),
    "SOUTH WESTERN RLY": ("South Western Railway", "Hubballi, Karnataka"),
    "SOUTHERN RLY": ("Southern Railway", "Chennai, Tamil Nadu"),
    "WEST CENTRAL RLY": ("West Central Railway", "Jabalpur, Madhya Pradesh"),
    "WESTERN RLY": ("Western Railway", "Mumbai (Churchgate), Maharashtra"),
}

# Common depot/sub-unit abbreviations seen embedded in depot names.
DEPOT_ABBREVIATIONS: dict[str, str] = {
    "GSD": "General Stores Depot",
}


def describe_railway(railway: str) -> str:
    """'BLW' -> 'Banaras Locomotive Works - Varanasi, Uttar Pradesh'."""
    entry = RAILWAY_LOCATIONS.get(railway.strip())
    if not entry:
        return railway
    full_name, location = entry
    return f"{full_name} - {location}"


def describe_depot(railway: str, depot: str) -> str:
    """Expand known abbreviations within a depot name, plus a historical-name
    note for BLW depots still carrying the old 'DLW' (Diesel Locomotive
    Works) name."""
    tokens = depot.split()
    expanded = [DEPOT_ABBREVIATIONS.get(t, t) for t in tokens]
    out = " ".join(expanded)
    if railway.strip() == "BLW" and "DLW" in tokens:
        out += " (DLW = formerly Diesel Locomotive Works, now Banaras Locomotive Works)"
    return out


def describe_location(railway: str, depot: str) -> str:
    """One-line human-readable location description for a lot's railway/depot."""
    return f"{describe_railway(railway)} / {describe_depot(railway, depot)}"
