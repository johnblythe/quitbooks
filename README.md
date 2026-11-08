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
DATABASE_URL="$(cs production --pooled)" npm run user:add -- john@… "John" # hidden password prompt
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

### Rebuild disposable test books

The committed `fixtures/bmo-fake-12mo-{single,split}.csv` files each contain 439 fake transactions;
their `.truth.json` companions contain the roster, opening balance and expected answers.
`fixtures/simplefin-demo.json` is a saved fake bank-feed response. None requires live bank access.

After `db:migrate` and creating a test login, restore the default fixture with:

```bash
DATABASE_URL=pglite:./.pglite npm run fake:restore
# Explicit opt-in for the disposable Neon dev database only:
DATABASE_URL="$(neon connection-string dev --database-name quitbooks --role-name quitbooks_owner)" npm run fake:restore -- --yes
```

Restore uses the real CSV parser, duplicate detection and import writer. Running it twice does not
duplicate transactions. It refuses books with bank-feed history and never wipes existing data.
To clear bookkeeping data first, use `npm run db:wipe -- --yes` against your **local/dev** database,
then run `fake:restore` again. Users and passwords survive the wipe. Never run either against production.

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit tests (CSV parsing, categorization, metrics) |
| `npm run typecheck` | TypeScript |
| `npm run db:generate` | New migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (Neon or PGlite) |
| `npm run db:seed` | Starter categories and settings (idempotent) |
| `npm run db:demo` | Sample data, PGlite only |
| `npm run db:wipe -- --yes` | Delete transactions, import batches, rules, CSV mappings and stylists, and make the bank feed's next sync re-fetch from its start date (keeps users, categories, settings and the bank link) |
| `npm run fake:bmo` | Generate a fabricated BMO CSV plus a `.truth.json` (see flags in `scripts/fake-bmo-csv.ts`; committed samples live in `fixtures/`) |
| `npm run fake:load -- <truth.json>` | Load the fake roster, chair count and opening balance (PGlite only unless `--yes`). Import the CSV through the app |
| `npm run fake:score -- <csv> <truth.json>` | Score the importer and categorizer against a truth file |
| `npm run bank:sync` | Run a bank sync from the command line (same as the cron) |
| `npm run user:add` | Create or reset a login |
| `npm run qbo:compare -- <pnl.csv>` | Read-only: compare our P&L with a QuickBooks P&L by Month export (see below) |

## Checking against QuickBooks

`npm run qbo:compare` checks our cash-basis P&L against QuickBooks, month by month and category by category. History imported from QuickBooks (Jan–Sep 2026) must match to the penny. From October on, it checks the bank feed plus Inbox sorting against QuickBooks' own numbers.

Export three reports from QuickBooks Online, all **Cash basis**:

1. **Transaction Detail by Account**, for the BMO account only, all dates. This is the history we import (see "Import with categories" below).
2. **Profit and Loss by Month** (Profit and Loss, Display columns by: Months), covering the months to check. This is what `qbo:compare` reads.
3. **Balance Sheet** as of the bank feed's start date. It gives the BMO balance where imported history hands over to the feed.

Run it against production. It is read-only: it reads inside a `READ ONLY` transaction, and Postgres refuses any write.

```bash
DATABASE_URL="$(cs production --pooled)" npm run qbo:compare -- <pnl.csv> --to 2026-09
```

- Options:
  - `--from YYYY-MM` and `--to YYYY-MM`: the default is every month in the file, and asking for a month the file doesn't have is an error;
  - `--tolerance-cents N`: default 0, applied to each cell and to each month's income, expenses and net, so small differences can't add up unseen;
  - `--out report.md`: also write the report to a file;
  - `--map map.json`.
- Output (Markdown):
  - which database was read: host and database name plus the Neon endpoint id (`ep-…`, which tells the production and dev branches apart), or "local PGlite";
  - problems in the QuickBooks file itself;
  - income, expenses, Inbox net and net per month, with Net Income taken from QuickBooks' own Net Income row;
  - every month × category cell that differs, with the QuickBooks accounts that feed it and our transactions in it;
  - the Inbox totals per month;
  - the account mapping.
- How money is counted:
  - Income and expenses are counted by our category on both sides. A QuickBooks income account mapped to one of our expense categories (a supplies refund) counts as a negative expense on both sides, so it can match.
  - The Inbox is compared as one net amount per month (money in − money out) against the QuickBooks accounts mapped to it, usually the placeholders. A placeholder nets a purchase and its refund inside one account, so comparing each direction separately would show two false mismatches. The Inbox net sits outside income and expenses, and every month's net includes it.
  - So netting can't hide money, there is also a gross check. Add up each Inbox-mapped QuickBooks account's month amount, ignoring signs: that can't be more than our Inbox money in plus money out (beyond the tolerance). If it is, the month is a mismatch, counted once: when the month's Inbox difference already shows the money, that difference is the mismatch. A shortfall within the tolerance is still listed. An example is the same $500 in Uncategorized Income and in Uncategorized Expense with nothing in our Inbox: the nets agree, but the gross check fails.
  - Unmapped QuickBooks accounts are kept apart by direction, so a "Misc" in Income and a "Misc" in Expenses are two cells.
