import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pgPackage from "pg";

import {
  PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS,
  PREFLIGHT_SQL_FOR_TESTS,
  verifyStagingDatabasePreflight,
} from "./staging-database-preflight/core.mjs";
import {
  POSTFLIGHT_SQL_FOR_TESTS,
  loadRepositorySpecification,
} from "./staging-database-postflight/core.mjs";
import { assertReadOnlySql } from "./staging-database-postflight/safety.mjs";
import { executeStagingDatabasePostflight } from "./verify-staging-database-postflight.mjs";

const { Client } = pgPackage;
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), "..");

const FIXTURE_KEYS = Object.freeze({
  url: "ACTUSTUBE_STAGING_HARNESS_DATABASE_URL",
  database: "ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE",
  role: "ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE",
  major: "ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR",
  migrationMax: "ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX",
});
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_PASSWORD = /^[A-Za-z0-9_!$'*+.-]{1,128}$/;
const FIXTURE_URL = /^(postgres|postgresql):\/\/([a-z][a-z0-9_]{0,62}):([A-Za-z0-9_!$'*+.-]{1,128})@127\.0\.0\.1:([1-9][0-9]{0,4})\/([a-z][a-z0-9_]{0,62})$/;
const EXPECTED_MAJOR = 18;
const EXPECTED_MIGRATION_MAX = 6;
const EXPECTED_MIGRATION_COUNT = EXPECTED_MIGRATION_MAX + 1;
const RUNTIME_ROLE = "actustube_ci_fixture_runtime";
const RUNTIME_PASSWORD = "ci_runtime_only_not_a_secret";
const USAGE_FIXTURE_ROLES = Object.freeze({
  explicitRuntime: "actustube_ci_usage_explicit",
  runtimeGroup: "actustube_ci_usage_group",
  membershipRuntime: "actustube_ci_usage_member",
  deniedRuntime: "actustube_ci_usage_denied",
  publicProbe: "actustube_ci_usage_public_probe",
});
const USAGE_MIGRATION_BOUNDARY_ROLES = Object.freeze({
  legacyOwner: "actustube_ci_usage_legacy_owner",
  migrationExecutor: "actustube_ci_usage_migration_executor",
});
const LEGACY_USAGE_SIGNATURE =
  "public.reserve_usage_limits(uuid,integer,public.usage_metric,timestamp with time zone)";
const VERSIONED_USAGE_SIGNATURES = Object.freeze([
  "public.usage_period_boundaries_v1(timestamp with time zone)",
  "public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)",
  "public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.get_usage_status_v1(uuid,integer,timestamp with time zone)",
]);
const USAGE_OWNER_IDENTITIES = Object.freeze([
  LEGACY_USAGE_SIGNATURE,
  ...VERSIONED_USAGE_SIGNATURES,
]);
const USAGE_OWNER_SECURITY_DEFINER_EXPECTATIONS = Object.freeze(
  Object.fromEntries(
    USAGE_OWNER_IDENTITIES.map((functionIdentity) => [functionIdentity, false])
  )
);
const CANONICAL_FUNCTION_CONTRACT = Object.freeze([
  Object.freeze({
    name: "finalize_ai_consult_reservation",
    identityArguments:
      "p_reservation_id uuid, p_user_id uuid, p_analysis_run_id uuid, p_ai_consult_snapshot jsonb, p_created_at timestamp with time zone",
    alterIdentity: "uuid,uuid,uuid,jsonb,timestamp with time zone",
  }),
  Object.freeze({
    name: "finalize_channel_analysis_reservation",
    identityArguments:
      "p_reservation_id uuid, p_user_id uuid, p_channel_id character varying, p_channel_title character varying, p_analysis_snapshot jsonb, p_regular_video_count integer, p_short_video_count integer, p_regular_average_views bigint, p_short_average_views bigint, p_analyzed_at timestamp with time zone",
    alterIdentity:
      "uuid,uuid,character varying,character varying,jsonb,integer,integer,bigint,bigint,timestamp with time zone",
  }),
  Object.freeze({
    name: "finalize_usage_reservation",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    alterIdentity: "uuid,uuid",
  }),
  Object.freeze({
    name: "get_usage_status_v1",
    identityArguments:
      "p_user_id uuid, p_session_version integer, p_now timestamp with time zone",
    alterIdentity: "uuid,integer,timestamp with time zone",
  }),
  Object.freeze({
    name: "recover_stale_usage_reservations",
    identityArguments:
      "p_stale_before timestamp with time zone, p_batch_size integer",
    alterIdentity: "timestamp with time zone,integer",
  }),
  Object.freeze({
    name: "release_usage_limits",
    identityArguments: "p_reservation_id uuid, p_user_id uuid",
    alterIdentity: "uuid,uuid",
  }),
  Object.freeze({
    name: "reserve_usage_limits",
    identityArguments:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
    alterIdentity: "uuid,integer,public.usage_metric,timestamp with time zone",
  }),
  Object.freeze({
    name: "reserve_usage_limits_v2",
    identityArguments:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
    alterIdentity: "uuid,integer,public.usage_metric,timestamp with time zone",
  }),
  Object.freeze({
    name: "resolve_effective_usage_plan_v1",
    identityArguments: "p_user_id uuid, p_now timestamp with time zone",
    alterIdentity: "uuid,timestamp with time zone",
  }),
  Object.freeze({
    name: "sync_google_oauth_account",
    identityArguments:
      "p_provider_account_id character varying, p_email character varying, p_name character varying, p_image_url character varying, p_granted_scope text, p_seen_at timestamp with time zone",
    alterIdentity:
      "character varying,character varying,character varying,character varying,text,timestamp with time zone",
  }),
  Object.freeze({
    name: "usage_period_boundaries_v1",
    identityArguments: "p_now timestamp with time zone",
    alterIdentity: "timestamp with time zone",
  }),
]);
const FIXTURE_SCHEMA_NAMES = Object.freeze(["drizzle", "public"]);
const MIGRATION_LEDGER_CONTRACT = Object.freeze({
  schema: "drizzle",
  table: "__drizzle_migrations",
  sequence: "__drizzle_migrations_id_seq",
  primaryKeyIndex: "__drizzle_migrations_pkey",
});
const OWNERSHIP_ROW_KEYS = Object.freeze([
  "object_kind",
  "schema_name",
  "object_name",
  "function_identity",
  "owner_name",
]);
const PRE_CANONICAL_OWNERSHIP_INVENTORY_SQL = `
  WITH target_roles AS (
    SELECT role_entry.oid, role_entry.rolname
    FROM pg_catalog.pg_roles AS role_entry
    WHERE role_entry.rolname = ANY($1::text[])
  ), inventory AS (
    SELECT
      CASE relation_entry.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'table'
        WHEN 'i' THEN 'index'
        WHEN 'I' THEN 'index'
        WHEN 'S' THEN 'sequence'
        ELSE 'unexpected_relation'
      END::text AS object_kind,
      namespace_entry.nspname::text AS schema_name,
      relation_entry.relname::text AS object_name,
      NULL::text AS function_identity,
      target_roles.rolname::text AS owner_name
    FROM pg_catalog.pg_class AS relation_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = relation_entry.relnamespace
    INNER JOIN target_roles ON target_roles.oid = relation_entry.relowner
    WHERE namespace_entry.nspname !~ '^pg_(?:catalog|toast|temp|toas?t_temp)'
      AND namespace_entry.nspname <> 'information_schema'

    UNION ALL

    SELECT
      CASE type_entry.typtype
        WHEN 'e' THEN 'type'
        ELSE 'unexpected_type'
      END::text,
      namespace_entry.nspname::text,
      type_entry.typname::text,
      NULL::text,
      target_roles.rolname::text
    FROM pg_catalog.pg_type AS type_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = type_entry.typnamespace
    INNER JOIN target_roles ON target_roles.oid = type_entry.typowner
    WHERE type_entry.typrelid = 0
      AND type_entry.typelem = 0
      AND namespace_entry.nspname !~ '^pg_(?:catalog|toast|temp|toas?t_temp)'
      AND namespace_entry.nspname <> 'information_schema'

    UNION ALL

    SELECT
      CASE procedure_entry.prokind
        WHEN 'f' THEN 'function'
        ELSE 'unexpected_routine'
      END::text,
      namespace_entry.nspname::text,
      procedure_entry.proname::text,
      pg_catalog.pg_get_function_identity_arguments(procedure_entry.oid)::text,
      target_roles.rolname::text
    FROM pg_catalog.pg_proc AS procedure_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = procedure_entry.pronamespace
    INNER JOIN target_roles ON target_roles.oid = procedure_entry.proowner
    WHERE namespace_entry.nspname !~ '^pg_(?:catalog|toast|temp|toas?t_temp)'
      AND namespace_entry.nspname <> 'information_schema'

    UNION ALL

    SELECT
      'unexpected_schema'::text,
      namespace_entry.nspname::text,
      namespace_entry.nspname::text,
      NULL::text,
      target_roles.rolname::text
    FROM pg_catalog.pg_namespace AS namespace_entry
    INNER JOIN target_roles ON target_roles.oid = namespace_entry.nspowner

    UNION ALL

    SELECT
      'shared_database'::text,
      NULL::text,
      'owned_database'::text,
      NULL::text,
      target_roles.rolname::text
    FROM pg_catalog.pg_database AS database_entry
    INNER JOIN target_roles ON target_roles.oid = database_entry.datdba

    UNION ALL

    SELECT
      'shared_tablespace'::text,
      NULL::text,
      'owned_tablespace'::text,
      NULL::text,
      target_roles.rolname::text
    FROM pg_catalog.pg_tablespace AS tablespace_entry
    INNER JOIN target_roles ON target_roles.oid = tablespace_entry.spcowner

    UNION ALL

    SELECT
      'unsupported_owned_object'::text,
      NULL::text,
      'unsupported_catalog'::text,
      NULL::text,
      target_roles.rolname::text
    FROM pg_catalog.pg_shdepend AS dependency_entry
    INNER JOIN target_roles ON target_roles.oid = dependency_entry.refobjid
    WHERE dependency_entry.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency_entry.deptype = 'o'
      AND dependency_entry.classid NOT IN (
        'pg_catalog.pg_class'::regclass,
        'pg_catalog.pg_proc'::regclass,
        'pg_catalog.pg_type'::regclass,
        'pg_catalog.pg_namespace'::regclass,
        'pg_catalog.pg_database'::regclass,
        'pg_catalog.pg_tablespace'::regclass
      )
  )
  SELECT
    object_kind,
    schema_name,
    object_name,
    function_identity,
    owner_name
  FROM inventory
  ORDER BY
    object_kind,
    schema_name NULLS FIRST,
    object_name,
    function_identity NULLS FIRST,
    owner_name
`;
const POST_CANONICAL_OWNERSHIP_SNAPSHOT_SQL = `
  WITH inventory AS (
    SELECT
      'database'::text AS object_kind,
      NULL::text AS schema_name,
      'current_database'::text AS object_name,
      NULL::text AS function_identity,
      pg_catalog.pg_get_userbyid(database_entry.datdba)::text AS owner_name
    FROM pg_catalog.pg_database AS database_entry
    WHERE database_entry.datname = pg_catalog.current_database()

    UNION ALL

    SELECT
      'schema'::text,
      namespace_entry.nspname::text,
      namespace_entry.nspname::text,
      NULL::text,
      pg_catalog.pg_get_userbyid(namespace_entry.nspowner)::text
    FROM pg_catalog.pg_namespace AS namespace_entry
    WHERE namespace_entry.nspname = ANY($1::text[])

    UNION ALL

    SELECT
      CASE relation_entry.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'table'
        WHEN 'i' THEN 'index'
        WHEN 'I' THEN 'index'
        WHEN 'S' THEN 'sequence'
        ELSE 'unexpected_relation'
      END::text,
      namespace_entry.nspname::text,
      relation_entry.relname::text,
      NULL::text,
      pg_catalog.pg_get_userbyid(relation_entry.relowner)::text
    FROM pg_catalog.pg_class AS relation_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = relation_entry.relnamespace
    WHERE namespace_entry.nspname = ANY($1::text[])
      AND relation_entry.relkind IN ('r', 'p', 'i', 'I', 'S', 'v', 'm', 'f', 'c')

    UNION ALL

    SELECT
      CASE type_entry.typtype
        WHEN 'e' THEN 'type'
        ELSE 'unexpected_type'
      END::text,
      namespace_entry.nspname::text,
      type_entry.typname::text,
      NULL::text,
      pg_catalog.pg_get_userbyid(type_entry.typowner)::text
    FROM pg_catalog.pg_type AS type_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = type_entry.typnamespace
    WHERE namespace_entry.nspname = ANY($1::text[])
      AND type_entry.typrelid = 0
      AND type_entry.typelem = 0

    UNION ALL

    SELECT
      CASE procedure_entry.prokind
        WHEN 'f' THEN 'function'
        ELSE 'unexpected_routine'
      END::text,
      namespace_entry.nspname::text,
      procedure_entry.proname::text,
      pg_catalog.pg_get_function_identity_arguments(procedure_entry.oid)::text,
      pg_catalog.pg_get_userbyid(procedure_entry.proowner)::text
    FROM pg_catalog.pg_proc AS procedure_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = procedure_entry.pronamespace
    WHERE namespace_entry.nspname = ANY($1::text[])
  )
  SELECT
    object_kind,
    schema_name,
    object_name,
    function_identity,
    owner_name
  FROM inventory
  ORDER BY
    object_kind,
    schema_name NULLS FIRST,
    object_name,
    function_identity NULLS FIRST,
    owner_name
`;
const TEMPORARY_AUTHORITY_ROW_KEYS = Object.freeze([
  "authority_kind",
  "role_name",
  "role_relation",
  "grantor_name",
  "grantee_name",
  "object_kind",
  "schema_name",
  "object_name",
  "column_name",
  "function_identity",
  "privilege_type",
  "grant_option",
  "granted_role",
  "inherit_option",
  "set_option",
]);
const TEMPORARY_AUTHORITY_INVENTORY_SQL = `
  WITH target_roles AS (
    SELECT role_entry.oid, role_entry.rolname
    FROM pg_catalog.pg_roles AS role_entry
    WHERE role_entry.rolname = ANY($1::text[])
  ), current_database_identity AS (
    SELECT database_entry.oid
    FROM pg_catalog.pg_database AS database_entry
    WHERE database_entry.datname = pg_catalog.current_database()
  ), explicit_acl_coverage AS (
    SELECT DISTINCT
      0::oid AS dbid,
      'pg_catalog.pg_database'::regclass AS classid,
      database_entry.oid AS objid,
      0::integer AS objsubid,
      target_role.oid AS target_role_oid
    FROM pg_catalog.pg_database AS database_entry
    CROSS JOIN LATERAL pg_catalog.aclexplode(database_entry.datacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor

    UNION

    SELECT DISTINCT
      current_database_identity.oid,
      'pg_catalog.pg_namespace'::regclass,
      namespace_entry.oid,
      0::integer,
      target_role.oid
    FROM pg_catalog.pg_namespace AS namespace_entry
    CROSS JOIN current_database_identity
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace_entry.nspacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor

    UNION

    SELECT DISTINCT
      current_database_identity.oid,
      'pg_catalog.pg_class'::regclass,
      relation_entry.oid,
      0::integer,
      target_role.oid
    FROM pg_catalog.pg_class AS relation_entry
    CROSS JOIN current_database_identity
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation_entry.relacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor

    UNION

    SELECT DISTINCT
      current_database_identity.oid,
      'pg_catalog.pg_class'::regclass,
      attribute_entry.attrelid,
      attribute_entry.attnum::integer,
      target_role.oid
    FROM pg_catalog.pg_attribute AS attribute_entry
    CROSS JOIN current_database_identity
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_entry.attacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    WHERE attribute_entry.attnum > 0
      AND NOT attribute_entry.attisdropped

    UNION

    SELECT DISTINCT
      current_database_identity.oid,
      'pg_catalog.pg_proc'::regclass,
      procedure_entry.oid,
      0::integer,
      target_role.oid
    FROM pg_catalog.pg_proc AS procedure_entry
    CROSS JOIN current_database_identity
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure_entry.proacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor

    UNION

    SELECT DISTINCT
      current_database_identity.oid,
      'pg_catalog.pg_type'::regclass,
      type_entry.oid,
      0::integer,
      target_role.oid
    FROM pg_catalog.pg_type AS type_entry
    CROSS JOIN current_database_identity
    CROSS JOIN LATERAL pg_catalog.aclexplode(type_entry.typacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor

    UNION

    SELECT DISTINCT
      current_database_identity.oid,
      'pg_catalog.pg_default_acl'::regclass,
      default_acl.oid,
      0::integer,
      target_role.oid
    FROM pg_catalog.pg_default_acl AS default_acl
    CROSS JOIN current_database_identity
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
  ), authority_inventory AS (
    SELECT
      'explicit_acl'::text AS authority_kind,
      target_role.rolname::text AS role_name,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text AS role_relation,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text AS grantor_name,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text AS grantee_name,
      'database'::text AS object_kind,
      NULL::text AS schema_name,
      database_entry.datname::text AS object_name,
      NULL::text AS column_name,
      NULL::text AS function_identity,
      acl.privilege_type::text AS privilege_type,
      acl.is_grantable AS grant_option,
      NULL::text AS granted_role,
      NULL::boolean AS inherit_option,
      NULL::boolean AS set_option
    FROM pg_catalog.pg_database AS database_entry
    CROSS JOIN LATERAL pg_catalog.aclexplode(database_entry.datacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee

    UNION ALL

    SELECT
      'explicit_acl'::text,
      target_role.rolname::text,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text,
      'schema'::text,
      namespace_entry.nspname::text,
      namespace_entry.nspname::text,
      NULL::text,
      NULL::text,
      acl.privilege_type::text,
      acl.is_grantable,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_namespace AS namespace_entry
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace_entry.nspacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee

    UNION ALL

    SELECT
      'explicit_acl'::text,
      target_role.rolname::text,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text,
      CASE relation_entry.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'table'
        WHEN 'S' THEN 'sequence'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized_view'
        WHEN 'f' THEN 'foreign_table'
        ELSE 'unexpected_relation'
      END::text,
      namespace_entry.nspname::text,
      relation_entry.relname::text,
      NULL::text,
      NULL::text,
      acl.privilege_type::text,
      acl.is_grantable,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_class AS relation_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = relation_entry.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation_entry.relacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee

    UNION ALL

    SELECT
      'explicit_acl'::text,
      target_role.rolname::text,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text,
      'column'::text,
      namespace_entry.nspname::text,
      relation_entry.relname::text,
      attribute_entry.attname::text,
      NULL::text,
      acl.privilege_type::text,
      acl.is_grantable,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_attribute AS attribute_entry
    INNER JOIN pg_catalog.pg_class AS relation_entry
      ON relation_entry.oid = attribute_entry.attrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = relation_entry.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_entry.attacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee
    WHERE attribute_entry.attnum > 0
      AND NOT attribute_entry.attisdropped

    UNION ALL

    SELECT
      'explicit_acl'::text,
      target_role.rolname::text,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text,
      CASE procedure_entry.prokind
        WHEN 'f' THEN 'function'
        WHEN 'p' THEN 'procedure'
        ELSE 'unexpected_routine'
      END::text,
      namespace_entry.nspname::text,
      procedure_entry.proname::text,
      NULL::text,
      pg_catalog.pg_get_function_identity_arguments(procedure_entry.oid)::text,
      acl.privilege_type::text,
      acl.is_grantable,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_proc AS procedure_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = procedure_entry.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure_entry.proacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee

    UNION ALL

    SELECT
      'explicit_acl'::text,
      target_role.rolname::text,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text,
      'type'::text,
      namespace_entry.nspname::text,
      type_entry.typname::text,
      NULL::text,
      NULL::text,
      acl.privilege_type::text,
      acl.is_grantable,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_type AS type_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = type_entry.typnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(type_entry.typacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee

    UNION ALL

    SELECT
      'explicit_acl'::text,
      target_role.rolname::text,
      CASE
        WHEN target_role.oid = acl.grantee AND target_role.oid = acl.grantor THEN 'both'
        WHEN target_role.oid = acl.grantee THEN 'grantee'
        WHEN target_role.oid = acl.grantor THEN 'grantor'
        ELSE 'unknown'
      END::text,
      COALESCE(grantor_identity.rolname, 'UNRESOLVED')::text,
      CASE
        WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE COALESCE(grantee_identity.rolname, 'UNRESOLVED')
      END::text,
      'default_acl'::text,
      namespace_entry.nspname::text,
      default_acl.defaclobjtype::text,
      NULL::text,
      NULL::text,
      acl.privilege_type::text,
      acl.is_grantable,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_default_acl AS default_acl
    LEFT JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = default_acl.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS acl
    INNER JOIN target_roles AS target_role
      ON target_role.oid = acl.grantee OR target_role.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantor_identity
      ON grantor_identity.oid = acl.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee_identity
      ON grantee_identity.oid = acl.grantee

    UNION ALL

    SELECT
      'direct_membership'::text,
      member_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'role'::text,
      NULL::text,
      granted_role.rolname::text,
      NULL::text,
      NULL::text,
      'MEMBER'::text,
      membership.admin_option,
      granted_role.rolname::text,
      membership.inherit_option,
      membership.set_option
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS grantor_role
      ON grantor_role.oid = membership.grantor
    WHERE member_role.oid IN (SELECT oid FROM target_roles)
       OR granted_role.oid IN (SELECT oid FROM target_roles)
       OR grantor_role.oid IN (SELECT oid FROM target_roles)

    UNION ALL

    SELECT
      'recursive_membership'::text,
      member_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'role'::text,
      NULL::text,
      granted_role.rolname::text,
      NULL::text,
      NULL::text,
      'MEMBER'::text,
      false,
      granted_role.rolname::text,
      NULL::boolean,
      NULL::boolean
    FROM target_roles AS member_role
    CROSS JOIN pg_catalog.pg_roles AS granted_role
    WHERE member_role.oid <> granted_role.oid
      AND pg_catalog.pg_has_role(member_role.oid, granted_role.oid, 'MEMBER')

    UNION ALL

    SELECT
      'effective_membership'::text,
      member_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'role'::text,
      NULL::text,
      granted_role.rolname::text,
      NULL::text,
      NULL::text,
      'USAGE'::text,
      false,
      granted_role.rolname::text,
      NULL::boolean,
      NULL::boolean
    FROM target_roles AS member_role
    CROSS JOIN pg_catalog.pg_roles AS granted_role
    WHERE member_role.oid <> granted_role.oid
      AND pg_catalog.pg_has_role(member_role.oid, granted_role.oid, 'USAGE')

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'database'::text,
      NULL::text,
      database_entry.datname::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_database AS database_entry
    INNER JOIN target_roles AS target_role ON target_role.oid = database_entry.datdba

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'schema'::text,
      namespace_entry.nspname::text,
      namespace_entry.nspname::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_namespace AS namespace_entry
    INNER JOIN target_roles AS target_role ON target_role.oid = namespace_entry.nspowner

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      CASE relation_entry.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'table'
        WHEN 'i' THEN 'index'
        WHEN 'I' THEN 'index'
        WHEN 'S' THEN 'sequence'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized_view'
        WHEN 'f' THEN 'foreign_table'
        ELSE 'unexpected_relation'
      END::text,
      namespace_entry.nspname::text,
      relation_entry.relname::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_class AS relation_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = relation_entry.relnamespace
    INNER JOIN target_roles AS target_role ON target_role.oid = relation_entry.relowner

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'type'::text,
      namespace_entry.nspname::text,
      type_entry.typname::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_type AS type_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = type_entry.typnamespace
    INNER JOIN target_roles AS target_role ON target_role.oid = type_entry.typowner

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      CASE procedure_entry.prokind
        WHEN 'f' THEN 'function'
        WHEN 'p' THEN 'procedure'
        ELSE 'unexpected_routine'
      END::text,
      namespace_entry.nspname::text,
      procedure_entry.proname::text,
      NULL::text,
      pg_catalog.pg_get_function_identity_arguments(procedure_entry.oid)::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_proc AS procedure_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = procedure_entry.pronamespace
    INNER JOIN target_roles AS target_role ON target_role.oid = procedure_entry.proowner

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'default_acl'::text,
      namespace_entry.nspname::text,
      default_acl.defaclobjtype::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_default_acl AS default_acl
    LEFT JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = default_acl.defaclnamespace
    INNER JOIN target_roles AS target_role ON target_role.oid = default_acl.defaclrole

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'tablespace'::text,
      NULL::text,
      tablespace_entry.spcname::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_tablespace AS tablespace_entry
    INNER JOIN target_roles AS target_role ON target_role.oid = tablespace_entry.spcowner

    UNION ALL

    SELECT
      'uncovered_acl_dependency'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'unsupported_acl_dependency'::text,
      NULL::text,
      dependency_entry.classid::regclass::text,
      CASE
        WHEN dependency_entry.objsubid = 0 THEN NULL::text
        ELSE 'column'::text
      END,
      NULL::text,
      'ACL_DEPENDENCY'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_shdepend AS dependency_entry
    INNER JOIN target_roles AS target_role ON target_role.oid = dependency_entry.refobjid
    WHERE dependency_entry.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency_entry.deptype = 'a'
      AND NOT EXISTS (
        SELECT 1
        FROM explicit_acl_coverage AS coverage
        WHERE coverage.dbid = dependency_entry.dbid
          AND coverage.classid = dependency_entry.classid
          AND coverage.objid = dependency_entry.objid
          AND coverage.objsubid = dependency_entry.objsubid
          AND coverage.target_role_oid = dependency_entry.refobjid
      )

    UNION ALL

    SELECT
      'ownership'::text,
      target_role.rolname::text,
      NULL::text,
      NULL::text,
      NULL::text,
      'unsupported_owned_object'::text,
      NULL::text,
      dependency_entry.classid::regclass::text,
      NULL::text,
      NULL::text,
      'OWNER'::text,
      false,
      NULL::text,
      NULL::boolean,
      NULL::boolean
    FROM pg_catalog.pg_shdepend AS dependency_entry
    INNER JOIN target_roles AS target_role ON target_role.oid = dependency_entry.refobjid
    WHERE dependency_entry.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency_entry.deptype = 'o'
      AND dependency_entry.classid NOT IN (
        'pg_catalog.pg_class'::regclass,
        'pg_catalog.pg_proc'::regclass,
        'pg_catalog.pg_type'::regclass,
        'pg_catalog.pg_namespace'::regclass,
        'pg_catalog.pg_database'::regclass,
        'pg_catalog.pg_tablespace'::regclass,
        'pg_catalog.pg_default_acl'::regclass
      )
  )
  SELECT
    authority_kind,
    role_name,
    role_relation,
    grantor_name,
    grantee_name,
    object_kind,
    schema_name,
    object_name,
    column_name,
    function_identity,
    privilege_type,
    grant_option,
    granted_role,
    inherit_option,
    set_option
  FROM authority_inventory
  ORDER BY
    authority_kind,
    role_name,
    role_relation NULLS FIRST,
    grantor_name NULLS FIRST,
    grantee_name NULLS FIRST,
    object_kind,
    schema_name NULLS FIRST,
    object_name,
    column_name NULLS FIRST,
    function_identity NULLS FIRST,
    privilege_type,
    grant_option,
    granted_role NULLS FIRST,
    inherit_option NULLS FIRST,
    set_option NULLS FIRST
`;
export const TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS =
  TEMPORARY_AUTHORITY_INVENTORY_SQL;
const FIXTURE_EXTENSION_CONTRACT = Object.freeze([
  Object.freeze({ name: "plpgsql", schema: "pg_catalog", version: "1.0" }),
]);
const INDEPENDENT_EXTENSION_INVENTORY_SQL = `
  SELECT
    extension.extname AS name,
    namespace.nspname AS schema,
    extension.extversion AS version
  FROM pg_catalog.pg_extension AS extension
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = extension.extnamespace
  ORDER BY extension.extname, namespace.nspname, extension.extversion
`;
const HARNESS_DEADLINE_LIMITS = Object.freeze({
  totalMilliseconds: 300_000,
  connectMilliseconds: 10_000,
  queryMilliseconds: 30_000,
  statementMilliseconds: 20_000,
  lockMilliseconds: 5_000,
  idleTransactionMilliseconds: 20_000,
  closeMilliseconds: 5_000,
  phaseMilliseconds: 120_000,
  migrationMilliseconds: 180_000,
});
const INTERNAL_PRODUCTION_WRAPPER_PROBE_STATES = new WeakMap();
const INTERNAL_PRODUCTION_WRAPPER_PROBE_SPECIFICATION = Object.freeze({
  migrations: Object.freeze(
    Array.from({ length: EXPECTED_MIGRATION_COUNT }, (_value, index) =>
      Object.freeze({ tag: `000${index}_fixed_wrapper_probe` })
    )
  ),
});
const EXTERNAL_FIXTURE_PHASES = Object.freeze({
  fixtureClientConnect: "FIXTURE_CLIENT_CONNECT",
  fixtureIdentity: "FIXTURE_IDENTITY",
  fixtureLedgerSetup: "FIXTURE_LEDGER_SETUP",
  extensionInventory: "EXTENSION_INVENTORY",
  fixtureClientClose: "FIXTURE_CLIENT_CLOSE",
  preflightStability: "PREFLIGHT_STABILITY",
  snapshotDriftControl: "SNAPSHOT_DRIFT_CONTROL",
  extensionClassification: "EXTENSION_CLASSIFICATION",
  preMutationClientConnect: "PRE_MUTATION_CLIENT_CONNECT",
  preMutationIdentity: "PRE_MUTATION_IDENTITY",
  defaultPrivilegeRevoke: "DEFAULT_PRIVILEGE_REVOKE",
  fixtureRoleSetup: "FIXTURE_ROLE_SETUP",
  migrationBoundaryIdentity: "MIGRATION_BOUNDARY_IDENTITY",
  migrationBaseline: "MIGRATION_BASELINE",
  migrationPublicAclNegativeControl: "MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL",
  migrationFinal: "MIGRATION_FINAL",
  migrationReplay: "MIGRATION_REPLAY",
  migrationPostconditions: "MIGRATION_POSTCONDITIONS",
  migrationClientClose: "MIGRATION_CLIENT_CLOSE",
  transactionRollbackControl: "TRANSACTION_ROLLBACK_CONTROL",
  cleanupClientConnect: "CLEANUP_CLIENT_CONNECT",
  cleanupIdentity: "CLEANUP_IDENTITY",
  ownershipPreInventory: "OWNERSHIP_PRE_INVENTORY",
  ownershipCanonicalization: "OWNERSHIP_CANONICALIZATION",
  ownershipPostSnapshot: "OWNERSHIP_POST_SNAPSHOT",
  authorityPreInventory: "AUTHORITY_PRE_INVENTORY",
  boundedRevoke: "BOUNDED_REVOKE",
  authorityZeroResidue: "AUTHORITY_ZERO_RESIDUE",
  maintenanceOwnerSnapshot: "MAINTENANCE_OWNER_SNAPSHOT",
  canonicalClientClose: "CANONICAL_CLIENT_CLOSE",
  postflight: "POSTFLIGHT",
  postflightDrift: "POSTFLIGHT_DRIFT",
  unknown: "UNKNOWN",
});
const EXTERNAL_FIXTURE_PHASE_MARKERS = Object.freeze({
  FIXTURE_CLIENT_CONNECT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_CLIENT_CONNECT",
  FIXTURE_IDENTITY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_IDENTITY",
  FIXTURE_LEDGER_SETUP:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_LEDGER_SETUP",
  EXTENSION_INVENTORY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_EXTENSION_INVENTORY",
  FIXTURE_CLIENT_CLOSE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_CLIENT_CLOSE",
  PREFLIGHT_STABILITY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_PREFLIGHT_STABILITY",
  SNAPSHOT_DRIFT_CONTROL:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_SNAPSHOT_DRIFT_CONTROL",
  EXTENSION_CLASSIFICATION:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_EXTENSION_CLASSIFICATION",
  PRE_MUTATION_CLIENT_CONNECT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_PRE_MUTATION_CLIENT_CONNECT",
  PRE_MUTATION_IDENTITY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_PRE_MUTATION_IDENTITY",
  DEFAULT_PRIVILEGE_REVOKE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_DEFAULT_PRIVILEGE_REVOKE",
  FIXTURE_ROLE_SETUP:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_ROLE_SETUP",
  MIGRATION_BOUNDARY_IDENTITY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_BOUNDARY_IDENTITY",
  MIGRATION_BASELINE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_BASELINE",
  MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL",
  MIGRATION_FINAL:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL",
  MIGRATION_REPLAY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_REPLAY",
  MIGRATION_POSTCONDITIONS:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_POSTCONDITIONS",
  MIGRATION_CLIENT_CLOSE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_CLIENT_CLOSE",
  TRANSACTION_ROLLBACK_CONTROL:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_TRANSACTION_ROLLBACK_CONTROL",
  CLEANUP_CLIENT_CONNECT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CLEANUP_CLIENT_CONNECT",
  CLEANUP_IDENTITY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CLEANUP_IDENTITY",
  OWNERSHIP_PRE_INVENTORY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_OWNERSHIP_PRE_INVENTORY",
  OWNERSHIP_CANONICALIZATION:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_OWNERSHIP_CANONICALIZATION",
  OWNERSHIP_POST_SNAPSHOT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_OWNERSHIP_POST_SNAPSHOT",
  AUTHORITY_PRE_INVENTORY:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_AUTHORITY_PRE_INVENTORY",
  BOUNDED_REVOKE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_BOUNDED_REVOKE",
  AUTHORITY_ZERO_RESIDUE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_AUTHORITY_ZERO_RESIDUE",
  MAINTENANCE_OWNER_SNAPSHOT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MAINTENANCE_OWNER_SNAPSHOT",
  CANONICAL_CLIENT_CLOSE:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CANONICAL_CLIENT_CLOSE",
  POSTFLIGHT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_POSTFLIGHT",
  POSTFLIGHT_DRIFT:
    "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_POSTFLIGHT_DRIFT",
  UNKNOWN: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
});
const EXTERNAL_FIXTURE_PHASE_FAILURES = new WeakMap();
const EXTERNAL_FIXTURE_NOT_CONFIGURED_FAILURES = new WeakSet();
const EXTERNAL_FIXTURE_OBSERVABILITY_CONTEXTS = new WeakSet();
const INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES = new WeakMap();
const INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_OPTIONS = new WeakMap();
const INITIAL_FIXTURE_CLIENT_LIFECYCLE = Symbol("initial-fixture-client-lifecycle");
const MIGRATION_CLIENT_LIFECYCLE = Symbol("migration-client-lifecycle");
const CANONICAL_CLEANUP_CLIENT_LIFECYCLE = Symbol(
  "canonical-cleanup-client-lifecycle"
);
const INTERNAL_PHASE_PROBE_FAILURE = Object.freeze(Object.create(null));

class HarnessIssue extends Error {
  constructor(code) {
    super(code);
    this.name = "HarnessIssue";
    this.code = code;
    if (code === "EXTERNAL_FIXTURE_NOT_CONFIGURED") {
      EXTERNAL_FIXTURE_NOT_CONFIGURED_FAILURES.add(this);
    }
  }
}

function requireHarness(condition, code) {
  if (!condition) throw new HarnessIssue(code);
}

function fixedExternalFixturePhase(phase) {
  return Object.prototype.hasOwnProperty.call(
    EXTERNAL_FIXTURE_PHASE_MARKERS,
    phase
  )
    ? phase
    : EXTERNAL_FIXTURE_PHASES.unknown;
}

function createExternalFixturePhaseFailure(context, phase) {
  const failure = Object.freeze(Object.create(null));
  EXTERNAL_FIXTURE_PHASE_FAILURES.set(
    failure,
    Object.freeze({ context, phase: fixedExternalFixturePhase(phase) })
  );
  return failure;
}

function externalFixtureFailureMarker(error) {
  if (EXTERNAL_FIXTURE_NOT_CONFIGURED_FAILURES.has(error)) {
    return "EXTERNAL_FIXTURE_NOT_CONFIGURED";
  }
  const brand = EXTERNAL_FIXTURE_PHASE_FAILURES.get(error);
  return EXTERNAL_FIXTURE_PHASE_MARKERS[
    brand?.phase ?? EXTERNAL_FIXTURE_PHASES.unknown
  ];
}

function requiredEnvironmentValue(environment, key) {
  const value = environment?.[key];
  requireHarness(
    typeof value === "string" && value.length > 0,
    "EXTERNAL_FIXTURE_NOT_CONFIGURED"
  );
  return value;
}

function parseCanonicalInteger(value, expected, code) {
  requireHarness(/^(?:0|[1-9][0-9]*)$/.test(value), code);
  const parsed = Number(value);
  requireHarness(Number.isSafeInteger(parsed) && parsed === expected, code);
  return parsed;
}

function validateExternalFixtureConfiguration(environment = process.env) {
  const allowedFixtureKeys = new Set(Object.values(FIXTURE_KEYS));
  requireHarness(
    Object.keys(environment || {}).every(
      (key) =>
        !key.startsWith("ACTUSTUBE_STAGING_HARNESS_") ||
        allowedFixtureKeys.has(key)
    ),
    "EXTERNAL_FIXTURE_INPUT_INVALID"
  );
  const rawUrl = requiredEnvironmentValue(environment, FIXTURE_KEYS.url);
  const expectedDatabase = requiredEnvironmentValue(
    environment,
    FIXTURE_KEYS.database
  );
  const expectedRole = requiredEnvironmentValue(environment, FIXTURE_KEYS.role);
  const expectedMajor = requiredEnvironmentValue(environment, FIXTURE_KEYS.major);
  const expectedMigrationMax = requiredEnvironmentValue(
    environment,
    FIXTURE_KEYS.migrationMax
  );

  requireHarness(
    SAFE_IDENTIFIER.test(expectedDatabase),
    "EXTERNAL_FIXTURE_DATABASE_INVALID"
  );
  requireHarness(
    SAFE_IDENTIFIER.test(expectedRole),
    "EXTERNAL_FIXTURE_ROLE_INVALID"
  );
  requireHarness(
    !/[\u0000-\u0020\u007f]|%|[?#,]|\[|\]/.test(rawUrl),
    "EXTERNAL_FIXTURE_URL_INVALID"
  );
  const match = FIXTURE_URL.exec(rawUrl);
  requireHarness(match !== null, "EXTERNAL_FIXTURE_URL_INVALID");
  const [, protocol, role, password, rawPort, database] = match;
  requireHarness(
    protocol === "postgres" || protocol === "postgresql",
    "EXTERNAL_FIXTURE_URL_INVALID"
  );
  requireHarness(SAFE_PASSWORD.test(password), "EXTERNAL_FIXTURE_URL_INVALID");
  const port = Number(rawPort);
  requireHarness(
    Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      String(port) === rawPort,
    "EXTERNAL_FIXTURE_PORT_INVALID"
  );
  requireHarness(
    database === expectedDatabase,
    "EXTERNAL_FIXTURE_DATABASE_MISMATCH"
  );
  requireHarness(role === expectedRole, "EXTERNAL_FIXTURE_ROLE_MISMATCH");

  return Object.freeze({
    rawUrl,
    host: "127.0.0.1",
    port,
    database,
    role,
    password,
    expectedMajor: parseCanonicalInteger(
      expectedMajor,
      EXPECTED_MAJOR,
      "EXTERNAL_FIXTURE_MAJOR_INVALID"
    ),
    expectedMigrationMax: parseCanonicalInteger(
      expectedMigrationMax,
      EXPECTED_MIGRATION_MAX,
      "EXTERNAL_FIXTURE_MIGRATION_MAX_INVALID"
    ),
  });
}

export function validateExternalFixtureConfigurationForTests(environment) {
  const configuration = validateExternalFixtureConfiguration(environment);
  return Object.freeze({
    valid: true,
    numericLoopback: configuration.host === "127.0.0.1",
    explicitPort: true,
    databaseIdentity: "match",
    roleIdentity: "match",
    postgresqlMajor: configuration.expectedMajor,
    migrationMax: configuration.expectedMigrationMax,
  });
}

function normalizeDeadlineLimits(overrides = {}) {
  const limits = {};
  for (const [key, maximum] of Object.entries(HARNESS_DEADLINE_LIMITS)) {
    const value = overrides[key] ?? maximum;
    requireHarness(
      Number.isSafeInteger(value) && value >= 1 && value <= maximum,
      "EXTERNAL_FIXTURE_DEADLINE_CONFIGURATION_INVALID"
    );
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function createDeadlineContext(overrides) {
  const limits = normalizeDeadlineLimits(overrides);
  const startedAt = performance.now();
  return {
    limits,
    absoluteDeadline: startedAt + limits.totalMilliseconds,
    timedOut: false,
    activeClients: new Set(),
    ownedClients: new Set(),
    operationStarts: {
      connect: 0,
      query: 0,
      close: 0,
      phase: 0,
      migration: 0,
    },
  };
}

function remainingTotalMilliseconds(context) {
  return Math.floor(context.absoluteDeadline - performance.now());
}

function destroyOwnedClient(ownedClient) {
  if (ownedClient.destroyed) return false;
  ownedClient.destroyed = true;
  ownedClient.usable = false;
  const stream = ownedClient.rawClient?.connection?.stream;
  requireHarness(
    stream && typeof stream.destroy === "function",
    "EXTERNAL_FIXTURE_OWNED_CONNECTION_DESTROY_UNAVAILABLE"
  );
  ownedClient.destroyCount += 1;
  try {
    stream.destroy();
  } catch {
    // The owned socket is already marked unusable. Public output remains fixed.
  }
  return true;
}

function destroyActiveOwnedClients(context) {
  for (const ownedClient of [...context.activeClients]) {
    destroyOwnedClient(ownedClient);
  }
  context.activeClients.clear();
}

async function runBoundedOperation(
  context,
  { category, maximumMilliseconds, ownedClient = null },
  operation
) {
  const remaining = remainingTotalMilliseconds(context);
  if (context.timedOut || remaining <= 0 || ownedClient?.destroyed) {
    context.timedOut = true;
    destroyActiveOwnedClients(context);
    throw new HarnessIssue("EXTERNAL_FIXTURE_OPERATION_TIMEOUT");
  }
  const timeoutMilliseconds = Math.max(
    1,
    Math.min(maximumMilliseconds, remaining)
  );
  context.operationStarts[category] += 1;
  const operationPromise = Promise.resolve().then(operation);
  operationPromise.catch(() => undefined);

  return await new Promise((resolveOperation, rejectOperation) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      context.timedOut = true;
      try {
        destroyActiveOwnedClients(context);
      } catch {
        rejectOperation(
          new HarnessIssue("EXTERNAL_FIXTURE_OWNED_CONNECTION_DESTROY_FAILED")
        );
        return;
      }
      rejectOperation(new HarnessIssue("EXTERNAL_FIXTURE_OPERATION_TIMEOUT"));
    }, timeoutMilliseconds);

    operationPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveOperation(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectOperation(error);
      }
    );
  });
}

function createOwnedClient(context, rawClient) {
  requireHarness(
    rawClient &&
      typeof rawClient.connect === "function" &&
      typeof rawClient.query === "function" &&
      typeof rawClient.end === "function",
    "EXTERNAL_FIXTURE_CONNECTION_FACTORY_INVALID"
  );
  const ownedClient = {
    rawClient,
    destroyed: false,
    closed: false,
    usable: true,
    destroyCount: 0,
    proxy: null,
  };
  ownedClient.proxy = new Proxy(rawClient, {
    get(target, property, receiver) {
      if (property === "query") {
        return (...argumentsList) => queryOwnedClient(context, ownedClient, ...argumentsList);
      }
      if (property === "end") {
        return () => closeOwnedClient(context, ownedClient);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  context.activeClients.add(ownedClient);
  context.ownedClients.add(ownedClient);
  return ownedClient;
}

async function queryOwnedClient(context, ownedClient, ...argumentsList) {
  requireHarness(
    ownedClient.usable && !ownedClient.destroyed && !ownedClient.closed,
    context.timedOut
      ? "EXTERNAL_FIXTURE_OPERATION_TIMEOUT"
      : "EXTERNAL_FIXTURE_CONNECTION_UNUSABLE"
  );
  return await runBoundedOperation(
    context,
    {
      category: "query",
      maximumMilliseconds: context.limits.queryMilliseconds,
      ownedClient,
    },
    () => ownedClient.rawClient.query(...argumentsList)
  );
}

async function closeOwnedClient(context, ownedClient) {
  if (ownedClient.closed || ownedClient.destroyed) {
    context.activeClients.delete(ownedClient);
    return;
  }
  try {
    await runBoundedOperation(
      context,
      {
        category: "close",
        maximumMilliseconds: context.limits.closeMilliseconds,
        ownedClient,
      },
      () => ownedClient.rawClient.end()
    );
    ownedClient.closed = true;
    ownedClient.usable = false;
  } finally {
    context.activeClients.delete(ownedClient);
  }
}

async function runBoundedPhase(context, category, maximumMilliseconds, operation) {
  return await runBoundedOperation(
    context,
    { category, maximumMilliseconds },
    operation
  );
}

async function runExternalFixturePhase(context, phase, operation) {
  const fixedPhase = fixedExternalFixturePhase(phase);
  const probeState = INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.get(context);
  const observable =
    EXTERNAL_FIXTURE_OBSERVABILITY_CONTEXTS.has(context) || probeState !== undefined;
  if (!observable) return await operation();

  let injectFixedProbeFailure = false;
  if (probeState) {
    probeState.phaseTrace.push(fixedPhase);
    if (
      probeState.targetPhase === fixedPhase &&
      probeState.targetHitCount === 0
    ) {
      probeState.targetHitCount += 1;
      injectFixedProbeFailure = !(
        probeState.productionGraph === true &&
        [
          EXTERNAL_FIXTURE_PHASES.fixtureClientConnect,
          EXTERNAL_FIXTURE_PHASES.fixtureClientClose,
          EXTERNAL_FIXTURE_PHASES.preMutationClientConnect,
          EXTERNAL_FIXTURE_PHASES.migrationClientClose,
          EXTERNAL_FIXTURE_PHASES.cleanupClientConnect,
          EXTERNAL_FIXTURE_PHASES.canonicalClientClose,
        ].includes(fixedPhase)
      );
    }
    if (
      fixedPhase === EXTERNAL_FIXTURE_PHASES.postflight ||
      fixedPhase === EXTERNAL_FIXTURE_PHASES.postflightDrift
    ) {
      probeState.postflightStartCount += 1;
    }
  }

  try {
    if (injectFixedProbeFailure) throw INTERNAL_PHASE_PROBE_FAILURE;
    if (
      probeState?.productionGraph === true &&
      ![
        EXTERNAL_FIXTURE_PHASES.fixtureClientConnect,
        EXTERNAL_FIXTURE_PHASES.fixtureClientClose,
        EXTERNAL_FIXTURE_PHASES.preMutationClientConnect,
        EXTERNAL_FIXTURE_PHASES.migrationClientClose,
        EXTERNAL_FIXTURE_PHASES.cleanupClientConnect,
        EXTERNAL_FIXTURE_PHASES.canonicalClientClose,
      ].includes(fixedPhase)
    ) {
      probeState.skippedOperationCount += 1;
      if (fixedPhase === EXTERNAL_FIXTURE_PHASES.extensionInventory) {
        return fixedExpectedExtensionInventory();
      }
      if (
        fixedPhase === EXTERNAL_FIXTURE_PHASES.preMutationIdentity ||
        fixedPhase === EXTERNAL_FIXTURE_PHASES.migrationBoundaryIdentity
      ) {
        return Object.freeze({ sessionRole: "actustube_ci_fixture" });
      }
      if (
        fixedPhase ===
        EXTERNAL_FIXTURE_PHASES.migrationPublicAclNegativeControl
      ) {
        return "fixed_phase_probe_acl_hash";
      }
      return undefined;
    }
    if (probeState) probeState.operationStartCount += 1;
    return await operation();
  } catch (error) {
    const existingBrand = EXTERNAL_FIXTURE_PHASE_FAILURES.get(error);
    if (existingBrand?.context === context) throw error;
    throw createExternalFixturePhaseFailure(context, fixedPhase);
  }
}

function runFixtureClientConnectPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.fixtureClientConnect,
    operation
  );
}

function runFixtureIdentityPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.fixtureIdentity,
    operation
  );
}

function runFixtureLedgerSetupPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.fixtureLedgerSetup,
    operation
  );
}

function runExtensionInventoryPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.extensionInventory,
    operation
  );
}

function runFixtureClientClosePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.fixtureClientClose,
    operation
  );
}

function runPreflightStabilityPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.preflightStability,
    operation
  );
}

function runSnapshotDriftControlPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.snapshotDriftControl,
    operation
  );
}

function runExtensionClassificationPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.extensionClassification,
    operation
  );
}

function runPreMutationClientConnectPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.preMutationClientConnect,
    operation
  );
}

function runPreMutationIdentityPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.preMutationIdentity,
    operation
  );
}

function runDefaultPrivilegeRevokePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.defaultPrivilegeRevoke,
    operation
  );
}

function runFixtureRoleSetupPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.fixtureRoleSetup,
    operation
  );
}

function runMigrationBoundaryIdentityPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationBoundaryIdentity,
    operation
  );
}

function runMigrationBaselinePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationBaseline,
    operation
  );
}

function runMigrationPublicAclNegativeControlPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationPublicAclNegativeControl,
    operation
  );
}

function runMigrationFinalPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationFinal,
    operation
  );
}

function runMigrationReplayPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationReplay,
    operation
  );
}

function runMigrationPostconditionsPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationPostconditions,
    operation
  );
}

function runMigrationClientClosePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.migrationClientClose,
    operation
  );
}

function runTransactionRollbackControlPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.transactionRollbackControl,
    operation
  );
}

function runCleanupClientConnectPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.cleanupClientConnect,
    operation
  );
}

function runCleanupIdentityPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.cleanupIdentity,
    operation
  );
}

function runOwnershipPreInventoryPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.ownershipPreInventory,
    operation
  );
}

function runOwnershipCanonicalizationPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.ownershipCanonicalization,
    operation
  );
}

function runOwnershipPostSnapshotPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.ownershipPostSnapshot,
    operation
  );
}

function runAuthorityPreInventoryPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.authorityPreInventory,
    operation
  );
}

function runBoundedRevokePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.boundedRevoke,
    operation
  );
}

function runAuthorityZeroResiduePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.authorityZeroResidue,
    operation
  );
}

function runMaintenanceOwnerSnapshotPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.maintenanceOwnerSnapshot,
    operation
  );
}

function runCanonicalClientClosePhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.canonicalClientClose,
    operation
  );
}

function runPostflightPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.postflight,
    operation
  );
}

function runPostflightDriftPhase(context, operation) {
  return runExternalFixturePhase(
    context,
    EXTERNAL_FIXTURE_PHASES.postflightDrift,
    operation
  );
}

function createPgClientFactory(deadlineLimits = HARNESS_DEADLINE_LIMITS) {
  return ({ host, port, database, role, password }) =>
    new Client({
      host,
      port,
      database,
      user: role,
      password,
      connectionTimeoutMillis: deadlineLimits.connectMilliseconds,
      query_timeout: deadlineLimits.queryMilliseconds,
      statement_timeout: deadlineLimits.statementMilliseconds,
      lock_timeout: deadlineLimits.lockMilliseconds,
      idle_in_transaction_session_timeout:
        deadlineLimits.idleTransactionMilliseconds,
    });
}

async function openClient(context, clientFactory, credentials) {
  const client = clientFactory(credentials);
  requireHarness(
    !client || typeof client.then !== "function",
    "EXTERNAL_FIXTURE_CONNECTION_FACTORY_INVALID"
  );
  const ownedClient = createOwnedClient(context, client);
  try {
    await runBoundedOperation(
      context,
      {
        category: "connect",
        maximumMilliseconds: context.limits.connectMilliseconds,
        ownedClient,
      },
      () => ownedClient.rawClient.connect()
    );
    return ownedClient;
  } catch (error) {
    if (!ownedClient.destroyed) {
      try {
        await closeOwnedClient(context, ownedClient);
      } catch {
        if (!ownedClient.destroyed) destroyOwnedClient(ownedClient);
      }
    }
    throw error;
  }
}

async function withClient(
  context,
  clientFactory,
  credentials,
  operation,
  lifecycle = null
) {
  const openOperation = () => openClient(context, clientFactory, credentials);
  const ownedClient =
    lifecycle === INITIAL_FIXTURE_CLIENT_LIFECYCLE
      ? await runFixtureClientConnectPhase(context, openOperation)
      : lifecycle === MIGRATION_CLIENT_LIFECYCLE
        ? await runPreMutationClientConnectPhase(context, openOperation)
      : lifecycle === CANONICAL_CLEANUP_CLIENT_LIFECYCLE
        ? await runCleanupClientConnectPhase(context, openOperation)
        : await openOperation();
  let operationResult;
  let primaryFailure;
  let primaryFailed = false;
  try {
    operationResult = await operation(ownedClient.proxy, ownedClient);
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }

  let closeFailure;
  let closeFailed = false;
  try {
    if (lifecycle === INITIAL_FIXTURE_CLIENT_LIFECYCLE) {
      await runFixtureClientClosePhase(context, () =>
        closeOwnedClient(context, ownedClient)
      );
    } else if (lifecycle === MIGRATION_CLIENT_LIFECYCLE) {
      await runMigrationClientClosePhase(context, () =>
        closeOwnedClient(context, ownedClient)
      );
    } else if (lifecycle === CANONICAL_CLEANUP_CLIENT_LIFECYCLE) {
      await runCanonicalClientClosePhase(context, () =>
        closeOwnedClient(context, ownedClient)
      );
    } else {
      await closeOwnedClient(context, ownedClient);
    }
  } catch (error) {
    closeFailed = true;
    closeFailure = error;
  }

  if (primaryFailed) throw primaryFailure;
  if (closeFailed) throw closeFailure;
  return operationResult;
}

function fixtureCredentials(configuration, overrides = {}) {
  return {
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    role: configuration.role,
    password: configuration.password,
    ...overrides,
  };
}

function createAdapter(context, clientFactory, credentialsForKind) {
  return {
    async connect(kind) {
      const ownedClient = await openClient(
        context,
        clientFactory,
        credentialsForKind(kind)
      );
      return {
        query(statement, parameters = []) {
          return ownedClient.proxy.query(statement, parameters);
        },
        close() {
          return closeOwnedClient(context, ownedClient);
        },
      };
    },
  };
}

function sameSql(left, right) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  return normalize(left) === normalize(right);
}

function quoteIdentifier(value) {
  requireHarness(SAFE_IDENTIFIER.test(value), "EXTERNAL_FIXTURE_IDENTIFIER_INVALID");
  return `"${value}"`;
}

async function assertFixtureIdentity(client, configuration) {
  const result = await client.query(`
    SELECT
      pg_catalog.current_database() AS database_name,
      current_user AS role_name,
      current_setting('server_version_num') AS server_version_num
  `);
  const row = result.rows?.[0];
  requireHarness(
    row?.database_name === configuration.database,
    "EXTERNAL_FIXTURE_DATABASE_MISMATCH"
  );
  requireHarness(
    row?.role_name === configuration.role,
    "EXTERNAL_FIXTURE_ROLE_MISMATCH"
  );
  requireHarness(
    Math.trunc(Number(row?.server_version_num) / 10_000) ===
      configuration.expectedMajor,
    "EXTERNAL_FIXTURE_MAJOR_MISMATCH"
  );
}

