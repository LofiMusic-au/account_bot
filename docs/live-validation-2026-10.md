# Milestone 1 live-read validation — October 2026

Read-only checks of real LOFI payouts against the normalisation and reconciliation code. Nothing was written to QuickBooks, a bank feed or any platform.

Real payout, transaction and order IDs are left out of this file because the repository is public. Full local reports, with real IDs and no buyer data, are written to `.live/` by `scripts/live-validate.ts`, which is git-ignored.

## eBay

**Credentials used:** an existing LOFI eBay user access token. It works for the Finances API, but the Fulfillment API rejects it with eBay error 1004, "Error processing the access token". So no order details (SKUs, destinations, line prices) could be read. Every sale is held as `order_details_missing`, and nothing is classified or guessed.

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
4. **Order-fetch errors were swallowed.**
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

- **Order details:** this needs a user token with `sell.fulfillment.readonly`, from LOFI's eBay developer app through the OAuth consent flow. Until then nothing can be compared with the Fulfillment order:
  - SKUs, line prices and shipping split
  - discounts
  - destination and eBay International Shipping detection
- **Refunds against earlier orders:** these need that order fetch to reverse with the original scenario.

## Shopify Payments

**Not run.** None of the available credentials can read Shopify Payments:
- **Claude's Shopify connector:** "Access denied for shopifyPaymentsAccount field. Required access: `read_shopify_payments` or `read_shopify_payments_accounts`".
- **The admin token in the Migrator project:** it has product, inventory and file scopes only, with no orders or payments.
- **The shipping-integration project:** it holds a placeholder token.

Done so far:
- **API version:** pinned to `2026-10`. All three queries validate against the current schema. The order query ran live against the store, and every field returned.
- **Store data checked:** the most recent five orders. Their gateways were `shopify_payments`, `Afterpay` and `paypal`. Only `shopify_payments` orders settle through Shopify Payments payouts.

To finish the Shopify half, create a custom app token with `read_orders` and `read_shopify_payments` (Shopify's validator also lists `read_shopify_payments_accounts`), then run:

```bash
SHOPIFY_SHOP=lofi-music.myshopify.com SHOPIFY_ADMIN_TOKEN=… npx vite-node scripts/live-validate.ts shopify --scan
SHOPIFY_SHOP=lofi-music.myshopify.com SHOPIFY_ADMIN_TOKEN=… npx vite-node scripts/live-validate.ts shopify <payoutId>
```
