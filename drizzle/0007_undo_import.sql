ALTER TABLE "import_batches" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "undone_by" uuid;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;