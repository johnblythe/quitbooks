# Changelog

All notable changes to this project are documented here, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased] - 2026-10-24

### Added
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
- Bank feed (#1):
  - disconnecting keeps the bank accounts (detached), so reconnecting the same SimpleFIN accounts re-attaches them;
  - a full re-fetch can start at most a year back (SimpleFIN allows 24 requests a day);
  - SimpleFIN errors about other connections are shown as amber warnings and no longer fail the sync;
  - bank feed rows can't be deleted; categorize them instead.
- `db:wipe` also makes the bank feed's next sync re-fetch from its start date (#1).
- Background AI suggestions run 16 groups per request with `max_tokens` 8000; Haiku 5.5 thinks by default and thinking counts toward the cap (#1).

### Fixed
- A manual entry plus the same CSV row counted twice (review P0-1).
- An open redirect after login.
- "Remember" rules that couldn't match their own transaction, and a remembered Booth Rent rule that didn't tag the stylist.
- A malformed stored password hash accepted any password.
- The CSV commit wasn't atomic, and the server action body limit was effectively 1 MB.
- The Inbox picker didn't show its suggestion until a page reload.
- `npm audit` production dependencies went from 4 high to 0 (nested `zod` override).
- PR #1 review fixes:
  - an earlier start date, or a newly included account, is now fetched from the start date;
  - disconnect then reconnect no longer duplicates feed rows;
  - a start date on or before the last CSV row is rejected, with both dates named;
  - the CSV guard also covers feed rows dated before a start date that was moved later;
  - connecting checks `BANK_TOKEN_KEY` before spending the one-time setup token, and saves the link before loading accounts, so a failed account fetch can be retried;
  - a start date in the future no longer reports every account missing;
  - deleted feed rows no longer come back on the next sync (they can't be deleted);
  - pages now re-check the session on every request, so a revoked session or deleted user can't read pages for up to 30 days;
  - parallel login attempts can no longer get past the 5-per-IP / 20-per-email limit;
  - background AI suggestion batches that hit `max_tokens` are split and retried, and a failing batch no longer blocks the others;
  - large Inbox groups (over 500 rows) no longer get a 400 from the suggestion route;
  - Zelle and transfer patterns keep the payer's name, so two stylists' payments no longer share one Inbox group;
  - "Remember" no longer leaves a bare first name as a stylist match term when the pattern has a comma.
