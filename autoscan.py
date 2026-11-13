#!/usr/bin/env python3
"""Scan IREPS (Indian Railways e-auction) published lots straight into Supabase.

This is the daily autoscan entrypoint, run on a schedule by
.github/workflows/autoscan.yml (and runnable locally for testing/manual
triggers). Unlike the old SQLite-backed tool, this script has no local
persistence of its own: it scrapes ireps.gov.in fresh, fetches the existing
`lots` rows from Supabase to diff against (new/updated/unchanged/expired,
same change_tag semantics as before), and pushes the result straight back --
so Supabase is the single source of truth and this script can run from a
clean checkout (e.g. in CI) every time.

It also syncs the per-lot detail-popup fields (`lots.detail` jsonb) for every
active lot that doesn't have them yet or just changed (plus anything anyone
has bookmarked, regardless of status), so the web app's Location column and
its detail view/PDF/print stay accurate for lots in general, not just
bookmarked ones -- without a live server-side proxy to ireps.gov.in
(GitHub Pages is static, and a browser fetch straight to ireps.gov.in would
hit CORS).

Credentials: reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
environment (set as repo secrets in CI) or, for local runs, from a
.env.local file (same directory as this script, gitignored, never printed).

Usage: .venv/bin/python autoscan.py [--skip-detail] [--max-detail N] [--max-pages N]
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

import ireps_core
from ireps_core import scan

ENV_FILE = Path(__file__).parent / ".env.local"
REQUIRED_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
EXISTING_PAGE_SIZE = 1000
UPSERT_BATCH_SIZE = 500
EXPIRE_CHUNK_SIZE = 200


def load_env() -> dict[str, str]:
    """Prefer real environment variables (GitHub Actions secrets); fall back
    to a local .env.local file for manual/dev runs."""
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
        print(
            f"Missing {', '.join(missing)} -- set as env vars (CI) or in {ENV_FILE} (local).",
            file=sys.stderr,
        )
        sys.exit(1)
    return env


def rest_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def fetch_existing_lots(base_url: str, headers: dict) -> dict[str, dict]:
    """lot_no -> {content_hash, status, first_seen_at} for every lot currently
    in Supabase, so a fresh scrape can be diffed against it without any
    local persistence."""
    out: dict[str, dict] = {}
    offset = 0
    while True:
        resp = requests.get(
            f"{base_url}/rest/v1/lots",
            headers=headers,
            params={
                "select": "lot_no,content_hash,status,first_seen_at",
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


def process_row(row: dict, existing: dict[str, dict], now_iso: str) -> dict:
    """Compute the Supabase-ready payload for one freshly-scraped row,
    including its change_tag, by comparing against the existing snapshot."""
    content_hash = ireps_core.content_hash(row)
    prev = existing.get(row["lot_no"])
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
        "lot_no": row["lot_no"],
        "lot_id": row.get("lot_id", ""),
        "railway": row["railway"],
        "depot": row["depot"],
        "qty_unit": row["qty_unit"],
        "category": row["category"],
        "min_incr": row["min_incr"],
        "material_descr": row["material_descr"],
        "publish_date": row["publish_date"],
        "next_auction": row.get("next_auction", ""),
        "status": "active",
        "change_tag": change_tag,
        "content_hash": content_hash,
        "first_seen_at": first_seen_at,
        "last_seen_at": now_iso,
    }


def push_lots(base_url: str, headers: dict, rows: list[dict]) -> None:
    if not rows:
        return
    url = f"{base_url}/rest/v1/lots"
    upsert_headers = {**headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
    for batch in chunked(rows, UPSERT_BATCH_SIZE):
        resp = requests.post(url, headers=upsert_headers, json=batch, timeout=60)
        if resp.status_code >= 300:
            print(f"  ERROR pushing lots batch: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()


def mark_expired(base_url: str, headers: dict, lot_nos: list[str]) -> None:
    patch_headers = {**headers, "Prefer": "return=minimal"}
    for batch in chunked(lot_nos, EXPIRE_CHUNK_SIZE):
        resp = requests.patch(
            f"{base_url}/rest/v1/lots",
            headers=patch_headers,
            params={"lot_no": "in.({})".format(",".join(batch))},
            json={"status": "expired", "change_tag": "expired"},
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"  ERROR marking lots expired: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()


def run_scan(base_url: str, headers: dict, rail_unit: str, depot_id: str, max_pages, delay: float, allow_expire: bool = True) -> dict:
    existing = fetch_existing_lots(base_url, headers)
    print(f"  fetched {len(existing)} existing lot(s) from Supabase for diffing", file=sys.stderr)
    now_iso = datetime.now(timezone.utc).isoformat()
    seen_lot_nos: set[str] = set()
    tally: dict[str, int] = {}
    for progress in scan(rail_unit, depot_id, max_pages, delay):
        if progress.new_rows:
            payload = []
            for row in progress.new_rows:
                processed = process_row(row, existing, now_iso)
                seen_lot_nos.add(row["lot_no"])
                tally[processed["change_tag"]] = tally.get(processed["change_tag"], 0) + 1
                payload.append(processed)
            push_lots(base_url, headers, payload)
        print(
            f"  page {progress.page_no} (~of {progress.est_total_pages}): "
            f"{progress.rows_seen} of {progress.total_results} lots scanned",
            file=sys.stderr,
        )
    expired_now = [
        lot_no for lot_no, row in existing.items()
        if row["status"] == "active" and lot_no not in seen_lot_nos
    ]
    if not allow_expire:
        print(
            f"  partial scan (--max-pages set): skipping expiry of "
            f"{len(expired_now)} not-seen lot(s) to avoid false expiries",
            file=sys.stderr,
        )
        expired_now = []
    elif expired_now:
        mark_expired(base_url, headers, expired_now)
    return {
        "total_lots": len(seen_lot_nos),
        "new_count": tally.get("new", 0),
        "updated_count": tally.get("updated", 0),
        "expired_count": len(expired_now),
    }


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


def fetch_watchlisted_lots(base_url: str, headers: dict) -> list[dict]:
    """lot_no/lot_id pairs for every lot anyone has bookmarked, via the
    bookmarks -> lots FK embed (service_role key bypasses RLS, so this sees
    every user's bookmarks, not just one)."""
    resp = requests.get(
        f"{base_url}/rest/v1/bookmarks",
        headers=headers,
        params={"select": "lot_no,lots(lot_id)"},
        timeout=30,
    )
    resp.raise_for_status()
    out = []
    seen = set()
    for r in resp.json():
        lot_no = r["lot_no"]
        lot_id = (r.get("lots") or {}).get("lot_id")
        if lot_no in seen or not lot_id:
            continue
        seen.add(lot_no)
        out.append({"lot_no": lot_no, "lot_id": lot_id})
    return out


def fetch_lots_needing_detail(base_url: str, headers: dict) -> list[dict]:
    """lot_no/lot_id pairs for active lots whose catalogue detail (the same
    page "View on IREPS" opens) hasn't been synced yet, or was just added/
    changed by this scan -- so the web app's Location column and detail
    view/PDF/print stay accurate for every active lot, not only bookmarked
    ones, without re-fetching detail for lots that haven't changed."""
    resp = requests.get(
        f"{base_url}/rest/v1/lots",
        headers=headers,
        params={
            "select": "lot_no,lot_id",
            "status": "eq.active",
            "or": "(detail.is.null,change_tag.in.(new,updated))",
            "limit": "5000",
        },
        timeout=60,
    )
    resp.raise_for_status()
    return [{"lot_no": r["lot_no"], "lot_id": r["lot_id"]} for r in resp.json() if r.get("lot_id")]


def push_lot_detail(base_url: str, headers: dict, max_detail: int | None) -> None:
    watchlisted = fetch_watchlisted_lots(base_url, headers)
    needing_detail = fetch_lots_needing_detail(base_url, headers)
    targets: list[dict] = []
    seen = set()
    for b in watchlisted + needing_detail:  # bookmarked lots always win a spot within max_detail
        if b["lot_no"] in seen:
            continue
        seen.add(b["lot_no"])
        targets.append(b)
    if max_detail is not None:
        targets = targets[:max_detail]
    if not targets:
        print("  no lots need detail fetched", file=sys.stderr)
        return

    session = requests.Session()
    print(f"  fetching detail for {len(targets)} lot(s) ({len(watchlisted)} bookmarked)...", file=sys.stderr)
    for i, b in enumerate(targets, 1):
        try:
            html = ireps_core.fetch_lot_detail(session, b["lot_id"])
            detail = ireps_core.parse_lot_detail(html)
        except Exception as exc:  # noqa: BLE001
            print(f"  [{i}/{len(targets)}] lot {b['lot_no']}: FAILED ({exc})", file=sys.stderr)
            continue
        resp = requests.patch(
            f"{base_url}/rest/v1/lots",
            headers={**headers, "Prefer": "return=minimal"},
            params={"lot_no": f"eq.{b['lot_no']}"},
            json={"detail": detail},
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"  [{i}/{len(targets)}] lot {b['lot_no']}: PATCH failed {resp.status_code} {resp.text[:200]}", file=sys.stderr)
            continue
        print(f"  [{i}/{len(targets)}] lot {b['lot_no']}: detail synced", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rail-unit", default="", help="Railway unit code to restrict to (default: all)")
    parser.add_argument("--depot-id", default="-1", help="Depot id to restrict to (default: all, -1)")
    parser.add_argument("--max-pages", type=int, default=None, help="Stop after N pages (for testing)")
    parser.add_argument("--delay", type=float, default=0.3, help="Seconds to wait between page requests")
    parser.add_argument("--skip-detail", action="store_true", help="Don't fetch/push per-lot catalogue detail")
    parser.add_argument("--max-detail", type=int, default=None, help="Limit how many lots to fetch detail for (for testing)")
    args = parser.parse_args()

    env = load_env()
    base_url = env["SUPABASE_URL"].rstrip("/")
    headers = rest_headers(env["SUPABASE_SERVICE_ROLE_KEY"])

    started_at = datetime.now(timezone.utc).isoformat()
    print("Scanning IREPS and syncing to Supabase...", file=sys.stderr)
    summary = run_scan(
        base_url, headers, args.rail_unit, args.depot_id, args.max_pages, args.delay,
        allow_expire=(args.max_pages is None),
    )
    finished_at = datetime.now(timezone.utc).isoformat()
    print(
        f"\nScan complete: {summary['total_lots']} lots "
        f"({summary['new_count']} new, {summary['updated_count']} updated, "
        f"{summary['expired_count']} expired)\n",
        file=sys.stderr,
    )

    print("Pushing scan summary...", file=sys.stderr)
    push_scan_summary(base_url, headers, started_at, finished_at, summary)

    if not args.skip_detail:
        print("Syncing catalogue detail...", file=sys.stderr)
        push_lot_detail(base_url, headers, args.max_detail)

    print("Done.", file=sys.stderr)


if __name__ == "__main__":
    main()
