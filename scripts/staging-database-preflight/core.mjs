import {
  PostflightIssue,
  PREFLIGHT_CONFIRMATION_KEY,
  safeIssueFrom,
  validateSafetyGate,
} from "../staging-database-postflight/safety.mjs";
import {
  POSTFLIGHT_SQL_FOR_TESTS,
  closeReadOnlyConnection,
  loadRepositorySpecification,
  openReadOnlyConnection,
  runQuery,
  validateMigrationTableShape,
} from "../staging-database-postflight/core.mjs";

const EXPECTED_MIGRATION_OBJECTS = Object.freeze([
  "S:__drizzle_migrations_id_seq",
  "i:__drizzle_migrations_pkey",
  "r:__drizzle_migrations",
]);

const USER_OBJECT_COUNT_FIELDS = Object.freeze([
  ["schemas", "schema_count"],
  ["relations", "relation_count"],
  ["routines", "routine_count"],
  ["types", "type_count"],
  ["triggers", "trigger_count"],
  ["rules", "rule_count"],
  ["policies", "policy_count"],
  ["constraints", "constraint_count"],
  ["other", "other_count"],
]);

const EXTENSION_DEPENDENCY = "e";
const INTERNAL_DEPENDENCY = "i";
const NORMAL_DEPENDENCY = "n";
const VIEW_RETURN_RULE = "_RETURN";
const VIEW_RELATION_KINDS = Object.freeze(["v", "m"]);
const FOREIGN_KEY_CONSTRAINT = "f";
const SUPPORTED_POSTGRESQL_MAJOR = 18;
export const STAGING_EXTENSION_INVENTORY_LIMITS = Object.freeze({
  jsonBytes: 32_768,
  entries: 128,
  stringCharacters: 128,
});
const EXTENSION_INVENTORY_KEYS = Object.freeze(["extensions", "schemaVersion"]);
const EXTENSION_ENTRY_KEYS = Object.freeze(["name", "schema", "version"]);
const EXTENSION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$-]*$/;
const EXTENSION_SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_$-]*$/;

function classifyExtensionCatalogObject({
  evidenceKind,
  dependencyType,
  dependentClass,
  referencedClass,
  referencedIsDirectExtensionMember = false,
  ruleName,
  relationKind,
  triggerConstraintMatches = false,
  constraintType,
} = {}) {
  if (evidenceKind === "candidate") {
    return "neutral_evidence";
  }
  if (evidenceKind === "residual_catalog") {
    return "residual_support";
  }
  if (evidenceKind !== "dependency") {
    return "unknown_evidence";
  }
  if (
    dependencyType === EXTENSION_DEPENDENCY &&
    referencedClass === "pg_extension"
  ) {
    return "managed_support";
  }
  if (dependencyType === NORMAL_DEPENDENCY) {
    return "neutral_evidence";
  }
  if (
    dependencyType !== INTERNAL_DEPENDENCY ||
    referencedIsDirectExtensionMember !== true
  ) {
    return "residual_support";
  }
  if (
    dependentClass === "pg_rewrite" &&
    referencedClass === "pg_class" &&
    ruleName === VIEW_RETURN_RULE &&
    VIEW_RELATION_KINDS.includes(relationKind)
  ) {
    return "managed_support";
  }
  if (
    dependentClass === "pg_trigger" &&
    referencedClass === "pg_constraint" &&
    triggerConstraintMatches === true &&
    constraintType === FOREIGN_KEY_CONSTRAINT
  ) {
    return "managed_support";
  }
  return "residual_support";
}

function verifiedFailure(code) {
  return new PostflightIssue(code, 1, "fail");
}

function notVerified(code) {
  return new PostflightIssue(code, 3, "not_verified");
}

function requireCondition(condition, code) {
  if (!condition) throw verifiedFailure(code);
}

function asNonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw notVerified(code);
  return number;
}

function asInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw notVerified(code);
  return number;
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => String(value)))].sort();
}

function isPlainOwnObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!isPlainOwnObject(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function validateExtensionString(value, pattern) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= STAGING_EXTENSION_INVENTORY_LIMITS.stringCharacters &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f/\\]/.test(value) &&
    pattern.test(value)
  );
}

function normalizeExtensionEntries(value, invalidCode, exitCode) {
  if (
    !Array.isArray(value) ||
    value.length > STAGING_EXTENSION_INVENTORY_LIMITS.entries
  ) {
    throw new PostflightIssue(invalidCode, exitCode, exitCode === 1 ? "fail" : "not_verified");
  }
  const names = new Set();
  const normalized = value.map((entry) => {
    if (
      !hasExactOwnKeys(entry, EXTENSION_ENTRY_KEYS) ||
      !validateExtensionString(entry.name, EXTENSION_NAME_PATTERN) ||
      !validateExtensionString(entry.schema, EXTENSION_SCHEMA_PATTERN) ||
      !validateExtensionString(entry.version, /^[\x20-\x7e]+$/)
    ) {
      throw new PostflightIssue(invalidCode, exitCode, exitCode === 1 ? "fail" : "not_verified");
    }
    if (names.has(entry.name)) {
      throw new PostflightIssue(invalidCode, exitCode, exitCode === 1 ? "fail" : "not_verified");
    }
    names.add(entry.name);
    return { name: entry.name, schema: entry.schema, version: entry.version };
  });
  return normalized.sort((left, right) =>
    `${left.name}\u0000${left.schema}\u0000${left.version}`.localeCompare(
      `${right.name}\u0000${right.schema}\u0000${right.version}`
    )
  );
}

export function parseExpectedStagingExtensions(environment) {
  if (!Object.hasOwn(environment, "ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS")) {
    throw new PostflightIssue("STAGING_EXTENSION_INVENTORY_REQUIRED", 2, "fail");
  }
  const raw = environment.ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS;
  if (
    typeof raw !== "string" ||
    raw.trim().length === 0 ||
    Buffer.byteLength(raw, "utf8") > STAGING_EXTENSION_INVENTORY_LIMITS.jsonBytes
  ) {
    throw new PostflightIssue("STAGING_EXTENSION_INVENTORY_INVALID", 2, "fail");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PostflightIssue("STAGING_EXTENSION_INVENTORY_INVALID", 2, "fail");
  }
  if (
    !hasExactOwnKeys(parsed, EXTENSION_INVENTORY_KEYS) ||
    parsed.schemaVersion !== 1
  ) {
    throw new PostflightIssue("STAGING_EXTENSION_INVENTORY_INVALID", 2, "fail");
  }
  try {
    return normalizeExtensionEntries(
      parsed.extensions,
      "STAGING_EXTENSION_INVENTORY_INVALID",
      2
    );
  } catch {
    throw new PostflightIssue("STAGING_EXTENSION_INVENTORY_INVALID", 2, "fail");
  }
}

function normalizeActualStagingExtensions(rows) {
  try {
    return normalizeExtensionEntries(
      rows,
      "STAGING_EXTENSION_INVENTORY_UNAVAILABLE",
      3
    );
  } catch {
    throw notVerified("STAGING_EXTENSION_INVENTORY_UNAVAILABLE");
  }
}

function requireExtensionInventoryMatch(expected, inventories) {
  const serializedExpected = JSON.stringify(expected);
  requireCondition(
    inventories.every(
      (inventory) => JSON.stringify(inventory) === serializedExpected
    ),
    "STAGING_EXTENSION_INVENTORY_MISMATCH"
  );
}

function throwIfPreflightAborted(signal) {
  if (signal?.aborted) throw notVerified("DATABASE_OPERATION_ABORTED");
}

function validatePostgresqlVersion(row) {
  const version = row?.server_version_num;
  if (typeof version !== "string" || !/^\d+$/.test(version)) {
    throw notVerified("POSTGRESQL_VERSION_UNAVAILABLE");
  }
  const versionNumber = Number(version);
  if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0) {
    throw notVerified("POSTGRESQL_VERSION_UNAVAILABLE");
  }
  requireCondition(
    Math.trunc(versionNumber / 10_000) === SUPPORTED_POSTGRESQL_MAJOR,
    "POSTGRESQL_VERSION_UNSUPPORTED"
  );
  return String(versionNumber);
}

const EXTENSION_CLASSIFICATION_SQL = `
extension_candidate_signature(object_signature) AS (
  SELECT DISTINCT
    managed_entry.classid::text || ':' ||
      managed_entry.objid::text || ':' ||
      managed_entry.objsubid::text
  FROM extension_managed AS managed_entry
  UNION
  SELECT DISTINCT
    residual_entry.classid::text || ':' ||
      residual_entry.objid::text || ':' ||
      residual_entry.objsubid::text
  FROM residual_objects AS residual_entry
), extension_dependency_evidence AS (
  SELECT
    classification_entry.object_signature,
    classification_entry.evidence_signature,
    classification_entry.evidence_kind,
    classification_entry.dependency_type,
    classification_entry.dependent_class,
    classification_entry.referenced_class,
    classification_entry.referenced_is_direct_extension_member,
    classification_entry.rule_name,
    classification_entry.relation_kind,
    classification_entry.trigger_constraint_matches,
    classification_entry.constraint_type,
    (
      CASE WHEN managed_entry.object_signature IS NULL THEN 0 ELSE 1 END +
      CASE WHEN residual_entry.object_signature IS NULL THEN 0 ELSE 1 END
    )::integer AS classification_count
  FROM extension_classification AS classification_entry
  LEFT JOIN (
    SELECT DISTINCT
      managed_object.classid::text || ':' ||
        managed_object.objid::text || ':' ||
        managed_object.objsubid::text AS object_signature
    FROM extension_managed AS managed_object
  ) AS managed_entry
    ON managed_entry.object_signature = classification_entry.object_signature
  LEFT JOIN (
    SELECT DISTINCT
      residual_object.classid::text || ':' ||
        residual_object.objid::text || ':' ||
        residual_object.objsubid::text AS object_signature
    FROM residual_objects AS residual_object
  ) AS residual_entry
    ON residual_entry.object_signature = classification_entry.object_signature
), extension_classification_complete AS (
  SELECT
    evidence_entry.object_signature,
    evidence_entry.evidence_signature,
    evidence_entry.evidence_kind,
    evidence_entry.dependency_type,
    evidence_entry.dependent_class,
    evidence_entry.referenced_class,
    evidence_entry.referenced_is_direct_extension_member,
    evidence_entry.rule_name,
    evidence_entry.relation_kind,
    evidence_entry.trigger_constraint_matches,
    evidence_entry.constraint_type,
    evidence_entry.classification_count
  FROM extension_dependency_evidence AS evidence_entry
  UNION ALL
  SELECT
    candidate_entry.object_signature,
    'candidate:' || candidate_entry.object_signature,
    'candidate'::text,
    'none'::text,
    'none'::text,
    'none'::text,
    false,
    NULL::text,
    NULL::text,
    false,
    NULL::text,
    NULL::integer
  FROM extension_candidate_signature AS candidate_entry
  UNION ALL
  SELECT
    residual_entry.classid::text || ':' ||
      residual_entry.objid::text || ':' ||
      residual_entry.objsubid::text,
    'residual_catalog:' || residual_entry.classid::text || ':' ||
      residual_entry.objid::text || ':' ||
      residual_entry.objsubid::text,
    'residual_catalog'::text,
    'none'::text,
    CASE
      WHEN residual_entry.classid = 'pg_namespace'::pg_catalog.regclass
        THEN 'pg_namespace'
      WHEN residual_entry.classid = 'pg_class'::pg_catalog.regclass
        THEN 'pg_class'
      WHEN residual_entry.classid = 'pg_proc'::pg_catalog.regclass
        THEN 'pg_proc'
      WHEN residual_entry.classid = 'pg_type'::pg_catalog.regclass
        THEN 'pg_type'
      WHEN residual_entry.classid = 'pg_trigger'::pg_catalog.regclass
        THEN 'pg_trigger'
      WHEN residual_entry.classid = 'pg_rewrite'::pg_catalog.regclass
        THEN 'pg_rewrite'
      WHEN residual_entry.classid = 'pg_policy'::pg_catalog.regclass
        THEN 'pg_policy'
      WHEN residual_entry.classid = 'pg_constraint'::pg_catalog.regclass
        THEN 'pg_constraint'
      ELSE 'other_catalog'
    END,
    'none'::text,
    false,
    NULL::text,
    NULL::text,
    false,
    NULL::text,
    NULL::integer
  FROM residual_objects AS residual_entry
)
`;

