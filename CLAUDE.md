# CLAUDE.md: LOFI payout reconciliation

Read `HANDOFF.md` first for the full project context, the decisions made and the next steps.

## Non-negotiables

- **No AI or heuristics in the tax path.** GST classification is deterministic code in `src/rules/`. Anything that doesn't match a rule goes to the review queue (`REVIEW`). Never guess a treatment.
- **Never guess what a SKU prefix or consignor means.** Ask Luke.
- **Nothing gets posted to QuickBooks from a scenario that isn't `signedOff: true`** in `src/rules/config.ts`. Payouts that aren't `ready` aren't posted either. Milestone 1 is report-only.
- **Money is integer cents** (`src/money.ts`). Use `allocate()` for any split so the parts always add up to the total.
- **Payouts must reconcile to the cent.** A difference is surfaced as `unbalanced`, never absorbed.
- Platform-specific logic belongs in `src/channels/*`. Everything after normalisation is channel-neutral.
- **Store facts, derive treatment.** Stock records hold ownership, acquisition source, condition, consignor and so on. Scenarios, GST and Division 66 candidacy are derived in `src/rules/engine.ts` and never stored on the item.
- **Unknown means review.** A missing fact, an unknown platform transaction type or an unresolved scenario must produce a blocking issue, never a default.
- **Unsigned-off means provisional.** Tests for unsigned-off scenarios assert the draft arithmetic *and* that the result is provisional; they must not read as statements of law.
- **Keep provenance.** Every normalised record carries a `SourceRef`. Raw transactions are stored in `source_transactions` with buyer details removed.
- **Branches.** Work on feature branches; don't merge to `main` without being asked.

## Historical accounting baseline

LOFI's current method has two stages:
1. **Payout split:** owned domestic goes to `SALES_DOMESTIC_GST`, owned overseas to `SALES_OVERSEAS_NO_GST`, and consignment in full to `CONSIGNMENT_SALES_NO_GST`. Fees go to `EBAY_FEES` / `SHOPIFY_FEES`, and refunds reverse the original category. This is `src/accounting/baseline.ts`.
2. **Consignment subledger:** commission per consignor rule, 1/11 GST on the commission, the rest payable to the consignor, totalled per month for the periodic journal. This is `src/accounting/consignment.ts` and the `consignment_sales` table.

**The consignment module is in SHADOW MODE (`CONSIGNMENT_MODULE_MODE`).** Jess's manual ledger is the source of truth. Never use the module's figures for consignor payouts, QuickBooks journals, liability balances or payment automation, and never write code that marks entries posted or paid. A test enforces this. The payout reconciler is the primary build.

Rules for this baseline:
- **Reproduce it before changing it.** It is the operational baseline, *not* accountant-approved. Keep it separate from the draft GST scenarios.
- **Recipes may change; source data may not.** Never rebuild or edit source transactions to change a treatment. Posted ledger entries are frozen.
- **A balanced payout isn't proof the accounting is right.**
- **Logical categories only.** No QuickBooks account IDs until milestone 2.
- **The `L-` SKU convention sets ownership only, never the GST scenario.**
- **The review queue asks for facts, not journal decisions.**

## Commands

- `npm test`: vitest. Keep every scenario covered when changing rules.
- `npm run typecheck`: checks `src` against Workers types and `test`/`scripts` against Node types.
- `npm run dev`: local Worker. Run `npm run db:migrate:local`, `npm run demo:sql` and `npm run demo:load` first.
- `npm run deploy`

## Conventions

- **Australian English in the UI and docs.** Currency is AUD.
- **Scenario codes and names must match the accountant sign-off doc** (see the link in HANDOFF.md §3). If a treatment changes, update the doc and `config.ts` together.
- **Schema changes go in new numbered files in `migrations/`.** Never edit `0001_init.sql` once it's deployed.
