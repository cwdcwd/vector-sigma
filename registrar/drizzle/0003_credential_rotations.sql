CREATE TABLE "credential_rotations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"device_id" uuid,
	"agent_name" text NOT NULL,
	"old_alias" text NOT NULL,
	"new_alias" text NOT NULL,
	"old_token" text,
	"new_token" text,
	"new_bundle_version" integer,
	"payload" jsonb,
	"status" text DEFAULT 'delivering' NOT NULL,
	"gateway_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"flip_at" timestamp with time zone,
	"target_confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "credential_rotations_kind_check" CHECK ("credential_rotations"."kind" IN ('a2a_identity','model_key')),
	CONSTRAINT "credential_rotations_status_check" CHECK ("credential_rotations"."status" IN ('delivering','awaiting_target','awaiting_revoke','completed'))
);
--> statement-breakpoint
ALTER TABLE "credential_rotations" ADD CONSTRAINT "credential_rotations_device_id_devices_balena_uuid_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("balena_uuid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "bundle_reports" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"applied_version" integer NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_reports" ADD CONSTRAINT "bundle_reports_device_id_devices_balena_uuid_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("balena_uuid") ON DELETE no action ON UPDATE no action;