const SQL = Object.freeze({
  serverVersion: `
    SELECT pg_catalog.current_setting('server_version_num', true)
      AS server_version_num
  `,
  identity: POSTFLIGHT_SQL_FOR_TESTS.identity,
  extensionInventory: `
    SELECT
      extension_entry.extname AS name,
      namespace_entry.nspname AS schema,
      extension_entry.extversion AS version
    FROM pg_catalog.pg_extension AS extension_entry
    INNER JOIN pg_catalog.pg_namespace AS namespace_entry
      ON namespace_entry.oid = extension_entry.extnamespace
    ORDER BY extension_entry.extname,
      namespace_entry.nspname,
      extension_entry.extversion
  `,
  migrationCatalog: `
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace
        WHERE nspname = 'drizzle'
      ) AS schema_exists,
      pg_catalog.to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
        AS table_exists,
      COALESCE(
        ARRAY(
          SELECT table_entry.relkind::text || ':' || table_entry.relname
          FROM pg_catalog.pg_class AS table_entry
          INNER JOIN pg_catalog.pg_namespace AS namespace_entry
            ON namespace_entry.oid = table_entry.relnamespace
          WHERE namespace_entry.nspname = 'drizzle'
          ORDER BY table_entry.relkind::text, table_entry.relname
        ),
        ARRAY[]::text[]
      ) AS objects
  `,
  migrationColumns: POSTFLIGHT_SQL_FOR_TESTS.migrationColumns,
  migrationColumnExact: `
    SELECT
      attribute_entry.attrelid =
        pg_catalog.to_regclass('drizzle.__drizzle_migrations')
        AS relation_is_canonical,
      attribute_entry.attnum::integer AS position,
      attribute_entry.attname AS column_name,
      attribute_entry.attisdropped AS is_dropped,
      attribute_entry.attinhcount::integer AS inherited_count,
      attribute_entry.attislocal AS is_local,
      CASE attribute_entry.atttypid
        WHEN 'integer'::pg_catalog.regtype::oid THEN 'integer'
        WHEN 'text'::pg_catalog.regtype::oid THEN 'text'
        WHEN 'bigint'::pg_catalog.regtype::oid THEN 'bigint'
        ELSE 'unexpected'
      END AS type_key,
      attribute_entry.atttypmod::integer AS typmod,
      attribute_entry.attlen::integer AS type_length,
      attribute_entry.attndims::integer AS dimensions,
      attribute_entry.attbyval AS passed_by_value,
      attribute_entry.attalign::text AS alignment,
      type_entry.typtype::text AS type_kind,
      type_entry.typbasetype = 0 AS domain_base_is_none,
      attribute_entry.attidentity::text AS identity_kind,
      attribute_entry.attgenerated::text AS generated_kind,
      attribute_entry.attcollation = type_entry.typcollation
        AS collation_is_canonical,
      attribute_entry.attnotnull AS is_not_null,
      attribute_entry.atthasdef AS has_default,
      CASE
        WHEN default_entry.oid IS NULL THEN 'none'
        WHEN attribute_entry.attname = 'id'
          AND pg_catalog.pg_get_expr(default_entry.adbin, default_entry.adrelid)
            = 'nextval(''drizzle.__drizzle_migrations_id_seq''::regclass)'
          THEN 'serial_sequence'
        ELSE 'unexpected'
      END AS default_kind,
      attribute_entry.attacl IS NULL AS acl_is_default,
      attribute_entry.attoptions IS NULL AS options_are_default,
      attribute_entry.attfdwoptions IS NULL AS fdw_options_are_default,
      attribute_entry.attstorage::text AS storage_kind,
      attribute_entry.attcompression::text AS compression_kind,
      attribute_entry.attstattarget IS NULL AS statistics_are_default,
      NOT attribute_entry.atthasmissing AS has_no_missing_value,
      attribute_entry.attmissingval IS NULL AS missing_value_is_null
    FROM pg_catalog.pg_attribute AS attribute_entry
    LEFT JOIN pg_catalog.pg_type AS type_entry
      ON type_entry.oid = attribute_entry.atttypid
    LEFT JOIN pg_catalog.pg_attrdef AS default_entry
      ON default_entry.adrelid = attribute_entry.attrelid
     AND default_entry.adnum = attribute_entry.attnum
    WHERE attribute_entry.attrelid =
      pg_catalog.to_regclass('drizzle.__drizzle_migrations')
      AND attribute_entry.attnum > 0
    ORDER BY attribute_entry.attnum
  `,
  migrationPrimaryKey: POSTFLIGHT_SQL_FOR_TESTS.migrationPrimaryKey,
  migrationHistory: POSTFLIGHT_SQL_FOR_TESTS.migrationHistory,
  migrationExact: `
    WITH target AS (
      SELECT
        pg_catalog.to_regnamespace('drizzle')::oid AS namespace_oid,
        pg_catalog.to_regclass('drizzle.__drizzle_migrations')::oid AS table_oid,
        pg_catalog.to_regclass('drizzle.__drizzle_migrations_id_seq')::oid AS sequence_oid,
        pg_catalog.to_regclass('drizzle.__drizzle_migrations_pkey')::oid AS index_oid
    ), id_column AS (
      SELECT attribute_entry.attnum
      FROM target
      INNER JOIN pg_catalog.pg_attribute AS attribute_entry
        ON attribute_entry.attrelid = target.table_oid
       AND attribute_entry.attname = 'id'
       AND NOT attribute_entry.attisdropped
    )
    SELECT
      table_entry.relkind::text AS table_relkind,
      table_entry.relpersistence::text AS table_persistence,
      table_entry.relisshared AS table_is_shared,
      table_entry.relrewrite = 0 AS table_rewrite_is_zero,
      COALESCE(
        table_entry.reltype <> 0
          AND table_row_type.typrelid = target.table_oid,
        false
      ) AS table_row_type_is_canonical,
      table_entry.relispartition AS table_is_partition,
      table_entry.relrowsecurity AS table_row_security,
      table_entry.relforcerowsecurity AS table_force_row_security,
      table_entry.relreplident::text AS table_replica_identity,
      table_entry.relchecks::integer AS table_check_count,
      table_entry.relhasrules AS table_has_rules,
      table_entry.relhastriggers AS table_has_triggers,
      table_entry.relnatts::integer AS table_attribute_count,
      table_entry.relhasindex AS table_has_index,
      table_entry.relhassubclass AS table_has_subclass,
      table_entry.relispopulated AS table_is_populated,
      table_entry.reloftype = 0 AS table_not_typed,
      table_entry.relpartbound IS NULL AS table_no_partition_bound,
      table_entry.reltoastrelid <> 0 AS table_has_toast,
      COALESCE(
        table_toast_entry.oid = table_entry.reltoastrelid
          AND table_toast_entry.relkind = 't'
          AND table_toast_entry.reltoastrelid = 0
          AND table_toast_entry.relowner = table_entry.relowner
          AND table_toast_namespace.nspname = 'pg_toast',
        false
      ) AS table_toast_mapping_is_canonical,
      table_entry.reltablespace = 0 AS table_tablespace_is_default,
      table_entry.relacl IS NULL AS table_acl_is_default,
      COALESCE(pg_catalog.array_length(table_entry.reloptions, 1), 0)::integer
        AS table_option_count,
      table_access_method.amname AS table_access_method,
      sequence_entry.relkind::text AS sequence_relkind,
      sequence_entry.relpersistence::text AS sequence_persistence,
      sequence_entry.relam = 0 AS sequence_access_method_is_zero,
      sequence_entry.relisshared AS sequence_is_shared,
      sequence_entry.relrewrite = 0 AS sequence_rewrite_is_zero,
      sequence_entry.reltype = 0 AS sequence_row_type_is_zero,
      sequence_entry.relispartition AS sequence_is_partition,
      sequence_entry.relrowsecurity AS sequence_row_security,
      sequence_entry.relforcerowsecurity AS sequence_force_row_security,
      sequence_entry.relreplident::text AS sequence_replica_identity,
      sequence_entry.relchecks::integer AS sequence_check_count,
      sequence_entry.relhasrules AS sequence_has_rules,
      sequence_entry.relhastriggers AS sequence_has_triggers,
      sequence_entry.relnatts::integer AS sequence_attribute_count,
      sequence_entry.relhasindex AS sequence_has_index,
      sequence_entry.relhassubclass AS sequence_has_subclass,
      sequence_entry.relispopulated AS sequence_is_populated,
      sequence_entry.reloftype = 0 AS sequence_not_typed,
      sequence_entry.relpartbound IS NULL AS sequence_no_partition_bound,
      sequence_entry.reltoastrelid = 0 AS sequence_has_no_toast,
      sequence_entry.reltablespace = 0 AS sequence_tablespace_is_default,
      sequence_entry.relacl IS NULL AS sequence_acl_is_default,
      COALESCE(pg_catalog.array_length(sequence_entry.reloptions, 1), 0)::integer
        AS sequence_option_count,
      pg_catalog.format_type(sequence_properties.seqtypid, NULL)
        AS sequence_data_type,
      sequence_properties.seqstart::text AS sequence_start,
      sequence_properties.seqincrement::text AS sequence_increment,
      sequence_properties.seqmin::text AS sequence_minimum,
      sequence_properties.seqmax::text AS sequence_maximum,
      sequence_properties.seqcache::text AS sequence_cache,
      sequence_properties.seqcycle AS sequence_cycle,
      sequence_current_state.last_value::text AS sequence_last_value,
      sequence_current_state.is_called AS sequence_is_called,
      index_entry.relkind::text AS index_relkind,
      index_entry.relpersistence::text AS index_persistence,
      index_entry.relisshared AS index_is_shared,
      index_entry.relrewrite = 0 AS index_rewrite_is_zero,
      index_entry.reltype = 0 AS index_row_type_is_zero,
      index_entry.relnatts::integer AS index_relation_attribute_count,
      index_entry.relispartition AS index_is_partition,
      index_entry.relrowsecurity AS index_row_security,
      index_entry.relforcerowsecurity AS index_force_row_security,
      index_entry.relreplident::text AS index_replica_identity,
      index_entry.relchecks::integer AS index_check_count,
      index_entry.relhasrules AS index_has_rules,
      index_entry.relhastriggers AS index_has_triggers,
      index_entry.relhasindex AS index_has_index,
      index_entry.relhassubclass AS index_has_subclass,
      index_entry.relispopulated AS index_is_populated,
      index_entry.reloftype = 0 AS index_not_typed,
      index_entry.relpartbound IS NULL AS index_no_partition_bound,
      index_entry.reltoastrelid = 0 AS index_has_no_toast,
      index_entry.reltablespace = 0 AS index_tablespace_is_default,
      index_entry.relacl IS NULL AS index_acl_is_default,
      table_entry.relnamespace = target.namespace_oid
        AND sequence_entry.relnamespace = target.namespace_oid
        AND index_entry.relnamespace = target.namespace_oid
        AS object_namespaces_are_canonical,
      table_entry.relowner = sequence_entry.relowner
        AND table_entry.relowner = index_entry.relowner
        AS object_owner_is_consistent,
      COALESCE(pg_catalog.array_length(index_entry.reloptions, 1), 0)::integer
        AS index_option_count,
      index_access_method.amname AS index_access_method,
      index_properties.indisunique AS index_is_unique,
      index_properties.indisprimary AS index_is_primary,
      index_properties.indisexclusion AS index_is_exclusion,
      index_properties.indisvalid AS index_is_valid,
      index_properties.indisready AS index_is_ready,
      index_properties.indislive AS index_is_live,
      index_properties.indisclustered AS index_is_clustered,
      index_properties.indisreplident AS index_is_replica_identity,
      index_properties.indimmediate AS index_is_immediate,
      index_properties.indcheckxmin AS index_check_xmin,
      index_properties.indnullsnotdistinct AS index_nulls_not_distinct,
      index_properties.indpred IS NULL AS index_has_no_predicate,
      index_properties.indexprs IS NULL AS index_has_no_expressions,
      index_properties.indcollation::text = '0'
        AS index_collation_is_canonical,
      index_properties.indoption::text = '0'
        AS index_option_is_canonical,
      index_operator_class.opcname = 'int4_ops'
        AND index_operator_namespace.nspname = 'pg_catalog'
        AS index_operator_class_is_canonical,
      index_properties.indnkeyatts::integer AS index_key_count,
      index_properties.indnatts::integer AS index_attribute_count,
      index_properties.indkey::text = id_column.attnum::text AS index_column_exact,
      pg_catalog.array_length(index_properties.indkey, 1) = 1
        AND pg_catalog.array_length(index_properties.indcollation, 1) = 1
        AND pg_catalog.array_length(index_properties.indclass, 1) = 1
        AND pg_catalog.array_length(index_properties.indoption, 1) = 1
        AS index_vector_lengths_are_canonical,
      index_properties.indexrelid = target.index_oid
        AND index_properties.indrelid = target.table_oid
        AS index_relation_mapping_is_canonical,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
      ) AS constraint_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype = 'p'
      ) AS primary_constraint_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype = 'n'
      ) AS not_null_constraint_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype NOT IN ('p', 'n')
      ) AS unexpected_constraint_count,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.conname = '__drizzle_migrations_pkey'
          AND constraint_entry.connamespace = target.namespace_oid
          AND constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contypid = 0
          AND constraint_entry.contype = 'p'
          AND constraint_entry.conindid = target.index_oid
          AND constraint_entry.confrelid = 0
          AND constraint_entry.conkey = ARRAY[id_column.attnum]::smallint[]
          AND constraint_entry.conenforced
          AND NOT constraint_entry.conperiod
          AND NOT constraint_entry.condeferrable
          AND NOT constraint_entry.condeferred
          AND constraint_entry.convalidated
          AND constraint_entry.conparentid = 0
          AND constraint_entry.coninhcount = 0
          AND constraint_entry.conislocal
          AND constraint_entry.connoinherit
      ) AS primary_key_exact,
      (
        SELECT count(*) = 3 AND bool_and(constraint_entry.conenforced)
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_enforcement_is_canonical,
      (
        SELECT count(*) = 3 AND bool_and(NOT constraint_entry.conperiod)
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_period_is_canonical,
      (
        SELECT
          count(*) = 3
          AND bool_and(
            constraint_entry.connamespace = target.namespace_oid
            AND constraint_entry.conrelid = target.table_oid
            AND constraint_entry.contypid = 0
            AND constraint_entry.confrelid = 0
            AND (
              (constraint_entry.contype = 'p'
                AND constraint_entry.conindid = target.index_oid)
              OR
              (constraint_entry.contype = 'n'
                AND constraint_entry.conindid = 0)
            )
          )
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_mapping_is_canonical,
      (
        SELECT
          count(*) = 3
          AND bool_and(
            constraint_entry.confupdtype = ' '
            AND constraint_entry.confdeltype = ' '
            AND constraint_entry.confmatchtype = ' '
          )
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_action_fields_are_canonical,
      (
        SELECT
          count(*) = 3
          AND bool_and(
            constraint_entry.confrelid = 0
            AND constraint_entry.confkey IS NULL
            AND constraint_entry.conpfeqop IS NULL
            AND constraint_entry.conppeqop IS NULL
            AND constraint_entry.conffeqop IS NULL
            AND constraint_entry.confdelsetcols IS NULL
          )
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_foreign_key_fields_are_canonical,
      (
        SELECT
          count(*) = 3
          AND bool_and(constraint_entry.conexclop IS NULL)
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_exclusion_fields_are_canonical,
      (
        SELECT
          count(*) = 3
          AND bool_and(constraint_entry.conbin IS NULL)
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype IN ('p', 'n')
      ) AS constraint_expression_fields_are_canonical,
      (
        SELECT
          count(*) = 2
          AND count(DISTINCT constraint_entry.conkey::text) = 2
          AND bool_and(
            pg_catalog.array_length(constraint_entry.conkey, 1) = 1
            AND constraint_entry.conkey =
              ARRAY[column_entry.attnum]::smallint[]
          )
        FROM pg_catalog.pg_constraint AS constraint_entry
        INNER JOIN pg_catalog.pg_attribute AS column_entry
          ON column_entry.attrelid = target.table_oid
         AND column_entry.attnum = constraint_entry.conkey[1]
         AND column_entry.attname IN ('id', 'hash')
         AND NOT column_entry.attisdropped
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype = 'n'
      ) AS not_null_constraint_keys_exact,
      (
        SELECT
          count(*) = 2
          AND bool_and(
            constraint_entry.conname =
              '__drizzle_migrations_' || column_entry.attname || '_not_null'
          )
        FROM pg_catalog.pg_constraint AS constraint_entry
        INNER JOIN pg_catalog.pg_attribute AS column_entry
          ON column_entry.attrelid = target.table_oid
         AND column_entry.attnum = constraint_entry.conkey[1]
         AND column_entry.attname IN ('id', 'hash')
         AND NOT column_entry.attisdropped
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype = 'n'
      ) AS not_null_constraint_names_exact,
      (
        SELECT
          count(*) = 2
          AND bool_and(
            constraint_entry.connamespace = target.namespace_oid
            AND constraint_entry.conrelid = target.table_oid
            AND constraint_entry.contypid = 0
            AND constraint_entry.conindid = 0
            AND constraint_entry.confrelid = 0
            AND constraint_entry.conenforced
            AND NOT constraint_entry.conperiod
            AND NOT constraint_entry.condeferrable
            AND NOT constraint_entry.condeferred
            AND constraint_entry.convalidated
            AND constraint_entry.conparentid = 0
            AND constraint_entry.coninhcount = 0
            AND constraint_entry.conislocal
            AND NOT constraint_entry.connoinherit
          )
        FROM pg_catalog.pg_constraint AS constraint_entry
        WHERE constraint_entry.conrelid = target.table_oid
          AND constraint_entry.contype = 'n'
      ) AS not_null_constraints_exact,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_trigger AS trigger_entry
        WHERE trigger_entry.tgrelid = target.table_oid
      ) AS trigger_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_rewrite AS rule_entry
        WHERE rule_entry.ev_class = target.table_oid
      ) AS rule_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_policy AS policy_entry
        WHERE policy_entry.polrelid = target.table_oid
      ) AS policy_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_depend AS dependency_entry
        WHERE dependency_entry.classid = 'pg_class'::pg_catalog.regclass
          AND dependency_entry.objid = target.sequence_oid
          AND dependency_entry.refclassid = 'pg_class'::pg_catalog.regclass
          AND dependency_entry.refobjid = target.table_oid
          AND dependency_entry.refobjsubid = id_column.attnum
          AND dependency_entry.deptype = 'a'
      ) AS sequence_owned_by_count,
      (
        SELECT count(*)::integer
        FROM pg_catalog.pg_attrdef AS default_entry
        INNER JOIN pg_catalog.pg_depend AS dependency_entry
          ON dependency_entry.classid = 'pg_attrdef'::pg_catalog.regclass
         AND dependency_entry.objid = default_entry.oid
         AND dependency_entry.refclassid = 'pg_class'::pg_catalog.regclass
         AND dependency_entry.refobjid = target.sequence_oid
         AND dependency_entry.deptype = 'n'
        WHERE default_entry.adrelid = target.table_oid
          AND default_entry.adnum = id_column.attnum
      ) AS default_sequence_dependency_count
    FROM target
    CROSS JOIN id_column
    INNER JOIN pg_catalog.pg_class AS table_entry
      ON table_entry.oid = target.table_oid
    LEFT JOIN pg_catalog.pg_type AS table_row_type
      ON table_row_type.oid = table_entry.reltype
    LEFT JOIN pg_catalog.pg_class AS table_toast_entry
      ON table_toast_entry.oid = table_entry.reltoastrelid
    LEFT JOIN pg_catalog.pg_namespace AS table_toast_namespace
      ON table_toast_namespace.oid = table_toast_entry.relnamespace
    INNER JOIN pg_catalog.pg_am AS table_access_method
      ON table_access_method.oid = table_entry.relam
    INNER JOIN pg_catalog.pg_class AS sequence_entry
      ON sequence_entry.oid = target.sequence_oid
    INNER JOIN pg_catalog.pg_sequence AS sequence_properties
      ON sequence_properties.seqrelid = target.sequence_oid
    CROSS JOIN drizzle.__drizzle_migrations_id_seq AS sequence_current_state
    INNER JOIN pg_catalog.pg_class AS index_entry
      ON index_entry.oid = target.index_oid
    INNER JOIN pg_catalog.pg_index AS index_properties
      ON index_properties.indexrelid = target.index_oid
     AND index_properties.indrelid = target.table_oid
    INNER JOIN pg_catalog.pg_am AS index_access_method
      ON index_access_method.oid = index_entry.relam
    INNER JOIN pg_catalog.pg_opclass AS index_operator_class
      ON index_operator_class.oid = index_properties.indclass[0]
    INNER JOIN pg_catalog.pg_namespace AS index_operator_namespace
      ON index_operator_namespace.oid = index_operator_class.opcnamespace
  `,
  userDefinedObjects: `
    WITH extension_direct(classid, objid, objsubid) AS (
      SELECT
        dependency_entry.classid,
        dependency_entry.objid,
        dependency_entry.objsubid
      FROM pg_catalog.pg_depend AS dependency_entry
      INNER JOIN pg_catalog.pg_extension AS extension_entry
        ON dependency_entry.refclassid = 'pg_extension'::pg_catalog.regclass
       AND dependency_entry.refobjid = extension_entry.oid
       AND dependency_entry.deptype = '${EXTENSION_DEPENDENCY}'
    ), extension_internal(classid, objid, objsubid) AS (
      SELECT
        dependency_entry.classid,
        dependency_entry.objid,
        dependency_entry.objsubid
      FROM pg_catalog.pg_depend AS dependency_entry
      INNER JOIN extension_direct AS extension_parent
        ON dependency_entry.refclassid = extension_parent.classid
       AND dependency_entry.refobjid = extension_parent.objid
       AND extension_parent.objsubid = 0
      INNER JOIN pg_catalog.pg_rewrite AS rule_entry
        ON dependency_entry.classid = 'pg_rewrite'::pg_catalog.regclass
       AND dependency_entry.objid = rule_entry.oid
      INNER JOIN pg_catalog.pg_class AS relation_entry
        ON dependency_entry.refclassid = 'pg_class'::pg_catalog.regclass
       AND dependency_entry.refobjid = relation_entry.oid
       AND rule_entry.ev_class = relation_entry.oid
      WHERE dependency_entry.deptype = '${INTERNAL_DEPENDENCY}'
        AND rule_entry.rulename = '${VIEW_RETURN_RULE}'
        AND relation_entry.relkind IN (${VIEW_RELATION_KINDS.map((kind) => `'${kind}'`).join(", ")})
      UNION
      SELECT
        dependency_entry.classid,
        dependency_entry.objid,
        dependency_entry.objsubid
      FROM pg_catalog.pg_depend AS dependency_entry
      INNER JOIN extension_direct AS extension_parent
        ON dependency_entry.refclassid = extension_parent.classid
       AND dependency_entry.refobjid = extension_parent.objid
       AND extension_parent.objsubid = 0
      INNER JOIN pg_catalog.pg_trigger AS trigger_entry
        ON dependency_entry.classid = 'pg_trigger'::pg_catalog.regclass
       AND dependency_entry.objid = trigger_entry.oid
      INNER JOIN pg_catalog.pg_constraint AS constraint_entry
        ON dependency_entry.refclassid = 'pg_constraint'::pg_catalog.regclass
       AND dependency_entry.refobjid = constraint_entry.oid
       AND trigger_entry.tgconstraint = constraint_entry.oid
      WHERE dependency_entry.deptype = '${INTERNAL_DEPENDENCY}'
        AND constraint_entry.contype = '${FOREIGN_KEY_CONSTRAINT}'
    ), extension_classification AS (
      SELECT
        dependency_entry.classid::text || ':' ||
          dependency_entry.objid::text || ':' ||
          dependency_entry.objsubid::text AS object_signature,
        'dependency:' || dependency_entry.classid::text || ':' ||
          dependency_entry.objid::text || ':' ||
          dependency_entry.objsubid::text || ':' ||
          dependency_entry.refclassid::text || ':' ||
          dependency_entry.refobjid::text || ':' ||
          dependency_entry.refobjsubid::text || ':' ||
          dependency_entry.deptype::text AS evidence_signature,
        'dependency'::text AS evidence_kind,
        dependency_entry.deptype::text AS dependency_type,
        CASE
          WHEN dependency_entry.classid = 'pg_rewrite'::pg_catalog.regclass
            THEN 'pg_rewrite'
          WHEN dependency_entry.classid = 'pg_trigger'::pg_catalog.regclass
            THEN 'pg_trigger'
          ELSE 'other_catalog'
        END AS dependent_class,
        'pg_extension'::text AS referenced_class,
        false AS referenced_is_direct_extension_member,
        NULL::text AS rule_name,
        NULL::text AS relation_kind,
        false AS trigger_constraint_matches,
        NULL::text AS constraint_type
      FROM pg_catalog.pg_depend AS dependency_entry
      INNER JOIN pg_catalog.pg_extension AS extension_entry
        ON dependency_entry.refclassid = 'pg_extension'::pg_catalog.regclass
       AND dependency_entry.refobjid = extension_entry.oid
       AND dependency_entry.deptype = '${EXTENSION_DEPENDENCY}'
      UNION ALL
      SELECT
        dependency_entry.classid::text || ':' ||
          dependency_entry.objid::text || ':' ||
          dependency_entry.objsubid::text,
        'dependency:' || dependency_entry.classid::text || ':' ||
          dependency_entry.objid::text || ':' ||
          dependency_entry.objsubid::text || ':' ||
          dependency_entry.refclassid::text || ':' ||
          dependency_entry.refobjid::text || ':' ||
          dependency_entry.refobjsubid::text || ':' ||
          dependency_entry.deptype::text,
        'dependency'::text,
        dependency_entry.deptype::text,
        CASE
          WHEN dependency_entry.classid = 'pg_rewrite'::pg_catalog.regclass
            THEN 'pg_rewrite'
          WHEN dependency_entry.classid = 'pg_trigger'::pg_catalog.regclass
            THEN 'pg_trigger'
          WHEN dependency_entry.classid = 'pg_constraint'::pg_catalog.regclass
            THEN 'pg_constraint'
          WHEN dependency_entry.classid = 'pg_class'::pg_catalog.regclass
            THEN 'pg_class'
          ELSE 'other_catalog'
        END,
        CASE
          WHEN dependency_entry.refclassid = 'pg_class'::pg_catalog.regclass
            THEN 'pg_class'
          WHEN dependency_entry.refclassid = 'pg_constraint'::pg_catalog.regclass
            THEN 'pg_constraint'
          ELSE 'other_catalog'
        END,
        true,
        rule_entry.rulename::text,
        relation_entry.relkind::text,
        COALESCE(trigger_entry.tgconstraint = constraint_entry.oid, false),
        constraint_entry.contype::text
      FROM pg_catalog.pg_depend AS dependency_entry
      INNER JOIN extension_direct AS extension_parent
        ON dependency_entry.refclassid = extension_parent.classid
       AND dependency_entry.refobjid = extension_parent.objid
       AND extension_parent.objsubid = 0
      LEFT JOIN pg_catalog.pg_rewrite AS rule_entry
        ON dependency_entry.classid = 'pg_rewrite'::pg_catalog.regclass
       AND dependency_entry.objid = rule_entry.oid
      LEFT JOIN pg_catalog.pg_class AS relation_entry
        ON dependency_entry.refclassid = 'pg_class'::pg_catalog.regclass
       AND dependency_entry.refobjid = relation_entry.oid
       AND rule_entry.ev_class = relation_entry.oid
      LEFT JOIN pg_catalog.pg_trigger AS trigger_entry
        ON dependency_entry.classid = 'pg_trigger'::pg_catalog.regclass
       AND dependency_entry.objid = trigger_entry.oid
      LEFT JOIN pg_catalog.pg_constraint AS constraint_entry
        ON dependency_entry.refclassid = 'pg_constraint'::pg_catalog.regclass
       AND dependency_entry.refobjid = constraint_entry.oid
    ), extension_managed(classid, objid, objsubid) AS (
      SELECT classid, objid, objsubid FROM extension_direct
      UNION
      SELECT classid, objid, objsubid FROM extension_internal
    ), user_namespaces AS (
      SELECT namespace_entry.oid, namespace_entry.nspname
      FROM pg_catalog.pg_namespace AS namespace_entry
      WHERE namespace_entry.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace_entry.nspname !~ '^pg_toast(?:_|$)'
        AND namespace_entry.nspname !~ '^pg_temp(?:_|$)'
        AND namespace_entry.nspname !~ '^pg_toast_temp(?:_|$)'
    ), residual_objects(kind, classid, objid, objsubid) AS (
      SELECT
        'schema',
        'pg_namespace'::pg_catalog.regclass::oid,
        namespace_entry.oid,
        0
      FROM user_namespaces AS namespace_entry
      WHERE namespace_entry.nspname NOT IN ('public', 'drizzle')
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_namespace'::pg_catalog.regclass
            AND extension_managed.objid = namespace_entry.oid
        )
      UNION ALL
      SELECT
        'relation',
        'pg_class'::pg_catalog.regclass::oid,
        relation_entry.oid,
        0
      FROM pg_catalog.pg_class AS relation_entry
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = relation_entry.relnamespace
      WHERE NOT (
        namespace_entry.nspname = 'drizzle'
        AND (
          (relation_entry.relkind = 'r' AND relation_entry.relname = '__drizzle_migrations')
          OR (relation_entry.relkind = 'i' AND relation_entry.relname = '__drizzle_migrations_pkey')
          OR (relation_entry.relkind = 'S' AND relation_entry.relname = '__drizzle_migrations_id_seq')
        )
      )
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_class'::pg_catalog.regclass
            AND extension_managed.objid = relation_entry.oid
        )
      UNION ALL
      SELECT 'routine', 'pg_proc'::pg_catalog.regclass::oid, routine_entry.oid, 0
      FROM pg_catalog.pg_proc AS routine_entry
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = routine_entry.pronamespace
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_managed
        WHERE extension_managed.classid = 'pg_proc'::pg_catalog.regclass
          AND extension_managed.objid = routine_entry.oid
      )
      UNION ALL
      SELECT 'type', 'pg_type'::pg_catalog.regclass::oid, type_entry.oid, 0
      FROM pg_catalog.pg_type AS type_entry
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = type_entry.typnamespace
      WHERE type_entry.typrelid = 0
        AND NOT (type_entry.typelem <> 0 AND type_entry.typarray = 0)
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_type'::pg_catalog.regclass
            AND extension_managed.objid = type_entry.oid
        )
      UNION ALL
      SELECT 'trigger', 'pg_trigger'::pg_catalog.regclass::oid, trigger_entry.oid, 0
      FROM pg_catalog.pg_trigger AS trigger_entry
      INNER JOIN pg_catalog.pg_class AS relation_entry
        ON relation_entry.oid = trigger_entry.tgrelid
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = relation_entry.relnamespace
      WHERE NOT (
        namespace_entry.nspname = 'drizzle'
        AND relation_entry.relname = '__drizzle_migrations'
      )
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_trigger'::pg_catalog.regclass
            AND extension_managed.objid = trigger_entry.oid
        )
      UNION ALL
      SELECT 'rule', 'pg_rewrite'::pg_catalog.regclass::oid, rule_entry.oid, 0
      FROM pg_catalog.pg_rewrite AS rule_entry
      INNER JOIN pg_catalog.pg_class AS relation_entry
        ON relation_entry.oid = rule_entry.ev_class
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = relation_entry.relnamespace
      WHERE NOT (
        namespace_entry.nspname = 'drizzle'
        AND relation_entry.relname = '__drizzle_migrations'
      )
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_rewrite'::pg_catalog.regclass
            AND extension_managed.objid = rule_entry.oid
        )
      UNION ALL
      SELECT 'policy', 'pg_policy'::pg_catalog.regclass::oid, policy_entry.oid, 0
      FROM pg_catalog.pg_policy AS policy_entry
      INNER JOIN pg_catalog.pg_class AS relation_entry
        ON relation_entry.oid = policy_entry.polrelid
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = relation_entry.relnamespace
      WHERE NOT (
        namespace_entry.nspname = 'drizzle'
        AND relation_entry.relname = '__drizzle_migrations'
      )
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_policy'::pg_catalog.regclass
            AND extension_managed.objid = policy_entry.oid
        )
      UNION ALL
      SELECT 'constraint', 'pg_constraint'::pg_catalog.regclass::oid, constraint_entry.oid, 0
      FROM pg_catalog.pg_constraint AS constraint_entry
      LEFT JOIN pg_catalog.pg_class AS relation_entry
        ON relation_entry.oid = constraint_entry.conrelid
      LEFT JOIN pg_catalog.pg_type AS type_entry
        ON type_entry.oid = constraint_entry.contypid
      INNER JOIN user_namespaces AS namespace_entry
        ON namespace_entry.oid = COALESCE(
          relation_entry.relnamespace,
          type_entry.typnamespace
        )
      WHERE NOT (
        namespace_entry.nspname = 'drizzle'
        AND relation_entry.relname = '__drizzle_migrations'
      )
        AND NOT EXISTS (
          SELECT 1 FROM extension_managed
          WHERE extension_managed.classid = 'pg_constraint'::pg_catalog.regclass
            AND extension_managed.objid = constraint_entry.oid
        )
      UNION ALL
      SELECT 'other', 'pg_operator'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_operator AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.oprnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_operator'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_opclass'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_opclass AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.opcnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_opclass'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_opfamily'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_opfamily AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.opfnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_opfamily'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_collation'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_collation AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.collnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_collation'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_conversion'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_conversion AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.connamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_conversion'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_ts_config'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_ts_config AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.cfgnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_ts_config'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_ts_dict'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_ts_dict AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.dictnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_ts_dict'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_ts_parser'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_ts_parser AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.prsnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_ts_parser'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_ts_template'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_ts_template AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.tmplnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_ts_template'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_statistic_ext'::pg_catalog.regclass::oid, object_entry.oid, 0
      FROM pg_catalog.pg_statistic_ext AS object_entry
      INNER JOIN user_namespaces AS namespace_entry ON namespace_entry.oid = object_entry.stxnamespace
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_statistic_ext'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_event_trigger'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_event_trigger AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_event_trigger'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_foreign_data_wrapper'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_foreign_data_wrapper AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_foreign_data_wrapper'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_foreign_server'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_foreign_server AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_foreign_server'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_user_mapping'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_user_mapping AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_user_mapping'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_publication'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_publication AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_publication'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_subscription'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_subscription AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_subscription'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_cast'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_cast AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_cast'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_transform'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_transform AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_transform'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_language'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_language AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_language'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_am'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_am AS object_entry
      WHERE object_entry.oid >= 16384 AND NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_am'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_default_acl'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_default_acl AS object_entry
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_default_acl'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_largeobject_metadata'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_largeobject_metadata AS object_entry
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_largeobject_metadata'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
      UNION ALL
      SELECT 'other', 'pg_parameter_acl'::pg_catalog.regclass::oid, object_entry.oid, 0 FROM pg_catalog.pg_parameter_acl AS object_entry
      WHERE NOT EXISTS (SELECT 1 FROM extension_managed WHERE extension_managed.classid = 'pg_parameter_acl'::pg_catalog.regclass AND extension_managed.objid = object_entry.oid)
    ), ${EXTENSION_CLASSIFICATION_SQL}
    SELECT
      count(*)::integer AS total_count,
      count(*) FILTER (WHERE kind = 'schema')::integer AS schema_count,
      count(*) FILTER (WHERE kind = 'relation')::integer AS relation_count,
      count(*) FILTER (WHERE kind = 'routine')::integer AS routine_count,
      count(*) FILTER (WHERE kind = 'type')::integer AS type_count,
      count(*) FILTER (WHERE kind = 'trigger')::integer AS trigger_count,
      count(*) FILTER (WHERE kind = 'rule')::integer AS rule_count,
      count(*) FILTER (WHERE kind = 'policy')::integer AS policy_count,
      count(*) FILTER (WHERE kind = 'constraint')::integer AS constraint_count,
      count(*) FILTER (WHERE kind = 'other')::integer AS other_count,
      COALESCE(
        (
          SELECT sum(GREATEST(COALESCE(table_stats.n_live_tup, 0), 0))::bigint
          FROM pg_catalog.pg_stat_all_tables AS table_stats
          INNER JOIN residual_objects
            ON residual_objects.kind = 'relation'
           AND residual_objects.classid = 'pg_class'::pg_catalog.regclass
           AND residual_objects.objid = table_stats.relid
        ),
        0
      )::text AS estimated_data_rows,
      COALESCE(
        pg_catalog.array_agg(
          kind || ':' || classid::text || ':' || objid::text || ':' || objsubid::text
          ORDER BY kind, classid, objid, objsubid
        ),
        ARRAY[]::text[]
      ) AS object_signature,
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'objectSignature', classification_entry.object_signature,
              'evidenceSignature', classification_entry.evidence_signature,
              'evidenceKind', classification_entry.evidence_kind,
              'dependencyType', classification_entry.dependency_type,
              'dependentClass', classification_entry.dependent_class,
              'referencedClass', classification_entry.referenced_class,
              'referencedIsDirectExtensionMember',
                classification_entry.referenced_is_direct_extension_member,
              'ruleName', classification_entry.rule_name,
              'relationKind', classification_entry.relation_kind,
              'triggerConstraintMatches',
                classification_entry.trigger_constraint_matches,
              'constraintType', classification_entry.constraint_type,
              'classificationCount',
                classification_entry.classification_count
            )
            ORDER BY
              classification_entry.object_signature,
              classification_entry.evidence_signature,
              classification_entry.evidence_kind,
              classification_entry.dependency_type,
              classification_entry.dependent_class,
              classification_entry.referenced_class
          )
          FROM extension_classification_complete AS classification_entry
        ),
        '[]'::pg_catalog.jsonb
      ) AS extension_classification_evidence,
      (
        SELECT count(*)::integer
        FROM extension_dependency_evidence AS evidence_entry
        WHERE evidence_entry.classification_count = 0
      ) AS extension_unclassified_count,
      (
        SELECT count(*)::integer
        FROM extension_dependency_evidence AS evidence_entry
        WHERE evidence_entry.classification_count > 1
      ) AS extension_ambiguous_count,
      COALESCE(
        (
          SELECT pg_catalog.array_agg(
            candidate_entry.object_signature
            ORDER BY candidate_entry.object_signature
          )
          FROM extension_candidate_signature AS candidate_entry
        ),
        ARRAY[]::text[]
      ) AS extension_candidate_signature,
      COALESCE(
        (
          SELECT pg_catalog.array_agg(
            managed_entry.classid::text || ':' ||
              managed_entry.objid::text || ':' ||
              managed_entry.objsubid::text
            ORDER BY
              managed_entry.classid,
              managed_entry.objid,
              managed_entry.objsubid
          )
          FROM extension_managed AS managed_entry
        ),
        ARRAY[]::text[]
      ) AS extension_managed_signature,
      COALESCE(
        (
          SELECT pg_catalog.array_agg(
            residual_entry.classid::text || ':' ||
              residual_entry.objid::text || ':' ||
              residual_entry.objsubid::text
            ORDER BY
              residual_entry.classid,
              residual_entry.objid,
              residual_entry.objsubid
          )
          FROM residual_objects AS residual_entry
        ),
        ARRAY[]::text[]
      ) AS extension_residual_signature
    FROM residual_objects
  `,
});

