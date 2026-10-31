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
- CSV import:
  - header detection (single or debit/credit columns, preamble lines, sign inversion, memo column);
  - editable mapping, saved after the first import;
  - preview with duplicate flags, suggested categories, and links to matching manual entries;
  - atomic commit;
  - mapping-independent dedupe hash;
  - parse errors shown, and the import needs an acknowledgment when there are any.
- Inbox:
  - grouped by suggested merchant pattern: one pick sorts a group, and "remember" saves a rule;
  - one-offs get per-row cards;
  - Booth Rent + stylist remembers by extending the stylist's match text.
- Import with category mapping (QuickBooks Transaction Detail CSV): optional Category column, per-value mapping step (existing / create new / Inbox), mapped category beats rules (Booth Rent still needs a stylist), choices saved with the column mapping, report lines skipped. The QuickBooks layout is from memory, not a verified export.
- Categorization: stylist names match as whole words, only within the stylist's active window (14 days before start through 45 after end).
- Stylists: roster with weekly/biweekly/monthly rent, start/end dates, bank match text.
- Settings: chair count, opening balance, categories (add/rename/hide), rules (add/edit/delete with a live "Matches N past · M in Inbox" test).
- Reports: P&L for presets or a custom range, summary CSV, detailed CSV, print / save as PDF.
- Auth hardening: safe post-login redirect, login throttling (5 failures per IP / 20 per email in 15 min), session revocation via `users.session_version`, stronger scrypt, anchored proxy matcher, security headers.
- Infra:
  - Neon `quitbooks` with `production` and `dev` branches (see README "Deploy");
  - node-postgres with `attachDatabasePool`;
  - transactional migrations;
  - Vercel project `drippy-projects/quitbooks`.
- Fake data: `fake:bmo` / `fake:load` / `fake:restore` / `fake:score` / `db:wipe`, plus committed 439-row, 12-month fixtures in `fixtures/`. `fake:restore` uses the real import writer and dedupes on repeat; the wipe-and-restore cycle is documented in README and verified locally and on Neon dev. Never use fake-data commands against production.
- Bank sync (SimpleFIN Bridge): one-time link in Settings, daily Vercel Cron plus "Sync now", dedupe by bank transaction id, manual-entry linking, dashboard reconciliation line, connection-attention banner, CSV cutover guard, Access URL encrypted with AES-256-GCM.
- AI category suggestions (Claude Haiku 5.5): lazy per group via `POST /api/inbox/suggest`, pre-fill the picker and are never auto-applied, precomputed after bank sync.
- Split transactions: 2+ lines (category, stylist for Booth Rent, amount, memo) that sum exactly to the row; editor at `/transactions/[id]/split` (also linked from Inbox one-offs); `transactions.is_split` + `transaction_splits` (migration 0006, after bank-sync 0004/0005). Every category aggregation goes through `expandLedgerLines` (`src/lib/ledger.ts`); "in the Inbox" is `inInbox()` (`src/lib/inbox-where.ts`: no category AND not split), never bare `isNull(category_id)`.
- Reports labelled "Cash basis" (P&L page, print view, both CSVs).
- Release verification on 2026-10-31: 542 tests; typecheck, lint and production builds pass. Five authenticated bank-sync preview pages load. Isolated local browser checks verify feed amount/date locks, no Delete, and an amber daily-budget sync result (not a real bank fetch). Split save/edit/remove and cash-basis detailed export pass at 390px without horizontal overflow.

Review findings (P0/P1/P2 with file:line): `docs/reviews/2026-10-24-logic.md`, `docs/reviews/2026-10-24-security.md`.

Neon dev is disposable; production is real books. Ask before wiping shared test data and never reset production as part of fixture work. On 2026-10-31 John authorized repairing the legacy dev split migration; 439 fake transactions were restored and the login preserved. Both databases now have migrations 0000 through 0006. An expiring rehearsal branch `release-check-2026-10-31` expires November 2.

Next up, in order:
1. **Production logins (John):** no production users exist as of 2026-10-31. Use `user:add` against `production`, with the hidden password prompt, for John and Lauren. Do not put passwords in chat, command arguments or committed files.
2. **Real BMO acceptance (John):** bank-sync PR #1 and splits PR #3 are merged; production deploys from `main`. Import category mapping is the next release PR. Sign up for SimpleFIN yourself, ideally with a view-only BMO user. Confirm which BMO login the salon uses (Digital Banking or OLBB).
   - link the real BMO on Production (not Preview);
   - first sync and a reconciliation check;
   - one guided Inbox session with Lauren.
   - compare cash-basis P&L to Lauren's actual QuickBooks exports; the committed QBO sample is synthetic, not evidence of real export compatibility.
3. **Everything else**:
   - undo an import (by `import_batch_id`);
   - password change screen;
   - QuickBooks bank-rules import (not done: the file format is unverified);
   - PWA polish;
   - review P2s and product calls (runway vs owner draws, rent carry-forward, chair count).

Known caveats:
- Expected weekly/biweekly rent counts due dates from the stylist's start date; if real payment days differ, the month boundary can shift one payment between months. Fine for now; revisit if it confuses Lauren.
- Cash runway needs an opening balance in Settings; balance = opening + everything recorded since that date.
- The test URL is the stable branch alias (e.g. `quitbooks-git-bank-sync-drippy-projects.vercel.app`), where John stays signed in. Don't hand out per-deploy URLs.
