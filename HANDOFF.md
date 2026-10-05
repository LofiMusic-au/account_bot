# Project handoff: LOFI payout reconciliation (`account_bot`)

Handoff date: 5 October 2026. Written at the end of the Cowork session that designed and built milestone 1, so work can continue in Claude Code.

---

## 1. The problem

LOFI Music (lofimusic.com.au) sells new and second-hand music gear through eBay, Shopify and Reverb, including consignment stock. The books are kept in QuickBooks Online (QBO, Australian company, GST).

Today, every eBay or Shopify payout lands in QBO as one lump-sum bank-feed line. Staff then work through it by hand:

1. Work out which sales are inside the payout.
2. Split it into those sales.
3. Fix the GST on each one, because the right treatment differs by sale:
   - consignment: GST only on LOFI's commission
   - second-hand stock: Division 66
   - exports: GST-free
4. Reconcile the bank feed.

The PayPal and eBay connectors in QBO can't apply per-sale GST rules, and their entries can't be edited.

**Goal:** stop staff touching normal payouts. The system rebuilds each payout from the platform APIs, applies LOFI's GST rules deterministically, and posts correct entries to QBO. The bank feed then only confirms the deposit, and people review the exceptions only.

---

## 2. Decisions already made (don't relitigate without asking)

| Decision | Choice | Why |
|---|---|---|
| Stack | TypeScript on Cloudflare Workers + D1. Workflows later. | LOFI's other apps already run on Cloudflare. |
| AI in the tax path | **None.** The rules engine is plain deterministic code. | Must be auditable. Unknown cases go to a review queue and are never guessed. |
| Channels, milestone 1 | eBay + Shopify Payments | Together they're most of the manual workload. |
| Milestone 1 scope | **Report-only.** Nothing is posted to QBO. | Lets staff compare against their manual entries for a month or two. |
| QBO posting model (milestone 2) | Each sale goes into a **channel clearing account** (eBay Clearing, Shopify Payments Clearing). Fees go against the same account. **Each payout is one transfer from the clearing account to the bank.** | The bank-feed line then matches one existing transaction. |
| Sale-level transactions | Lean to **Sales Receipts per sale**, not one journal per payout. | Keeps sale-level GST and audit trail. Accountant to confirm (blocker 5). |
| Tax classification lives on the item | Each stock item / SKU carries ownership, source and consignor. | The same item gets the same treatment on any channel. |
| Existing QBO PayPal/eBay connectors | Switch off when posting goes live. | Avoids double-counting. |
| Money | Integer cents everywhere (`src/money.ts`) | — |

---

## 3. The GST scenarios and their sign-off status

The full brief for the accountant is a Claude Doc: **"LOFI GST & Accounting Scenarios — for accountant sign-off"**, https://claude.ai/code/artifact/843f8a98-9038-4901-abf3-6f61e814de57.

The scenarios are encoded in `src/rules/config.ts`. **All are `signedOff: false`.**

| Code | Scenario | Working treatment |
|---|---|---|
| A1 | Owned stock from a GST-registered supplier, sold in Australia | GST = 1/11 of the price |
| A2 | Second-hand item bought from a private seller | Full GST on the sale. A Division 66 notional input tax credit of 1/11 of the purchase price applies. Over $300, it's claimed at resale and capped at the GST on the sale; $300 or under, it's claimed at purchase. |
| A3 | Trade-in, resold | As A2. The trade-in is recorded as a purchase. |
| B1 | Consignment, consignor not GST-registered, LOFI acting as agent | Proceeds to Consignor Payable with no GST. Commission is income with GST at 1/11. |
| B2_AGENCY | Consignment, registered consignor, ordinary agency | Same split as B1. The consignor reports the GST on the sale. |
| B2_153B | Consignment, registered consignor, Subdivision 153-B | LOFI reports GST on the full sale. The consignor's supply to LOFI is recorded as a bill. |
| C1 | LOFI ships overseas itself | GST-free export (normally within 60 days, with evidence kept) |
| C2 | Sold through eBay International Shipping (EIS) | **Unresolved.** Always goes to review (`EBAY_INTERNATIONAL_SHIPPING_TREATMENT = "UNRESOLVED"`). |
| C3 | Consigned item exported | Proceeds to the consignor. Commission is still taxable. |
| C4 | Foreign currency | GST uses **one approved conversion rate and day**, not the payout AUD. The settlement difference goes to FX gain/loss and is **not** a GST adjustment. *Not implemented yet:* the code uses the platform's AUD amount and flags it. |
| D1 | Fees | GST treatment per fee type, in the `FEE_TAX` map. All `PENDING`. |
| D2 | Shipping | Follows the item. Shipping on consignment sales is assumed to be LOFI income (pending). |
| D3 | Refunds | Reversed using the original sale's scenario |
| D4 | Order-level discounts | Shared in proportion across lines (largest-remainder method) |
| D5 | Anything unmatched | Review queue |

**Rule precedence:** manual override on the item, then destination (overseas means a C scenario), then ownership and source (A or B), then review.

**The five pre-build blockers the accountant must answer.** Everything else can be settled while milestone 1 runs report-only.