async function collectPreflightEvidence(
  connection,
  onQuery,
  { signal } = {}
) {
  throwIfPreflightAborted(signal);
  const serverVersionRow = (
    await runQuery(connection, SQL.serverVersion, [], onQuery, { signal })
  ).rows?.[0];
  const serverVersionNumber = validatePostgresqlVersion(serverVersionRow);
  const serverVersion = { server_version_num: serverVersionNumber };
  const identity = (
    await runQuery(connection, SQL.identity, [], onQuery, { signal })
  ).rows || [];
  let extensionInventory;
  try {
    const extensionResult = await runQuery(
      connection,
      SQL.extensionInventory,
      [],
      onQuery,
      { signal }
    );
    extensionInventory = normalizeActualStagingExtensions(extensionResult.rows);
  } catch (error) {
    if (
      error instanceof PostflightIssue &&
      error.code === "DATABASE_OPERATION_ABORTED"
    ) {
      throw error;
    }
    throw notVerified("STAGING_EXTENSION_INVENTORY_UNAVAILABLE");
  }
  const migrationCatalog = (
    await runQuery(connection, SQL.migrationCatalog, [], onQuery, { signal })
  ).rows?.[0];
  if (!migrationCatalog) throw notVerified("MIGRATION_CATALOG_UNAVAILABLE");

  let migrationColumns = [];
  let migrationColumnExact = [];
  let migrationPrimaryKey = [];
  let migrationHistory = [];
  let migrationExact = null;
  if (migrationCatalog.table_exists === true) {
    migrationColumns = (
      await runQuery(connection, SQL.migrationColumns, [], onQuery, { signal })
    ).rows || [];
    migrationColumnExact = (
      await runQuery(connection, SQL.migrationColumnExact, [], onQuery, { signal })
    ).rows || [];
    migrationPrimaryKey = (
      await runQuery(connection, SQL.migrationPrimaryKey, [], onQuery, { signal })
    ).rows || [];
    migrationHistory = (
      await runQuery(connection, SQL.migrationHistory, [], onQuery, { signal })
    ).rows || [];
    migrationExact = (
      await runQuery(connection, SQL.migrationExact, [], onQuery, { signal })
    ).rows?.[0];
    if (!migrationExact) throw notVerified("MIGRATION_EXACT_CATALOG_UNAVAILABLE");
  }

  const userDefinedObjects = (
    await runQuery(connection, SQL.userDefinedObjects, [], onQuery, { signal })
  ).rows?.[0];
  if (!userDefinedObjects) {
    throw notVerified("USER_OBJECT_CATALOG_UNAVAILABLE");
  }

  return {
    serverVersion,
    identity,
    extensionInventory,
    migrationCatalog,
    migrationColumns,
    migrationColumnExact,
    migrationPrimaryKey,
    migrationHistory,
    migrationExact,
    userDefinedObjects,
  };
}

