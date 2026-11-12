"""Shared scraping logic for the IREPS lot-publishing tool.

Pulls the public "Lot Publishing Module" list (no login required) from
ireps.gov.in. Used by both the CLI (ireps_filter.py) and the web dashboard
(webapp.py).
"""
from __future__ import annotations

import re
import time
from typing import Iterator

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://ireps.gov.in/eps/viewLotPublishBidderAnon.do"
AUCTION_PROPS_URL = "https://ireps.gov.in/eps/auctionProperties"
LOT_DETAIL_URL = "https://ireps.gov.in/eps/auction/viewLotAnon.do"
ROWS_PER_PAGE = 10
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; ireps-lot-filter/1.0)",
}
BASE_FIELDS = [
    "railway",
    "depot",
    "lot_no",
    "qty_unit",
    "category",
    "min_incr",
    "material_descr",
    "publish_date",
]
# next_auction/lot_id are enriched in after the base row scrape (see scan()).
FIELDS = BASE_FIELDS + ["next_auction", "lot_id"]


def fetch_page(session: requests.Session, page_no: int, rail_unit_name: str, depot_id: str) -> str:
    data = {
        "searchParam": "showPage",
        "pageNo": str(page_no),
        "railUnitName": rail_unit_name,
        "depotId": depot_id,
        "startDate": "",
        "toDate": "",
        "auctionStartDate": "",
    }
    resp = session.post(BASE_URL, data=data, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def parse_total_results(html: str) -> int:
    m = re.search(r'Total\s*<font[^>]*>\s*(\d+)', html)
    return int(m.group(1)) if m else 0


def parse_rows(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    rows = []
    for tr in soup.find_all("tr", class_="trPoRow"):
        cells = tr.find_all("td", class_="datatext")
        if len(cells) < 8:
            continue
        values = [c.get_text(strip=True) for c in cells[:8]]
        row = dict(zip(BASE_FIELDS, values))
        m = re.search(r"myWindow\((\d+)\)", str(cells[2]))
        row["lot_id"] = m.group(1) if m else ""
        row["next_auction"] = ""
        rows.append(row)
    return rows


def parse_railway_options(html: str) -> dict[str, str]:
    """Map railway display name -> railUnitName id, read off the search form."""
    soup = BeautifulSoup(html, "lxml")
    select = soup.find("select", {"name": "railUnitName"})
    if not select:
        return {}
    out = {}
    for opt in select.find_all("option"):
        val = (opt.get("value") or "").strip()
        text = opt.get_text(strip=True)
        if val and val != "-1":
            out[text] = val
    return out


def fetch_depot_ids(session: requests.Session, railway_id: str) -> dict[str, str]:
    """Map depot name -> depot id for a given railway, via the site's own AJAX endpoint."""
    resp = session.get(
        AUCTION_PROPS_URL, params={"searchdepots": railway_id}, headers=HEADERS, timeout=30
    )
    resp.raise_for_status()
    parts = [p for p in resp.text.split("^") if p != ""]
    return {parts[i]: parts[i + 1] for i in range(0, len(parts) - 1, 2)}


def fetch_auction_dates(session: requests.Session, depot_id: str) -> list[str]:
    """Upcoming scheduled auction start date/times for a depot (soonest first)."""
    resp = session.get(
        AUCTION_PROPS_URL, params={"searchauctionStartDate": depot_id}, headers=HEADERS, timeout=30
    )
    resp.raise_for_status()
    text = resp.text.strip()
    if text in ("-2", "-1", ""):
        return []
    parts = text.split("^")
    return [p for i, p in enumerate(parts) if i % 2 == 0 and p.strip()]


class AuctionScheduleLookup:
    """Resolves (railway, depot) -> next scheduled auction date/time, with caching.

    Each unique railway/depot pair costs at most two extra HTTP calls total
    (not per lot), since results are cached across the whole scan.
    """

    def __init__(self, session: requests.Session):
        self.session = session
        self.railway_ids: dict[str, str] | None = None
        self.depot_ids: dict[str, dict[str, str]] = {}  # railway -> {depot: depot_id}
        self.auction_dates: dict[str, list[str]] = {}  # depot_id -> dates

    def set_railway_ids(self, railway_ids: dict[str, str]) -> None:
        self.railway_ids = railway_ids

    def next_auction(self, railway: str, depot: str) -> str:
        if not self.railway_ids:
            return ""
        railway_id = self.railway_ids.get(railway)
        if not railway_id:
            return ""
        if railway not in self.depot_ids:
            try:
                self.depot_ids[railway] = fetch_depot_ids(self.session, railway_id)
            except requests.RequestException:
                self.depot_ids[railway] = {}
        depot_id = self.depot_ids[railway].get(depot)
        if not depot_id:
            return ""
        if depot_id not in self.auction_dates:
            try:
                self.auction_dates[depot_id] = fetch_auction_dates(self.session, depot_id)
            except requests.RequestException:
                self.auction_dates[depot_id] = []
        dates = self.auction_dates[depot_id]
        return dates[0] if dates else ""


def fetch_lot_detail(session: requests.Session, lot_id: str) -> str:
    resp = session.get(LOT_DETAIL_URL, params={"lotId": lot_id}, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def parse_lot_detail(html: str) -> dict[str, str]:
    """Parse the extra fields off the per-lot detail popup (viewLotAnon.do).

    The page nests several unrelated tables (page chrome, title bars, etc.),
    so this only pairs a td.formLabel with the td immediately after it in
    the same row, rather than pairing cell text by position across the
    whole row (which breaks on odd cell counts and colspan rows).
    """
    soup = BeautifulSoup(html, "lxml")
    out: dict[str, str] = {}
    for tr in soup.find_all("tr"):
        cells = tr.find_all("td")
        i = 0
        n = len(cells)
        while i < n:
            classes = cells[i].get("class") or []
            if "formLabel" in classes and i + 1 < n:
                label = re.sub(r"\s+", " ", cells[i].get_text(" ", strip=True)).strip()
                value = re.sub(r"\s+", " ", cells[i + 1].get_text(" ", strip=True)).strip()
                if label and value and label not in out:
                    out[label] = value
                i += 2
            else:
                i += 1
    return out


class ScanProgress:
    """Snapshot of scan progress, yielded after each page."""

    def __init__(self, page_no: int, est_total_pages: int, total_results: int,
                 rows_seen: int, new_rows: list[dict], done: bool,
                 category_counts: dict[str, int] | None = None):
        self.page_no = page_no
        self.est_total_pages = est_total_pages
        self.total_results = total_results
        self.rows_seen = rows_seen
        self.new_rows = new_rows
        self.done = done
        self.category_counts = category_counts or {}


def scan(
    rail_unit: str = "",
    depot_id: str = "-1",
    max_pages: int | None = None,
    delay: float = 0.3,
) -> Iterator[ScanProgress]:
    """Scan all published lots, yielding a ScanProgress after every page.

    Stops once an empty page is hit or every known row has been seen, so a
    wrong rows-per-page assumption can't cause an early stop or infinite loop.

    Always scans every lot (no keyword filtering here) - callers persist
    `new_rows` (the rows newly seen on this page) however they like, e.g.
    into the SQLite store, and keyword search happens afterwards as a query
    against stored lots. Every seen (deduped) lot is tallied into a category
    breakdown (the official IREPS "CATEGORY" field, e.g. Ferrous/Non-Ferrous/
    Misc Scrap). Each row is also enriched with the depot's next scheduled
    auction date/time, resolved via cached lookups so the extra cost is per
    unique railway/depot, not per lot.
    """
    session = requests.Session()
    schedule = AuctionScheduleLookup(session)
    seen_lot_nos: set[str] = set()
    category_counts: dict[str, int] = {}
    page_no = 1
    total_results = 0
    est_total_pages = 1
    while True:
        if max_pages and page_no > max_pages:
            break
        if page_no > 1:
            time.sleep(delay)
        html = fetch_page(session, page_no, rail_unit, depot_id)
        if page_no == 1:
            total_results = parse_total_results(html)
            est_total_pages = (
                (total_results + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE if total_results else 1
            )
            schedule.set_railway_ids(parse_railway_options(html))
        rows = parse_rows(html)
        if not rows:
            break
        new_rows = []
        for row in rows:
            if row["lot_no"] in seen_lot_nos:
                continue
            seen_lot_nos.add(row["lot_no"])
            row["next_auction"] = schedule.next_auction(row["railway"], row["depot"])
            category_counts[row["category"]] = category_counts.get(row["category"], 0) + 1
            new_rows.append(row)
        done = bool(total_results and len(seen_lot_nos) >= total_results)
        yield ScanProgress(
            page_no, est_total_pages, total_results, len(seen_lot_nos),
            new_rows, done, dict(category_counts),
        )
        if done:
            break
        page_no += 1
