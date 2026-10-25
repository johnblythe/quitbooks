# L Marie Books

Simple bookkeeping for L Marie Beauty Collective: import the BMO business account, sort transactions, track booth rent, and pull a tax-ready P&L. Replaces QuickBooks. Product spec: [docs/PRD.md](docs/PRD.md).

**Stack:** Next.js 16 (App Router, Cache Components) · Neon Postgres via Drizzle · Tailwind 4 · deployed on Vercel.

## Run it locally (no Neon needed)

```bash
npm install
cp .env.example .env
# In .env: DATABASE_URL=pglite:./.pglite  and a SESSION_SECRET (command is in the file)
npm run db:migrate
npm run db:seed
npm run db:demo        # optional: fake stylists + 6 months of transactions (local only)
npm run user:add -- you@example.com "Your Name" "a-long-password"
npm run dev
```

`pglite:` runs an embedded Postgres stored in `./.pglite`, so local dev needs no database server.

## Deploy (Vercel + Neon)

Live setup: Vercel project `drippy-projects/quitbooks`, Neon project `quitbooks` (`snowy-queen-68891538`, aws-us-east-1).

| Neon branch | Used by | Data |
| --- | --- | --- |
| `production` | Vercel Production | Real books |
| `dev` | Vercel Preview, local testing | Disposable; fake roster via `fake:load` |

- Vercel env, Production and Preview each: `DATABASE_URL` (pooled, `-pooler` host) and `SESSION_SECRET` (separate random values).
- Migrations use the **direct** connection (`DATABASE_URL_UNPOOLED`) and run in one transaction (`scripts/db.ts`).

Run scripts against a branch without writing secrets to disk (needs `npm i -g neon` and `neon login`; the repo is linked via `.neon`):

```bash
cs() { neon connection-string "$1" --database-name quitbooks --role-name quitbooks_owner $2; }
DATABASE_URL="$(cs dev --pooled)" DATABASE_URL_UNPOOLED="$(cs dev)" npm run db:migrate
DATABASE_URL="$(cs dev --pooled)" npm run db:seed
DATABASE_URL="$(cs production --pooled)" npm run user:add -- john@… "John" "…"
```

Run migrations on `dev` first, then `production`. Pushing to `main` deploys Production; any other branch gets a Preview against `dev`.

After the first deploy: sign in, set chairs and the BMO opening balance in Settings, add stylists, then import a CSV.

### Bank sync

- Vercel env, Production and Preview: `BANK_TOKEN_KEY` (encrypts the stored SimpleFIN Access URL), `CRON_SECRET`, and `ANTHROPIC_API_KEY` (optional; enables AI category suggestions), plus the existing `DATABASE_URL` / `SESSION_SECRET`. See `.env.example`.
- **Never rotate `BANK_TOKEN_KEY` casually.** The stored connection can't be decrypted with a new key, so you'd have to re-link.
- To link: in SimpleFIN Bridge, create a setup token, paste it in Settings → Bank connection, then pick the account and a start date.
- A Vercel Cron syncs daily at 11:00 UTC; "Sync now" in Settings runs it on demand. The cron is a no-op until a bank is linked.
- Pending items: the feed only imports posted transactions.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit tests (CSV parsing, categorization, metrics) |
| `npm run typecheck` | TypeScript |
| `npm run db:generate` | New migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (Neon or PGlite) |
| `npm run db:seed` | Starter categories and settings (idempotent) |
| `npm run db:demo` | Sample data, PGlite only |
| `npm run db:wipe -- --yes` | Delete transactions, import batches, rules, CSV mappings and stylists (keeps users, categories, settings) |
| `npm run fake:bmo` | Generate a fabricated BMO CSV plus a `.truth.json` (see flags in `scripts/fake-bmo-csv.ts`; committed samples live in `fixtures/`) |
| `npm run fake:load -- <truth.json>` | Load the fake roster, chair count and opening balance (PGlite only unless `--yes`). Import the CSV through the app |
| `npm run fake:score -- <csv> <truth.json>` | Score the importer and categorizer against a truth file |
| `npm run bank:sync` | Run a bank sync from the command line (same as the cron) |
| `npm run user:add` | Create or reset a login |

## How it works

- **Money** is integer cents. Transactions are signed: positive in, negative out.
- **Categories** are income, expense, or transfer. Transfers (owner draws, contributions) are excluded from P&L but count toward the bank balance.
- **Import** parses the CSV (`src/lib/csv.ts`), detects columns, previews, then inserts. Each row gets a fingerprint so re-importing overlapping exports never double-counts.
- **Auto-categorizing** (`src/lib/categorize.ts`): money in whose description contains a stylist's match text becomes Booth Rent for that stylist; otherwise the first matching rule wins; otherwise it lands in the Inbox.
- **Splits** (`src/lib/splits.ts`, `src/lib/ledger.ts`): one bank row can be split into 2+ lines, each with its own category, stylist (required for Booth Rent), amount and memo, e.g. one Zelle covering two stylists' rent, or a Square deposit net of fees (+$103 sales, −$3 fees on +$100). The lines must add up exactly to the row, so the bank balance never changes. A split row has no category of its own (`transactions.is_split`; lines in `transaction_splits`) and is never in the Inbox, rules or AI suggestions. Everything that groups by category (dashboard, P&L, CSV exports) expands split rows into their lines with one function, `expandLedgerLines`.
- **Metrics** (`src/lib/metrics.ts`) are pure functions shared by the dashboard, reports and tests.
- **Reports are cash basis**: the app records cash in and out of the bank, so the P&L and both CSV exports are labelled "Cash basis" (compare against QuickBooks run on cash basis).
- **Auth** is two hand-made accounts (scrypt-hashed passwords, signed session cookie). `src/proxy.ts` guards pages; every server action and route handler re-checks.

## License

Copyright (C) 2026 John Blythe.

Licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its users the source code of your version.
