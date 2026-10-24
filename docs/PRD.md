# PRD: L Marie Books — A Simple Salon Ledger

> Source of truth: https://claude.ai/artifact/G878NrWxKweVpZyrkKjQ8v (this file is a copy as of the first scaffold).

## Overview
L Marie Beauty Collective (L Marie Studio LLC) currently uses QuickBooks to track cash flow and keep P&L statements ready for taxes. QuickBooks is expensive, overfeatured, and unintuitive for this use. This app replaces it with a focused, mobile-friendly ledger built around the salon's single BMO business account.

## Goals
- Replace QuickBooks for the salon's bookkeeping needs.
- Make it fast to get transactions in (manual + CSV import).
- Give John and Lauren an at-a-glance view of business health.
- Produce tax-ready P&L output on demand.

## Non-Goals
- Lauren's personal Square stylist income (separate account, out of scope).
- Venmo reconciliation or batch-deposit splitting.
- Payroll, invoicing, or multi-entity accounting.
- Accountant-specific formats (TBD once the accountant weighs in).

## Users
- **Lauren** — owner and master stylist; checks health, categorizes, preps for taxes.
- **John** — co-operator; same capabilities. Two users, equal permissions.

## Context: How Money Moves
- All salon money flows through one **BMO business account**.
- Stylists pay booth rent directly via **Zelle** (and Venmo, ignored) into BMO.
- Expenses (rent, utilities, supplies, etc.) leave from BMO.

## Core Features (MVP)

### 1. Transaction Entry
- Manual one-off entry: date, amount, direction (in/out), category, payee/stylist, note.
- Edit and delete transactions.

### 2. CSV Import
- Upload a BMO CSV export.
- Column mapping on first import, saved for reuse.
- Duplicate detection (date + amount + description).
- Preview screen before committing.

### 3. Categorization
- Editable category list (income and expense).
- Rules: auto-categorize by description match (e.g. Zelle from a stylist's name → Booth Rent, tagged to that stylist).
- Uncategorized inbox for quick triage on phone.

### 4. Stylists & Booth Rent
- Stylist roster: name, chair, expected rent amount and cadence, active dates.
- Zelle payments matched to stylists by sender name.
- Expected vs. collected tracking per stylist per period.

### 5. Dashboard (Health Measures)
- **Monthly profit** with trend line.
- **Booth rent collected vs. expected**, flagging late/short stylists.
- **Chair occupancy** — filled chairs / total chairs (supports expansion planning).
- **Expenses by category** over time.
- **Cash runway** — months of expenses covered by current balance if rent stopped.

### 6. Reports
- P&L for any date range (month, quarter, year).
- Export to CSV and PDF for tax prep.

## Stretch Goals
- Automatic bank sync for BMO via an aggregator. Options:
  - **Plaid** — best coverage and polish; requires production approval, per-account fees.
  - **Teller** — clean API, free tier; narrower bank coverage (verify BMO).
  - **SimpleFIN Bridge** — ~$15/yr, read-only, built for personal/small use; less polished, connections can be flaky.
- Additional health metrics as discovered through use.
- Accountant-friendly category mapping (e.g. Schedule C lines) once requirements are known.

## Technical Approach
- **Frontend/App:** Next.js (App Router), responsive, mobile-first UI.
- **Hosting:** Vercel.
- **Database:** Neon (Postgres).
- **Auth:** Simple auth for two users.

## Success Criteria
- QuickBooks subscription cancelled.
- Monthly import + categorization takes under 10 minutes.
- Year-end P&L generated in one click.

## Open Questions
- What format will the accountant want?
- Is the chair count fixed, or does it change with expansion?
- How far back should historical data be imported from QuickBooks?
- Does BMO's CSV export include enough detail to identify Zelle senders?
