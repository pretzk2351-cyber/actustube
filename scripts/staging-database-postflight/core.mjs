import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EXPECTED_FUNCTIONS,
  EXPECTED_MIGRATION_TAGS,
  FORBIDDEN_RUNTIME_TABLE_PRIVILEGES,
  RUNTIME_TABLE_PRIVILEGES,
} from "./manifest.mjs";
import {
  PostflightIssue,
  assertReadOnlySql,
  safeIssueFrom,
  validateSafetyGate,
} from "./safety.mjs";

const QUERY_TIMEOUT_MILLISECONDS = 20_000;
const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const CLEANUP_TIMEOUT_MILLISECONDS = 5_000;
const ALLOWED_RUNTIME_PRIVILEGES = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
]);
const TABLE_NAMES = Object.freeze(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort());

function verifiedFailure(code) {
  return new PostflightIssue(code, 1, "fail");
}

function notVerified(code) {
  return new PostflightIssue(code, 3, "not_verified");
}

function requireCondition(condition, code) {
  if (!condition) throw verifiedFailure(code);
}

function compareText(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function asNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw notVerified("CATALOG_VALUE_INVALID");
  return number;
}

function normalizeSqlExpression(value, tableNames = TABLE_NAMES) {
  let normalized = String(value ?? "").toLowerCase();
  normalized = normalized.replace(/^check\s*/i, "");
  normalized = normalized.replaceAll('"', "");
  normalized = normalized.replaceAll(/::[a-z_][a-z0-9_. ]*(?=[,)=<>+\-*/]|$)/gi, "");
  for (const table of tableNames) {
    normalized = normalized.replaceAll(`${table}.`, "");
  }
  return normalized.replaceAll(/[()\s]/g, "");
}

function normalizeDataType(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^varchar(?=\(|$)/, "character varying");
}

