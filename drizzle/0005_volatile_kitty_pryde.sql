ALTER TABLE "bank_accounts" ADD COLUMN "conn_id" text;--> statement-breakpoint
ALTER TABLE "bank_sync_runs" ADD COLUMN "requests" integer DEFAULT 0 NOT NULL;