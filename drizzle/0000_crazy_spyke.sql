CREATE TYPE "public"."plan_assignment_source" AS ENUM('system', 'manual');--> statement-breakpoint
CREATE TYPE "public"."plan_assignment_status" AS ENUM('active', 'inactive', 'expired');--> statement-breakpoint
CREATE TYPE "public"."usage_metric" AS ENUM('analysis', 'ai_consult');--> statement-breakpoint
CREATE TYPE "public"."usage_period_kind" AS ENUM('day', 'month');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"granted_scope" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"analysis_daily_limit" integer NOT NULL,
	"analysis_monthly_limit" integer NOT NULL,
	"ai_daily_limit" integer NOT NULL,
	"ai_monthly_limit" integer NOT NULL,
	"regular_video_limit" integer NOT NULL,
	"shorts_video_limit" integer NOT NULL,
	"history_retention_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_not_empty" CHECK (length("plans"."code") > 0),
	CONSTRAINT "plans_limits_nonnegative" CHECK ("plans"."analysis_daily_limit" >= 0
        AND "plans"."analysis_monthly_limit" >= 0
        AND "plans"."ai_daily_limit" >= 0
        AND "plans"."ai_monthly_limit" >= 0
        AND "plans"."regular_video_limit" >= 0
        AND "plans"."shorts_video_limit" >= 0),
	CONSTRAINT "plans_history_retention_positive" CHECK ("plans"."history_retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_plan_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"status" "plan_assignment_status" DEFAULT 'active' NOT NULL,
	"source" "plan_assignment_source" DEFAULT 'system' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_plan_assignments_valid_period" CHECK ("user_plan_assignments"."ends_at" IS NULL OR "user_plan_assignments"."ends_at" > "user_plan_assignments"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "user_usage_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"metric" "usage_metric" NOT NULL,
	"period_kind" "usage_period_kind" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"limit_snapshot" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_buckets_counts_valid" CHECK ("user_usage_buckets"."used_count" >= 0
        AND "user_usage_buckets"."limit_snapshot" >= 0
        AND "user_usage_buckets"."used_count" <= "user_usage_buckets"."limit_snapshot")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320),
	"name" varchar(200),
	"image_url" varchar(2048),
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_session_version_positive" CHECK ("users"."session_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plan_assignments" ADD CONSTRAINT "user_plan_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plan_assignments" ADD CONSTRAINT "user_plan_assignments_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage_buckets" ADD CONSTRAINT "user_usage_buckets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_provider_account_unique" ON "oauth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_plan_assignments_one_active_per_user" ON "user_plan_assignments" USING btree ("user_id") WHERE "user_plan_assignments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "user_plan_assignments_plan_code_idx" ON "user_plan_assignments" USING btree ("plan_code");--> statement-breakpoint
CREATE UNIQUE INDEX "user_usage_buckets_scope_unique" ON "user_usage_buckets" USING btree ("user_id","metric","period_kind","period_start");--> statement-breakpoint
CREATE INDEX "user_usage_buckets_period_start_idx" ON "user_usage_buckets" USING btree ("period_start");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
INSERT INTO "plans" (
	"code",
	"name",
	"analysis_daily_limit",
	"analysis_monthly_limit",
	"ai_daily_limit",
	"ai_monthly_limit",
	"regular_video_limit",
	"shorts_video_limit",
	"history_retention_days",
	"active"
)
VALUES ('free', 'Free', 2, 5, 1, 3, 10, 10, 90, true)
ON CONFLICT ("code") DO UPDATE
SET
	"name" = EXCLUDED."name",
	"analysis_daily_limit" = EXCLUDED."analysis_daily_limit",
	"analysis_monthly_limit" = EXCLUDED."analysis_monthly_limit",
	"ai_daily_limit" = EXCLUDED."ai_daily_limit",
	"ai_monthly_limit" = EXCLUDED."ai_monthly_limit",
	"regular_video_limit" = EXCLUDED."regular_video_limit",
	"shorts_video_limit" = EXCLUDED."shorts_video_limit",
	"history_retention_days" = EXCLUDED."history_retention_days",
	"active" = EXCLUDED."active",
	"updated_at" = now();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."sync_google_oauth_account"(
	"p_provider_account_id" varchar,
	"p_email" varchar,
	"p_name" varchar,
	"p_image_url" varchar,
	"p_granted_scope" text,
	"p_seen_at" timestamp with time zone
)
RETURNS TABLE (
	"user_id" uuid,
	"account_status" "public"."user_status",
	"session_version" integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_user_id uuid;
BEGIN
	IF p_provider_account_id IS NULL OR length(p_provider_account_id) = 0 THEN
		RAISE EXCEPTION 'Google provider account ID is required';
	END IF;

	PERFORM pg_advisory_xact_lock(
		hashtextextended('google:' || p_provider_account_id, 0)
	);

	SELECT oa.user_id
	INTO v_user_id
	FROM public.oauth_accounts AS oa
	WHERE oa.provider = 'google'
		AND oa.provider_account_id = p_provider_account_id;

	IF v_user_id IS NULL THEN
		INSERT INTO public.users (
			email,
			name,
			image_url,
			last_login_at,
			created_at,
			updated_at
		)
		VALUES (
			p_email,
			p_name,
			p_image_url,
			p_seen_at,
			p_seen_at,
			p_seen_at
		)
		RETURNING id INTO v_user_id;

		INSERT INTO public.oauth_accounts (
			user_id,
			provider,
			provider_account_id,
			granted_scope,
			last_seen_at,
			created_at,
			updated_at
		)
		VALUES (
			v_user_id,
			'google',
			p_provider_account_id,
			p_granted_scope,
			p_seen_at,
			p_seen_at,
			p_seen_at
		);
	ELSE
		UPDATE public.oauth_accounts
		SET
			granted_scope = COALESCE(
				p_granted_scope,
				public.oauth_accounts.granted_scope
			),
			last_seen_at = p_seen_at,
			updated_at = p_seen_at
		WHERE provider = 'google'
			AND provider_account_id = p_provider_account_id;

		UPDATE public.users
		SET
			email = CASE
				WHEN public.users.status = 'active'
					THEN COALESCE(p_email, public.users.email)
				ELSE public.users.email
			END,
			name = CASE
				WHEN public.users.status = 'active'
					THEN COALESCE(p_name, public.users.name)
				ELSE public.users.name
			END,
			image_url = CASE
				WHEN public.users.status = 'active'
					THEN COALESCE(p_image_url, public.users.image_url)
				ELSE public.users.image_url
			END,
			last_login_at = CASE
				WHEN public.users.status = 'active'
					THEN p_seen_at
				ELSE public.users.last_login_at
			END,
			updated_at = CASE
				WHEN public.users.status = 'active'
					THEN p_seen_at
				ELSE public.users.updated_at
			END
		WHERE id = v_user_id;
	END IF;

	INSERT INTO public.user_plan_assignments (
		user_id,
		plan_code,
		status,
		source,
		starts_at,
		created_at,
		updated_at
	)
	SELECT
		v_user_id,
		'free',
		'active',
		'system',
		p_seen_at,
		p_seen_at,
		p_seen_at
	WHERE EXISTS (
		SELECT 1
		FROM public.users AS active_user
		WHERE active_user.id = v_user_id
			AND active_user.status = 'active'
	)
	ON CONFLICT (user_id) WHERE status = 'active' DO NOTHING;

	RETURN QUERY
	SELECT u.id, u.status, u.session_version
	FROM public.users AS u
	WHERE u.id = v_user_id;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."sync_google_oauth_account"(
	varchar,
	varchar,
	varchar,
	varchar,
	text,
	timestamp with time zone
) FROM PUBLIC;
