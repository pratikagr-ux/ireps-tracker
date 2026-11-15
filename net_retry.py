"""Shared retry helper for the scraper/importer scripts.

Wraps a single HTTP call (through a requests.Session method, or a bare
requests.get/post/patch) with exponential-backoff retries, so one transient
blip -- a dropped connection, a brief 5xx, a timeout talking to
ireps.gov.in, matexnet.com or Supabase -- doesn't kill an entire daily
scan. 4xx responses are never retried (they won't fix themselves); callers
still call resp.raise_for_status() / check resp.status_code as before.

Used by ireps_core.py, matex_core.py, autoscan.py, matex_autoscan.py and
mstc_import.py.
"""
from __future__ import annotations

import sys
import time

import requests

RETRYABLE_STATUS = {500, 502, 503, 504}


def call_with_retry(fn, *args, max_attempts: int = 4, backoff: float = 2.0, **kwargs) -> requests.Response:
    """Call fn(*args, **kwargs) -- e.g. session.get, session.post, or the
    bare requests.get/post/patch -- retrying on connection errors, timeouts
    and 5xx responses with exponential backoff (2s, 4s, 8s, ...)."""
    for attempt in range(1, max_attempts + 1):
        try:
            resp = fn(*args, **kwargs)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            if attempt == max_attempts:
                raise
            wait = backoff ** (attempt - 1)
            print(f"  [retry {attempt}/{max_attempts}] request failed ({exc}); retrying in {wait:.0f}s...", file=sys.stderr)
            time.sleep(wait)
            continue
        if resp.status_code in RETRYABLE_STATUS and attempt < max_attempts:
            wait = backoff ** (attempt - 1)
            print(f"  [retry {attempt}/{max_attempts}] got HTTP {resp.status_code}; retrying in {wait:.0f}s...", file=sys.stderr)
            time.sleep(wait)
            continue
        return resp
    raise AssertionError("unreachable")  # loop above always returns or raises