function stableSortRows(rows, fields) {
  return [...rows].sort((left, right) => {
    for (const field of fields) {
      const comparison = String(left[field] ?? "").localeCompare(
        String(right[field] ?? "")
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function stableFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function withTimeout(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(notVerified(code)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadRepositorySpecification(repositoryRoot) {
  const migrationRoot = join(repositoryRoot, "drizzle");
  let journal;
  let snapshot;
  let entries;
  try {
    journal = JSON.parse(
      await readFile(join(migrationRoot, "meta", "_journal.json"), "utf8")
    );
    snapshot = JSON.parse(
      await readFile(join(migrationRoot, "meta", "0006_snapshot.json"), "utf8")
    );
    entries = await readdir(migrationRoot, { withFileTypes: true });
  } catch {
    throw verifiedFailure("REPOSITORY_MIGRATION_METADATA_INVALID");
  }

  requireCondition(journal?.version === "7", "MIGRATION_JOURNAL_VERSION_MISMATCH");
  requireCondition(journal?.dialect === "postgresql", "MIGRATION_DIALECT_MISMATCH");
  requireCondition(
    Array.isArray(journal.entries) &&
      journal.entries.length === EXPECTED_MIGRATION_TAGS.length,
    "MIGRATION_JOURNAL_COUNT_MISMATCH"
  );

  const tags = journal.entries.map((entry) => entry?.tag);
  requireCondition(
    JSON.stringify(tags) === JSON.stringify(EXPECTED_MIGRATION_TAGS),
    "MIGRATION_JOURNAL_ORDER_MISMATCH"
  );
  for (const [index, entry] of journal.entries.entries()) {
    requireCondition(entry.idx === index, "MIGRATION_JOURNAL_INDEX_MISMATCH");
    requireCondition(entry.version === "7", "MIGRATION_JOURNAL_ENTRY_INVALID");
    requireCondition(entry.breakpoints === true, "MIGRATION_JOURNAL_ENTRY_INVALID");
    requireCondition(
      Number.isSafeInteger(entry.when) && entry.when > 0,
      "MIGRATION_JOURNAL_ENTRY_INVALID"
    );
  }

  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const expectedFiles = EXPECTED_MIGRATION_TAGS.map((tag) => `${tag}.sql`);
  requireCondition(
    JSON.stringify(sqlFiles) === JSON.stringify(expectedFiles),
    "MIGRATION_FILE_SET_MISMATCH"
  );

  const migrations = [];
  const functionSourceHashes = new Map();
  for (const entry of journal.entries) {
    const content = await readFile(join(migrationRoot, `${entry.tag}.sql`), "utf8");
    migrations.push({
      tag: entry.tag,
      createdAt: String(entry.when),
      hash: createHash("sha256").update(content).digest("hex"),
    });
    const functionPattern =
      /CREATE(?: OR REPLACE)? FUNCTION\s+"public"\."([^"]+)"[\s\S]*?\sAS\s+\$\$([\s\S]*?)\$\$;/g;
    for (const match of content.matchAll(functionPattern)) {
      functionSourceHashes.set(
        match[1],
        createHash("sha256")
          .update(match[2].replaceAll("\r\n", "\n").trim())
          .digest("hex")
      );
    }
  }

  requireCondition(snapshot?.version === "7", "SCHEMA_SNAPSHOT_VERSION_MISMATCH");
  requireCondition(snapshot?.dialect === "postgresql", "SCHEMA_SNAPSHOT_INVALID");
  requireCondition(snapshot?.tables && snapshot?.enums, "SCHEMA_SNAPSHOT_INVALID");
  requireCondition(
    EXPECTED_FUNCTIONS.every((entry) => functionSourceHashes.has(entry.name)) &&
      functionSourceHashes.size === EXPECTED_FUNCTIONS.length,
    "FUNCTION_SOURCE_MANIFEST_INVALID"
  );

  return {
    migrations,
    snapshot,
    functionSourceHashes,
    expectedTableNames: Object.values(snapshot.tables)
      .map((table) => table.name)
      .sort(),
  };
}

const SQL = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  statementTimeout: "SET LOCAL statement_timeout = '15000ms'",
  lockTimeout: "SET LOCAL lock_timeout = '3000ms'",
  transactionReadOnly: "SHOW transaction_read_only",
  rollback: "ROLLBACK",
  identity: `
    SELECT
      database_entry.oid::text AS database_oid,
      control.system_identifier::text AS system_identifier
    FROM pg_catalog.pg_database AS database_entry
    CROSS JOIN pg_catalog.pg_control_system() AS control
    WHERE database_entry.datname = pg_catalog.current_database()
  `,
  roleSecurity: `
    SELECT
      role_entry.oid::text AS role_oid,
      database_entry.datdba::text AS database_owner_oid,
      role_entry.rolsuper,
      role_entry.rolcreatedb,
      role_entry.rolcreaterole,
      role_entry.rolreplication,
      role_entry.rolbypassrls,
      role_entry.rolcanlogin,
      session_user = current_user AS session_role_matches,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS candidate_role
        WHERE candidate_role.oid <> role_entry.oid
          AND pg_catalog.pg_has_role(
            current_user,
            candidate_role.oid,
            'MEMBER'
          )
      ) AS any_role_membership,
      pg_catalog.has_database_privilege(
        current_user,
        pg_catalog.current_database(),
        'CREATE'
      ) AS database_create,
      pg_catalog.has_schema_privilege(
        current_user,
        'public',
        'USAGE'
      ) AS schema_usage,
      pg_catalog.has_schema_privilege(
        current_user,
        'public',
        'CREATE'
      ) AS schema_create,
      pg_catalog.has_schema_privilege(
        current_user,
        'drizzle',
        'USAGE'
      ) AS migration_schema_usage,
      pg_catalog.has_schema_privilege(
        current_user,
        'drizzle',
        'CREATE'
      ) AS migration_schema_create
    FROM pg_catalog.pg_roles AS role_entry
    CROSS JOIN pg_catalog.pg_database AS database_entry
    WHERE role_entry.rolname = current_user
      AND database_entry.datname = pg_catalog.current_database()
  `,
  searchPath: "SHOW search_path",
  migrationColumns: `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'drizzle'
      AND table_name = '__drizzle_migrations'
    ORDER BY ordinal_position
  `,
  migrationPrimaryKey: `
    SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)::text[] AS columns
    FROM pg_catalog.pg_constraint AS constraint_entry
    INNER JOIN pg_catalog.pg_class AS table_entry
      ON table_entry.oid = constraint_entry.conrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    CROSS JOIN LATERAL unnest(constraint_entry.conkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_entry.oid
      AND attribute.attnum = key_column.attnum
    WHERE namespace_entry.nspname = 'drizzle'
      AND table_entry.relname = '__drizzle_migrations'
      AND constraint_entry.contype = 'p'
  `,
  migrationHistory: `
    SELECT id::text, hash, created_at::text
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at ASC, id ASC
  `,
  columns: `
    SELECT
      table_entry.relname AS table_name,
      attribute.attname AS column_name,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS not_null,
      attribute.attidentity AS identity_kind,
      attribute.attgenerated AS generated_kind,
      pg_catalog.pg_get_expr(default_entry.adbin, default_entry.adrelid) AS default_expression
    FROM pg_catalog.pg_class AS table_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_entry.oid
    LEFT JOIN pg_catalog.pg_attrdef AS default_entry
      ON default_entry.adrelid = table_entry.oid
      AND default_entry.adnum = attribute.attnum
    WHERE namespace_entry.nspname = 'public'
      AND table_entry.relname = ANY($1::text[])
      AND table_entry.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY table_entry.relname, attribute.attnum
  `,
  constraints: `
    SELECT
      table_entry.relname AS table_name,
      constraint_entry.conname AS constraint_name,
      constraint_entry.contype AS constraint_type,
      referenced_table.relname AS referenced_table,
      ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_entry.conkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_entry.conrelid
          AND attribute.attnum = key_column.attnum
        ORDER BY key_column.ordinality
      )::text[] AS columns,
      ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_entry.confkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_entry.confrelid
          AND attribute.attnum = key_column.attnum
        ORDER BY key_column.ordinality
      )::text[] AS referenced_columns,
      CASE
        WHEN constraint_entry.contype = 'c'
        THEN pg_catalog.pg_get_expr(
          constraint_entry.conbin,
          constraint_entry.conrelid
        )
        ELSE NULL
      END AS expression,
      constraint_entry.confupdtype AS update_action,
      constraint_entry.confdeltype AS delete_action,
      constraint_entry.condeferrable AS is_deferrable,
      constraint_entry.condeferred AS initially_deferred,
      constraint_entry.convalidated AS is_validated
    FROM pg_catalog.pg_constraint AS constraint_entry
    INNER JOIN pg_catalog.pg_class AS table_entry
      ON table_entry.oid = constraint_entry.conrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    LEFT JOIN pg_catalog.pg_class AS referenced_table
      ON referenced_table.oid = constraint_entry.confrelid
    WHERE namespace_entry.nspname = 'public'
      AND table_entry.relname = ANY($1::text[])
      AND constraint_entry.contype IN ('p', 'u', 'f', 'c')
    ORDER BY table_entry.relname, constraint_entry.conname
  `,
  indexes: `
    SELECT
      table_entry.relname AS table_name,
      index_entry.relname AS index_name,
      index_catalog.indisunique AS is_unique,
      index_catalog.indisvalid AS is_valid,
      index_catalog.indisready AS is_ready,
      index_catalog.indislive AS is_live,
      access_method.amname AS method,
      index_catalog.indexprs IS NOT NULL AS has_expressions,
      ARRAY(
        SELECT attribute.attname::text
        FROM unnest(index_catalog.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = table_entry.oid
          AND attribute.attnum = key_column.attnum
        ORDER BY key_column.ordinality
      )::text[] AS columns,
      ARRAY(
        SELECT (index_catalog.indoption[key_column.ordinality - 1] & 1) = 0
        FROM unnest(index_catalog.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        ORDER BY key_column.ordinality
      )::boolean[] AS ascending,
      ARRAY(
        SELECT CASE
          WHEN (index_catalog.indoption[key_column.ordinality - 1] & 2) = 2
          THEN 'first'
          ELSE 'last'
        END
        FROM unnest(index_catalog.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        ORDER BY key_column.ordinality
      )::text[] AS nulls_order,
      pg_catalog.pg_get_expr(
        index_catalog.indpred,
        index_catalog.indrelid
      ) AS predicate
    FROM pg_catalog.pg_index AS index_catalog
    INNER JOIN pg_catalog.pg_class AS table_entry
      ON table_entry.oid = index_catalog.indrelid
    INNER JOIN pg_catalog.pg_class AS index_entry
      ON index_entry.oid = index_catalog.indexrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    INNER JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_entry.relam
    WHERE namespace_entry.nspname = 'public'
      AND table_entry.relname = ANY($1::text[])
      AND NOT index_catalog.indisprimary
    ORDER BY table_entry.relname, index_entry.relname
  `,
  enums: `
    SELECT
      type_entry.typname AS enum_name,
      type_entry.typowner::text AS owner_oid,
      array_agg(enum_entry.enumlabel::text ORDER BY enum_entry.enumsortorder)::text[] AS values
    FROM pg_catalog.pg_type AS type_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = type_entry.typnamespace
    INNER JOIN pg_catalog.pg_enum AS enum_entry
      ON enum_entry.enumtypid = type_entry.oid
    WHERE namespace_entry.nspname = 'public'
    GROUP BY type_entry.typname, type_entry.typowner
    ORDER BY type_entry.typname
  `,
  tables: `
    SELECT
      table_entry.relname AS table_name,
      table_entry.relowner::text AS owner_oid,
      table_entry.relrowsecurity AS rls_enabled,
      table_entry.relforcerowsecurity AS rls_forced,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
          AND acl.privilege_type <> 'SELECT'
      ) AS public_unexpected,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
      ) AS public_any,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee NOT IN (0, table_entry.relowner, current_role_entry.oid)
      ) AS unexpected_grantee
      , EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = current_role_entry.oid
          AND acl.is_grantable
      ) AS current_grant_option
    FROM pg_catalog.pg_class AS table_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    CROSS JOIN pg_catalog.pg_roles AS current_role_entry
    WHERE namespace_entry.nspname = 'public'
      AND table_entry.relkind IN ('r', 'p')
      AND current_role_entry.rolname = current_user
    ORDER BY table_entry.relname
  `,
  policies: `
    SELECT
      table_entry.relname AS table_name,
      policy_entry.polname AS policy_name,
      policy_entry.polcmd AS command,
      policy_entry.polpermissive AS permissive,
      policy_entry.polroles::text AS role_oids,
      pg_catalog.pg_get_expr(policy_entry.polqual, policy_entry.polrelid) AS qualifier,
      pg_catalog.pg_get_expr(policy_entry.polwithcheck, policy_entry.polrelid) AS with_check
    FROM pg_catalog.pg_policy AS policy_entry
    INNER JOIN pg_catalog.pg_class AS table_entry
      ON table_entry.oid = policy_entry.polrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    WHERE namespace_entry.nspname = 'public'
    ORDER BY table_entry.relname, policy_entry.polname
  `,
  sequences: `
    SELECT
      sequence_entry.relname AS sequence_name,
      sequence_entry.relowner::text AS owner_oid,
      namespace_entry.nspname AS schema_name,
      dependent_table.relname AS owned_table,
      dependent_attribute.attname AS owned_column,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            sequence_entry.relacl,
            pg_catalog.acldefault('S', sequence_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
      ) AS public_any,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            sequence_entry.relacl,
            pg_catalog.acldefault('S', sequence_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee NOT IN (
          0,
          sequence_entry.relowner,
          current_role_entry.oid
        )
      ) AS unexpected_grantee,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            sequence_entry.relacl,
            pg_catalog.acldefault('S', sequence_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = current_role_entry.oid
          AND acl.is_grantable
      ) AS current_grant_option
    FROM pg_catalog.pg_class AS sequence_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = sequence_entry.relnamespace
    CROSS JOIN pg_catalog.pg_roles AS current_role_entry
    LEFT JOIN pg_catalog.pg_depend AS dependency
      ON dependency.objid = sequence_entry.oid
      AND dependency.classid = 'pg_catalog.pg_class'::regclass
      AND dependency.deptype IN ('a', 'i')
    LEFT JOIN pg_catalog.pg_class AS dependent_table
      ON dependent_table.oid = dependency.refobjid
    LEFT JOIN pg_catalog.pg_attribute AS dependent_attribute
      ON dependent_attribute.attrelid = dependent_table.oid
      AND dependent_attribute.attnum = dependency.refobjsubid
    WHERE sequence_entry.relkind = 'S'
      AND namespace_entry.nspname IN ('drizzle', 'public')
      AND current_role_entry.rolname = current_user
    ORDER BY namespace_entry.nspname, sequence_entry.relname
  `,
  functions: `
    SELECT
      procedure_entry.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(procedure_entry.oid) AS identity_arguments,
      pg_catalog.pg_get_function_result(procedure_entry.oid) AS result_type,
      procedure_entry.provolatile AS volatility,
      language_entry.lanname AS language,
      procedure_entry.pronargdefaults AS argument_defaults,
      pg_catalog.pg_get_expr(procedure_entry.proargdefaults, 0) AS default_expression,
      procedure_entry.proretset AS returns_set,
      procedure_entry.proisstrict AS is_strict,
      procedure_entry.proparallel AS parallel_safety,
      procedure_entry.prosecdef AS security_definer,
      procedure_entry.proconfig AS configuration,
      procedure_entry.prosrc AS source_text,
      procedure_entry.proowner::text AS owner_oid,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure_entry.proacl,
            pg_catalog.acldefault('f', procedure_entry.proowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
      ) AS public_execute,
      pg_catalog.has_function_privilege(
        current_user,
        procedure_entry.oid,
        'EXECUTE'
      ) AS current_role_execute,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure_entry.proacl,
            pg_catalog.acldefault('f', procedure_entry.proowner)
          )
        ) AS acl
        WHERE acl.grantee NOT IN (
          0,
          procedure_entry.proowner,
          current_role_entry.oid
        )
      ) AS unexpected_grantee
      , EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure_entry.proacl,
            pg_catalog.acldefault('f', procedure_entry.proowner)
          )
        ) AS acl
        WHERE acl.grantee = current_role_entry.oid
          AND acl.is_grantable
      ) AS current_grant_option
    FROM pg_catalog.pg_proc AS procedure_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = procedure_entry.pronamespace
    INNER JOIN pg_catalog.pg_language AS language_entry
      ON language_entry.oid = procedure_entry.prolang
    CROSS JOIN pg_catalog.pg_roles AS current_role_entry
    WHERE namespace_entry.nspname IN ('public', 'drizzle')
      AND current_role_entry.rolname = current_user
    ORDER BY procedure_entry.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure_entry.oid)
  `,
  schemaOwnership: `
    SELECT
      namespace_entry.nspowner::text AS owner_oid,
      (
        namespace_entry.nspowner = role_entry.oid
        OR (
          namespace_entry.nspowner = database_owner_role.oid
          AND database_entry.datdba = role_entry.oid
        )
      ) AS owner_is_expected,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'CREATE'
      ) AS public_create
      , EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee NOT IN (namespace_entry.nspowner, role_entry.oid)
          AND acl.privilege_type = 'CREATE'
      ) AS unexpected_create_grantee
      , EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee = role_entry.oid
          AND acl.privilege_type = 'USAGE'
          AND acl.is_grantable
      ) AS current_usage_grant_option,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee = role_entry.oid
          AND acl.privilege_type = 'CREATE'
          AND acl.is_grantable
      ) AS current_create_grant_option
    FROM pg_catalog.pg_namespace AS namespace_entry
    CROSS JOIN pg_catalog.pg_roles AS role_entry
    CROSS JOIN pg_catalog.pg_database AS database_entry
    LEFT JOIN pg_catalog.pg_roles AS database_owner_role
      ON database_owner_role.rolname = 'pg_database_owner'
    WHERE namespace_entry.nspname = 'public'
      AND role_entry.rolname = current_user
      AND database_entry.datname = pg_catalog.current_database()
  `,
  drizzleOwnership: `
    SELECT
      namespace_entry.nspowner::text AS schema_owner_oid,
      table_entry.relowner::text AS table_owner_oid,
      sequence_entry.relowner::text AS sequence_owner_oid,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
      ) AS public_any,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee NOT IN (
          0,
          table_entry.relowner,
          current_role_entry.oid
        )
      ) AS unexpected_grantee,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee = 0
      ) AS schema_public_any,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee NOT IN (namespace_entry.nspowner, current_role_entry.oid)
          AND acl.privilege_type = 'CREATE'
      ) AS schema_unexpected_create_grantee,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            namespace_entry.nspacl,
            pg_catalog.acldefault('n', namespace_entry.nspowner)
          )
        ) AS acl
        WHERE acl.grantee = current_role_entry.oid
          AND acl.is_grantable
      ) AS schema_current_grant_option,
      pg_catalog.has_table_privilege(
        current_user,
        table_entry.oid,
        'SELECT'
      ) AS current_select,
      pg_catalog.has_table_privilege(
        current_user,
        table_entry.oid,
        'INSERT'
      ) AS current_insert,
      pg_catalog.has_table_privilege(
        current_user,
        table_entry.oid,
        'UPDATE'
      ) AS current_update,
      pg_catalog.has_table_privilege(
        current_user,
        table_entry.oid,
        'DELETE'
      ) AS current_delete
      , EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            table_entry.relacl,
            pg_catalog.acldefault('r', table_entry.relowner)
          )
        ) AS acl
        WHERE acl.grantee = current_role_entry.oid
          AND acl.is_grantable
      ) AS current_grant_option
    FROM pg_catalog.pg_namespace AS namespace_entry
    INNER JOIN pg_catalog.pg_class AS table_entry
      ON table_entry.relnamespace = namespace_entry.oid
      AND table_entry.relname = '__drizzle_migrations'
    INNER JOIN pg_catalog.pg_class AS sequence_entry
      ON sequence_entry.relnamespace = namespace_entry.oid
      AND sequence_entry.relname = '__drizzle_migrations_id_seq'
    CROSS JOIN pg_catalog.pg_roles AS current_role_entry
    WHERE namespace_entry.nspname = 'drizzle'
      AND current_role_entry.rolname = current_user
  `,
  defaultPrivileges: `
    SELECT
      object_kind.kind,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_entry
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_entry.defaclacl) AS acl
        WHERE default_entry.defaclrole = role_entry.oid
          AND default_entry.defaclobjtype = object_kind.kind
          AND acl.grantee = 0
      ) OR (
        object_kind.kind = 'f'::"char"
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl AS global_default
          WHERE global_default.defaclrole = role_entry.oid
            AND global_default.defaclnamespace = 0
            AND global_default.defaclobjtype = 'f'::"char"
        )
      ) AS public_privilege
      , EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_entry
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_entry.defaclacl) AS acl
        WHERE default_entry.defaclrole = role_entry.oid
          AND default_entry.defaclobjtype = object_kind.kind
          AND acl.grantee NOT IN (0, role_entry.oid)
      ) AS unexpected_grantee,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_entry
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_entry.defaclacl) AS acl
        WHERE default_entry.defaclrole = role_entry.oid
          AND default_entry.defaclobjtype = object_kind.kind
          AND acl.grantee <> role_entry.oid
          AND acl.is_grantable
      ) AS unexpected_grant_option
    FROM pg_catalog.pg_roles AS role_entry
    CROSS JOIN (
      VALUES ('r'::"char"), ('S'::"char"), ('f'::"char")
    ) AS object_kind(kind)
    WHERE role_entry.rolname = current_user
    ORDER BY object_kind.kind
  `,
  runtimeTablePrivileges: `
    SELECT
      table_name,
      privilege,
      pg_catalog.has_table_privilege(
        current_user,
        pg_catalog.format('public.%I', table_name),
        privilege
      ) AS allowed
    FROM unnest($1::text[]) AS table_name
    CROSS JOIN unnest(
      ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]
    ) AS privilege
    ORDER BY table_name, privilege
  `,
  runtimeSequencePrivileges: `
    SELECT
      sequence_entry.relname AS sequence_name,
      pg_catalog.has_sequence_privilege(
        current_user,
        sequence_entry.oid,
        'USAGE'
      ) AS usage_allowed,
      pg_catalog.has_sequence_privilege(
        current_user,
        sequence_entry.oid,
        'UPDATE'
      ) AS update_allowed
      , pg_catalog.has_sequence_privilege(
        current_user,
        sequence_entry.oid,
        'SELECT'
      ) AS select_allowed
    FROM pg_catalog.pg_class AS sequence_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = sequence_entry.relnamespace
    WHERE namespace_entry.nspname IN ('public', 'drizzle')
      AND sequence_entry.relkind = 'S'
    ORDER BY namespace_entry.nspname, sequence_entry.relname
  `,
  runtimeTypePrivileges: `
    SELECT
      type_name,
      pg_catalog.has_type_privilege(
        current_user,
        pg_catalog.format('public.%I', type_name),
        'USAGE'
      ) AS usage_allowed
      , EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            type_entry.typacl,
            pg_catalog.acldefault('T', type_entry.typowner)
          )
        ) AS acl
        WHERE acl.grantee = role_entry.oid
          AND acl.is_grantable
      ) AS current_grant_option
    FROM unnest($1::text[]) AS type_name
    INNER JOIN pg_catalog.pg_type AS type_entry
      ON type_entry.typname = type_name
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = type_entry.typnamespace
      AND namespace_entry.nspname = 'public'
    CROSS JOIN pg_catalog.pg_roles AS role_entry
    WHERE role_entry.rolname = current_user
    ORDER BY type_name
  `,
  columnPrivileges: `
    SELECT
      table_entry.relname AS table_name,
      attribute.attname AS column_name,
      acl.privilege_type,
      acl.is_grantable
    FROM pg_catalog.pg_class AS table_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = table_entry.relnamespace
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_entry.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
    WHERE namespace_entry.nspname IN ('public', 'drizzle')
      AND table_entry.relkind IN ('r', 'p')
    ORDER BY table_entry.relname, attribute.attname, acl.privilege_type
  `,
  runtimeOwnerMembership: `
    SELECT pg_catalog.pg_has_role(
      current_user,
      $1::oid,
      'MEMBER'
    ) AS owner_membership
  `,
  counts: `
    SELECT
      (SELECT count(*)::text FROM public.users) AS users_count,
      (SELECT count(*)::text FROM public.oauth_accounts) AS oauth_accounts_count,
      (SELECT count(*)::text FROM public.user_plan_assignments) AS assignments_count,
      (SELECT count(*)::text FROM public.user_usage_buckets) AS usage_buckets_count,
      (SELECT COALESCE(sum(used_count), 0)::text FROM public.user_usage_buckets) AS counter_total,
      (SELECT count(*)::text FROM public.usage_reservation_leases) AS leases_count,
      (SELECT count(*)::text FROM public.analysis_runs) AS history_count,
      (SELECT count(*)::text FROM public.improvement_actions) AS improvement_count
  `,
  collision: `
    SELECT (
      (SELECT count(*) FROM public.users WHERE id = $1::uuid)
      + (SELECT count(*) FROM public.analysis_runs WHERE id = $1::uuid)
      + (SELECT count(*) FROM public.improvement_actions WHERE id = $1::uuid)
      + (SELECT count(*) FROM public.usage_reservation_leases WHERE id = $1::uuid)
    )::integer AS occurrences
  `,
  usageSmoke: `
    SELECT
      (SELECT count(*)::integer FROM public.users WHERE id = $1::uuid) AS user_count,
      (SELECT count(*)::integer FROM public.user_plan_assignments WHERE user_id = $1::uuid) AS assignment_count,
      (SELECT count(*)::integer FROM public.user_usage_buckets WHERE user_id = $1::uuid) AS bucket_count,
      (SELECT count(*)::integer FROM public.usage_reservation_leases WHERE user_id = $1::uuid) AS lease_count
  `,
  weeklySmoke: `
    SELECT
      (SELECT count(*)::integer FROM public.analysis_runs WHERE user_id = $1::uuid) AS history_count,
      (SELECT count(*)::integer FROM public.improvement_actions WHERE user_id = $1::uuid) AS improvement_count
  `,
  preparedSmoke: "SELECT ($1::uuid IS NOT NULL) AS parameterized",
});

async function runQuery(connection, statement, parameters = [], onQuery) {
  assertReadOnlySql(statement);
  onQuery?.(statement);
  try {
    return await withTimeout(
      Promise.resolve(connection.query(statement, parameters)),
      QUERY_TIMEOUT_MILLISECONDS,
      "DATABASE_QUERY_TIMEOUT"
    );
  } catch (error) {
    throw safeIssueFrom(error, "DATABASE_QUERY_UNAVAILABLE", 3);
  }
}

async function openReadOnlyConnection(adapter, kind, url, onQuery) {
  let connection;
  try {
    connection = await adapter.connect(kind, url, {
      timeoutMilliseconds: CONNECTION_TIMEOUT_MILLISECONDS,
    });
    await runQuery(connection, SQL.begin, [], onQuery);
    await runQuery(connection, SQL.statementTimeout, [], onQuery);
    await runQuery(connection, SQL.lockTimeout, [], onQuery);
    const readOnly = await runQuery(
      connection,
      SQL.transactionReadOnly,
      [],
      onQuery
    );
    const value = readOnly.rows?.[0]?.transaction_read_only;
    if (value !== "on") throw verifiedFailure("TRANSACTION_NOT_READ_ONLY");
    return connection;
  } catch (error) {
    if (connection) {
      try {
        await closeReadOnlyConnection(connection, onQuery);
      } catch {
        throw notVerified("CONNECTION_CLEANUP_UNVERIFIED");
      }
    }
    if (
      error instanceof PostflightIssue &&
      error.code === "TRANSACTION_NOT_READ_ONLY"
    ) {
      throw error;
    }
    throw new PostflightIssue(
      `${kind.toUpperCase()}_CONNECTION_UNAVAILABLE`,
      3,
      "fail"
    );
  }
}

async function closeReadOnlyConnection(connection, onQuery) {
  let rollbackFailed = false;
  try {
    await runQuery(connection, SQL.rollback, [], onQuery);
  } catch {
    rollbackFailed = true;
  }
  try {
    await withTimeout(
      Promise.resolve().then(() => connection.close()),
      CLEANUP_TIMEOUT_MILLISECONDS,
      "CONNECTION_CLEANUP_TIMEOUT"
    );
  } catch (error) {
    if (error instanceof PostflightIssue) throw error;
    throw notVerified("CONNECTION_CLEANUP_UNVERIFIED");
  }
  if (rollbackFailed) throw notVerified("TRANSACTION_ROLLBACK_UNVERIFIED");
}

function validateMigrationHistory(specification, evidence) {
  const columns = evidence.migrationColumns;
  requireCondition(columns.length === 3, "MIGRATION_HISTORY_COLUMN_COUNT_MISMATCH");
  const expectedColumns = [
    ["id", "integer", "NO"],
    ["hash", "text", "NO"],
    ["created_at", "bigint", "YES"],
  ];
  for (const [index, expected] of expectedColumns.entries()) {
    const actual = columns[index];
    const defaultMatches =
      index === 0
        ? /^nextval\('drizzle\.__drizzle_migrations_id_seq'::regclass\)$/i.test(
            String(actual?.column_default || "").replaceAll(/\s+/g, "")
          )
        : actual?.column_default == null;
    requireCondition(
      actual?.column_name === expected[0] &&
        actual?.data_type === expected[1] &&
        actual?.is_nullable === expected[2] &&
        defaultMatches,
      "MIGRATION_HISTORY_COLUMN_SIGNATURE_MISMATCH"
    );
  }
  requireCondition(
    Array.isArray(evidence.migrationPrimaryKey?.[0]?.columns) &&
      JSON.stringify(evidence.migrationPrimaryKey[0].columns) ===
        JSON.stringify(["id"]),
    "MIGRATION_HISTORY_PRIMARY_KEY_MISMATCH"
  );
  requireCondition(
    evidence.migrationHistory.length === specification.migrations.length,
    "MIGRATION_HISTORY_COUNT_MISMATCH"
  );
  let previousId = 0n;
  const seenIds = new Set();
  const seenHashes = new Set();
  const seenCreatedAt = new Set();
  for (const [index, expected] of specification.migrations.entries()) {
    const actual = evidence.migrationHistory[index];
    requireCondition(Boolean(actual), "MIGRATION_HISTORY_PENDING");
    requireCondition(/^\d+$/.test(actual.id), "MIGRATION_HISTORY_ID_MISMATCH");
    const actualId = BigInt(actual.id);
    requireCondition(
      actualId > 0n && actualId > previousId && !seenIds.has(actual.id),
      "MIGRATION_HISTORY_ID_MISMATCH"
    );
    requireCondition(
      compareText(actual.hash, expected.hash),
      "MIGRATION_HISTORY_HASH_MISMATCH"
    );
    requireCondition(
      compareText(actual.created_at, expected.createdAt),
      "MIGRATION_HISTORY_ORDER_MISMATCH"
    );
    requireCondition(!seenHashes.has(actual.hash), "MIGRATION_HISTORY_DUPLICATE");
    requireCondition(
      !seenCreatedAt.has(actual.created_at),
      "MIGRATION_HISTORY_DUPLICATE"
    );
    previousId = actualId;
    seenIds.add(actual.id);
    seenHashes.add(actual.hash);
    seenCreatedAt.add(actual.created_at);
  }
  return {
    status: "pass",
    expected: specification.migrations.length,
    actual: evidence.migrationHistory.length,
    pending: 0,
    duplicates: 0,
    unknown: 0,
  };
}

function expectedColumnsFromSnapshot(snapshot) {
  const rows = [];
  for (const table of Object.values(snapshot.tables)) {
    for (const column of Object.values(table.columns)) {
      rows.push({
        table_name: table.name,
        column_name: column.name,
        data_type: column.type,
        not_null: column.notNull,
        identity_kind: "",
        generated_kind: "",
        default_expression:
          column.default === undefined ? null : String(column.default),
      });
    }
  }
  return rows;
}

function validateColumns(snapshot, actualRows) {
  const expectedRows = expectedColumnsFromSnapshot(snapshot);
  requireCondition(actualRows.length === expectedRows.length, "COLUMN_SET_MISMATCH");
  for (const [index, expected] of expectedRows.entries()) {
    const actual = actualRows[index];
    requireCondition(
      actual?.table_name === expected.table_name &&
        actual?.column_name === expected.column_name,
      "COLUMN_SET_MISMATCH"
    );
    requireCondition(
      normalizeDataType(actual.data_type) === normalizeDataType(expected.data_type),
      "COLUMN_TYPE_MISMATCH"
    );
    requireCondition(actual.not_null === expected.not_null, "COLUMN_NULLABILITY_MISMATCH");
    requireCondition(
      actual.identity_kind === expected.identity_kind &&
        actual.generated_kind === expected.generated_kind,
      "COLUMN_GENERATION_MISMATCH"
    );
    requireCondition(
      normalizeSqlExpression(actual.default_expression) ===
        normalizeSqlExpression(expected.default_expression),
      "COLUMN_DEFAULT_MISMATCH"
    );
  }
}

function expectedConstraintsFromSnapshot(snapshot) {
  const rows = [];
  const actionCode = {
    "no action": "a",
    restrict: "r",
    cascade: "c",
    "set null": "n",
    "set default": "d",
  };
  for (const table of Object.values(snapshot.tables)) {
    const primaryColumns = Object.values(table.columns)
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    if (primaryColumns.length > 0) {
      rows.push({
        table_name: table.name,
        constraint_name: `${table.name}_pkey`,
        constraint_type: "p",
        columns: primaryColumns,
      });
    }
    for (const constraint of Object.values(table.uniqueConstraints)) {
      rows.push({
        table_name: table.name,
        constraint_name: constraint.name,
        constraint_type: "u",
        columns: constraint.columns,
      });
    }
    for (const constraint of Object.values(table.foreignKeys)) {
      rows.push({
        table_name: table.name,
        constraint_name: constraint.name,
        constraint_type: "f",
        columns: constraint.columnsFrom,
        referenced_table: constraint.tableTo,
        referenced_columns: constraint.columnsTo,
        update_action: actionCode[constraint.onUpdate],
        delete_action: actionCode[constraint.onDelete],
      });
    }
    for (const constraint of Object.values(table.checkConstraints)) {
      rows.push({
        table_name: table.name,
        constraint_name: constraint.name,
        constraint_type: "c",
        expression: constraint.value,
      });
    }
  }
  return stableSortRows(rows, ["table_name", "constraint_name"]);
}

function validateConstraints(snapshot, actualRows) {
  const expectedRows = expectedConstraintsFromSnapshot(snapshot);
  requireCondition(actualRows.length === expectedRows.length, "CONSTRAINT_SET_MISMATCH");
  for (const [index, expected] of expectedRows.entries()) {
    const actual = actualRows[index];
    requireCondition(
      actual?.table_name === expected.table_name &&
        actual?.constraint_name === expected.constraint_name &&
        actual?.constraint_type === expected.constraint_type,
      "CONSTRAINT_SET_MISMATCH"
    );
    requireCondition(
      actual.is_deferrable === false &&
        actual.initially_deferred === false &&
        actual.is_validated === true,
      "CONSTRAINT_STATE_MISMATCH"
    );
    if (expected.constraint_type !== "c") {
      requireCondition(
        JSON.stringify(actual.columns || []) === JSON.stringify(expected.columns || []),
        "CONSTRAINT_COLUMN_MISMATCH"
      );
    }
    if (expected.constraint_type === "f") {
      requireCondition(
        actual.referenced_table === expected.referenced_table &&
          JSON.stringify(actual.referenced_columns || []) ===
            JSON.stringify(expected.referenced_columns || []) &&
          actual.update_action === expected.update_action &&
          actual.delete_action === expected.delete_action,
        "FOREIGN_KEY_MISMATCH"
      );
    }
    if (expected.constraint_type === "c") {
      requireCondition(
        normalizeSqlExpression(actual.expression) ===
          normalizeSqlExpression(expected.expression),
        "CHECK_CONSTRAINT_MISMATCH"
      );
    }
  }
}

function expectedIndexesFromSnapshot(snapshot) {
  const rows = [];
  for (const table of Object.values(snapshot.tables)) {
    for (const index of Object.values(table.indexes)) {
      rows.push({
        table_name: table.name,
        index_name: index.name,
        is_unique: index.isUnique,
        method: index.method,
        columns: index.columns.map((column) => column.expression),
        ascending: index.columns.map((column) => column.asc),
        nulls_order: index.columns.map((column) => column.nulls),
        predicate: index.where ?? null,
      });
    }
  }
  return stableSortRows(rows, ["table_name", "index_name"]);
}

function validateIndexes(snapshot, actualRows) {
  const expectedRows = expectedIndexesFromSnapshot(snapshot);
  requireCondition(actualRows.length === expectedRows.length, "INDEX_SET_MISMATCH");
  for (const [index, expected] of expectedRows.entries()) {
    const actual = actualRows[index];
    requireCondition(
      actual?.table_name === expected.table_name &&
        actual?.index_name === expected.index_name,
      "INDEX_SET_MISMATCH"
    );
    requireCondition(
      actual.is_unique === expected.is_unique &&
        actual.is_valid === true &&
        actual.is_ready === true &&
        actual.is_live === true &&
        actual.method === expected.method &&
        actual.has_expressions === false &&
        JSON.stringify(actual.columns) === JSON.stringify(expected.columns) &&
        JSON.stringify(actual.ascending) === JSON.stringify(expected.ascending) &&
        JSON.stringify(actual.nulls_order) === JSON.stringify(expected.nulls_order),
      "INDEX_SIGNATURE_MISMATCH"
    );
    requireCondition(
      normalizeSqlExpression(actual.predicate) ===
        normalizeSqlExpression(expected.predicate),
      "INDEX_PREDICATE_MISMATCH"
    );
  }
}

/**
 * @param {Record<string, any>} snapshot
 * @param {Array<Record<string, any>>} actualRows
 * @param {string | null} [directRoleOid]
 */
function validateEnums(snapshot, actualRows, directRoleOid = null) {
  const expected = Object.values(snapshot.enums)
    .map((entry) => ({ enum_name: entry.name, values: entry.values }))
    .sort((left, right) => left.enum_name.localeCompare(right.enum_name));
  requireCondition(actualRows.length === expected.length, "ENUM_SET_MISMATCH");
  for (const [index, entry] of expected.entries()) {
    requireCondition(
      actualRows[index]?.enum_name === entry.enum_name &&
        JSON.stringify(actualRows[index]?.values) === JSON.stringify(entry.values) &&
        (directRoleOid === null || actualRows[index]?.owner_oid === directRoleOid),
      "ENUM_SIGNATURE_MISMATCH"
    );
  }
}

/**
 * @param {Array<Record<string, any>>} actualRows
 * @param {string} directRoleOid
 * @param {{runtime?: boolean, sourceHashes?: Map<string, string> | null}} [options]
 */
function validateFunctions(actualRows, directRoleOid, options = {}) {
  const { runtime = false, sourceHashes = null } = options;
  requireCondition(actualRows.length === EXPECTED_FUNCTIONS.length, "FUNCTION_SET_MISMATCH");
  for (const [index, expected] of EXPECTED_FUNCTIONS.entries()) {
    const actual = actualRows[index];
    requireCondition(actual?.function_name === expected.name, "FUNCTION_SET_MISMATCH");
    requireCondition(
      actual.identity_arguments === expected.identity,
      "FUNCTION_SIGNATURE_MISMATCH"
    );
    requireCondition(actual.result_type === expected.result, "FUNCTION_RETURN_MISMATCH");
    requireCondition(
      actual.volatility === expected.volatility &&
        actual.language === expected.language &&
        actual.argument_defaults === expected.argumentDefaults &&
        (actual.default_expression == null
          ? null
          : normalizeSqlExpression(actual.default_expression, [])) ===
          (expected.defaultExpression == null
            ? null
            : normalizeSqlExpression(expected.defaultExpression, [])) &&
        actual.returns_set === expected.returnsSet &&
        actual.is_strict === false &&
        actual.parallel_safety === "u",
      "FUNCTION_BEHAVIOR_MISMATCH"
    );
    requireCondition(actual.security_definer === false, "FUNCTION_SECURITY_MODE_MISMATCH");
    requireCondition(
      JSON.stringify(actual.configuration) ===
        JSON.stringify(["search_path=public, pg_temp"]),
      "FUNCTION_SEARCH_PATH_MISMATCH"
    );
    requireCondition(actual.public_execute === false, "FUNCTION_PUBLIC_EXECUTE_PRESENT");
    if (sourceHashes) {
      requireCondition(
        actual.source_hash === sourceHashes.get(expected.name),
        "FUNCTION_SOURCE_MISMATCH"
      );
    }
    if (runtime) {
      requireCondition(
        actual.unexpected_grantee === false,
        "FUNCTION_ACL_UNEXPECTED_GRANTEE"
      );
      requireCondition(
        actual.current_grant_option === false,
        "FUNCTION_GRANT_OPTION_PRESENT"
      );
    }
    requireCondition(
      runtime ? actual.current_role_execute === true : actual.owner_oid === directRoleOid,
      runtime ? "RUNTIME_FUNCTION_EXECUTE_MISSING" : "FUNCTION_OWNER_MISMATCH"
    );
  }
}

function validateTablesAndSecurity(
  specification,
  evidence,
  directRoleOid,
  { runtime = false } = {}
) {
  requireCondition(
    JSON.stringify(evidence.tables.map((row) => row.table_name)) ===
      JSON.stringify(specification.expectedTableNames),
    "TABLE_SET_MISMATCH"
  );
  for (const row of evidence.tables) {
    requireCondition(row.owner_oid === directRoleOid, "TABLE_OWNER_MISMATCH");
    requireCondition(row.public_any === false, "TABLE_PUBLIC_PRIVILEGE_PRESENT");
    if (runtime) {
      requireCondition(
        row.unexpected_grantee === false,
        "TABLE_ACL_UNEXPECTED_GRANTEE"
      );
      requireCondition(
        row.current_grant_option === false,
        "TABLE_GRANT_OPTION_PRESENT"
      );
    }
    requireCondition(
      row.rls_enabled === false && row.rls_forced === false,
      "TABLE_RLS_MISMATCH"
    );
  }
  requireCondition(evidence.policies.length === 0, "TABLE_POLICY_MISMATCH");
  requireCondition(
    evidence.columnPrivileges.length === 0,
    "COLUMN_LEVEL_PRIVILEGE_PRESENT"
  );
  const applicationSequences = evidence.sequences.filter(
    (row) => row.schema_name === "public"
  );
  requireCondition(applicationSequences.length === 0, "APPLICATION_SEQUENCE_MISMATCH");
  const historySequence = evidence.sequences.filter(
    (row) => row.schema_name === "drizzle"
  );
  requireCondition(
    historySequence.length === 1 &&
      historySequence[0].owned_table === "__drizzle_migrations" &&
      historySequence[0].owned_column === "id" &&
      historySequence[0].owner_oid === directRoleOid &&
      historySequence[0].public_any === false,
    "MIGRATION_SEQUENCE_MISMATCH"
  );
}

function validateDirectPrivileges(evidence, directRoleOid) {
  const role = evidence.roleSecurity[0];
  requireCondition(Boolean(role), "DIRECT_ROLE_UNAVAILABLE");
  requireCondition(role.role_oid === directRoleOid, "DIRECT_ROLE_IDENTITY_MISMATCH");
  requireCondition(
    role.database_owner_oid === directRoleOid,
    "DIRECT_DATABASE_OWNER_MISMATCH"
  );
  requireCondition(
    evidence.schemaOwnership.length === 1 &&
      evidence.schemaOwnership[0].owner_is_expected === true &&
      evidence.schemaOwnership[0].public_create === false &&
      evidence.schemaOwnership[0].unexpected_create_grantee === false,
    "SCHEMA_OWNER_OR_ACL_MISMATCH"
  );
  requireCondition(
    evidence.drizzleOwnership.length === 1 &&
      evidence.drizzleOwnership[0].schema_owner_oid === directRoleOid &&
      evidence.drizzleOwnership[0].table_owner_oid === directRoleOid &&
      evidence.drizzleOwnership[0].sequence_owner_oid === directRoleOid &&
      evidence.drizzleOwnership[0].public_any === false &&
      evidence.drizzleOwnership[0].schema_public_any === false &&
      evidence.drizzleOwnership[0].schema_unexpected_create_grantee === false,
    "MIGRATION_OWNER_MISMATCH"
  );
  requireCondition(
    evidence.defaultPrivileges.length === 3,
    "DEFAULT_PRIVILEGE_SET_MISMATCH"
  );
  requireCondition(
    evidence.defaultPrivileges.every((row) => row.public_privilege === false),
    "DEFAULT_PUBLIC_PRIVILEGE_PRESENT"
  );
  requireCondition(
    evidence.defaultPrivileges.every(
      (row) =>
        row.unexpected_grantee === false &&
        row.unexpected_grant_option === false
    ),
    "DEFAULT_PRIVILEGE_UNEXPECTED_GRANTEE"
  );
}

function validateRuntimePrivileges(evidence, directRoleOid, expectedEnumNames = []) {
  const role = evidence.roleSecurity[0];
  requireCondition(Boolean(role), "RUNTIME_ROLE_UNAVAILABLE");
  requireCondition(role.role_oid !== directRoleOid, "RUNTIME_ROLE_IS_OWNER");
  requireCondition(
    role.rolsuper === false &&
      role.rolcreatedb === false &&
      role.rolcreaterole === false &&
      role.rolreplication === false &&
      role.rolbypassrls === false &&
      role.rolcanlogin === true &&
      role.session_role_matches === true &&
      role.any_role_membership === false,
    "RUNTIME_ROLE_ATTRIBUTE_EXCESS"
  );
  requireCondition(role.database_create === false, "RUNTIME_DATABASE_CREATE_PRESENT");
  requireCondition(
    role.schema_usage === true &&
      role.schema_create === false &&
      role.migration_schema_usage === true &&
      role.migration_schema_create === false &&
      evidence.schemaOwnership[0]?.current_usage_grant_option === false &&
      evidence.schemaOwnership[0]?.current_create_grant_option === false &&
      evidence.drizzleOwnership[0]?.schema_current_grant_option === false,
    "RUNTIME_SCHEMA_PRIVILEGE_MISMATCH"
  );
  requireCondition(
    evidence.runtimeOwnerMembership?.[0]?.owner_membership === false,
    "RUNTIME_OWNER_MEMBERSHIP_PRESENT"
  );
  requireCondition(
    evidence.searchPath[0]?.search_path === "public, pg_temp",
    "RUNTIME_SEARCH_PATH_MISMATCH"
  );

  for (const row of evidence.runtimeTablePrivileges) {
    const expected = RUNTIME_TABLE_PRIVILEGES[row.table_name] || [];
    const shouldBeAllowed = expected.includes(row.privilege);
    requireCondition(
      row.allowed === shouldBeAllowed,
      shouldBeAllowed
        ? "RUNTIME_TABLE_PRIVILEGE_MISSING"
        : "RUNTIME_TABLE_PRIVILEGE_EXCESS"
    );
    requireCondition(
      !FORBIDDEN_RUNTIME_TABLE_PRIVILEGES.includes(row.privilege) ||
        row.allowed === false,
      "RUNTIME_TABLE_PRIVILEGE_EXCESS"
    );
    requireCondition(
      !row.allowed || ALLOWED_RUNTIME_PRIVILEGES.has(row.privilege),
      "RUNTIME_TABLE_PRIVILEGE_EXCESS"
    );
  }
  requireCondition(
    evidence.runtimeSequencePrivileges.every(
      (row) =>
        row.usage_allowed === false &&
        row.update_allowed === false &&
        row.select_allowed === false
    ),
    "RUNTIME_SEQUENCE_PRIVILEGE_EXCESS"
  );
  requireCondition(
    evidence.sequences.every(
      (row) =>
        row.public_any === false &&
        row.unexpected_grantee === false &&
        row.current_grant_option === false
    ),
    "RUNTIME_SEQUENCE_ACL_MISMATCH"
  );
  requireCondition(
    evidence.runtimeTypePrivileges.length === expectedEnumNames.length &&
      evidence.runtimeTypePrivileges.every(
        (row, index) =>
          row.type_name === expectedEnumNames[index] && row.usage_allowed === true
          && row.current_grant_option === false
      ),
    "RUNTIME_TYPE_PRIVILEGE_MISMATCH"
  );
  const migrationAcl = evidence.drizzleOwnership[0];
  requireCondition(
    migrationAcl?.public_any === false &&
      migrationAcl?.unexpected_grantee === false &&
      migrationAcl?.current_select === true &&
      migrationAcl?.current_insert === false &&
      migrationAcl?.current_update === false &&
      migrationAcl?.current_delete === false &&
      migrationAcl?.current_grant_option === false,
    "RUNTIME_MIGRATION_HISTORY_PRIVILEGE_MISMATCH"
  );
}

async function collectEvidence(connection, specification, onQuery) {
  const tableNames = specification.expectedTableNames;
  const enumNames = Object.values(specification.snapshot.enums).map(
    (entry) => entry.name
  );
  const queries = [
    ["identity", SQL.identity],
    ["roleSecurity", SQL.roleSecurity],
    ["searchPath", SQL.searchPath],
    ["migrationColumns", SQL.migrationColumns],
    ["migrationPrimaryKey", SQL.migrationPrimaryKey],
    ["migrationHistory", SQL.migrationHistory],
    ["columns", SQL.columns, [tableNames]],
    ["constraints", SQL.constraints, [tableNames]],
    ["indexes", SQL.indexes, [tableNames]],
    ["enums", SQL.enums],
    ["tables", SQL.tables],
    ["policies", SQL.policies],
    ["sequences", SQL.sequences],
    ["functions", SQL.functions],
    ["schemaOwnership", SQL.schemaOwnership],
    ["drizzleOwnership", SQL.drizzleOwnership],
    ["defaultPrivileges", SQL.defaultPrivileges],
    ["runtimeTablePrivileges", SQL.runtimeTablePrivileges, [tableNames]],
    ["runtimeSequencePrivileges", SQL.runtimeSequencePrivileges],
    ["runtimeTypePrivileges", SQL.runtimeTypePrivileges, [enumNames]],
    ["columnPrivileges", SQL.columnPrivileges],
  ];
  const evidence = {};
  for (const [key, statement, parameters = []] of queries) {
    try {
      const result = await runQuery(connection, statement, parameters, onQuery);
      evidence[key] =
        key === "functions"
          ? (result.rows || []).map(({ source_text: sourceText, ...row }) => ({
              ...row,
              source_hash: createHash("sha256")
                .update(String(sourceText).replaceAll("\r\n", "\n").trim())
                .digest("hex"),
            }))
          : result.rows || [];
    } catch (error) {
      if (
        error instanceof PostflightIssue &&
        error.code === "DATABASE_QUERY_UNAVAILABLE"
      ) {
        throw notVerified(
          `CATALOG_${key.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_UNAVAILABLE`
        );
      }
      throw error;
    }
  }
  return evidence;
}

function validateEvidence(specification, evidence, { directRoleOid, runtime }) {
  const migrationHistory = validateMigrationHistory(specification, evidence);
  validateColumns(specification.snapshot, evidence.columns);
  validateConstraints(specification.snapshot, evidence.constraints);
  validateIndexes(specification.snapshot, evidence.indexes);
  validateEnums(specification.snapshot, evidence.enums, directRoleOid);
  validateFunctions(evidence.functions, directRoleOid, {
    runtime,
    sourceHashes: specification.functionSourceHashes,
  });
  validateTablesAndSecurity(specification, evidence, directRoleOid, { runtime });
  if (runtime) {
    validateRuntimePrivileges(
      evidence,
      directRoleOid,
      Object.values(specification.snapshot.enums)
        .map((entry) => entry.name)
        .sort()
    );
  }
  else validateDirectPrivileges(evidence, directRoleOid);
  return migrationHistory;
}

function comparableEvidence(evidence) {
  return {
    migrationHistory: evidence.migrationHistory.map((row) => ({
      hash: row.hash,
      created_at: row.created_at,
    })),
    columns: evidence.columns,
    constraints: evidence.constraints,
    indexes: evidence.indexes,
    enums: evidence.enums,
    tables: evidence.tables.map((row) => ({
      table_name: row.table_name,
      owner_oid: row.owner_oid,
      public_any: row.public_any,
      public_any: row.public_any,
      rls_enabled: row.rls_enabled,
      rls_forced: row.rls_forced,
    })),
    policies: evidence.policies,
    sequences: evidence.sequences.map((row) => ({
      schema_name: row.schema_name,
      sequence_name: row.sequence_name,
      owned_table: row.owned_table,
      owned_column: row.owned_column,
      owner_oid: row.owner_oid,
    })),
    functions: evidence.functions.map((row) => ({
      function_name: row.function_name,
      identity_arguments: row.identity_arguments,
      result_type: row.result_type,
      volatility: row.volatility,
      language: row.language,
      argument_defaults: row.argument_defaults,
      default_expression: row.default_expression,
      returns_set: row.returns_set,
      is_strict: row.is_strict,
      parallel_safety: row.parallel_safety,
      security_definer: row.security_definer,
      configuration: row.configuration,
      source_hash: row.source_hash,
      owner_oid: row.owner_oid,
      public_execute: row.public_execute,
    })),
    columnPrivileges: evidence.columnPrivileges,
  };
}

function requireLogicalDatabaseMatch(directEvidence, pooledEvidence) {
  const directIdentity = directEvidence.identity[0];
  const pooledIdentity = pooledEvidence.identity[0];
  if (
    !directIdentity?.database_oid ||
    !directIdentity?.system_identifier ||
    !pooledIdentity?.database_oid ||
    !pooledIdentity?.system_identifier
  ) {
    throw notVerified("LOGICAL_DATABASE_IDENTITY_UNAVAILABLE");
  }
  requireCondition(
    directIdentity.database_oid === pooledIdentity.database_oid &&
      directIdentity.system_identifier === pooledIdentity.system_identifier,
    "LOGICAL_DATABASE_IDENTITY_MISMATCH"
  );
  requireCondition(
    stableFingerprint(comparableEvidence(directEvidence)) ===
      stableFingerprint(comparableEvidence(pooledEvidence)),
    "DIRECT_POOLED_SCHEMA_MISMATCH"
  );
}

async function collectCounts(connection, onQuery) {
  const result = await runQuery(connection, SQL.counts, [], onQuery);
  const row = result.rows?.[0];
  if (!row) throw notVerified("DATA_COUNT_UNAVAILABLE");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, asNumber(value)])
  );
}

