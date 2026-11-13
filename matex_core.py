"""Shared scraping logic for the Matex (matexnet.com) auction lot listing.

Mirrors ireps_core.py's structure/spirit, but Matex is a much thinner
source: its richer per-auction detail and auction history live behind a
login (the "Auctions" nav link bounces back to the public homepage when
signed out), so this only scrapes the "All Events" table on the public
homepage -- the same upcoming-auctions list anyone sees without an
account. That table gives a lot code, a location (state), a free-text
description and a date/time window; there's no qty/unit, category or
per-lot detail page available publicly.
"""
from __future__ import annotations

import hashlib
import re

import requests
from bs4 import BeautifulSoup

INDEX_URL = "https://www.matexnet.com/Index.aspx"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; auction-tracker/1.0)",
}

# "MATEX3066-FRSO11 Rajasthan" -> ("MATEX3066-FRSO11", "Rajasthan")
LOT_CODE_RE = re.compile(r"^(MATEX\d+-[A-Z0-9]+)\s*(.*)$")

# "13th November 2026 Between 12:00 PM to 12:30 PM" (sometimes prefixed
# with "Forward Auction:", and occasionally a malformed 24h+AM/PM mix like
# "15:05 PM") -> the first date/time found in the string.
DATE_RE = re.compile(
    r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4}).*?"
    r"(\d{1,2}):(\d{2})\s*(AM|PM)?",
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
TRACKED_FIELDS = ["material_descr", "next_auction"]


def content_hash(row: dict) -> str:
    raw = "|".join(str(row.get(f, "")) for f in TRACKED_FIELDS)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def format_auction_datetime(text: str) -> str:
    """Best-effort convert Matex's date/time text into IREPS's own
    "DD/MM/YYYY HH:MM:SS" format, so the rest of the app (daysToAuction,
    Dashboard sorting) treats both sources the same way. Falls back to the
    raw text when it doesn't look like a date at all."""
    m = DATE_RE.search(text or "")
    if not m:
        return (text or "").strip()
    day, month_name, year, hour, minute, ampm = m.groups()
    month = MONTHS.get(month_name.lower())
    if not month:
        return text.strip()
    hour = int(hour)
    if ampm and hour <= 12:  # source data is occasionally already 24h + a spurious AM/PM
        ampm = ampm.upper()
        if ampm == "PM" and hour != 12:
            hour += 12
        elif ampm == "AM" and hour == 12:
            hour = 0
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
    resp = session.get(INDEX_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return parse_events(resp.text)