function validateDatabaseIdentity(evidence) {
  const identity = evidence.identity?.[0];
  if (!identity?.database_oid || !identity?.system_identifier) {
    throw notVerified("LOGICAL_DATABASE_IDENTITY_UNAVAILABLE");
  }
  return {
    databaseOid: String(identity.database_oid),
    systemIdentifier: String(identity.system_identifier),
  };
}

function requireIdentityMatch(directEvidence, pooledEvidence) {
  const direct = validateDatabaseIdentity(directEvidence);
  const pooled = validateDatabaseIdentity(pooledEvidence);
  requireCondition(
    direct.databaseOid === pooled.databaseOid &&
      direct.systemIdentifier === pooled.systemIdentifier,
    "LOGICAL_DATABASE_IDENTITY_MISMATCH"
  );
}

function classifyMigrationHistory(specification, migrationHistory) {
  const known = new Set(
    specification.migrations.map(
      (entry) => `${entry.hash}\u0000${entry.createdAt}`
    )
  );
  const seenIds = new Set();
  const seenHashes = new Set();
  const seenCreatedAt = new Set();
  let duplicates = 0;
  let unknown = 0;

  for (const row of migrationHistory) {
    const id = String(row?.id ?? "");
    const hash = String(row?.hash ?? "");
    const createdAt = String(row?.created_at ?? "");
    if (
      seenIds.has(id) ||
      seenHashes.has(hash) ||
      seenCreatedAt.has(createdAt)
    ) {
      duplicates += 1;
    }
    if (!known.has(`${hash}\u0000${createdAt}`)) unknown += 1;
    seenIds.add(id);
    seenHashes.add(hash);
    seenCreatedAt.add(createdAt);
  }
  return { duplicates, unknown };
}