async function createEmptyMigrationLedger(client) {
  await client.query("CREATE SCHEMA drizzle");
  await client.query(`
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

function exactOwnKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function validateIndependentExtensionInventory(rows) {
  requireHarness(
    Array.isArray(rows) && rows.length === FIXTURE_EXTENSION_CONTRACT.length,
    "EXTERNAL_FIXTURE_EXTENSION_INVENTORY_MISMATCH"
  );
  for (const [index, row] of rows.entries()) {
    const expected = FIXTURE_EXTENSION_CONTRACT[index];
    requireHarness(
      exactOwnKeys(row, ["name", "schema", "version"]) &&
        typeof row.name === "string" &&
        typeof row.schema === "string" &&
        typeof row.version === "string" &&
        row.name === expected.name &&
        row.schema === expected.schema &&
        row.version === expected.version,
      "EXTERNAL_FIXTURE_EXTENSION_INVENTORY_MISMATCH"
    );
  }
  return true;
}

function fixedExpectedExtensionInventory() {
  return JSON.stringify({
    schemaVersion: 1,
    extensions: FIXTURE_EXTENSION_CONTRACT.map((entry) => ({ ...entry })),
  });
}

async function verifyIndependentExtensionInventory(client) {
  const result = await client.query(INDEPENDENT_EXTENSION_INVENTORY_SQL);
  validateIndependentExtensionInventory(result.rows);
  return fixedExpectedExtensionInventory();
}

function preflightEnvironment(configuration, extensions) {
  return {
    ACTUSTUBE_DB_ENV: "staging",
    ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "1",
    DIRECT_DATABASE_URL: configuration.rawUrl,
    DATABASE_URL: configuration.rawUrl,
    ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "local-postflight-fixture",
    ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: extensions,
  };
}

async function runStablePreflight(
  context,
  configuration,
  clientFactory,
  extensions,
  betweenSnapshotTransactions
) {
  const statements = [];
  const adapter = createAdapter(context, clientFactory, () =>
    fixtureCredentials(configuration)
  );
  const report = await runBoundedPhase(
    context,
    "phase",
    context.limits.phaseMilliseconds,
    () =>
      verifyStagingDatabasePreflight({
        environment: preflightEnvironment(configuration, extensions),
        repositoryRoot,
        adapter,
        allowLoopback: true,
        onQuery(statement) {
          assertReadOnlySql(statement);
          statements.push(statement);
        },
        betweenSnapshotTransactions,
      })
  );
  return { report, statements };
}

async function queryExtensionClassification(
  context,
  clientFactory,
  configuration,
  { managed, residual }
) {
  return withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      const managedSql = managed
        ? "SELECT 'pg_class'::pg_catalog.regclass::oid, 90001::oid, 0"
        : "SELECT 0::oid, 0::oid, 0 WHERE false";
      const residualSql = residual
        ? "SELECT 'relation'::text, 'pg_class'::pg_catalog.regclass::oid, 90001::oid, 0"
        : "SELECT ''::text, 0::oid, 0::oid, 0 WHERE false";
      const statement = `
        WITH extension_classification(
          object_signature, evidence_signature, evidence_kind, dependency_type,
          dependent_class, referenced_class, referenced_is_direct_extension_member,
          rule_name, relation_kind, trigger_constraint_matches, constraint_type
        ) AS (
          VALUES (
            '1259:90001:0'::text,
            'dependency:1259:90001:0:fixture'::text,
            'dependency'::text, 'e'::text, 'pg_class'::text,
            'pg_extension'::text, false, NULL::text, NULL::text, false,
            NULL::text
          )
        ), extension_managed(classid, objid, objsubid) AS (
          ${managedSql}
        ), residual_objects(kind, classid, objid, objsubid) AS (
          ${residualSql}
        ), ${PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS}
        SELECT
          (SELECT count(*)::integer FROM extension_dependency_evidence)
            AS evidence_count,
          (SELECT count(*)::integer FROM extension_dependency_evidence
            WHERE classification_count = 0) AS unclassified_count,
          (SELECT count(*)::integer FROM extension_dependency_evidence
            WHERE classification_count > 1) AS ambiguous_count,
          (SELECT min(classification_count)::integer
            FROM extension_dependency_evidence) AS classification_count,
          (SELECT count(*)::integer FROM extension_classification_complete
            WHERE evidence_kind = 'dependency') AS complete_dependency_count
      `;
      assertReadOnlySql(statement);
      return (await client.query(statement)).rows[0];
    }
  );
}

async function verifyExtensionClassificationMatrix(
  context,
  clientFactory,
  configuration
) {
  const cases = [
    { managed: true, residual: false, expected: [1, 0, 0, 1, 1] },
    { managed: false, residual: true, expected: [1, 0, 0, 1, 1] },
    { managed: false, residual: false, expected: [1, 1, 0, 0, 1] },
    { managed: true, residual: true, expected: [1, 0, 1, 2, 1] },
  ];
  for (const entry of cases) {
    const row = await queryExtensionClassification(
      context,
      clientFactory,
      configuration,
      entry
    );
    const actual = [
      row.evidence_count,
      row.unclassified_count,
      row.ambiguous_count,
      row.classification_count,
      row.complete_dependency_count,
    ].map(Number);
    requireHarness(
      JSON.stringify(actual) === JSON.stringify(entry.expected),
      "EXTERNAL_FIXTURE_EXTENSION_CLASSIFICATION_MISMATCH"
    );
  }
}

async function assertMigrationLedger(client, expectedCount) {
  const result = await client.query(`
    SELECT
      count(*)::integer AS row_count,
      count(DISTINCT hash)::integer AS distinct_hash_count,
      count(DISTINCT created_at)::integer AS distinct_created_at_count
    FROM drizzle.__drizzle_migrations
  `);
  const row = result.rows?.[0];
  requireHarness(
    Number(row?.row_count) === expectedCount &&
      Number(row?.distinct_hash_count) === expectedCount &&
      Number(row?.distinct_created_at_count) === expectedCount,
    "EXTERNAL_FIXTURE_MIGRATION_LEDGER_MISMATCH"
  );
}

function databaseErrorCode(error) {
  return (
    error?.code ??
    (error?.cause && typeof error.cause === "object"
      ? error.cause.code
      : undefined)
  );
}

async function expectDatabaseFailure(operation, expectedCode) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  requireHarness(Boolean(failure), "EXTERNAL_FIXTURE_EXPECTED_FAILURE_MISSING");
  requireHarness(
    databaseErrorCode(failure) === expectedCode,
    "EXTERNAL_FIXTURE_EXPECTED_FAILURE_MISMATCH"
  );
}

function migrationConfiguration() {
  return {
    migrationsFolder: join(repositoryRoot, "drizzle"),
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  };
}

async function applyMigrationCountWithinBoundary(client, expectedCount) {
  const configuration = migrationConfiguration();
  const migrations = readMigrationFiles(configuration);
  requireHarness(
    migrations.length === EXPECTED_MIGRATION_COUNT &&
      Number.isSafeInteger(expectedCount) &&
      expectedCount >= 1 &&
      expectedCount <= migrations.length,
    "EXTERNAL_FIXTURE_MIGRATION_CONTRACT_MISMATCH"
  );
  const database = drizzle(client);
  await database.dialect.migrate(
    migrations.slice(0, expectedCount),
    database.session,
    configuration
  );
}

async function applyMigrationCount(context, client, expectedCount) {
  await runBoundedPhase(
    context,
    "migration",
    context.limits.migrationMilliseconds,
    () => applyMigrationCountWithinBoundary(client, expectedCount)
  );
}

function assertUsageFixtureRoleSeparation(sessionRole) {
  const internalRoles = [
    ...Object.values(USAGE_FIXTURE_ROLES),
    ...Object.values(USAGE_MIGRATION_BOUNDARY_ROLES),
    RUNTIME_ROLE,
  ];
  requireHarness(
    SAFE_IDENTIFIER.test(sessionRole) &&
      new Set(internalRoles).size === internalRoles.length &&
      !internalRoles.includes(sessionRole),
    "EXTERNAL_FIXTURE_ROLE_CONTRACT_MISMATCH"
  );
}

async function createUsageFixtureRoles(client) {
  const roles = USAGE_FIXTURE_ROLES;
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  await client.query(`
    CREATE ROLE ${quoteIdentifier(boundary.legacyOwner)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${quoteIdentifier(boundary.migrationExecutor)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${quoteIdentifier(roles.explicitRuntime)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${quoteIdentifier(roles.runtimeGroup)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${quoteIdentifier(roles.membershipRuntime)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${quoteIdentifier(roles.deniedRuntime)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${quoteIdentifier(roles.publicProbe)}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  `);
}

async function grantUsageMigrationPrivileges(client) {
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  await client.query(`
    DO $fixture_database_grant$
    BEGIN
      EXECUTE pg_catalog.format(
        'GRANT CREATE ON DATABASE %I TO %I',
        pg_catalog.current_database(),
        '${boundary.migrationExecutor}'
      );
    END;
    $fixture_database_grant$;
    GRANT USAGE, CREATE ON SCHEMA public TO
      ${quoteIdentifier(boundary.migrationExecutor)},
      ${quoteIdentifier(boundary.legacyOwner)};
    GRANT USAGE, CREATE ON SCHEMA drizzle
      TO ${quoteIdentifier(boundary.migrationExecutor)};
    GRANT SELECT, INSERT ON TABLE drizzle.__drizzle_migrations
      TO ${quoteIdentifier(boundary.migrationExecutor)};
    GRANT USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq
      TO ${quoteIdentifier(boundary.migrationExecutor)};
  `);
}

async function configureUsageMigrationBaseline(client) {
  const roles = USAGE_FIXTURE_ROLES;
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  await client.query(`
    ALTER FUNCTION ${LEGACY_USAGE_SIGNATURE}
      OWNER TO ${quoteIdentifier(boundary.legacyOwner)};
    GRANT ${quoteIdentifier(roles.runtimeGroup)}
      TO ${quoteIdentifier(roles.membershipRuntime)};
    GRANT USAGE ON SCHEMA public TO
      ${quoteIdentifier(roles.explicitRuntime)},
      ${quoteIdentifier(roles.runtimeGroup)},
      ${quoteIdentifier(roles.deniedRuntime)},
      ${quoteIdentifier(roles.publicProbe)};
    REVOKE ALL PRIVILEGES ON FUNCTION ${LEGACY_USAGE_SIGNATURE} FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${LEGACY_USAGE_SIGNATURE}
      TO ${quoteIdentifier(roles.explicitRuntime)} WITH GRANT OPTION;
    GRANT EXECUTE ON FUNCTION ${LEGACY_USAGE_SIGNATURE}
      TO ${quoteIdentifier(roles.runtimeGroup)};
  `);
}

async function grantLegacyOwnerMembership(client) {
  await client.query(`
    GRANT ${quoteIdentifier(USAGE_MIGRATION_BOUNDARY_ROLES.legacyOwner)}
      TO ${quoteIdentifier(USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor)}
  `);
}

async function withMigrationExecutorRole(context, client, operation) {
  await client.query(
    `SET ROLE ${quoteIdentifier(USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor)}`
  );
  try {
    return await operation();
  } finally {
    if (!context.timedOut && remainingTotalMilliseconds(context) > 0) {
      await client.query("RESET ROLE");
    }
  }
}

function singleExactRow(result, expectedKeys, code) {
  requireHarness(
    Array.isArray(result?.rows) &&
      result.rows.length === 1 &&
      exactOwnKeys(result.rows[0], expectedKeys),
    code
  );
  return result.rows[0];
}

function validateObservedSessionIdentity(identity, code) {
  requireHarness(
    identity !== null &&
      typeof identity === "object" &&
      Object.isFrozen(identity) &&
      exactOwnKeys(identity, ["sessionRole"]) &&
      typeof identity.sessionRole === "string" &&
      SAFE_IDENTIFIER.test(identity.sessionRole) &&
      ![
        ...Object.values(USAGE_FIXTURE_ROLES),
        ...Object.values(USAGE_MIGRATION_BOUNDARY_ROLES),
        RUNTIME_ROLE,
      ].includes(identity.sessionRole),
    code
  );
  return identity.sessionRole;
}

async function observeSessionIdentity(client, expectedSessionRole, code) {
  requireHarness(
    typeof expectedSessionRole === "string" &&
      SAFE_IDENTIFIER.test(expectedSessionRole),
    code
  );
  const result = await client.query(
    `SELECT
       session_user AS session_role,
       current_user AS effective_role`
  );
  const row = singleExactRow(
    result,
    ["session_role", "effective_role"],
    code
  );
  requireHarness(
    typeof row.session_role === "string" &&
      typeof row.effective_role === "string" &&
      SAFE_IDENTIFIER.test(row.session_role) &&
      SAFE_IDENTIFIER.test(row.effective_role) &&
      row.session_role === row.effective_role &&
      row.session_role === expectedSessionRole &&
      ![
        ...Object.values(USAGE_FIXTURE_ROLES),
        ...Object.values(USAGE_MIGRATION_BOUNDARY_ROLES),
        RUNTIME_ROLE,
      ].includes(row.session_role),
    code
  );
  return Object.freeze({ sessionRole: row.session_role });
}

function createObservedSessionIdentityAuthority(observedSessionIdentity) {
  validateObservedSessionIdentity(
    observedSessionIdentity,
    "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_INVALID"
  );
  return Object.freeze({ observedSessionIdentity });
}

function requireOriginalObservedSessionIdentity(
  identityAuthority,
  observedSessionIdentity
) {
  requireHarness(
    identityAuthority !== null &&
      typeof identityAuthority === "object" &&
      Object.isFrozen(identityAuthority) &&
      exactOwnKeys(identityAuthority, ["observedSessionIdentity"]) &&
      identityAuthority.observedSessionIdentity === observedSessionIdentity,
    "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_REFERENCE_MISMATCH"
  );
  return validateObservedSessionIdentity(
    observedSessionIdentity,
    "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_INVALID"
  );
}

async function runPreMutationSessionIdentityBoundary({
  context,
  clientFactory,
  credentials,
  expectedSessionRole,
  operation,
}) {
  requireHarness(
    typeof operation === "function",
    "EXTERNAL_FIXTURE_PRE_MUTATION_BOUNDARY_INVALID"
  );
  return await withClient(
    context,
    clientFactory,
    credentials,
    async (client) => {
      const observedSessionIdentity = await runPreMutationIdentityPhase(
        context,
        () =>
          observeSessionIdentity(
            client,
            expectedSessionRole,
            "EXTERNAL_FIXTURE_INITIAL_SESSION_IDENTITY_MISMATCH"
          )
      );
      const identityAuthority =
        createObservedSessionIdentityAuthority(observedSessionIdentity);
      const operationResult = await operation(
        client,
        observedSessionIdentity,
        identityAuthority
      );
      requireOriginalObservedSessionIdentity(
        identityAuthority,
        observedSessionIdentity
      );
      return Object.freeze({ identityAuthority, operationResult });
    },
    MIGRATION_CLIENT_LIFECYCLE
  );
}

function validateInitialMigrationBoundaryRoles(result, expectedSessionRole) {
  const code = "EXTERNAL_FIXTURE_INITIAL_ROLE_CONTRACT_MISMATCH";
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  const expectedRoleNames = [boundary.legacyOwner, boundary.migrationExecutor];
  requireHarness(
    Array.isArray(result?.rows) && result.rows.length === expectedRoleNames.length,
    code
  );
  const observedOids = new Set();
  const observedNames = new Set();
  for (const [index, row] of result.rows.entries()) {
    requireHarness(
      exactOwnKeys(row, [
        "ordinal",
        "role_name",
        "role_oid",
        "session_role",
        "effective_role",
        "role_restricted",
        "oid_is_separated",
      ]) &&
        row.ordinal === index + 1 &&
        row.role_name === expectedRoleNames[index] &&
        typeof row.role_oid === "string" &&
        /^[1-9][0-9]*$/.test(row.role_oid) &&
        row.session_role === expectedSessionRole &&
        row.effective_role === expectedSessionRole &&
        row.role_restricted === true &&
        row.oid_is_separated === true &&
        !observedNames.has(row.role_name) &&
        !observedOids.has(row.role_oid),
      code
    );
    observedNames.add(row.role_name);
    observedOids.add(row.role_oid);
  }
  requireHarness(
    observedNames.size === expectedRoleNames.length &&
      observedOids.size === expectedRoleNames.length,
    code
  );
}

async function assertInitialMigrationBoundaryRoles(
  client,
  expectedSessionRole,
  identityAuthority,
  preMutationObservedIdentity
) {
  const observedSessionRole = requireOriginalObservedSessionIdentity(
    identityAuthority,
    preMutationObservedIdentity
  );
  const boundaryObservedIdentity = await observeSessionIdentity(
    client,
    expectedSessionRole,
    "EXTERNAL_FIXTURE_INITIAL_SESSION_IDENTITY_MISMATCH"
  );
  requireHarness(
    validateObservedSessionIdentity(
      boundaryObservedIdentity,
      "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_INVALID"
    ) === observedSessionRole,
    "EXTERNAL_FIXTURE_INITIAL_SESSION_IDENTITY_MISMATCH"
  );
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  const conflictingRoles = [
    ...Object.values(USAGE_FIXTURE_ROLES),
    RUNTIME_ROLE,
  ];
  const result = await client.query(
    `WITH expected(role_name, ordinal) AS (
       SELECT role_name, ordinal::integer
       FROM unnest($1::text[]) WITH ORDINALITY
         AS expected(role_name, ordinal)
     )
     SELECT
       expected.ordinal,
       role_entry.rolname AS role_name,
       role_entry.oid::text AS role_oid,
       session_user AS session_role,
       current_user AS effective_role,
       (
         NOT role_entry.rolcanlogin
         AND NOT role_entry.rolsuper
         AND NOT role_entry.rolcreatedb
         AND NOT role_entry.rolcreaterole
         AND NOT role_entry.rolreplication
         AND NOT role_entry.rolbypassrls
       ) AS role_restricted,
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_roles AS conflicting_role
         WHERE conflicting_role.oid = role_entry.oid
           AND (
             conflicting_role.rolname = session_user
             OR conflicting_role.rolname = ANY($2::text[])
           )
       ) AS oid_is_separated
     FROM expected
     LEFT JOIN pg_catalog.pg_roles AS role_entry
       ON role_entry.rolname = expected.role_name
     ORDER BY expected.ordinal`,
    [
      [boundary.legacyOwner, boundary.migrationExecutor],
      conflictingRoles,
    ]
  );
  validateInitialMigrationBoundaryRoles(result, expectedSessionRole);
  return boundaryObservedIdentity;
}

async function assertMigrationExecutorIdentity(client, expectedSessionRole) {
  const result = await client.query(
    `SELECT
       session_user AS session_role,
       current_user AS effective_role,
       role.rolname AS migration_executor_name,
       (
         NOT role.rolcanlogin
         AND NOT role.rolsuper
         AND NOT role.rolcreatedb
         AND NOT role.rolcreaterole
         AND NOT role.rolreplication
         AND NOT role.rolbypassrls
       ) AS migration_executor_restricted
     FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = $1`,
    [USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor]
  );
  const row = singleExactRow(
    result,
    [
      "session_role",
      "effective_role",
      "migration_executor_name",
      "migration_executor_restricted",
    ],
    "EXTERNAL_FIXTURE_MIGRATION_ROLE_PRECONDITION_MISMATCH"
  );
  requireHarness(
    row.session_role === expectedSessionRole &&
      row.effective_role === USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor &&
      row.migration_executor_name ===
        USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor &&
      row.migration_executor_restricted === true,
    "EXTERNAL_FIXTURE_MIGRATION_ROLE_PRECONDITION_MISMATCH"
  );
}

function validateMigrationRolePrecondition(result, expectedSessionRole) {
  const row = singleExactRow(
    result,
    [
      "session_role",
      "effective_role",
      "legacy_function_owner_oid",
      "legacy_owner_oid",
      "legacy_owner_name",
      "migration_executor_oid",
      "migration_executor_name",
      "has_legacy_membership",
      "legacy_owner_restricted",
      "migration_executor_restricted",
    ],
    "EXTERNAL_FIXTURE_MIGRATION_ROLE_PRECONDITION_MISMATCH"
  );
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  requireHarness(
    row.session_role === expectedSessionRole &&
      row.effective_role === boundary.migrationExecutor &&
      row.legacy_owner_name === boundary.legacyOwner &&
      row.migration_executor_name === boundary.migrationExecutor &&
      typeof row.legacy_function_owner_oid === "string" &&
      /^[1-9][0-9]*$/.test(row.legacy_function_owner_oid) &&
      row.legacy_function_owner_oid === row.legacy_owner_oid &&
      typeof row.migration_executor_oid === "string" &&
      /^[1-9][0-9]*$/.test(row.migration_executor_oid) &&
      row.legacy_owner_oid !== row.migration_executor_oid &&
      row.effective_role !== row.legacy_owner_name &&
      row.session_role !== row.legacy_owner_name &&
      row.has_legacy_membership === true &&
      row.legacy_owner_restricted === true &&
      row.migration_executor_restricted === true,
    "EXTERNAL_FIXTURE_MIGRATION_ROLE_PRECONDITION_MISMATCH"
  );
  return row;
}

async function assertMigrationRolePrecondition(client, expectedSessionRole) {
  const boundary = USAGE_MIGRATION_BOUNDARY_ROLES;
  const result = await client.query(
    `WITH legacy_function AS (
       SELECT procedure.proowner
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid = pg_catalog.to_regprocedure($1)
     ),
     legacy_role AS (
       SELECT * FROM pg_catalog.pg_roles WHERE rolname = $2
     ),
     migration_executor AS (
       SELECT * FROM pg_catalog.pg_roles WHERE rolname = $3
     )
     SELECT
       session_user AS session_role,
       current_user AS effective_role,
       legacy_function.proowner::text AS legacy_function_owner_oid,
       legacy_role.oid::text AS legacy_owner_oid,
       legacy_role.rolname AS legacy_owner_name,
       migration_executor.oid::text AS migration_executor_oid,
       migration_executor.rolname AS migration_executor_name,
       pg_catalog.pg_has_role(
         migration_executor.oid,
         legacy_role.oid,
         'MEMBER'
       ) AS has_legacy_membership,
       (
         NOT legacy_role.rolcanlogin
         AND NOT legacy_role.rolsuper
         AND NOT legacy_role.rolcreatedb
         AND NOT legacy_role.rolcreaterole
         AND NOT legacy_role.rolreplication
         AND NOT legacy_role.rolbypassrls
       ) AS legacy_owner_restricted,
       (
         NOT migration_executor.rolcanlogin
         AND NOT migration_executor.rolsuper
         AND NOT migration_executor.rolcreatedb
         AND NOT migration_executor.rolcreaterole
         AND NOT migration_executor.rolreplication
         AND NOT migration_executor.rolbypassrls
       ) AS migration_executor_restricted
     FROM legacy_function
     CROSS JOIN legacy_role
     CROSS JOIN migration_executor`,
    [LEGACY_USAGE_SIGNATURE, boundary.legacyOwner, boundary.migrationExecutor]
  );
  validateMigrationRolePrecondition(result, expectedSessionRole);
}

async function verifyPublicAclMigrationFailure(
  context,
  client,
  expectedSessionRole
) {
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${LEGACY_USAGE_SIGNATURE} TO PUBLIC`
  );
  await withMigrationExecutorRole(context, client, async () => {
    await assertMigrationRolePrecondition(client, expectedSessionRole);
    await expectDatabaseFailure(
      () => applyMigrationCount(context, client, EXPECTED_MIGRATION_COUNT),
      "P0001"
    );
  });
  requireHarness(
    !context.timedOut,
    "EXTERNAL_FIXTURE_OPERATION_TIMEOUT"
  );
  await assertMigrationLedger(client, EXPECTED_MIGRATION_MAX);
  const result = await client.query(`
    SELECT
      pg_catalog.to_regprocedure(
        'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)'
      ) IS NULL AS versioned_function_absent,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS acl
        WHERE procedure.oid = pg_catalog.to_regprocedure($1)
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
      ) AS public_execute_retained
  `, [LEGACY_USAGE_SIGNATURE]);
  requireHarness(
    result.rows?.[0]?.versioned_function_absent === true &&
      result.rows?.[0]?.public_execute_retained === true,
    "EXTERNAL_FIXTURE_PUBLIC_ACL_FAILURE_NOT_ATOMIC"
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON FUNCTION ${LEGACY_USAGE_SIGNATURE} FROM PUBLIC`
  );
}

function validateUsageOwnerPostcondition(result, expectedSessionRole) {
  const code = "EXTERNAL_FIXTURE_OWNER_POSTCONDITION_MISMATCH";
  requireHarness(
    Array.isArray(result?.rows) &&
      result.rows.length === USAGE_OWNER_IDENTITIES.length,
    code
  );
  const expectedOwner = USAGE_MIGRATION_BOUNDARY_ROLES.legacyOwner;
  const executor = USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor;
  let legacyOwnerOid = null;
  const observedIdentities = new Set();
  const observedFunctionOids = new Set();
  for (const [index, row] of result.rows.entries()) {
    requireHarness(
      exactOwnKeys(row, [
        "function_identity",
        "ordinal",
        "function_oid",
        "owner_oid",
        "owner_name",
        "acl_text",
        "security_definer",
        "search_path",
      ]) &&
        row.function_identity === USAGE_OWNER_IDENTITIES[index] &&
        row.ordinal === index + 1 &&
        typeof row.function_oid === "string" &&
        /^[1-9][0-9]*$/.test(row.function_oid) &&
        typeof row.owner_oid === "string" &&
        /^[1-9][0-9]*$/.test(row.owner_oid) &&
        row.owner_name === expectedOwner &&
        row.owner_name !== executor &&
        row.owner_name !== expectedSessionRole &&
        typeof row.acl_text === "string" &&
        row.acl_text.length > 0 &&
        typeof row.security_definer === "boolean" &&
        row.security_definer ===
          USAGE_OWNER_SECURITY_DEFINER_EXPECTATIONS[row.function_identity] &&
        Array.isArray(row.search_path) &&
        row.search_path.length === 1 &&
        row.search_path[0] === "search_path=public, pg_temp" &&
        !observedIdentities.has(row.function_identity) &&
        !observedFunctionOids.has(row.function_oid),
      code
    );
    observedIdentities.add(row.function_identity);
    observedFunctionOids.add(row.function_oid);
    if (index === 0) legacyOwnerOid = row.owner_oid;
    requireHarness(row.owner_oid === legacyOwnerOid, code);
  }
  requireHarness(
    observedIdentities.size === USAGE_OWNER_IDENTITIES.length &&
      observedFunctionOids.size === USAGE_OWNER_IDENTITIES.length &&
      typeof legacyOwnerOid === "string",
    code
  );
  return true;
}

async function assertUsageOwnerPostcondition(client, expectedSessionRole) {
  const result = await client.query(
    `WITH expected(function_identity, ordinal) AS (
       SELECT function_identity, ordinal::integer
       FROM unnest($1::text[]) WITH ORDINALITY
         AS expected(function_identity, ordinal)
     )
     SELECT
       expected.function_identity,
       expected.ordinal,
       target.oid::text AS function_oid,
       target.proowner::text AS owner_oid,
       pg_catalog.pg_get_userbyid(target.proowner) AS owner_name,
       target.proacl::text AS acl_text,
       target.prosecdef AS security_definer,
       target.proconfig AS search_path
     FROM expected
     LEFT JOIN LATERAL (
       SELECT procedure.*
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid =
         pg_catalog.to_regprocedure(expected.function_identity)
     ) AS target ON true
     ORDER BY expected.ordinal`,
    [USAGE_OWNER_IDENTITIES]
  );
  validateUsageOwnerPostcondition(result, expectedSessionRole);
}

function compareOwnershipRows(left, right) {
  for (const key of OWNERSHIP_ROW_KEYS) {
    const comparison = String(left[key] ?? "").localeCompare(
      String(right[key] ?? "")
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function sortedOwnershipRows(rows) {
  return [...rows].sort(compareOwnershipRows);
}

function compareTemporaryAuthorityRows(left, right) {
  for (const key of TEMPORARY_AUTHORITY_ROW_KEYS) {
    const comparison = String(left[key] ?? "").localeCompare(
      String(right[key] ?? "")
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function sortedTemporaryAuthorityRows(rows) {
  return [...rows].sort(compareTemporaryAuthorityRows);
}

function temporaryAuthorityRow({
  authorityKind,
  roleName,
  roleRelation = null,
  grantorName = null,
  granteeName = null,
  objectKind,
  schemaName = null,
  objectName,
  columnName = null,
  functionIdentity = null,
  privilegeType,
  grantOption = false,
  grantedRole = null,
  inheritOption = null,
  setOption = null,
}) {
  return {
    authority_kind: authorityKind,
    role_name: roleName,
    role_relation: roleRelation,
    grantor_name: grantorName,
    grantee_name: granteeName,
    object_kind: objectKind,
    schema_name: schemaName,
    object_name: objectName,
    column_name: columnName,
    function_identity: functionIdentity,
    privilege_type: privilegeType,
    grant_option: grantOption,
    granted_role: grantedRole,
    inherit_option: inheritOption,
    set_option: setOption,
  };
}

function buildTemporaryAuthorityContract({ database, observedSessionIdentity }) {
  const code = "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_CONTRACT_INVALID";
  const observedSessionRole = validateObservedSessionIdentity(
    observedSessionIdentity,
    code
  );
  requireHarness(
    SAFE_IDENTIFIER.test(database) &&
      SAFE_IDENTIFIER.test(USAGE_MIGRATION_BOUNDARY_ROLES.legacyOwner) &&
      SAFE_IDENTIFIER.test(USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor),
    code
  );
  const { legacyOwner, migrationExecutor } = USAGE_MIGRATION_BOUNDARY_ROLES;
  const temporaryAclAuthorityRow = (row) =>
    temporaryAuthorityRow({
      ...row,
      authorityKind: "explicit_acl",
      roleRelation: "grantee",
      grantorName: observedSessionRole,
      granteeName: row.roleName,
    });
  const rows = [
    temporaryAclAuthorityRow({
      roleName: migrationExecutor,
      objectKind: "database",
      objectName: database,
      privilegeType: "CREATE",
    }),
    ...["CREATE", "USAGE"].map((privilegeType) =>
      temporaryAclAuthorityRow({
        roleName: migrationExecutor,
        objectKind: "schema",
        schemaName: "public",
        objectName: "public",
        privilegeType,
      })
    ),
    ...["CREATE", "USAGE"].map((privilegeType) =>
      temporaryAclAuthorityRow({
        roleName: legacyOwner,
        objectKind: "schema",
        schemaName: "public",
        objectName: "public",
        privilegeType,
      })
    ),
    ...["CREATE", "USAGE"].map((privilegeType) =>
      temporaryAclAuthorityRow({
        roleName: migrationExecutor,
        objectKind: "schema",
        schemaName: MIGRATION_LEDGER_CONTRACT.schema,
        objectName: MIGRATION_LEDGER_CONTRACT.schema,
        privilegeType,
      })
    ),
    ...["INSERT", "SELECT"].map((privilegeType) =>
      temporaryAclAuthorityRow({
        roleName: migrationExecutor,
        objectKind: "table",
        schemaName: MIGRATION_LEDGER_CONTRACT.schema,
        objectName: MIGRATION_LEDGER_CONTRACT.table,
        privilegeType,
      })
    ),
    ...["SELECT", "USAGE"].map((privilegeType) =>
      temporaryAclAuthorityRow({
        roleName: migrationExecutor,
        objectKind: "sequence",
        schemaName: MIGRATION_LEDGER_CONTRACT.schema,
        objectName: MIGRATION_LEDGER_CONTRACT.sequence,
        privilegeType,
      })
    ),
    temporaryAuthorityRow({
      authorityKind: "direct_membership",
      roleName: migrationExecutor,
      objectKind: "role",
      objectName: legacyOwner,
      privilegeType: "MEMBER",
      grantedRole: legacyOwner,
      inheritOption: true,
      setOption: true,
    }),
    temporaryAuthorityRow({
      authorityKind: "recursive_membership",
      roleName: migrationExecutor,
      objectKind: "role",
      objectName: legacyOwner,
      privilegeType: "MEMBER",
      grantedRole: legacyOwner,
    }),
    temporaryAuthorityRow({
      authorityKind: "effective_membership",
      roleName: migrationExecutor,
      objectKind: "role",
      objectName: legacyOwner,
      privilegeType: "USAGE",
      grantedRole: legacyOwner,
    }),
  ];
  const sortedRows = sortedTemporaryAuthorityRows(rows);
  requireHarness(
    sortedRows.length === 14 &&
      new Set(
        sortedRows.map((row) =>
          JSON.stringify(TEMPORARY_AUTHORITY_ROW_KEYS.map((key) => row[key]))
        )
      ).size === sortedRows.length,
    code
  );
  return Object.freeze(sortedRows.map((row) => Object.freeze(row)));
}

function ownershipRow({
  objectKind,
  schemaName,
  objectName,
  functionIdentity = null,
  ownerName,
}) {
  return {
    object_kind: objectKind,
    schema_name: schemaName,
    object_name: objectName,
    function_identity: functionIdentity,
    owner_name: ownerName,
  };
}

function buildRepositoryOwnershipContract(specification, expectedSessionRole) {
  const code = "EXTERNAL_FIXTURE_OWNERSHIP_CONTRACT_INVALID";
  requireHarness(
    specification?.snapshot?.tables &&
      specification?.snapshot?.enums &&
      specification?.functionSourceHashes instanceof Map &&
      SAFE_IDENTIFIER.test(expectedSessionRole),
    code
  );
  const tables = Object.values(specification.snapshot.tables);
  const enums = Object.values(specification.snapshot.enums);
  const expectedFunctionNames = CANONICAL_FUNCTION_CONTRACT.map(
    (entry) => entry.name
  ).sort();
  requireHarness(
    JSON.stringify([...specification.functionSourceHashes.keys()].sort()) ===
      JSON.stringify(expectedFunctionNames),
    code
  );

  const tableNames = [];
  const indexNames = [];
  for (const table of tables) {
    requireHarness(
      (table?.schema === "" || table?.schema === "public") &&
        SAFE_IDENTIFIER.test(table?.name),
      code
    );
    const primaryColumns = Object.values(table.columns || {}).filter(
      (column) => column?.primaryKey === true
    );
    requireHarness(primaryColumns.length === 1, code);
    tableNames.push(table.name);
    indexNames.push(`${table.name}_pkey`);
    for (const index of Object.values(table.indexes || {})) {
      requireHarness(SAFE_IDENTIFIER.test(index?.name), code);
      indexNames.push(index.name);
    }
  }
  requireHarness(
    JSON.stringify([...tableNames].sort()) ===
      JSON.stringify(specification.expectedTableNames) &&
      new Set(tableNames).size === tableNames.length &&
      new Set(indexNames).size === indexNames.length,
    code
  );

  const enumNames = enums.map((entry) => {
    requireHarness(
      entry?.schema === "public" && SAFE_IDENTIFIER.test(entry?.name),
      code
    );
    return entry.name;
  });
  requireHarness(new Set(enumNames).size === enumNames.length, code);

  const legacyOwnedFunctionNames = new Set([
    "get_usage_status_v1",
    "reserve_usage_limits",
    "reserve_usage_limits_v2",
    "resolve_effective_usage_plan_v1",
    "usage_period_boundaries_v1",
  ]);
  const preCanonicalRows = [];
  for (const tableName of tableNames) {
    preCanonicalRows.push(
      ownershipRow({
        objectKind: "table",
        schemaName: "public",
        objectName: tableName,
        ownerName: USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor,
      })
    );
  }
  for (const indexName of indexNames) {
    preCanonicalRows.push(
      ownershipRow({
        objectKind: "index",
        schemaName: "public",
        objectName: indexName,
        ownerName: USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor,
      })
    );
  }
  for (const enumName of enumNames) {
    preCanonicalRows.push(
      ownershipRow({
        objectKind: "type",
        schemaName: "public",
        objectName: enumName,
        ownerName: USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor,
      })
    );
  }
  for (const entry of CANONICAL_FUNCTION_CONTRACT) {
    requireHarness(
      SAFE_IDENTIFIER.test(entry.name) &&
        typeof entry.identityArguments === "string" &&
        entry.identityArguments.length > 0 &&
        typeof entry.alterIdentity === "string" &&
        entry.alterIdentity.length > 0,
      code
    );
    preCanonicalRows.push(
      ownershipRow({
        objectKind: "function",
        schemaName: "public",
        objectName: entry.name,
        functionIdentity: entry.identityArguments,
        ownerName: legacyOwnedFunctionNames.has(entry.name)
          ? USAGE_MIGRATION_BOUNDARY_ROLES.legacyOwner
          : USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor,
      })
    );
  }

  const postCanonicalRows = [
    ownershipRow({
      objectKind: "database",
      schemaName: null,
      objectName: "current_database",
      ownerName: expectedSessionRole,
    }),
    ...FIXTURE_SCHEMA_NAMES.map((schemaName) =>
      ownershipRow({
        objectKind: "schema",
        schemaName,
        objectName: schemaName,
        ownerName: expectedSessionRole,
      })
    ),
    ...tableNames.map((tableName) =>
      ownershipRow({
        objectKind: "table",
        schemaName: "public",
        objectName: tableName,
        ownerName: expectedSessionRole,
      })
    ),
    ownershipRow({
      objectKind: "table",
      schemaName: MIGRATION_LEDGER_CONTRACT.schema,
      objectName: MIGRATION_LEDGER_CONTRACT.table,
      ownerName: expectedSessionRole,
    }),
    ...indexNames.map((indexName) =>
      ownershipRow({
        objectKind: "index",
        schemaName: "public",
        objectName: indexName,
        ownerName: expectedSessionRole,
      })
    ),
    ownershipRow({
      objectKind: "index",
      schemaName: MIGRATION_LEDGER_CONTRACT.schema,
      objectName: MIGRATION_LEDGER_CONTRACT.primaryKeyIndex,
      ownerName: expectedSessionRole,
    }),
    ownershipRow({
      objectKind: "sequence",
      schemaName: MIGRATION_LEDGER_CONTRACT.schema,
      objectName: MIGRATION_LEDGER_CONTRACT.sequence,
      ownerName: expectedSessionRole,
    }),
    ...enumNames.map((enumName) =>
      ownershipRow({
        objectKind: "type",
        schemaName: "public",
        objectName: enumName,
        ownerName: expectedSessionRole,
      })
    ),
    ...CANONICAL_FUNCTION_CONTRACT.map((entry) =>
      ownershipRow({
        objectKind: "function",
        schemaName: "public",
        objectName: entry.name,
        functionIdentity: entry.identityArguments,
        ownerName: expectedSessionRole,
      })
    ),
  ];

  return Object.freeze({
    tableNames: Object.freeze([...tableNames].sort()),
    indexNames: Object.freeze([...indexNames].sort()),
    enumNames: Object.freeze([...enumNames].sort()),
    preCanonicalRows: Object.freeze(sortedOwnershipRows(preCanonicalRows)),
    postCanonicalRows: Object.freeze(sortedOwnershipRows(postCanonicalRows)),
  });
}

function validateOwnershipRows(actualRows, expectedRows, code) {
  requireHarness(
    Array.isArray(actualRows) && actualRows.length === expectedRows.length,
    code
  );
  const observedSignatures = new Set();
  for (const [index, actual] of actualRows.entries()) {
    const expected = expectedRows[index];
    requireHarness(
      exactOwnKeys(actual, OWNERSHIP_ROW_KEYS) &&
        OWNERSHIP_ROW_KEYS.every((key) => actual[key] === expected[key]),
      code
    );
    const signature = JSON.stringify(
      OWNERSHIP_ROW_KEYS.slice(0, 4).map((key) => actual[key])
    );
    requireHarness(!observedSignatures.has(signature), code);
    observedSignatures.add(signature);
  }
  requireHarness(observedSignatures.size === expectedRows.length, code);
}

async function assertPreCanonicalOwnershipInventory(client, contract) {
  const result = await client.query(PRE_CANONICAL_OWNERSHIP_INVENTORY_SQL, [
    [
      USAGE_MIGRATION_BOUNDARY_ROLES.legacyOwner,
      USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor,
    ],
  ]);
  validateOwnershipRows(
    result.rows,
    contract.preCanonicalRows,
    "EXTERNAL_FIXTURE_PRE_CANONICAL_INVENTORY_MISMATCH"
  );
}

async function canonicalizeFixtureOwnership(client, contract) {
  for (const schemaName of FIXTURE_SCHEMA_NAMES) {
    await client.query(
      `ALTER SCHEMA ${quoteIdentifier(schemaName)} OWNER TO SESSION_USER`
    );
  }
  await client.query(
    'ALTER TABLE "drizzle"."__drizzle_migrations" OWNER TO SESSION_USER'
  );
  await client.query(
    'ALTER SEQUENCE "drizzle"."__drizzle_migrations_id_seq" OWNER TO SESSION_USER'
  );
  for (const tableName of contract.tableNames) {
    await client.query(
      `ALTER TABLE ${quoteIdentifier("public")}.${quoteIdentifier(tableName)} OWNER TO SESSION_USER`
    );
  }
  for (const enumName of contract.enumNames) {
    await client.query(
      `ALTER TYPE ${quoteIdentifier("public")}.${quoteIdentifier(enumName)} OWNER TO SESSION_USER`
    );
  }
  for (const entry of CANONICAL_FUNCTION_CONTRACT) {
    await client.query(
      `ALTER FUNCTION ${quoteIdentifier("public")}.${quoteIdentifier(entry.name)}(${entry.alterIdentity}) OWNER TO SESSION_USER`
    );
  }
}

async function assertPostCanonicalOwnershipSnapshot(client, contract) {
  const result = await client.query(POST_CANONICAL_OWNERSHIP_SNAPSHOT_SQL, [
    FIXTURE_SCHEMA_NAMES,
  ]);
  validateOwnershipRows(
    result.rows,
    contract.postCanonicalRows,
    "EXTERNAL_FIXTURE_POST_CANONICAL_SNAPSHOT_MISMATCH"
  );
}

function validateTemporaryAuthorityRows(actualRows, expectedRows, code) {
  requireHarness(
    Array.isArray(actualRows) && actualRows.length === expectedRows.length,
    code
  );
  const observedSignatures = new Set();
  for (const [index, actual] of actualRows.entries()) {
    const expected = expectedRows[index];
    requireHarness(
      exactOwnKeys(actual, TEMPORARY_AUTHORITY_ROW_KEYS) &&
        TEMPORARY_AUTHORITY_ROW_KEYS.every(
          (key) => actual[key] === expected[key]
        ),
      code
    );
    const signature = JSON.stringify(
      TEMPORARY_AUTHORITY_ROW_KEYS.map((key) => actual[key])
    );
    requireHarness(!observedSignatures.has(signature), code);
    observedSignatures.add(signature);
  }
  requireHarness(observedSignatures.size === expectedRows.length, code);
}

async function readTemporaryAuthorityInventory(client) {
  return await client.query(TEMPORARY_AUTHORITY_INVENTORY_SQL, [
    [
      USAGE_MIGRATION_BOUNDARY_ROLES.legacyOwner,
      USAGE_MIGRATION_BOUNDARY_ROLES.migrationExecutor,
    ],
  ]);
}

async function assertPreCleanupTemporaryAuthorityInventory(client, contract) {
  const result = await readTemporaryAuthorityInventory(client);
  validateTemporaryAuthorityRows(
    result.rows,
    contract,
    "EXTERNAL_FIXTURE_PRE_CLEANUP_AUTHORITY_MISMATCH"
  );
}

async function revokeTemporaryMigrationAuthorities(client) {
  const { legacyOwner, migrationExecutor } = USAGE_MIGRATION_BOUNDARY_ROLES;
  await client.query(`
    DO $fixture_database_revoke$
    BEGIN
      EXECUTE pg_catalog.format(
        'REVOKE CREATE ON DATABASE %I FROM %I',
        pg_catalog.current_database(),
        '${migrationExecutor}'
      );
    END;
    $fixture_database_revoke$;
  `);
  await client.query(
    `REVOKE USAGE, CREATE ON SCHEMA public FROM ${quoteIdentifier(migrationExecutor)}`
  );
  await client.query(
    `REVOKE USAGE, CREATE ON SCHEMA public FROM ${quoteIdentifier(legacyOwner)}`
  );
  await client.query(
    `REVOKE USAGE, CREATE ON SCHEMA drizzle FROM ${quoteIdentifier(migrationExecutor)}`
  );
  await client.query(
    `REVOKE SELECT, INSERT ON TABLE drizzle.__drizzle_migrations FROM ${quoteIdentifier(migrationExecutor)}`
  );
  await client.query(
    `REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM ${quoteIdentifier(migrationExecutor)}`
  );
  await client.query(
    `REVOKE ${quoteIdentifier(legacyOwner)} FROM ${quoteIdentifier(migrationExecutor)}`
  );
}

async function assertZeroTemporaryAuthorityResidue(client) {
  const result = await readTemporaryAuthorityInventory(client);
  validateTemporaryAuthorityRows(
    result.rows,
    [],
    "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
  );
}

async function runCanonicalOwnershipBoundary({
  context,
  clientFactory,
  configuration,
  identityAuthority,
  observedSessionIdentity,
  specification,
  postflightOperation,
  identityReferenceObserver = null,
}) {
  const observedSessionRole = requireOriginalObservedSessionIdentity(
    identityAuthority,
    observedSessionIdentity
  );
  requireHarness(
    identityReferenceObserver === null ||
      typeof identityReferenceObserver === "function",
    "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_REFERENCE_MISMATCH"
  );
  identityReferenceObserver?.(observedSessionIdentity);
  const contract = buildRepositoryOwnershipContract(
    specification,
    observedSessionRole
  );
  const temporaryAuthorityContract = buildTemporaryAuthorityContract({
    database: configuration.database,
    observedSessionIdentity,
  });
  await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await runCleanupIdentityPhase(context, () =>
        observeSessionIdentity(
          client,
          observedSessionRole,
          "EXTERNAL_FIXTURE_CLEANUP_SESSION_IDENTITY_MISMATCH"
        )
      );
      await runOwnershipPreInventoryPhase(context, () =>
        assertPreCanonicalOwnershipInventory(client, contract)
      );
      await runOwnershipCanonicalizationPhase(context, () =>
        canonicalizeFixtureOwnership(client, contract)
      );
      await runOwnershipPostSnapshotPhase(context, () =>
        assertPostCanonicalOwnershipSnapshot(client, contract)
      );
      await runAuthorityPreInventoryPhase(context, () =>
        assertPreCleanupTemporaryAuthorityInventory(
          client,
          temporaryAuthorityContract
        )
      );
      await runBoundedRevokePhase(context, () =>
        revokeTemporaryMigrationAuthorities(client)
      );
      await runAuthorityZeroResiduePhase(context, () =>
        assertZeroTemporaryAuthorityResidue(client)
      );
      await runMaintenanceOwnerSnapshotPhase(context, () =>
        assertPostCanonicalOwnershipSnapshot(client, contract)
      );
    },
    CANONICAL_CLEANUP_CLIENT_LIFECYCLE
  );
  requireHarness(
    typeof postflightOperation === "function",
    "EXTERNAL_FIXTURE_POSTFLIGHT_BOUNDARY_INVALID"
  );
  return await runPostflightPhase(context, postflightOperation);
}

async function configureRuntimeAcl(client, configuration) {
  await client.query(`
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.explicitRuntime)},
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.runtimeGroup)},
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.deniedRuntime)},
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.publicProbe)};
    REVOKE USAGE ON SCHEMA public FROM
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.explicitRuntime)},
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.runtimeGroup)},
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.deniedRuntime)},
      ${quoteIdentifier(USAGE_FIXTURE_ROLES.publicProbe)};
    CREATE ROLE ${quoteIdentifier(RUNTIME_ROLE)}
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD '${RUNTIME_PASSWORD}';
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
    ALTER ROLE ${quoteIdentifier(RUNTIME_ROLE)}
      SET search_path = public, pg_temp;
    GRANT CONNECT ON DATABASE ${quoteIdentifier(configuration.database)}
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT USAGE ON SCHEMA public, drizzle
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT SELECT ON TABLE drizzle.__drizzle_migrations
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT SELECT, INSERT, UPDATE ON TABLE
      public.users,
      public.oauth_accounts,
      public.user_usage_buckets,
      public.analysis_runs,
      public.improvement_actions
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT SELECT ON TABLE
      public.plans,
      public.user_plan_assignments
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT SELECT, INSERT, DELETE ON TABLE
      public.usage_reservation_leases
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT USAGE ON TYPE
      public.user_status,
      public.plan_assignment_status,
      public.plan_assignment_source,
      public.usage_metric,
      public.usage_period_kind,
      public.improvement_action_status
      TO ${quoteIdentifier(RUNTIME_ROLE)};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
      TO ${quoteIdentifier(RUNTIME_ROLE)};
  `);
}

async function runMigrationCallback(
  context,
  client,
  callbackKind,
  callback
) {
  requireHarness(
    ["baseline", "final", "replay"].includes(callbackKind) &&
      typeof callback === "function",
    "EXTERNAL_FIXTURE_MIGRATION_CALLBACK_INVALID"
  );
  const internalProbeState =
    INTERNAL_PRODUCTION_WRAPPER_PROBE_STATES.get(context);
  if (internalProbeState) {
    internalProbeState.migrationCallbackInvocations += 1;
  }
  const callbackResult = await runBoundedPhase(
    context,
    "migration",
    context.limits.migrationMilliseconds,
    () => callback(client, callbackKind)
  );
  requireHarness(
    callbackResult === undefined,
    "EXTERNAL_FIXTURE_MIGRATION_CALLBACK_REPLACEMENT"
  );
}

async function orchestrateUsageMigrationOwnerBoundary({
  context,
  client,
  expectedSessionRole,
  identityAuthority,
  observedSessionIdentity,
  baselineMigration,
  finalMigration,
  replayMigration,
  beforeFinalMigration,
  identityReferenceObserver = null,
}) {
  requireHarness(
    typeof beforeFinalMigration === "function" &&
      (identityReferenceObserver === null ||
        typeof identityReferenceObserver === "function"),
    "EXTERNAL_FIXTURE_MIGRATION_CALLBACK_INVALID"
  );
  requireOriginalObservedSessionIdentity(
    identityAuthority,
    observedSessionIdentity
  );
  await runFixtureRoleSetupPhase(context, () => createUsageFixtureRoles(client));
  const boundaryObservedIdentity = await runMigrationBoundaryIdentityPhase(
    context,
    () =>
      assertInitialMigrationBoundaryRoles(
        client,
        expectedSessionRole,
        identityAuthority,
        observedSessionIdentity
      )
  );
  identityReferenceObserver?.({
    preMutationObservedIdentity:
      identityAuthority.observedSessionIdentity,
    downstreamObservedIdentity: observedSessionIdentity,
    boundaryObservedIdentity,
  });
  await runFixtureRoleSetupPhase(context, () =>
    grantUsageMigrationPrivileges(client)
  );
  await runMigrationBaselinePhase(context, async () => {
    await withMigrationExecutorRole(context, client, async () => {
      await assertMigrationExecutorIdentity(client, expectedSessionRole);
      await runMigrationCallback(
        context,
        client,
        "baseline",
        baselineMigration
      );
    });
    await configureUsageMigrationBaseline(client);
    await grantLegacyOwnerMembership(client);
  });
  const beforeFinalResult = await runMigrationPublicAclNegativeControlPhase(
    context,
    () => beforeFinalMigration(client)
  );
  await runMigrationFinalPhase(context, () =>
    withMigrationExecutorRole(context, client, async () => {
      await assertMigrationRolePrecondition(client, expectedSessionRole);
      await runMigrationCallback(context, client, "final", finalMigration);
    })
  );
  await runMigrationPostconditionsPhase(context, () =>
    assertUsageOwnerPostcondition(client, expectedSessionRole)
  );
  await runMigrationReplayPhase(context, () =>
    withMigrationExecutorRole(context, client, async () => {
      await assertMigrationRolePrecondition(client, expectedSessionRole);
      await runMigrationCallback(context, client, "replay", replayMigration);
    })
  );
  await runMigrationPostconditionsPhase(context, () =>
    assertUsageOwnerPostcondition(client, expectedSessionRole)
  );
  return Object.freeze({ beforeFinalResult });
}

async function applyMigrationsAndRuntimeAcl(
  context,
  clientFactory,
  configuration,
  specification
) {
  const internalProbeState =
    INTERNAL_PRODUCTION_WRAPPER_PROBE_STATES.get(context) ?? null;
  if (internalProbeState) {
    internalProbeState.productionApplyInvocations += 1;
  }
  assertUsageFixtureRoleSeparation(configuration.role);
  requireHarness(
    specification.migrations.length === EXPECTED_MIGRATION_COUNT &&
      specification.migrations.at(-1)?.tag.startsWith("0006_"),
    "EXTERNAL_FIXTURE_MIGRATION_CONTRACT_MISMATCH"
  );
  const preMutationBoundary = await runPreMutationSessionIdentityBoundary({
    context,
    clientFactory,
    credentials: fixtureCredentials(configuration),
    expectedSessionRole: configuration.role,
    async operation(
      client,
      preMutationObservedIdentity,
      identityAuthority
    ) {
      const downstreamObservedIdentity =
        internalProbeState?.replaceObservedIdentityForTest === true
          ? Object.freeze({
              sessionRole: preMutationObservedIdentity.sessionRole,
            })
          : preMutationObservedIdentity;
      if (internalProbeState) {
        internalProbeState.initialObservedIdentityReference =
          preMutationObservedIdentity;
        internalProbeState.downstreamObservedIdentityReference =
          downstreamObservedIdentity;
      }
      requireOriginalObservedSessionIdentity(
        identityAuthority,
        downstreamObservedIdentity
      );
      await runDefaultPrivilegeRevokePhase(context, () =>
        client.query(
          "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
        )
      );
      const boundaryResult = await orchestrateUsageMigrationOwnerBoundary({
        context,
        client,
        expectedSessionRole: configuration.role,
        identityAuthority,
        observedSessionIdentity: downstreamObservedIdentity,
        async baselineMigration(callbackClient) {
          await applyMigrationCountWithinBoundary(
            callbackClient,
            EXPECTED_MIGRATION_MAX
          );
          await assertMigrationLedger(callbackClient, EXPECTED_MIGRATION_MAX);
          await verifyOldMigrationCompatibility(context, callbackClient);
          if (internalProbeState?.callbackScenario === "replace-client") {
            return { replacementClient: true };
          }
        },
        async beforeFinalMigration(callbackClient) {
          await verifyPublicAclMigrationFailure(
            context,
            callbackClient,
            configuration.role
          );
          const aclHash = (
            await callbackClient.query(
              `SELECT pg_catalog.md5(proacl::text) AS acl_hash
               FROM pg_catalog.pg_proc
               WHERE oid = pg_catalog.to_regprocedure($1)`,
              [LEGACY_USAGE_SIGNATURE]
            )
          ).rows?.[0]?.acl_hash;
          requireHarness(
            typeof aclHash === "string",
            "EXTERNAL_FIXTURE_LEGACY_ACL_UNAVAILABLE"
          );
          return aclHash;
        },
        async finalMigration(callbackClient) {
          await applyMigrationCountWithinBoundary(
            callbackClient,
            EXPECTED_MIGRATION_COUNT
          );
          await assertMigrationLedger(callbackClient, EXPECTED_MIGRATION_COUNT);
        },
        async replayMigration(callbackClient) {
          await applyMigrationCountWithinBoundary(
            callbackClient,
            EXPECTED_MIGRATION_COUNT
          );
          await assertMigrationLedger(callbackClient, EXPECTED_MIGRATION_COUNT);
        },
        identityReferenceObserver: internalProbeState
          ? (references) => {
              internalProbeState.downstreamObservedIdentityReference =
                references.downstreamObservedIdentity;
              internalProbeState.boundaryObservedIdentityReference =
                references.boundaryObservedIdentity;
            }
          : null,
      });
      return boundaryResult.beforeFinalResult;
    },
  });
  const { identityAuthority, operationResult: legacyAclHash } =
    preMutationBoundary;
  if (internalProbeState) {
    internalProbeState.laterVerificationStubInvocations += 1;
  } else {
    await runMigrationPostconditionsPhase(context, async () => {
      await verifyUsageAclInheritance(
        context,
        clientFactory,
        configuration,
        legacyAclHash,
        configuration.role
      );
      await verifyPlanResolution(context, clientFactory, configuration);
      await verifyReservationLifecycle(context, clientFactory, configuration);
      await withClient(
        context,
        clientFactory,
        fixtureCredentials(configuration),
        (client) => configureRuntimeAcl(client, configuration)
      );
    });
  }
  requireOriginalObservedSessionIdentity(
    identityAuthority,
    identityAuthority.observedSessionIdentity
  );
  return identityAuthority;
}

function usageSignatureArraySql() {
  return VERSIONED_USAGE_SIGNATURES.map(
    (signature) => `'${signature.replaceAll("'", "''")}'`
  ).join(", ");
}

