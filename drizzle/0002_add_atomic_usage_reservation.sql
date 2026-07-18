ALTER TYPE "public"."usage_metric" RENAME VALUE 'analysis' TO 'channel_analysis';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reserve_usage_limits"(
	"p_user_id" uuid,
	"p_session_version" integer,
	"p_metric" "public"."usage_metric",
	"p_now" timestamp with time zone DEFAULT statement_timestamp()
)
RETURNS TABLE (
	"allowed" boolean,
	"denial_reason" text,
	"metric" "public"."usage_metric",
	"daily_used" integer,
	"daily_limit" integer,
	"daily_reset_at" timestamp with time zone,
	"monthly_used" integer,
	"monthly_limit" integer,
	"monthly_reset_at" timestamp with time zone,
	"plan_code" varchar
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
	v_now timestamp with time zone := COALESCE(p_now, statement_timestamp());
	v_daily_start timestamp with time zone;
	v_monthly_start timestamp with time zone;
	v_daily_reset timestamp with time zone;
	v_monthly_reset timestamp with time zone;
	v_user_status "public"."user_status";
	v_database_session_version integer;
	v_plan_code varchar(32);
	v_daily_limit integer;
	v_monthly_limit integer;
	v_daily_used integer := 0;
	v_monthly_used integer := 0;
BEGIN
	v_daily_start := date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
	v_monthly_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
	v_daily_reset := v_daily_start + interval '1 day';
	v_monthly_reset := v_monthly_start + interval '1 month';

	SELECT u.status, u.session_version
	INTO v_user_status, v_database_session_version
	FROM public.users AS u
	WHERE u.id = p_user_id
	FOR SHARE OF u;

	IF NOT FOUND THEN
		RETURN QUERY SELECT
			false,
			'user_not_found'::text,
			p_metric,
			NULL::integer,
			NULL::integer,
			v_daily_reset,
			NULL::integer,
			NULL::integer,
			v_monthly_reset,
			NULL::varchar;
		RETURN;
	END IF;

	IF v_user_status <> 'active' THEN
		RETURN QUERY SELECT
			false,
			'user_inactive'::text,
			p_metric,
			NULL::integer,
			NULL::integer,
			v_daily_reset,
			NULL::integer,
			NULL::integer,
			v_monthly_reset,
			NULL::varchar;
		RETURN;
	END IF;

	IF v_database_session_version <> p_session_version THEN
		RETURN QUERY SELECT
			false,
			'session_version_mismatch'::text,
			p_metric,
			NULL::integer,
			NULL::integer,
			v_daily_reset,
			NULL::integer,
			NULL::integer,
			v_monthly_reset,
			NULL::varchar;
		RETURN;
	END IF;

	SELECT
		upa.plan_code,
		CASE p_metric
			WHEN 'channel_analysis' THEN p.analysis_daily_limit
			WHEN 'ai_consult' THEN p.ai_daily_limit
		END,
		CASE p_metric
			WHEN 'channel_analysis' THEN p.analysis_monthly_limit
			WHEN 'ai_consult' THEN p.ai_monthly_limit
		END
	INTO v_plan_code, v_daily_limit, v_monthly_limit
	FROM public.user_plan_assignments AS upa
	INNER JOIN public.plans AS p ON p.code = upa.plan_code
	WHERE upa.user_id = p_user_id
		AND upa.status = 'active'
		AND upa.starts_at <= v_now
		AND (upa.ends_at IS NULL OR upa.ends_at > v_now)
		AND p.active = true
	LIMIT 1
	FOR SHARE OF upa, p;

	IF NOT FOUND OR v_daily_limit IS NULL OR v_monthly_limit IS NULL THEN
		RETURN QUERY SELECT
			false,
			'no_active_plan'::text,
			p_metric,
			NULL::integer,
			NULL::integer,
			v_daily_reset,
			NULL::integer,
			NULL::integer,
			v_monthly_reset,
			NULL::varchar;
		RETURN;
	END IF;

	PERFORM pg_advisory_xact_lock(
		hashtextextended(
			'usage:' || p_user_id::text || ':' || p_metric::text,
			0
		)
	);

	SELECT COALESCE(MAX(b.used_count), 0)
	INTO v_daily_used
	FROM public.user_usage_buckets AS b
	WHERE b.user_id = p_user_id
		AND b.metric = p_metric
		AND b.period_kind = 'day'
		AND b.period_start = v_daily_start;

	SELECT COALESCE(MAX(b.used_count), 0)
	INTO v_monthly_used
	FROM public.user_usage_buckets AS b
	WHERE b.user_id = p_user_id
		AND b.metric = p_metric
		AND b.period_kind = 'month'
		AND b.period_start = v_monthly_start;

	IF v_daily_used >= v_daily_limit THEN
		RETURN QUERY SELECT
			false,
			'daily_limit_reached'::text,
			p_metric,
			v_daily_used,
			v_daily_limit,
			v_daily_reset,
			v_monthly_used,
			v_monthly_limit,
			v_monthly_reset,
			v_plan_code;
		RETURN;
	END IF;

	IF v_monthly_used >= v_monthly_limit THEN
		RETURN QUERY SELECT
			false,
			'monthly_limit_reached'::text,
			p_metric,
			v_daily_used,
			v_daily_limit,
			v_daily_reset,
			v_monthly_used,
			v_monthly_limit,
			v_monthly_reset,
			v_plan_code;
		RETURN;
	END IF;

	INSERT INTO public.user_usage_buckets AS daily_bucket (
		user_id,
		metric,
		period_kind,
		period_start,
		used_count,
		limit_snapshot,
		created_at,
		updated_at
	)
	VALUES (
		p_user_id,
		p_metric,
		'day',
		v_daily_start,
		1,
		v_daily_limit,
		v_now,
		v_now
	)
	ON CONFLICT (user_id, metric, period_kind, period_start) DO UPDATE
	SET
		used_count = daily_bucket.used_count + 1,
		limit_snapshot = EXCLUDED.limit_snapshot,
		updated_at = v_now;

	INSERT INTO public.user_usage_buckets AS monthly_bucket (
		user_id,
		metric,
		period_kind,
		period_start,
		used_count,
		limit_snapshot,
		created_at,
		updated_at
	)
	VALUES (
		p_user_id,
		p_metric,
		'month',
		v_monthly_start,
		1,
		v_monthly_limit,
		v_now,
		v_now
	)
	ON CONFLICT (user_id, metric, period_kind, period_start) DO UPDATE
	SET
		used_count = monthly_bucket.used_count + 1,
		limit_snapshot = EXCLUDED.limit_snapshot,
		updated_at = v_now;

	RETURN QUERY SELECT
		true,
		NULL::text,
		p_metric,
		v_daily_used + 1,
		v_daily_limit,
		v_daily_reset,
		v_monthly_used + 1,
		v_monthly_limit,
		v_monthly_reset,
		v_plan_code;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reserve_usage_limits"(
	uuid,
	integer,
	"public"."usage_metric",
	timestamp with time zone
) FROM PUBLIC;
