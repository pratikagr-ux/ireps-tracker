"""Shared scraping logic for the Matex (matexnet.com) auction lot listing.

Mirrors ireps_core.py's structure/spirit. `scan()` is the public,
no-login path: the "All Events" table on the public homepage, giving a
lot code, a location (state), a free-text description and a date/time
window -- no qty/unit, category or per-lot detail.

`scan_authenticated(user_id, password)` is the richer, logged-in path
(credentials are an opt-in env var pair; matex_autoscan.py falls back to
`scan()` when they're absent or login fails). Signed in, the "Auctions"
listing (Bidder/showproducts.aspx) gives the same auctions with the full,
untruncated company name and description, plus a link to each auction's
ProdDetails page -- the real per-lot breakdown (material code, quantity,
EMD amount) that was previously unavailable.
"""
from __future__ import annotations

import hashlib
import re
import sys
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from net_retry import call_with_retry

INDEX_URL = "https://www.matexnet.com/Index.aspx"
LOGIN_PAGE_URL = "https://www.matexnet.com/Index.aspx"
LISTING_URL = "https://www.matexnet.com/Bidder/showproducts.aspx"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; auction-tracker/1.0)",
}

# "MATEX3066-FRSO11 Rajasthan" -> ("MATEX3066-FRSO11", "Rajasthan")
LOT_CODE_RE = re.compile(r"^(MATEX\d+-[A-Z0-9]+)\s*(.*)$")

# The authenticated listing's "Company Name" cell is shaped differently --
# "HINDUSTAN ZINC LIMITED - Rajasthan (MATEX3133-FRSO11)" -- lot code last,
# in parens, company name and location separated by " - ". Anchored on the
# "MATEX..." text inside the parens so a company name that itself contains
# parens (e.g. "DALMIA CEMENT (BHARAT) LIMITED") doesn't get matched instead.
AUTH_LOT_CODE_RE = re.compile(r"\((MATEX\d+-[A-Z0-9]+)\)\s*$")

# Public homepage: "13th November 2026 Between 12:00 PM to 12:30 PM"
# (sometimes prefixed with "Forward Auction:", and occasionally a
# malformed 24h+AM/PM mix like "15:05 PM") -- word month name.
DATE_RE = re.compile(
    r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4}).*?"
    r"(\d{1,2}):(\d{2})\s*(AM|PM)?",
    re.IGNORECASE,
)
# Authenticated listing: "19/11/2026 11:30 AM To 02:00 PM" -- numeric
# DD/MM/YYYY instead. The two formats' separators ("/" vs a month name)
# never cross-match, so both regexes can safely be tried on the same text.
NUMERIC_DATE_RE = re.compile(
    r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?",
    re.IGNORECASE,
)
MONTHS = {
    name.lower(): i
    for i, name in enumerate(
        ["January", "February", "March", "April", "May", "June", "July",
         "August", "September", "October", "November", "December"],
        start=1,
    )
}

# Fields whose change should flip a lot's change_tag to 'updated'.
TRACKED_FIELDS = ["material_descr", "qty_unit", "next_auction"]


def content_hash(row: dict) -> str:
    raw = "|".join(str(row.get(f, "")) for f in TRACKED_FIELDS)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _to_24h(hour: int, ampm: str | None) -> int:
    if ampm and hour <= 12:  # source data is occasionally already 24h + a spurious AM/PM
        ampm = ampm.upper()
        if ampm == "PM" and hour != 12:
            hour += 12
        elif ampm == "AM" and hour == 12:
            hour = 0
    return hour


