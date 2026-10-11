# Historical baseline comparison

The question this answers is "would the app have produced the same split staff actually used?", not only "does it balance to $0.00?"

## How to run it

1. Pick 5–10 real payouts that staff already split by hand in QuickBooks. Mix eBay and Shopify, and include at least one with a refund, one export and one consignment sale if possible.
2. Make sure each payout is in the dashboard and its items have their facts recorded. A line left `UNCLASSIFIED` can't be compared.
3. On each payout's page, use **Download this split as CSV**. It has one row per line, totals per category, and the payout total.
4. Open the QuickBooks transaction where staff split that payout. Compare:
   - each sale and the category it went to
   - refunds
   - fees and their category
   - domestic vs overseas
   - the final total
5. Record every difference in the table below, even small ones. Leave a row out only when it matches.

## Mismatch types

| Type | Meaning | Usual fix |
|---|---|---|
| **Stock fact** | A fact about the item is missing or wrong (ownership, consignor, destination, listing link) | Correct the fact in the review queue |
| **Rule** | The rules table gives a different category from what staff do | Change `PAYOUT_CLASSIFICATION_RULES` (only with agreement) |
| **Source mapping** | The app read the platform data wrongly (amount, fee type, refund, currency) | Fix the channel normaliser and add a regression fixture |
| **Historical inconsistency** | Staff didn't treat like cases the same way | Decide the intended treatment, then record it |
| **Accountant decision** | It depends on something still awaiting sign-off (GST scenarios, fee GST, FX, BAS) | Leave for the accountant, with a note |

## Log

| Payout (date, platform) | Order / line | App category | QuickBooks category | Amount | Type | Note / action |
|---|---|---|---|---|---|---|
| | | | | | | |
