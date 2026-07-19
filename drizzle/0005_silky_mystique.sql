CREATE TYPE "public"."improvement_action_status" AS ENUM('planned', 'completed', 'skipped');--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" varchar(24) NOT NULL,
	"channel_title" varchar(200) NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"analysis_snapshot" jsonb NOT NULL,
	"regular_video_count" integer NOT NULL,
	"short_video_count" integer NOT NULL,
	"regular_average_views" bigint NOT NULL,
	"short_average_views" bigint NOT NULL,
	"ai_consult_snapshot" jsonb,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_consult_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_runs_channel_id_valid" CHECK (length("analysis_runs"."channel_id") = 24),
	CONSTRAINT "analysis_runs_counts_nonnegative" CHECK ("analysis_runs"."regular_video_count" >= 0
        AND "analysis_runs"."short_video_count" >= 0
        AND "analysis_runs"."regular_average_views" >= 0
        AND "analysis_runs"."short_average_views" >= 0),
	CONSTRAINT "analysis_runs_ai_consult_timestamp_consistent" CHECK (("analysis_runs"."ai_consult_snapshot" IS NULL AND "analysis_runs"."ai_consult_created_at" IS NULL)
        OR ("analysis_runs"."ai_consult_snapshot" IS NOT NULL AND "analysis_runs"."ai_consult_created_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "improvement_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"analysis_run_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"status" "improvement_action_status" DEFAULT 'planned' NOT NULL,
	"result_note" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "improvement_actions_text_valid" CHECK (length(btrim("improvement_actions"."title")) > 0
        AND length("improvement_actions"."description") <= 2000
        AND ("improvement_actions"."result_note" IS NULL OR length("improvement_actions"."result_note") <= 2000)),
	CONSTRAINT "improvement_actions_result_consistent" CHECK (("improvement_actions"."status" = 'planned' AND "improvement_actions"."result_note" IS NULL AND "improvement_actions"."completed_at" IS NULL)
        OR ("improvement_actions"."status" = 'completed' AND "improvement_actions"."result_note" IS NOT NULL AND length(btrim("improvement_actions"."result_note")) > 0 AND "improvement_actions"."completed_at" IS NOT NULL)
        OR ("improvement_actions"."status" = 'skipped' AND "improvement_actions"."result_note" IS NOT NULL AND length(btrim("improvement_actions"."result_note")) > 0 AND "improvement_actions"."completed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "improvement_actions" ADD CONSTRAINT "improvement_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_id_user_unique" ON "analysis_runs" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "improvement_actions" ADD CONSTRAINT "improvement_actions_owned_analysis_fk" FOREIGN KEY ("analysis_run_id","user_id") REFERENCES "public"."analysis_runs"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_user_analyzed_idx" ON "analysis_runs" USING btree ("user_id","analyzed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "improvement_actions_analysis_run_unique" ON "improvement_actions" USING btree ("analysis_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "improvement_actions_one_planned_per_user" ON "improvement_actions" USING btree ("user_id") WHERE "improvement_actions"."status" = 'planned';--> statement-breakpoint
CREATE INDEX "improvement_actions_user_updated_idx" ON "improvement_actions" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE FUNCTION "public"."finalize_channel_analysis_reservation"(
	"p_reservation_id" uuid,
	"p_user_id" uuid,
	"p_channel_id" varchar,
	"p_channel_title" varchar,
	"p_analysis_snapshot" jsonb,
	"p_regular_video_count" integer,
	"p_short_video_count" integer,
	"p_regular_average_views" bigint,
	"p_short_average_views" bigint,
	"p_analyzed_at" timestamp with time zone
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_analysis_run_id uuid;
BEGIN
	WITH consumed_lease AS (
		DELETE FROM public.usage_reservation_leases AS lease
		WHERE lease.id = p_reservation_id
			AND lease.user_id = p_user_id
			AND lease.metric = 'channel_analysis'
		RETURNING lease.id
	)
	INSERT INTO public.analysis_runs (
		user_id,
		channel_id,
		channel_title,
		snapshot_version,
		analysis_snapshot,
		regular_video_count,
		short_video_count,
		regular_average_views,
		short_average_views,
		analyzed_at,
		created_at,
		updated_at
	)
	SELECT
		p_user_id,
		p_channel_id,
		p_channel_title,
		1,
		p_analysis_snapshot,
		p_regular_video_count,
		p_short_video_count,
		p_regular_average_views,
		p_short_average_views,
		p_analyzed_at,
		p_analyzed_at,
		p_analyzed_at
	FROM consumed_lease
	RETURNING id INTO v_analysis_run_id;

	RETURN v_analysis_run_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."finalize_channel_analysis_reservation"(
	uuid,
	uuid,
	varchar,
	varchar,
	jsonb,
	integer,
	integer,
	bigint,
	bigint,
	timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "public"."finalize_ai_consult_reservation"(
	"p_reservation_id" uuid,
	"p_user_id" uuid,
	"p_analysis_run_id" uuid,
	"p_ai_consult_snapshot" jsonb,
	"p_created_at" timestamp with time zone
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
	WITH owned_run AS (
		SELECT run.id
		FROM public.analysis_runs AS run
		WHERE run.id = p_analysis_run_id
			AND run.user_id = p_user_id
	),
	consumed_lease AS (
		DELETE FROM public.usage_reservation_leases AS lease
		WHERE lease.id = p_reservation_id
			AND lease.user_id = p_user_id
			AND lease.metric = 'ai_consult'
			AND EXISTS (SELECT 1 FROM owned_run)
		RETURNING lease.id
	),
	updated_run AS (
		UPDATE public.analysis_runs AS run
		SET
			ai_consult_snapshot = p_ai_consult_snapshot,
			ai_consult_created_at = p_created_at,
			updated_at = p_created_at
		WHERE run.id = p_analysis_run_id
			AND run.user_id = p_user_id
			AND EXISTS (SELECT 1 FROM consumed_lease)
		RETURNING run.id
	)
	SELECT EXISTS (SELECT 1 FROM updated_run);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."finalize_ai_consult_reservation"(
	uuid,
	uuid,
	uuid,
	jsonb,
	timestamp with time zone
) FROM PUBLIC;
