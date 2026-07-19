CREATE INDEX "usage_reservation_leases_created_at_idx" ON "usage_reservation_leases" USING btree ("created_at");
--> statement-breakpoint
CREATE FUNCTION "public"."recover_stale_usage_reservations"(
	"p_stale_before" timestamp with time zone,
	"p_batch_size" integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
	v_lease record;
	v_recovered integer := 0;
BEGIN
	IF p_stale_before IS NULL OR p_batch_size < 1 OR p_batch_size > 500 THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'Invalid stale reservation recovery input.';
	END IF;

	FOR v_lease IN
		SELECT
			r.id,
			r.user_id,
			r.metric,
			r.daily_period_start,
			r.monthly_period_start
		FROM public.usage_reservation_leases AS r
		WHERE r.created_at <= p_stale_before
		ORDER BY r.created_at, r.id
		FOR UPDATE OF r SKIP LOCKED
		LIMIT p_batch_size
	LOOP
		PERFORM pg_advisory_xact_lock(
			hashtextextended(
				'usage:' || v_lease.user_id::text || ':' || v_lease.metric::text,
				0
			)
		);

		UPDATE public.user_usage_buckets AS b
		SET
			used_count = GREATEST(b.used_count - 1, 0),
			updated_at = statement_timestamp()
		WHERE b.user_id = v_lease.user_id
			AND b.metric = v_lease.metric
			AND b.period_kind = 'day'
			AND b.period_start = v_lease.daily_period_start;

		UPDATE public.user_usage_buckets AS b
		SET
			used_count = GREATEST(b.used_count - 1, 0),
			updated_at = statement_timestamp()
		WHERE b.user_id = v_lease.user_id
			AND b.metric = v_lease.metric
			AND b.period_kind = 'month'
			AND b.period_start = v_lease.monthly_period_start;

		DELETE FROM public.usage_reservation_leases AS r
		WHERE r.id = v_lease.id;

		v_recovered := v_recovered + 1;
	END LOOP;

	RETURN v_recovered;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."recover_stale_usage_reservations"(
	timestamp with time zone,
	integer
) FROM PUBLIC;
