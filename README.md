# LOFI payout reconciliation

Rebuilds each eBay and Shopify Payments payout into its individual sales, fees, refunds and adjustments. It then works out GST for every sale line from LOFI's stock facts and draft scenarios, and checks that the pieces add up to the actual payout to the cent.

**Milestone 1 is report-only: nothing is posted to QuickBooks.** There is no QuickBooks client in this codebase, and a test fails if one appears. Every scenario is a draft until the accountant signs it off (see "LOFI GST & Accounting Scenarios — for accountant sign-off"), and every payout that uses one is marked **Provisional**.

## How it works

```
eBay Finances + Fulfillment API ─┐
                                 ├─> normalise ─> store sources (D1, idempotent)
Shopify Payments + Orders (GQL) ─┘          │
                                            ▼
                               channel-neutral payout model
                                            │
   stock facts / SKU prefix rules /  ──>  GST rules engine  ──>  reconcile  ──>  report (D1)  ──>  dashboard
   consignors / order facts (D1)            (explains every line)                                 + review queue
```

- `src/channels/`: eBay and Shopify clients. Each converts its own data into one channel-neutral model (`src/types.ts`). Every sale, fee, refund and adjustment keeps its platform source: payout ID, transaction ID and type, order and line-item IDs, raw amount and currency, and timestamp.
- `src/rules/config.ts`: the scenarios (A1–A3, B1–B2, C1–C3) with their sign-off status, the proposed QuickBooks accounts, the GST treatment of each fee type, and the switches for the unresolved eBay International Shipping (C2) and trade-in (A3) treatments.
- `src/rules/engine.ts`: deterministic classification from facts. The precedence is manual override, then destination, then ownership and acquisition facts. Any missing fact goes to review; nothing is guessed. Division 66 is derived from the facts (LOFI-owned, bought from a private seller or as a trade-in, second-hand), never tagged. Every line carries an explanation such as `ownership = LOFI → source_type = private_non_gst_seller → condition = secondhand → A2 → Division 66 candidate`.
- `src/reconcile.ts`: rebuilds the payout to the cent and collects issues. The status is `ready`, `needs_review` or `unbalanced`. A separate `provisional` flag stays on while any treatment used is unsigned-off.
- `src/db.ts`: stock facts, provenance tables, and reports. Re-fetching a payout updates rows keyed on platform IDs instead of adding new ones.
- `src/index.ts`: a daily cron at about 6am Sydney time, plus the dashboard and the fact-correction routes.

### Issues: blocking vs awaiting sign-off

| Kind | Examples | Effect |
|---|---|---|
| Blocking | unknown SKU or stock record, unknown acquisition source, condition, consignor or consignor GST status, unknown destination, unsupported transaction type, dispute, sale that doesn't match its order, payout mismatch, transaction already in another payout | Payout is `needs_review` (or `unbalanced`) and appears in the review queue |
| Awaiting sign-off | scenario not signed off, fee GST treatment pending, foreign-currency policy pending | Payout is marked **Provisional**; staff can't clear it, only the accountant can |

Staff fix blocking issues by recording **facts**, never tax codes. The review queue offers one-click answers, such as ownership (LOFI or consignment), acquisition source, condition, consignor GST registration, and destination for orders without a shipping address. Each answer is saved against the SKU, consignor or order. Every open payout is then rebuilt from stored data without calling the platforms again.

## Setup

```bash
npm install
npx wrangler d1 create lofi-recon          # paste the id into wrangler.toml
npm run db:migrate:remote
npx wrangler secret put SHOPIFY_ADMIN_TOKEN
npx wrangler secret put EBAY_CLIENT_ID      # and EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN
npx wrangler secret put DASHBOARD_TOKEN     # or put the Worker behind Cloudflare Access (preferred)
npm run deploy
```

- **Shopify:** a custom app with `read_orders` and `read_shopify_payments_payouts` (or the broader `read_shopify_payments`). Shopify's docs confirm this scope for balance transactions. Set `SHOPIFY_SHOP` in `wrangler.toml`.
- **eBay:** a developer app and a user refresh token for LOFI's seller account, with `sell.finances` and `sell.fulfillment.readonly`. The code requests exactly these two scopes when refreshing its token.
- Secrets live only in Wrangler secrets or a local `.dev.vars`. Both are git-ignored, along with `.env` files and local databases.

## Try it locally with demo data

```bash
npm run db:migrate:local
npm run demo:sql      # runs the real ingest path over the test fixtures
npm run demo:load
npm run dev           # http://localhost:8787
```

The demo has three payouts. eBay 7001 is ready but provisional. Shopify 9001 needs review because of an unknown SKU and a local-pickup order. eBay 7003 needs review because of an unsupported transaction type.

## Tests

```bash
npm test             # vitest
npm run typecheck    # src (Workers types) and test (Node types)
```

- **Fixtures:** `test/fixtures/` holds an eBay and a Shopify payout. Between them they have multi-line orders, discounts, shipping, an export, consignment, a refund, marketplace, payment, promoted-listing and shipping-label fees, and adjustments. Both reconcile to the cent.
- **Storage tests:** these run the real migrations on an in-memory SQLite database through a small D1 stand-in. They cover idempotent re-import, change detection, cross-payout duplicates and fact corrections.
- **Unsigned-off scenarios:** the tests assert that the result is provisional or held for review. They don't assert that the draft treatment is correct.

## Before trusting the numbers

1. **Run against real payouts and compare with how they were entered by hand.** Neither channel has been run against a live payout. See "Unverified platform assumptions" in HANDOFF.md.
2. **Load stock facts.** Load them item by item through `POST /api/stock`, or with SKU prefix rules for families of stock.
3. **When the accountant signs off a scenario,** set `signedOff: true` in `src/rules/config.ts`. Then update `FEE_TAX`, `EBAY_INTERNATIONAL_SHIPPING_TREATMENT` and `TRADE_IN_TREATMENT`.

## Next milestones

- Post to QuickBooks into channel clearing accounts, once the accountant chooses the posting model.
- Move to Cloudflare Workflows if the per-run payout cap or retries become a real problem.
- Add the PayPal and Afterpay settlement channels.
