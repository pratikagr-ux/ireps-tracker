#!/usr/bin/env python3
"""Scan Matex (matexnet.com) upcoming auctions into Supabase's `lots`
table (source='Matex'), alongside the IREPS rows that autoscan.py
maintains for source='IREPS'. Same new/updated/unchanged/expired
change_tag pattern as autoscan.py, but scoped to source='Matex' rows
only, so it never touches IREPS data.

Two modes, chosen automatically by whether MATEX_USER_ID/MATEX_PASSWORD
are set:

- Logged in (preferred): signs in via matex_core.scan_authenticated(),
  then imports one `lots` row per *individual lot* within each auction
  (lot_no = "<auction code>#<lot no>"), same granularity as
  mstc_import.py -- real material code, description, quantity and EMD
  amount per lot, not just one coarse row per auction. If login fails, or
  one auction's per-lot page can't be fetched/parsed, that auction falls
  back to a single coarse row (same shape as the public-only scan), so a
  site hiccup degrades gracefully instead of losing the auction entirely.
- Public only (fallback / no credentials): the public homepage's "All
  Events" table -- a lot code, a location (state), a free-text
  description and an auction date/time window; no qty/unit or per-lot
  detail.

Credentials: same SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY as
autoscan.py, plus optional MATEX_USER_ID / MATEX_PASSWORD for the
logged-in mode (env vars in CI, or a local .env.local file).

Usage: .venv/bin/python matex_autoscan.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

import matex_core
from net_retry import call_with_retry
from pg_filter import pg_in_filter

ENV_FILE = Path(__file__).parent / ".env.local"
REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
OPTIONAL_KEYS = ("MATEX_USER_ID", "MATEX_PASSWORD")
EXISTING_PAGE_SIZE = 1000


def load_env() -> dict[str, str]:
    all_keys = REQUIRED_KEYS + OPTIONAL_KEYS
    env = {k: os.environ[k] for k in all_keys if os.environ.get(k)}
    if len(env) < len(all_keys) and ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key in all_keys and key not in env:
                env[key] = value.strip()
    missing = [k for k in REQUIRED_KEYS if not env.get(k)]
    if missing:
        print(f"Missing {', '.join(missing)} -- set as env vars (CI) or in {ENV_FILE} (local).", file=sys.stderr)
        sys.exit(1)
    return env


def rest_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


#: field -> human label, for the diff shown when a lot's change_tag is
#: "updated" (lots.change_detail). Mirrors matex_core.TRACKED_FIELDS.
TRACKED_FIELD_LABELS = {
    "material_descr": "Material Descr.",
    "qty_unit": "Quantity",
    "next_auction": "Next Auction",
}


def fetch_existing_matex_lots(base_url: str, headers: dict) -> dict[str, dict]:
    """lot_no -> {content_hash, status, first_seen_at, <tracked fields>} for
    every existing source='Matex' row, to diff a fresh scrape against."""
    select_fields = "lot_no,content_hash,status,first_seen_at,relist_count," + ",".join(matex_core.TRACKED_FIELDS)
    out: dict[str, dict] = {}
    offset = 0
    while True:
        resp = call_with_retry(
            requests.get,
            f"{base_url}/rest/v1/lots",
            headers=headers,
            params={
                "select": select_fields,
                "source": "eq.Matex",
                "limit": str(EXISTING_PAGE_SIZE),
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
        if len(batch) < EXISTING_PAGE_SIZE:
            break
        offset += EXISTING_PAGE_SIZE
    return out


def process_event(event: dict, existing: dict[str, dict], now_iso: str) -> dict:
    """`event` is already a fully-shaped row (lot_no, lot_id, qty_unit,
    material_descr, next_auction, detail) -- built either per-lot from the
    authenticated path or per-auction from the public-only fallback; this
    just layers the new/updated/unchanged/expired diff bookkeeping on
    top, same as autoscan.py/mstc_import.py."""
    content_hash = matex_core.content_hash(event)
    prev = existing.get(event["lot_no"])
    change_detail = None
    relist_count = 0
    if prev is None:
        change_tag = "new"
        first_seen_at = now_iso
    else:
        relist_count = prev.get("relist_count") or 0
        if prev["status"] == "expired":
            change_tag = "updated"  # reappeared after being gone
        elif prev["content_hash"] != content_hash:
            change_tag = "updated"
        else:
            change_tag = "unchanged"
        if change_tag == "updated":
            change_detail = {}
            for field, label in TRACKED_FIELD_LABELS.items():
                old, new = prev.get(field, ""), event.get(field, "")
                if old != new:
                    change_detail[label] = {"from": old, "to": new}
            if change_detail.get("Next Auction", {}).get("from"):
                relist_count += 1
        first_seen_at = prev.get("first_seen_at") or now_iso
    return {
        "lot_no": event["lot_no"],
        "lot_id": event.get("lot_id", event["lot_no"]),
        "source": "Matex",
        "railway": "",
        "depot": "",
        "qty_unit": event.get("qty_unit", ""),
        "category": "Matex Auction",
        "min_incr": "",
        "material_descr": event["material_descr"],
        "publish_date": "",
        "next_auction": event["next_auction"],
        "status": "active",
        "change_tag": change_tag,
        "change_detail": change_detail,
        "relist_count": relist_count,
        "content_hash": content_hash,
        "detail": event.get("detail"),
        "first_seen_at": first_seen_at,
        "last_seen_at": now_iso,
    }


def build_events_from_public(public_events: list[dict]) -> list[dict]:
    """Shape matex_core.scan()'s per-auction rows to process_event's
    uniform event dict -- one row per auction, no per-lot detail."""
    return [
        {
            "lot_no": e["lot_no"],
            "lot_id": e["lot_no"],
            "qty_unit": "",
            "material_descr": e["material_descr"],
            "next_auction": e["next_auction"],
            "detail": {"Location": e["location"]} if e["location"] else None,
        }
        for e in public_events
    ]


def build_events_from_authenticated(auctions: list[dict]) -> list[dict]:
    """Shape matex_core.scan_authenticated()'s auctions (each possibly
    carrying a per-lot `items` breakdown) to process_event's uniform event
    dict -- one row per individual lot where available, falling back to a
    single coarse row (matching the public-only shape) for any auction
    whose ProdDetails page couldn't be fetched/parsed."""
    events = []
    for auction in auctions:
        items = auction.get("items") or []
        company_name = auction.get("company_name") or ""
        detail_base = {"Location": auction["location"]} if auction["location"] else {}
        if company_name:
            # The company name was previously parsed off the listing and
            # then discarded entirely -- not stored, not searchable, not
            # shown anywhere. Carried through here, and folded into
            # material_descr below, so a lot's auction is visible/
            # searchable right in the main table instead of only on
            # Matex's own ProdDetails page.
            detail_base["Company"] = company_name
        if auction.get("detail_url"):
            # Lets the app's "View on Matex" link open this exact auction
            # instead of the generic homepage -- only works for a viewer
            # who's themselves logged in to Matex (no public/anonymous
            # equivalent exists there), but that's strictly better than
            # always landing on the homepage.
            detail_base["Detail URL"] = auction["detail_url"]
        auction_descr = f"{company_name} — {auction['material_descr']}" if company_name else auction["material_descr"]
        if not items:
            events.append({
                "lot_no": auction["lot_no"],
                "lot_id": auction["lot_no"],
                "qty_unit": "",
                "material_descr": auction_descr,
                "next_auction": auction["next_auction"],
                "detail": detail_base or None,
            })
            continue
        for item in items:
            item_descr = item["material_descr"] or auction["material_descr"]
            events.append({
                "lot_no": f"{auction['lot_no']}#{item['item_lot_no']}",
                "lot_id": auction["lot_no"],
                "qty_unit": item["qty_unit"],
                "material_descr": f"{company_name} — {item_descr}" if company_name else item_descr,
                "next_auction": auction["next_auction"],
                "detail": {
                    **detail_base,
                    "Material Code": item["material_code"],
                    "Plant": item["plant"],
                    "EMD Amount (Rs.)": item["emd_amount"],
                },
            })
    return events


