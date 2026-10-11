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

## Commands

- `npm test`: vitest. Keep every scenario covered when changing rules.
- `npm run typecheck`: checks `src` against Workers types and `test`/`scripts` against Node types.
- `npm run dev`: local Worker. Run `npm run db:migrate:local`, `npm run demo:sql` and `npm run demo:load` first.
- `npm run deploy`

## Conventions

- **Australian English in the UI and docs.** Currency is AUD.
- **Scenario codes and names must match the accountant sign-off doc** (see the link in HANDOFF.md §3). If a treatment changes, update the doc and `config.ts` together.
- **Schema changes go in new numbered files in `migrations/`.** Never edit `0001_init.sql` once it's deployed.
