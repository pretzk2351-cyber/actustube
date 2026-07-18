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
#variable_conflict use_column
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