async function runRuntimeReadOnlySmoke(connection, onQuery, uuidFactory) {
  let syntheticId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = uuidFactory();
    const collision = await runQuery(connection, SQL.collision, [candidate], onQuery);
    if (asNumber(collision.rows?.[0]?.occurrences) === 0) {
      syntheticId = candidate;
      break;
    }
  }
  if (!syntheticId) throw notVerified("SYNTHETIC_ID_COLLISION_LIMIT");

  const usage = await runQuery(connection, SQL.usageSmoke, [syntheticId], onQuery);
  const weekly = await runQuery(connection, SQL.weeklySmoke, [syntheticId], onQuery);
  const prepared = await runQuery(
    connection,
    SQL.preparedSmoke,
    [syntheticId],
    onQuery
  );
  requireCondition(
    Object.values(usage.rows?.[0] || {}).every((value) => asNumber(value) === 0),
    "USAGE_READ_ONLY_SMOKE_MISMATCH"
  );
  requireCondition(
    Object.values(weekly.rows?.[0] || {}).every((value) => asNumber(value) === 0),
    "WEEKLY_READ_ONLY_SMOKE_MISMATCH"
  );
  requireCondition(
    prepared.rows?.[0]?.parameterized === true,
    "PARAMETERIZED_QUERY_SMOKE_MISMATCH"
  );
}

