# Milestone 1 live-read validation — October 2026

Read-only checks of real LOFI payouts against the normalisation and reconciliation code. Nothing was written to QuickBooks, a bank feed or any platform.

Real payout, transaction and order IDs are left out of this file because the repository is public. Full local reports, with real IDs and no buyer data, are written to `.live/` by `scripts/live-validate.ts`, which is git-ignored.

## eBay

**Credentials used:** at first, an existing LOFI eBay user access token. It worked for the Finances API, but the Fulfillment API rejected it with eBay error 1004. Then a refresh token from `npm run ebay:consent` was used, with `sell.finances` and `sell.fulfillment.readonly`, and both APIs worked.

**With order details** (re-run on all five payouts):
- **18 of 20 sales** match their Fulfillment order exactly: line prices after discounts plus shipping equal net + fees.
- **The two foreign-buyer sales** match in the order's own currency. EUR 39.99 equals the fee basis, and so does USD 69.46.
- **All refunds** are matched to their original orders.
- **The only remaining blockers** are SKUs with no stock record (no stock facts are loaded yet), plus one German listing that has no SKU on eBay.

| Payout date | Contents | Actual payout | Reconstructed | Difference |
|---|---|---|---|---|
| 2026-10-10 | 3 sales | $1,393.33 | $1,393.33 | $0.00 |
| 2026-10-08 | 2 sales, 1 partial refund | $114.95 | $114.95 | $0.00 |
| 2026-10-02 | 1 sale, 1 non-sale charge | $503.68 | $503.68 | $0.00 |
| 2026-09-14 | 3 sales, 2 refunds | $111.52 | $111.52 | $0.00 |
| 2026-09-11 | 11 sales, 2 in foreign currency | $4,303.68 | $4,303.68 | $0.00 |

In every payout:
- Every normalised record carries its eBay transaction ID.
- Ingesting the payout twice produced no duplicate rows.
- No unsupported transaction type was found.

A 30-day scan found these types only: `SALE`, `REFUND`, and `NON_SALE_CHARGE` with fee type `OTHER_FEES`.

### Field mappings confirmed

- **A SALE's `amount` is net of selling fees.** `amount + totalFeeAmount = totalFeeBasisAmount` on every AUD sale checked. Gross = net + fees stands, and eBay's fee basis is now an independent cross-check, so the payout total is no longer the only proof.
- **Itemised fees add up.** `orderLineItems[].marketplaceFees[]` always summed to `totalFeeAmount`. The types seen were `FINAL_VALUE_FEE`, `FINAL_VALUE_FEE_FIXED_PER_ORDER` and `INTERNATIONAL_FEE`.
- **The payout is the sum of signed transactions.** `payout.amount` equals the sum of the signed `amount`s (CREDIT +, DEBIT −). The `filter=payoutId:{id}` query returned exactly `transactionCount` transactions.
- **The Finances host is right.** It is `apiz.ebay.com/sell/finances/v1`, with `X-EBAY-C-MARKETPLACE-ID: EBAY_AU`.

### Field mappings changed

1. **REFUND is net of the fee credit.**
   - What the data shows: on a live partial refund, `amount` was 23.46 DEBIT, `totalFeeAmount` was 2.44, and `totalFeeBasisAmount` was 25.90.
   - What the code did: it recorded a $23.46 refund. That balanced but understated the refund and hid eBay crediting the fees back.
   - Now: refund gross = `amount + totalFeeAmount` (cross-checked with the fee basis), and each `marketplaceFees` entry is a negative fee (a credit). The payout total is unchanged.
2. **Foreign-currency sales have fees in the buyer's currency.**
   - What the data shows: `amount` is AUD and carries `convertedFromCurrency`, `convertedFromValue` and `exchangeRate`. But `totalFeeAmount`, `totalFeeBasisAmount` and every itemised fee are in EUR or USD.
   - What the code did: it added EUR fees to AUD net and recorded them as AUD cents. The payout still balanced, because the gross was derived from the same fees.
   - Now: each foreign fee is converted at that transaction's `exchangeRate` with integer arithmetic. eBay's AUD net stays authoritative, and gross = AUD net + converted fees. Net + fees is checked against the fee basis in the transaction's own currency, and the converted basis must agree within rounding.
   - A fee in another currency, or a missing rate, blocks the payout.
   - This is a working method only. It raises an `fx_policy_pending` sign-off issue until the accountant approves LOFI's FX policy (C4).
3. **Collected tax uses a different spelling.** The live field is `ebayCollectedTaxAmount`. The code read `eBayCollectedTaxAmount`, so it never saw it. Both are read now. eBay collects and remits that tax (EUR 7.60 of EU VAT on one sale), and it is outside LOFI's gross and fee basis.
4. **Foreign-buyer orders are priced in the buyer's currency.** The Fulfillment order for a EUR or USD sale has `lineItemCost`, `deliveryCost` and `pricingSummary` in EUR or USD, and they match the fee basis. The comparison is now made in that currency. eBay's AUD gross is then split across items and shipping in proportion, recorded in the payout notes. A mismatch in the order's currency still blocks.
5. **Order-fetch errors were swallowed.**
   - What the code did: a failed `getOrder` became "order details not found". It was also retried four times, even for an OAuth error.
   - Now: the real error is carried into the issue, and OAuth-domain errors aren't retried.

