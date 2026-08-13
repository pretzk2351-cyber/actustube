import { realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPreflightBaseReport,
  verifyStagingDatabasePreflight,
} from "./staging-database-preflight/core.mjs";
import { createNeonPostflightAdapter } from "./staging-database-postflight/neon-adapter.mjs";
import { EXPECTED_MIGRATION_TAGS } from "./staging-database-postflight/manifest.mjs";

export const PARENT_ENVIRONMENT_NOTICE =
  "このscriptは親shellの環境変数を削除できません。呼出し元processからstaging DB用環境変数を削除し、不要ならterminalを閉じてください。";

const PUBLIC_REPORT_KEYS = Object.freeze([
  "environment",
  "postgresqlVersion",
  "directConnection",
  "pooledConnection",
  "connectionAuthority",
  "directPooledIdentity",
  "databaseRoleIdentity",
  "expectedIdentity",
  "extensionInventory",
  "initialState",
  "migrationCatalog",
  "migrationHistory",
  "applicationTables",
  "applicationFunctions",
  "applicationData",
  "userDefinedObjects",
  "migrationSequenceState",
  "partialSchema",
  "readOnlyInvariant",
  "beforeAfterComparison",
  "cleanup",
  "secretRedaction",
  "overallStatus",
  "exitCode",
]);
const VERSION_KEYS = Object.freeze([
  "direct",
  "pooled",
  "directAfter",
  "pooledAfter",
]);
const MIGRATION_HISTORY_KEYS = Object.freeze([
  "status",
  "expected",
  "applied",
  "pending",
  "pendingTags",
  "duplicates",
  "unknown",
]);
const USER_OBJECT_COUNT_KEYS = Object.freeze([
  "total",
  "estimatedDataRows",
  "schemas",
  "relations",
  "routines",
  "types",
  "triggers",
  "rules",
  "policies",
  "constraints",
  "other",
]);
const PUBLIC_CHECK_IDS = new Set([
  "APPLICATION_SEQUENCE_MISMATCH",
  "CATALOG_VALUE_INVALID",
  "CHECK_CONSTRAINT_MISMATCH",
  "COLUMN_DEFAULT_MISMATCH",
  "COLUMN_GENERATION_MISMATCH",
  "COLUMN_LEVEL_PRIVILEGE_PRESENT",
  "COLUMN_NULLABILITY_MISMATCH",
  "COLUMN_SET_MISMATCH",
  "COLUMN_TYPE_MISMATCH",
  "CONNECTION_CLEANUP_TIMEOUT",
  "CONNECTION_CLEANUP_UNVERIFIED",
  "CONSTRAINT_COLUMN_MISMATCH",
  "CONSTRAINT_SET_MISMATCH",
  "CONSTRAINT_STATE_MISMATCH",
  "DATABASE_OPERATION_ABORTED",
  "DATABASE_QUERY_TIMEOUT",
  "DATABASE_QUERY_UNAVAILABLE",
  "DATA_COUNTS_CHANGED",
  "DATA_COUNT_UNAVAILABLE",
  "DEFAULT_PRIVILEGE_SET_MISMATCH",
  "DEFAULT_PRIVILEGE_UNEXPECTED_GRANTEE",
  "DEFAULT_PUBLIC_PRIVILEGE_PRESENT",
  "DIRECT_CONNECTION_UNAVAILABLE",
  "DIRECT_DATABASE_OWNER_MISMATCH",
  "DIRECT_ENDPOINT_KIND_REJECTED",
  "DIRECT_FORBIDDEN_TARGET",
  "DIRECT_LOOPBACK_REJECTED",
  "DIRECT_POOLED_PROVIDER_IDENTITY_MISMATCH",
  "DIRECT_POOLED_SCHEMA_MISMATCH",
  "DIRECT_POOLED_STATE_MISMATCH",
  "DIRECT_POOLED_TARGET_MISMATCH",
  "DIRECT_ROLE_IDENTITY_MISMATCH",
  "DIRECT_ROLE_IDENTITY_UNAVAILABLE",
  "DIRECT_ROLE_UNAVAILABLE",
  "DIRECT_STAGING_MARKER_REQUIRED",
  "DIRECT_TARGET_UNCLASSIFIED",
  "DIRECT_URL_INVALID",
  "DIRECT_URL_FRAGMENT_REJECTED",
  "DIRECT_URL_QUERY_REJECTED",
  "DIRECT_URL_PROTOCOL_REJECTED",
  "DIRECT_URL_REQUIRED",
  "EMPTY_SQL_REJECTED",
  "ENUM_SET_MISMATCH",
  "ENUM_SIGNATURE_MISMATCH",
  "EXPECTED_STAGING_IDENTITY_MISMATCH",
  "EXPECTED_STAGING_IDENTITY_REQUIRED",
  "FOREIGN_KEY_MISMATCH",
  "FUNCTION_ACL_UNEXPECTED_GRANTEE",
  "FUNCTION_BEHAVIOR_MISMATCH",
  "FUNCTION_GRANT_OPTION_PRESENT",
  "FUNCTION_OWNER_MISMATCH",
  "FUNCTION_PUBLIC_EXECUTE_PRESENT",
  "FUNCTION_RETURN_MISMATCH",
  "FUNCTION_SEARCH_PATH_MISMATCH",
  "FUNCTION_SECURITY_MODE_MISMATCH",
  "FUNCTION_SET_MISMATCH",
  "FUNCTION_SIGNATURE_MISMATCH",
  "FUNCTION_SOURCE_MANIFEST_INVALID",
  "FUNCTION_SOURCE_MISMATCH",
  "INDEX_PREDICATE_MISMATCH",
  "INDEX_SET_MISMATCH",
  "INDEX_SIGNATURE_MISMATCH",
  "LOGICAL_DATABASE_IDENTITY_MISMATCH",
  "LOGICAL_DATABASE_IDENTITY_UNAVAILABLE",
  "MIGRATION_CATALOG_STATE_INVALID",
  "MIGRATION_CATALOG_UNAVAILABLE",
  "MIGRATION_COLUMN_CATALOG_MISMATCH",
  "MIGRATION_COLUMN_CATALOG_UNAVAILABLE",
  "MIGRATION_CONSTRAINT_COUNT_UNAVAILABLE",
  "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
  "MIGRATION_DIALECT_MISMATCH",
  "MIGRATION_EXACT_CATALOG_INVALID",
  "MIGRATION_EXACT_CATALOG_UNAVAILABLE",
  "MIGRATION_FILE_SET_MISMATCH",
  "MIGRATION_HISTORY_COLUMN_COUNT_MISMATCH",
  "MIGRATION_HISTORY_COLUMN_SIGNATURE_MISMATCH",
  "MIGRATION_HISTORY_COUNT_MISMATCH",
  "MIGRATION_HISTORY_DUPLICATE",
  "MIGRATION_HISTORY_HASH_MISMATCH",
  "MIGRATION_HISTORY_ID_MISMATCH",
  "MIGRATION_HISTORY_NOT_EMPTY",
  "MIGRATION_HISTORY_ORDER_MISMATCH",
  "MIGRATION_HISTORY_PENDING",
  "MIGRATION_HISTORY_PRIMARY_KEY_MISMATCH",
  "MIGRATION_HISTORY_UNKNOWN",
  "MIGRATION_INDEX_PROPERTY_UNAVAILABLE",
  "MIGRATION_INDEX_SHAPE_MISMATCH",
  "MIGRATION_JOURNAL_COUNT_MISMATCH",
  "MIGRATION_JOURNAL_ENTRY_INVALID",
  "MIGRATION_JOURNAL_INDEX_MISMATCH",
  "MIGRATION_JOURNAL_ORDER_MISMATCH",
  "MIGRATION_JOURNAL_VERSION_MISMATCH",
  "MIGRATION_OWNER_MISMATCH",
  "MIGRATION_POLICY_COUNT_UNAVAILABLE",
  "MIGRATION_POLICY_PRESENT",
  "MIGRATION_RULE_COUNT_UNAVAILABLE",
  "MIGRATION_RULE_PRESENT",
  "MIGRATION_SCHEMA_PARTIAL",
  "MIGRATION_SEQUENCE_DEFAULT_UNAVAILABLE",
  "MIGRATION_SEQUENCE_MISMATCH",
  "MIGRATION_SEQUENCE_OWNERSHIP_UNAVAILABLE",
  "MIGRATION_SEQUENCE_PROPERTY_UNAVAILABLE",
  "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
  "MIGRATION_SEQUENCE_STATE_MISMATCH",
  "MIGRATION_SEQUENCE_STATE_UNAVAILABLE",
  "MIGRATION_TABLE_PROPERTY_MISMATCH",
  "MIGRATION_TABLE_PROPERTY_UNAVAILABLE",
  "MIGRATION_TRIGGER_COUNT_UNAVAILABLE",
  "MIGRATION_TRIGGER_PRESENT",
  "NON_READ_ONLY_SQL_REJECTED",
  "PARAMETERIZED_QUERY_SMOKE_MISMATCH",
  "POOLED_CONNECTION_UNAVAILABLE",
  "POOLED_ENDPOINT_KIND_REJECTED",
  "POOLED_FORBIDDEN_TARGET",
  "POOLED_LOOPBACK_REJECTED",
  "POOLED_ROLE_IDENTITY_MISMATCH",
  "POOLED_ROLE_IDENTITY_UNAVAILABLE",
  "POOLED_ROLE_UNAVAILABLE",
  "POOLED_STAGING_MARKER_REQUIRED",
  "POOLED_TARGET_UNCLASSIFIED",
  "POOLED_URL_INVALID",
  "POOLED_URL_FRAGMENT_REJECTED",
  "POOLED_URL_QUERY_REJECTED",
  "POOLED_URL_PROTOCOL_REJECTED",
  "POOLED_URL_REQUIRED",
  "POSTGRESQL_VERSION_CHANGED",
  "POSTGRESQL_VERSION_MISMATCH",
  "POSTGRESQL_VERSION_UNAVAILABLE",
  "POSTGRESQL_VERSION_UNSUPPORTED",
  "PREFLIGHT_FORMATTER_FAILURE",
  "PREFLIGHT_OUTPUT_FAILURE",
  "PREFLIGHT_PUBLIC_REPORT_INVALID",
  "PREFLIGHT_SNAPSHOT_BOUNDARY_INVALID",
  "PREFLIGHT_TERMINAL_BARRIER_FAILURE",
  "PREFLIGHT_TOP_LEVEL_FAILURE",
  "PREFLIGHT_UNAVAILABLE",
  "READ_ONLY_INVARIANT_MISMATCH",
  "REPOSITORY_MIGRATION_METADATA_INVALID",
  "RUNTIME_DATABASE_CREATE_PRESENT",
  "RUNTIME_FUNCTION_EXECUTE_MISSING",
  "RUNTIME_MIGRATION_HISTORY_PRIVILEGE_MISMATCH",
  "RUNTIME_OWNER_MEMBERSHIP_PRESENT",
  "RUNTIME_ROLE_ATTRIBUTE_EXCESS",
  "RUNTIME_ROLE_IS_OWNER",
  "RUNTIME_ROLE_UNAVAILABLE",
  "RUNTIME_SCHEMA_PRIVILEGE_MISMATCH",
  "RUNTIME_SEARCH_PATH_MISMATCH",
  "RUNTIME_SEQUENCE_ACL_MISMATCH",
  "RUNTIME_SEQUENCE_PRIVILEGE_EXCESS",
  "RUNTIME_TABLE_PRIVILEGE_EXCESS",
  "RUNTIME_TABLE_PRIVILEGE_MISSING",
  "RUNTIME_TYPE_PRIVILEGE_MISMATCH",
  "SCHEMA_CHANGED_DURING_VERIFICATION",
  "SCHEMA_OWNER_OR_ACL_MISMATCH",
  "SCHEMA_SNAPSHOT_INVALID",
  "SCHEMA_SNAPSHOT_VERSION_MISMATCH",
  "STAGING_CONFIRMATION_REQUIRED",
  "STAGING_ENVIRONMENT_REQUIRED",
  "STAGING_EXTENSION_INVENTORY_INVALID",
  "STAGING_EXTENSION_INVENTORY_MISMATCH",
  "STAGING_EXTENSION_INVENTORY_REQUIRED",
  "STAGING_EXTENSION_INVENTORY_UNAVAILABLE",
  "STAGING_PREFLIGHT_CONFIRMATION_REQUIRED",
  "SYNTHETIC_ID_COLLISION_LIMIT",
  "TABLE_ACL_UNEXPECTED_GRANTEE",
  "TABLE_GRANT_OPTION_PRESENT",
  "TABLE_OWNER_MISMATCH",
  "TABLE_POLICY_MISMATCH",
  "TABLE_PUBLIC_PRIVILEGE_PRESENT",
  "TABLE_RLS_MISMATCH",
  "TABLE_SET_MISMATCH",
  "TRANSACTION_NOT_READ_ONLY",
  "TRANSACTION_ROLLBACK_UNVERIFIED",
  "UNCAUGHT_EXCEPTION",
  "UNHANDLED_REJECTION",
  "USAGE_READ_ONLY_SMOKE_MISMATCH",
  "USER_DEFINED_DATA_PRESENT",
  "USER_DEFINED_OBJECT_PRESENT",
  "USER_OBJECT_CATALOG_INVALID",
  "USER_OBJECT_CATALOG_UNAVAILABLE",
  "USER_OBJECT_CATALOG_UNCLASSIFIED",
  "WEEKLY_READ_ONLY_SMOKE_MISMATCH",
]);
const PUBLIC_MIGRATION_TAG = /^[0-9]{4}_[a-z0-9_-]{1,123}$/;

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys) {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("INVALID_PUBLIC_REPORT_RECORD");
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError("INVALID_PUBLIC_REPORT_KEYS");
  }
}

