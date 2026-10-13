CREATE TABLE IF NOT EXISTS cards (
  card_id TEXT PRIMARY KEY,
  year TEXT,
  set_name TEXT,
  parallel TEXT,
  player TEXT,
  card_no TEXT,
  serial_denom TEXT,
  is_auto BOOLEAN NOT NULL DEFAULT FALSE,
  is_rookie BOOLEAN NOT NULL DEFAULT FALSE,
  grade_co TEXT,
  grade TEXT,
  canonical_title TEXT,
  is_print_to_order BOOLEAN NOT NULL DEFAULT FALSE,
  identity_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  item_id TEXT,
  url TEXT,
  page_type TEXT NOT NULL,
  status TEXT,
  price NUMERIC(12, 2),
  shipping NUMERIC(12, 2),
  currency TEXT,
  sold_date TEXT,
  captured_at TIMESTAMPTZ,
  title TEXT,
  specifics JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_urls TEXT[] NOT NULL DEFAULT '{}',
  seller_hash TEXT,
  feedback_bucket TEXT,
  own_sale BOOLEAN NOT NULL DEFAULT FALSE,
  own_seller_id TEXT,
  parser_ver TEXT,
  extension_version TEXT,
  raw_hash TEXT NOT NULL UNIQUE,
  card_id TEXT REFERENCES cards (card_id),
  match_score NUMERIC(5, 4),
  condition TEXT,
  buying_format TEXT,
  grade_co TEXT,
  grade TEXT,
  cert TEXT,
  serial TEXT,
  is_auto BOOLEAN NOT NULL DEFAULT FALSE,
  is_rookie BOOLEAN NOT NULL DEFAULT FALSE,
  parallel TEXT,
  set_name TEXT,
  year TEXT,
  player TEXT,
  card_no TEXT
);

CREATE INDEX IF NOT EXISTS observations_item_idx ON observations (site, item_id);
CREATE INDEX IF NOT EXISTS observations_captured_idx ON observations (captured_at);

CREATE TABLE IF NOT EXISTS comps (
  comp_id BIGSERIAL PRIMARY KEY,
  card_id TEXT REFERENCES cards (card_id),
  observation_id BIGINT REFERENCES observations (id),
  external_ref TEXT,
  source TEXT NOT NULL CHECK (source IN ('ebay_view', 'browse_api', 'cardsight', 'ledger191', 'own_sale')),
  item_id TEXT,
  sold_price NUMERIC(12, 2),
  sold_date TEXT,
  accepted_offer BOOLEAN NOT NULL DEFAULT FALSE,
  confidence NUMERIC(5, 4),
  included BOOLEAN NOT NULL DEFAULT FALSE,
  exclusion_reason TEXT,
  UNIQUE (source, item_id)
);

CREATE TABLE IF NOT EXISTS sku_mappings (
  id BIGSERIAL PRIMARY KEY,
  card_id TEXT REFERENCES cards (card_id),
  mascot_item_id TEXT,
  sku TEXT,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  cardsight_id TEXT,
  checklist_slug TEXT,
  UNIQUE (cardsight_id),
  UNIQUE (mascot_item_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
