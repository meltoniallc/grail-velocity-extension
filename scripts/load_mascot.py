#!/usr/bin/env python3
"""Read-only Mascot SKU-mapping CSV stub. Never writes."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = [
    "mascot_item_id",
    "sku",
    "shopify_product_id",
    "shopify_variant_id",
    "cardsight_id",
    "checklist_slug",
]


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if "--commit" in argv:
        print("mascot loader is read-only", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(description="Read a Mascot SKU map. Does not write.")
    parser.add_argument("--csv", type=Path, default=ROOT / "fixtures" / "mascot" / "sku-map.csv")
    args = parser.parse_args(argv)
    with args.csv.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = [name for name in COLUMNS if reader.fieldnames is None or name not in reader.fieldnames]
        if missing:
            print("missing columns: " + ", ".join(missing), file=sys.stderr)
            return 2
        rows = list(reader)
    mapped = 0
    missing_sku = 0
    for row in rows:
        if (row.get("sku") or "").strip() and (row.get("mascot_item_id") or "").strip():
            mapped += 1
        else:
            missing_sku += 1
    print(f"in={len(rows)}")
    print(f"mapped={mapped}")
    print(f"missing_sku={missing_sku}")
    print("dry_run=true")
    print("read_only=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