1. Division 66: eligibility, timing, records, and how to post it in QBO.
2. Consignment model: agency or 153-B, checked against LOFI's actual consignment agreement.
3. EIS exports: GST-free or taxable.
4. Foreign-currency policy: the approved conversion rate and day.
5. QBO posting model: Sales Receipts or journals, and how the clearing-account entries should look.

When a scenario is signed off, set `signedOff: true` (plus `signedOffBy` and `signedOffOn`) in `src/rules/config.ts`.

---

## 4. What's built (milestone 1, commit `3f2fb4d`)

```
src/
  index.ts            Worker: cron (daily, 20:00 UTC ≈ 6–7am Sydney) + dashboard routes + JSON intake API
  types.ts            Channel-neutral model: NormalisedPayout, OrderSale, SaleLine, Refund, Fee, Adjustment, StockItem, LineClassification
  money.ts            toCents, fmt, gstInclusive (1/11), allocate (largest remainder)
  reconcile.ts        buildReport(): classify all lines, totals by scenario, cents-exact payout check -> status ready | needs_review | unbalanced
  db.ts               D1: makeResolver (item record > longest SKU prefix rule), loadResolver, save/list/get reports, stock + consignor upserts, validation
  ui.ts               Server-rendered HTML (light/dark): payouts list, payout detail, review queue, stock/consignor forms
  rules/config.ts     Scenarios + sign-off flags, accounts, FEE_TAX, EIS decision, Div 66 threshold
  rules/engine.ts     classifyLine / classifyShipping / classifyOrder / rescaleOrder / commissionFor / div66Credit
  channels/shopify.ts Admin GraphQL: payouts, balance transactions per payout, orders -> NormalisedPayout
  channels/ebay.ts    OAuth refresh, Finances API (payouts, transactions by payoutId), Fulfillment getOrder -> NormalisedPayout
migrations/0001_init.sql  consignors, stock_items, sku_prefix_rules, payout_reports
scripts/demo-sql.ts       Builds demo data from real LOFI order shapes for local D1
test/                     32 vitest tests (all passing): every scenario, Div 66 cap/threshold, commission override, precedence, shipping, refunds, both normalisers, reconciliation
```

**Dashboard routes:**

- `GET /`: list of payouts
- `POST /run`: fetch new payouts
- `GET /payout/:channel/:id`: payout detail
- `POST /payout/:channel/:id/rerun`: rebuild a payout
- `GET /review`: review queue
- `GET /stock/new`: stock form
- `POST /stock`, `POST /consignors`: save stock records and consignors
- `POST /api/stock`: bulk JSON intake. Validates everything first and rejects the whole batch on any error.

**Auth:** set the `DASHBOARD_TOKEN` secret (visit `?token=…` once to get a cookie), or put the Worker behind Cloudflare Access (preferred).

**Verified:**

- `tsc --noEmit` is clean.
- All 32 tests pass.
- `wrangler dev --local` was run with demo data. Every route returned 200/303, and the report page rendered correctly. On the demo payout ($2,491.84): $0.00 difference, GST $139.49, Division 66 credit $54.55, and the C1 export and B1 consignment split were correct.

---

## 5. What's verified vs assumed about the platform APIs

### Shopify (store "LOFI Music", AUD, `taxesIncluded: true`)

- All three GraphQL queries in `channels/shopify.ts` were **validated against Shopify's live Admin schema**.
- Real orders show gateways `shopify_payments` and `Afterpay`, with `sourceName: "web"`. Shopify charges 10% GST on every line and on shipping, including consignment items. That is the core error the system corrects. Example: order #3252, Korg Wavestation, $854.05. Shopify GST is $77.64; at 25% commission under B1 it should be $19.41.
- **Not verified on live data:** the Shopify connection used in Cowork lacked the `read_shopify_payments` scopes, so no live payout or balance transaction has been read. Assumptions to check on the first real payout:
  - The balance-transaction filter `payments_transfer_id:<payout legacyResourceId>` returns that payout's transactions.
  - `hideTransfers: true` excludes the payout line itself.
  - Refund `fee` handling.
  - Treating `SHIPPING_*` types as fees.
- Required scopes for the custom app: `read_orders`, `read_shopify_payments` (payouts and balance transactions), and possibly `read_shopify_payments_accounts`.
- Afterpay (and PayPal) orders **don't** settle through Shopify Payments, so they won't appear. They need their own settlement channel later.

### eBay

- No developer app exists yet. LOFI needs one, plus a user refresh token with the scopes `sell.finances` and `sell.fulfillment.readonly`.
- Field names follow eBay's published types (Transaction, Order, LineItem, FulfillmentStartInstruction, Program).
- **Unverified assumptions:**
  - The Finances host is `https://apiz.ebay.com/sell/finances/v1`, and the header `X-EBAY-C-MARKETPLACE-ID: EBAY_AU` is required.
  - The transaction filter is `filter=payoutId:{ID}` with `limit` up to 1000.
  - For a SALE, `amount` is **net of fees**, so the code uses gross = signed amount + `totalFeeAmount`. Check this first; if it's wrong, every eBay payout will show up as unbalanced.
  - EIS is detected by `order.program.ebayInternationalShipping`, or by `fulfillmentStartInstructions[0].ebaySupportedFulfillment === true` with a non-AU destination. The final destination comes from `finalDestinationAddress.countryCode`.
  - Order line amounts come from `discountedLineItemCost ?? lineItemCost`, and shipping from `deliveryCost.shippingCost`.
