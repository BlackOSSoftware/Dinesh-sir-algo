"""
Angel One live market quote — proxied through backend so keys stay server-side.

Browser calls GET /angel/live-quote with **Indian Algo** JWT only.
Angel `jwt_token` + `api_key` come from `backend/.env` (see `.env.example`).
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException

from app.config import settings
from app.deps import get_current_user, require_admin
from app.models import User
from app.services.angel_candles import post_get_candle_data
from app.services.angel_quote import post_market_quote, _truthy_status

LOG = logging.getLogger(__name__)

router = APIRouter(prefix="/angel", tags=["angel"])

_CACHE: dict[str, Any] = {"t": 0.0, "payload": None}
_CACHE_TTL_SEC = 1.35  # Slightly above upstream min spacing; avoids duplicate quote calls.

_START_BAR_CACHE: dict[str, Any] = {"t": 0.0, "key": "", "payload": None}
_START_BAR_CACHE_TTL_SEC = 180.0  # Start-bar for "today" changes rarely; eases candle API pressure.


def clear_angel_caches() -> None:
    """Clear live-quote and start-bar caches (e.g. after JWT refresh)."""
    global _CACHE, _START_BAR_CACHE
    _CACHE = {"t": 0.0, "payload": None}
    _START_BAR_CACHE = {"t": 0.0, "key": "", "payload": None}
    try:
        from app.services.market_ltp import clear_market_ltp_cache

        clear_market_ltp_cache()
    except Exception:  # noqa: BLE001
        pass


def _asia_kolkata_tz():
    """IST for session dates. Windows needs `tzdata` package; else UTC+05:30 fallback."""
    try:
        return ZoneInfo("Asia/Kolkata")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=5, minutes=30))


def _parse_candle_row(row: Any) -> tuple[str | None, float | None, float | None, float | None, float | None]:
    """Angel returns each candle as [datetime, open, high, low, close, volume] or similar."""
    if isinstance(row, (list, tuple)) and len(row) >= 5:
        dt = str(row[0]) if row[0] is not None else None
        try:
            o = float(row[1])
            h = float(row[2])
            l = float(row[3])
            c = float(row[4])
            return dt, o, h, l, c
        except (TypeError, ValueError):
            return dt, None, None, None, None
    if isinstance(row, dict):
        dt_raw = row.get("date") or row.get("datetime") or row.get("DateTime")
        dt = str(dt_raw) if dt_raw is not None else None

        def _f(*keys: str) -> float | None:
            for k in keys:
                v = row.get(k)
                if v is None or v == "":
                    continue
                try:
                    return float(v)
                except (TypeError, ValueError):
                    continue
            return None

        o = _f("open", "Open")
        h = _f("high", "High")
        l_ = _f("low", "Low")
        c = _f("close", "Close", "ltp", "Ltp")
        return dt, o, h, l_, c
    return None, None, None, None, None


def _parse_exchange_tokens(raw: str) -> dict[str, list[str]]:
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=503,
            detail=f"ANGEL_EXCHANGE_TOKENS must be valid JSON: {e}",
        ) from e
    if not isinstance(data, dict):
        raise HTTPException(status_code=503, detail="ANGEL_EXCHANGE_TOKENS must be a JSON object")
    out: dict[str, list[str]] = {}
    for ex, tokens in data.items():
        if not isinstance(ex, str):
            continue
        if isinstance(tokens, list):
            out[ex.upper()] = [str(t).strip() for t in tokens if str(t).strip()]
        elif isinstance(tokens, str):
            out[ex.upper()] = [tokens.strip()] if tokens.strip() else []
    return out


@router.get("/live-quote")
def angel_live_quote(_user: User = Depends(get_current_user)):
    """
    Cached live quote (LTP/OHLC/FULL per `ANGEL_QUOTE_MODE`).
    Response includes normalized `fetched` / `unfetched` when Angel returns them.
    """
    if not (settings.angel_api_key or "").strip() or not (settings.angel_jwt_token or "").strip():
        raise HTTPException(
            status_code=503,
            detail="Angel One not configured: set ANGEL_API_KEY and ANGEL_JWT_TOKEN in backend/.env",
        )

    exchange_tokens = _parse_exchange_tokens(settings.angel_exchange_tokens)
    if not exchange_tokens:
        raise HTTPException(
            status_code=503,
            detail='Set ANGEL_EXCHANGE_TOKENS JSON, e.g. {"BSE":["99919000"]} for SENSEX or {"NSE":["3045"]} for SBIN',
        )

    mode = (settings.angel_quote_mode or "OHLC").strip().upper()
    if mode not in ("LTP", "OHLC", "FULL"):
        mode = "OHLC"

    now = time.monotonic()
    if _CACHE["payload"] is not None and now - float(_CACHE["t"]) < _CACHE_TTL_SEC:
        return _CACHE["payload"]

    try:
        raw = post_market_quote(
            api_key=settings.angel_api_key.strip(),
            jwt_token=settings.angel_jwt_token.strip(),
            source_id=(settings.angel_source_id or "WEB").strip(),
            client_local_ip=(settings.angel_client_local_ip or "127.0.0.1").strip(),
            client_public_ip=(settings.angel_client_public_ip or "127.0.0.1").strip(),
            mac_address=(settings.angel_mac_address or "00:00:00:00:00:00").strip(),
            user_type=(settings.angel_user_type or "USER").strip(),
            mode=mode,
            exchange_tokens=exchange_tokens,
            timeout_sec=float(settings.angel_request_timeout_sec or 15.0),
        )
    except RuntimeError as e:
        LOG.warning("Angel quote failed: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        LOG.exception("Angel quote unexpected error")
        raise HTTPException(status_code=502, detail=str(e)) from e

    data = raw.get("data") if isinstance(raw, dict) else None
    fetched: list[Any] = []
    unfetched: list[Any] = []
    if isinstance(data, dict):
        if isinstance(data.get("fetched"), list):
            fetched = data["fetched"]
        if isinstance(data.get("unfetched"), list):
            unfetched = data["unfetched"]

    ok = _truthy_status(raw) if isinstance(raw, dict) else False
    msg = ""
    if isinstance(raw, dict):
        msg = str(raw.get("message") or raw.get("Message") or "")

    out = {
        "angel_ok": ok,
        "angel_message": msg,
        "mode": mode,
        "fetched": fetched,
        "unfetched": unfetched,
        "as_of": time.time(),
        "raw": raw if settings.angel_debug else None,
    }

    _CACHE["t"] = now
    _CACHE["payload"] = out
    return out


def _parse_start_hhmm(start: str) -> tuple[int, int]:
    s = (start or "").strip()
    # HTML time can be "09:15" or "09:15:00"
    m = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", s)
    if not m:
        raise HTTPException(status_code=422, detail="Query `start` must be HH:MM (e.g. 09:15)")
    hh = int(m.group(1))
    mm = int(m.group(2))
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise HTTPException(status_code=422, detail="Invalid time in `start`")
    return hh, mm


@router.get("/start-bar-close")
def angel_start_bar_close(start: str = "09:15", _user: User = Depends(get_current_user)):
    """
    Close of the first ONE_MINUTE candle at `start` (IST) for today, for the primary
    instrument in ANGEL_EXCHANGE_TOKENS (same token as live-quote).
    """
    if not (settings.angel_api_key or "").strip() or not (settings.angel_jwt_token or "").strip():
        raise HTTPException(
            status_code=503,
            detail="Angel One not configured: set ANGEL_API_KEY and ANGEL_JWT_TOKEN in backend/.env",
        )

    exchange_tokens = _parse_exchange_tokens(settings.angel_exchange_tokens)
    if not exchange_tokens:
        raise HTTPException(
            status_code=503,
            detail='Set ANGEL_EXCHANGE_TOKENS JSON, e.g. {"BSE":["99919000"]} for SENSEX',
        )

    hh, mm = _parse_start_hhmm(start)
    tz = _asia_kolkata_tz()
    now = datetime.now(tz)
    day = now.date()
    from_dt = datetime(day.year, day.month, day.day, hh, mm, 0, tzinfo=tz)
    to_dt = from_dt + timedelta(minutes=15)
    fromdate = from_dt.strftime("%Y-%m-%d %H:%M")
    todate = to_dt.strftime("%Y-%m-%d %H:%M")

    exchange = next(iter(exchange_tokens.keys()))
    tokens = exchange_tokens[exchange]
    if not tokens:
        raise HTTPException(status_code=503, detail="ANGEL_EXCHANGE_TOKENS has empty token list")
    symboltoken = tokens[0]

    cache_key = f"{exchange}:{symboltoken}:{fromdate}:{todate}"
    mono = time.monotonic()
    if (
        _START_BAR_CACHE["payload"] is not None
        and _START_BAR_CACHE["key"] == cache_key
        and mono - float(_START_BAR_CACHE["t"]) < _START_BAR_CACHE_TTL_SEC
    ):
        return _START_BAR_CACHE["payload"]

    try:
        raw = post_get_candle_data(
            api_key=settings.angel_api_key.strip(),
            jwt_token=settings.angel_jwt_token.strip(),
            source_id=(settings.angel_source_id or "WEB").strip(),
            client_local_ip=(settings.angel_client_local_ip or "127.0.0.1").strip(),
            client_public_ip=(settings.angel_client_public_ip or "127.0.0.1").strip(),
            mac_address=(settings.angel_mac_address or "00:00:00:00:00:00").strip(),
            user_type=(settings.angel_user_type or "USER").strip(),
            exchange=exchange,
            symboltoken=symboltoken,
            interval="ONE_MINUTE",
            fromdate=fromdate,
            todate=todate,
            timeout_sec=float(settings.angel_request_timeout_sec or 15.0),
        )
    except (RuntimeError, json.JSONDecodeError, TypeError, ValueError) as e:
        LOG.warning("Angel start-bar-close failed: %s", e)
        out = {
            "ok": False,
            "start_time": f"{hh:02d}:{mm:02d}",
            "close": None,
            "candle_time": None,
            "open": None,
            "high": None,
            "low": None,
            "exchange": exchange,
            "symboltoken": symboltoken,
            "fromdate": fromdate,
            "todate": todate,
            "message": str(e),
            "as_of": time.time(),
        }
        _START_BAR_CACHE["t"] = mono
        _START_BAR_CACHE["key"] = cache_key
        _START_BAR_CACHE["payload"] = out
        return out

    msg = ""
    if isinstance(raw, dict):
        msg = str(raw.get("message") or raw.get("Message") or "")

    rows = None
    if isinstance(raw, dict) and isinstance(raw.get("data"), list):
        rows = raw["data"]

    close_val: float | None = None
    open_val: float | None = None
    high_val: float | None = None
    low_val: float | None = None
    candle_time: str | None = None

    if rows:
        target_sub = f"{hh:02d}:{mm:02d}"
        chosen: tuple[str | None, float | None, float | None, float | None, float | None] | None = None
        chosen_fallback: tuple[str | None, float | None, float | None, float | None, float | None] | None = None
        for row in rows:
            ct, o, h, l, c = _parse_candle_row(row)
            if c is None:
                continue
            if chosen_fallback is None:
                chosen_fallback = (ct, o, h, l, c)
            tnorm = (ct or "").replace("T", " ")
            if target_sub in tnorm:
                chosen = (ct, o, h, l, c)
                break
        pick = chosen or chosen_fallback
        if pick:
            candle_time, open_val, high_val, low_val, close_val = pick

    out = {
        "ok": close_val is not None,
        "start_time": f"{hh:02d}:{mm:02d}",
        "close": close_val,
        "open": open_val,
        "high": high_val,
        "low": low_val,
        "candle_time": candle_time,
        "exchange": exchange,
        "symboltoken": symboltoken,
        "fromdate": fromdate,
        "todate": todate,
        "message": (msg or "") if close_val is None else "",
        "as_of": time.time(),
        "raw": raw if settings.angel_debug else None,
    }
    if close_val is None and not out["message"]:
        out["message"] = "No 1m candle in range (pre-open, holiday, or data not ready yet)"

    _START_BAR_CACHE["t"] = mono
    _START_BAR_CACHE["key"] = cache_key
    _START_BAR_CACHE["payload"] = out
    return out


@router.post("/refresh-session")
async def angel_refresh_session(_admin: User = Depends(require_admin)):
    """
    Run `scripts/angel_smartapi_login.py` with the backend venv, update ANGEL_JWT_TOKEN
    in `.env` and in-memory settings. Admin only. Does not replace the manual script workflow.
    """
    from app.services.angel_auto_login_scheduler import trigger_manual_angel_login_async

    return await trigger_manual_angel_login_async()