function validateMigrationSequenceCurrentState(exact) {
  if (
    !exact ||
    typeof exact !== "object" ||
    exact.sequence_last_value === null ||
    exact.sequence_last_value === undefined ||
    typeof exact.sequence_is_called !== "boolean"
  ) {
    throw notVerified("MIGRATION_SEQUENCE_STATE_UNAVAILABLE");
  }
  requireCondition(
    String(exact.sequence_last_value) === "1" &&
      exact.sequence_is_called === false,
    "MIGRATION_SEQUENCE_STATE_MISMATCH"
  );
}

function validateMigrationColumnExactState(rows) {
  if (!Array.isArray(rows)) {
    throw notVerified("MIGRATION_COLUMN_CATALOG_UNAVAILABLE");
  }
  requireCondition(
    rows.length === 3,
    "MIGRATION_COLUMN_CATALOG_MISMATCH"
  );
  const expectedColumns = [
    {
      position: 1,
      column_name: "id",
      type_key: "integer",
      type_length: 4,
      passed_by_value: true,
      alignment: "i",
      is_not_null: true,
      has_default: true,
      default_kind: "serial_sequence",
      storage_kind: "p",
    },
    {
      position: 2,
      column_name: "hash",
      type_key: "text",
      type_length: -1,
      passed_by_value: false,
      alignment: "i",
      is_not_null: true,
      has_default: false,
      default_kind: "none",
      storage_kind: "x",
    },
    {
      position: 3,
      column_name: "created_at",
      type_key: "bigint",
      type_length: 8,
      passed_by_value: true,
      alignment: "d",
      is_not_null: false,
      has_default: false,
      default_kind: "none",
      storage_kind: "p",
    },
  ];
  const booleanFields = [
    "relation_is_canonical",
    "is_dropped",
    "is_local",
    "domain_base_is_none",
    "collation_is_canonical",
    "is_not_null",
    "passed_by_value",
    "has_default",
    "acl_is_default",
    "options_are_default",
    "fdw_options_are_default",
    "statistics_are_default",
    "has_no_missing_value",
    "missing_value_is_null",
  ];
  const stringFields = [
    "column_name",
    "type_key",
    "type_kind",
    "identity_kind",
    "generated_kind",
    "default_kind",
    "storage_kind",
    "compression_kind",
    "alignment",
  ];
  for (const [index, expected] of expectedColumns.entries()) {
    const actual = rows[index];
    if (!actual || typeof actual !== "object") {
      throw notVerified("MIGRATION_COLUMN_CATALOG_UNAVAILABLE");
    }
    for (const field of booleanFields) {
      if (typeof actual[field] !== "boolean") {
        throw notVerified("MIGRATION_COLUMN_CATALOG_UNAVAILABLE");
      }
    }
    for (const field of stringFields) {
      if (typeof actual[field] !== "string") {
        throw notVerified("MIGRATION_COLUMN_CATALOG_UNAVAILABLE");
      }
    }
    const position = asInteger(
      actual.position,
      "MIGRATION_COLUMN_CATALOG_UNAVAILABLE"
    );
    const inheritedCount = asInteger(
      actual.inherited_count,
      "MIGRATION_COLUMN_CATALOG_UNAVAILABLE"
    );
    const typmod = asInteger(
      actual.typmod,
      "MIGRATION_COLUMN_CATALOG_UNAVAILABLE"
    );
    const dimensions = asInteger(
      actual.dimensions,
      "MIGRATION_COLUMN_CATALOG_UNAVAILABLE"
    );
    const typeLength = asInteger(
      actual.type_length,
      "MIGRATION_COLUMN_CATALOG_UNAVAILABLE"
    );
    requireCondition(
      actual.relation_is_canonical === true &&
        position === expected.position &&
        actual.column_name === expected.column_name &&
        actual.is_dropped === false &&
        inheritedCount === 0 &&
        actual.is_local === true &&
        actual.type_key === expected.type_key &&
        typmod === -1 &&
        typeLength === expected.type_length &&
        dimensions === 0 &&
        actual.passed_by_value === expected.passed_by_value &&
        actual.alignment === expected.alignment &&
        actual.type_kind === "b" &&
        actual.domain_base_is_none === true &&
        actual.identity_kind === "" &&
        actual.generated_kind === "" &&
        actual.collation_is_canonical === true &&
        actual.is_not_null === expected.is_not_null &&
        actual.has_default === expected.has_default &&
        actual.default_kind === expected.default_kind &&
        actual.acl_is_default === true &&
        actual.options_are_default === true &&
        actual.fdw_options_are_default === true &&
        actual.storage_kind === expected.storage_kind &&
        actual.compression_kind === "" &&
        actual.statistics_are_default === true &&
        actual.has_no_missing_value === true &&
        actual.missing_value_is_null === true,
      "MIGRATION_COLUMN_CATALOG_MISMATCH"
    );
  }
}

