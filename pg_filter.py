"""Tiny PostgREST filter-value helper.

Shared by autoscan.py, matex_autoscan.py and mstc_import.py wherever they
build an `in.(...)` filter over a batch of lot_no values.
"""
from __future__ import annotations


def pg_in_filter(values: list[str]) -> str:
    """Build a PostgREST `in.(...)` filter value, quoting each item.

    PostgREST's `in` operator treats an unquoted list item literally up to
    the next comma/paren, so any value containing a space, comma or
    parenthesis silently fails to match (no error -- it just returns zero
    rows) unless double-quoted. MSTC's lot_no values are full auction
    numbers like "MSTC/NRO/.../1/Pithoragarh (UK)/26-27/42861" and hit this
    constantly; IREPS/Matex lot_nos usually don't, but quoting always is
    cheap and removes the whole class of bug.
    """
    quoted = [f'"{v.replace(chr(34), chr(34) * 2)}"' for v in values]
    return "in.({})".format(",".join(quoted))
