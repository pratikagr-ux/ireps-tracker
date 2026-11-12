"""SQLite-backed persistence for scanned lots, bookmarks, and scan history.

A lot's lifecycle: first seen -> change_tag='new'. On a later scan, if any of
its tracked fields differ -> change_tag='updated', otherwise 'unchanged'. If a
lot that was previously active isn't seen in a scan anymore, it's marked
status='expired' (never deleted, so bookmarks/notes on it are preserved).
"""
from __future__ import annotations

import hashlib
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

DB_PATH = Path(__file__).parent / "ireps.db"

# Fields whose change should flip a lot's change_tag to 'updated'.
TRACKED_FIELDS = ["qty_unit", "category", "min_incr", "material_descr", "publish_date", "next_auction"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS lots (
    lot_no TEXT PRIMARY KEY,
    lot_id TEXT,
    railway TEXT,
    depot TEXT,
    qty_unit TEXT,
    category TEXT,
    min_incr TEXT,
    material_descr TEXT,
    publish_date TEXT,
    next_auction TEXT,
    content_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',      -- active | expired
    change_tag TEXT NOT NULL DEFAULT 'new',      -- new | updated | unchanged | expired
    first_seen TEXT,
    last_seen TEXT
);

CREATE TABLE IF NOT EXISTS bookmarks (
    lot_no TEXT PRIMARY KEY REFERENCES lots(lot_no),
    bookmarked_at TEXT,
    notes TEXT DEFAULT '',
    target_rate TEXT DEFAULT '',
    secured_rate TEXT DEFAULT '',
    sold_rate TEXT DEFAULT '',
    expenses TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT,
    finished_at TEXT,
    total_lots INTEGER,
    new_count INTEGER,
    updated_count INTEGER,
    expired_count INTEGER
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


def _content_hash(row: dict) -> str:
    raw = "|".join(str(row.get(f, "")) for f in TRACKED_FIELDS)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def start_scan() -> int:
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO scans (started_at, total_lots, new_count, updated_count, expired_count) "
            "VALUES (?, 0, 0, 0, 0)",
            (now,),
        )
        return cur.lastrowid


def upsert_lot(conn: sqlite3.Connection, row: dict, now: str) -> str:
    """Insert/update one lot row within an already-open connection. Returns its change_tag."""
    existing = conn.execute("SELECT content_hash, status FROM lots WHERE lot_no = ?", (row["lot_no"],)).fetchone()
    content_hash = _content_hash(row)
    if existing is None:
        change_tag = "new"
        conn.execute(
            """INSERT INTO lots (lot_no, lot_id, railway, depot, qty_unit, category, min_incr,
                                  material_descr, publish_date, next_auction, content_hash,
                                  status, change_tag, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)""",
            (
                row["lot_no"], row.get("lot_id", ""), row["railway"], row["depot"], row["qty_unit"],
                row["category"], row["min_incr"], row["material_descr"], row["publish_date"],
                row.get("next_auction", ""), content_hash, change_tag, now, now,
            ),
        )
    else:
        if existing["status"] == "expired":
            change_tag = "updated"  # reappeared after being gone
        elif existing["content_hash"] != content_hash:
            change_tag = "updated"
        else:
            change_tag = "unchanged"
        conn.execute(
            """UPDATE lots SET lot_id=?, railway=?, depot=?, qty_unit=?, category=?, min_incr=?,
                                material_descr=?, publish_date=?, next_auction=?, content_hash=?,
                                status='active', change_tag=?, last_seen=?
               WHERE lot_no=?""",
            (
                row.get("lot_id", ""), row["railway"], row["depot"], row["qty_unit"], row["category"],
                row["min_incr"], row["material_descr"], row["publish_date"], row.get("next_auction", ""),
                content_hash, change_tag, now, row["lot_no"],
            ),
        )
    return change_tag


def finalize_scan(scan_id: int, seen_lot_nos: set[str], started_at: str) -> dict:
    """Mark any previously-active lot not seen this scan as expired, and log the summary."""
    now = datetime.now().isoformat(timespec="seconds")
    with connect() as conn:
        active_rows = conn.execute("SELECT lot_no FROM lots WHERE status = 'active'").fetchall()
        expired_now = [r["lot_no"] for r in active_rows if r["lot_no"] not in seen_lot_nos]
        for lot_no in expired_now:
            conn.execute(
                "UPDATE lots SET status='expired', change_tag='expired' WHERE lot_no=?", (lot_no,)
            )
        counts = conn.execute(
            "SELECT change_tag, COUNT(*) as n FROM lots WHERE lot_no IN ({}) GROUP BY change_tag".format(
                ",".join("?" * len(seen_lot_nos))
            ) if seen_lot_nos else "SELECT NULL as change_tag, 0 as n WHERE 0",
            tuple(seen_lot_nos),
        ).fetchall()
        tally = {row["change_tag"]: row["n"] for row in counts}
        summary = {
            "total_lots": len(seen_lot_nos),
            "new_count": tally.get("new", 0),
            "updated_count": tally.get("updated", 0),
            "expired_count": len(expired_now),
        }
        conn.execute(
            "UPDATE scans SET finished_at=?, total_lots=?, new_count=?, updated_count=?, expired_count=? WHERE id=?",
            (now, summary["total_lots"], summary["new_count"], summary["updated_count"],
             summary["expired_count"], scan_id),
        )
        return summary


def category_counts() -> dict[str, int]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT category, COUNT(*) as n FROM lots WHERE status='active' GROUP BY category ORDER BY n DESC"
        ).fetchall()
        return {r["category"]: r["n"] for r in rows}