function validateMigrationExactCatalogFields(exact) {
  const booleanFields = [
    "table_is_shared",
    "table_rewrite_is_zero",
    "table_row_type_is_canonical",
    "table_is_partition",
    "table_row_security",
    "table_force_row_security",
    "table_has_rules",
    "table_has_triggers",
    "table_has_index",
    "table_has_subclass",
    "table_is_populated",
    "table_not_typed",
    "table_no_partition_bound",
    "table_has_toast",
    "table_toast_mapping_is_canonical",
    "table_tablespace_is_default",
    "table_acl_is_default",
    "sequence_access_method_is_zero",
    "sequence_is_shared",
    "sequence_rewrite_is_zero",
    "sequence_row_type_is_zero",
    "sequence_is_partition",
    "sequence_row_security",
    "sequence_force_row_security",
    "sequence_has_rules",
    "sequence_has_triggers",
    "sequence_has_index",
    "sequence_has_subclass",
    "sequence_is_populated",
    "sequence_not_typed",
    "sequence_no_partition_bound",
    "sequence_has_no_toast",
    "sequence_tablespace_is_default",
    "sequence_acl_is_default",
    "sequence_cycle",
    "index_is_shared",
    "index_rewrite_is_zero",
    "index_row_type_is_zero",
    "index_is_partition",
    "index_row_security",
    "index_force_row_security",
    "index_has_rules",
    "index_has_triggers",
    "index_has_index",
    "index_has_subclass",
    "index_is_populated",
    "index_not_typed",
    "index_no_partition_bound",
    "index_has_no_toast",
    "index_tablespace_is_default",
    "index_acl_is_default",
    "object_namespaces_are_canonical",
    "object_owner_is_consistent",
    "index_is_unique",
    "index_is_primary",
    "index_is_exclusion",
    "index_is_valid",
    "index_is_ready",
    "index_is_live",
    "index_is_clustered",
    "index_is_replica_identity",
    "index_is_immediate",
    "index_check_xmin",
    "index_nulls_not_distinct",
    "index_has_no_predicate",
    "index_has_no_expressions",
    "index_collation_is_canonical",
    "index_option_is_canonical",
    "index_operator_class_is_canonical",
    "index_column_exact",
    "index_vector_lengths_are_canonical",
    "index_relation_mapping_is_canonical",
    "primary_key_exact",
    "constraint_enforcement_is_canonical",
    "constraint_period_is_canonical",
    "constraint_mapping_is_canonical",
    "constraint_action_fields_are_canonical",
    "constraint_foreign_key_fields_are_canonical",
    "constraint_exclusion_fields_are_canonical",
    "constraint_expression_fields_are_canonical",
    "not_null_constraint_keys_exact",
    "not_null_constraint_names_exact",
    "not_null_constraints_exact",
  ];
  const stringFields = [
    "table_relkind",
    "table_persistence",
    "table_replica_identity",
    "table_access_method",
    "sequence_relkind",
    "sequence_persistence",
    "sequence_replica_identity",
    "sequence_data_type",
    "sequence_start",
    "sequence_increment",
    "sequence_minimum",
    "sequence_maximum",
    "sequence_cache",
    "index_relkind",
    "index_persistence",
    "index_replica_identity",
    "index_access_method",
  ];
  if (
    booleanFields.some((field) => typeof exact[field] !== "boolean") ||
    stringFields.some((field) => typeof exact[field] !== "string")
  ) {
    throw notVerified("MIGRATION_EXACT_CATALOG_UNAVAILABLE");
  }
}

function validateMigrationExactState(exact) {
  if (!exact || typeof exact !== "object") {
    throw notVerified("MIGRATION_EXACT_CATALOG_INVALID");
  }
  validateMigrationExactCatalogFields(exact);
  requireCondition(
    exact.table_relkind === "r" &&
      exact.table_persistence === "p" &&
      exact.table_is_shared === false &&
      exact.table_rewrite_is_zero === true &&
      exact.table_row_type_is_canonical === true &&
      exact.table_is_partition === false &&
      exact.table_row_security === false &&
      exact.table_force_row_security === false &&
      exact.table_replica_identity === "d" &&
      asNonNegativeInteger(
        exact.table_check_count,
        "MIGRATION_TABLE_PROPERTY_UNAVAILABLE"
      ) === 0 &&
      exact.table_has_rules === false &&
      exact.table_has_triggers === false &&
      asNonNegativeInteger(
        exact.table_attribute_count,
        "MIGRATION_TABLE_PROPERTY_UNAVAILABLE"
      ) === 3 &&
      exact.table_has_index === true &&
      exact.table_has_subclass === false &&
      exact.table_is_populated === true &&
      exact.table_not_typed === true &&
      exact.table_no_partition_bound === true &&
      exact.table_has_toast === true &&
      exact.table_toast_mapping_is_canonical === true &&
      exact.table_tablespace_is_default === true &&
      exact.table_acl_is_default === true &&
      exact.object_namespaces_are_canonical === true &&
      exact.object_owner_is_consistent === true &&
      asNonNegativeInteger(
        exact.table_option_count,
        "MIGRATION_TABLE_PROPERTY_UNAVAILABLE"
      ) === 0 &&
      exact.table_access_method === "heap",
    "MIGRATION_TABLE_PROPERTY_MISMATCH"
  );
  requireCondition(
    asNonNegativeInteger(
      exact.constraint_count,
      "MIGRATION_CONSTRAINT_COUNT_UNAVAILABLE"
    ) === 3 &&
      asNonNegativeInteger(
        exact.primary_constraint_count,
        "MIGRATION_CONSTRAINT_COUNT_UNAVAILABLE"
      ) === 1 &&
      asNonNegativeInteger(
        exact.not_null_constraint_count,
        "MIGRATION_CONSTRAINT_COUNT_UNAVAILABLE"
      ) === 2 &&
      asNonNegativeInteger(
        exact.unexpected_constraint_count,
        "MIGRATION_CONSTRAINT_COUNT_UNAVAILABLE"
      ) === 0 &&
      exact.primary_key_exact === true &&
      exact.constraint_enforcement_is_canonical === true &&
      exact.constraint_period_is_canonical === true &&
      exact.constraint_mapping_is_canonical === true &&
      exact.constraint_action_fields_are_canonical === true &&
      exact.constraint_foreign_key_fields_are_canonical === true &&
      exact.constraint_exclusion_fields_are_canonical === true &&
      exact.constraint_expression_fields_are_canonical === true &&
      exact.not_null_constraint_keys_exact === true &&
      exact.not_null_constraint_names_exact === true &&
      exact.not_null_constraints_exact === true,
    "MIGRATION_CONSTRAINT_SHAPE_MISMATCH"
  );
  requireCondition(
    asNonNegativeInteger(
      exact.trigger_count,
      "MIGRATION_TRIGGER_COUNT_UNAVAILABLE"
    ) === 0,
    "MIGRATION_TRIGGER_PRESENT"
  );
  requireCondition(
    asNonNegativeInteger(
      exact.rule_count,
      "MIGRATION_RULE_COUNT_UNAVAILABLE"
    ) === 0,
    "MIGRATION_RULE_PRESENT"
  );
  requireCondition(
    asNonNegativeInteger(
      exact.policy_count,
      "MIGRATION_POLICY_COUNT_UNAVAILABLE"
    ) === 0,
    "MIGRATION_POLICY_PRESENT"
  );
  validateMigrationSequenceCurrentState(exact);
  requireCondition(
    exact.sequence_relkind === "S" &&
      exact.sequence_persistence === "p" &&
      exact.sequence_access_method_is_zero === true &&
      exact.sequence_is_shared === false &&
      exact.sequence_rewrite_is_zero === true &&
      exact.sequence_row_type_is_zero === true &&
      exact.sequence_is_partition === false &&
      exact.sequence_row_security === false &&
      exact.sequence_force_row_security === false &&
      exact.sequence_replica_identity === "n" &&
      asNonNegativeInteger(
        exact.sequence_check_count,
        "MIGRATION_SEQUENCE_PROPERTY_UNAVAILABLE"
      ) === 0 &&
      exact.sequence_has_rules === false &&
      exact.sequence_has_triggers === false &&
      asNonNegativeInteger(
        exact.sequence_attribute_count,
        "MIGRATION_SEQUENCE_PROPERTY_UNAVAILABLE"
      ) === 3 &&
      exact.sequence_has_index === false &&
      exact.sequence_has_subclass === false &&
      exact.sequence_is_populated === true &&
      exact.sequence_not_typed === true &&
      exact.sequence_no_partition_bound === true &&
      exact.sequence_has_no_toast === true &&
      exact.sequence_tablespace_is_default === true &&
      exact.sequence_acl_is_default === true &&
      asNonNegativeInteger(
        exact.sequence_option_count,
        "MIGRATION_SEQUENCE_PROPERTY_UNAVAILABLE"
      ) === 0 &&
      exact.sequence_data_type === "integer" &&
      String(exact.sequence_start) === "1" &&
      String(exact.sequence_increment) === "1" &&
      String(exact.sequence_minimum) === "1" &&
      String(exact.sequence_maximum) === "2147483647" &&
      String(exact.sequence_cache) === "1" &&
      exact.sequence_cycle === false &&
      asNonNegativeInteger(
        exact.sequence_owned_by_count,
        "MIGRATION_SEQUENCE_OWNERSHIP_UNAVAILABLE"
      ) === 1 &&
      asNonNegativeInteger(
        exact.default_sequence_dependency_count,
        "MIGRATION_SEQUENCE_DEFAULT_UNAVAILABLE"
      ) === 1,
    "MIGRATION_SEQUENCE_SHAPE_MISMATCH"
  );
  requireCondition(
    exact.index_relkind === "i" &&
      exact.index_persistence === "p" &&
      exact.index_is_shared === false &&
      exact.index_rewrite_is_zero === true &&
      exact.index_row_type_is_zero === true &&
      asNonNegativeInteger(
        exact.index_relation_attribute_count,
        "MIGRATION_INDEX_PROPERTY_UNAVAILABLE"
      ) === 1 &&
      exact.index_is_partition === false &&
      exact.index_row_security === false &&
      exact.index_force_row_security === false &&
      exact.index_replica_identity === "n" &&
      asNonNegativeInteger(
        exact.index_check_count,
        "MIGRATION_INDEX_PROPERTY_UNAVAILABLE"
      ) === 0 &&
      exact.index_has_rules === false &&
      exact.index_has_triggers === false &&
      exact.index_has_index === false &&
      exact.index_has_subclass === false &&
      exact.index_is_populated === true &&
      exact.index_not_typed === true &&
      exact.index_no_partition_bound === true &&
      exact.index_has_no_toast === true &&
      exact.index_tablespace_is_default === true &&
      exact.index_acl_is_default === true &&
      asNonNegativeInteger(
        exact.index_option_count,
        "MIGRATION_INDEX_PROPERTY_UNAVAILABLE"
      ) === 0 &&
      exact.index_access_method === "btree" &&
      exact.index_is_unique === true &&
      exact.index_is_primary === true &&
      exact.index_is_exclusion === false &&
      exact.index_is_valid === true &&
      exact.index_is_ready === true &&
      exact.index_is_live === true &&
      exact.index_is_clustered === false &&
      exact.index_is_replica_identity === false &&
      exact.index_is_immediate === true &&
      exact.index_check_xmin === false &&
      exact.index_nulls_not_distinct === false &&
      exact.index_has_no_predicate === true &&
      exact.index_has_no_expressions === true &&
      exact.index_collation_is_canonical === true &&
      exact.index_option_is_canonical === true &&
      exact.index_operator_class_is_canonical === true &&
      asNonNegativeInteger(
        exact.index_key_count,
        "MIGRATION_INDEX_PROPERTY_UNAVAILABLE"
      ) === 1 &&
      asNonNegativeInteger(
      exact.index_attribute_count,
        "MIGRATION_INDEX_PROPERTY_UNAVAILABLE"
      ) === 1 &&
      exact.index_column_exact === true &&
      exact.index_vector_lengths_are_canonical === true &&
      exact.index_relation_mapping_is_canonical === true,
    "MIGRATION_INDEX_SHAPE_MISMATCH"
  );
}