async function catalogBoolean(client, statement, parameters = []) {
  const result = await client.query(statement, parameters);
  const value = result.rows?.[0]
    ? Object.values(result.rows[0])[0]
    : undefined;
  requireHarness(value === true, "EXTERNAL_FIXTURE_USAGE_CONTRACT_MISMATCH");
  return true;
}

function usageUserStateQuery() {
  return `
    SELECT json_build_object(
      'assignments', (SELECT COUNT(*) FROM public.user_plan_assignments WHERE user_id = $1),
      'buckets', (SELECT COUNT(*) FROM public.user_usage_buckets WHERE user_id = $1),
      'leases', (SELECT COUNT(*) FROM public.usage_reservation_leases WHERE user_id = $1),
      'analysis', (SELECT COUNT(*) FROM public.analysis_runs WHERE user_id = $1),
      'ai', (
        SELECT COUNT(*) FROM public.analysis_runs
        WHERE user_id = $1 AND ai_consult_snapshot IS NOT NULL
      ),
      'improvements', (SELECT COUNT(*) FROM public.improvement_actions WHERE user_id = $1)
    ) AS state
  `;
}

async function verifyOldMigrationCompatibility(context, client) {
  const userId = "50000000-0000-4000-8000-000000000001";
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.users (id, status, session_version)
       VALUES ($1, 'active', 1)`,
      [userId]
    );
    const before = (await client.query(usageUserStateQuery(), [userId])).rows[0]
      ?.state;
    await catalogBoolean(
      client,
      `SELECT pg_catalog.to_regprocedure(
         'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)'
       ) IS NULL
       AND pg_catalog.to_regprocedure(
         'public.get_usage_status_v1(uuid,integer,timestamp with time zone)'
       ) IS NULL AS compatible`
    );
    await client.query("SAVEPOINT versioned_function_absence");
    await expectDatabaseFailure(
      () =>
        client.query(
          `SELECT * FROM public.reserve_usage_limits_v2(
            $1::uuid, 1, 'channel_analysis'::public.usage_metric,
            statement_timestamp()
          )`,
          [userId]
        ),
      "42883"
    );
    await client.query("ROLLBACK TO SAVEPOINT versioned_function_absence");
    await client.query("RELEASE SAVEPOINT versioned_function_absence");
    const after = (await client.query(usageUserStateQuery(), [userId])).rows[0]
      ?.state;
    requireHarness(
      JSON.stringify(after) === JSON.stringify(before),
      "EXTERNAL_FIXTURE_OLD_MIGRATION_STATE_CHANGED"
    );
  } finally {
    if (!context.timedOut) await client.query("ROLLBACK");
  }
}

async function queryAsUsageRole(
  context,
  clientFactory,
  configuration,
  executionRole,
  statement,
  parameters = [],
  { commit = false } = {}
) {
  return await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          `SET LOCAL ROLE ${quoteIdentifier(executionRole)}`
        );
        const result = await client.query(statement, parameters);
        await client.query(commit ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        if (!context.timedOut) await client.query("ROLLBACK");
        throw error;
      }
    }
  );
}

async function verifyUsageAclInheritance(
  context,
  clientFactory,
  configuration,
  legacyAclHash,
  expectedSessionRole
) {
  await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await assertUsageOwnerPostcondition(client, expectedSessionRole);
      const targets = usageSignatureArraySql();
      await catalogBoolean(
        client,
        `WITH legacy AS (
           SELECT proowner FROM pg_catalog.pg_proc
           WHERE oid = pg_catalog.to_regprocedure($1)
         )
         SELECT COUNT(*) = ${VERSIONED_USAGE_SIGNATURES.length}
           AND bool_and(target.proowner = legacy.proowner) AS matches
         FROM unnest(ARRAY[${targets}]::text[]) AS signature
         CROSS JOIN legacy
         INNER JOIN pg_catalog.pg_proc AS target
           ON target.oid = pg_catalog.to_regprocedure(signature)`,
        [LEGACY_USAGE_SIGNATURE]
      );
      await catalogBoolean(
        client,
        `SELECT pg_catalog.md5(proacl::text) = $2 AS preserved
         FROM pg_catalog.pg_proc
         WHERE oid = pg_catalog.to_regprocedure($1)`,
        [LEGACY_USAGE_SIGNATURE, legacyAclHash]
      );
      await catalogBoolean(
        client,
        `SELECT bool_and(
           NOT EXISTS (
             SELECT acl.grantee, acl.privilege_type, acl.is_grantable
             FROM pg_catalog.pg_proc AS target
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(target.proacl, pg_catalog.acldefault('f', target.proowner))
             ) AS acl
             WHERE target.oid = pg_catalog.to_regprocedure(signature)
               AND acl.grantee <> target.proowner
             EXCEPT
             SELECT acl.grantee, acl.privilege_type, acl.is_grantable
             FROM pg_catalog.pg_proc AS legacy
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(legacy.proacl, pg_catalog.acldefault('f', legacy.proowner))
             ) AS acl
             WHERE legacy.oid = pg_catalog.to_regprocedure($1)
               AND acl.grantee <> legacy.proowner
           )
           AND NOT EXISTS (
             SELECT acl.grantee, acl.privilege_type, acl.is_grantable
             FROM pg_catalog.pg_proc AS legacy
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(legacy.proacl, pg_catalog.acldefault('f', legacy.proowner))
             ) AS acl
             WHERE legacy.oid = pg_catalog.to_regprocedure($1)
               AND acl.grantee <> legacy.proowner
             EXCEPT
             SELECT acl.grantee, acl.privilege_type, acl.is_grantable
             FROM pg_catalog.pg_proc AS target
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               COALESCE(target.proacl, pg_catalog.acldefault('f', target.proowner))
             ) AS acl
             WHERE target.oid = pg_catalog.to_regprocedure(signature)
               AND acl.grantee <> target.proowner
           )
         ) AS equal
         FROM unnest(ARRAY[${targets}]::text[]) AS signature`,
        [LEGACY_USAGE_SIGNATURE]
      );
      await catalogBoolean(
        client,
        `SELECT bool_and(
           pg_catalog.has_function_privilege(
             $1, pg_catalog.to_regprocedure(signature), 'EXECUTE'
           )
         ) AS allowed
         FROM unnest(ARRAY[${targets}]::text[]) AS signature`,
        [USAGE_FIXTURE_ROLES.explicitRuntime]
      );
      await catalogBoolean(
        client,
        `SELECT bool_and(
           pg_catalog.has_function_privilege(
             $1, pg_catalog.to_regprocedure(signature), 'EXECUTE'
           )
         ) AS allowed
         FROM unnest(ARRAY[${targets}]::text[]) AS signature`,
        [USAGE_FIXTURE_ROLES.membershipRuntime]
      );
      for (const deniedRole of [
        USAGE_FIXTURE_ROLES.deniedRuntime,
        USAGE_FIXTURE_ROLES.publicProbe,
      ]) {
        await catalogBoolean(
          client,
          `SELECT bool_and(
             NOT pg_catalog.has_function_privilege(
               $1, pg_catalog.to_regprocedure(signature), 'EXECUTE'
             )
           ) AS denied
           FROM unnest(ARRAY[${targets}]::text[]) AS signature`,
          [deniedRole]
        );
      }
      await catalogBoolean(
        client,
        `WITH legacy AS (
           SELECT prosecdef FROM pg_catalog.pg_proc
           WHERE oid = pg_catalog.to_regprocedure($1)
         )
         SELECT bool_and(target.prosecdef = legacy.prosecdef) AS matches
         FROM unnest(ARRAY[${targets}]::text[]) AS signature
         CROSS JOIN legacy
         INNER JOIN pg_catalog.pg_proc AS target
           ON target.oid = pg_catalog.to_regprocedure(signature)`,
        [LEGACY_USAGE_SIGNATURE]
      );
      await catalogBoolean(
        client,
        `SELECT bool_and(
           procedure.proconfig IS NOT DISTINCT FROM
             ARRAY['search_path=public, pg_temp']::text[]
         ) AS fixed
         FROM unnest(ARRAY[${targets}, '${LEGACY_USAGE_SIGNATURE}']::text[])
           AS signature
         INNER JOIN pg_catalog.pg_proc AS procedure
           ON procedure.oid = pg_catalog.to_regprocedure(signature)`
      );
    }
  );

  const nonExistingUser = "10000000-0000-4000-8000-000000000001";
  for (const executionRole of [
    USAGE_FIXTURE_ROLES.explicitRuntime,
    USAGE_FIXTURE_ROLES.membershipRuntime,
  ]) {
    const result = await queryAsUsageRole(
      context,
      clientFactory,
      configuration,
      executionRole,
      `SELECT allowed FROM public.reserve_usage_limits_v2(
         $1::uuid, 1, 'channel_analysis'::public.usage_metric,
         statement_timestamp()
       )`,
      [nonExistingUser]
    );
    requireHarness(
      result.rows?.[0]?.allowed === false,
      "EXTERNAL_FIXTURE_USAGE_RUNTIME_EXECUTION_MISMATCH"
    );
  }
  for (const deniedRole of [
    USAGE_FIXTURE_ROLES.deniedRuntime,
    USAGE_FIXTURE_ROLES.publicProbe,
  ]) {
    await expectDatabaseFailure(
      () =>
        queryAsUsageRole(
          context,
          clientFactory,
          configuration,
          deniedRole,
          `SELECT * FROM public.reserve_usage_limits_v2(
             $1::uuid, 1, 'channel_analysis'::public.usage_metric,
             statement_timestamp()
           )`,
          [nonExistingUser]
        ),
      "42501"
    );
  }
}

async function withRollback(context, clientFactory, configuration, operation) {
  return await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await client.query("BEGIN");
      try {
        return await operation(client);
      } finally {
        if (!context.timedOut) await client.query("ROLLBACK");
      }
    }
  );
}

async function insertUsageUser(client, userId) {
  await client.query(
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1)`,
    [userId]
  );
}