function publicEnum(value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new TypeError("INVALID_PUBLIC_REPORT_VALUE");
  }
  return value;
}

function publicCount(value) {
  if (value === "not_verified") return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("INVALID_PUBLIC_REPORT_COUNT");
  }
  return value;
}

function publicUserObjectCounts(value) {
  assertExactKeys(value, USER_OBJECT_COUNT_KEYS);
  return Object.fromEntries(
    USER_OBJECT_COUNT_KEYS.map((key) => [key, publicCount(value[key])])
  );
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertCanonicalPreflightOutcome(report) {
  if (report.exitCode !== 0) {
    const expectedOverall = report.exitCode === 3 ? "not_verified" : "fail";
    if (report.overallStatus !== expectedOverall) {
      throw new TypeError("INVALID_PUBLIC_OVERALL_STATUS");
    }
    return;
  }

  const expectedSequenceState =
    report.initialState === "pristine" ? "not_applicable" : "unused";
  const successConditions = [
    report.overallStatus === "pass",
    Object.values(report.postgresqlVersion).every(
      (status) => status === "supported"
    ),
    report.directConnection === "pass",
    report.pooledConnection === "pass",
    report.connectionAuthority === "match",
    report.directPooledIdentity === "match",
    report.databaseRoleIdentity === "match",
    report.expectedIdentity === "match",
    report.extensionInventory === "match",
    ["pristine", "empty_migration_table"].includes(report.initialState),
    report.migrationCatalog === "pass",
    report.migrationHistory.status === "pass",
    report.migrationHistory.expected === EXPECTED_MIGRATION_TAGS.length,
    report.migrationHistory.applied === 0,
    report.migrationHistory.pending === EXPECTED_MIGRATION_TAGS.length,
    arraysEqual(report.migrationHistory.pendingTags, EXPECTED_MIGRATION_TAGS),
    new Set(report.migrationHistory.pendingTags).size ===
      report.migrationHistory.pendingTags.length,
    report.migrationHistory.duplicates === 0,
    report.migrationHistory.unknown === 0,
    report.applicationTables === 0,
    report.applicationFunctions === 0,
    report.applicationData === 0,
    Object.values(report.userDefinedObjects).every((counts) =>
      Object.values(counts).every((count) => count === 0)
    ),
    Object.values(report.migrationSequenceState).every(
      (status) => status === expectedSequenceState
    ),
    report.partialSchema === "none",
    report.readOnlyInvariant === "pass",
    report.beforeAfterComparison === "match",
    report.cleanup === "pass",
    report.secretRedaction === "pass",
  ];
  if (successConditions.some((condition) => condition !== true)) {
    throw new TypeError("INVALID_PUBLIC_SUCCESS_SEMANTICS");
  }
}

export function projectPublicPreflightReport(report) {
  const hasFailure =
    isPlainRecord(report) && Object.hasOwn(report, "failure");
  assertExactKeys(
    report,
    hasFailure ? [...PUBLIC_REPORT_KEYS, "failure"] : PUBLIC_REPORT_KEYS
  );

  assertExactKeys(report.postgresqlVersion, VERSION_KEYS);
  const postgresqlVersion = Object.fromEntries(
    VERSION_KEYS.map((key) => [
      key,
      publicEnum(report.postgresqlVersion[key], ["supported", "not_verified"]),
    ])
  );

  assertExactKeys(report.migrationHistory, MIGRATION_HISTORY_KEYS);
  if (
    !Array.isArray(report.migrationHistory.pendingTags) ||
    report.migrationHistory.pendingTags.length > 128 ||
    report.migrationHistory.pendingTags.some(
      (tag) => typeof tag !== "string" || !PUBLIC_MIGRATION_TAG.test(tag)
    )
  ) {
    throw new TypeError("INVALID_PUBLIC_MIGRATION_TAGS");
  }
  const migrationHistory = {
    status: publicEnum(report.migrationHistory.status, ["pass", "not_verified"]),
    expected: publicCount(report.migrationHistory.expected),
    applied: publicCount(report.migrationHistory.applied),
    pending: publicCount(report.migrationHistory.pending),
    pendingTags: [...report.migrationHistory.pendingTags],
    duplicates: publicCount(report.migrationHistory.duplicates),
    unknown: publicCount(report.migrationHistory.unknown),
  };
  if (migrationHistory.expected !== 7) {
    throw new TypeError("INVALID_PUBLIC_MIGRATION_COUNT");
  }

  assertExactKeys(report.userDefinedObjects, VERSION_KEYS);
  const userDefinedObjects = Object.fromEntries(
    VERSION_KEYS.map((key) => [key, publicUserObjectCounts(report.userDefinedObjects[key])])
  );

  assertExactKeys(report.migrationSequenceState, VERSION_KEYS);
  const migrationSequenceState = Object.fromEntries(
    VERSION_KEYS.map((key) => [
      key,
      publicEnum(report.migrationSequenceState[key], [
        "unused",
        "not_applicable",
        "not_verified",
      ]),
    ])
  );

  const exitCode = publicEnum(report.exitCode, [0, 1, 2, 3]);
  let failure;
  if (hasFailure) {
    assertExactKeys(report.failure, ["checkId", "status"]);
    if (
      typeof report.failure.checkId !== "string" ||
      !PUBLIC_CHECK_IDS.has(report.failure.checkId)
    ) {
      throw new TypeError("INVALID_PUBLIC_CHECK_ID");
    }
    failure = {
      checkId: report.failure.checkId,
      status: publicEnum(report.failure.status, ["fail", "not_verified"]),
    };
  }
  if ((exitCode === 0 && hasFailure) || (exitCode !== 0 && !hasFailure)) {
    throw new TypeError("INVALID_PUBLIC_FAILURE_STATE");
  }

  const projectedReport = {
    environment: publicEnum(report.environment, ["staging"]),
    postgresqlVersion,
    directConnection: publicEnum(report.directConnection, [
      "pass",
      "fail",
      "not_verified",
    ]),
    pooledConnection: publicEnum(report.pooledConnection, [
      "pass",
      "fail",
      "not_verified",
    ]),
    connectionAuthority: publicEnum(report.connectionAuthority, [
      "match",
      "fail",
      "not_verified",
    ]),
    directPooledIdentity: publicEnum(report.directPooledIdentity, [
      "match",
      "fail",
      "not_verified",
    ]),
    databaseRoleIdentity: publicEnum(report.databaseRoleIdentity, [
      "match",
      "fail",
      "not_verified",
    ]),
    expectedIdentity: publicEnum(report.expectedIdentity, [
      "match",
      "fail",
      "not_verified",
    ]),
    extensionInventory: publicEnum(report.extensionInventory, [
      "match",
      "not_verified",
    ]),
    initialState: publicEnum(report.initialState, [
      "pristine",
      "empty_migration_table",
      "not_verified",
    ]),
    migrationCatalog: publicEnum(report.migrationCatalog, [
      "pass",
      "fail",
      "not_verified",
    ]),
    migrationHistory,
    applicationTables: publicCount(report.applicationTables),
    applicationFunctions: publicCount(report.applicationFunctions),
    applicationData: publicCount(report.applicationData),
    userDefinedObjects,
    migrationSequenceState,
    partialSchema: publicEnum(report.partialSchema, ["none", "not_verified"]),
    readOnlyInvariant: publicEnum(report.readOnlyInvariant, [
      "pass",
      "not_verified",
    ]),
    beforeAfterComparison: publicEnum(report.beforeAfterComparison, [
      "match",
      "fail",
      "not_verified",
    ]),
    cleanup: publicEnum(report.cleanup, ["pass", "not_verified"]),
    secretRedaction: publicEnum(report.secretRedaction, ["pass"]),
    overallStatus: publicEnum(report.overallStatus, [
      "pass",
      "fail",
      "not_verified",
    ]),
    ...(failure ? { failure } : {}),
    exitCode,
  };
  assertCanonicalPreflightOutcome(projectedReport);
  return projectedReport;
}

function reportValue(report, path) {
  try {
    let value = report;
    for (const key of path) {
      if (!value || typeof value !== "object") return "not_verified";
      value = value[key];
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      return String(value);
    }
  } catch {
    // A malformed report must not turn a verified failure into a raw formatter error.
  }
  return "not_verified";
}

function failureSummary(report) {
  try {
    if (!report?.failure || typeof report.failure !== "object") return [];
  } catch {
    return [];
  }
  return [
    `failure check: ${reportValue(report, ["failure", "checkId"])}`,
    `failure status: ${reportValue(report, ["failure", "status"])}`,
  ];
}

export function formatHumanSummary(report) {
  return [
    "ActusTube staging database preflight",
    `direct connection: ${reportValue(report, ["directConnection"])}`,
    `pooled connection: ${reportValue(report, ["pooledConnection"])}`,
    `connection authority: ${reportValue(report, ["connectionAuthority"])}`,
    `direct / pooled identity: ${reportValue(report, ["directPooledIdentity"])}`,
    `database role identity: ${reportValue(report, ["databaseRoleIdentity"])}`,
    `expected identity: ${reportValue(report, ["expectedIdentity"])}`,
    `extension inventory: ${reportValue(report, ["extensionInventory"])}`,
    `PostgreSQL version (direct): ${reportValue(report, ["postgresqlVersion", "direct"])}`,
    `PostgreSQL version (pooled): ${reportValue(report, ["postgresqlVersion", "pooled"])}`,
    `PostgreSQL version (direct after): ${reportValue(report, ["postgresqlVersion", "directAfter"])}`,
    `PostgreSQL version (pooled after): ${reportValue(report, ["postgresqlVersion", "pooledAfter"])}`,
    `initial state: ${reportValue(report, ["initialState"])}`,
    `migration catalog: ${reportValue(report, ["migrationCatalog"])}`,
    `migration history: ${reportValue(report, ["migrationHistory", "status"])}`,
    `applied migrations: ${reportValue(report, ["migrationHistory", "applied"])}`,
    `pending migrations: ${reportValue(report, ["migrationHistory", "pending"])}`,
    `duplicate migrations: ${reportValue(report, ["migrationHistory", "duplicates"])}`,
    `unknown migrations: ${reportValue(report, ["migrationHistory", "unknown"])}`,
    `migration sequence (direct): ${reportValue(report, ["migrationSequenceState", "direct"])}`,
    `migration sequence (pooled): ${reportValue(report, ["migrationSequenceState", "pooled"])}`,
    `migration sequence (direct after): ${reportValue(report, ["migrationSequenceState", "directAfter"])}`,
    `migration sequence (pooled after): ${reportValue(report, ["migrationSequenceState", "pooledAfter"])}`,
    `application tables: ${reportValue(report, ["applicationTables"])}`,
    `application functions: ${reportValue(report, ["applicationFunctions"])}`,
    `application data: ${reportValue(report, ["applicationData"])}`,
    `user-defined objects (direct): ${reportValue(report, ["userDefinedObjects", "direct", "total"])}`,
    `user-defined objects (pooled): ${reportValue(report, ["userDefinedObjects", "pooled", "total"])}`,
    `user-defined objects (direct after): ${reportValue(report, ["userDefinedObjects", "directAfter", "total"])}`,
    `user-defined objects (pooled after): ${reportValue(report, ["userDefinedObjects", "pooledAfter", "total"])}`,
    `partial schema: ${reportValue(report, ["partialSchema"])}`,
    `read-only invariant: ${reportValue(report, ["readOnlyInvariant"])}`,
    `before / after comparison: ${reportValue(report, ["beforeAfterComparison"])}`,
    `cleanup: ${reportValue(report, ["cleanup"])}`,
    `secret redaction: ${reportValue(report, ["secretRedaction"])}`,
    `overall status: ${reportValue(report, ["overallStatus"])}`,
    ...failureSummary(report),
    `exit code: ${reportValue(report, ["exitCode"])}`,
    PARENT_ENVIRONMENT_NOTICE,
  ].join("\n");
}

function writeProcessStdout(buffer) {
  writeSync(1, buffer);
}

export function createUnverifiedPreflightReport(checkId) {
  return {
    ...createPreflightBaseReport(),
    exitCode: 3,
    failure: { checkId, status: "not_verified" },
  };
}

function buildPreflightReportBuffer({ report, formatSummary }) {
  let outputReport;
  let json;
  let summary;
  try {
    outputReport = projectPublicPreflightReport(report);
  } catch {
    outputReport = createUnverifiedPreflightReport(
      "PREFLIGHT_PUBLIC_REPORT_INVALID"
    );
    json = JSON.stringify(outputReport);
    summary = formatHumanSummary(outputReport);
    return {
      outputReport,
      buffer: `${json}\n${summary}\n`,
    };
  }
  try {
    json = JSON.stringify(outputReport);
    const canonicalSummary = formatHumanSummary(outputReport);
    summary = formatSummary(outputReport);
    if (
      typeof json !== "string" ||
      typeof summary !== "string" ||
      summary !== canonicalSummary
    ) {
      throw new TypeError("INVALID_PREFLIGHT_FORMATTER_OUTPUT");
    }
  } catch {
    outputReport = createUnverifiedPreflightReport(
      "PREFLIGHT_FORMATTER_FAILURE"
    );
    json = JSON.stringify(outputReport);
    summary = formatHumanSummary(outputReport);
  }
  return {
    outputReport,
    buffer: `${json}\n${summary}\n`,
  };
}

function emitPreflightReport({ report, stdout, formatSummary }) {
  const prepared = buildPreflightReportBuffer({ report, formatSummary });
  try {
    const result = stdout(prepared.buffer);
    if (result && typeof result.then === "function") {
      throw new TypeError("PREFLIGHT_SYNCHRONOUS_WRITER_REQUIRED");
    }
    return prepared.outputReport;
  } catch {
    return createUnverifiedPreflightReport("PREFLIGHT_OUTPUT_FAILURE");
  }
}

export async function executeStagingDatabasePreflight({
  environment = process.env,
  repositoryRoot = process.cwd(),
  adapter = createNeonPostflightAdapter(),
  allowLoopback = false,
  onQuery,
  signal,
  stdout = writeProcessStdout,
  formatSummary = formatHumanSummary,
} = {}) {
  const report = await verifyStagingDatabasePreflight({
    environment,
    repositoryRoot,
    adapter,
    allowLoopback,
    onQuery,
    signal,
  });
  return emitPreflightReport({ report, stdout, formatSummary });
}

export function createTerminalReportGate({
  stdout = writeProcessStdout,
  formatSummary = formatHumanSummary,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let terminalOutcome = null;
  let fatalCheckId = null;
  let reportCommitted = false;
  let effectiveExitCode;

  const latchFatal = (checkId) => {
    if (reportCommitted || fatalCheckId !== null) return false;
    fatalCheckId = checkId;
    effectiveExitCode = 3;
    setExitCode(3);
    return true;
  };

  const commit = (mainReport) => {
    if (reportCommitted) return terminalOutcome;
    let selected = fatalCheckId
      ? createUnverifiedPreflightReport(fatalCheckId)
      : mainReport;
    let prepared = buildPreflightReportBuffer({
      report: selected,
      formatSummary: fatalCheckId ? formatHumanSummary : formatSummary,
    });
    if (fatalCheckId && prepared.outputReport.exitCode !== 3) {
      prepared = buildPreflightReportBuffer({
        report: createUnverifiedPreflightReport(fatalCheckId),
        formatSummary: formatHumanSummary,
      });
    }
    if (!fatalCheckId && prepared.outputReport.exitCode === 3) {
      selected = prepared.outputReport;
    } else if (fatalCheckId) {
      selected = createUnverifiedPreflightReport(fatalCheckId);
      prepared = buildPreflightReportBuffer({
        report: selected,
        formatSummary: formatHumanSummary,
      });
    } else {
      selected = prepared.outputReport;
    }

    if (fatalCheckId && selected.failure?.checkId !== fatalCheckId) {
      selected = createUnverifiedPreflightReport(fatalCheckId);
      prepared = buildPreflightReportBuffer({
        report: selected,
        formatSummary: formatHumanSummary,
      });
    }

    terminalOutcome = selected;
    reportCommitted = true;
    if (effectiveExitCode !== selected.exitCode) {
      effectiveExitCode = selected.exitCode;
      setExitCode(effectiveExitCode);
    }
    try {
      const result = stdout(prepared.buffer);
      if (result && typeof result.then === "function") {
        throw new TypeError("PREFLIGHT_SYNCHRONOUS_WRITER_REQUIRED");
      }
    } catch {
      terminalOutcome = createUnverifiedPreflightReport(
        "PREFLIGHT_OUTPUT_FAILURE"
      );
      if (effectiveExitCode !== 3) {
        effectiveExitCode = 3;
        setExitCode(3);
      }
    }
    return terminalOutcome;
  };

  return {
    commit,
    latchFatal,
    state() {
      return {
        fatalCheckId,
        reportCommitted,
        exitCode: effectiveExitCode,
      };
    },
  };
}

export function createFatalExitLatch({
  stdout = writeProcessStdout,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let fatal = false;
  const terminalGate = createTerminalReportGate({ stdout, setExitCode });
  const latch = (checkId) => {
    fatal = true;
    terminalGate.latchFatal(checkId);
    return terminalGate.commit(createUnverifiedPreflightReport(checkId));
  };
  return {
    latch,
    setReportExitCode(code) {
      const effectiveCode = fatal ? 3 : code;
      setExitCode(effectiveCode);
      return effectiveCode;
    },
  };
}

async function main({ signal } = {}) {
  return verifyStagingDatabasePreflight({
    environment: process.env,
    repositoryRoot: process.cwd(),
    adapter: createNeonPostflightAdapter(),
    signal,
  });
}

export function installFatalProcessListeners({
  processObject,
  terminalGate,
  abortController,
  onFatal,
}) {
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    processObject.off("uncaughtException", onUncaughtException);
    processObject.off("unhandledRejection", onUnhandledRejection);
  };
  const onUncaughtException = () => {
    abortController.abort();
    terminalGate.latchFatal("UNCAUGHT_EXCEPTION");
    onFatal("UNCAUGHT_EXCEPTION");
  };
  const onUnhandledRejection = () => {
    abortController.abort();
    terminalGate.latchFatal("UNHANDLED_REJECTION");
    onFatal("UNHANDLED_REJECTION");
  };
  processObject.on("uncaughtException", onUncaughtException);
  processObject.on("unhandledRejection", onUnhandledRejection);
  return remove;
}

export async function runPreflightCli({
  mainFunction = main,
  processObject = process,
  stdout = writeProcessStdout,
  formatSummary = formatHumanSummary,
  terminalBarrier = () =>
    new Promise((resolve) => {
      setImmediate(resolve);
    }),
} = {}) {
  const terminalGate = createTerminalReportGate({
    stdout,
    formatSummary,
    setExitCode: (code) => {
      processObject.exitCode = code;
    },
  });
  const abortController = new AbortController();
  let resolveFatalOutcome;
  const fatalOutcomePromise = new Promise((resolveFatal) => {
    resolveFatalOutcome = resolveFatal;
  });
  const removeListeners = installFatalProcessListeners({
    processObject,
    terminalGate,
    abortController,
    onFatal: (checkId) => {
      resolveFatalOutcome({ kind: "fatal", checkId });
    },
  });
  try {
    let mainPromise;
    try {
      mainPromise = Promise.resolve(
        mainFunction({ signal: abortController.signal })
      );
    } catch {
      mainPromise = Promise.reject(new Error("PREFLIGHT_TOP_LEVEL_FAILURE"));
    }
    const outcome = await Promise.race([
      mainPromise.then(
        (report) => ({ kind: "main", report }),
        () => ({ kind: "failure" })
      ),
      fatalOutcomePromise,
    ]);
    let mainReport;
    if (
      outcome.kind === "fatal"
    ) {
      mainReport = createUnverifiedPreflightReport(outcome.checkId);
    } else if (
      outcome.kind === "failure" ||
      !outcome.report ||
      typeof outcome.report !== "object" ||
      !Number.isInteger(outcome.report.exitCode) ||
      outcome.report.exitCode < 0 ||
      outcome.report.exitCode > 3
    ) {
      terminalGate.latchFatal("PREFLIGHT_TOP_LEVEL_FAILURE");
      mainReport = createUnverifiedPreflightReport("PREFLIGHT_TOP_LEVEL_FAILURE");
    } else {
      mainReport = outcome.report;
    }
    try {
      await terminalBarrier({
        signal: abortController.signal,
        state: terminalGate.state,
      });
    } catch {
      terminalGate.latchFatal("PREFLIGHT_TERMINAL_BARRIER_FAILURE");
    }
    await Promise.resolve();
    return terminalGate.commit(mainReport);
  } finally {
    removeListeners();
  }
}

export function isDirectPreflightInvocation({
  moduleUrl = import.meta.url,
  argvEntry = process.argv[1],
  platform = process.platform,
  realpath = realpathSync.native,
} = {}) {
  if (!argvEntry) return false;
  try {
    const normalizePath = (value) => {
      const normalized = realpath(resolve(value));
      return platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return normalizePath(fileURLToPath(moduleUrl)) === normalizePath(argvEntry);
  } catch {
    return false;
  }
}

export async function runStagingPreflightEntrypoint({
  runCliFunction = runPreflightCli,
  terminateProcess = (code) => process.exit(code),
} = {}) {
  const report = await runCliFunction();
  if (report.exitCode === 3) terminateProcess(3);
  return report;
}

if (isDirectPreflightInvocation()) {
  void runStagingPreflightEntrypoint();
}
