#!/usr/bin/env python3
"""Load CardSight rows into cards, comps, and sku_mappings.

Dry-run by default. --commit writes only the sqlite file you pass.
No network calls.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "db" / "sqlite" / "001_observe.sql"
PTO = ("topps now", "bowman now", "panini instant")


def norm(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def read_json(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return data.get("items") or data.get("results") or []
    return data


def is_print_to_order(set_name: str, title: str) -> bool:
    blob = f"{set_name} {title}".lower()
    return any(token in blob for token in PTO)


def card_row(mapped: dict, title: str) -> dict:
    set_name = mapped.get("set") or mapped.get("set_name") or ""
    fields = {
        "year": str(mapped.get("year") or ""),
        "set_name": set_name,
        "parallel": mapped.get("parallel") or "",
        "player": mapped.get("player") or "",
        "card_no": str(mapped.get("card_no") or ""),
        "serial_denom": str(mapped.get("serial_denom") or ""),
        "is_auto": 1 if mapped.get("is_auto") else 0,
        "is_rookie": 1 if mapped.get("is_rookie") else 0,
        "grade_co": mapped.get("grade_co") or "",
        "grade": str(mapped.get("grade") or ""),
        "canonical_title": title,
        "is_print_to_order": 1 if is_print_to_order(set_name, title) else 0,
    }
    identity = "|".join(
        norm(fields[key])
        for key in ("year", "set_name", "parallel", "player", "card_no", "serial_denom", "grade_co", "grade")
    )
    fields["identity_key"] = identity
    fields["card_id"] = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return fields


def item_key(row: dict) -> str:
    if row["item_id"]:
        return row["item_id"]
    return f"cardsight:{row['cardsight_id']}"


def load_rows(all_items: Path, remainder: Path) -> list[dict]:
    rows = []
    for path in (all_items, remainder):
        for raw in read_json(path):
            rows.append(
                {
                    "cardsight_id": str(raw.get("cardsight_id") or raw.get("id") or ""),
                    "title": str(raw.get("title") or ""),
                    "sold_price": raw.get("sold_price", raw.get("price")),
                    "sold_date": str(raw.get("sold_date") or ""),
                    "item_id": str(raw.get("ebay_item_id") or raw.get("item_id") or ""),
                    "accepted_offer": 1 if raw.get("accepted_offer") else 0,
                }
            )
    return rows


def existing_keys(conn: sqlite3.Connection) -> set[str]:
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    found = set()
    for (item_id,) in conn.execute("SELECT item_id FROM comps WHERE source = 'cardsight'"):
        if item_id:
            found.add(item_id)
    return found


def commit_rows(conn: sqlite3.Connection, prepared: list[dict]) -> int:
    inserted = 0
    for row in prepared:
        card = row.get("card")
        card_id = None
        if card:
            conn.execute(
                """
                INSERT OR IGNORE INTO cards (
                  card_id, year, set_name, parallel, player, card_no, serial_denom,
                  is_auto, is_rookie, grade_co, grade, canonical_title, is_print_to_order, identity_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card["card_id"],
                    card["year"],
                    card["set_name"],
                    card["parallel"],
                    card["player"],
                    card["card_no"],
                    card["serial_denom"],
                    card["is_auto"],
                    card["is_rookie"],
                    card["grade_co"],
                    card["grade"],
                    card["canonical_title"],
                    card["is_print_to_order"],
                    card["identity_key"],
                ),
            )
            card_id = card["card_id"]
            conn.execute(
                """
                INSERT OR IGNORE INTO sku_mappings (card_id, cardsight_id, checklist_slug)
                VALUES (?, ?, ?)
                """,
                (card_id, row["cardsight_id"], norm(card["player"]).replace(" ", "-")),
            )
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO comps (
              card_id, external_ref, source, item_id, sold_price, sold_date,
              accepted_offer, included, exclusion_reason
            ) VALUES (?, ?, 'cardsight', ?, ?, ?, ?, 0, 'unreviewed')
            """,
            (
                card_id,
                row["cardsight_id"],
                item_key(row),
                row["sold_price"],
                row["sold_date"],
                row["accepted_offer"],
            ),
        )
        inserted += cur.rowcount
    conn.commit()
    return inserted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CardSight loader (dry-run unless --commit)")
    parser.add_argument("--all-items", type=Path, default=ROOT / "fixtures" / "cardsight" / "all-items.json")
    parser.add_argument("--catalog-map", type=Path, default=ROOT / "fixtures" / "cardsight" / "catalog-map.json")
    parser.add_argument("--remainder", type=Path, default=ROOT / "fixtures" / "cardsight" / "results-remainder.json")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--sqlite", default="")
    args = parser.parse_args(argv)
    if args.commit and not args.sqlite:
        print("commit requires --sqlite PATH", file=sys.stderr)
        return 2

    catalog = json.loads(args.catalog_map.read_text(encoding="utf-8"))
    rows = load_rows(args.all_items, args.remainder)
    known = set()
    if args.commit:
        conn = sqlite3.connect(args.sqlite)
        try:
            known = existing_keys(conn)
        finally:
            conn.close()

    matched = 0
    unmatched = 0
    duplicates = 0
    prepared = []
    seen = set(known)
    for row in rows:
        key = item_key(row)
        mapped = catalog.get(row["cardsight_id"])
        if mapped:
            matched += 1
            row["card"] = card_row(mapped, row["title"])
        else:
            unmatched += 1
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        prepared.append(row)

    inserted = 0
    if args.commit:
        conn = sqlite3.connect(args.sqlite)
        try:
            conn.executescript(SCHEMA.read_text(encoding="utf-8"))
            inserted = commit_rows(conn, prepared)
        finally:
            conn.close()

    print(f"in={len(rows)}")
    print(f"matched={matched}")
    print(f"unmatched={unmatched}")
    print(f"duplicates={duplicates}")
    print(f"inserted={inserted}")
    print(f"dry_run={str(not args.commit).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
