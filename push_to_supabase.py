#!/usr/bin/env python3
"""Push locally-scanned IREPS lots (ireps.db) up to Supabase.

Run this manually after a local scan (ireps_filter.py / webapp.py) to sync
the `lots` and `scans` tables for the public web dashboard (web/, deployed
to GitHub Pages) to read.

This script never touches the `bookmarks` table — your bookmarks (notes,
target/secured/sold rate, expenses) live in Supabase scoped to your signed-
in user via Row-Level Security (see supabase/schema.sql), and are created
directly from the web app once you sign in there. This script only pushes
the shared, non-sensitive scanned-lot data (using the service_role key,
which bypasses RLS) and, for lots you've bookmarked locally, the detailed
per-lot fields used by the web app's client-side PDF catalogue.

Credentials: reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from a local
.env.local file (same directory as this script), which is gitignored and
never printed. See README/chat instructions for how to populate it.

Usage: .venv/bin/python push_to_supabase.py [--skip-detail] [--max-detail N]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

import ireps_core
import ireps_db

ENV_FILE = Path(__file__).parent / ".env.local"


def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        print(f"Missing {ENV_FILE} -- see chat instructions for its contents.", file=sys.stderr)
        sys.exit(1)
    env: dict[str, str] = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not env.get(k)]
    if missing:
        print(f"{ENV_FILE} is missing: {', '.join(missing)}", file=sys.stderr)
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


def push_lots(base_url: str, headers: dict, rows: list[dict]) -> None:
    url = f"{base_url}/rest/v1/lots"
    upsert_headers = {**headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
    payload_rows = []
    for r in rows:
        payload_rows.append({
            "lot_no": r["lot_no"],
            "lot_id": r.get("lot_id", ""),
            "railway": r["railway"],
            "depot": r["depot"],
            "qty_unit": r["qty_unit"],
            "category": r["category"],
            "min_incr": r["min_incr"],
            "material_descr": r["material_descr"],
            "publish_date": r["publish_date"],
            "next_auction": r["next_auction"],
            "status": r["status"],
            "change_tag": r["change_tag"],
            "content_hash": r.get("content_hash", ""),
            "first_seen_at": r.get("first_seen"),
            "last_seen_at": r.get("last_seen"),
        })
    total = len(payload_rows)
    pushed = 0
    for batch in chunked(payload_rows, 500):
        resp = requests.post(url, headers=upsert_headers, json=batch, timeout=60)
        if resp.status_code >= 300:
            print(f"  ERROR pushing lots batch: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()
        pushed += len(batch)
        print(f"  pushed {pushed}/{total} lots", file=sys.stderr)


def push_latest_scan(base_url: str, headers: dict) -> None:
    with ireps_db.connect() as conn:
        row = conn.execute("SELECT * FROM scans ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        print("  no local scan history to push", file=sys.stderr)
        return
    local_scan = dict(row)

    # Only push if this scan isn't already the latest remote one (compared
    # by started_at), so repeated pushes with no new local scan don't pile
    # up duplicate rows.
    resp = requests.get(
        f"{base_url}/rest/v1/scans",
        headers=headers,
        params={"select": "started_at", "order": "finished_at.desc", "limit": "1"},
        timeout=30,
    )
    resp.raise_for_status()
    remote = resp.json()
    if remote and remote[0]["started_at"] == local_scan["started_at"]:
        print("  latest scan already pushed, skipping", file=sys.stderr)
        return

    payload = {
        "started_at": local_scan["started_at"],
        "finished_at": local_scan["finished_at"],
        "total_lots": local_scan["total_lots"],
        "new_count": local_scan["new_count"],
        "updated_count": local_scan["updated_count"],
        "expired_count": local_scan["expired_count"],
    }
    resp = requests.post(f"{base_url}/rest/v1/scans", headers={**headers, "Prefer": "return=minimal"}, json=payload, timeout=30)
    if resp.status_code >= 300:
        print(f"  ERROR pushing scan summary: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()
    print("  pushed latest scan summary", file=sys.stderr)


def push_bookmarked_detail(base_url: str, headers: dict, max_detail: int | None) -> None:
    """Fetch the per-lot detail-popup fields for locally-bookmarked lots and
    store them in lots.detail (jsonb), so the web app can build a full PDF
    catalogue for lots you've actually starred, without needing a live
    server-side proxy (GitHub Pages is static, and a browser fetch straight
    to ireps.gov.in would hit CORS)."""
    with ireps_db.connect() as conn:
        rows = conn.execute(
            """SELECT lots.lot_no, lots.lot_id FROM bookmarks
               JOIN lots ON lots.lot_no = bookmarks.lot_no
               WHERE lots.lot_id IS NOT NULL AND lots.lot_id != ''"""
        ).fetchall()
    bookmarked = [dict(r) for r in rows]
    if max_detail is not None:
        bookmarked = bookmarked[:max_detail]
    if not bookmarked:
        print("  no bookmarked lots to fetch detail for", file=sys.stderr)
        return

    session = requests.Session()
    print(f"  fetching detail for {len(bookmarked)} bookmarked lot(s)...", file=sys.stderr)
    for i, b in enumerate(bookmarked, 1):
        try:
            html = ireps_core.fetch_lot_detail(session, b["lot_id"])
            detail = ireps_core.parse_lot_detail(html)
        except Exception as exc:  # noqa: BLE001
            print(f"  [{i}/{len(bookmarked)}] lot {b['lot_no']}: FAILED ({exc})", file=sys.stderr)
            continue
        resp = requests.patch(
            f"{base_url}/rest/v1/lots",
            headers={**headers, "Prefer": "return=minimal"},
            params={"lot_no": f"eq.{b['lot_no']}"},
            json={"detail": detail},
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"  [{i}/{len(bookmarked)}] lot {b['lot_no']}: PATCH failed {resp.status_code} {resp.text[:200]}", file=sys.stderr)
            continue
        print(f"  [{i}/{len(bookmarked)}] lot {b['lot_no']}: detail synced", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-detail", action="store_true", help="Don't fetch/push per-lot detail for bookmarked lots")
    parser.add_argument("--max-detail", type=int, default=None, help="Limit how many bookmarked lots to fetch detail for (for testing)")
    args = parser.parse_args()

    env = load_env()
    base_url = env["SUPABASE_URL"].rstrip("/")
    headers = rest_headers(env["SUPABASE_SERVICE_ROLE_KEY"])

    ireps_db.init_db()
    all_lots = ireps_db.query_lots(status="", limit=100000)
    print(f"Pushing {len(all_lots)} lots to Supabase...", file=sys.stderr)
    push_lots(base_url, headers, all_lots)

    print("Pushing latest scan summary...", file=sys.stderr)
    push_latest_scan(base_url, headers)

    if not args.skip_detail:
        print("Syncing detail for bookmarked lots...", file=sys.stderr)
        push_bookmarked_detail(base_url, headers, args.max_detail)

    print("Done.", file=sys.stderr)


if __name__ == "__main__":
    main()