def query_lots(
    search: str = "",
    category: str = "",
    change_tag: str = "",
    status: str = "active",
    bookmarked_only: bool = False,
    limit: int = 500,
) -> list[dict]:
    clauses = []
    params: list = []
    if status:
        clauses.append("lots.status = ?")
        params.append(status)
    if category:
        clauses.append("lots.category = ?")
        params.append(category)
    if change_tag:
        clauses.append("lots.change_tag = ?")
        params.append(change_tag)
    if search:
        terms = [t.strip() for t in search.split(",") if t.strip()]
        if terms:
            term_clauses = []
            for t in terms:
                term_clauses.append("(lots.material_descr LIKE ? OR lots.category LIKE ?)")
                params.extend([f"%{t}%", f"%{t}%"])
            clauses.append("(" + " OR ".join(term_clauses) + ")")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    bookmarked_join = "LEFT JOIN bookmarks ON bookmarks.lot_no = lots.lot_no"
    having = "HAVING bookmarks.lot_no IS NOT NULL" if bookmarked_only else ""
    sql = f"""
        SELECT lots.*, bookmarks.lot_no IS NOT NULL AS is_bookmarked
        FROM lots {bookmarked_join}
        {where}
        {having}
        ORDER BY lots.last_seen DESC
        LIMIT ?
    """
    params.append(limit)
    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def get_lot(lot_no: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM lots WHERE lot_no = ?", (lot_no,)).fetchone()
        return dict(row) if row else None


def get_lot_by_id(lot_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM lots WHERE lot_id = ?", (lot_id,)).fetchone()
        return dict(row) if row else None


def toggle_bookmark(lot_no: str) -> bool:
    """Returns True if now bookmarked, False if removed."""
    with connect() as conn:
        existing = conn.execute("SELECT 1 FROM bookmarks WHERE lot_no = ?", (lot_no,)).fetchone()
        if existing:
            conn.execute("DELETE FROM bookmarks WHERE lot_no = ?", (lot_no,))
            return False
        conn.execute(
            "INSERT INTO bookmarks (lot_no, bookmarked_at) VALUES (?, ?)",
            (lot_no, datetime.now().isoformat(timespec="seconds")),
        )
        return True


def update_bookmark(lot_no: str, notes: str, target_rate: str, secured_rate: str, sold_rate: str, expenses: str) -> None:
    with connect() as conn:
        conn.execute(
            """UPDATE bookmarks SET notes=?, target_rate=?, secured_rate=?, sold_rate=?, expenses=?
               WHERE lot_no=?""",
            (notes, target_rate, secured_rate, sold_rate, expenses, lot_no),
        )


def get_bookmarks() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT lots.*, bookmarks.notes, bookmarks.target_rate, bookmarks.secured_rate,
                      bookmarks.sold_rate, bookmarks.expenses, bookmarks.bookmarked_at
               FROM bookmarks JOIN lots ON lots.lot_no = bookmarks.lot_no
               ORDER BY bookmarks.bookmarked_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_lots_by_nos(lot_nos: list[str]) -> list[dict]:
    if not lot_nos:
        return []
    with connect() as conn:
        placeholders = ",".join("?" * len(lot_nos))
        rows = conn.execute(
            f"""SELECT lots.*, bookmarks.notes, bookmarks.target_rate, bookmarks.secured_rate,
                       bookmarks.sold_rate, bookmarks.expenses
                FROM lots LEFT JOIN bookmarks ON bookmarks.lot_no = lots.lot_no
                WHERE lots.lot_no IN ({placeholders})""",
            lot_nos,
        ).fetchall()
        return [dict(r) for r in rows]