function validatedCatalogSignatures(value) {
  if (!Array.isArray(value)) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }
  const signatures = value.map((entry) => String(entry));
  if (
    signatures.some((entry) => !/^\d+:\d+:\d+$/.test(entry)) ||
    sortedUnique(signatures).length !== signatures.length
  ) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }
  return signatures;
}

function validateExtensionClassification(row) {
  const unclassifiedCount = asNonNegativeInteger(
    row?.extension_unclassified_count,
    "USER_OBJECT_CATALOG_UNCLASSIFIED"
  );
  const ambiguousCount = asNonNegativeInteger(
    row?.extension_ambiguous_count,
    "USER_OBJECT_CATALOG_UNCLASSIFIED"
  );
  if (unclassifiedCount !== 0 || ambiguousCount !== 0) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }
  const evidence = row?.extension_classification_evidence;
  if (!Array.isArray(evidence)) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }
  const candidates = validatedCatalogSignatures(
    row?.extension_candidate_signature
  );
  const expectedManaged = validatedCatalogSignatures(
    row?.extension_managed_signature
  );
  const expectedResidual = validatedCatalogSignatures(
    row?.extension_residual_signature
  );
  const candidateSet = new Set(candidates);
  const evidenceBySignature = new Map();
  const evidenceSignatures = new Set();

  for (const entry of evidence) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.objectSignature !== "string" ||
      !/^\d+:\d+:\d+$/.test(entry.objectSignature) ||
      typeof entry.evidenceSignature !== "string" ||
      !/^[a-z_]+:[a-z0-9:_-]+$/.test(entry.evidenceSignature) ||
      typeof entry.evidenceKind !== "string" ||
      typeof entry.dependencyType !== "string" ||
      typeof entry.dependentClass !== "string" ||
      typeof entry.referencedClass !== "string" ||
      typeof entry.referencedIsDirectExtensionMember !== "boolean" ||
      typeof entry.triggerConstraintMatches !== "boolean" ||
      (entry.ruleName !== null && typeof entry.ruleName !== "string") ||
      (entry.relationKind !== null && typeof entry.relationKind !== "string") ||
      (entry.constraintType !== null &&
        typeof entry.constraintType !== "string")
    ) {
      throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
    }
    if (evidenceSignatures.has(entry.evidenceSignature)) {
      throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
    }
    evidenceSignatures.add(entry.evidenceSignature);
    const supports = evidenceBySignature.get(entry.objectSignature) || [];
    supports.push(classifyExtensionCatalogObject(entry));
    evidenceBySignature.set(entry.objectSignature, supports);
  }

  if (
    evidenceBySignature.size !== candidateSet.size ||
    [...evidenceBySignature.keys()].some(
      (signature) => !candidateSet.has(signature)
    ) ||
    candidates.some((signature) => !evidenceBySignature.has(signature))
  ) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }

  const computedManaged = [];
  const computedResidual = [];
  for (const signature of candidates) {
    const supports = evidenceBySignature.get(signature);
    if (!Array.isArray(supports) || supports.length === 0) {
      throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
    }
    const supportSet = new Set(supports);
    if (
      supportSet.has("unknown_evidence") ||
      (supportSet.has("managed_support") &&
        supportSet.has("residual_support")) ||
      (!supportSet.has("managed_support") &&
        !supportSet.has("residual_support"))
    ) {
      throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
    }
    if (supportSet.has("managed_support")) {
      computedManaged.push(signature);
    } else if (supportSet.has("residual_support")) {
      computedResidual.push(signature);
    } else {
      throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
    }
  }

  const managedSet = new Set(expectedManaged);
  const residualSet = new Set(expectedResidual);
  const total = asNonNegativeInteger(
    row?.total_count,
    "USER_OBJECT_CATALOG_UNCLASSIFIED"
  );
  const objectSignatures = Array.isArray(row?.object_signature)
    ? row.object_signature.map((entry) => String(entry))
    : null;
  const residualFromObjects = objectSignatures?.map((entry) => {
    const match = /^(?:schema|relation|routine|type|trigger|rule|policy|constraint|other):(\d+:\d+:\d+)$/.exec(
      entry
    );
    if (!match) throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
    return match[1];
  });

  if (
    candidates.length !== expectedManaged.length + expectedResidual.length ||
    expectedManaged.some((signature) => residualSet.has(signature)) ||
    expectedResidual.some((signature) => managedSet.has(signature)) ||
    JSON.stringify(sortedUnique(computedManaged)) !==
      JSON.stringify(sortedUnique(expectedManaged)) ||
    JSON.stringify(sortedUnique(computedResidual)) !==
      JSON.stringify(sortedUnique(expectedResidual)) ||
    expectedResidual.length !== total ||
    !residualFromObjects ||
    residualFromObjects.length !== total ||
    sortedUnique(residualFromObjects).length !== total ||
    JSON.stringify(sortedUnique(residualFromObjects)) !==
      JSON.stringify(sortedUnique(expectedResidual))
  ) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }
}

function summarizeUserDefinedObjects(row) {
  if (!row || typeof row !== "object") {
    throw notVerified("USER_OBJECT_CATALOG_INVALID");
  }
  validateExtensionClassification(row);
  const counts = {};
  let classifiedTotal = 0;
  for (const [reportKey, catalogKey] of USER_OBJECT_COUNT_FIELDS) {
    const value = asNonNegativeInteger(
      row[catalogKey],
      "USER_OBJECT_CATALOG_INVALID"
    );
    counts[reportKey] = value;
    classifiedTotal += value;
  }
  const total = asNonNegativeInteger(
    row.total_count,
    "USER_OBJECT_CATALOG_INVALID"
  );
  const estimatedDataRows = asNonNegativeInteger(
    row.estimated_data_rows,
    "USER_OBJECT_CATALOG_INVALID"
  );
  const signature = Array.isArray(row.object_signature)
    ? row.object_signature.map((entry) => String(entry))
    : null;
  if (
    classifiedTotal !== total ||
    !signature ||
    signature.length !== total ||
    sortedUnique(signature).length !== total
  ) {
    throw notVerified("USER_OBJECT_CATALOG_UNCLASSIFIED");
  }
  return {
    total,
    estimatedDataRows,
    counts,
    signature,
  };
}

function publicUserObjectCounts(summary) {
  return {
    total: summary.total,
    estimatedDataRows: summary.estimatedDataRows,
    ...summary.counts,
  };
}

function validateInitialDatabaseState(
  specification,
  evidence,
  userObjectSummary = summarizeUserDefinedObjects(evidence.userDefinedObjects)
) {
  const catalog = evidence.migrationCatalog;
  const schemaExists = catalog.schema_exists;
  const tableExists = catalog.table_exists;
  if (typeof schemaExists !== "boolean" || typeof tableExists !== "boolean") {
    throw notVerified("MIGRATION_CATALOG_STATE_INVALID");
  }
  const migrationObjects = sortedUnique(
    Array.isArray(catalog.objects) ? catalog.objects : []
  );

  let initialState = "pristine";
  if (!schemaExists) {
    requireCondition(!tableExists, "MIGRATION_SCHEMA_PARTIAL");
    requireCondition(migrationObjects.length === 0, "MIGRATION_SCHEMA_PARTIAL");
  } else {
    requireCondition(tableExists, "MIGRATION_SCHEMA_PARTIAL");
    requireCondition(
      JSON.stringify(migrationObjects) ===
        JSON.stringify([...EXPECTED_MIGRATION_OBJECTS].sort()),
      "MIGRATION_SCHEMA_PARTIAL"
    );
    validateMigrationTableShape(evidence);
    validateMigrationColumnExactState(evidence.migrationColumnExact);
    validateMigrationExactState(evidence.migrationExact);
    initialState = "empty_migration_table";
  }

  const history = evidence.migrationHistory;
  const historyClassification = classifyMigrationHistory(specification, history);
  if (historyClassification.duplicates > 0) {
    throw verifiedFailure("MIGRATION_HISTORY_DUPLICATE");
  }
  if (historyClassification.unknown > 0) {
    throw verifiedFailure("MIGRATION_HISTORY_UNKNOWN");
  }
  if (history.length > 0) {
    throw verifiedFailure("MIGRATION_HISTORY_NOT_EMPTY");
  }

  if (userObjectSummary.estimatedDataRows > 0) {
    throw verifiedFailure("USER_DEFINED_DATA_PRESENT");
  }
  if (userObjectSummary.total > 0) {
    throw verifiedFailure("USER_DEFINED_OBJECT_PRESENT");
  }

  return {
    initialState,
    migrationHistory: {
      status: "pass",
      expected: specification.migrations.length,
      applied: 0,
      pending: specification.migrations.length,
      pendingTags: specification.migrations.map((entry) => entry.tag),
      duplicates: 0,
      unknown: 0,
    },
    applicationTables: userObjectSummary.counts.relations,
    applicationFunctions: userObjectSummary.counts.routines,
    applicationData: userObjectSummary.estimatedDataRows,
    partialSchema: "none",
  };
}