### Other source fields seen, not used yet

`transactionStatus` (PAYOUT), `paymentsEntity` ("eBay Commerce Australia Pty Ltd"), `references[]` (for example REFUND_ID), and `feeMemo` on international fees (for example "Charged because the delivery address is in Germany").

`NON_SALE_CHARGE` / `OTHER_FEES` of $74.95 had the memo "2026-09-30 - 2026-10-30". It looks like the monthly store subscription, but it's left as an "other" fee rather than guessed.

### Regression fixtures

These are masked copies of live shapes in `test/fixtures/live/`. IDs are replaced, and there is no buyer data and no bank details. Each one is tested in `test/live-fixtures.test.ts`:
- `ebay-refund-fee-credit.json`
- `ebay-non-sale-charge.json`
- `ebay-foreign-currency.json`

### Still to validate on eBay

- **eBay International Shipping:** no EIS order appeared in 30 days. Detection (`program.ebayInternationalShipping` or `ebaySupportedFulfillment`) is still unverified on live data.
- **Collected tax on exports:** eBay reported collecting AUD 18.90 of tax on a $126.00 sale. That's 15%, consistent with NZ GST on a low-value import. It's noted as outside LOFI's gross, and the export classification still needs stock facts.
- **Classification:** stock facts and SKU prefix meanings must be loaded before any sale can be classified.

## Shopify Payments

**Credentials used:** a Dev Dashboard app for LOFI, authenticated with the client credentials grant (a 24-hour token). It has the Shopify Payments payout and account scopes, but **not `read_orders` yet**. So order details (SKUs, shipping, discounts, destination) couldn't be read. Every sale is held as `order_details_missing`, with Shopify's "Access denied for Order object" as the reason. Nothing is classified or guessed.

| Payout date | Contents | Actual payout | Reconstructed | Difference |
|---|---|---|---|---|
| 2026-10-08 | 2 charges, 1 refund | $338.23 | $338.23 | $0.00 |
| 2026-10-07 | 6 charges | $2,609.24 | $2,609.24 | $0.00 |
| 2026-10-02 | 3 charges | $5,396.31 | $5,396.31 | $0.00 |

In every payout:
- Every normalised record carries its Shopify balance transaction ID.
- Ingesting the payout twice produced no duplicate rows.
- No unsupported transaction type was found.

A 30-day scan found only `CHARGE` and `REFUND`. No adjustments, chargebacks, reserves or shipping labels were seen.

### Field mappings confirmed

- **Balance transaction amounts:** `amount` is the gross charge, `fee` is the Shopify Payments processing fee, and `net` = `amount − fee` on every row.
- **Refund fees:** the refund carried `fee` 0.00, so there was no processing-fee credit on that refund.
- **The payout filter is right.** `balanceTransactions(query: "payments_transfer_id:<payout legacyResourceId>", hideTransfers: true)` returns exactly the payout's transactions. Their nets sum to `payout.net` to the cent, and the payout's own transfer line is excluded.
- **Amount format:** amounts can come with one decimal place, e.g. `"-5.0"`, and they parse correctly.
- **Scopes for this route:** an app with the Shopify Payments payout and account scopes can read `shopifyPaymentsAccount.payouts` and `balanceTransactions`.

### Terminology: Shopify vs the internal model

| Shopify | Internal model |
|---|---|
| Payout `net` | `NormalisedPayout.netCents` (the actual payout) |
| Balance transaction `CHARGE` `amount` | the sale's `grossCents` (items + shipping, after discounts, GST-inclusive) |
| `CHARGE` `fee` | a `Fee` in the `payment` category (`shopify_payments_fee`) |
| `REFUND` `amount` (negative) | a `Refund` with positive `cents` |
| `SHIPPING_LABEL*` | a `Fee` in the `shipping_label` category |
| `ADJUSTMENT`, `RESERVED_FUNDS*`, `CHARGEBACK_HOLD*` and similar | an `Adjustment` (supported) |
| `DISPUTE_*` | an `Adjustment` plus a blocking `dispute` issue |
| any other type, including `CURRENCY_CONVERSION` (new in 2026-10) | an unsupported `Adjustment` that blocks the payout |

### Changed

- **Authentication:** Dev Dashboard apps don't show a `shpat_` token. The client now exchanges `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` for a token. `SHOPIFY_ADMIN_TOKEN` still works.
- **Order errors:** a failed order lookup (for example a missing scope) no longer aborts the payout. The payout reconciles, and each sale carries the reason.

### Regression fixture

`test/fixtures/live/shopify-charges-refund.json` is a masked copy of the 8 October payout.

### Still to validate on Shopify

- **Order data:** add `read_orders` to the app, release the new version and approve it on the store. Then re-run `npm run live:validate -- shopify 143669428399` to compare against the orders:
  - items, shipping and discounts per order
  - charges against order totals
  - the refund's reversal against its original order
  - destinations, including local pickup
- **Fee GST:** the GST on the Shopify Payments fee awaits the accountant (D1).
