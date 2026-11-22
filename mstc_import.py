#!/usr/bin/env python3
"""Import MSTC (mstcecommerce.com) upcoming-auction rows into Supabase's
`lots` table (source='MSTC'), enriched with each auction's public
"Detailed Auction Catalogue" PDF.

Unlike IREPS/Matex, this can never be a cron-style scraper: MSTC's search
page demands a fresh CAPTCHA on every single query (confirmed by testing --
resubmitting the identical search in the same browser session still
prompted a brand new one, so it isn't a one-time session gate). Automating
that would mean solving the CAPTCHA unattended, which this project won't
do. Instead, a person runs the search themselves --
https://www.mstcecommerce.com/auctionhome/aucsearch/search.jsp -> Search
Auction -> tick Upcoming Auctions -> All -> Filter by Category -> pick a
category -> solve the CAPTCHA -- the resulting table is extracted from the
page and saved as a JSON file, and this script upserts it.

The search results page only gives one row per *auction* (seller/office/
date), with no material description. But each row's "Download PDF" link
calls downloadCatalogue(aucid), which POSTs to a public, no-login,
no-CAPTCHA endpoint that returns a "Detailed Auction Catalogue" PDF listing
every individual *lot* in that auction, with real material description,
quantity, pricing and location (see mstc_catalogue.py). So for every
auction row that carries an "aucid", this fetches and parses that PDF and
imports one `lots` row per lot (lot_no = "<auction number>#<lot number>"),
falling back to a single coarse row per auction (the old behaviour) only
if the PDF couldn't be fetched or parsed, or no aucid was captured.

Input JSON: a list of objects, one per result-table row --
  [{"category": "Iron and steel", "auctionNo": "MSTC/NRO/.../26-27/42861",
    "dateOfAuction": "27/11/2026",
    "duration": "27/11/2026 11:00:00 To 27/11/2026 15:00:00",
    "aucid": "614261"}, ...]
(aucid is optional -- extract it from each row's Auction Number link via
 `tr.querySelector('td:nth-child(3) a[onclick]').getAttribute('onclick')`,
 which looks like "downloadCatalogue(614261);".)

Each import is necessarily partial (whatever category/filter was searched
that time), so -- unlike autoscan.py/matex_autoscan.py -- a lot absent from
one import is never assumed gone. Expiry is instead purely date-based: any
active MSTC lot (imported now or earlier) whose own auction date has
already passed is marked expired.

Usage: .venv/bin/python mstc_import.py rows.json [--limit N]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

import mstc_catalogue
from net_retry import call_with_retry
from pg_filter import pg_in_filter

ENV_FILE = Path(__file__).parent / ".env.local"
REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
MSTC_SEARCH_URL = "https://www.mstcecommerce.com/auctionhome/aucsearch/search.jsp"

DURATION_RE = re.compile(r"^(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2})\s+To\s+(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2})$")

# Fields that feed each lot row's content_hash -- anything else changing
# (e.g. the search's own category label) doesn't bump change_tag to
# "updated" on its own.
_HASH_FIELDS = ["category", "material_descr", "qty_unit", "min_incr", "next_auction"]
_HASH_FIELD_LABELS = {
    "category": "Category", "material_descr": "Material Descr.", "qty_unit": "Qty/Unit",
    "min_incr": "Bid Increment (INR)", "next_auction": "Next Auction",
}


def load_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in REQUIRED_KEYS if os.environ.get(k)}
    if len(env) < len(REQUIRED_KEYS) and ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key in REQUIRED_KEYS and key not in env:
                env[key] = value.strip()
    missing = [k for k in REQUIRED_KEYS if not env.get(k)]
    if missing:
        print(f"Missing {', '.join(missing)} -- set as env vars or in {ENV_FILE}.", file=sys.stderr)
        sys.exit(1)
    return env


def rest_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def parse_dt(value: str) -> datetime | None:
    try:
        return datetime.strptime((value or "").strip(), "%d/%m/%Y %H:%M:%S")
    except ValueError:
        return None


def content_hash(row: dict) -> str:
    raw = "|".join(str(row.get(f, "")) for f in _HASH_FIELDS)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _auction_office_and_search_category(raw: dict) -> tuple[str, str, str]:
    """Best-effort parse of an Auction Number like
    "MSTC/NRO/COMMANDANT 55 BN SSB PITHORAGARH (UK)/1/Pithoragarh/26-27/42861"
    for its office code and seller name (segments: MSTC/office/seller/lot#/
    location/fiscal-year/id). A handful have an extra "/" inside the
    seller/location text which shifts this -- harmless, since the full
    string, not these parsed display pieces, is a lot's actual identity."""
    auction_no = raw["auctionNo"].strip()
    segs = auction_no.split("/")
    office = segs[1] if len(segs) > 1 else ""
    seller = segs[2] if len(segs) > 2 else auction_no
    # A few rows repeat the category text twice (e.g. "Iron and steel\nIron
    # and steel") -- take just the first line.
    search_category = raw["category"].strip().splitlines()[0].strip()
    return office, seller, search_category