async function expectPlanFailureInTransaction(client, userId) {
  const before = (await client.query(usageUserStateQuery(), [userId])).rows[0]
    ?.state;
  for (const invocation of [
    `SELECT * FROM public.get_usage_status_v1(
      $1::uuid, 1, '2026-09-01T12:00:00Z'::timestamptz
    )`,
    `SELECT * FROM public.reserve_usage_limits_v2(
      $1::uuid, 1, 'channel_analysis'::public.usage_metric,
      '2026-09-01T12:00:00Z'::timestamptz
    )`,
  ]) {
    await client.query("SAVEPOINT expected_plan_failure");
    await expectDatabaseFailure(
      () => client.query(invocation, [userId]),
      "P0001"
    );
    await client.query("ROLLBACK TO SAVEPOINT expected_plan_failure");
    await client.query("RELEASE SAVEPOINT expected_plan_failure");
  }
  const after = (await client.query(usageUserStateQuery(), [userId])).rows[0]
    ?.state;
  requireHarness(
    JSON.stringify(after) === JSON.stringify(before),
    "EXTERNAL_FIXTURE_PLAN_FAILURE_CHANGED_STATE"
  );
}

async function verifyPlanResolution(context, clientFactory, configuration) {
  await withRollback(context, clientFactory, configuration, async (client) => {
    const userId = "20000000-0000-4000-8000-000000000001";
    await insertUsageUser(client, userId);
    const status = await client.query(
      `SELECT available, canonical_plan_key, plan_from_assignment,
              analysis_daily_remaining, ai_monthly_remaining
       FROM public.get_usage_status_v1(
         $1::uuid, 1, '2026-09-01T12:00:00Z'::timestamptz
       )`,
      [userId]
    );
    requireHarness(
      JSON.stringify(status.rows?.[0]) ===
        JSON.stringify({
          available: true,
          canonical_plan_key: "free",
          plan_from_assignment: false,
          analysis_daily_remaining: 2,
          ai_monthly_remaining: 3,
        }),
      "EXTERNAL_FIXTURE_FREE_PLAN_FALLBACK_MISMATCH"
    );
    const reservation = await client.query(
      `SELECT allowed, canonical_plan_key, plan_from_assignment
       FROM public.reserve_usage_limits_v2(
         $1::uuid, 1, 'channel_analysis'::public.usage_metric,
         '2026-09-01T12:00:00Z'::timestamptz
       )`,
      [userId]
    );
    requireHarness(
      reservation.rows?.[0]?.allowed === true &&
        reservation.rows?.[0]?.canonical_plan_key === "free" &&
        reservation.rows?.[0]?.plan_from_assignment === false,
      "EXTERNAL_FIXTURE_FREE_PLAN_RESERVATION_MISMATCH"
    );
  });

  await withRollback(context, clientFactory, configuration, async (client) => {
    const userId = "20000000-0000-4000-8000-000000000002";
    await insertUsageUser(client, userId);
    await client.query(
      `INSERT INTO public.user_plan_assignments (
         user_id, plan_code, status, source, starts_at, ends_at
       ) VALUES
         ($1, 'free', 'inactive', 'system', '2026-01-01T00:00:00Z', NULL),
         ($1, 'free', 'expired', 'system', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
      [userId]
    );
    const status = await client.query(
      `SELECT available, canonical_plan_key, plan_from_assignment
       FROM public.get_usage_status_v1(
         $1::uuid, 1, '2026-09-01T12:00:00Z'::timestamptz
       )`,
      [userId]
    );
    requireHarness(
      JSON.stringify(status.rows?.[0]) ===
        JSON.stringify({
          available: true,
          canonical_plan_key: "free",
          plan_from_assignment: false,
        }),
      "EXTERNAL_FIXTURE_INACTIVE_PLAN_FALLBACK_MISMATCH"
    );
  });

  const failureSetups = [
    (client, userId) =>
      client.query(
        `INSERT INTO public.user_plan_assignments
          (user_id, plan_code, status, source, starts_at)
         VALUES ($1, 'free', 'active', 'system', '2026-09-02T00:00:00Z')`,
        [userId]
      ),
    (client, userId) =>
      client.query(
        `INSERT INTO public.user_plan_assignments
          (user_id, plan_code, status, source, starts_at, ends_at)
         VALUES (
           $1, 'free', 'active', 'system',
           '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z'
         )`,
        [userId]
      ),
    async (client, userId) => {
      await client.query(
        `ALTER TABLE public.user_plan_assignments
         DROP CONSTRAINT user_plan_assignments_plan_code_plans_code_fk`
      );
      await client.query(
        `INSERT INTO public.user_plan_assignments
          (user_id, plan_code, status, source, starts_at)
         VALUES ($1, 'missing', 'active', 'system', '2026-01-01T00:00:00Z')`,
        [userId]
      );
    },
    async (client, userId) => {
      await client.query("DROP INDEX public.user_plan_assignments_one_active_per_user");
      await client.query(
        `INSERT INTO public.user_plan_assignments
          (user_id, plan_code, status, source, starts_at)
         VALUES
          ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z'),
          ($1, 'free', 'active', 'manual', '2026-01-02T00:00:00Z')`,
        [userId]
      );
    },
    (client) => client.query("DELETE FROM public.plans WHERE code = 'free'"),
    (client) =>
      client.query(
        `ALTER TABLE public.plans DROP CONSTRAINT plans_pkey CASCADE;
         INSERT INTO public.plans (
           code, name, analysis_daily_limit, analysis_monthly_limit,
           ai_daily_limit, ai_monthly_limit, regular_video_limit,
           shorts_video_limit, history_retention_days, active
         ) VALUES ('free', 'Duplicate', 2, 5, 1, 3, 10, 10, 90, true)`
      ),
    (client) =>
      client.query("UPDATE public.plans SET active = false WHERE code = 'free'"),
    (client) =>
      client.query(
        "UPDATE public.plans SET analysis_daily_limit = 3 WHERE code = 'free'"
      ),
    (client) =>
      client.query(
        `ALTER TABLE public.plans DROP CONSTRAINT plans_limits_nonnegative;
         UPDATE public.plans SET ai_monthly_limit = -1 WHERE code = 'free'`
      ),
  ];
  for (const [index, setup] of failureSetups.entries()) {
    await withRollback(context, clientFactory, configuration, async (client) => {
      const userId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      await insertUsageUser(client, userId);
      await setup(client, userId);
      await expectPlanFailureInTransaction(client, userId);
    });
  }
}

async function executeFixtureQuery(
  context,
  clientFactory,
  configuration,
  statement,
  parameters = []
) {
  return await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    (client) => client.query(statement, parameters)
  );
}

async function fixtureScalar(
  context,
  clientFactory,
  configuration,
  statement,
  parameters = []
) {
  const result = await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    statement,
    parameters
  );
  return result.rows?.[0] ? Object.values(result.rows[0])[0] : undefined;
}

async function verifyReservationLifecycle(context, clientFactory, configuration) {
  const concurrentUser = "40000000-0000-4000-8000-000000000001";
  await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1);
     INSERT INTO public.user_plan_assignments (
       user_id, plan_code, status, source, starts_at
     ) VALUES ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z')`,
    [concurrentUser]
  );
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, () =>
      queryAsUsageRole(
        context,
        clientFactory,
        configuration,
        USAGE_FIXTURE_ROLES.explicitRuntime,
        `SELECT allowed FROM public.reserve_usage_limits_v2(
           $1::uuid, 1, 'channel_analysis'::public.usage_metric,
           '2026-09-01T12:00:00Z'::timestamptz
         )`,
        [concurrentUser],
        { commit: true }
      )
    )
  );
  requireHarness(
    concurrent.filter((result) => result.rows?.[0]?.allowed === true).length === 2,
    "EXTERNAL_FIXTURE_CONCURRENT_RESERVATION_MISMATCH"
  );
  requireHarness(
    Number(
      await fixtureScalar(
        context,
        clientFactory,
        configuration,
        `SELECT MAX(used_count) FROM public.user_usage_buckets
         WHERE user_id = $1 AND metric = 'channel_analysis'`,
        [concurrentUser]
      )
    ) === 2,
    "EXTERNAL_FIXTURE_USAGE_BUCKET_LIMIT_MISMATCH"
  );
  await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    "DELETE FROM public.users WHERE id = $1::uuid",
    [concurrentUser]
  );

  const releaseUser = "40000000-0000-4000-8000-000000000002";
  await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1);
     INSERT INTO public.user_plan_assignments (
       user_id, plan_code, status, source, starts_at
     ) VALUES ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z')`,
    [releaseUser]
  );
  const released = await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    `SELECT reservation_id FROM public.reserve_usage_limits_v2(
       $1::uuid, 1, 'channel_analysis'::public.usage_metric,
       '2026-09-01T12:00:00Z'::timestamptz
     )`,
    [releaseUser]
  );
  const reservationId = released.rows?.[0]?.reservation_id;
  requireHarness(
    (await fixtureScalar(
      context,
      clientFactory,
      configuration,
      "SELECT released FROM public.release_usage_limits($1::uuid, $2::uuid)",
      [reservationId, releaseUser]
    )) === true &&
      (await fixtureScalar(
        context,
        clientFactory,
        configuration,
        "SELECT released FROM public.release_usage_limits($1::uuid, $2::uuid)",
        [reservationId, releaseUser]
      )) === false,
    "EXTERNAL_FIXTURE_ONE_TIME_RELEASE_MISMATCH"
  );
  const finalized = await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    `SELECT reservation_id FROM public.reserve_usage_limits_v2(
       $1::uuid, 1, 'ai_consult'::public.usage_metric,
       '2026-09-01T12:00:00Z'::timestamptz
     )`,
    [releaseUser]
  );
  requireHarness(
    (await fixtureScalar(
      context,
      clientFactory,
      configuration,
      "SELECT public.finalize_usage_reservation($1::uuid, $2::uuid)",
      [finalized.rows?.[0]?.reservation_id, releaseUser]
    )) === true,
    "EXTERNAL_FIXTURE_FINALIZATION_MISMATCH"
  );

  const staleUser = "40000000-0000-4000-8000-000000000003";
  await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1);
     INSERT INTO public.user_plan_assignments (
       user_id, plan_code, status, source, starts_at
     ) VALUES ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z');
     SELECT reservation_id FROM public.reserve_usage_limits_v2(
       $1::uuid, 1, 'channel_analysis'::public.usage_metric,
       '2026-09-01T12:00:00Z'::timestamptz
     )`,
    [staleUser]
  );
  const recoveries = await Promise.all(
    Array.from({ length: 2 }, () =>
      executeFixtureQuery(
        context,
        clientFactory,
        configuration,
        `SELECT public.recover_stale_usage_reservations(
           '2026-09-01T12:15:00Z'::timestamptz, 10
         ) AS recovered`
      )
    )
  );
  requireHarness(
    recoveries.reduce(
      (total, result) => total + Number(result.rows?.[0]?.recovered),
      0
    ) === 1,
    "EXTERNAL_FIXTURE_STALE_RECOVERY_MISMATCH"
  );
  await executeFixtureQuery(
    context,
    clientFactory,
    configuration,
    "DELETE FROM public.users WHERE id = ANY($1::uuid[])",
    [[releaseUser, staleUser]]
  );
}

async function verifyTransactionRollback(context, clientFactory, configuration) {
  await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          "CREATE TABLE public.external_fixture_rollback_probe (id integer)"
        );
        throw new HarnessIssue("EXTERNAL_FIXTURE_INTENTIONAL_TRANSACTION_FAILURE");
      } catch (error) {
        if (!context.timedOut) await client.query("ROLLBACK");
        requireHarness(
          error instanceof HarnessIssue &&
            error.code === "EXTERNAL_FIXTURE_INTENTIONAL_TRANSACTION_FAILURE",
          "EXTERNAL_FIXTURE_TRANSACTION_PROBE_INVALID"
        );
      }
      const result = await client.query(
        "SELECT pg_catalog.to_regclass('public.external_fixture_rollback_probe') AS relation"
      );
      requireHarness(
        result.rows?.[0]?.relation === null,
        "EXTERNAL_FIXTURE_TRANSACTION_ROLLBACK_FAILED"
      );
    }
  );
}

function postflightEnvironment(configuration) {
  const directUrl = configuration.rawUrl;
  const pooledUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:${configuration.port}/${configuration.database}`;
  return {
    environment: {
      ACTUSTUBE_DB_ENV: "staging",
      ACTUSTUBE_ALLOW_STAGING_DB_VERIFY: "1",
      DIRECT_DATABASE_URL: directUrl,
      DATABASE_URL: pooledUrl,
      ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "local-postflight-fixture",
    },
    secretParts: [
      directUrl,
      pooledUrl,
      configuration.password,
      configuration.database,
      configuration.role,
      String(configuration.port),
      RUNTIME_PASSWORD,
      RUNTIME_ROLE,
    ],
  };
}

