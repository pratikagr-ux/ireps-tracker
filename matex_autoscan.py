#!/usr/bin/env python3
"""Scan the public Matex (matexnet.com) upcoming-auctions list into
Supabase's `lots` table (source='Matex'), alongside the IREPS rows that
autoscan.py maintains for source='IREPS'. Same new/updated/unchanged/
expired change_tag pattern as autoscan.py, but scoped to source='Matex'
rows only, so it never touches IREPS data.

Matex's own "Auctions" page (richer per-lot detail, qty, category) sits
behind a login we don't have -- its link bounces back to the public
homepage when signed out -- so this only has what's public: a lot code,
a location (state), a free-text description and an auction date/time
window. qty_unit, category and min_incr are left blank for Matex rows;
`detail` is set directly from the scraped location (no second per-lot
fetch needed, unlike IREPS).

Credentials: same SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY as
autoscan.py (env vars in CI, or a local .env.local file).

Usage: .venv/bin/python matex_autoscan.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

import matex_core

ENV_FILE = Path(__file__).parent / ".env.local"
REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
EXISTING_PAGE_SIZE = 1000


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
        print(f"Missing {', '.join(missing)} -- set as env vars (CI) or in {ENV_FILE} (local).", file=sys.stderr)
        sys.exit(1)
    return env


def rest_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def fetch_existing_matex_lots(base_url: str, headers: dict) -> dict[str, dict]:
    """lot_no -> {content_hash, status, first_seen_at} for every existing
    source='Matex' row, to diff a fresh scrape against."""
    out: dict[str, dict] = {}
    offset = 0
    while True:
        resp = requests.get(
            f"{base_url}/rest/v1/lots",
            headers=headers,
            params={
                "select": "lot_no,content_hash,status,first_seen_at",
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
    content_hash = matex_core.content_hash(event)
    prev = existing.get(event["lot_no"])
    if prev is None:
        change_tag = "new"
        first_seen_at = now_iso
    else:
        if prev["status"] == "expired":
            change_tag = "updated"  # reappeared after being gone
        elif prev["content_hash"] != content_hash:
            change_tag = "updated"
        else:
            change_tag = "unchanged"
        first_seen_at = prev.get("first_seen_at") or now_iso
    return {
        "lot_no": event["lot_no"],
        "lot_id": event["lot_no"],
        "source": "Matex",
        "railway": "",
        "depot": "",
        "qty_unit": "",
        "category": "Matex Auction",
        "min_incr": "",
        "material_descr": event["material_descr"],
        "publish_date": "",
        "next_auction": event["next_auction"],
        "status": "active",
        "change_tag": change_tag,
        "content_hash": content_hash,
        "detail": {"Location": event["location"]} if event["location"] else None,
        "first_seen_at": first_seen_at,
        "last_seen_at": now_iso,
    }


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
        print(f"  ERROR pushing Matex lots: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()


def mark_expired(base_url: str, headers: dict, lot_nos: list[str]) -> None:
    if not lot_nos:
        return
    resp = requests.patch(
        f"{base_url}/rest/v1/lots",
        headers={**headers, "Prefer": "return=minimal"},
        params={"lot_no": "in.({})".format(",".join(lot_nos))},
        json={"status": "expired", "change_tag": "expired"},
        timeout=30,
    )
    if resp.status_code >= 300:
        print(f"  ERROR marking Matex lots expired: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()


def push_scan_summary(base_url: str, headers: dict, started_at: str, finished_at: str, summary: dict) -> None:
    payload = {
        "started_at": started_at,
        "finished_at": finished_at,
        "total_lots": summary["total_lots"],
        "new_count": summary["new_count"],
        "updated_count": summary["updated_count"],
        "expired_count": summary["expired_count"],
    }
    resp = requests.post(
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
    print("Scanning Matex and syncing to Supabase...", file=sys.stderr)
    events = matex_core.scan()
    print(f"  found {len(events)} upcoming event(s) on the Matex homepage", file=sys.stderr)

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