def format_auction_datetime(text: str) -> str:
    """Best-effort convert Matex's date/time text (either source format --
    see DATE_RE/NUMERIC_DATE_RE) into IREPS's own "DD/MM/YYYY HH:MM:SS"
    format, so the rest of the app (daysToAuction, Dashboard sorting)
    treats both sources the same way. Falls back to the raw text when it
    doesn't look like a date at all.

    Some authenticated-listing rows carry two date/times ("CB: <catalogue
    bidding time> <real auction time>") -- the LAST match (by position in
    the text) is always the actual auction slot, and for the normal
    single-date case it's the same as the only match, so this is safe for
    both."""
    text = text or ""
    candidates = []
    for m in DATE_RE.finditer(text):
        day, month_name, year, hour, minute, ampm = m.groups()
        month = MONTHS.get(month_name.lower())
        if month:
            candidates.append((m.start(), day, month, year, hour, minute, ampm))
    for m in NUMERIC_DATE_RE.finditer(text):
        day, month, year, hour, minute, ampm = m.groups()
        candidates.append((m.start(), day, int(month), year, hour, minute, ampm))
    if not candidates:
        return text.strip()
    _, day, month, year, hour, minute, ampm = max(candidates, key=lambda c: c[0])
    hour = _to_24h(int(hour), ampm)
    return f"{int(day):02d}/{month:02d}/{year} {hour:02d}:{int(minute):02d}:00"


def parse_events(html: str) -> list[dict]:
    """Parse the public "All Events" table (#grid1, inside the
    #product_tabs_all pane) -- the no-login upcoming-auctions list on the
    Matex homepage. No pagination observed; it's one static table."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id="grid1")
    if not table:
        return []
    rows = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) < 4:
            continue  # header row (uses <th>) or malformed row
        company_text = cells[1].get_text(" ", strip=True)
        description = cells[2].get_text(" ", strip=True)
        date_text = cells[3].get_text(" ", strip=True)
        m = LOT_CODE_RE.match(company_text)
        lot_no, location = (m.group(1), m.group(2).strip()) if m else (company_text, "")
        if not lot_no:
            continue
        rows.append({
            "lot_no": lot_no,
            "location": location,
            "material_descr": description,
            "next_auction": format_auction_datetime(date_text),
        })
    return rows


def scan() -> list[dict]:
    """One-shot fetch + parse of the public Matex "All Events" list."""
    session = requests.Session()
    resp = call_with_retry(session.get, INDEX_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return parse_events(resp.text)


def _matex_password_hash(password: str) -> str:
    """Matches the client-side JS the login box runs before submit
    (js/MD5Conversion.js): `MD5(MD5(password).toUpperCase() + rId)` with
    rId == '' for this particular login box (there's a second, unrelated
    modal login on the same page that salts differently). The real
    password is never sent to the server at all -- confirmed by computing
    this in both a live browser and Python for a throwaway test string
    and diffing the output byte for byte."""
    first = hashlib.md5(password.encode("utf-8")).hexdigest().upper()
    return hashlib.md5((first + "").encode("utf-8")).hexdigest()


def login(session: requests.Session, user_id: str, password: str) -> bool:
    """Sign in to the Matex bidder portal, mutating `session`'s cookies.
    Replays the Index.aspx ASP.NET WebForms login postback (the page's one
    <form> covers several unrelated widgets -- newsletter, enquiry,
    account-revoke -- so only the viewstate/validation hidden fields plus
    the login-specific UserId/UserPassword/imgSubmit are sent). Returns
    whether the response looks signed-in."""
    resp = call_with_retry(session.get, LOGIN_PAGE_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "lxml")
    form = soup.find("form")
    if not form:
        return False
    data = {
        inp.get("name"): inp.get("value", "")
        for inp in form.find_all("input", attrs={"type": "hidden"})
        if inp.get("name")
    }
    data["UserId"] = user_id
    data["UserPassword"] = _matex_password_hash(password)
    data["imgSubmit"] = "Go"
    action = urljoin(LOGIN_PAGE_URL, form.get("action") or LOGIN_PAGE_URL)
    resp2 = call_with_retry(session.post, action, data=data, headers=HEADERS, timeout=30)
    resp2.raise_for_status()
    ok = "Welcome :" in resp2.text
    if not ok:
        # Diagnostic only -- never includes `data` (which holds the
        # password), just a peek at what page came back, to tell a bad
        # form replay apart from a wrong-credentials/bot-check response.
        snippet = re.sub(r"\s+", " ", resp2.text).strip()[:400]
        print(
            f"  [matex login] no 'Welcome :' in response -- status={resp2.status_code} "
            f"final_url={resp2.url} snippet={snippet!r}",
            file=sys.stderr,
        )
    return ok


def parse_authenticated_listing(html: str) -> list[dict]:
    """Parse the signed-in "ALL EVENTS" table (id ending "product_grid1")
    on Bidder/showproducts.aspx -- same auctions as the public page, but
    with the full (untruncated) company name/description, plus a link to
    each auction's ProdDetails page (the per-lot breakdown)."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id=lambda i: i and i.endswith("product_grid1"))
    if not table:
        return []
    rows = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) < 4:
            continue  # header row (uses <th>) or malformed row
        link = cells[1].find("a", href=True)
        company_text = cells[1].get_text(" ", strip=True)
        description = cells[2].get_text(" ", strip=True)
        date_text = cells[3].get_text(" ", strip=True)
        m = AUTH_LOT_CODE_RE.search(company_text)
        if not m or not link:
            continue
        lot_no = m.group(1)
        rest = company_text[:m.start()].strip()
        _company_name, _, location = rest.rpartition(" - ")
        location = location.strip() if _company_name else ""
        rows.append({
            "lot_no": lot_no,
            "location": location,
            "material_descr": description,
            "next_auction": format_auction_datetime(date_text),
            "detail_url": urljoin(LISTING_URL, link["href"]),
        })
    return rows


