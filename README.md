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

1. Import this repo in Vercel: https://vercel.com/new
2. In the Vercel project, add the Neon integration (Storage → Neon). It sets `DATABASE_URL`.
3. Add `SESSION_SECRET` in Project Settings → Environment Variables (32+ random characters).
4. From your machine, with `DATABASE_URL` pointed at Neon in `.env`:
   ```bash
   npm run db:migrate
   npm run db:seed
   npm run user:add -- john@… "John" "…"
   npm run user:add -- lauren@… "Lauren" "…"
   ```
5. Deploy. Sign in, set chairs and the BMO opening balance in Settings, add stylists, then import a CSV.

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
| `npm run user:add` | Create or reset a login |

## How it works

- **Money** is integer cents. Transactions are signed: positive in, negative out.
- **Categories** are income, expense, or transfer. Transfers (owner draws, contributions) are excluded from P&L but count toward the bank balance.
- **Import** parses the CSV (`src/lib/csv.ts`), detects columns, previews, then inserts. Each row gets a fingerprint so re-importing overlapping exports never double-counts.
- **Auto-categorizing** (`src/lib/categorize.ts`): money in whose description contains a stylist's match text becomes Booth Rent for that stylist; otherwise the first matching rule wins; otherwise it lands in the Inbox.
- **Metrics** (`src/lib/metrics.ts`) are pure functions shared by the dashboard, reports and tests.
- **Auth** is two hand-made accounts (scrypt-hashed passwords, signed session cookie). `src/proxy.ts` guards pages; every server action and route handler re-checks.

## License

Copyright (C) 2026 John Blythe.

Licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its users the source code of your version.
