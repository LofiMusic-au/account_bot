# Milestone 2: QuickBooks posting (dry run)

**Status:** built and tested against a fake QuickBooks. **Dry run is the default. No QuickBooks write has ever been made.**

## How a payout is posted

```
payout -> reconciled to $0.00 -> classified (rules R1-R8) -> one journal preview
       -> hard gate -> person approves -> post journal -> verify
       -> post transfer (clearing -> bank) -> verify -> posted
bank feed shows the deposit -> staff press Match on the transfer
```

- **One journal per payout,** dated on the payout date. The DocNumber is `EB-<payout>` or `SP-<payout>`.
- **Sales lines:** credit Sales, Overseas Sales or Commission Sales, with sales and shipping together.
- **Refunds:** debit the same accounts they reverse.
- **Fees:** debit the fee accounts. Fee credits reduce them.
- **Adjustments:** recognised adjustments go to Marketplace Adjustments.
- **Clearing:** debit the channel clearing account with the exact net payout.
- **One transfer per payout:** from the clearing account to the bank, for the exact payout. Its PrivateNote carries `LOFI-PAYOUT <DocNumber>`. The bank-feed deposit matches this transfer, so nobody splits the deposit.
- **QuickBooks is the summary.** The order, line, SKU, rule, fee and FX detail stays in this app, and each journal line lists its evidence.

## Hard gate

There is no approval and no posting unless all of these hold:
- the payout difference is exactly $0.00
- every line is classified
- there are no blocking review issues
- every fee type is in the fee GST table
- the journal balances and its clearing line equals the payout
- the payout is positive
- it hasn't already been posted

Deferred facts (Division 66, trade-ins) never block.

## Statuses

| Status | Meaning |
|---|---|
| Not ready | The gate fails. The reasons are listed on the payout page. |
| Ready for review | The gate passes, and a person can approve the exact preview |
| Approved | Approved for this preview (by fingerprint). Any change to the preview withdraws the approval. |
| Posting… | A short lock while posting |
| Journal posted, transfer pending | A partial post. Retry creates only the transfer. |
| Posted | The journal and the transfer are in QuickBooks and verified |
| Posting failed | Nothing was posted. Retry looks in QuickBooks first. |
| Adjustment required | The accounting changed after posting. An adjusting journal is prepared. |

## Idempotency

**One payout gives at most one journal and one transfer.** Before creating anything, the app checks our record (`qbo_postings`), then QuickBooks itself:
- the journal by its DocNumber
- the transfer by the PrivateNote reference, date and amount

A lost response or a retry therefore adopts what already exists instead of creating a second transaction. Tests cover a double post, re-import after posting, a transfer failure after the journal, and a journal created whose response was lost.

## Corrections

**Posted history never changes.** If a payout's accounting changes after posting (for example, an item turns out to be consigned):
- the original journal and `posted_preview_json` stay as they were
- an adjusting journal `<DocNumber>-A<n>` is prepared, containing the difference only and linked to the original journal ID
- it needs its own approval and posting

## Audit trail

