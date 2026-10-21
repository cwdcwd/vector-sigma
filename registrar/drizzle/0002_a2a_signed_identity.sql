CREATE TABLE "a2a_public_keys" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"ed25519" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"conflict_ed25519" text,
	"conflict_fingerprint" text,
	"conflict_at" timestamp with time zone,
	"guard_status" jsonb,
	"reported_bundle_version" integer,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_public_keys_status_check" CHECK ("a2a_public_keys"."status" IN ('active','pending'))
);
--> statement-breakpoint
CREATE TABLE "mesh_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"strict" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "a2a_public_keys" ADD CONSTRAINT "a2a_public_keys_device_id_devices_balena_uuid_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("balena_uuid") ON DELETE no action ON UPDATE no action;