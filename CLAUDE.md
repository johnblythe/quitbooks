# CLAUDE.md — handoff for coding agents

@AGENTS.md

Read `docs/PRD.md` and `README.md` first. This repo is a working first pass: every MVP screen exists, builds, and was exercised end to end in a headless browser against the demo data. Your job is to harden it, deploy it, and close the gaps below.

## Ground rules

- This is **Next.js 16 with Cache Components on**. Before touching routing, caching or data fetching, read the bundled docs in `node_modules/next/dist/docs/`. In particular:
  - Request-time reads (DB, cookies, `searchParams`, `params`, the current date) must sit inside a `<Suspense>` boundary. Pages follow the pattern: static `PageHeader` + `<Suspense>` around an async component that does the reads.
  - Every read in `src/lib/data.ts` calls `await connection()` first. Use `requestToday()` (not `todayIso()`) in server components, or the build fails with a prerender error.
  - `middleware` is now `proxy` (`src/proxy.ts`).
  - Server actions refresh the page with `refresh()` from `next/cache`, or `redirect()`.
- Money is integer cents everywhere. Never use floats for money. Parse with `parseAmountToCents`.
- Dates are `YYYY-MM-DD` strings (Postgres `date`), never `Date` objects, to avoid time-zone drift.
- Business logic goes in pure functions in `src/lib/` with Vitest tests next to them. Keep pages thin.
- Every server action and route handler starts with `requireUser()` / `getSession()`.
- Schema changes: edit `src/db/schema.ts`, then `npm run db:generate`, commit the SQL in `drizzle/`.

## Verify before you say you're done

```bash
npm run typecheck && npm test && npm run build
```

Then run it against PGlite (`DATABASE_URL=pglite:./.pglite`, `db:migrate`, `db:seed`, `db:demo`, `user:add`) and click through on a phone-sized viewport (390×844).

## Status

Done:
- Auth (2 users, scrypt + signed cookie), proxy guard
- Dashboard: monthly profit + 6-month bars, booth rent expected vs collected, chairs filled, cash runway, expenses by category vs 3-month average
- Transactions list by month, add, edit, delete
- CSV import: header detection (single or debit/credit columns, preamble lines, sign inversion, memo column), editable mapping saved after first import, preview with duplicate flags and suggested categories, idempotent commit
- Inbox: categorize, optional stylist, "remember" creates a rule and re-sorts the Inbox
- Stylists: roster with weekly/biweekly/monthly rent, start/end dates, bank match text
- Settings: chair count, opening balance, categories (add/rename/hide), rules
- Reports: P&L for presets or custom range, summary CSV, detailed CSV, print / save as PDF
- 52 unit tests across money, dates, CSV, categorization, metrics

Review findings (P0/P1/P2 with file:line): `docs/reviews/2026-10-24-logic.md`, `docs/reviews/2026-10-24-security.md`.

Data is not precious yet: wiping and re-importing is fine until John says otherwise, so don't contort a fix to preserve existing rows.

Next up, in order:
1. **Fabricated BMO data**: a seeded generator for N months of a booth-rent salon (Zelle rent, salon expenses, owner draws, realistic traps), in each plausible BMO export shape. Fixture tests against the importer. Replaces waiting on a real export; check against a real one when it turns up.
2. **Neon + deploy**: Vercel + Neon, transactional migrations (review security P1-4), seed, load the fabricated data, John's and Lauren's logins.
3. **Categorization** (review logic P1-1, P1-3, P1-4): stylist matching on whole words and active dates, contiguous "remember" patterns, Booth Rent remember tags the stylist. Plus Inbox bulk actions, "would catch N" preview, rule editing and a "test this rule" preview.
4. **Hardening**:
   - Import integrity: manual-vs-import double count (logic P0-1), a mapping-independent hash (logic P1-2), atomic commit, visible parse errors, 4 MB body limit.
   - Auth: open redirect, login rate limiting (an attempts table; Vercel KV no longer exists), stored-hash validation.
   - `.env.example`.
5. **Everything else**:
   - undo an import (by `import_batch_id`);
   - split a transaction;
   - password change screen;
   - QuickBooks history;
   - PWA polish;
   - review P2s and product calls (runway vs owner draws, rent carry-forward);
   - stretch: bank sync (Plaid / Teller / SimpleFIN; a `bank_sync` writer reusing `categorize()` and the dedupe hash).

Known caveats:
- Expected weekly/biweekly rent counts due dates from the stylist's start date; if real payment days differ, the month boundary can shift one payment between months. Fine for now; revisit if it confuses Lauren.
- Cash runway needs an opening balance in Settings; balance = opening + everything recorded since that date.
- `npm audit` reports advisories in dev-only tooling from the scaffold; review before deploy.
