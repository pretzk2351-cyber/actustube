export const EXPECTED_MIGRATION_TAGS = Object.freeze([
  "0000_crazy_spyke",
  "0001_fix_google_oauth_account_variable_conflict",
  "0002_add_atomic_usage_reservation",
  "0003_add_usage_reservation_release",
  "0004_add_stale_reservation_recovery",
  "0005_silky_mystique",
  "0006_usage_status_plan_snapshot",
]);

export const EXPECTED_FUNCTIONS = Object.freeze([
  {
    name: "finalize_ai_consult_reservation",
    identity:
      "p_reservation_id uuid, p_user_id uuid, p_analysis_run_id uuid, p_ai_consult_snapshot jsonb, p_created_at timestamp with time zone",
    result: "boolean",
    volatility: "v",
    language: "sql",
    argumentDefaults: 0,
    defaultExpression: null,
    returnsSet: false,
  },
  {
    name: "finalize_channel_analysis_reservation",
    identity:
      "p_reservation_id uuid, p_user_id uuid, p_channel_id character varying, p_channel_title character varying, p_analysis_snapshot jsonb, p_regular_video_count integer, p_short_video_count integer, p_regular_average_views bigint, p_short_average_views bigint, p_analyzed_at timestamp with time zone",
    result: "uuid",
    volatility: "v",
    language: "plpgsql",
    argumentDefaults: 0,
    defaultExpression: null,
    returnsSet: false,
  },
  {
    name: "finalize_usage_reservation",
    identity: "p_reservation_id uuid, p_user_id uuid",
    result: "boolean",
    volatility: "v",
    language: "sql",
    argumentDefaults: 0,
    defaultExpression: null,
    returnsSet: false,
  },
  {
    name: "get_usage_status_v1",
    identity:
      "p_user_id uuid, p_session_version integer, p_now timestamp with time zone",
    result:
      "TABLE(available boolean, denial_reason text, effective_plan_id character varying, canonical_plan_key character varying, plan_kind text, plan_from_assignment boolean, analysis_daily_used integer, analysis_daily_limit integer, analysis_daily_remaining integer, analysis_daily_reset_at timestamp with time zone, analysis_monthly_used integer, analysis_monthly_limit integer, analysis_monthly_remaining integer, analysis_monthly_reset_at timestamp with time zone, ai_daily_used integer, ai_daily_limit integer, ai_daily_remaining integer, ai_daily_reset_at timestamp with time zone, ai_monthly_used integer, ai_monthly_limit integer, ai_monthly_remaining integer, ai_monthly_reset_at timestamp with time zone, regular_video_limit integer, shorts_video_limit integer)",
    volatility: "s",
    language: "plpgsql",
    argumentDefaults: 1,
    defaultExpression: "statement_timestamp()",
    returnsSet: true,
  },
  {
    name: "recover_stale_usage_reservations",
    identity:
      "p_stale_before timestamp with time zone, p_batch_size integer",
    result: "integer",
    volatility: "v",
    language: "plpgsql",
    argumentDefaults: 1,
    defaultExpression: "100",
    returnsSet: false,
  },
  {
    name: "release_usage_limits",
    identity: "p_reservation_id uuid, p_user_id uuid",
    result: "TABLE(released boolean, daily_used integer, monthly_used integer)",
    volatility: "v",
    language: "plpgsql",
    argumentDefaults: 0,
    defaultExpression: null,
    returnsSet: true,
  },
  {
    name: "reserve_usage_limits",
    identity:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
    result:
      "TABLE(allowed boolean, denial_reason text, metric usage_metric, daily_used integer, daily_limit integer, daily_reset_at timestamp with time zone, monthly_used integer, monthly_limit integer, monthly_reset_at timestamp with time zone, plan_code character varying, reservation_id uuid)",
    volatility: "v",
    language: "sql",
    argumentDefaults: 1,
    defaultExpression: "statement_timestamp()",
    returnsSet: true,
  },
  {
    name: "reserve_usage_limits_v2",
    identity:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
    result:
      "TABLE(allowed boolean, denial_reason text, metric usage_metric, daily_used integer, daily_limit integer, daily_reset_at timestamp with time zone, monthly_used integer, monthly_limit integer, monthly_reset_at timestamp with time zone, plan_code character varying, reservation_id uuid, effective_plan_id character varying, canonical_plan_key character varying, plan_kind text, regular_video_limit integer, shorts_video_limit integer, plan_from_assignment boolean)",
    volatility: "v",
    language: "plpgsql",
    argumentDefaults: 1,
    defaultExpression: "statement_timestamp()",
    returnsSet: true,
  },
  {
    name: "resolve_effective_usage_plan_v1",
    identity: "p_user_id uuid, p_now timestamp with time zone",
    result:
      "TABLE(effective_plan_id character varying, canonical_plan_key character varying, plan_kind text, analysis_daily_limit integer, analysis_monthly_limit integer, ai_daily_limit integer, ai_monthly_limit integer, regular_video_limit integer, shorts_video_limit integer, plan_from_assignment boolean)",
    volatility: "s",
    language: "plpgsql",
    argumentDefaults: 1,
    defaultExpression: "statement_timestamp()",
    returnsSet: true,
  },
  {
    name: "sync_google_oauth_account",
    identity:
      "p_provider_account_id character varying, p_email character varying, p_name character varying, p_image_url character varying, p_granted_scope text, p_seen_at timestamp with time zone",
    result: "TABLE(user_id uuid, account_status user_status, session_version integer)",
    volatility: "v",
    language: "plpgsql",
    argumentDefaults: 0,
    defaultExpression: null,
    returnsSet: true,
  },
  {
    name: "usage_period_boundaries_v1",
    identity: "p_now timestamp with time zone",
    result:
      "TABLE(daily_period_start timestamp with time zone, daily_reset_at timestamp with time zone, monthly_period_start timestamp with time zone, monthly_reset_at timestamp with time zone)",
    volatility: "s",
    language: "sql",
    argumentDefaults: 1,
    defaultExpression: "statement_timestamp()",
    returnsSet: true,
  },
]);

export const RUNTIME_TABLE_PRIVILEGES = Object.freeze({
  analysis_runs: ["SELECT", "INSERT", "UPDATE"],
  improvement_actions: ["SELECT", "INSERT", "UPDATE"],
  oauth_accounts: ["SELECT", "INSERT", "UPDATE"],
  plans: ["SELECT"],
  usage_reservation_leases: ["SELECT", "INSERT", "DELETE"],
  user_plan_assignments: ["SELECT", "INSERT"],
  user_usage_buckets: ["SELECT", "INSERT", "UPDATE"],
  users: ["SELECT", "INSERT", "UPDATE"],
});

export const FORBIDDEN_RUNTIME_TABLE_PRIVILEGES = Object.freeze([
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
]);
