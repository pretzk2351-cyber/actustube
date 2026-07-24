DO $usage_acl_preflight$
DECLARE
	v_legacy_oid oid;
	v_legacy_count integer;
	v_legacy_owner oid;
	v_legacy_security_definer boolean;
	v_legacy_search_path text[];
	v_legacy_acl aclitem[];
	v_legacy_volatility "char";
	v_public_execute boolean;
	v_public_schema oid;
BEGIN
	SELECT COUNT(*)::integer, (ARRAY_AGG(p.oid))[1]
	INTO v_legacy_count, v_legacy_oid
	FROM pg_catalog.pg_proc AS p
	INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
	WHERE n.nspname = 'public'
		AND p.proname = 'reserve_usage_limits'
		AND p.proargtypes = ARRAY[
			'uuid'::pg_catalog.regtype::oid,
			'integer'::pg_catalog.regtype::oid,
			'public.usage_metric'::pg_catalog.regtype::oid,
			'timestamp with time zone'::pg_catalog.regtype::oid
		]::oidvector;

	IF v_legacy_count <> 1 OR v_legacy_oid IS NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function permission baseline is unavailable.';
	END IF;

	SELECT
		p.proowner,
		p.prosecdef,
		p.proconfig,
		p.proacl,
		p.provolatile,
		n.oid
	INTO
		v_legacy_owner,
		v_legacy_security_definer,
		v_legacy_search_path,
		v_legacy_acl,
		v_legacy_volatility,
		v_public_schema
	FROM pg_catalog.pg_proc AS p
	INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
	WHERE p.oid = v_legacy_oid;

	IF
		v_legacy_owner IS NULL
		OR v_legacy_security_definer IS NULL
		OR v_legacy_volatility IS DISTINCT FROM 'v'::"char"
		OR v_legacy_search_path IS DISTINCT FROM ARRAY[
			'search_path=public, pg_temp'
		]::text[]
		OR v_legacy_acl IS NULL
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function permission baseline is unsafe.';
	END IF;

	BEGIN
		SELECT EXISTS (
			SELECT 1
			FROM pg_catalog.aclexplode(
				COALESCE(
					v_legacy_acl,
					pg_catalog.acldefault('f', v_legacy_owner)
				)
			) AS acl
			WHERE acl.grantee = 0
				AND acl.privilege_type = 'EXECUTE'
		)
		INTO v_public_execute;
	EXCEPTION
		WHEN OTHERS THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'Usage function ACL cannot be inspected safely.';
	END;

	IF v_public_execute IS DISTINCT FROM false THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function execution depends on PUBLIC.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM pg_catalog.aclexplode(v_legacy_acl) AS acl
		WHERE acl.privilege_type <> 'EXECUTE'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function ACL contains an unsupported privilege.';
	END IF;

	IF
		NOT pg_catalog.pg_has_role(
			current_user::pg_catalog.regrole::oid,
			v_legacy_owner,
			'MEMBER'
		)
		OR NOT pg_catalog.has_schema_privilege(
			current_user::pg_catalog.regrole::oid,
			v_public_schema,
			'CREATE'
		)
		OR NOT pg_catalog.has_schema_privilege(
			v_legacy_owner,
			v_public_schema,
			'CREATE'
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function ownership cannot be preserved safely.';
	END IF;

	PERFORM pg_catalog.set_config(
		'actustube.usage_acl_source_oid',
		v_legacy_oid::text,
		true
	);
	PERFORM pg_catalog.set_config(
		'actustube.usage_acl_source_owner',
		v_legacy_owner::text,
		true
	);
	PERFORM pg_catalog.set_config(
		'actustube.usage_acl_source_security_definer',
		v_legacy_security_definer::text,
		true
	);
	PERFORM pg_catalog.set_config(
		'actustube.usage_acl_source_hash',
		pg_catalog.md5(v_legacy_acl::text),
		true
	);
END;
$usage_acl_preflight$;
--> statement-breakpoint
CREATE FUNCTION "public"."usage_period_boundaries_v1"(
	"p_now" timestamp with time zone DEFAULT statement_timestamp()
)
RETURNS TABLE (
	"daily_period_start" timestamp with time zone,
	"daily_reset_at" timestamp with time zone,
	"monthly_period_start" timestamp with time zone,
	"monthly_reset_at" timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
	WITH normalized AS (
		SELECT COALESCE(p_now, statement_timestamp()) AS effective_now
	), boundaries AS (
		SELECT
			date_trunc('day', source.effective_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS daily_start,
			date_trunc('month', source.effective_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS monthly_start
		FROM normalized AS source
	)
	SELECT
		daily_start,
		daily_start + interval '1 day',
		monthly_start,
		monthly_start + interval '1 month'
	FROM boundaries;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."usage_period_boundaries_v1"(
	timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "public"."resolve_effective_usage_plan_v1"(
	"p_user_id" uuid,
	"p_now" timestamp with time zone DEFAULT statement_timestamp()
)
RETURNS TABLE (
	"effective_plan_id" varchar,
	"canonical_plan_key" varchar,
	"plan_kind" text,
	"analysis_daily_limit" integer,
	"analysis_monthly_limit" integer,
	"ai_daily_limit" integer,
	"ai_monthly_limit" integer,
	"regular_video_limit" integer,
	"shorts_video_limit" integer,
	"plan_from_assignment" boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
	v_now timestamp with time zone := COALESCE(p_now, statement_timestamp());
	v_active_assignment_count integer;
	v_free_plan_count integer;
	v_effective_plan_id varchar(32);
	v_plan_active boolean;
	v_analysis_daily_limit integer;
	v_analysis_monthly_limit integer;
	v_ai_daily_limit integer;
	v_ai_monthly_limit integer;
	v_regular_video_limit integer;
	v_shorts_video_limit integer;
	v_plan_from_assignment boolean;
	v_assignment_starts_at timestamp with time zone;
	v_assignment_ends_at timestamp with time zone;
BEGIN
	IF p_user_id IS NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'Usage plan input is invalid.';
	END IF;

	SELECT COUNT(*)::integer
	INTO v_active_assignment_count
	FROM public.user_plan_assignments AS upa
	WHERE upa.user_id = p_user_id
		AND upa.status = 'active';

	IF v_active_assignment_count > 1 THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage plan state is unavailable.';
	END IF;

	IF v_active_assignment_count = 1 THEN
		SELECT
			p.code,
			p.active,
			p.analysis_daily_limit,
			p.analysis_monthly_limit,
			p.ai_daily_limit,
			p.ai_monthly_limit,
			p.regular_video_limit,
			p.shorts_video_limit,
			upa.starts_at,
			upa.ends_at
		INTO
			v_effective_plan_id,
			v_plan_active,
			v_analysis_daily_limit,
			v_analysis_monthly_limit,
			v_ai_daily_limit,
			v_ai_monthly_limit,
			v_regular_video_limit,
			v_shorts_video_limit,
			v_assignment_starts_at,
			v_assignment_ends_at
		FROM public.user_plan_assignments AS upa
		LEFT JOIN public.plans AS p ON p.code = upa.plan_code
		WHERE upa.user_id = p_user_id
			AND upa.status = 'active'
		LIMIT 1;

		IF
			v_assignment_starts_at IS NULL
			OR v_assignment_starts_at > v_now
			OR (
				v_assignment_ends_at IS NOT NULL
				AND v_assignment_ends_at <= v_now
			)
			OR v_effective_plan_id IS NULL
			OR v_plan_active IS DISTINCT FROM true
		THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'Usage plan state is unavailable.';
		END IF;

		v_plan_from_assignment := true;
	ELSE
		SELECT COUNT(*)::integer
		INTO v_free_plan_count
		FROM public.plans AS p
		WHERE p.code = 'free';

		IF v_free_plan_count <> 1 THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'Canonical usage plan is unavailable.';
		END IF;

		SELECT
			p.code,
			p.active,
			p.analysis_daily_limit,
			p.analysis_monthly_limit,
			p.ai_daily_limit,
			p.ai_monthly_limit,
			p.regular_video_limit,
			p.shorts_video_limit
		INTO
			v_effective_plan_id,
			v_plan_active,
			v_analysis_daily_limit,
			v_analysis_monthly_limit,
			v_ai_daily_limit,
			v_ai_monthly_limit,
			v_regular_video_limit,
			v_shorts_video_limit
		FROM public.plans AS p
		WHERE p.code = 'free';

		v_plan_from_assignment := false;
	END IF;

	IF
		v_effective_plan_id IS DISTINCT FROM 'free'
		OR v_plan_active IS DISTINCT FROM true
		OR v_analysis_daily_limit IS DISTINCT FROM 2
		OR v_analysis_monthly_limit IS DISTINCT FROM 5
		OR v_ai_daily_limit IS DISTINCT FROM 1
		OR v_ai_monthly_limit IS DISTINCT FROM 3
		OR v_regular_video_limit IS DISTINCT FROM 10
		OR v_shorts_video_limit IS DISTINCT FROM 10
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage plan limits are unavailable.';
	END IF;

	RETURN QUERY SELECT
		v_effective_plan_id,
		'free'::varchar,
		'free'::text,
		v_analysis_daily_limit,
		v_analysis_monthly_limit,
		v_ai_daily_limit,
		v_ai_monthly_limit,
		v_regular_video_limit,
		v_shorts_video_limit,
		v_plan_from_assignment;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."resolve_effective_usage_plan_v1"(
	uuid,
	timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "public"."reserve_usage_limits_v2"(
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
	"plan_code" varchar,
	"reservation_id" uuid,
	"effective_plan_id" varchar,
	"canonical_plan_key" varchar,
	"plan_kind" text,
	"regular_video_limit" integer,
	"shorts_video_limit" integer,
	"plan_from_assignment" boolean
)
LANGUAGE plpgsql
VOLATILE
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
	v_effective_plan_id varchar(32);
	v_canonical_plan_key varchar(32);
	v_plan_kind text;
	v_analysis_daily_limit integer;
	v_analysis_monthly_limit integer;
	v_ai_daily_limit integer;
	v_ai_monthly_limit integer;
	v_regular_video_limit integer;
	v_shorts_video_limit integer;
	v_plan_from_assignment boolean;
	v_daily_limit integer;
	v_monthly_limit integer;
	v_daily_used integer := 0;
	v_monthly_used integer := 0;
	v_reservation_id uuid;
BEGIN
	SELECT
		boundaries.daily_period_start,
		boundaries.daily_reset_at,
		boundaries.monthly_period_start,
		boundaries.monthly_reset_at
	INTO
		v_daily_start,
		v_daily_reset,
		v_monthly_start,
		v_monthly_reset
	FROM public.usage_period_boundaries_v1(v_now) AS boundaries;

	SELECT u.status, u.session_version
	INTO v_user_status, v_database_session_version
	FROM public.users AS u
	WHERE u.id = p_user_id
	FOR SHARE OF u;

	IF NOT FOUND THEN
		RETURN QUERY SELECT
			false, 'user_not_found'::text, p_metric,
			NULL::integer, NULL::integer, v_daily_reset,
			NULL::integer, NULL::integer, v_monthly_reset,
			NULL::varchar, NULL::uuid,
			NULL::varchar, NULL::varchar, NULL::text,
			NULL::integer, NULL::integer, NULL::boolean;
		RETURN;
	END IF;

	IF v_user_status <> 'active' THEN
		RETURN QUERY SELECT
			false, 'user_inactive'::text, p_metric,
			NULL::integer, NULL::integer, v_daily_reset,
			NULL::integer, NULL::integer, v_monthly_reset,
			NULL::varchar, NULL::uuid,
			NULL::varchar, NULL::varchar, NULL::text,
			NULL::integer, NULL::integer, NULL::boolean;
		RETURN;
	END IF;

	IF v_database_session_version <> p_session_version THEN
		RETURN QUERY SELECT
			false, 'session_version_mismatch'::text, p_metric,
			NULL::integer, NULL::integer, v_daily_reset,
			NULL::integer, NULL::integer, v_monthly_reset,
			NULL::varchar, NULL::uuid,
			NULL::varchar, NULL::varchar, NULL::text,
			NULL::integer, NULL::integer, NULL::boolean;
		RETURN;
	END IF;

	SELECT
		plan.effective_plan_id,
		plan.canonical_plan_key,
		plan.plan_kind,
		plan.analysis_daily_limit,
		plan.analysis_monthly_limit,
		plan.ai_daily_limit,
		plan.ai_monthly_limit,
		plan.regular_video_limit,
		plan.shorts_video_limit,
		plan.plan_from_assignment
	INTO
		v_effective_plan_id,
		v_canonical_plan_key,
		v_plan_kind,
		v_analysis_daily_limit,
		v_analysis_monthly_limit,
		v_ai_daily_limit,
		v_ai_monthly_limit,
		v_regular_video_limit,
		v_shorts_video_limit,
		v_plan_from_assignment
	FROM public.resolve_effective_usage_plan_v1(p_user_id, v_now) AS plan;

	v_daily_limit := CASE p_metric
		WHEN 'channel_analysis' THEN v_analysis_daily_limit
		WHEN 'ai_consult' THEN v_ai_daily_limit
	END;
	v_monthly_limit := CASE p_metric
		WHEN 'channel_analysis' THEN v_analysis_monthly_limit
		WHEN 'ai_consult' THEN v_ai_monthly_limit
	END;

	IF v_daily_limit IS NULL OR v_monthly_limit IS NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage metric is unavailable.';
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
			false, 'daily_limit_reached'::text, p_metric,
			v_daily_used, v_daily_limit, v_daily_reset,
			v_monthly_used, v_monthly_limit, v_monthly_reset,
			v_canonical_plan_key, NULL::uuid,
			v_effective_plan_id, v_canonical_plan_key, v_plan_kind,
			v_regular_video_limit, v_shorts_video_limit,
			v_plan_from_assignment;
		RETURN;
	END IF;

	IF v_monthly_used >= v_monthly_limit THEN
		RETURN QUERY SELECT
			false, 'monthly_limit_reached'::text, p_metric,
			v_daily_used, v_daily_limit, v_daily_reset,
			v_monthly_used, v_monthly_limit, v_monthly_reset,
			v_canonical_plan_key, NULL::uuid,
			v_effective_plan_id, v_canonical_plan_key, v_plan_kind,
			v_regular_video_limit, v_shorts_video_limit,
			v_plan_from_assignment;
		RETURN;
	END IF;

	INSERT INTO public.user_usage_buckets AS daily_bucket (
		user_id, metric, period_kind, period_start,
		used_count, limit_snapshot, created_at, updated_at
	)
	VALUES (
		p_user_id, p_metric, 'day', v_daily_start,
		1, v_daily_limit, v_now, v_now
	)
	ON CONFLICT (user_id, metric, period_kind, period_start) DO UPDATE
	SET
		used_count = daily_bucket.used_count + 1,
		limit_snapshot = EXCLUDED.limit_snapshot,
		updated_at = v_now;

	INSERT INTO public.user_usage_buckets AS monthly_bucket (
		user_id, metric, period_kind, period_start,
		used_count, limit_snapshot, created_at, updated_at
	)
	VALUES (
		p_user_id, p_metric, 'month', v_monthly_start,
		1, v_monthly_limit, v_now, v_now
	)
	ON CONFLICT (user_id, metric, period_kind, period_start) DO UPDATE
	SET
		used_count = monthly_bucket.used_count + 1,
		limit_snapshot = EXCLUDED.limit_snapshot,
		updated_at = v_now;

	INSERT INTO public.usage_reservation_leases (
		user_id, metric, daily_period_start, monthly_period_start, created_at
	)
	VALUES (
		p_user_id, p_metric, v_daily_start, v_monthly_start, v_now
	)
	RETURNING id INTO v_reservation_id;

	RETURN QUERY SELECT
		true, NULL::text, p_metric,
		v_daily_used + 1, v_daily_limit, v_daily_reset,
		v_monthly_used + 1, v_monthly_limit, v_monthly_reset,
		v_canonical_plan_key, v_reservation_id,
		v_effective_plan_id, v_canonical_plan_key, v_plan_kind,
		v_regular_video_limit, v_shorts_video_limit,
		v_plan_from_assignment;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reserve_usage_limits_v2"(
	uuid,
	integer,
	"public"."usage_metric",
	timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
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
	"plan_code" varchar,
	"reservation_id" uuid
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
	SELECT
		result.allowed,
		result.denial_reason,
		result.metric,
		result.daily_used,
		result.daily_limit,
		result.daily_reset_at,
		result.monthly_used,
		result.monthly_limit,
		result.monthly_reset_at,
		result.plan_code,
		result.reservation_id
	FROM public.reserve_usage_limits_v2(
		p_user_id,
		p_session_version,
		p_metric,
		p_now
	) AS result;
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."get_usage_status_v1"(
	"p_user_id" uuid,
	"p_session_version" integer,
	"p_now" timestamp with time zone DEFAULT statement_timestamp()
)
RETURNS TABLE (
	"available" boolean,
	"denial_reason" text,
	"effective_plan_id" varchar,
	"canonical_plan_key" varchar,
	"plan_kind" text,
	"plan_from_assignment" boolean,
	"analysis_daily_used" integer,
	"analysis_daily_limit" integer,
	"analysis_daily_remaining" integer,
	"analysis_daily_reset_at" timestamp with time zone,
	"analysis_monthly_used" integer,
	"analysis_monthly_limit" integer,
	"analysis_monthly_remaining" integer,
	"analysis_monthly_reset_at" timestamp with time zone,
	"ai_daily_used" integer,
	"ai_daily_limit" integer,
	"ai_daily_remaining" integer,
	"ai_daily_reset_at" timestamp with time zone,
	"ai_monthly_used" integer,
	"ai_monthly_limit" integer,
	"ai_monthly_remaining" integer,
	"ai_monthly_reset_at" timestamp with time zone,
	"regular_video_limit" integer,
	"shorts_video_limit" integer
)
LANGUAGE plpgsql
STABLE
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
	v_analysis_daily_count integer;
	v_analysis_monthly_count integer;
	v_ai_daily_count integer;
	v_ai_monthly_count integer;
BEGIN
	SELECT
		boundaries.daily_period_start,
		boundaries.daily_reset_at,
		boundaries.monthly_period_start,
		boundaries.monthly_reset_at
	INTO
		v_daily_start,
		v_daily_reset,
		v_monthly_start,
		v_monthly_reset
	FROM public.usage_period_boundaries_v1(v_now) AS boundaries;

	analysis_daily_reset_at := v_daily_reset;
	analysis_monthly_reset_at := v_monthly_reset;
	ai_daily_reset_at := v_daily_reset;
	ai_monthly_reset_at := v_monthly_reset;

	SELECT u.status, u.session_version
	INTO v_user_status, v_database_session_version
	FROM public.users AS u
	WHERE u.id = p_user_id;

	IF NOT FOUND THEN
		available := false;
		denial_reason := 'user_not_found';
		RETURN NEXT;
		RETURN;
	END IF;

	IF v_user_status <> 'active' THEN
		available := false;
		denial_reason := 'user_inactive';
		RETURN NEXT;
		RETURN;
	END IF;

	IF v_database_session_version <> p_session_version THEN
		available := false;
		denial_reason := 'session_version_mismatch';
		RETURN NEXT;
		RETURN;
	END IF;

	SELECT
		plan.effective_plan_id,
		plan.canonical_plan_key,
		plan.plan_kind,
		plan.plan_from_assignment,
		plan.analysis_daily_limit,
		plan.analysis_monthly_limit,
		plan.ai_daily_limit,
		plan.ai_monthly_limit,
		plan.regular_video_limit,
		plan.shorts_video_limit
	INTO
		effective_plan_id,
		canonical_plan_key,
		plan_kind,
		plan_from_assignment,
		analysis_daily_limit,
		analysis_monthly_limit,
		ai_daily_limit,
		ai_monthly_limit,
		regular_video_limit,
		shorts_video_limit
	FROM public.resolve_effective_usage_plan_v1(p_user_id, v_now) AS plan;

	SELECT
		COUNT(*) FILTER (
			WHERE b.metric = 'channel_analysis'
				AND b.period_kind = 'day'
				AND b.period_start = v_daily_start
		)::integer,
		COUNT(*) FILTER (
			WHERE b.metric = 'channel_analysis'
				AND b.period_kind = 'month'
				AND b.period_start = v_monthly_start
		)::integer,
		COUNT(*) FILTER (
			WHERE b.metric = 'ai_consult'
				AND b.period_kind = 'day'
				AND b.period_start = v_daily_start
		)::integer,
		COUNT(*) FILTER (
			WHERE b.metric = 'ai_consult'
				AND b.period_kind = 'month'
				AND b.period_start = v_monthly_start
		)::integer,
		COALESCE(MAX(b.used_count) FILTER (
			WHERE b.metric = 'channel_analysis'
				AND b.period_kind = 'day'
				AND b.period_start = v_daily_start
		), 0),
		COALESCE(MAX(b.used_count) FILTER (
			WHERE b.metric = 'channel_analysis'
				AND b.period_kind = 'month'
				AND b.period_start = v_monthly_start
		), 0),
		COALESCE(MAX(b.used_count) FILTER (
			WHERE b.metric = 'ai_consult'
				AND b.period_kind = 'day'
				AND b.period_start = v_daily_start
		), 0),
		COALESCE(MAX(b.used_count) FILTER (
			WHERE b.metric = 'ai_consult'
				AND b.period_kind = 'month'
				AND b.period_start = v_monthly_start
		), 0)
	INTO
		v_analysis_daily_count,
		v_analysis_monthly_count,
		v_ai_daily_count,
		v_ai_monthly_count,
		analysis_daily_used,
		analysis_monthly_used,
		ai_daily_used,
		ai_monthly_used
	FROM public.user_usage_buckets AS b
	WHERE b.user_id = p_user_id
		AND (
			(b.period_kind = 'day' AND b.period_start = v_daily_start)
			OR (b.period_kind = 'month' AND b.period_start = v_monthly_start)
		);

	IF
		v_analysis_daily_count > 1
		OR v_analysis_monthly_count > 1
		OR v_ai_daily_count > 1
		OR v_ai_monthly_count > 1
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage counter state is unavailable.';
	END IF;

	analysis_daily_remaining := GREATEST(
		analysis_daily_limit - analysis_daily_used,
		0
	);
	analysis_monthly_remaining := GREATEST(
		analysis_monthly_limit - analysis_monthly_used,
		0
	);
	ai_daily_remaining := GREATEST(ai_daily_limit - ai_daily_used, 0);
	ai_monthly_remaining := GREATEST(ai_monthly_limit - ai_monthly_used, 0);
	available := true;
	denial_reason := NULL;

	RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."get_usage_status_v1"(
	uuid,
	integer,
	timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
DO $usage_acl_apply$
DECLARE
	v_legacy_oid oid := NULLIF(
		pg_catalog.current_setting('actustube.usage_acl_source_oid', true),
		''
	)::oid;
	v_legacy_owner oid := NULLIF(
		pg_catalog.current_setting('actustube.usage_acl_source_owner', true),
		''
	)::oid;
	v_legacy_security_definer boolean := NULLIF(
		pg_catalog.current_setting(
			'actustube.usage_acl_source_security_definer',
			true
		),
		''
	)::boolean;
	v_legacy_acl_hash text := NULLIF(
		pg_catalog.current_setting('actustube.usage_acl_source_hash', true),
		''
	);
	v_legacy_owner_name name;
	v_target_signature text;
	v_target_oid oid;
	v_target_owner oid;
	v_grant record;
BEGIN
	IF
		v_legacy_oid IS NULL
		OR v_legacy_owner IS NULL
		OR v_legacy_security_definer IS NULL
		OR v_legacy_acl_hash IS NULL
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function permission baseline was not retained.';
	END IF;

	SELECT pg_catalog.pg_get_userbyid(v_legacy_owner)
	INTO v_legacy_owner_name;

	IF v_legacy_owner_name IS NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function owner is unavailable.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_proc AS p
		WHERE p.oid = v_legacy_oid
			AND p.pronamespace = 'public'::pg_catalog.regnamespace
			AND p.proname = 'reserve_usage_limits'
			AND p.proowner = v_legacy_owner
			AND pg_catalog.md5(p.proacl::text) = v_legacy_acl_hash
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Usage function permission baseline changed unexpectedly.';
	END IF;

	FOREACH v_target_signature IN ARRAY ARRAY[
		'public.usage_period_boundaries_v1(timestamp with time zone)',
		'public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)',
		'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)',
		'public.get_usage_status_v1(uuid,integer,timestamp with time zone)'
	]::text[]
	LOOP
		v_target_oid := pg_catalog.to_regprocedure(v_target_signature)::oid;

		IF v_target_oid IS NULL THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'A versioned usage function is unavailable.';
		END IF;

		SELECT p.proowner
		INTO v_target_owner
		FROM pg_catalog.pg_proc AS p
		WHERE p.oid = v_target_oid
			AND p.pronamespace = 'public'::pg_catalog.regnamespace;

		IF v_target_owner IS NULL THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'A versioned usage function is ambiguous.';
		END IF;

		FOR v_grant IN
			SELECT acl.grantee
			FROM pg_catalog.pg_proc AS p
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					p.proacl,
					pg_catalog.acldefault('f', p.proowner)
				)
			) AS acl
			WHERE p.oid = v_target_oid
				AND acl.grantee <> p.proowner
			GROUP BY acl.grantee
		LOOP
			IF v_grant.grantee = 0 THEN
				EXECUTE pg_catalog.format(
					'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
					v_target_oid::pg_catalog.regprocedure
				);
			ELSE
				EXECUTE pg_catalog.format(
					'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
					v_target_oid::pg_catalog.regprocedure,
					pg_catalog.pg_get_userbyid(v_grant.grantee)
				);
			END IF;
		END LOOP;

		FOR v_grant IN
			SELECT
				acl.grantee,
				acl.is_grantable
			FROM pg_catalog.pg_proc AS p
			CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS acl
			WHERE p.oid = v_legacy_oid
				AND acl.grantee <> p.proowner
				AND acl.grantee <> 0
				AND acl.privilege_type = 'EXECUTE'
		LOOP
			EXECUTE pg_catalog.format(
				'GRANT EXECUTE ON FUNCTION %s TO %I%s',
				v_target_oid::pg_catalog.regprocedure,
				pg_catalog.pg_get_userbyid(v_grant.grantee),
				CASE
					WHEN v_grant.is_grantable THEN ' WITH GRANT OPTION'
					ELSE ''
				END
			);
		END LOOP;

		EXECUTE pg_catalog.format(
			'ALTER FUNCTION %s SECURITY %s',
			v_target_oid::pg_catalog.regprocedure,
			CASE
				WHEN v_legacy_security_definer THEN 'DEFINER'
				ELSE 'INVOKER'
			END
		);
		EXECUTE pg_catalog.format(
			'ALTER FUNCTION %s SET search_path = public, pg_temp',
			v_target_oid::pg_catalog.regprocedure
		);
		EXECUTE pg_catalog.format(
			'ALTER FUNCTION %s OWNER TO %I',
			v_target_oid::pg_catalog.regprocedure,
			v_legacy_owner_name
		);
	END LOOP;

	EXECUTE pg_catalog.format(
		'ALTER FUNCTION %s SECURITY %s',
		v_legacy_oid::pg_catalog.regprocedure,
		CASE
			WHEN v_legacy_security_definer THEN 'DEFINER'
			ELSE 'INVOKER'
		END
	);
	EXECUTE pg_catalog.format(
		'ALTER FUNCTION %s SET search_path = public, pg_temp',
		v_legacy_oid::pg_catalog.regprocedure
	);

	IF NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_proc AS p
		WHERE p.oid = v_legacy_oid
			AND p.proowner = v_legacy_owner
			AND p.prosecdef = v_legacy_security_definer
			AND p.proconfig IS NOT DISTINCT FROM ARRAY[
				'search_path=public, pg_temp'
			]::text[]
			AND pg_catalog.md5(p.proacl::text) = v_legacy_acl_hash
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'The legacy usage function contract was not preserved.';
	END IF;

	FOREACH v_target_signature IN ARRAY ARRAY[
		'public.usage_period_boundaries_v1(timestamp with time zone)',
		'public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)',
		'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)',
		'public.get_usage_status_v1(uuid,integer,timestamp with time zone)'
	]::text[]
	LOOP
		v_target_oid := pg_catalog.to_regprocedure(v_target_signature)::oid;

		IF NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS target_proc
			WHERE target_proc.oid = v_target_oid
				AND target_proc.proowner = v_legacy_owner
				AND target_proc.prosecdef = v_legacy_security_definer
				AND target_proc.proconfig IS NOT DISTINCT FROM ARRAY[
					'search_path=public, pg_temp'
				]::text[]
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.aclexplode(
						COALESCE(
							target_proc.proacl,
							pg_catalog.acldefault(
								'f',
								target_proc.proowner
							)
						)
					) AS target_acl
					WHERE target_acl.grantee = 0
						AND target_acl.privilege_type = 'EXECUTE'
				)
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'A versioned usage function permission is unsafe.';
		END IF;

		IF EXISTS (
			SELECT
				target_acl.grantee,
				target_acl.privilege_type,
				target_acl.is_grantable
			FROM pg_catalog.pg_proc AS target_proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					target_proc.proacl,
					pg_catalog.acldefault('f', target_proc.proowner)
				)
			) AS target_acl
			WHERE target_proc.oid = v_target_oid
				AND target_acl.grantee <> target_proc.proowner
			EXCEPT
			SELECT
				legacy_acl.grantee,
				legacy_acl.privilege_type,
				legacy_acl.is_grantable
			FROM pg_catalog.pg_proc AS legacy_proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					legacy_proc.proacl,
					pg_catalog.acldefault('f', legacy_proc.proowner)
				)
			) AS legacy_acl
			WHERE legacy_proc.oid = v_legacy_oid
				AND legacy_acl.grantee <> legacy_proc.proowner
		) OR EXISTS (
			SELECT
				legacy_acl.grantee,
				legacy_acl.privilege_type,
				legacy_acl.is_grantable
			FROM pg_catalog.pg_proc AS legacy_proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					legacy_proc.proacl,
					pg_catalog.acldefault('f', legacy_proc.proowner)
				)
			) AS legacy_acl
			WHERE legacy_proc.oid = v_legacy_oid
				AND legacy_acl.grantee <> legacy_proc.proowner
			EXCEPT
			SELECT
				target_acl.grantee,
				target_acl.privilege_type,
				target_acl.is_grantable
			FROM pg_catalog.pg_proc AS target_proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(
					target_proc.proacl,
					pg_catalog.acldefault('f', target_proc.proowner)
				)
			) AS target_acl
			WHERE target_proc.oid = v_target_oid
				AND target_acl.grantee <> target_proc.proowner
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001',
				MESSAGE = 'A versioned usage function ACL was not preserved.';
		END IF;
	END LOOP;
END;
$usage_acl_apply$;