def build_lot_rows(raw: dict, pdf_lots: list[dict] | None) -> list[dict]:
    """One `lots` row per lot in the auction's catalogue PDF, or a single
    coarse row for the whole auction if pdf_lots is empty/None (no aucid,
    or the PDF fetch/parse failed)."""
    auction_no = raw["auctionNo"].strip()
    office, seller, search_category = _auction_office_and_search_category(raw)
    m = DURATION_RE.match(raw["duration"].strip())
    next_auction = m.group(1) if m else raw["duration"].strip()

    if not pdf_lots:
        return [{
            "lot_no": auction_no,
            "lot_id": auction_no,
            "source": "MSTC",
            "railway": "",
            "depot": office,
            "qty_unit": "",
            "category": search_category,
            "min_incr": "",
            "material_descr": seller,
            "publish_date": "",
            "next_auction": next_auction,
            "detail": {"Office": office, "Auction No.": auction_no},
        }]

    rows = []
    seen_lot_nos: dict[str, int] = {}
    for lot in pdf_lots:
        detail = {"Auction No.": auction_no, "Lot No": lot["lot_no"], "Office": office}
        for key, label in [
            ("product_type", "Product Type"), ("category", "Category"), ("pcb_group", "PCB Group"),
            ("description", "Description"), ("item_code", "Item Code"),
            ("start_price", "Start Price (INR)"), ("bid_increment", "Bid Increment (INR)"),
            ("post_bid_emd_pct", "Post Bid EMD %"), ("tcs_pct", "TCS %"), ("gst_pct", "GST %"),
            ("lot_location", "Location"), ("state", "State"), ("bid_valid_till", "Bid Valid Till"),
        ]:
            if lot.get(key):
                detail[label] = lot[key]

        # MSTC's own catalogue occasionally reuses the same "Lot No" for two
        # genuinely different lots within one auction (seen in practice: a
        # duplicated Item Code). Disambiguate rather than silently merging
        # or dropping one.
        seen_lot_nos[lot["lot_no"]] = seen_lot_nos.get(lot["lot_no"], 0) + 1
        suffix = f"-{seen_lot_nos[lot['lot_no']]}" if seen_lot_nos[lot["lot_no"]] > 1 else ""

        rows.append({
            "lot_no": f"{auction_no}#{lot['lot_no']}{suffix}",
            "lot_id": auction_no,
            "source": "MSTC",
            "railway": "",
            "depot": office,
            "qty_unit": lot["quantity"],
            "category": lot["category"] or search_category,
            "min_incr": lot["bid_increment"],
            "material_descr": lot["lot_name"] or seller,
            "publish_date": "",
            "next_auction": next_auction,
            "detail": detail,
        })
    return rows