- Every mismatch shows as a warning plus an `unbalanced` status, never a silent error.

---

## 6. LOFI's SKU conventions (open question)

From about 500 of the 2,927 Shopify variants (the newest 250 and the oldest 250): current listings use **`PREFIX-serial-DDMMYY`**, where DDMMYY is the listing date.

- **Prefixes seen:** `L-` (most common), `RM-`, `MR-`, `TT-` / `TT-BOX62-`, `P27-` to `P44-` (numbered), `G50-` (blank cassettes), `RC-`, `LC-`, `RT-`, `MC-`, `A-`.
- **Generic stock without a prefix:** e.g. `ADAPT-GEN-02`, `240/100_Stepdown`, `Cable-Patch30`.
- **Older SKUs:** brand-model-date with no prefix, e.g. `Rol-JD800-71122`.
- **Embedded references:** some SKUs contain `INS_220630_00038` or `AUD_220620_00037`. These look like purchase or auction references.

**Waiting on Luke:** what each prefix means for ownership and GST, whether each `P##` number is a consignor or a purchase lot, and what the `INS_`/`AUD_` references are. Once known, load the `sku_prefix_rules` and `consignors` tables. Longest prefix wins, matching is case-insensitive, and an individual `stock_items` row always beats a prefix rule. **Don't guess the meanings.**

---

## 7. Next steps, in order

1. **Push to GitHub:** `LofiMusic-au/account_bot`. It's public and empty. Cowork couldn't push because of a session permissions issue.
2. **Get the SKU prefix meanings from Luke** and seed `sku_prefix_rules` and `consignors`. A seed migration or `scripts/seed-prefixes.ts` works.
3. **Deploy:**
   - `wrangler d1 create lofi-recon`, then put the id in `wrangler.toml`.
   - Set `SHOPIFY_SHOP` in `wrangler.toml`.
   - Run the remote migrations.
   - Set the secrets (`SHOPIFY_ADMIN_TOKEN`, `DASHBOARD_TOKEN`, and the eBay ones when available).
   - `npm run deploy`.
   - Put the Worker behind Cloudflare Access.
4. **Run against real Shopify payouts** and compare with how staff entered them in QBO. Fix the normaliser assumptions in §5.
5. **eBay:** create the developer app, get the refresh token, run against real payouts, and check the gross = net + fees assumption first.
6. **Stock data:** bulk-load from LOFI's legacy stock/repair sheet through `POST /api/stock`. Division 66 fields matter for private-seller items: seller name and address, description and quantity, date, and price.
7. **Hardening:**
   - Move per-payout processing to **Cloudflare Workflows**, which removes the `MAX_PAYOUTS_PER_RUN = 6` cap and gives retries.
   - Cache eBay `getOrder` results.
   - The cron is UTC (`0 20 * * *`), so it drifts an hour across Sydney's daylight-saving changes. That's acceptable.
8. **After accountant sign-off:**
   - Flip `signedOff`, set `FEE_TAX` and the EIS treatment.
   - Implement the C4 FX policy: store the buyer-currency amount and the approved rate, and post the difference to FX Gain/Loss.
9. **Milestone 2: QBO posting.**
   - Intuit app (LOFI has one), OAuth.
   - Map `ACCOUNTS` and tax codes to the real QBO chart of accounts and AU tax codes.
   - Create Sales Receipts per sale against the clearing account, fees as expenses, and the payout as a Transfer.
   - Use idempotency keys (channel + payout + line).
   - Post only when the payout is `ready` **and** every scenario used is signed off.
   - Add an approve button.
   - Add a "posted" state to D1.
10. **More channels:** PayPal settlement, Afterpay, Reverb.

### Known rough edges

- **Shipping scenario label:** a shipping line takes the first item line's scenario code, so shipping adds to that scenario's count in the "By scenario" table. A separate `SHIP` pseudo-scenario would be clearer.
- **Refund fee handling:** Shopify's refund fee and eBay's fee credits on refunds are recorded simply. Verify them on real data.
- **Bulk intake errors:** `POST /api/stock` rejects the whole batch if any row is invalid. That's intentional.

---

## 8. Running it

```bash
npm install
npm test                      # 32 tests
npm run typecheck
npm run db:migrate:local
npx vite-node scripts/demo-sql.ts > .wrangler/demo.sql
npx wrangler d1 execute lofi-recon --local --file .wrangler/demo.sql
npm run dev                   # http://localhost:8787
```

---

## 9. Suggested first prompt for Claude Code

> Read HANDOFF.md and CLAUDE.md. Push this repo to LofiMusic-au/account_bot (main). Then help me deploy milestone 1 to Cloudflare and run it against my real Shopify payouts — I'll provide the tokens. I'll also tell you what my SKU prefixes mean so you can seed the prefix rules.
