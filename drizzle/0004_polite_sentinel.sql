ALTER TABLE "bank_accounts" DROP CONSTRAINT "bank_accounts_connection_id_bank_connections_id_fk";
--> statement-breakpoint
DROP INDEX "bank_accounts_conn_ext_idx";--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "full_sync_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "last_warning" text;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_ext_idx" ON "bank_accounts" USING btree ("external_id");