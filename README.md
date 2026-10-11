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

Staff fix blocking issues by recording **facts**, never tax codes. The review queue is a fact-correction console:

- **Summary:** counts of payouts (ready, needs review, unbalanced) and problems by group. The groups are facts to record, integration problems, and items for the accountant.
- **One row per SKU:** an inline form records ownership, acquisition source, condition, purchase price, consignor and commission in one save. It is prefilled from the current record or prefix rule.
- **Prefix rules:** the same form can create a **SKU prefix rule**, such as everything starting with `L-`. Safety checks:
  - The prefix must be at least 2 characters and the start of that SKU.
  - An existing rule is never overwritten without ticking "replace".
  - Rules never set purchase prices.
  - An item's own record always wins over a rule.
- **No SKU on eBay:** the line is keyed on its listing ID (`EBAY-ITEM-<id>`). Staff can either **link the listing to a known stock SKU**, which persists across re-imports, or record its facts directly.
- **Destination unknown:** answer Australia, overseas (with a country), or **"Not sure: refer for review"**, which moves it to the accountant group. Nothing is assumed from a missing address.
- **Ready feedback:** rows that are the only blocker for a payout say so ("Fixing this makes 1 payout ready"). After each save, the message lists which payouts became ready.
- **Other one-click answers:** destination, consignor Australian GST registration, and agency or 153-B.

## Historical accounting baseline

This is how LOFI accounts for marketplace payouts today. The system reproduces it first, and improves on it only after the accountant signs off.

**Stage 1: payout split (done by hand in QuickBooks until now).** A payout arrives in the bank feed. Staff open the marketplace's payout breakdown, split the bank line into its parts, and give each part a chart-of-accounts category:

| Component | Historical account | Logical category |
|---|---|---|
| LOFI-owned sale in Australia | Sales - GST | `SALES_DOMESTIC_GST` |
| LOFI-owned sale overseas | Overseas Sales - No GST | `SALES_OVERSEAS_NO_GST` |
| Consignment sale (full amount) | consignment sales, no GST | `CONSIGNMENT_SALES_NO_GST` (the split is worked out in the stage 2 ledger) |
| eBay / Shopify fees | eBay Fees - No GST, etc. | `EBAY_FEES` / `SHOPIFY_FEES` |
| Refunds | reverse the original | `REFUND` (records the category it reverses) |

