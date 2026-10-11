// Shared test helpers: fixture loading, a stock resolver for the fixtures, and
// a D1 stand-in over node:sqlite with the real migrations applied.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { normaliseEbayPayout, type EbayOrder, type EbayPayout, type EbayTransaction } from "../src/channels/ebay";
import { normaliseShopifyPayout, type ShopifyBalanceTxn, type ShopifyOrder, type ShopifyPayout } from "../src/channels/shopify";
import { makeResolver, type ConsignorRow, type PrefixRow, type StockRow } from "../src/db";

const root = join(import.meta.dirname, "..");
// Vite rewrites "node:sqlite" to "sqlite"; load it through Node's own require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncT;

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(root, "test/fixtures", name), "utf8")) as T;
}

export interface EbayFixture {
  payout: EbayPayout;
  transactions: EbayTransaction[];
  orders: EbayOrder[];
}
export interface ShopifyFixture {
  payout: ShopifyPayout;
  transactions: ShopifyBalanceTxn[];
  orders: ShopifyOrder[];
}

export function ebayFixture(mutate?: (f: EbayFixture) => void) {
  const f = loadFixture<EbayFixture>("ebay-payout.json");
  mutate?.(f);
  return normaliseEbayPayout(f.payout, f.transactions, new Map(f.orders.map((o) => [o.orderId, o])));
}

export function shopifyFixture(mutate?: (f: ShopifyFixture) => void) {
  const f = loadFixture<ShopifyFixture>("shopify-payout.json");
  mutate?.(f);
  return normaliseShopifyPayout(f.payout, f.transactions, new Map(f.orders.map((o) => [o.id, o])));
}

const stock = (sku: string, over: Partial<StockRow>): StockRow => ({
  sku,
  title: null,
  ownership: "owned",
  acquired_from: null,
  item_condition: null,
  purchase_cents: null,
  purchase_date: null,
  seller_name: null,
  seller_address: null,
  seller_description: null,
  consignor_id: null,
  commission_type: null,
  commission_value: null,
  override_scenario: null,
  ...over,
});
const div66Record = { seller_name: "P. Seller", seller_address: "1 Example St", seller_description: "1 x unit", purchase_date: "2026-08-01" };

/** Facts for every SKU in the two fixtures. */
export const FIXTURE_STOCK: StockRow[] = [
  stock("L-500-A", { acquired_from: "registered_supplier", item_condition: "new" }),
  stock("L-300-B", { acquired_from: "private_seller", item_condition: "secondhand", purchase_cents: 12000, ...div66Record }),
  stock("L-NZ-1", { acquired_from: "registered_supplier", item_condition: "new" }),
  stock("RM-CONS-1", { ownership: "consignment", consignor_id: 1 }),
  stock("L-REF-1", { acquired_from: "private_seller", item_condition: "secondhand", purchase_cents: 40000, ...div66Record }),
  stock("240/100_Stepdown", { acquired_from: "registered_supplier", item_condition: "new" }),
  stock("RM-256549-001196-140526", { ownership: "consignment", consignor_id: 1 }),
  stock("L-DISC-1", { acquired_from: "registered_supplier", item_condition: "new" }),
  stock("L-NZ-2", { acquired_from: "private_seller", item_condition: "secondhand", purchase_cents: 35000, ...div66Record }),
  stock("L-mk3-0010230-300726", { acquired_from: "private_seller", item_condition: "secondhand", purchase_cents: 60000, ...div66Record }),
];
export const FIXTURE_CONSIGNORS: ConsignorRow[] = [
  { id: 1, name: "Private consignor", gst_registered: 0, gst_status: "not_registered", commission_type: "percent", commission_value: 25, agreement_type: "agency" },
];
export const FIXTURE_PREFIXES: PrefixRow[] = [];
export const fixtureResolver = () => makeResolver(FIXTURE_STOCK, FIXTURE_PREFIXES, FIXTURE_CONSIGNORS);

/** The subset of D1 this codebase uses, over an in-memory SQLite with every migration applied. */
export function makeTestD1(): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(root, "migrations");
  for (const f of readdirSync(dir).filter((x: string) => x.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  type P = (string | number | null)[];
  const stmt = (sql: string, params: P = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p as P),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[], success: true }),
    first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    run: async () => {
      sqlite.prepare(sql).run(...params);
      return { success: true };
    },
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, sqlite };
}

/** Load the fixture facts into a test database. */
export function seedFixtureFacts(sqlite: DatabaseSync) {
  for (const c of FIXTURE_CONSIGNORS) {
    sqlite
      .prepare("INSERT INTO consignors (id, name, gst_registered, gst_status, commission_type, commission_value, agreement_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.name, c.gst_registered, c.gst_status ?? null, c.commission_type, c.commission_value, c.agreement_type);
  }
  for (const s of FIXTURE_STOCK) {
    sqlite
      .prepare(
        `INSERT INTO stock_items (sku, ownership, acquired_from, item_condition, purchase_cents, purchase_date, seller_name, seller_address, seller_description, consignor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.sku, s.ownership, s.acquired_from, s.item_condition ?? null, s.purchase_cents, s.purchase_date, s.seller_name, s.seller_address, s.seller_description, s.consignor_id);
  }
}
