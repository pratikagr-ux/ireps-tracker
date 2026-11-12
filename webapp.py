#!/usr/bin/env python3
"""Local web dashboard for the IREPS lot-publishing filter.

Run with: .venv/bin/python webapp.py
Then open http://127.0.0.1:5050
"""
from __future__ import annotations

import csv
import io
import threading
import traceback
from datetime import datetime

import requests
from flask import Flask, Response, jsonify, render_template, request
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

import ireps_codes
import ireps_core
import ireps_db

app = Flask(__name__)
ireps_db.init_db()


def _with_location(rows: list[dict]) -> list[dict]:
    for row in rows:
        row["location"] = ireps_codes.describe_location(row["railway"], row["depot"])
    return rows

_lock = threading.Lock()
_job = {
    "status": "idle",  # idle | running | done | error
    "page_no": 0,
    "est_total_pages": 0,
    "total_results": 0,
    "rows_seen": 0,
    "category_counts": {},
    "scan_summary": None,
    "error": None,
    "started_at": None,
    "finished_at": None,
}


def _run_scan(rail_unit, depot_id, max_pages):
    with _lock:
        _job.update(
            status="running",
            page_no=0,
            est_total_pages=0,
            total_results=0,
            rows_seen=0,
            category_counts={},
            scan_summary=None,
            error=None,
            started_at=datetime.now().isoformat(timespec="seconds"),
            finished_at=None,
        )
    try:
        scan_id = ireps_db.start_scan()
        started_at = datetime.now().isoformat(timespec="seconds")
        seen_lot_nos: set[str] = set()
        for progress in ireps_core.scan(rail_unit, depot_id, max_pages):
            now = datetime.now().isoformat(timespec="seconds")
            if progress.new_rows:
                with ireps_db.connect() as conn:
                    for row in progress.new_rows:
                        ireps_db.upsert_lot(conn, row, now)
                        seen_lot_nos.add(row["lot_no"])
            with _lock:
                _job.update(
                    page_no=progress.page_no,
                    est_total_pages=progress.est_total_pages,
                    total_results=progress.total_results,
                    rows_seen=progress.rows_seen,
                    category_counts=progress.category_counts,
                )
        summary = ireps_db.finalize_scan(scan_id, seen_lot_nos, started_at)
        with _lock:
            _job["status"] = "done"
            _job["scan_summary"] = summary
            _job["finished_at"] = datetime.now().isoformat(timespec="seconds")
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _job["status"] = "error"
            _job["error"] = f"{exc}\n{traceback.format_exc()}"
            _job["finished_at"] = datetime.now().isoformat(timespec="seconds")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/scan", methods=["POST"])
def start_scan():
    with _lock:
        already_running = _job["status"] == "running"
    if already_running:
        return jsonify({"started": False, "reason": "already running"})

    rail_unit = request.form.get("rail_unit", "").strip()
    depot_id = request.form.get("depot_id", "-1").strip() or "-1"
    max_pages_raw = request.form.get("max_pages", "").strip()
    max_pages = int(max_pages_raw) if max_pages_raw.isdigit() else None

    thread = threading.Thread(
        target=_run_scan, args=(rail_unit, depot_id, max_pages), daemon=True
    )
    thread.start()
    return jsonify({"started": True})


@app.route("/status")
def status():
    with _lock:
        snapshot = dict(_job)
    return jsonify(snapshot)


@app.route("/lots")
def lots():
    rows = ireps_db.query_lots(
        search=request.args.get("search", ""),
        category=request.args.get("category", ""),
        change_tag=request.args.get("change_tag", ""),
        status=request.args.get("status", "active"),
        bookmarked_only=request.args.get("bookmarked_only", "") == "1",
        limit=int(request.args.get("limit", "500")),
    )
    return jsonify(_with_location(rows))


@app.route("/category_counts")
def category_counts_route():
    return jsonify(ireps_db.category_counts())


@app.route("/bookmark/<lot_no>", methods=["POST"])
def bookmark_toggle(lot_no):
    bookmarked = ireps_db.toggle_bookmark(lot_no)
    return jsonify({"bookmarked": bookmarked})


@app.route("/bookmark/<lot_no>/update", methods=["POST"])
def bookmark_update(lot_no):
    ireps_db.update_bookmark(
        lot_no,
        notes=request.form.get("notes", ""),
        target_rate=request.form.get("target_rate", ""),
        secured_rate=request.form.get("secured_rate", ""),
        sold_rate=request.form.get("sold_rate", ""),
        expenses=request.form.get("expenses", ""),
    )
    return jsonify({"ok": True})