async function runPostflight(context, clientFactory, configuration) {
  const { environment, secretParts } = postflightEnvironment(configuration);
  const output = [];
  const statements = [];
  const adapter = createAdapter(context, clientFactory, (kind) =>
    kind === "direct"
      ? fixtureCredentials(configuration)
      : fixtureCredentials(configuration, {
          role: RUNTIME_ROLE,
          password: RUNTIME_PASSWORD,
        })
  );
  const report = await runBoundedPhase(
    context,
    "phase",
    context.limits.phaseMilliseconds,
    () =>
      executeStagingDatabasePostflight({
        environment,
        repositoryRoot,
        adapter,
        allowLoopback: true,
        onQuery(statement) {
          assertReadOnlySql(statement);
          statements.push(statement);
        },
        stdout(line) {
          output.push(line);
        },
      })
  );
  const serialized = output.join("\n");
  requireHarness(
    secretParts.every((part) => !serialized.includes(part)),
    "EXTERNAL_FIXTURE_OUTPUT_REDACTION_FAILED"
  );
  return { report, statements };
}

function publicSuccessResult() {
  return Object.freeze({
    success: true,
    fixtureConfigured: true,
    lifecycleOwner: "github_actions_service_container",
    postgresqlMajor: EXPECTED_MAJOR,
    migrationCount: EXPECTED_MIGRATION_COUNT,
    stablePreflight: true,
    snapshotDriftRejected: true,
    extensionClassification: true,
    independentExtensionInventory: true,
    migrationOrderAndReplay: true,
    usageMigrationSemantics: true,
    temporaryAuthorityCleanup: true,
    deadlineBounded: true,
    transactionRollback: true,
    postflight: true,
    postflightDriftRejected: true,
    verifierQueriesReadOnly: true,
    outputRedaction: true,
  });
}

export function externalFixtureSuccessResultForTests() {
  return publicSuccessResult();
}

export const EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS =
  FIXTURE_EXTENSION_CONTRACT;
export const INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS =
  INDEPENDENT_EXTENSION_INVENTORY_SQL;
export const HARNESS_DEADLINE_LIMITS_FOR_TESTS = HARNESS_DEADLINE_LIMITS;

export function validateIndependentExtensionInventoryForTests(rows) {
  validateIndependentExtensionInventory(rows);
  return Object.freeze({ match: true });
}

/**
 * @param {{
 *   client: object,
 *   unrelatedClient?: object | null,
 *   expectedSessionRole: string,
 *   deadlineLimits?: object,
 *   callbackScenario?: string,
 *   replaceObservedIdentityForTest?: boolean,
 * }} options
 */
export async function runMigrationOwnerBoundaryProbeForTests({
  client,
  unrelatedClient = null,
  expectedSessionRole,
  deadlineLimits,
  callbackScenario = "normal",
  replaceObservedIdentityForTest = false,
}) {
  assertUsageFixtureRoleSeparation(expectedSessionRole);
  requireHarness(
    ["normal", "replace-client"].includes(callbackScenario),
    "EXTERNAL_FIXTURE_MIGRATION_CALLBACK_INVALID"
  );
  const context = createDeadlineContext(deadlineLimits);
  const unrelatedContext = unrelatedClient
    ? createDeadlineContext(deadlineLimits)
    : null;
  let unrelatedOwnedClient = null;
  let failureMarker = null;
  const internalProbeState = {
    callbackScenario,
    replaceObservedIdentityForTest,
    productionApplyInvocations: 0,
    migrationCallbackInvocations: 0,
    laterVerificationStubInvocations: 0,
    initialObservedIdentityReference: null,
    downstreamObservedIdentityReference: null,
    boundaryObservedIdentityReference: null,
  };
  INTERNAL_PRODUCTION_WRAPPER_PROBE_STATES.set(context, internalProbeState);
  try {
    if (unrelatedContext) {
      unrelatedOwnedClient = await openClient(
        unrelatedContext,
        () => unrelatedClient,
        {}
      );
    }
    await applyMigrationsAndRuntimeAcl(
      context,
      () => client,
      Object.freeze({
        host: "127.0.0.1",
        port: 5432,
        database: "actustube_ci_fixture",
        role: expectedSessionRole,
      }),
      INTERNAL_PRODUCTION_WRAPPER_PROBE_SPECIFICATION
    );
  } catch (error) {
    failureMarker =
      error instanceof HarnessIssue
        ? error.code
        : "EXTERNAL_FIXTURE_VERIFICATION_FAILED";
  } finally {
    INTERNAL_PRODUCTION_WRAPPER_PROBE_STATES.delete(context);
    if (unrelatedContext && unrelatedOwnedClient) {
      await closeOwnedClient(unrelatedContext, unrelatedOwnedClient);
    }
  }
  const ownedClient = [...context.ownedClients][0];
  const initialObservedIdentityReference =
    internalProbeState.initialObservedIdentityReference;
  const downstreamObservedIdentityReference =
    internalProbeState.downstreamObservedIdentityReference;
  const boundaryObservedIdentityReference =
    internalProbeState.boundaryObservedIdentityReference;
  return Object.freeze({
    failureMarker,
    timedOut: context.timedOut,
    activeClientCount: context.activeClients.size,
    usable: ownedClient?.usable === true,
    destroyed: ownedClient?.destroyed === true,
    productionApplyInvocations:
      internalProbeState.productionApplyInvocations,
    migrationCallbackInvocations:
      internalProbeState.migrationCallbackInvocations,
    laterVerificationStubInvocations:
      internalProbeState.laterVerificationStubInvocations,
    unrelatedActiveClientCount: unrelatedContext?.activeClients.size ?? 0,
    unrelatedUsable: unrelatedOwnedClient?.usable === true,
    unrelatedDestroyed: unrelatedOwnedClient?.destroyed === true,
    observedIdentityFrozen:
      initialObservedIdentityReference !== null &&
      Object.isFrozen(initialObservedIdentityReference) &&
      exactOwnKeys(initialObservedIdentityReference, ["sessionRole"]),
    observedIdentityReferencePreserved:
      initialObservedIdentityReference !== null &&
      initialObservedIdentityReference === downstreamObservedIdentityReference,
    boundaryReobservationDistinct:
      boundaryObservedIdentityReference !== null &&
      boundaryObservedIdentityReference !== initialObservedIdentityReference,
    operationStarts: Object.freeze({ ...context.operationStarts }),
  });
}

/**
 * @param {{
 *   initialIdentityClient: object,
 *   client: object,
 *   postflightClient: object,
 *   unrelatedClient?: object | null,
 *   callerConfigurationRole: string,
 *   cleanupConfigurationRoleForTest?: string,
 *   replaceObservedIdentityForTest?: boolean,
 *   deadlineLimits?: object,
 * }} options
 */
export async function runOwnershipCanonicalizationProbeForTests({
  initialIdentityClient,
  client,
  postflightClient,
  unrelatedClient = null,
  callerConfigurationRole,
  cleanupConfigurationRoleForTest = callerConfigurationRole,
  replaceObservedIdentityForTest = false,
  deadlineLimits,
}) {
  assertUsageFixtureRoleSeparation(callerConfigurationRole);
  assertUsageFixtureRoleSeparation(cleanupConfigurationRoleForTest);
  const specification = await loadRepositorySpecification(repositoryRoot);
  const context = createDeadlineContext(deadlineLimits);
  const unrelatedContext = unrelatedClient
    ? createDeadlineContext(deadlineLimits)
    : null;
  let unrelatedOwnedClient = null;
  let failureMarker = null;
  let initialObservedIdentityReference = null;
  let downstreamObservedIdentityReference = null;
  try {
    if (unrelatedContext) {
      unrelatedOwnedClient = await openClient(
        unrelatedContext,
        () => unrelatedClient,
        {}
      );
    }
    const preMutationBoundary = await runPreMutationSessionIdentityBoundary({
      context,
      clientFactory: () => initialIdentityClient,
      credentials: {},
      expectedSessionRole: callerConfigurationRole,
      operation(_client, observedSessionIdentity) {
        initialObservedIdentityReference = observedSessionIdentity;
      },
    });
    const { identityAuthority } = preMutationBoundary;
    const observedSessionIdentity = replaceObservedIdentityForTest
      ? Object.freeze({
          sessionRole: identityAuthority.observedSessionIdentity.sessionRole,
        })
      : identityAuthority.observedSessionIdentity;
    const configuration = Object.freeze({
      host: "127.0.0.1",
      port: 5432,
      database: "actustube_ci_fixture",
      role: cleanupConfigurationRoleForTest,
      password: "fixed_test_only_password",
    });
    await runCanonicalOwnershipBoundary({
      context,
      clientFactory: () => client,
      configuration,
      identityAuthority,
      observedSessionIdentity,
      specification,
      identityReferenceObserver(identity) {
        downstreamObservedIdentityReference = identity;
      },
      postflightOperation: () =>
        withClient(context, () => postflightClient, {}, (ownedClient) =>
          ownedClient.query(
            "SELECT 'fixed_postflight_boundary'::text AS fixed_boundary_probe"
          )
        ),
    });
  } catch (error) {
    failureMarker =
      error instanceof HarnessIssue
        ? error.code
        : "EXTERNAL_FIXTURE_VERIFICATION_FAILED";
  } finally {
    if (unrelatedContext && unrelatedOwnedClient) {
      await closeOwnedClient(unrelatedContext, unrelatedOwnedClient);
    }
  }
  return Object.freeze({
    failureMarker,
    timedOut: context.timedOut,
    activeClientCount: context.activeClients.size,
    observedIdentityReferencePreserved:
      initialObservedIdentityReference !== null &&
      initialObservedIdentityReference === downstreamObservedIdentityReference,
    operationStarts: Object.freeze({ ...context.operationStarts }),
  });
}

/**
 * @param {{
 *   environment?: NodeJS.ProcessEnv,
 *   clientFactory?: ((credentials: object) => object),
 *   deadlineLimits?: object,
 * }} [options]
 */
async function runConnectionOnlyHarnessWithinContext(options, context) {
  const {
    environment = process.env,
    clientFactory,
  } = options;
  const configuration = validateExternalFixtureConfiguration(environment);
  const resolvedClientFactory =
    clientFactory ?? createPgClientFactory(context.limits);
  requireHarness(
    typeof resolvedClientFactory === "function",
    "EXTERNAL_FIXTURE_CONNECTION_FACTORY_INVALID"
  );
  const specification = await loadRepositorySpecification(repositoryRoot);
  requireHarness(
    specification.migrations.length === configuration.expectedMigrationMax + 1,
    "EXTERNAL_FIXTURE_MIGRATION_CONTRACT_MISMATCH"
  );

  const extensions = await withClient(
    context,
    resolvedClientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await runFixtureIdentityPhase(context, () =>
        assertFixtureIdentity(client, configuration)
      );
      await runFixtureLedgerSetupPhase(context, () =>
        createEmptyMigrationLedger(client)
      );
      return await runExtensionInventoryPhase(context, () =>
        verifyIndependentExtensionInventory(client)
      );
    },
    INITIAL_FIXTURE_CLIENT_LIFECYCLE
  );

  await runPreflightStabilityPhase(context, async () => {
    const stable = await runStablePreflight(
      context,
      configuration,
      resolvedClientFactory,
      extensions
    );
    requireHarness(
      stable.report.exitCode === 0 &&
        stable.report.overallStatus === "pass" &&
        stable.report.initialState === "empty_migration_table" &&
        stable.report.beforeAfterComparison === "match" &&
        stable.report.extensionInventory === "match",
      "EXTERNAL_FIXTURE_STABLE_PREFLIGHT_FAILED"
    );
    for (const key of [
      "serverVersion",
      "identity",
      "roleIdentity",
      "extensionInventory",
      "migrationCatalog",
      "migrationColumns",
      "migrationColumnExact",
      "migrationPrimaryKey",
      "migrationHistory",
      "migrationExact",
      "userDefinedObjects",
    ]) {
      requireHarness(
        stable.statements.filter((statement) =>
          sameSql(statement, PREFLIGHT_SQL_FOR_TESTS[key])
        ).length === 4,
        "EXTERNAL_FIXTURE_PREFLIGHT_QUERY_COUNT_MISMATCH"
      );
    }
    requireHarness(
      stable.statements.filter((statement) =>
        sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.begin)
      ).length === 4 &&
        stable.statements.filter((statement) =>
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback)
        ).length === 4,
      "EXTERNAL_FIXTURE_PREFLIGHT_TRANSACTION_MISMATCH"
    );
  });

  await runSnapshotDriftControlPhase(context, async () => {
    let driftWrites = 0;
    const drift = await runStablePreflight(
      context,
      configuration,
      resolvedClientFactory,
      extensions,
      async () => {
        await withClient(
          context,
          resolvedClientFactory,
          fixtureCredentials(configuration),
          async (client) => {
            await client.query(
              "CREATE TABLE public.external_fixture_snapshot_drift (id integer)"
            );
            driftWrites += 1;
          }
        );
      }
    );
    requireHarness(
      driftWrites === 1 &&
        drift.report.exitCode === 1 &&
        drift.report.overallStatus === "fail" &&
        drift.report.beforeAfterComparison === "fail" &&
        drift.report.failure?.checkId === "READ_ONLY_INVARIANT_MISMATCH",
      "EXTERNAL_FIXTURE_SNAPSHOT_DRIFT_NOT_REJECTED"
    );
    await withClient(
      context,
      resolvedClientFactory,
      fixtureCredentials(configuration),
      (client) => client.query("DROP TABLE public.external_fixture_snapshot_drift")
    );
  });

  await runExtensionClassificationPhase(context, () =>
    verifyExtensionClassificationMatrix(
      context,
      resolvedClientFactory,
      configuration
    )
  );
  const identityAuthority = await applyMigrationsAndRuntimeAcl(
    context,
    resolvedClientFactory,
    configuration,
    specification
  );
  await runTransactionRollbackControlPhase(context, () =>
    verifyTransactionRollback(context, resolvedClientFactory, configuration)
  );

  await runCanonicalOwnershipBoundary({
    context,
    clientFactory: resolvedClientFactory,
    configuration,
    identityAuthority,
    observedSessionIdentity: identityAuthority.observedSessionIdentity,
    specification,
    async postflightOperation() {
      const postflight = await runPostflight(
        context,
        resolvedClientFactory,
        configuration
      );
      requireHarness(
        postflight.report.exitCode === 0 &&
          postflight.report.sameLogicalDatabase === "pass" &&
          postflight.report.migrationHistory.status === "pass" &&
          postflight.report.migrationHistory.actual === EXPECTED_MIGRATION_COUNT &&
          postflight.report.schema === "pass" &&
          postflight.report.acl === "pass" &&
          postflight.report.readOnlySmoke === "pass" &&
          postflight.report.dataCountsUnchanged === "pass",
        "EXTERNAL_FIXTURE_POSTFLIGHT_FAILED"
      );
      return postflight;
    },
  });

  await runPostflightDriftPhase(context, async () => {
    await withClient(
      context,
      resolvedClientFactory,
      fixtureCredentials(configuration),
      (client) =>
        client.query(
          "CREATE TABLE public.external_fixture_postflight_drift (id integer)"
        )
    );
    const postflightDrift = await runPostflight(
      context,
      resolvedClientFactory,
      configuration
    );
    requireHarness(
      postflightDrift.report.exitCode === 1 &&
        postflightDrift.report.failure?.checkId === "TABLE_SET_MISMATCH",
      "EXTERNAL_FIXTURE_POSTFLIGHT_DRIFT_NOT_REJECTED"
    );
    await withClient(
      context,
      resolvedClientFactory,
      fixtureCredentials(configuration),
      (client) => client.query("DROP TABLE public.external_fixture_postflight_drift")
    );
  });

  return publicSuccessResult();
}