def _parse_product_name(text: str) -> tuple[str, str, str]:
    """"Material Code 100000003 MANGANESE STEEL LINERS SCRAP Plant RD Mine"
    -> ("100000003", "MANGANESE STEEL LINERS SCRAP", "RD Mine")."""
    text = text.strip()
    if text.startswith("Material Code"):
        code, _, rest = text[len("Material Code"):].strip().partition(" ")
    else:
        code, rest = "", text
    if " Plant " in rest:
        descr, plant = rest.rsplit(" Plant ", 1)
    else:
        descr, plant = rest, ""
    return code.strip(), descr.strip(), plant.strip()


def _parse_quantity(text: str) -> str:
    """"12.18 - TO/TO" -> "12.18 TO"."""
    value, _, unit = text.strip().partition(" - ")
    unit = unit.split("/")[0].strip()
    return f"{value.strip()} {unit}".strip() if unit else value.strip()


def parse_lot_items(html: str) -> list[dict]:
    """Parse the per-auction lot-level breakdown table (id ending
    "GridView1") on Bidder/ProdDetails.aspx: one row per actual lot within
    the auction, with its own material code/description, EMD amount and
    quantity."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id=lambda i: i and i.endswith("GridView1"))
    if not table:
        return []
    items = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) != 4:
            continue  # header (uses <th>) or the blank spacer row
        item_lot_no = cells[0].get_text(strip=True)
        if not item_lot_no.isdigit():
            continue
        material_code, material_descr, plant = _parse_product_name(cells[1].get_text(" ", strip=True))
        emd_amount = cells[2].get_text(strip=True)
        qty_unit = _parse_quantity(cells[3].get_text(strip=True))
        items.append({
            "item_lot_no": item_lot_no,
            "material_code": material_code,
            "material_descr": material_descr,
            "plant": plant,
            "emd_amount": emd_amount,
            "qty_unit": qty_unit,
        })
    return items


def fetch_lot_items(session: requests.Session, detail_url: str) -> list[dict]:
    resp = call_with_retry(session.get, detail_url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return parse_lot_items(resp.text)


def scan_authenticated(user_id: str, password: str) -> tuple[list[dict], bool]:
    """Log in and fetch the full authenticated listing with each auction's
    per-lot breakdown. Returns (auctions, login_ok); on login failure,
    auctions is []. Each auction dict always has the richer
    company/location/description/next_auction fields; `items` is the
    per-lot breakdown, empty if that one auction's ProdDetails page
    couldn't be fetched/parsed (caller falls back to a single coarse row
    for that auction, same as the public-only scan, in that case)."""
    session = requests.Session()
    if not login(session, user_id, password):
        return [], False
    auctions = fetch_authenticated_listing(session)
    for auction in auctions:
        try:
            auction["items"] = fetch_lot_items(session, auction["detail_url"])
        except Exception:
            auction["items"] = []
    return auctions, True


def fetch_authenticated_listing(session: requests.Session) -> list[dict]:
    resp = call_with_retry(session.get, LISTING_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return parse_authenticated_listing(resp.text)