function comparableEvidence(evidence) {
  return JSON.stringify({
    serverVersion: evidence.serverVersion,
    identity: evidence.identity,
    migrationCatalog: evidence.migrationCatalog,
    migrationColumns: evidence.migrationColumns,
    migrationColumnExact: evidence.migrationColumnExact,
    migrationPrimaryKey: evidence.migrationPrimaryKey,
    migrationHistory: evidence.migrationHistory,
    migrationExact: evidence.migrationExact,
    userDefinedObjects: evidence.userDefinedObjects,
    extensionInventory: evidence.extensionInventory,
  });
}

function publicMigrationSequenceState(evidence) {
  const tableExists = evidence?.migrationCatalog?.table_exists;
  if (typeof tableExists !== "boolean") {
    throw notVerified("MIGRATION_CATALOG_STATE_INVALID");
  }
  if (!tableExists) return "not_applicable";
  validateMigrationSequenceCurrentState(evidence.migrationExact);
  return "unused";
}

function unverifiedUserObjectCounts() {
  return {
    total: "not_verified",
    estimatedDataRows: "not_verified",
    schemas: "not_verified",
    relations: "not_verified",
    routines: "not_verified",
    types: "not_verified",
    triggers: "not_verified",
    rules: "not_verified",
    policies: "not_verified",
    constraints: "not_verified",
    other: "not_verified",
  };
}

export function createPreflightBaseReport() {
  return {
    environment: "staging",
    postgresqlVersion: {
      direct: "not_verified",
      pooled: "not_verified",
      directAfter: "not_verified",
      pooledAfter: "not_verified",
    },
    directConnection: "not_verified",
    pooledConnection: "not_verified",
    directPooledIdentity: "not_verified",
    expectedIdentity: "not_verified",
    extensionInventory: "not_verified",
    initialState: "not_verified",
    migrationHistory: {
      status: "not_verified",
      expected: 7,
      applied: "not_verified",
      pending: "not_verified",
      pendingTags: [],
      duplicates: "not_verified",
      unknown: "not_verified",
    },
    applicationTables: "not_verified",
    applicationFunctions: "not_verified",
    applicationData: "not_verified",
    userDefinedObjects: {
      direct: unverifiedUserObjectCounts(),
      pooled: unverifiedUserObjectCounts(),
      directAfter: unverifiedUserObjectCounts(),
      pooledAfter: unverifiedUserObjectCounts(),
    },
    migrationSequenceState: {
      direct: "not_verified",
      pooled: "not_verified",
      directAfter: "not_verified",
      pooledAfter: "not_verified",
    },
    partialSchema: "not_verified",
    readOnlyInvariant: "not_verified",
    cleanup: "not_verified",
    secretRedaction: "pass",
    exitCode: 3,
  };
}

export async function verifyStagingDatabasePreflight({
  environment,
  repositoryRoot,
  adapter,
  allowLoopback = false,
  onQuery = undefined,
  signal = undefined,
}) {
  const report = createPreflightBaseReport();
  let directConnection;
  let pooledConnection;
  try {
    const safety = validateSafetyGate(environment, {
      allowLoopback,
      confirmationKey: PREFLIGHT_CONFIRMATION_KEY,
      confirmationErrorCode: "STAGING_PREFLIGHT_CONFIRMATION_REQUIRED",
    });
    throwIfPreflightAborted(signal);
    const expectedExtensions = parseExpectedStagingExtensions(environment);
    report.expectedIdentity = "match";
    throwIfPreflightAborted(signal);
    const specification = await loadRepositorySpecification(repositoryRoot);
    throwIfPreflightAborted(signal);

    directConnection = await openReadOnlyConnection(
      adapter,
      "direct",
      safety.directUrl,
      onQuery,
      { signal }
    );
    report.directConnection = "pass";
    pooledConnection = await openReadOnlyConnection(
      adapter,
      "pooled",
      safety.pooledUrl,
      onQuery,
      { signal }
    );
    report.pooledConnection = "pass";

    const directBefore = await collectPreflightEvidence(
      directConnection,
      onQuery,
      { signal }
    );
    const pooledBefore = await collectPreflightEvidence(
      pooledConnection,
      onQuery,
      { signal }
    );
    throwIfPreflightAborted(signal);
    requireExtensionInventoryMatch(expectedExtensions, [
      directBefore.extensionInventory,
      pooledBefore.extensionInventory,
    ]);
    const directVersion = validatePostgresqlVersion(directBefore.serverVersion);
    const pooledVersion = validatePostgresqlVersion(pooledBefore.serverVersion);
    report.postgresqlVersion.direct = "supported";
    report.postgresqlVersion.pooled = "supported";
    requireCondition(
      directVersion === pooledVersion,
      "POSTGRESQL_VERSION_MISMATCH"
    );
    requireIdentityMatch(directBefore, pooledBefore);
    report.directPooledIdentity = "match";

    const directUserObjects = summarizeUserDefinedObjects(
      directBefore.userDefinedObjects
    );
    const pooledUserObjects = summarizeUserDefinedObjects(
      pooledBefore.userDefinedObjects
    );
    report.userDefinedObjects.direct = publicUserObjectCounts(directUserObjects);
    report.userDefinedObjects.pooled = publicUserObjectCounts(pooledUserObjects);
    report.migrationSequenceState.direct = publicMigrationSequenceState(
      directBefore
    );
    report.migrationSequenceState.pooled = publicMigrationSequenceState(
      pooledBefore
    );
    report.applicationTables = directUserObjects.counts.relations;
    report.applicationFunctions = directUserObjects.counts.routines;
    report.applicationData = directUserObjects.estimatedDataRows;

    const directState = validateInitialDatabaseState(
      specification,
      directBefore,
      directUserObjects
    );
    validateInitialDatabaseState(
      specification,
      pooledBefore,
      pooledUserObjects
    );
    requireCondition(
      comparableEvidence(directBefore) === comparableEvidence(pooledBefore),
      "DIRECT_POOLED_STATE_MISMATCH"
    );
    throwIfPreflightAborted(signal);

    const directAfter = await collectPreflightEvidence(
      directConnection,
      onQuery,
      { signal }
    );
    const pooledAfter = await collectPreflightEvidence(
      pooledConnection,
      onQuery,
      { signal }
    );
    throwIfPreflightAborted(signal);
    requireExtensionInventoryMatch(expectedExtensions, [
      directBefore.extensionInventory,
      pooledBefore.extensionInventory,
      directAfter.extensionInventory,
      pooledAfter.extensionInventory,
    ]);
    report.extensionInventory = "match";
    const directAfterVersion = validatePostgresqlVersion(
      directAfter.serverVersion
    );
    const pooledAfterVersion = validatePostgresqlVersion(
      pooledAfter.serverVersion
    );
    report.postgresqlVersion.directAfter = "supported";
    report.postgresqlVersion.pooledAfter = "supported";
    requireCondition(
      directVersion === directAfterVersion &&
        pooledVersion === pooledAfterVersion &&
        directAfterVersion === pooledAfterVersion,
      "POSTGRESQL_VERSION_CHANGED"
    );
    requireIdentityMatch(directAfter, pooledAfter);
    report.directPooledIdentity = "match";
    throwIfPreflightAborted(signal);
    const directAfterUserObjects = summarizeUserDefinedObjects(
      directAfter.userDefinedObjects
    );
    const pooledAfterUserObjects = summarizeUserDefinedObjects(
      pooledAfter.userDefinedObjects
    );
    report.userDefinedObjects.directAfter = publicUserObjectCounts(
      directAfterUserObjects
    );
    report.userDefinedObjects.pooledAfter = publicUserObjectCounts(
      pooledAfterUserObjects
    );
    report.migrationSequenceState.directAfter = publicMigrationSequenceState(
      directAfter
    );
    report.migrationSequenceState.pooledAfter = publicMigrationSequenceState(
      pooledAfter
    );
    requireCondition(
      comparableEvidence(directBefore) === comparableEvidence(directAfter) &&
        comparableEvidence(pooledBefore) === comparableEvidence(pooledAfter),
      "READ_ONLY_INVARIANT_MISMATCH"
    );

    Object.assign(report, directState, {
      readOnlyInvariant: "pass",
      exitCode: 0,
    });
  } catch (error) {
    const issue = safeIssueFrom(error, "PREFLIGHT_UNAVAILABLE", 3);
    report.exitCode = issue.exitCode;
    report.failure = {
      checkId: issue.code,
      status: issue.exitCode === 3 ? "not_verified" : issue.status,
    };
    if (
      issue.code === "EXPECTED_STAGING_IDENTITY_MISMATCH" ||
      issue.code === "EXPECTED_STAGING_IDENTITY_REQUIRED"
    ) {
      report.expectedIdentity =
        issue.exitCode === 3 ? "not_verified" : "fail";
    }
    if (issue.code === "DIRECT_CONNECTION_UNAVAILABLE") {
      report.directConnection = "fail";
    }
    if (issue.code === "POOLED_CONNECTION_UNAVAILABLE") {
      report.pooledConnection = "fail";
    }
    if (issue.code === "LOGICAL_DATABASE_IDENTITY_MISMATCH") {
      report.directPooledIdentity = "fail";
    }
  } finally {
    const cleanupIssues = [];
    const cleanupConnections = [pooledConnection, directConnection].filter(
      Boolean
    );
    if (cleanupConnections.length > 0) {
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), 5_000);
      try {
        const cleanupResults = await Promise.allSettled(
          cleanupConnections.map((connection) =>
            closeReadOnlyConnection(connection, onQuery, {
              signal: cleanupController.signal,
            })
          )
        );
        if (cleanupResults.some((result) => result.status === "rejected")) {
          cleanupIssues.push("CONNECTION_CLEANUP_UNVERIFIED");
        }
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
    if (cleanupIssues.length > 0) {
      report.cleanup = "not_verified";
      report.exitCode = 3;
      report.failure = {
        checkId: "CONNECTION_CLEANUP_UNVERIFIED",
        status: "not_verified",
      };
    } else if (directConnection && pooledConnection) {
      report.cleanup = "pass";
    }
  }
  return report;
}

export const PREFLIGHT_SQL_FOR_TESTS = SQL;
export const PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS =
  EXTENSION_CLASSIFICATION_SQL;
export {
  classifyMigrationHistory,
  collectPreflightEvidence,
  validateMigrationSequenceCurrentState,
  validateInitialDatabaseState,
};
