#!/usr/bin/env python3
"""Scan IREPS (Indian Railways e-auction) published lots into the local store.

Pulls the public "Lot Publishing Module" list (no login required) from
ireps.gov.in, scans every published lot, and persists it to ireps.db -
tagging each lot new/updated/unchanged since the last scan, and marking any
previously-active lot that's no longer listed as expired. Optionally also
searches the stored lots by keyword afterwards.
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path

import ireps_codes
import ireps_db
from ireps_core import FIELDS, scan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rail-unit", default="", help="Railway unit code to restrict to (default: all)")
    parser.add_argument("--depot-id", default="-1", help="Depot id to restrict to (default: all, -1)")
    parser.add_argument("--max-pages", type=int, default=None, help="Stop after N pages (for testing)")
    parser.add_argument("--delay", type=float, default=0.3, help="Seconds to wait between page requests")
    parser.add_argument("--no-scan", action="store_true", help="Skip scanning; just search/print the stored lots")
    parser.add_argument("--search", help="Comma-separated keywords to filter stored lots by, after scanning")
    parser.add_argument("--output", type=Path, help="Optional CSV path to write the --search results to")
    args = parser.parse_args()

    if not args.no_scan:
        scan_id = ireps_db.start_scan()
        started_at = datetime.now().isoformat(timespec="seconds")
        seen_lot_nos: set[str] = set()
        for progress in scan(args.rail_unit, args.depot_id, args.max_pages, args.delay):
            if progress.new_rows:
                now = datetime.now().isoformat(timespec="seconds")
                with ireps_db.connect() as conn:
                    for row in progress.new_rows:
                        ireps_db.upsert_lot(conn, row, now)
                        seen_lot_nos.add(row["lot_no"])
            print(
                f"  page {progress.page_no} (~of {progress.est_total_pages}): "
                f"{progress.rows_seen} of {progress.total_results} lots scanned",
                file=sys.stderr,
            )
        summary = ireps_db.finalize_scan(scan_id, seen_lot_nos, started_at)
        print(
            f"\nScan complete: {summary['total_lots']} lots "
            f"({summary['new_count']} new, {summary['updated_count']} updated, "
            f"{summary['expired_count']} expired)\n",
            file=sys.stderr,
        )

    print("Lots by category (active lots):", file=sys.stderr)
    for category, count in ireps_db.category_counts().items():
        print(f"  {count:>5}  {category}", file=sys.stderr)

    if not args.search:
        return

    matched = ireps_db.query_lots(search=args.search, status="active", limit=10000)
    for row in matched:
        row["location"] = ireps_codes.describe_location(row["railway"], row["depot"])
    print(f"\n{len(matched)} matching lots found for '{args.search}':\n", file=sys.stderr)
    for row in matched:
        auction = f" - next auction {row['next_auction']}" if row["next_auction"] else ""
        print(
            f"[{row['railway']}/{row['depot']}] Lot {row['lot_no']} "
            f"({row['qty_unit']}, {row['category']}): {row['material_descr']} "
            f"- published {row['publish_date']}{auction}\n"
            f"    {row['location']}"
        )

    if args.output:
        with args.output.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS + ["location"], extrasaction="ignore")
            writer.writeheader()
            writer.writerows(matched)
        print(f"\nSaved {len(matched)} rows to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