def fetch_existing_mstc_lots(base_url: str, headers: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    offset = 0
    page_size = 1000
    while True:
        resp = call_with_retry(
            requests.get,
            f"{base_url}/rest/v1/lots",
            headers=headers,
            params={
                "select": "lot_no,content_hash,status,first_seen_at,relist_count," + ",".join(_HASH_FIELDS),
                "source": "eq.MSTC",
                "limit": str(page_size),
                "offset": str(offset),
            },
            timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        for row in batch:
            out[row["lot_no"]] = row
        if len(batch) < page_size:
            break
        offset += page_size
    return out


UPSERT_BATCH_SIZE = 300


def push_lots(base_url: str, headers: dict, rows: list[dict]) -> None:
    for i in range(0, len(rows), UPSERT_BATCH_SIZE):
        batch = rows[i:i + UPSERT_BATCH_SIZE]
        resp = call_with_retry(
            requests.post,
            f"{base_url}/rest/v1/lots",
            headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=batch,
            timeout=60,
        )
        if resp.status_code >= 300:
            print(f"ERROR pushing MSTC lots batch: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()


def delete_lots(base_url: str, headers: dict, lot_nos: list[str]) -> None:
    for i in range(0, len(lot_nos), 200):
        batch = lot_nos[i:i + 200]
        resp = call_with_retry(
            requests.delete,
            f"{base_url}/rest/v1/lots",
            headers={**headers, "Prefer": "return=minimal"},
            params={"lot_no": pg_in_filter(batch), "source": "eq.MSTC"},
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"ERROR deleting superseded MSTC rows: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()


def mark_expired(base_url: str, headers: dict, lot_nos: list[str]) -> None:
    for i in range(0, len(lot_nos), 200):
        batch = lot_nos[i:i + 200]
        resp = call_with_retry(
            requests.patch,
            f"{base_url}/rest/v1/lots",
            headers={**headers, "Prefer": "return=minimal"},
            params={"lot_no": pg_in_filter(batch)},
            json={"status": "expired", "change_tag": "expired"},
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"ERROR expiring MSTC lots: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()


def push_scan_summary(base_url: str, headers: dict, started_at: str, finished_at: str, summary: dict) -> None:
    """Record this import's own `scans` row (source='MSTC'), same shape as
    autoscan.py/matex_autoscan.py -- so the app's dashboard can show a
    "last scanned" line for MSTC too, even though (unlike those two) this
    is a manual, partial import rather than a full daily crawl."""
    payload = {
        "source": "MSTC",
        "started_at": started_at,
        "finished_at": finished_at,
        "total_lots": summary["total_lots"],
        "new_count": summary["new_count"],
        "updated_count": summary["updated_count"],
        "expired_count": summary["expired_count"],
    }
    resp = call_with_retry(
        requests.post,
        f"{base_url}/rest/v1/scans", headers={**headers, "Prefer": "return=minimal"}, json=payload, timeout=30
    )
    if resp.status_code >= 300:
        print(f"  ERROR pushing scan summary: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rows_file")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N rows (for testing)")
    args = parser.parse_args()

    rows_raw = json.loads(Path(args.rows_file).read_text())
    if args.limit is not None:
        rows_raw = rows_raw[:args.limit]
    if not rows_raw:
        print("No rows in input file -- nothing to do.", file=sys.stderr)
        return

    env = load_env()
    base_url = env["SUPABASE_URL"].rstrip("/")
    headers = rest_headers(env["SUPABASE_SERVICE_ROLE_KEY"])

    started_at = datetime.now(timezone.utc).isoformat()
    existing = fetch_existing_mstc_lots(base_url, headers)
    now = datetime.now()
    now_iso = datetime.now(timezone.utc).isoformat()

    payload = []
    tally: dict[str, int] = {}
    superseded_auction_nos = []  # bare auction-number rows from an older coarse import
    pdf_ok, pdf_failed = 0, 0

    for n, raw in enumerate(rows_raw, 1):
        pdf_lots = None
        aucid = raw.get("aucid")
        if aucid:
            try:
                pdf_bytes = mstc_catalogue.fetch_catalogue_pdf(str(aucid))
                pdf_lots = mstc_catalogue.parse_catalogue_pdf(pdf_bytes)
                if pdf_lots:
                    pdf_ok += 1
                    superseded_auction_nos.append(raw["auctionNo"].strip())
                else:
                    pdf_failed += 1
            except Exception as exc:  # noqa: BLE001
                pdf_failed += 1
                print(f"  [{n}/{len(rows_raw)}] WARNING: catalogue PDF failed for {raw['auctionNo']} (aucid={aucid}): {exc}", file=sys.stderr)

        for row in build_lot_rows(raw, pdf_lots):
            row["content_hash"] = content_hash(row)
            prev = existing.get(row["lot_no"])
            change_detail = None
            relist_count = 0
            if prev is None:
                change_tag = "new"
                first_seen_at = now_iso
            else:
                relist_count = prev.get("relist_count") or 0
                first_seen_at = prev.get("first_seen_at") or now_iso
                change_tag = "updated" if (prev["status"] == "expired" or prev["content_hash"] != row["content_hash"]) else "unchanged"
                if change_tag == "updated":
                    change_detail = {}
                    for field, label in _HASH_FIELD_LABELS.items():
                        old, new = prev.get(field, ""), row.get(field, "")
                        if old != new:
                            change_detail[label] = {"from": old, "to": new}
                    if change_detail.get("Next Auction", {}).get("from"):
                        relist_count += 1

            dt = parse_dt(row["next_auction"])
            status = "expired" if dt and dt < now else "active"
            if status == "expired":
                change_tag = "expired" if change_tag != "new" else "new"

            row.update(status=status, change_tag=change_tag, change_detail=change_detail, relist_count=relist_count, first_seen_at=first_seen_at, last_seen_at=now_iso)
            tally[change_tag] = tally.get(change_tag, 0) + 1
            payload.append(row)

        if n % 20 == 0:
            print(f"  ...processed {n}/{len(rows_raw)} auction(s)", file=sys.stderr)

    push_lots(base_url, headers, payload)
    print(f"Upserted {len(payload)} MSTC lot row(s) from {len(rows_raw)} auction(s): {tally}", file=sys.stderr)
    print(f"Catalogue PDFs: {pdf_ok} parsed, {pdf_failed} fell back to a coarse per-auction row.", file=sys.stderr)

    # An auction that now has real per-lot rows supersedes its old
    # bare-auction-number row from a coarse import, if one exists.
    to_delete = [a for a in superseded_auction_nos if a in existing]
    if to_delete:
        delete_lots(base_url, headers, to_delete)
        print(f"Removed {len(to_delete)} superseded coarse auction-level row(s).", file=sys.stderr)

    # Expire any OTHER active MSTC lot (not touched by this import -- it may
    # just be outside this search's filters) whose own date has passed.
    seen = {r["lot_no"] for r in payload}
    stale = [
        lot_no for lot_no, r in existing.items()
        if r["status"] == "active" and lot_no not in seen and (dt := parse_dt(r.get("next_auction") or "")) and dt < now
    ]
    if stale:
        mark_expired(base_url, headers, stale)
    print(f"Expired {len(stale)} previously-imported MSTC lot(s) whose date has passed.", file=sys.stderr)

    finished_at = datetime.now(timezone.utc).isoformat()
    summary = {
        "total_lots": len(payload),
        "new_count": tally.get("new", 0),
        "updated_count": tally.get("updated", 0),
        "expired_count": tally.get("expired", 0) + len(stale),
    }
    push_scan_summary(base_url, headers, started_at, finished_at, summary)


if __name__ == "__main__":
    main()
