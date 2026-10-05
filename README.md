# LOFI payout reconciliation

Rebuilds each eBay and Shopify Payments payout into its individual sales, fees, refunds and adjustments. It then works out GST for every sale line using LOFI's scenarios, and checks that the pieces add up to the bank deposit to the cent.

**Milestone 1 is report-only: nothing is posted to QuickBooks.** Every scenario is a draft until the accountant signs it off (see "LOFI GST & Accounting Scenarios — for accountant sign-off").

## How it works

```
eBay Finances + Fulfillment API ─┐
                                 ├─> normalise ─> GST rules engine ─> reconcile ─> D1 report ─> dashboard
Shopify Payments + Orders (GQL) ─┘                     ▲
                                        stock records / SKU prefix rules / consignors (D1)
```

- `src/channels/`: eBay and Shopify clients. Each converts its own data into one channel-neutral payout model (`src/types.ts`).
- `src/rules/config.ts`: the scenarios (A1–A3, B1–B2, C1–C3) with their sign-off status, the QuickBooks accounts, the GST treatment of each fee type, and the eBay International Shipping decision.
- `src/rules/engine.ts`: deterministic classification. The order of precedence is manual override, then destination (overseas means a C scenario), then ownership and where the item came from. Anything that doesn't match goes to review. The engine also handles Division 66 credits, commission splits, shipping (D2) and refund reversal (D3).
- `src/reconcile.ts`: checks the payout to the cent. The status is `ready`, `needs_review` or `unbalanced`.
- `src/index.ts`: a daily cron at 6am Sydney, plus the dashboard (payouts, payout detail, review queue, stock and consignor intake, `POST /api/stock` for bulk loading).

## Setup

```bash
npm install
npx wrangler d1 create lofi-recon          # paste the id into wrangler.toml
npm run db:migrate:remote
npx wrangler secret put SHOPIFY_ADMIN_TOKEN
npx wrangler secret put EBAY_CLIENT_ID      # and EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN
npx wrangler secret put DASHBOARD_TOKEN     # or put the Worker behind Cloudflare Access
npm run deploy
```

- **Shopify:** you need a custom app with `read_orders` and Shopify Payments payouts read access. Set `SHOPIFY_SHOP` in `wrangler.toml`.
- **eBay:** you need a developer app and a user refresh token for LOFI's seller account, with the scopes `sell.finances` and `sell.fulfillment.readonly`.

## Try it locally with demo data

```bash
npm run db:migrate:local
npx vite-node scripts/demo-sql.ts > .wrangler/demo.sql
npx wrangler d1 execute lofi-recon --local --file .wrangler/demo.sql
npm run dev        # http://localhost:8787
```

## Tests

`npm test` covers every scenario, the cents-exact reconciliation, and normalisation for both channels. The Shopify fixtures use the shape of real LOFI orders.

## Before trusting the numbers

1. **Run against a few real payouts and compare with how they were entered by hand.** The eBay field mapping follows eBay's published types, but it hasn't been run against a live payout yet. Any mismatch shows up as a warning and an unbalanced payout.
2. **Load stock records.** You can do this item by item, or with SKU prefix rules for families of stock (for example, adapters you buy in).
3. **When the accountant signs off a scenario,** set `signedOff: true` in `src/rules/config.ts`. Also update `FEE_TAX` and `EBAY_INTERNATIONAL_SHIPPING_TREATMENT`.

## Next milestones

- Post to QuickBooks: Sales Receipts into channel clearing accounts, and the payout as a transfer to the bank.
- Move to Cloudflare Workflows for retries, and to lift the per-run payout cap.
- Add the PayPal and Afterpay settlement channels.
