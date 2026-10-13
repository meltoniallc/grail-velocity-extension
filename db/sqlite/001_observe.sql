CREATE TABLE IF NOT EXISTS cards (
  card_id TEXT PRIMARY KEY,
  year TEXT,
  set_name TEXT,
  parallel TEXT,
  player TEXT,
  card_no TEXT,
  serial_denom TEXT,
  is_auto INTEGER NOT NULL DEFAULT 0,
  is_rookie INTEGER NOT NULL DEFAULT 0,
  grade_co TEXT,
  grade TEXT,
  canonical_title TEXT,
  is_print_to_order INTEGER NOT NULL DEFAULT 0,
  identity_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  item_id TEXT,
  url TEXT,
  page_type TEXT,
  status TEXT,
  price REAL,
  shipping REAL,
  currency TEXT,
  sold_date TEXT,
  captured_at TEXT,
  title TEXT,
  specifics TEXT,
  image_urls TEXT,
  seller_hash TEXT,
  feedback_bucket TEXT,
  own_sale INTEGER NOT NULL DEFAULT 0,
  own_seller_id TEXT,
  parser_ver TEXT,
  extension_version TEXT,
  raw_hash TEXT NOT NULL UNIQUE,
  card_id TEXT,
  match_score REAL,
  condition TEXT,
  buying_format TEXT,
  grade_co TEXT,
  grade TEXT,
  cert TEXT,
  serial TEXT,
  is_auto INTEGER NOT NULL DEFAULT 0,
  is_rookie INTEGER NOT NULL DEFAULT 0,
  parallel TEXT,
  set_name TEXT,
  year TEXT,
  player TEXT,
  card_no TEXT
);

CREATE INDEX IF NOT EXISTS observations_item_idx ON observations (site, item_id);

CREATE TABLE IF NOT EXISTS comps (
  comp_id INTEGER PRIMARY KEY,
  card_id TEXT,
  observation_id INTEGER,
  external_ref TEXT,
  source TEXT NOT NULL,
  item_id TEXT,
  sold_price REAL,
  sold_date TEXT,
  accepted_offer INTEGER NOT NULL DEFAULT 0,
  confidence REAL,
  included INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  UNIQUE (source, item_id)
);

CREATE TABLE IF NOT EXISTS sku_mappings (
  id INTEGER PRIMARY KEY,
  card_id TEXT,
  mascot_item_id TEXT,
  sku TEXT,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  cardsight_id TEXT UNIQUE,
  checklist_slug TEXT,
  UNIQUE (mascot_item_id)
);
