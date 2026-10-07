CREATE TABLE "mesh_enroll_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"agent_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gateway_creator_key" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mesh_enroll_keys" ADD CONSTRAINT "mesh_enroll_keys_agent_name_unique" UNIQUE("agent_name");
--> statement-breakpoint
ALTER TABLE "gateway_creator_key" ADD CONSTRAINT "gateway_creator_key_alias_unique" UNIQUE("alias");