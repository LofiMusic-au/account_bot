// Prints SQL that loads demo data into the local D1 database, so the
// dashboard can be tried before any API credentials are set up:
//   npm run db:migrate:local
//   npm run demo:sql
//   npm run demo:load
//
// It runs the real ingest path (normalise -> store sources -> classify ->
// reconcile) over the test fixtures in an in-memory database, then dumps the
// tables as INSERT statements. Three payouts are produced:
//   - eBay 7001: ready, provisional
//   - Shopify 9001: needs review (an unknown SKU and a local-pickup order)
//   - eBay 7003: needs review (an unsupported transaction type)
import { ingestAndReport } from "../src/index";
import { ebayFixture, makeTestD1, seedFixtureFacts, shopifyFixture } from "../test/helpers";

const { d1, sqlite } = makeTestD1();
seedFixtureFacts(sqlite);
sqlite.prepare("DELETE FROM stock_items WHERE sku = 'L-DISC-1'").run();

await ingestAndReport(d1, ebayFixture());
await ingestAndReport(d1, shopifyFixture((f) => void (f.orders[2]!.shippingAddress = null)));
await ingestAndReport(
  d1,
  ebayFixture((f) => {
    f.payout.payoutId = "7003";
    f.payout.payoutDate = "2026-10-09T03:00:00.000Z";
    f.transactions = [
      { ...f.transactions[0]!, transactionId: "26-00005-00005", orderId: "26-00005-00005" },
      {
        transactionId: "LR-1",
        transactionType: "LOAN_REPAYMENT",
        transactionDate: "2026-10-08T08:00:00.000Z",
        bookingEntry: "DEBIT",
        amount: { value: "10.00", currency: "AUD" },
      },
    ];
    f.orders = [{ ...f.orders[0]!, orderId: "26-00005-00005" }];
    f.payout.amount.value = "726.88";
  }),
);

const q = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const out: string[] = [];
for (const table of ["consignors", "stock_items", "sku_prefix_rules", "order_facts", "source_payouts", "source_transactions", "source_orders", "payout_reports"]) {
  for (const row of sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
    const cols = Object.keys(row);
    out.push(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => q(row[c])).join(", ")});`);
  }
}
console.log(out.join("\n"));