**Stage 2: consignment ledger (Jess's hand-kept spreadsheet, still the source of truth).** Each consigned item sold is a row with these columns:
- Sale
- actual Postage
- marketplace Fees
- Repairs
- = NET, then split between the parties by that consignor's arrangement, for example 65/25/10, 65/25/5/5, 75/20/5 or 50/50
- a BAS column for GST

**What the system does:**
- **Stage 1:** `src/accounting/baseline.ts` gives every payout line a logical category using **one ordered rules table** (`PAYOUT_CLASSIFICATION_RULES`, R1–R6, shown on the Rules page). The table looks at ownership and destination only. Fees map through the configured `FEE_CATEGORY_MAP`. Each line records the rule that decided it, and its Division 66 status ("not assessed" unless acquisition facts exist). Missing facts give `UNCLASSIFIED`, never a guess. The split always adds up to the payout.
- **Stage 2 (shadow only):** `src/accounting/consignment.ts` builds a shadow copy of Jess's ledger from the same sales, so nothing is re-keyed. It uses the `consignment_entries` table and the Consignments page:
  - **Sale:** the item price after discounts, plus the shipping the buyer paid (each rule can switch this off).
  - **Fees:** marketplace and payment fees come in automatically.
  - **Postage:** the platform shipping-label cost when there is one, or entered by hand.
  - **Repairs and other agreed costs:** entered by hand.
  - **NET:** the sale less whichever costs the item's **settlement rule** deducts.
  - **Shares:** NET is shared between the rule's parties (one consignor, LOFI, and any other partners). Fixed amounts come off first, then percentages, always adding up to NET exactly.
  - **Audit:** every component and party share is stored per sale.
  - **Monthly view:** a draft settlement per month and consignor.
- **QuickBooks:** categories are logical codes, mapped to QuickBooks account IDs in milestone 2. Nothing is posted yet.

**Consignment module status: SHADOW MODE.** Jess's manual consignment ledger stays the operational source of truth. The module in this repo is a prototype that runs alongside it, fed from the same normalised sales as the payout reconciler. Its figures are provisional and non-authoritative:
- no real consignor payouts
- no QuickBooks consignment or GST journals
- no authoritative liability balances
- no payment automation
- no replacement of the spreadsheet workflow

This phase exists to show the module can reproduce Jess's ledger over several real months before any cutover. The payout reconciler remains the primary build.

**Still open in the shadow ledger:**
- **BAS / GST on LOFI's share is not assumed.** Each rule's BAS treatment starts as "unconfirmed", with no figure, until LOFI and the accountant confirm what Jess's BAS column means for that arrangement.
- **Not yet compared with Jess's ledger.** Run it against several real months before trusting it. Jess's ledger stays authoritative.
- **No integrations yet.** There is no Australia Post or repair-system feed. Postage and repairs are entered by hand.

**This baseline is LOFI's current operational treatment, not an accountant-approved one.** The draft GST scenarios in `src/rules/` and their sign-off remain authoritative for any change. Both run side by side. Each payout shows the historical split and the draft-scenario classification.

**Design principles:**
- *A balanced payout is necessary but not sufficient for accounting correctness.* Every line also needs its facts and an approved recipe.
- *The reconciliation engine stores facts and source transactions. Accounting recipes may change after accountant sign-off without the source data being rebuilt.* Changing a consignor's rule recalculates unposted ledger entries and never touches source sales. Posted entries are frozen.

**Ownership convention:** SKUs beginning `L-` are LOFI-owned. That sets ownership only. The acquisition source, condition and price must still be recorded before a GST scenario (A1/A2/A3) is derived. `LC-` and other L-letter prefixes aren't covered until their meaning is confirmed.

## Setup

```bash
npm install
npx wrangler d1 create lofi-recon          # paste the id into wrangler.toml
npm run db:migrate:remote
npx wrangler secret put SHOPIFY_CLIENT_ID     # and SHOPIFY_CLIENT_SECRET (Dev Dashboard app)
npx wrangler secret put EBAY_CLIENT_ID      # and EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN
npx wrangler secret put DASHBOARD_TOKEN     # or put the Worker behind Cloudflare Access (preferred)
npm run deploy
```

- **Shopify:** an app created in Shopify's Dev Dashboard and installed on the store, with `read_orders`, `read_shopify_payments_payouts` and `read_shopify_payments_accounts`. The Worker swaps its client ID and secret for a 24-hour token (client credentials grant). An older admin-created app's `shpat_` token still works through `SHOPIFY_ADMIN_TOKEN`. The Admin API version is pinned to `2026-10` in `wrangler.toml`.
- **eBay:** a developer app and a user refresh token for LOFI's seller account, with `sell.finances` and `sell.fulfillment.readonly`. The code requests exactly these two scopes when refreshing its token. The existing token in the Migrator project reads Finances but is rejected by the Fulfillment API.
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

**Compare against real bookkeeping first.** See `docs/baseline-comparison.md`. Download each payout's split as CSV and compare it line by line with the QuickBooks split staff made. Log every mismatch by type.


1. **Run against real payouts and compare with how they were entered by hand.**
   - Five live eBay payouts reconcile to the cent. See `docs/live-validation-2026-10.md`.
   - eBay order details still need a token with Fulfillment access.
   - Shopify Payments hasn't been read live yet, because no available token has the payments scope.
   - Use `npm run live:validate -- ebay|shopify --scan`, then pass a payout ID. It is read-only and writes to the git-ignored `.live/` folder.
2. **Load stock facts.** Load them item by item through `POST /api/stock`, or with SKU prefix rules for families of stock.
3. **When the accountant signs off a scenario,** set `signedOff: true` in `src/rules/config.ts`. Then update `FEE_TAX`, `EBAY_INTERNATIONAL_SHIPPING_TREATMENT` and `TRADE_IN_TREATMENT`.

## Next milestones

- Post to QuickBooks into channel clearing accounts, once the accountant chooses the posting model.
- Move to Cloudflare Workflows if the per-run payout cap or retries become a real problem.
- Add the PayPal and Afterpay settlement channels.