- Exit codes:
  - 0: the last line is `MATCH: <first month> to <last month> (N months)`;
  - 1: the last line is `N mismatches, total abs diff $X`;
  - 2: it couldn't compare (bad options, a file it can't read or place, a database error), and the error is on stderr. That includes a `DATABASE_URL` with an unencoded `@`, `/`, `?` or `#` in its user or password: it is refused before connecting, because part of the password would be taken for the host. Percent-encode them (`@` is `%40`).
- MATCH needs every cell and every month total to agree within the tolerance.
  - It also needs the file to agree with itself: every section and parent Total, Gross Profit and Net Income must equal its accounts, a Net Income row must be present, and the report must not be Accrual.
  - A partial first or last month (`Jan 15-31, 2026`) is compared for its days only, on both sides. Even when you asked for the whole month with `--from`/`--to`, a `WARNING: partial month` line right above the verdict says which dates were compared.
- A row the parser can't place stops the run (exit 2) with its line number. That covers:
  - an amount outside any section, or with no account name;
  - a "Total …" row that closes nothing;
  - a summary-looking row it doesn't know (e.g. `Net Earnings`);
  - an amount that isn't under a month heading, such as an unquoted `1,800.00`;
  - a "Cash Basis …" row with amounts, wherever it is;
  - month columns with a gap.
- It also reads:
  - a file opened and re-saved in Excel: `Jan-26` / `Jan 26` month headers (a two-digit year only after a 3-letter month), ` - ` zeros and `$ (12.00)` negatives;
  - a first column that is blank on every line;
  - the date stamp on a line of its own, in the preamble or after Net Income;
  - summary rows ending in `(Loss)`, such as `Net Income (Loss)`, which are cross-checked like the others.

  Exporting the CSV straight from QuickBooks, without re-saving it, is still the safest.
- Mapping QuickBooks accounts to our categories:
  - a `--map` file wins: `{"QuickBooks account": "Our category"}`, with `"Inbox"` meaning uncategorized;
  - then the choices saved by the QuickBooks import;
  - then the same name, in any case;
  - then QuickBooks placeholders (Uncategorized Income/Expense, Ask My Accountant) map to our Inbox.

  Sub-accounts roll up to their parent when only the parent matches. Unmapped accounts, and our categories that nothing maps to, are listed.
- The P&L layout is written from memory and unverified against a real export; the assumptions are listed at the top of `src/lib/qbo-pnl.ts`. If Lauren's file trips the parser, it says which line and why.

## How it works

- **Money** is integer cents. Transactions are signed: positive in, negative out.
- **Categories** are income, expense, or transfer. Transfers (owner draws, contributions) are excluded from P&L but count toward the bank balance.
- **Import** parses the CSV (`src/lib/csv.ts`), detects columns, previews, then inserts. Each row gets a fingerprint so re-importing overlapping exports never double-counts.
- **Import with categories** (`src/lib/import-categories.ts`): if the CSV has a category column (QuickBooks "Transaction Detail by Account" puts it in `Split`), the preview lists each distinct value to map to one of ours, create, or leave for the Inbox. A mapped category beats rules; Booth Rent still needs a stylist match or the row goes to the Inbox. The choices are saved inside the saved column mapping (`csv_mappings`, name `BMO:categories`). In QuickBooks Online: Reports, **Transaction Detail by Account** for the BMO account, all dates, **Cash basis**, Export (if only Excel is offered, Save As CSV). The report layout is written from memory and unverified against a real export. Importing QuickBooks bank rules is not done, because that file's format is unverified.
- **Auto-categorizing** (`src/lib/categorize.ts`): money in whose description contains a stylist's match text becomes Booth Rent for that stylist; otherwise the first matching rule wins; otherwise it lands in the Inbox.
- **Splits** (`src/lib/splits.ts`, `src/lib/ledger.ts`): one bank row can be split into 2+ lines, each with its own category, stylist (required for Booth Rent), amount and memo, e.g. one Zelle covering two stylists' rent, or a Square deposit net of fees (+$103 sales, −$3 fees on +$100). The lines must add up exactly to the row, so the bank balance never changes. A split row has no category of its own (`transactions.is_split`; lines in `transaction_splits`) and is never in the Inbox, rules or AI suggestions. Everything that groups by category (dashboard, P&L, CSV exports) expands split rows into their lines with one function, `expandLedgerLines`.
- **Metrics** (`src/lib/metrics.ts`) are pure functions shared by the dashboard, reports and tests.
- **Reports are cash basis**: the app records cash in and out of the bank, so the P&L and both CSV exports are labelled "Cash basis" (compare against QuickBooks run on cash basis).
- **Auth** is two hand-made accounts (scrypt-hashed passwords, signed session cookie). `src/proxy.ts` guards pages; every server action and route handler re-checks.

## License

Copyright (C) 2026 John Blythe.

Licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its users the source code of your version.
