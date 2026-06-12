"""
Background trading engine: range triggers, TP/SL, session auto-exit, paper fills,
LIVE Angel orders + order-book reconciliation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, time as dt_time, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.config import settings
from app.database import SessionLocal
from app.models import StrategySettings, TradePosition
from app.services import angel_orders
from app.services.angel_quote import _truthy_status
from app.services import trading_repository as tr
from app.services.bfo_options import resolve_bfo_option
from app.services.market_ltp import get_index_ltp_cached

LOG = logging.getLogger(__name__)

_engine_task: asyncio.Task[None] | None = None
_stop = asyncio.Event()
_prev_index_ltp: float | None = None
_last_market_ok: bool | None = None
_logged_engine_start: bool = False


def _ist_tz():
    try:
        return ZoneInfo("Asia/Kolkata")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=5, minutes=30))


def _parse_hhmm(s: str) -> dt_time | None:
    raw = (s or "").strip()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", raw)
    if not m:
        return None
    h, mm = int(m.group(1)), int(m.group(2))
    if not (0 <= h <= 23 and 0 <= mm <= 59):
        return None
    return dt_time(h, mm)


def _now_ist() -> datetime:
    return datetime.now(_ist_tz())


def _in_trading_window(now: datetime, start_s: str, end_s: str) -> bool:
    st = _parse_hhmm(start_s) or dt_time(9, 15)
    et = _parse_hhmm(end_s) or dt_time(15, 30)
    cur = now.timetz() if hasattr(now, "timetz") else now.time()
    # compare naive times
    c = datetime(2000, 1, 1, cur.hour, cur.minute, cur.second).time()
    a = datetime(2000, 1, 1, st.hour, st.minute, st.second).time()
    b = datetime(2000, 1, 1, et.hour, et.minute, et.second).time()
    if a <= b:
        return a <= c <= b
    return c >= a or c <= b


def _crossed_level(prev: float | None, cur: float | None, level: float) -> bool:
    if prev is None or cur is None:
        return False
    return (prev - level) * (cur - level) <= 0


def _parse_int_loose(v: Any) -> int | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v == v:
        return int(round(v))
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _parse_float_loose(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and v == v:
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


# Basket SL uses absolute index levels (SENSEX-scale). Smaller values are ignored
# so legacy "points" inputs do not fire immediately.
_GLOBAL_INDEX_SL_MIN = 15_000.0


def _global_sl_index_level(cfg: dict[str, Any], key: str) -> float | None:
    x = _parse_float_loose(cfg.get(key))
    if x is None or x < _GLOBAL_INDEX_SL_MIN:
        return None
    return x


def _take_profit_index(cfg: dict[str, Any], side: str, range_level: float, trd: dict[str, Any]) -> float | None:
    """TP from range ± gap (same as dashboard). Ignores stale per-leg tp JSON."""
    g = _parse_float_loose(cfg.get("gap"))
    if g is not None and g > 0:
        return range_level - g if side == "PUT" else range_level + g
    tp_raw = trd.get("tp")
    if tp_raw is None or str(tp_raw).strip() == "":
        return None
    try:
        return float(tp_raw)
    except (TypeError, ValueError):
        return None


def _leg_id(tr: dict[str, Any]) -> str | None:
    typ = str(tr.get("type") or "").upper()
    leg = tr.get("leg")
    try:
        li = int(leg)
    except (TypeError, ValueError):
        return None
    if typ == "PUT":
        return f"P{li}"
    if typ == "CALL":
        return f"C{li}"
    return None


def _synthetic_option_mark(pos: TradePosition, index_ltp: float) -> float:
    """Mark long option from index move vs entry (paper + LIVE PnL proxy)."""
    u0 = pos.underlying_at_entry
    if u0 is None:
        u0 = index_ltp
    du = index_ltp - float(u0)
    mult = -0.35 if (pos.side or "").upper() == "PUT" else 0.35
    ep = float(pos.entry_price or 0.0)
    if ep <= 0:
        ep = max(5.0, abs(du) * 0.05)
    m = ep + du * mult
    return max(0.05, m)


def _angel_headers() -> dict[str, str]:
    return dict(
        api_key=settings.angel_api_key.strip(),
        jwt_token=settings.angel_jwt_token.strip(),
        source_id=(settings.angel_source_id or "WEB").strip(),
        client_local_ip=(settings.angel_client_local_ip or "127.0.0.1").strip(),
        client_public_ip=(settings.angel_client_public_ip or "127.0.0.1").strip(),
        mac_address=(settings.angel_mac_address or "00:00:00:00:00:00").strip(),
        user_type=(settings.angel_user_type or "USER").strip(),
    )


def _past_or_at_session_end(now: datetime, end_s: str) -> bool:
    et = _parse_hhmm(end_s) or dt_time(15, 30)
    cur = now.time()
    return cur >= et


def _parse_order_book_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data")
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict) and isinstance(data.get("orderBook"), list):
        return [x for x in data["orderBook"] if isinstance(x, dict)]
    return []


def _order_row_for_id(rows: list[dict[str, Any]], order_id: str) -> dict[str, Any] | None:
    oid = (order_id or "").strip()
    if not oid:
        return None
    for r in rows:
        rid = str(r.get("orderid") or r.get("orderId") or "").strip()
        if rid == oid:
            return r
    return None


def _poll_live_entry_fill(db: Session, pos: TradePosition) -> None:
    if not pos.order_id:
        return
    try:
        raw = angel_orders.get_order_book(timeout_sec=float(settings.angel_request_timeout_sec or 15.0), **_angel_headers())
    except RuntimeError as e:
        tr.update_position_fields(db, pos, last_order_message=str(e)[:500])
        return
    rows = _parse_order_book_list(raw)
    row = _order_row_for_id(rows, pos.order_id)
    if not row:
        return
    status = str(row.get("orderstatus") or row.get("orderStatus") or "").strip().lower()
    text = str(row.get("text") or row.get("rejectReason") or "")
    try:
        avg = float(row.get("averageprice") or row.get("filledshares") or 0)
    except (TypeError, ValueError):
        avg = 0.0
    if status in ("rejected", "cancelled"):
        tr.append_trading_log(
            db,
            user_id=pos.user_id,
            mode=pos.trading_mode,
            leg=pos.leg_id,
            action="ORDER_REJECTED" if "reject" in status or status == "rejected" else "ORDER_CANCELLED",
            symbol=pos.trading_symbol,
            strike=pos.strike,
            quantity=pos.quantity,
            order_id=pos.order_id,
            message=text or status,
        )
        pos.status = "CLOSED"
        pos.exit_reason = "ORDER_REJECTED" if "reject" in status or status == "rejected" else "ORDER_CANCELLED"
        pos.exit_time = datetime.now(timezone.utc)
        pos.exit_price = 0.0
        pos.pnl = 0.0
        pos.last_order_message = (text or status)[:500]
        db.add(pos)
        db.commit()
        return
    if status in ("complete", "filled") and avg > 0:
        pos.entry_price = avg
        pos.last_order_message = (text or "FILLED")[:500]
        db.add(pos)
        db.commit()
        tr.append_trading_log(
            db,
            user_id=pos.user_id,
            mode=pos.trading_mode,
            leg=pos.leg_id,
            action="ORDER_FILLED",
            symbol=pos.trading_symbol,
            strike=pos.strike,
            quantity=pos.quantity,
            entry_price=avg,
            status="FILLED",
            order_id=pos.order_id,
            message=text or "Order filled",
        )


def _lot_multiplier(cfg: dict[str, Any]) -> int:
    v = _parse_int_loose(cfg.get("exchangeLotSize"))
    if v and v > 0:
        return v
    return max(1, int(settings.default_sensex_option_lot_size or 20))


def _repeat_leg_entries_allowed(cfg: dict[str, Any]) -> bool:
    """When true, skip same-day single-entry guard so a leg can open again after close."""
    m = str(cfg.get("legEntryMode") or "once").strip().lower()
    return m in ("multi", "repeat", "multiple")


def _try_enter_leg(
    db: Session,
    st_row: StrategySettings,
    cfg: dict[str, Any],
    trd: dict[str, Any],
    *,
    index_ltp: float,
) -> None:
    uid = st_row.user_id
    mode = (st_row.trading_mode or "PAPER").upper()
    leg_id = _leg_id(trd)
    if not leg_id:
        return
    if tr.get_open_position_by_leg(db, uid, leg_id):
        return
    if tr.leg_has_session_blocking_exit_today_ist(db, uid, leg_id):
        return
    if not _repeat_leg_entries_allowed(cfg) and tr.leg_has_entry_today_ist(db, uid, leg_id):
        return

    typ = str(trd.get("type") or "").upper()
    side = "PUT" if typ == "PUT" else "CALL"
    range_level = float(trd["range"])
    strike = float(trd["entry"])
    tp = _take_profit_index(cfg, side, range_level, trd)
    lots = max(1, _parse_int_loose(trd.get("lot")) or 1)
    lot_mult = _lot_multiplier(cfg)
    qty = lots * lot_mult
    psl = _global_sl_index_level(cfg, "putSL")
    csl = _global_sl_index_level(cfg, "callSL")
    put_sl = int(round(psl)) if psl is not None else _parse_int_loose(cfg.get("putSL"))
    call_sl = int(round(csl)) if csl is not None else _parse_int_loose(cfg.get("callSL"))
    sl_mode = str(cfg.get("slMode") or "auto")
    off = float(cfg.get("offset") or 500)
    syn_entry = max(5.0, min(5000.0, off * 0.1))

    exch = (settings.angel_option_exchange or "BFO").upper()
    product = (settings.angel_option_product_type or "CARRYFORWARD").upper()

    if mode == "LIVE":
        resolved = resolve_bfo_option(strike, "PE" if side == "PUT" else "CE")
        if resolved is None:
            tr.append_trading_log(
                db,
                user_id=uid,
                mode="LIVE",
                leg=leg_id,
                action="ERROR",
                symbol=None,
                strike=strike,
                quantity=qty,
                message="LIVE: no BFO instrument mapping (set ANGEL_BFO_INSTRUMENTS_JSON)",
            )
            return
        qty = lots * max(1, int(resolved.lotsize))
        try:
            raw = angel_orders.place_market_order(
                exchange=exch,
                tradingsymbol=resolved.tradingsymbol,
                symboltoken=resolved.token,
                transaction_type="BUY",
                quantity=qty,
                product_type=product,
                timeout_sec=float(settings.angel_request_timeout_sec or 15.0),
                **_angel_headers(),
            )
        except RuntimeError as e:
            tr.append_trading_log(
                db,
                user_id=uid,
                mode="LIVE",
                leg=leg_id,
                action="ORDER_REJECTED",
                symbol=resolved.tradingsymbol,
                strike=strike,
                quantity=qty,
                message=str(e)[:900],
            )
            return
        data = raw.get("data") if isinstance(raw, dict) else None
        oid = ""
        uoid = ""
        if isinstance(data, dict):
            oid = str(data.get("orderid") or data.get("orderId") or "")
            uoid = str(data.get("uniqueorderid") or data.get("uniqueOrderId") or "")
        msg = str(raw.get("message") or raw.get("Message") or "")
        ok = _truthy_status(raw) if isinstance(raw, dict) else False
        if not oid:
            tr.append_trading_log(
                db,
                user_id=uid,
                mode="LIVE",
                leg=leg_id,
                action="ORDER_REJECTED",
                symbol=resolved.tradingsymbol,
                strike=strike,
                quantity=qty,
                message=msg or json.dumps(raw)[:900],
            )
            return

        pos = TradePosition(
            user_id=uid,
            leg_id=leg_id,
            trading_mode="LIVE",
            side=side,
            range_level=range_level,
            strike=float(resolved.strike),
            tp=tp,
            lots=lots,
            quantity=qty,
            put_sl_pts=put_sl,
            call_sl_pts=call_sl,
            sl_mode=sl_mode,
            underlying_at_entry=index_ltp,
            entry_price=0.0,
            exchange=exch,
            trading_symbol=resolved.tradingsymbol,
            symbol_token=str(resolved.token),
            order_id=oid,
            unique_order_id=uoid or None,
            last_order_message=(msg or "PLACED")[:500],
        )
        tr.create_open_position(db, pos)
        tr.append_trading_log(
            db,
            user_id=uid,
            mode="LIVE",
            leg=leg_id,
            action="LEVEL_TRIGGERED",
            symbol=resolved.tradingsymbol,
            strike=strike,
            quantity=qty,
            message=f"Range {range_level:g} hit",
        )
        tr.append_trading_log(
            db,
            user_id=uid,
            mode="LIVE",
            leg=leg_id,
            action="ORDER_PLACED",
            symbol=resolved.tradingsymbol,
            strike=strike,
            quantity=qty,
            status="PLACED",
            order_id=oid,
            message=msg or "Order placed",
        )
        return

    # PAPER
    pos = TradePosition(
        user_id=uid,
        leg_id=leg_id,
        trading_mode="PAPER",
        side=side,
        range_level=range_level,
        strike=strike,
        tp=tp,
        lots=lots,
        quantity=qty,
        put_sl_pts=put_sl,
        call_sl_pts=call_sl,
        sl_mode=sl_mode,
        underlying_at_entry=index_ltp,
        entry_price=syn_entry,
        exchange=exch,
        trading_symbol=f"{round(strike):g} {'PE' if side == 'PUT' else 'CE'}",
        symbol_token=None,
        order_id=None,
        unique_order_id=None,
        last_order_message="PAPER_SIM",
    )
    tr.create_open_position(db, pos)
    sym = pos.trading_symbol or ""
    tr.append_trading_log(
        db,
        user_id=uid,
        mode="PAPER",
        leg=leg_id,
        action="LEVEL_TRIGGERED",
        symbol=sym,
        strike=strike,
        quantity=qty,
        message=f"Range {range_level:g} hit",
    )
    tr.append_trading_log(
        db,
        user_id=uid,
        mode="PAPER",
        leg=leg_id,
        action="ENTRY",
        symbol=sym,
        strike=strike,
        quantity=qty,
        entry_price=syn_entry,
        status="FILLED",
        message=f"Qty {qty}",
    )


def _should_exit_tp(pos: TradePosition, index_ltp: float) -> tuple[bool, str, float]:
    """Index-based take-profit only (PUT: index at/below TP; CALL: index at/above TP)."""
    mark = _synthetic_option_mark(pos, index_ltp)
    if pos.entry_price and float(pos.entry_price) <= 0:
        return False, "", mark
    if pos.tp is None:
        return False, "", mark
    tpf = float(pos.tp)
    su = (pos.side or "").upper()
    if su == "PUT" and index_ltp <= tpf:
        return True, "TP_HIT", mark
    if su == "CALL" and index_ltp >= tpf:
        return True, "TP_HIT", mark
    return False, "", mark


def _close_open(db: Session, pos: TradePosition, reason: str, exit_px: float) -> None:
    entry = float(pos.entry_price or 0.0)
    qty = int(pos.quantity)
    if entry <= 0:
        pnl = 0.0
        exit_px = 0.0
    else:
        pnl = (exit_px - entry) * qty
    tr.close_position(db, pos, exit_price=exit_px, exit_reason=reason, pnl=pnl)
    act = reason[:32]
    tr.append_trading_log(
        db,
        user_id=pos.user_id,
        mode=pos.trading_mode,
        leg=pos.leg_id,
        action=act,
        symbol=pos.trading_symbol,
        strike=pos.strike,
        quantity=qty,
        entry_price=entry,
        exit_price=exit_px,
        pnl=pnl,
        status=act,
        order_id=pos.order_id,
        message=reason[:900],
    )


def manual_close_leg(db: Session, user_id: int, leg_id: str) -> None:
    lid = (leg_id or "").strip().upper()
    pos = tr.get_open_position_by_leg(db, user_id, lid)
    if not pos:
        raise ValueError("NO_OPEN_POSITION")
    ltp, _, ok = get_index_ltp_cached()
    idx = float(ltp) if ok and ltp is not None else float(pos.underlying_at_entry or pos.range_level)
    mark = _synthetic_option_mark(pos, idx)
    _close_open(db, pos, "MANUAL_CLOSE", mark)


def _tick_session(db: Session, st_row: StrategySettings, cfg: dict[str, Any], index_ltp: float) -> None:
    uid = st_row.user_id
    now = _now_ist()
    start_s = str(cfg.get("startTime") or "09:15")
    end_s = str(cfg.get("endTime") or "15:30")
    in_win = _in_trading_window(now, start_s, end_s)
    trades = cfg.get("trades")
    if not isinstance(trades, list):
        trades = []

    global _prev_index_ltp
    prev = _prev_index_ltp

    sl_mode = str(cfg.get("slMode") or "auto")

    open_pos = tr.list_open_positions(db, uid)
    for pos in list(open_pos):
        if pos.trading_mode == "LIVE" and float(pos.entry_price or 0) <= 0:
            _poll_live_entry_fill(db, pos)

    open_pos = tr.list_open_positions(db, uid)
    if sl_mode == "auto" and _past_or_at_session_end(now, end_s):
        while True:
            open_pos = tr.list_open_positions(db, uid)
            pos = next((p for p in open_pos if p.status == "OPEN"), None)
            if pos is None:
                break
            if pos.trading_mode == "LIVE" and float(pos.entry_price or 0) <= 0 and pos.order_id:
                try:
                    angel_orders.cancel_order(
                        variety="NORMAL",
                        order_id=str(pos.order_id),
                        timeout_sec=float(settings.angel_request_timeout_sec or 15.0),
                        **_angel_headers(),
                    )
                    tr.append_trading_log(
                        db,
                        user_id=uid,
                        mode="LIVE",
                        leg=pos.leg_id,
                        action="ORDER_CANCELLED",
                        symbol=pos.trading_symbol,
                        strike=pos.strike,
                        quantity=pos.quantity,
                        order_id=pos.order_id,
                        message="Cancelled at session end (unfilled)",
                    )
                except RuntimeError as e:
                    tr.append_trading_log(
                        db,
                        user_id=uid,
                        mode="LIVE",
                        leg=pos.leg_id,
                        action="ERROR",
                        symbol=pos.trading_symbol,
                        order_id=pos.order_id,
                        message=f"Cancel at end failed: {e}"[:900],
                    )
            mark = _synthetic_option_mark(pos, index_ltp)
            _close_open(db, pos, "AUTO_EXIT", mark)

    put_sl_lvl = _global_sl_index_level(cfg, "putSL")
    if put_sl_lvl is not None and index_ltp >= put_sl_lvl:
        while True:
            open_pos = tr.list_open_positions(db, uid)
            pos = next(
                (
                    p
                    for p in open_pos
                    if p.status == "OPEN" and (p.side or "").upper() == "PUT"
                ),
                None,
            )
            if pos is None:
                break
            if pos.trading_mode == "LIVE" and float(pos.entry_price or 0) <= 0 and pos.order_id:
                try:
                    angel_orders.cancel_order(
                        variety="NORMAL",
                        order_id=str(pos.order_id),
                        timeout_sec=float(settings.angel_request_timeout_sec or 15.0),
                        **_angel_headers(),
                    )
                    tr.append_trading_log(
                        db,
                        user_id=uid,
                        mode="LIVE",
                        leg=pos.leg_id,
                        action="ORDER_CANCELLED",
                        symbol=pos.trading_symbol,
                        strike=pos.strike,
                        quantity=pos.quantity,
                        order_id=pos.order_id,
                        message="Cancelled on basket PUT SL (unfilled)",
                    )
                except RuntimeError as e:
                    tr.append_trading_log(
                        db,
                        user_id=uid,
                        mode="LIVE",
                        leg=pos.leg_id,
                        action="ERROR",
                        symbol=pos.trading_symbol,
                        order_id=pos.order_id,
                        message=f"Basket PUT SL cancel failed: {e}"[:900],
                    )
            mark = _synthetic_option_mark(pos, index_ltp)
            _close_open(db, pos, "PUT_SL_HIT", mark)

    call_sl_lvl = _global_sl_index_level(cfg, "callSL")
    if call_sl_lvl is not None and index_ltp <= call_sl_lvl:
        while True:
            open_pos = tr.list_open_positions(db, uid)
            pos = next(
                (
                    p
                    for p in open_pos
                    if p.status == "OPEN" and (p.side or "").upper() == "CALL"
                ),
                None,
            )
            if pos is None:
                break
            if pos.trading_mode == "LIVE" and float(pos.entry_price or 0) <= 0 and pos.order_id:
                try:
                    angel_orders.cancel_order(
                        variety="NORMAL",
                        order_id=str(pos.order_id),
                        timeout_sec=float(settings.angel_request_timeout_sec or 15.0),
                        **_angel_headers(),
                    )
                    tr.append_trading_log(
                        db,
                        user_id=uid,
                        mode="LIVE",
                        leg=pos.leg_id,
                        action="ORDER_CANCELLED",
                        symbol=pos.trading_symbol,
                        strike=pos.strike,
                        quantity=pos.quantity,
                        order_id=pos.order_id,
                        message="Cancelled on basket CALL SL (unfilled)",
                    )
                except RuntimeError as e:
                    tr.append_trading_log(
                        db,
                        user_id=uid,
                        mode="LIVE",
                        leg=pos.leg_id,
                        action="ERROR",
                        symbol=pos.trading_symbol,
                        order_id=pos.order_id,
                        message=f"Basket CALL SL cancel failed: {e}"[:900],
                    )
            mark = _synthetic_option_mark(pos, index_ltp)
            _close_open(db, pos, "CALL_SL_HIT", mark)

    while True:
        open_pos = tr.list_open_positions(db, uid)
        found = False
        for pos in open_pos:
            if pos.status != "OPEN":
                continue
            if pos.trading_mode == "LIVE" and float(pos.entry_price or 0) <= 0:
                continue
            ex, reason, mark = _should_exit_tp(pos, index_ltp)
            if ex:
                _close_open(db, pos, reason, mark)
                found = True
                break
        if not found:
            break

    # LIVE: new entries only during session. PAPER: allow 24h so range tests work off-hours.
    mode_u = (st_row.trading_mode or "PAPER").upper()
    if mode_u != "PAPER" and not in_win:
        return

    if prev is None:
        return
    for trd in trades:
        if not isinstance(trd, dict):
            continue
        if not bool(trd.get("enabled", True)):
            continue
        leg_id = _leg_id(trd)
        if not leg_id:
            continue
        try:
            lvl = float(trd["range"])
        except (TypeError, ValueError, KeyError):
            continue
        if not _crossed_level(prev, index_ltp, lvl):
            continue
        _try_enter_leg(db, st_row, cfg, trd, index_ltp=index_ltp)


def tick_once() -> None:
    global _prev_index_ltp, _last_market_ok, _logged_engine_start
    ltp, detail, ok = get_index_ltp_cached()
    db = SessionLocal()
    try:
        rows = list(db.scalars(select(StrategySettings).where(StrategySettings.algo_running.is_(True))).all())
        if not _logged_engine_start and rows:
            LOG.info("Trading engine serving %d active strategy row(s)", len(rows))
            _logged_engine_start = True

        good = bool(ok and ltp is not None)
        if good:
            if _last_market_ok is not True:
                for st in rows:
                    tr.append_trading_log(
                        db,
                        user_id=st.user_id,
                        mode=st.trading_mode,
                        leg="-",
                        action="MARKET_DATA_CONNECTED",
                        message="Index quote OK",
                    )
        else:
            if _last_market_ok is True:
                for st in rows:
                    tr.append_trading_log(
                        db,
                        user_id=st.user_id,
                        mode=st.trading_mode,
                        leg="-",
                        action="MARKET_DATA_LOST",
                        message=detail or "No LTP",
                    )
        _last_market_ok = good

        if ltp is None or not ok:
            return

        assert ltp is not None
        index_ltp = float(ltp)

        for st in rows:
            cfg = tr.load_config_dict(db, st.user_id)
            try:
                _tick_session(db, st, cfg, index_ltp)
            except Exception as exc:  # noqa: BLE001
                LOG.exception("User %s trading tick error", st.user_id)
                tr.append_trading_log(
                    db,
                    user_id=st.user_id,
                    mode=st.trading_mode,
                    leg="-",
                    action="ERROR",
                    message=str(exc)[:900],
                )

        _prev_index_ltp = index_ltp
    finally:
        db.close()


async def run_engine_loop() -> None:
    LOG.info("Trading engine loop started")
    while not _stop.is_set():
        try:
            await asyncio.to_thread(tick_once)
        except Exception:  # noqa: BLE001
            LOG.exception("tick_once crashed")
        try:
            await asyncio.wait_for(asyncio.sleep(2.0), timeout=3.0)
        except asyncio.CancelledError:
            break
    LOG.info("Trading engine loop stopped")


def start_trading_engine_task() -> asyncio.Task[None]:
    global _engine_task
    _stop.clear()
    if _engine_task and not _engine_task.done():
        return _engine_task
    _engine_task = asyncio.create_task(run_engine_loop(), name="trading-engine")
    return _engine_task


async def stop_trading_engine_task() -> None:
    global _engine_task
    _stop.set()
    if _engine_task and not _engine_task.done():
        _engine_task.cancel()
        try:
            await _engine_task
        except asyncio.CancelledError:
            pass
    _engine_task = None