**Per payout,** these are kept:
- source payout ID and date
- the journal preview with, on every line, its source transaction IDs, order IDs, SKUs and classification rule IDs
- FX records (foreign amount and currency, the marketplace's rate, and the AUD value)
- fee type and its GST code
- approval (who, when, and which preview fingerprint)
- the QuickBooks journal ID and DocNumber, the transfer ID, the posting time, and any adjustment journal IDs
- an append-only event log in `qbo_posting_events`

## Account and tax mapping

Logical keys only. QuickBooks IDs are set per company with `POST /api/qbo/map` (shown on the QuickBooks page).

| Key | Account | Tax code | Status |
|---|---|---|---|
| SALES_DOMESTIC_GST | Sales (Income, Sales of Product Income) | GST (10% Sales) | confirmed |
| SALES_OVERSEAS_NO_GST | Overseas Sales (Income, Sales - retail) | GST free (0% Sales) | confirmed |
| CONSIGNMENT_SALES_NO_GST | Commission Sales (Income, Sales - retail) | GST free (0% Sales) | confirmed |
| EBAY_FEES / PAYPAL_FEES | to confirm | GST free purchases (0%) | tax confirmed |
| SHOPIFY_FEES / AFTERPAY_FEES / ZIP_FEES | to confirm | GST on purchases (10%) | tax confirmed |
| MARKETPLACE_ADJUSTMENTS | to confirm | — | to confirm |
| EBAY_CLEARING, SHOPIFY_PAYMENTS_CLEARING (later PAYPAL, AFTERPAY, ZIP) | to create in QuickBooks | — | to create |
| BANK | the account payouts land in | — | to confirm |

## Dry-run example (masked live payout)

- **Payout:** eBay `LIVE-PAYOUT-1` (masked), paid 2026-10-08. It holds 2 sales and a partial refund that came with a fee credit.
- **Gate:** passes (difference $0.00, every line classified, no blocking issues).
- **Journal:** DocNumber `EB-LIVE-PAYOUT-1`, dated 2026-10-08.

| Account | Tax code | Debit | Credit | GST incl. | Evidence |
|---|---|---|---|---|---|
| Sales (`SALES_DOMESTIC_GST`) | GST (10% Sales) |  | $31.44 | $2.86 | 1 txn; rules R8 |
| Overseas Sales (`SALES_OVERSEAS_NO_GST`) | GST free (0% Sales) |  | $126.00 |  | 1 txn; rules R7 |
| Sales (`SALES_DOMESTIC_GST`) | GST (10% Sales) | $25.90 |  | $2.35 | 1 txn; rules R8 |
| eBay Fees (`EBAY_FEES`) | GST free purchases (0%) | $16.59 |  |  | 3 txn; rules — |
| eBay Clearing (`EBAY_CLEARING`) | — | $114.95 |  |  | net payout |
| **Total** | | **$157.44** | **$157.44** | | |

**Transfer:** $114.95 from eBay Clearing to the bank on 2026-10-08, with the reference `LOFI-PAYOUT EB-LIVE-PAYOUT-1`. The bank feed matches this transfer.

*Illustration: the item facts for this payout haven't been recorded yet, so its SKUs are assumed LOFI-owned here. The amounts, refund, fee credit and FX handling are as eBay sent them.*

## Sandbox test (Intuit sandbox company only)

```bash
# .dev.vars: QBO_MODE=sandbox, QBO_REALM_ID, QBO_CLIENT_ID / QBO_CLIENT_SECRET (DEVELOPMENT keys)
npm run qbo:connect                      # sign in, choose the sandbox company; tokens saved to .dev.vars + local D1
npm run dev                              # restart so the Worker is in sandbox mode
npm run qbo:sandbox -- discover          # company country, currency, accounts, tax codes and rates
npm run qbo:sandbox -- map --create      # create/find sandbox accounts, match GST codes by rate, save IDs
npm run qbo:sandbox -- prove ebay <payoutId>   # post via the real route, re-fetch and compare, duplicate + recovery tests
```

Raw requests and responses go to `.live/qbo-sandbox/` (git-ignored). Everything goes to `sandbox-quickbooks.api.intuit.com`, and the scripts refuse to run unless `QBO_MODE=sandbox`.

## Switching posting on (later, with explicit approval)

1. **Create the clearing accounts in QuickBooks** and confirm the placeholder account names.
2. **Set the QuickBooks IDs** for every account and tax code (`POST /api/qbo/map`).
3. **Sandbox first:**
   - Set `QBO_MODE=sandbox` plus `QBO_REALM_ID`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and `QBO_REFRESH_TOKEN` as Wrangler secrets.
   - Post a few approved payouts to an Intuit sandbox company.
   - **Verify the AU GST treatment on journal lines** and the query syntax in `src/posting/qbo-http.ts`. Both are marked UNVERIFIED.
4. **Check bank-feed matching.** Confirm the bank feed matches the clearing-to-bank transfer as expected.
5. **Only then, live:** `QBO_MODE=live`. Every payout still needs a person to approve it and press Post.

## Still open

- **Account names:** the fee, adjustment, clearing and bank accounts need confirming and creating.
- **QuickBooks request format:** AU GST on JournalEntry lines, and the transfer lookup query, must be verified in the sandbox.
- **Shopify local pickup:** needs the `read_merchant_managed_fulfillment_orders` scope. Without it, pickup orders ask staff for the destination.
- **The GST on LOFI's share of a domestic consignment sale** belongs to the consignment workflow. It's still shadow mode and isn't posted.
- **The historical comparison** (`docs/baseline-comparison.md`) should be done before enabling posting.
