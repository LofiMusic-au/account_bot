-- Review-queue facts that persist across re-imports.

-- A marketplace listing with no SKU, linked by staff to the real stock SKU
-- (e.g. EBAY-ITEM-123 -> L-zn41902-170926). Applied on every rebuild.
CREATE TABLE listing_sku_map (
  channel     TEXT NOT NULL,
  listing_key TEXT NOT NULL,                  -- the key the line had, e.g. EBAY-ITEM-123
  sku         TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, listing_key)
);

-- Destination questions staff couldn't answer, referred for manual review.
ALTER TABLE order_facts ADD COLUMN referred INTEGER NOT NULL DEFAULT 0;
