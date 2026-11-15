"""Fetch and parse MSTC's "Detailed Auction Catalogue" PDF for one auction.

Each row on the public search page (see mstc_import.py) is one *auction*,
which can bundle several individual *lots* -- the real material
description, quantity, pricing and location live in this PDF, one per
auction, keyed by a numeric "aucid" captured from that row's
`downloadCatalogue(aucid)` onclick handler. Unlike the search itself, this
PDF endpoint needs no login and no CAPTCHA (confirmed by fetching it with a
plain unauthenticated POST), so it's safe to fetch automatically for every
auction in an import batch.

The PDF's "Lot Details" table has five columns -- Lot Details, Lot
Description, Lot Parameters, Other Details, Lot Documents -- which
pdfplumber extracts as five separate cells per lot row, each a "\n"-joined
block of "Label - value" pairs (occasionally "Label :value"). Labels are
fixed and don't repeat within a cell, so each cell can be parsed by
splitting on whichever of the known labels appear in it, in order.
"""
from __future__ import annotations

import re

import pdfplumber
import requests
from io import BytesIO

from net_retry import call_with_retry

CATALOGUE_PDF_URL = "https://www.mstcecommerce.com/auctionhome/mstc/auction_detailed_report_pdf.jsp"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; auction-tracker/1.0)",
}

# Ordered only for readability -- extraction doesn't depend on this order
# (see _extract_labeled), since each label match starts at its own earliest
# position in the text regardless of listing order.
LOT_FIELD_LABELS = [
    "Lot No", "Lot Name", "Product Type", "Category", "PCB Group",
    "Quantity", "Start Price in INR", "Bid Increment in INR", "Post Bid EMD %", "TCS (%)",
    "GST (%)", "Lot Location", "State", "Lot State", "Bid Valid Till",
]
_LABEL_PATTERN = re.compile(
    "(" + "|".join(re.escape(l) for l in LOT_FIELD_LABELS) + r")\s*[-:]\s*"
)
_ITEM_CODE_RE = re.compile(r"Item Code\s*:-\s*([A-Za-z0-9]+)")
# The source PDF sometimes renders an empty sub-category as a literal
# placeholder token ("0.0", ".", "null") after the dash instead of just
# leaving it blank -- strip those (possibly repeated) trailing segments.
_PLACEHOLDER_SUFFIX_RE = re.compile(r"\s*-\s*(0\.0|null|\.|-)\s*$", re.IGNORECASE)


def _strip_placeholder_suffix(value: str) -> str:
    while True:
        cleaned = _PLACEHOLDER_SUFFIX_RE.sub("", value).strip()
        if cleaned == value:
            return value
        value = cleaned


def fetch_catalogue_pdf(aucid: str) -> bytes:
    """POST to the public catalogue-PDF endpoint for one auction id. No
    login or CAPTCHA required."""
    resp = call_with_retry(
        requests.post, CATALOGUE_PDF_URL,
        data={"auc": aucid, "cat": "0", "sell": "0"},
        headers=HEADERS, timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def _extract_labeled(cell_text: str) -> dict[str, str]:
    """Split one table cell's text on whichever known labels it contains,
    returning {label: value}. A value's trailing " - -" (a formatting
    artifact seen when a lot has no sub-category) is stripped."""
    joined = " ".join((cell_text or "").split("\n"))
    parts = _LABEL_PATTERN.split(joined)
    out: dict[str, str] = {}
    i = 1
    while i < len(parts) - 1:
        label = parts[i]
        value = parts[i + 1].strip()
        value = re.sub(r"[\s-]+$", "", value).strip()
        out[label] = value
        i += 2
    return out


def _parse_description_cell(cell_text: str) -> tuple[str, str]:
    """The "Lot Description" column is free text, not labeled fields --
    pull out an embedded "Item Code:- NNNN" if present and return the
    remaining text (boilerplate phrases stripped) alongside it."""
    text = " ".join((cell_text or "").split("\n"))
    m = _ITEM_CODE_RE.search(text)
    item_code = m.group(1) if m else ""
    text = _ITEM_CODE_RE.sub("", text)
    text = re.sub(r"CLICK FOR ANNEXURE\.?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text, item_code


def parse_catalogue_pdf(pdf_bytes: bytes) -> list[dict]:
    """Return one dict per lot in the catalogue (an auction with N lots
    yields N dicts), scanning every page -- a long lot list spans several
    pages, and only the first of them repeats the column-header row."""
    lots = []
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row or not row[0] or not re.match(r"\s*Lot No\s*[-:]", row[0]):
                        continue
                    cells = (row + [None] * 5)[:5]
                    fields = {}
                    for cell in (cells[0], cells[2], cells[3]):
                        fields.update(_extract_labeled(cell or ""))
                    description, item_code = _parse_description_cell(cells[1])
                    lots.append({
                        "lot_no": fields.get("Lot No", ""),
                        "lot_name": fields.get("Lot Name", ""),
                        "product_type": fields.get("Product Type", ""),
                        "category": _strip_placeholder_suffix(fields.get("Category", "")),
                        "pcb_group": fields.get("PCB Group", ""),
                        "description": description,
                        "item_code": item_code,
                        "quantity": fields.get("Quantity", ""),
                        "start_price": fields.get("Start Price in INR", ""),
                        "bid_increment": fields.get("Bid Increment in INR", ""),
                        "post_bid_emd_pct": fields.get("Post Bid EMD %", ""),
                        "tcs_pct": fields.get("TCS (%)", ""),
                        "gst_pct": fields.get("GST (%)", ""),
                        "lot_location": fields.get("Lot Location", ""),
                        "state": fields.get("State") or fields.get("Lot State", ""),
                        "bid_valid_till": fields.get("Bid Valid Till", ""),
                    })
    return [l for l in lots if l["lot_no"]]