def push_lots(base_url: str, headers: dict, rows: list[dict]) -> None:
    if not rows:
        return
    resp = call_with_retry(
        requests.post,
        f"{base_url}/rest/v1/lots",
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=rows,
        timeout=60,
    )
    if resp.status_code >= 300:
        print(f"  ERROR pushing Matex lots: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()


def mark_expired(base_url: str, headers: dict, lot_nos: list[str]) -> None:
    if not lot_nos:
        return
    resp = call_with_retry(
        requests.patch,
        f"{base_url}/rest/v1/lots",
        headers={**headers, "Prefer": "return=minimal"},
        params={"lot_no": pg_in_filter(lot_nos)},
        json={"status": "expired", "change_tag": "expired"},
        timeout=30,
    )
    if resp.status_code >= 300:
        print(f"  ERROR marking Matex lots expired: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()


def push_scan_summary(base_url: str, headers: dict, started_at: str, finished_at: str, summary: dict) -> None:
    payload = {
        "source": "Matex",
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
    env = load_env()
    base_url = env["SUPABASE_URL"].rstrip("/")
    headers = rest_headers(env["SUPABASE_SERVICE_ROLE_KEY"])

    started_at = datetime.now(timezone.utc).isoformat()

    matex_user, matex_pass = env.get("MATEX_USER_ID"), env.get("MATEX_PASSWORD")
    events: list[dict] = []
    if matex_user and matex_pass:
        print("Signing in to Matex for per-lot detail...", file=sys.stderr)
        auctions, login_ok = matex_core.scan_authenticated(matex_user, matex_pass)
        if login_ok:
            events = build_events_from_authenticated(auctions)
            with_items = sum(1 for a in auctions if a.get("items"))
            print(
                f"  signed in -- {len(auctions)} auction(s), {with_items} with a per-lot "
                f"breakdown ({len(events)} total lot rows)",
                file=sys.stderr,
            )
        else:
            print("  login failed -- falling back to public-only scan", file=sys.stderr)

    if not events:
        print("Scanning Matex (public) and syncing to Supabase...", file=sys.stderr)
        public_events = matex_core.scan()
        print(f"  found {len(public_events)} upcoming event(s) on the Matex homepage", file=sys.stderr)
        events = build_events_from_public(public_events)

    existing = fetch_existing_matex_lots(base_url, headers)
    now_iso = datetime.now(timezone.utc).isoformat()
    seen_lot_nos: set[str] = set()
    tally: dict[str, int] = {}
    payload = []
    for event in events:
        processed = process_event(event, existing, now_iso)
        seen_lot_nos.add(event["lot_no"])
        tally[processed["change_tag"]] = tally.get(processed["change_tag"], 0) + 1
        payload.append(processed)
    push_lots(base_url, headers, payload)

    expired_now = [lot_no for lot_no, row in existing.items() if row["status"] == "active" and lot_no not in seen_lot_nos]
    mark_expired(base_url, headers, expired_now)

    finished_at = datetime.now(timezone.utc).isoformat()
    summary = {
        "total_lots": len(seen_lot_nos),
        "new_count": tally.get("new", 0),
        "updated_count": tally.get("updated", 0),
        "expired_count": len(expired_now),
    }
    print(
        f"\nMatex scan complete: {summary['total_lots']} lots "
        f"({summary['new_count']} new, {summary['updated_count']} updated, "
        f"{summary['expired_count']} expired)\n",
        file=sys.stderr,
    )

    print("Pushing scan summary...", file=sys.stderr)
    push_scan_summary(base_url, headers, started_at, finished_at, summary)
    print("Done.", file=sys.stderr)


if __name__ == "__main__":
    main()
