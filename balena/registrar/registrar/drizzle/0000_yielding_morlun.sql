CREATE TABLE "admin_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"outcome" text NOT NULL,
	"reason" text,
	"key_id" text,
	"source_ip" "inet",
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_log_outcome_check" CHECK ("delivery_log"."outcome" IN ('delivered','denied','admin'))
);
--> statement-breakpoint
CREATE TABLE "delivery_slots" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'armed' NOT NULL,
	"delivered_at" timestamp with time zone,
	"auto_rearm_after" interval DEFAULT '1 hour'::interval NOT NULL,
	"delivery_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "delivery_slots_state_check" CHECK ("delivery_slots"."state" IN ('armed','consumed'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"balena_uuid" uuid PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"registrar_key_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "devices_agent_name_unique" UNIQUE("agent_name"),
	CONSTRAINT "devices_status_check" CHECK ("devices"."status" IN ('pending','active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "identity_blobs" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"bundle" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_device_id_devices_balena_uuid_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("balena_uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD CONSTRAINT "delivery_slots_device_id_devices_balena_uuid_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("balena_uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_blobs" ADD CONSTRAINT "identity_blobs_device_id_devices_balena_uuid_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("balena_uuid") ON DELETE no action ON UPDATE no action;