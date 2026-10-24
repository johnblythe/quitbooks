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

Next up, in priority order:
1. **Get a real BMO CSV export** and check `detectMapping` against it, especially whether Zelle sender names appear in the description or a separate column (PRD open question). Add a fixture test with the real headers (fake the rows).
2. **Deploy**: Vercel + Neon integration, run migrations and seed against Neon, create John's and Lauren's logins. Confirm the Neon HTTP driver works for every action (it has no interactive transactions; nothing currently needs one).
3. **Inbox bulk actions**: select several rows → one category. "Remember" currently matches the suggested pattern; consider showing how many other Inbox items it would catch before saving.
4. **Rule editing** (only add/delete today) and a "test this rule" preview.
5. **Split a transaction** across categories (e.g. one Amazon order = supplies + cleaning).
6. **Undo an import** (delete by `import_batch_id`) from the Recent imports list.
7. **Login rate limiting** (e.g. a simple attempts table or Vercel KV) and a password change screen.
8. **QuickBooks history**: decide how far back to import (open question). QuickBooks can export transactions to CSV; the importer may just work with a mapping.
9. **PWA polish**: app icon, manifest, add-to-home-screen.
10. Stretch: bank sync (Plaid / Teller / SimpleFIN, see PRD). Add a `bank_sync` source writer that reuses `categorize()` and the dedupe hash.

Known caveats:
- Expected weekly/biweekly rent counts due dates from the stylist's start date; if real payment days differ, the month boundary can shift one payment between months. Fine for now; revisit if it confuses Lauren.
- Cash runway needs an opening balance in Settings; balance = opening + everything recorded since that date.
- `npm audit` reports advisories in dev-only tooling from the scaffold; review before deploy.