function baseReport() {
  return {
    environment: "staging",
    directConnection: "not_verified",
    pooledConnection: "not_verified",
    sameLogicalDatabase: "not_verified",
    migrationHistory: {
      status: "not_verified",
      expected: EXPECTED_MIGRATION_TAGS.length,
      actual: 0,
      pending: EXPECTED_MIGRATION_TAGS.length,
      duplicates: 0,
      unknown: 0,
    },
    schema: "not_verified",
    functions: "not_verified",
    ownership: "not_verified",
    acl: "not_verified",
    publicExecute: "not_verified",
    defaultPrivileges: "not_verified",
    securityMode: "not_verified",
    searchPath: "not_verified",
    runtimePrivileges: "not_verified",
    rlsPolicies: "not_verified",
    readOnlySmoke: "not_verified",
    dataCountsUnchanged: "not_verified",
    exitCode: 3,
  };
}

export async function verifyStagingDatabasePostflight({
  environment,
  repositoryRoot,
  adapter,
  allowLoopback = false,
  onQuery = undefined,
  uuidFactory = randomUUID,
}) {
  const report = baseReport();
  let directConnection;
  let pooledConnection;
  let issue;
  try {
    const safety = validateSafetyGate(environment, { allowLoopback });
    const specification = await loadRepositorySpecification(repositoryRoot);

    directConnection = await openReadOnlyConnection(
      adapter,
      "direct",
      safety.directUrl,
      onQuery
    );
    report.directConnection = "pass";
    pooledConnection = await openReadOnlyConnection(
      adapter,
      "pooled",
      safety.pooledUrl,
      onQuery
    );
    report.pooledConnection = "pass";

    const directEvidence = await collectEvidence(
      directConnection,
      specification,
      onQuery
    );
    const directRoleOid = directEvidence.roleSecurity[0]?.role_oid;
    if (!directRoleOid) throw notVerified("DIRECT_ROLE_IDENTITY_UNAVAILABLE");
    report.migrationHistory = validateEvidence(specification, directEvidence, {
      directRoleOid,
      runtime: false,
    });

    const pooledEvidence = await collectEvidence(
      pooledConnection,
      specification,
      onQuery
    );
    pooledEvidence.runtimeOwnerMembership = (
      await runQuery(
        pooledConnection,
        SQL.runtimeOwnerMembership,
        [directRoleOid],
        onQuery
      )
    ).rows;
    validateEvidence(specification, pooledEvidence, {
      directRoleOid,
      runtime: true,
    });
    requireLogicalDatabaseMatch(directEvidence, pooledEvidence);
    report.sameLogicalDatabase = "pass";

    const beforeCounts = await collectCounts(pooledConnection, onQuery);
    await runRuntimeReadOnlySmoke(pooledConnection, onQuery, uuidFactory);
    const afterCounts = await collectCounts(pooledConnection, onQuery);
    requireCondition(
      JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
      "DATA_COUNTS_CHANGED"
    );

    const directAfter = await collectEvidence(
      directConnection,
      specification,
      onQuery
    );
    requireCondition(
      stableFingerprint(comparableEvidence(directEvidence)) ===
        stableFingerprint(comparableEvidence(directAfter)),
      "SCHEMA_CHANGED_DURING_VERIFICATION"
    );

    Object.assign(report, {
      schema: "pass",
      functions: "pass",
      ownership: "pass",
      acl: "pass",
      publicExecute: "none",
      defaultPrivileges: "pass",
      securityMode: "pass",
      searchPath: "pass",
      runtimePrivileges: "pass",
      rlsPolicies: "pass",
      readOnlySmoke: "pass",
      dataCountsUnchanged: "pass",
      exitCode: 0,
    });
  } catch (error) {
    issue = safeIssueFrom(error, "POSTFLIGHT_UNAVAILABLE", 3);
    report.exitCode = issue.exitCode;
    report.failure = {
      checkId: issue.code,
      status: issue.status,
    };
    if (issue.code === "LOGICAL_DATABASE_IDENTITY_MISMATCH") {
      report.sameLogicalDatabase = "fail";
    }
    if (issue.code === "DIRECT_CONNECTION_UNAVAILABLE") {
      report.directConnection = "fail";
    }
    if (issue.code === "POOLED_CONNECTION_UNAVAILABLE") {
      report.pooledConnection = "fail";
    }
  } finally {
    const cleanupIssues = [];
    for (const connection of [pooledConnection, directConnection]) {
      if (!connection) continue;
      try {
        await closeReadOnlyConnection(connection, onQuery);
      } catch (error) {
        cleanupIssues.push(safeIssueFrom(error, "CONNECTION_CLEANUP_UNVERIFIED", 3));
      }
    }
    if (cleanupIssues.length > 0) {
      report.exitCode = 3;
      report.failure = {
        checkId: "CONNECTION_CLEANUP_UNVERIFIED",
        status: "not_verified",
      };
    }
  }
  return report;
}

export const POSTFLIGHT_SQL_FOR_TESTS = SQL;
export {
  closeReadOnlyConnection,
  comparableEvidence,
  normalizeSqlExpression,
  validateColumns,
  validateConstraints,
  validateDirectPrivileges,
  validateEnums,
  validateFunctions,
  validateIndexes,
  validateMigrationHistory,
  validateRuntimePrivileges,
  validateTablesAndSecurity,
};