export async function runConnectionOnlyHarness(options = {}) {
  const context = createDeadlineContext(options.deadlineLimits);
  const internalProbeState =
    INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_OPTIONS.get(options);
  EXTERNAL_FIXTURE_OBSERVABILITY_CONTEXTS.add(context);
  if (internalProbeState) {
    internalProbeState.context = context;
    INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.set(context, internalProbeState);
  }
  try {
    return await runConnectionOnlyHarnessWithinContext(options, context);
  } finally {
    INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.delete(context);
    EXTERNAL_FIXTURE_OBSERVABILITY_CONTEXTS.delete(context);
  }
}

const INTERNAL_PHASE_PROBE_SCENARIOS = Object.freeze({
  "fixture-client-connect-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.fixtureClientConnect,
  }),
  "production-fixture-client-connect-path": Object.freeze({
    kind: "production-path",
    phase: EXTERNAL_FIXTURE_PHASES.fixtureClientConnect,
  }),
  "fixture-identity-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.fixtureIdentity,
  }),
  "fixture-ledger-setup-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.fixtureLedgerSetup,
  }),
  "extension-inventory-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.extensionInventory,
  }),
  "fixture-client-close-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.fixtureClientClose,
  }),
  "preflight-stability-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.preflightStability,
  }),
  "snapshot-drift-control-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.snapshotDriftControl,
  }),
  "extension-classification-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.extensionClassification,
  }),
  "pre-mutation-client-connect-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.preMutationClientConnect,
  }),
  "pre-mutation-identity-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.preMutationIdentity,
  }),
  "default-privilege-revoke-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.defaultPrivilegeRevoke,
  }),
  "fixture-role-setup-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.fixtureRoleSetup,
  }),
  "migration-boundary-identity-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationBoundaryIdentity,
  }),
  "migration-baseline-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationBaseline,
  }),
  "migration-public-acl-negative-control-unexpected-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationPublicAclNegativeControl,
  }),
  "migration-final-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationFinal,
  }),
  "migration-replay-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationReplay,
  }),
  "migration-postconditions-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationPostconditions,
  }),
  "migration-client-close-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.migrationClientClose,
  }),
  "transaction-rollback-control-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.transactionRollbackControl,
  }),
  "cleanup-client-connect-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.cleanupClientConnect,
  }),
  "cleanup-identity-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.cleanupIdentity,
  }),
  "ownership-pre-inventory-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.ownershipPreInventory,
  }),
  "ownership-canonicalization-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.ownershipCanonicalization,
  }),
  "ownership-post-snapshot-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.ownershipPostSnapshot,
  }),
  "authority-pre-inventory-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.authorityPreInventory,
  }),
  "bounded-revoke-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.boundedRevoke,
  }),
  "authority-zero-residue-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.authorityZeroResidue,
  }),
  "maintenance-owner-snapshot-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.maintenanceOwnerSnapshot,
  }),
  "canonical-client-close-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.canonicalClientClose,
  }),
  "postflight-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.postflight,
  }),
  "postflight-drift-rejects": Object.freeze({
    kind: "phase",
    phase: EXTERNAL_FIXTURE_PHASES.postflightDrift,
  }),
  "migration-final-through-outer-wrappers": Object.freeze({
    kind: "nested",
    phase: EXTERNAL_FIXTURE_PHASES.migrationFinal,
  }),
  "migration-final-plus-canonical-close": Object.freeze({
    kind: "primary-close",
    phase: EXTERNAL_FIXTURE_PHASES.migrationFinal,
  }),
  "canonical-close-only": Object.freeze({
    kind: "close-only",
    phase: null,
  }),
  "cross-context-token-replay": Object.freeze({
    kind: "cross-context",
    phase: null,
  }),
  "fixture-identity-timeout": Object.freeze({
    kind: "timeout",
    phase: null,
  }),
  "unbranded-unknown": Object.freeze({ kind: "unknown", phase: null }),
  "forged-known-marker-message": Object.freeze({ kind: "forged", phase: null }),
  "forged-known-marker-object": Object.freeze({
    kind: "forged-object",
    phase: null,
  }),
  "redaction-shaped-unknown": Object.freeze({ kind: "redaction", phase: null }),
  "intentional-public-acl-negative-control": Object.freeze({
    kind: "intentional-negative-control",
    phase: null,
  }),
  success: Object.freeze({ kind: "production-success", phase: null }),
});

function createFixedPhaseProbeClient({ queryNeverSettles = false, endRejects = false } = {}) {
  const counters = { connect: 0, query: 0, end: 0, destroy: 0 };
  const client = {
    connection: {
      stream: {
        destroy() {
          counters.destroy += 1;
        },
      },
    },
    async connect() {
      counters.connect += 1;
    },
    query() {
      counters.query += 1;
      return queryNeverSettles
        ? new Promise(() => undefined)
        : Promise.resolve({ rows: [] });
    },
    async end() {
      counters.end += 1;
      if (endRejects) throw new Error("fixed-private-close-failure");
    },
  };
  return Object.freeze({ client, counters });
}

function fixedPhaseProbeTranscript({
  error,
  publicResult,
  state,
  context,
  probeStateRemoved,
  targetClient,
  unrelatedClient,
}) {
  const failureMarker = error === null ? null : externalFixtureFailureMarker(error);
  return Object.freeze({
    failureMarker,
    exitCode: error === null ? 0 : 1,
    stdout: error === null ? `${JSON.stringify(publicResult)}\n` : "",
    stderr: error === null ? "" : `${failureMarker}\n`,
    publicResult,
    phaseTrace: Object.freeze([...state.phaseTrace]),
    phaseStartCount: state.phaseTrace.length,
    targetHitCount: state.targetHitCount,
    operationStartCount: state.operationStartCount,
    skippedOperationCount: state.skippedOperationCount ?? 0,
    postflightStartCount: state.postflightStartCount,
    connectionFactoryCallCount: state.connectionFactoryCallCount,
    activeClientCount: context.activeClients.size,
    targetConnectCount:
      state.graphCounters?.connect ?? targetClient?.counters.connect ?? 0,
    targetQueryCount:
      state.graphCounters?.query ?? targetClient?.counters.query ?? 0,
    targetEndCount: state.graphCounters?.end ?? targetClient?.counters.end ?? 0,
    targetDestroyCount:
      state.graphCounters?.destroy ?? targetClient?.counters.destroy ?? 0,
    unrelatedDestroyCount: unrelatedClient?.counters.destroy ?? 0,
    probeStateRemoved,
  });
}

async function runProductionGraphPhaseProbeForTests(specification) {
  const state = {
    targetPhase: specification.phase,
    targetHitCount: 0,
    operationStartCount: 0,
    postflightStartCount: 0,
    skippedOperationCount: 0,
    connectionFactoryCallCount: 0,
    phaseTrace: [],
    context: null,
    productionGraph: true,
    graphCounters: { connect: 0, query: 0, end: 0, destroy: 0 },
  };
  const options = Object.freeze({
    environment: Object.freeze({
      NODE_ENV: "test",
      ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
        "postgresql://actustube_ci_fixture:fixed_probe_only@127.0.0.1:5432/actustube_ci_fixture",
      ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE: "actustube_ci_fixture",
      ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE: "actustube_ci_fixture",
      ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR: "18",
      ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX: "6",
    }),
    clientFactory() {
      state.connectionFactoryCallCount += 1;
      const clientOrdinal = state.connectionFactoryCallCount;
      return {
        connection: {
          stream: {
            destroy() {
              state.graphCounters.destroy += 1;
            },
          },
        },
        async connect() {
          state.graphCounters.connect += 1;
          if (
            (state.targetPhase ===
              EXTERNAL_FIXTURE_PHASES.fixtureClientConnect &&
              clientOrdinal === 1) ||
            (state.targetPhase ===
              EXTERNAL_FIXTURE_PHASES.preMutationClientConnect &&
              clientOrdinal === 2) ||
            (state.targetPhase ===
              EXTERNAL_FIXTURE_PHASES.cleanupClientConnect &&
              clientOrdinal === 3)
          ) {
            throw new Error("fixed-private-client-connect-failure");
          }
        },
        async query() {
          state.graphCounters.query += 1;
          throw new Error("fixed-private-unreachable-production-graph-query");
        },
        async end() {
          state.graphCounters.end += 1;
          if (
            (state.targetPhase ===
              EXTERNAL_FIXTURE_PHASES.fixtureClientClose &&
              clientOrdinal === 1) ||
            (state.targetPhase ===
              EXTERNAL_FIXTURE_PHASES.migrationClientClose &&
              clientOrdinal === 2) ||
            (state.targetPhase ===
              EXTERNAL_FIXTURE_PHASES.canonicalClientClose &&
              clientOrdinal === 3)
          ) {
            throw new Error("fixed-private-client-close-failure");
          }
        },
      };
    },
  });
  INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_OPTIONS.set(options, state);
  let error = null;
  let publicResult = null;
  try {
    publicResult = await runConnectionOnlyHarness(options);
  } catch (caughtError) {
    error = caughtError;
  } finally {
    INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_OPTIONS.delete(options);
  }
  requireHarness(state.context !== null, "EXTERNAL_FIXTURE_PHASE_PROBE_NOT_TRIGGERED");
  if (specification.phase === null) {
    requireHarness(
      error === null && publicResult !== null,
      "EXTERNAL_FIXTURE_PHASE_PROBE_NOT_TRIGGERED"
    );
  } else {
    requireHarness(
      error !== null && state.targetHitCount === 1,
      "EXTERNAL_FIXTURE_PHASE_PROBE_NOT_TRIGGERED"
    );
  }
  const probeStateRemoved =
    !INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_OPTIONS.has(options) &&
    !INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.has(state.context);
  return fixedPhaseProbeTranscript({
    error,
    publicResult,
    state,
    context: state.context,
    probeStateRemoved,
    targetClient: null,
    unrelatedClient: null,
  });
}

export async function runExternalFixturePhaseProbeForTests(scenario) {
  requireHarness(
    arguments.length === 1 &&
      typeof scenario === "string" &&
      Object.prototype.hasOwnProperty.call(INTERNAL_PHASE_PROBE_SCENARIOS, scenario),
    "EXTERNAL_FIXTURE_PHASE_PROBE_INVALID"
  );
  const specification = INTERNAL_PHASE_PROBE_SCENARIOS[scenario];
  if (
    specification.kind === "phase" ||
    specification.kind === "production-path" ||
    specification.kind === "production-success"
  ) {
    return await runProductionGraphPhaseProbeForTests(specification);
  }
  const context = createDeadlineContext(
    specification.kind === "timeout"
      ? {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 5,
          closeMilliseconds: 20,
        }
      : undefined
  );
  const state = {
    targetPhase: specification.phase,
    targetHitCount: 0,
    operationStartCount: 0,
    skippedOperationCount: 0,
    postflightStartCount: 0,
    connectionFactoryCallCount: 0,
    phaseTrace: [],
  };
  INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.set(context, state);
  let error = null;
  let publicResult = null;
  let targetClient = null;
  let unrelatedClient = null;
  try {
    if (specification.kind === "nested") {
      await runMigrationPostconditionsPhase(context, () =>
        runMigrationFinalPhase(context, async () => undefined)
      );
    } else if (
      specification.kind === "primary-close" ||
      specification.kind === "close-only"
    ) {
      targetClient = createFixedPhaseProbeClient({ endRejects: true });
      await withClient(
        context,
        () => targetClient.client,
        {},
        specification.kind === "primary-close"
          ? () =>
              runMigrationPostconditionsPhase(context, () =>
                runMigrationFinalPhase(context, async () => undefined)
              )
          : async () => undefined,
        CANONICAL_CLEANUP_CLIENT_LIFECYCLE
      );
    } else if (specification.kind === "timeout") {
      targetClient = createFixedPhaseProbeClient({ queryNeverSettles: true });
      unrelatedClient = createFixedPhaseProbeClient();
      const unrelatedContext = createDeadlineContext();
      const unrelatedOwnedClient = await openClient(
        unrelatedContext,
        () => unrelatedClient.client,
        {}
      );
      try {
        await withClient(context, () => targetClient.client, {}, (client) =>
          runFixtureIdentityPhase(context, () => client.query())
        );
      } finally {
        await closeOwnedClient(unrelatedContext, unrelatedOwnedClient);
      }
    } else if (specification.kind === "cross-context") {
      const sourceContext = createDeadlineContext();
      const sourceState = {
        targetPhase: EXTERNAL_FIXTURE_PHASES.migrationFinal,
        targetHitCount: 0,
        operationStartCount: 0,
        skippedOperationCount: 0,
        postflightStartCount: 0,
        connectionFactoryCallCount: 0,
        phaseTrace: [],
      };
      INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.set(
        sourceContext,
        sourceState
      );
      let sourceFailure = null;
      try {
        await runMigrationFinalPhase(sourceContext, async () => undefined);
      } catch (caughtError) {
        sourceFailure = caughtError;
      } finally {
        INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.delete(sourceContext);
      }
      requireHarness(
        sourceFailure !== null &&
          sourceState.targetHitCount === 1 &&
          !INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.has(sourceContext),
        "EXTERNAL_FIXTURE_PHASE_PROBE_NOT_TRIGGERED"
      );
      await runMigrationPostconditionsPhase(context, () =>
        Promise.reject(sourceFailure)
      );
    } else if (specification.kind === "unknown") {
      throw new Error("fixed-private-unknown-failure");
    } else if (specification.kind === "forged") {
      throw new Error(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL"
      );
    } else if (specification.kind === "forged-object") {
      throw Object.freeze({
        phase: "MIGRATION_FINAL",
        code: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL",
        marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL",
      });
    } else if (specification.kind === "redaction") {
      throw new Error(
        "credential://fixed-private@127.0.0.1:5432/private_db\n" +
          "SELECT private_role FROM private_catalog"
      );
    } else if (specification.kind === "intentional-negative-control") {
      await runMigrationPublicAclNegativeControlPhase(context, async () => {
        try {
          throw new Error("fixed-expected-public-acl-rejection");
        } catch {
          return undefined;
        }
      });
      publicResult = publicSuccessResult();
    }
  } catch (caughtError) {
    error = caughtError;
  } finally {
    INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.delete(context);
  }
  const probeStateRemoved =
    !INTERNAL_EXTERNAL_FIXTURE_PHASE_PROBE_STATES.has(context);
  requireHarness(
    error !== null || publicResult !== null,
    "EXTERNAL_FIXTURE_PHASE_PROBE_NOT_TRIGGERED"
  );
  return fixedPhaseProbeTranscript({
    error,
    publicResult,
    state,
    context,
    probeStateRemoved,
    targetClient,
    unrelatedClient,
  });
}

const DEADLINE_PROBE_SCENARIOS = new Set([
  "connect-hang",
  "raw-query-hang",
  "transaction-hang",
  "migration-hang",
  "preflight-hang",
  "postflight-hang",
  "independent-inventory-hang",
  "cleanup-query-hang",
  "end-hang",
  "total-deadline-exhausted",
  "operation-start-expired",
]);

function neverSettlingOperation() {
  return new Promise(() => undefined);
}

export async function runHarnessDeadlineProbeForTests({
  scenario,
  client,
  deadlineLimits,
}) {
  requireHarness(
    DEADLINE_PROBE_SCENARIOS.has(scenario),
    "EXTERNAL_FIXTURE_DEADLINE_PROBE_INVALID"
  );
  const context = createDeadlineContext(deadlineLimits);
  if (scenario === "operation-start-expired") {
    context.absoluteDeadline = performance.now() - 1;
  }
  const startedAt = performance.now();
  let failureMarker = null;
  try {
    if (scenario === "transaction-hang") {
      await withRollback(context, () => client, {}, (transactionClient) =>
        transactionClient.query("SELECT fixed_transaction_body_probe")
      );
    } else {
      const ownedClient = await openClient(context, () => client, {});
      if (scenario === "total-deadline-exhausted") {
        context.absoluteDeadline = performance.now() - 1;
        await ownedClient.proxy.query("SELECT fixed_deadline_probe");
      } else if (scenario === "raw-query-hang") {
        await ownedClient.proxy.query("SELECT fixed_deadline_probe");
      } else if (scenario === "independent-inventory-hang") {
        await ownedClient.proxy.query(INDEPENDENT_EXTENSION_INVENTORY_SQL);
      } else if (scenario === "cleanup-query-hang") {
        await ownedClient.proxy.query("ROLLBACK");
      } else if (scenario === "end-hang") {
        await closeOwnedClient(context, ownedClient);
      } else if (
        scenario === "migration-hang" ||
        scenario === "preflight-hang" ||
        scenario === "postflight-hang"
      ) {
        await runBoundedPhase(
          context,
          scenario === "migration-hang" ? "migration" : "phase",
          scenario === "migration-hang"
            ? context.limits.migrationMilliseconds
            : context.limits.phaseMilliseconds,
          neverSettlingOperation
        );
      } else if (scenario !== "connect-hang") {
        throw new HarnessIssue("EXTERNAL_FIXTURE_DEADLINE_PROBE_INVALID");
      }
    }
  } catch (error) {
    failureMarker =
      error instanceof HarnessIssue
        ? error.code
        : "EXTERNAL_FIXTURE_VERIFICATION_FAILED";
  }

  const operationStartsBeforeBlockedProbe = {
    ...context.operationStarts,
  };
  const ownedClient = [...context.ownedClients][0];
  if (ownedClient) {
    try {
      await ownedClient.proxy.query("SELECT blocked_after_timeout");
    } catch {
      // This is an assertion that no raw post-timeout query can start.
    }
  }
  const operationStartsAfterBlockedProbe = { ...context.operationStarts };
  return Object.freeze({
    scenario,
    failureMarker,
    finiteFailure: typeof failureMarker === "string",
    elapsedMilliseconds: performance.now() - startedAt,
    destroyCount: [...context.ownedClients].reduce(
      (total, entry) => total + entry.destroyCount,
      0
    ),
    activeClientCount: context.activeClients.size,
    operationStarts: Object.freeze(operationStartsBeforeBlockedProbe),
    postTimeoutOperationStarts:
      Object.values(operationStartsAfterBlockedProbe).reduce(
        (total, value) => total + value,
        0
      ) -
      Object.values(operationStartsBeforeBlockedProbe).reduce(
        (total, value) => total + value,
        0
      ),
  });
}

function ownedClientStateForTests(context, ownedClient) {
  return Object.freeze({
    timedOut: context.timedOut,
    activeClientCount: context.activeClients.size,
    registered: context.activeClients.has(ownedClient),
    usable: ownedClient.usable,
    destroyed: ownedClient.destroyed,
    closed: ownedClient.closed,
    destroyCount: ownedClient.destroyCount,
    operationStarts: Object.freeze({ ...context.operationStarts }),
  });
}

export async function createIndependentDeadlineContextsForTests({
  targetClient,
  unrelatedClient,
  deadlineLimits,
}) {
  requireHarness(
    targetClient !== unrelatedClient,
    "EXTERNAL_FIXTURE_DEADLINE_PROBE_INVALID"
  );
  const targetContext = createDeadlineContext(deadlineLimits);
  const unrelatedContext = createDeadlineContext(deadlineLimits);
  const targetOwnedClient = await openClient(
    targetContext,
    () => targetClient,
    {}
  );
  const unrelatedOwnedClient = await openClient(
    unrelatedContext,
    () => unrelatedClient,
    {}
  );
  const targetOperation = targetOwnedClient.proxy
    .query("SELECT fixed_independent_context_probe")
    .then(
      () => null,
      (error) =>
        error instanceof HarnessIssue
          ? error.code
          : "EXTERNAL_FIXTURE_VERIFICATION_FAILED"
    );

  return Object.freeze({
    targetOperation,
    inspectTargetForTests() {
      return ownedClientStateForTests(targetContext, targetOwnedClient);
    },
    inspectUnrelatedForTests() {
      return ownedClientStateForTests(unrelatedContext, unrelatedOwnedClient);
    },
    async closeUnrelatedForTests() {
      await closeOwnedClient(unrelatedContext, unrelatedOwnedClient);
    },
  });
}

export async function runHarnessTransactionBoundaryProbeForTests({
  client,
  deadlineLimits,
}) {
  const context = createDeadlineContext(deadlineLimits);
  let failureMarker = null;
  try {
    await withRollback(context, () => client, {}, (transactionClient) =>
      transactionClient.query("SELECT fixed_transaction_body_probe")
    );
  } catch (error) {
    failureMarker =
      error instanceof HarnessIssue
        ? error.code
        : "EXTERNAL_FIXTURE_VERIFICATION_FAILED";
  }
  const ownedClient = [...context.ownedClients][0];
  return Object.freeze({
    failureMarker,
    timedOut: context.timedOut,
    activeClientCount: context.activeClients.size,
    destroyed: ownedClient?.destroyed === true,
    closed: ownedClient?.closed === true,
    operationStarts: Object.freeze({ ...context.operationStarts }),
  });
}

export function harnessAuthorityBoundaryForTests() {
  return Object.freeze({
    databaseProcessAuthority: 0,
    databasePortAuthority: 0,
    databaseFilesystemAuthority: 0,
    databaseTerminationAuthority: 0,
    databaseLifecycleAdapters: 0,
    fixtureOwner: "github_actions_service_container",
    connectionInputs: Object.freeze(Object.values(FIXTURE_KEYS)),
  });
}

function normalizedInvocationPath(value) {
  const normalized = resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  normalizedInvocationPath(process.argv[1]) === normalizedInvocationPath(modulePath);

if (invokedDirectly) {
  try {
    const result = await runConnectionOnlyHarness();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const marker = externalFixtureFailureMarker(error);
    process.stderr.write(`${marker}\n`);
    process.exitCode = 1;
  }
}
