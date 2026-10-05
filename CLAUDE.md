# CLAUDE.md: LOFI payout reconciliation

Read `HANDOFF.md` first for the full project context, the decisions made and the next steps.

## Non-negotiables

- **No AI or heuristics in the tax path.** GST classification is deterministic code in `src/rules/`. Anything that doesn't match a rule goes to the review queue (`REVIEW`). Never guess a treatment.
- **Never guess what a SKU prefix or consignor means.** Ask Luke.
- **Nothing gets posted to QuickBooks from a scenario that isn't `signedOff: true`** in `src/rules/config.ts`. Payouts that aren't `ready` aren't posted either. Milestone 1 is report-only.
- **Money is integer cents** (`src/money.ts`). Use `allocate()` for any split so the parts always add up to the total.
- **Payouts must reconcile to the cent.** A difference is surfaced as `unbalanced`, never absorbed.
- Platform-specific logic belongs in `src/channels/*`. Everything after normalisation is channel-neutral.

## Commands

- `npm test`: vitest. Keep every scenario covered when changing rules.
- `npm run typecheck`
- `npm run dev`: local Worker. Run `npm run db:migrate:local` first; demo data comes from `scripts/demo-sql.ts`.
- `npm run deploy`

## Conventions

- **Australian English in the UI and docs.** Currency is AUD.
- **Scenario codes and names must match the accountant sign-off doc** (see the link in HANDOFF.md §3). If a treatment changes, update the doc and `config.ts` together.
- **Schema changes go in new numbered files in `migrations/`.** Never edit `0001_init.sql` once it's deployed.
