#!/usr/bin/env python3
"""Import MSTC (mstcecommerce.com) upcoming-auction rows into Supabase's
`lots` table (source='MSTC').

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

Input JSON: a list of objects, one per result-table row, exactly as shown
on the page --
  [{"category": "Iron and steel", "auctionNo": "MSTC/NRO/.../26-27/42861",
    "dateOfAuction": "27/11/2026",
    "duration": "27/11/2026 11:00:00 To 27/11/2026 15:00:00"}, ...]

Each import is necessarily partial (whatever category/filter was searched
that time), so -- unlike autoscan.py/matex_autoscan.py -- a lot absent from
one import is never assumed gone. Expiry is instead purely date-based: any
active MSTC lot (imported now or earlier) whose own auction date has
already passed is marked expired.

Usage: .venv/bin/python mstc_import.py rows.json
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ENV_FILE = Path(__file__).parent / ".env.local"
REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
MSTC_SEARCH_URL = "https://www.mstcecommerce.com/auctionhome/aucsearch/search.jsp"

DURATION_RE = re.compile(r"^(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2})\s+To\s+(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2})$")


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
    raw = f"{row['category']}|{row['next_auction']}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def parse_row(raw: dict) -> dict:
    """Best-effort parse of an Auction Number like
    "MSTC/NRO/COMMANDANT 55 BN SSB PITHORAGARH (UK)/1/Pithoragarh/26-27/42861"
    into office/seller/location (segments: MSTC/office/seller/lot#/location/
    fiscal-year/id). A handful have an extra "/" inside the seller/location
    text which shifts this -- harmless, since the full string, not these
    parsed display pieces, is the lot's actual identity (lot_no)."""
    auction_no = raw["auctionNo"].strip()
    segs = auction_no.split("/")
    office = segs[1] if len(segs) > 1 else ""
    seller = segs[2] if len(segs) > 2 else auction_no
    location = segs[-3] if len(segs) >= 3 else ""

    m = DURATION_RE.match(raw["duration"].strip())
    next_auction = m.group(1) if m else raw["duration"].strip()

    # A few rows repeat the category text twice (e.g. "Iron and steel\nIron
    # and steel") -- take just the first line.
    category = raw["category"].strip().splitlines()[0].strip()

    detail = {"Office": office, "Auction No.": auction_no}
    if location:
        detail["Location"] = location

    return {
        "lot_no": auction_no,
        "lot_id": auction_no,
        "source": "MSTC",
        "railway": "",
        "depot": office,
        "qty_unit": "",
        "category": category,
        "min_incr": "",
        "material_descr": seller,
        "publish_date": "",
        "next_auction": next_auction,
        "detail": detail,
    }


def fetch_existing_mstc_lots(base_url: str, headers: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    offset = 0
    page_size = 1000
    while True:
        resp = requests.get(
            f"{base_url}/rest/v1/lots",
            headers=headers,
            params={
                "select": "lot_no,content_hash,status,first_seen_at,next_auction",
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


def push_lots(base_url: str, headers: dict, rows: list[dict]) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{base_url}/rest/v1/lots",
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=rows,
        timeout=60,
    )
    if resp.status_code >= 300:
        print(f"ERROR pushing MSTC lots: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()


def mark_expired(base_url: str, headers: dict, lot_nos: list[str]) -> None:
    for i in range(0, len(lot_nos), 200):
        batch = lot_nos[i:i + 200]
        resp = requests.patch(
            f"{base_url}/rest/v1/lots",
            headers={**headers, "Prefer": "return=minimal"},
            params={"lot_no": "in.({})".format(",".join(batch))},
            json={"status": "expired", "change_tag": "expired"},
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"ERROR expiring MSTC lots: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()


def main():
    if len(sys.argv) != 2:
        print("Usage: mstc_import.py rows.json", file=sys.stderr)
        sys.exit(1)
    rows_raw = json.loads(Path(sys.argv[1]).read_text())
    if not rows_raw:
        print("No rows in input file -- nothing to do.", file=sys.stderr)
        return

    env = load_env()
    base_url = env["SUPABASE_URL"].rstrip("/")
    headers = rest_headers(env["SUPABASE_SERVICE_ROLE_KEY"])

    existing = fetch_existing_mstc_lots(base_url, headers)
    now = datetime.now()
    now_iso = datetime.now(timezone.utc).isoformat()

    payload = []
    tally: dict[str, int] = {}
    for raw in rows_raw:
        row = parse_row(raw)
        row["content_hash"] = content_hash(row)
        prev = existing.get(row["lot_no"])
        if prev is None:
            change_tag = "new"
            first_seen_at = now_iso
        else:
            first_seen_at = prev.get("first_seen_at") or now_iso
            if prev["status"] == "expired" or prev["content_hash"] != row["content_hash"]:
                change_tag = "updated"
            else:
                change_tag = "unchanged"

        dt = parse_dt(row["next_auction"])
        status = "expired" if dt and dt < now else "active"
        if status == "expired":
            change_tag = "expired" if change_tag != "new" else "new"

        row.update(status=status, change_tag=change_tag, first_seen_at=first_seen_at, last_seen_at=now_iso)
        tally[change_tag] = tally.get(change_tag, 0) + 1
        payload.append(row)

    push_lots(base_url, headers, payload)
    print(f"Upserted {len(payload)} MSTC row(s): {tally}", file=sys.stderr)

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


if __name__ == "__main__":
    main()