@app.route("/bookmarks")
def bookmarks():
    return jsonify(_with_location(ireps_db.get_bookmarks()))


@app.route("/lot_detail/<lot_id>")
def lot_detail(lot_id):
    try:
        html = ireps_core.fetch_lot_detail(requests.Session(), lot_id)
        return jsonify(ireps_core.parse_lot_detail(html))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


def _build_catalogue_pdf(lot_id: str, lot_row: dict | None, detail: dict[str, str]) -> bytes:
    """Render a lot's scraped detail fields into a clean, standalone PDF.

    This is a locally-generated summary, not the official IREPS catalogue
    document (that requires a logged-in bidder session to fetch - see
    printPublishLotDescriptionAnon.do).
    """
    styles = getSampleStyleSheet()
    cell_style = ParagraphStyle("cell", parent=styles["Normal"], fontSize=9, leading=12)
    label_style = ParagraphStyle("label", parent=cell_style, fontName="Helvetica-Bold")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=18 * mm, bottomMargin=18 * mm, leftMargin=16 * mm, rightMargin=16 * mm,
    )
    story = [Paragraph(f"Lot Catalogue - Lot {lot_row['lot_no'] if lot_row else lot_id}", styles["Title"])]

    if lot_row:
        location = ireps_codes.describe_location(lot_row["railway"], lot_row["depot"])
        summary_rows = [
            ["Railway / Depot", f"{lot_row['railway']} / {lot_row['depot']}"],
            ["Location", location],
            ["Category", lot_row["category"]],
            ["Qty / Unit", lot_row["qty_unit"]],
            ["Min Increment", lot_row["min_incr"]],
            ["Publish Date", lot_row["publish_date"]],
            ["Next Auction", lot_row["next_auction"] or "-"],
        ]
        summary_table = Table(
            [[Paragraph(k, label_style), Paragraph(str(v), cell_style)] for k, v in summary_rows],
            colWidths=[40 * mm, 134 * mm],
        )
        summary_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
        ]))
        story += [Spacer(1, 6), summary_table, Spacer(1, 12)]

    detail_rows = [[Paragraph(k, label_style), Paragraph(v, cell_style)] for k, v in detail.items()]
    if detail_rows:
        detail_table = Table(detail_rows, colWidths=[55 * mm, 119 * mm])
        detail_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.lightgrey),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BACKGROUND", (0, 0), (0, -1), colors.whitesmoke),
        ]))
        story.append(detail_table)

    story += [
        Spacer(1, 10),
        Paragraph(
            "Generated locally from publicly scraped IREPS lot data. This is not the "
            "official IREPS catalogue document.",
            ParagraphStyle("footnote", parent=styles["Normal"], fontSize=7, textColor=colors.grey),
        ),
    ]
    doc.build(story)
    return buf.getvalue()


@app.route("/download_catalogue/<lot_id>")
def download_catalogue(lot_id):
    try:
        html = ireps_core.fetch_lot_detail(requests.Session(), lot_id)
        detail = ireps_core.parse_lot_detail(html)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502
    lot_row = ireps_db.get_lot_by_id(lot_id)
    pdf_bytes = _build_catalogue_pdf(lot_id, lot_row, detail)
    filename = f"lot_{lot_row['lot_no'] if lot_row else lot_id}_catalogue.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.route("/print")
def print_lots():
    lot_nos_raw = request.args.get("lot_nos", "")
    lot_nos = [n.strip() for n in lot_nos_raw.split(",") if n.strip()]
    rows = _with_location(ireps_db.get_lots_by_nos(lot_nos))
    return render_template("print.html", rows=rows)


@app.route("/download.csv")
def download_csv():
    rows = _with_location(ireps_db.query_lots(
        search=request.args.get("search", ""),
        category=request.args.get("category", ""),
        change_tag=request.args.get("change_tag", ""),
        status=request.args.get("status", "active"),
        bookmarked_only=request.args.get("bookmarked_only", "") == "1",
        limit=int(request.args.get("limit", "10000")),
    ))
    buf = io.StringIO()
    fieldnames = ireps_core.FIELDS + ["status", "change_tag", "location"]
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=ireps_lots.csv"},
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False)
