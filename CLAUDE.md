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
- Fake data: `fake:bmo` / `fake:load` / `fake:score` / `db:wipe`, plus 12-month fixtures in `fixtures/`.
- Bank sync (SimpleFIN Bridge): one-time link in Settings, daily Vercel Cron plus "Sync now", dedupe by bank transaction id, manual-entry linking, dashboard reconciliation line, connection-attention banner, CSV cutover guard, Access URL encrypted with AES-256-GCM.
- AI category suggestions (Claude Haiku 5.5): lazy per group via `POST /api/inbox/suggest`, pre-fill the picker and are never auto-applied, precomputed after bank sync.
- 339 unit tests. A browser click-through on the preview (against `dev`) passed for import, linking, Inbox, rules, headers and AI suggestions. **Not yet checked at 390 px wide** beyond John's eyeball ("good enough"): Chrome on macOS won't resize below 500 px, so use a phone or DevTools device mode.

Review findings (P0/P1/P2 with file:line): `docs/reviews/2026-10-24-logic.md`, `docs/reviews/2026-10-24-security.md`.

Data is not precious yet: wiping and re-importing is fine until John says otherwise, so don't contort a fix to preserve existing rows.

Next up, in order:
1. **Real BMO link (John):** the $1.50 SimpleFIN test, ideally with a view-only BMO user. Confirm which BMO login the salon uses (Digital Banking or OLBB).
2. **Go live**:
   - merge `bank-sync` → `main` (deploys Production);
   - production logins via `user:add` against the `production` Neon branch;
   - link the real BMO on Production (not Preview);
   - first sync and a reconciliation check;
   - one guided Inbox session with Lauren.
3. **Everything else**:
   - undo an import (by `import_batch_id`);
   - split a transaction;
   - password change screen;
   - QuickBooks bank-rules import (not done: the file format is unverified);
   - PWA polish;
   - review P2s and product calls (runway vs owner draws, rent carry-forward, chair count).

Known caveats:
- Expected weekly/biweekly rent counts due dates from the stylist's start date; if real payment days differ, the month boundary can shift one payment between months. Fine for now; revisit if it confuses Lauren.
- Cash runway needs an opening balance in Settings; balance = opening + everything recorded since that date.
- The test URL is the stable branch alias (e.g. `quitbooks-git-bank-sync-drippy-projects.vercel.app`), where John stays signed in. Don't hand out per-deploy URLs.
