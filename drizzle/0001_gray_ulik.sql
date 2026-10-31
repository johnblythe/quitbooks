CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" text NOT NULL,
	"ok" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "login_attempts_email_at_idx" ON "login_attempts" USING btree ("email","at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at_idx" ON "login_attempts" USING btree ("ip","at");