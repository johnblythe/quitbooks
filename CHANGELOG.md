# Changelog

All notable changes to this project are documented here, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased] - 2026-10-24

### Added
- CSV import with category mapping, for a QuickBooks Online export or any CSV with a category column:
  - an optional Category column in the column mapping (QuickBooks' "Split" is detected automatically), plus Name and Memo joined into the description with duplicates dropped;
  - a preview step listing each distinct category in the file with its row count and net total, to map to an existing category, create as new (editable name and kind), or leave for the Inbox;
  - sensible defaults: exact name match, QuickBooks placeholders (-Split-, Uncategorized, Ask My Accountant, blank) to the Inbox, new categories typed by row direction and as transfers for owner equity names;
  - a mapped category beats rules, except Booth Rent, which still needs a stylist from stylist matching and otherwise goes to the Inbox;
  - new categories are created inside the same atomic commit, and the choices are saved with the column mapping so a re-import pre-fills them;
  - QuickBooks "Transaction Detail by Account" report lines (section headings, "Total for" rows, the "Cash Basis" footer) are skipped and counted instead of flagged as errors.
- Automatic bank sync through SimpleFIN Bridge:
  - a one-time link in Settings → Bank connection;
  - a daily Vercel Cron (11:00 UTC) and "Sync now";
  - dedupe by bank transaction id, and manual-entry linking;
  - a dashboard reconciliation line ("BMO says $X · Books say $Y");
  - a connection-attention banner;
  - a CSV cutover guard so imports can't overlap the feed;
  - the Access URL encrypted with AES-256-GCM.
- AI category suggestions (Claude Haiku 5.5):
  - the Inbox fills in suggestions per group, lazily and top to bottom, through `POST /api/inbox/suggest`;
  - a suggestion pre-fills the picker and is never auto-applied;
  - suggestions are precomputed after bank sync.
- A grouped Inbox: transactions grouped by merchant, one tap to Sort, and Remember to save a rule.
- Rule editing in Settings with a live "Matches N past · M in Inbox" preview.
- CSV import:
  - links a row to a matching manual entry instead of double-counting it;
  - lists rows it couldn't read and asks for acknowledgement before importing without them.
- Login rate limiting (5 failures per IP / 20 per email in 15 minutes).
- Session revocation (`users.session_version`; re-running `user:add` logs that user out everywhere).
- A fake BMO data generator and 12-month fixtures (`fake:bmo`, `fake:load`, `fake:score`, `db:wipe`).
- Infrastructure: a Neon project (`production` and `dev` branches), a Vercel project, and the Neon agent skills.
- Review findings in `docs/reviews/` and `.env.example`.

### Changed
- Database driver: node-postgres with Vercel `attachDatabasePool`, giving real transactions.
- Migrations: transactional, over the direct URL; `sslmode=verify-full`.
- Stylist matching: whole words only, and only within the stylist's active window (14 days before start through 45 after end).
- The import dedupe hash no longer changes when the column mapping changes (memo column, sign flip).
- Stronger scrypt parameters; legacy hashes still verify.
- `user:add` prompts for the password, hidden; `db:seed` is keyed on system categories.
- The proxy matcher is anchored, and security headers are added.

### Fixed
- A manual entry plus the same CSV row counted twice (review P0-1).
- An open redirect after login.
- "Remember" rules that couldn't match their own transaction, and a remembered Booth Rent rule that didn't tag the stylist.
- A malformed stored password hash accepted any password.
- The CSV commit wasn't atomic, and the server action body limit was effectively 1 MB.
- The Inbox picker didn't show its suggestion until a page reload.
- `npm audit` production dependencies went from 4 high to 0 (nested `zod` override).
