/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS,
  PREFLIGHT_SQL_FOR_TESTS,
  STAGING_EXTENSION_INVENTORY_LIMITS,
  createPreflightBaseReport,
  parseExpectedStagingExtensions,
  verifyStagingDatabasePreflight,
} from "../scripts/staging-database-preflight/core.mjs";
import {
  POSTFLIGHT_SQL_FOR_TESTS,
  loadRepositorySpecification,
} from "../scripts/staging-database-postflight/core.mjs";
import { assertReadOnlySql } from "../scripts/staging-database-postflight/safety.mjs";
import {
  EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS,
  HARNESS_DEADLINE_LIMITS_FOR_TESTS,
  INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS,
  TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS,
  createIndependentDeadlineContextsForTests,
  externalFixtureSuccessResultForTests,
  harnessAuthorityBoundaryForTests,
  runConnectionOnlyHarness,
  runHarnessDeadlineProbeForTests,
  runHarnessTransactionBoundaryProbeForTests,
  runMigrationOwnerBoundaryProbeForTests,
  runOwnershipCanonicalizationProbeForTests,
  validateExternalFixtureConfigurationForTests,
  validateIndependentExtensionInventoryForTests,
} from "../scripts/test-staging-database-preflight-postgres.mjs";
import {
  benignChildLifecycleCountersForTests,
  runBenignChildLifecycleProbeForTests,
} from "../scripts/test-staging-database-fault-lifecycle.mjs";
import {
  PARENT_ENVIRONMENT_NOTICE,
  createFatalExitLatch,
  executeStagingDatabasePreflight,
  formatHumanSummary,
  runPreflightCli,
} from "../scripts/verify-staging-database-preflight.mjs";

const repositoryRoot = process.cwd();
const fakeSecret = "preflight-fixture-secret-never-print";
const directUrl =
  `postgresql://staging_direct:${fakeSecret}@ep-actustube-safe.example.test/staging_database?sslmode=require`;
const pooledUrl =
  `postgresql://staging_runtime:${fakeSecret}@ep-actustube-safe-pooler.example.test/staging_database?sslmode=require`;

function validEnvironment(): any {
  return {
    ACTUSTUBE_DB_ENV: "staging",
    ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "1",
    DIRECT_DATABASE_URL: directUrl,
    DATABASE_URL: pooledUrl,
    ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-actustube-safe",
    ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
      schemaVersion: 1,
      extensions: [],
    }),
  };
}

function baseState(): any {
  return {
    serverVersion: {
      server_version_num: "180004",
    },
    identity: {
      database_oid: "100",
      system_identifier: "200",
    },
    roleIdentity: { role_name: "staging_direct" },
    extensionInventory: [],
    migrationCatalog: {
      schema_exists: false,
      table_exists: false,
      objects: [],
    },
    migrationColumns: [],
    migrationColumnExact: [],
    migrationPrimaryKey: [],
    migrationHistory: [],
    migrationExact: null,
    userDefinedObjects: {
      total_count: 0,
      schema_count: 0,
      relation_count: 0,
      routine_count: 0,
      type_count: 0,
      trigger_count: 0,
      rule_count: 0,
      policy_count: 0,
      constraint_count: 0,
      other_count: 0,
      estimated_data_rows: "0",
      object_signature: [],
      extension_classification_evidence: [],
      extension_unclassified_count: 0,
      extension_ambiguous_count: 0,
      extension_candidate_signature: [],
      extension_managed_signature: [],
      extension_residual_signature: [],
    },
  };
}

const exactMigrationState = {
  table_relkind: "r",
  table_persistence: "p",
  table_is_shared: false,
  table_rewrite_is_zero: true,
  table_row_type_is_canonical: true,
  table_is_partition: false,
  table_row_security: false,
  table_force_row_security: false,
  table_replica_identity: "d",
  table_check_count: 0,
  table_has_rules: false,
  table_has_triggers: false,
  table_attribute_count: 3,
  table_has_index: true,
  table_has_subclass: false,
  table_is_populated: true,
  table_not_typed: true,
  table_no_partition_bound: true,
  table_has_toast: true,
  table_toast_mapping_is_canonical: true,
  table_tablespace_is_default: true,
  table_acl_is_default: true,
  object_namespaces_are_canonical: true,
  object_owner_is_consistent: true,
  table_option_count: 0,
  table_access_method: "heap",
  sequence_relkind: "S",
  sequence_persistence: "p",
  sequence_access_method_is_zero: true,
  sequence_is_shared: false,
  sequence_rewrite_is_zero: true,
  sequence_row_type_is_zero: true,
  sequence_is_partition: false,
  sequence_row_security: false,
  sequence_force_row_security: false,
  sequence_replica_identity: "n",
  sequence_check_count: 0,
  sequence_has_rules: false,
  sequence_has_triggers: false,
  sequence_attribute_count: 3,
  sequence_has_index: false,
  sequence_has_subclass: false,
  sequence_is_populated: true,
  sequence_not_typed: true,
  sequence_no_partition_bound: true,
  sequence_has_no_toast: true,
  sequence_tablespace_is_default: true,
  sequence_acl_is_default: true,
  sequence_option_count: 0,
  sequence_data_type: "integer",
  sequence_start: "1",
  sequence_increment: "1",
  sequence_minimum: "1",
  sequence_maximum: "2147483647",
  sequence_cache: "1",
  sequence_cycle: false,
  sequence_last_value: "1",
  sequence_is_called: false,
  index_relkind: "i",
  index_persistence: "p",
  index_is_shared: false,
  index_rewrite_is_zero: true,
  index_row_type_is_zero: true,
  index_relation_attribute_count: 1,
  index_is_partition: false,
  index_row_security: false,
  index_force_row_security: false,
  index_replica_identity: "n",
  index_check_count: 0,
  index_has_rules: false,
  index_has_triggers: false,
  index_has_index: false,
  index_has_subclass: false,
  index_is_populated: true,
  index_not_typed: true,
  index_no_partition_bound: true,
  index_has_no_toast: true,
  index_tablespace_is_default: true,
  index_acl_is_default: true,
  index_option_count: 0,
  index_access_method: "btree",
  index_is_unique: true,
  index_is_primary: true,
  index_is_exclusion: false,
  index_is_valid: true,
  index_is_ready: true,
  index_is_live: true,
  index_is_clustered: false,
  index_is_replica_identity: false,
  index_is_immediate: true,
  index_check_xmin: false,
  index_nulls_not_distinct: false,
  index_has_no_predicate: true,
  index_has_no_expressions: true,
  index_collation_is_canonical: true,
  index_option_is_canonical: true,
  index_operator_class_is_canonical: true,
  index_key_count: 1,
  index_attribute_count: 1,
  index_column_exact: true,
  index_vector_lengths_are_canonical: true,
  index_relation_mapping_is_canonical: true,
  constraint_count: 3,
  primary_constraint_count: 1,
  not_null_constraint_count: 2,
  unexpected_constraint_count: 0,
  primary_key_exact: true,
  constraint_enforcement_is_canonical: true,
  constraint_period_is_canonical: true,
  constraint_mapping_is_canonical: true,
  constraint_action_fields_are_canonical: true,
  constraint_foreign_key_fields_are_canonical: true,
  constraint_exclusion_fields_are_canonical: true,
  constraint_expression_fields_are_canonical: true,
  not_null_constraint_keys_exact: true,
  not_null_constraint_names_exact: true,
  not_null_constraints_exact: true,
  trigger_count: 0,
  rule_count: 0,
  policy_count: 0,
  sequence_owned_by_count: 1,
  default_sequence_dependency_count: 1,
};

const migrationColumns = [
  {
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    column_default:
      "nextval('drizzle.__drizzle_migrations_id_seq'::regclass)",
  },
  {
    column_name: "hash",
    data_type: "text",
    is_nullable: "NO",
    column_default: null,
  },
  {
    column_name: "created_at",
    data_type: "bigint",
    is_nullable: "YES",
    column_default: null,
  },
];

const migrationColumnExact = [
  {
    relation_is_canonical: true,
    position: 1,
    column_name: "id",
    is_dropped: false,
    inherited_count: 0,
    is_local: true,
    type_key: "integer",
    typmod: -1,
    type_length: 4,
    dimensions: 0,
    passed_by_value: true,
    alignment: "i",
    type_kind: "b",
    domain_base_is_none: true,
    identity_kind: "",
    generated_kind: "",
    collation_is_canonical: true,
    is_not_null: true,
    has_default: true,
    default_kind: "serial_sequence",
    acl_is_default: true,
    options_are_default: true,
    fdw_options_are_default: true,
    storage_kind: "p",
    compression_kind: "",
    statistics_are_default: true,
    has_no_missing_value: true,
    missing_value_is_null: true,
  },
  {
    relation_is_canonical: true,
    position: 2,
    column_name: "hash",
    is_dropped: false,
    inherited_count: 0,
    is_local: true,
    type_key: "text",
    typmod: -1,
    type_length: -1,
    dimensions: 0,
    passed_by_value: false,
    alignment: "i",
    type_kind: "b",
    domain_base_is_none: true,
    identity_kind: "",
    generated_kind: "",
    collation_is_canonical: true,
    is_not_null: true,
    has_default: false,
    default_kind: "none",
    acl_is_default: true,
    options_are_default: true,
    fdw_options_are_default: true,
    storage_kind: "x",
    compression_kind: "",
    statistics_are_default: true,
    has_no_missing_value: true,
    missing_value_is_null: true,
  },
  {
    relation_is_canonical: true,
    position: 3,
    column_name: "created_at",
    is_dropped: false,
    inherited_count: 0,
    is_local: true,
    type_key: "bigint",
    typmod: -1,
    type_length: 8,
    dimensions: 0,
    passed_by_value: true,
    alignment: "d",
    type_kind: "b",
    domain_base_is_none: true,
    identity_kind: "",
    generated_kind: "",
    collation_is_canonical: true,
    is_not_null: false,
    has_default: false,
    default_kind: "none",
    acl_is_default: true,
    options_are_default: true,
    fdw_options_are_default: true,
    storage_kind: "p",
    compression_kind: "",
    statistics_are_default: true,
    has_no_missing_value: true,
    missing_value_is_null: true,
  },
];

function emptyMigrationTableState(): any {
  return {
    ...baseState(),
    migrationCatalog: {
      schema_exists: true,
      table_exists: true,
      objects: [
        "S:__drizzle_migrations_id_seq",
        "i:__drizzle_migrations_pkey",
        "r:__drizzle_migrations",
      ],
    },
    migrationColumns,
    migrationColumnExact: migrationColumnExact.map((row) => ({ ...row })),
    migrationPrimaryKey: [{ columns: ["id"] }],
    migrationExact: { ...exactMigrationState },
  };
}

function residualState(
  field: string,
  { estimatedDataRows = "0", signature = "1259:90001:0" } = {}
) {
  const state = baseState();
  const kindByField: Record<string, string> = {
    schema_count: "schema",
    relation_count: "relation",
    routine_count: "routine",
    type_count: "type",
    trigger_count: "trigger",
    rule_count: "rule",
    policy_count: "policy",
    constraint_count: "constraint",
    other_count: "other",
  };
  const kind = kindByField[field];
  if (!kind) throw new Error("UNKNOWN_RESIDUAL_FIXTURE_FIELD");
  state.userDefinedObjects = {
    ...state.userDefinedObjects,
    total_count: 1,
    [field]: 1,
    estimated_data_rows: estimatedDataRows,
    object_signature: [`${kind}:${signature}`],
    extension_classification_evidence: [
      {
        objectSignature: signature,
        evidenceSignature: `candidate:${signature}`,
        evidenceKind: "candidate",
        dependencyType: "none",
        dependentClass: "none",
        referencedClass: "none",
        referencedIsDirectExtensionMember: false,
        triggerConstraintMatches: false,
        ruleName: null,
        relationKind: null,
        constraintType: null,
      },
      {
        objectSignature: signature,
        evidenceSignature: `residual_catalog:${signature}`,
        evidenceKind: "residual_catalog",
        dependencyType: "none",
        dependentClass: "other_catalog",
        referencedClass: "none",
        referencedIsDirectExtensionMember: false,
        triggerConstraintMatches: false,
        ruleName: null,
        relationKind: null,
        constraintType: null,
      },
    ],
    extension_candidate_signature: [signature],
    extension_managed_signature: [],
    extension_residual_signature: [signature],
  };
  return state;
}

function extensionClassificationState(
  evidence: Record<string, unknown>,
  {
    managed = false,
    residualField = "other_count",
    signature = "1259:90002:0",
  }: { managed?: boolean; residualField?: string; signature?: string } = {}
) {
  const state = managed
    ? baseState()
    : residualState(residualField, { signature });
  state.userDefinedObjects.extension_classification_evidence = [
    {
      objectSignature: signature,
      evidenceSignature: `candidate:${signature}`,
      evidenceKind: "candidate",
      dependencyType: "none",
      dependentClass: "none",
      referencedClass: "none",
      referencedIsDirectExtensionMember: false,
      triggerConstraintMatches: false,
      ruleName: null,
      relationKind: null,
      constraintType: null,
    },
    {
      objectSignature: signature,
      evidenceSignature: `dependency:${signature}:1`,
      evidenceKind: "dependency",
      referencedIsDirectExtensionMember: false,
      triggerConstraintMatches: false,
      ruleName: null,
      relationKind: null,
      constraintType: null,
      ...evidence,
    },
    ...(!managed
      ? [
          {
            objectSignature: signature,
            evidenceSignature: `residual_catalog:${signature}`,
            evidenceKind: "residual_catalog",
            dependencyType: "none",
            dependentClass: "other_catalog",
            referencedClass: "none",
            referencedIsDirectExtensionMember: false,
            triggerConstraintMatches: false,
            ruleName: null,
            relationKind: null,
            constraintType: null,
          },
        ]
      : []),
  ];
  state.userDefinedObjects.extension_candidate_signature = [signature];
  state.userDefinedObjects.extension_managed_signature = managed
    ? [signature]
    : [];
  state.userDefinedObjects.extension_residual_signature = managed
    ? []
    : [signature];
  return state;
}

function dependencyEvidence(
  signature: string,
  suffix: string,
  overrides: Record<string, unknown>
) {
  return {
    objectSignature: signature,
    evidenceSignature: `dependency:${signature}:${suffix}`,
    evidenceKind: "dependency",
    dependencyType: "n",
    dependentClass: "other_catalog",
    referencedClass: "other_catalog",
    referencedIsDirectExtensionMember: false,
    triggerConstraintMatches: false,
    ruleName: null,
    relationKind: null,
    constraintType: null,
    ...overrides,
  };
}

function sameSql(left: string, right: string) {
  return left.replaceAll(/\s+/g, " ").trim() ===
    right.replaceAll(/\s+/g, " ").trim();
}

function countSqlCalls(connection: any, statement: string) {
  return connection.query.mock.calls.filter(([actual]: [string]) =>
    sameSql(actual, statement)
  ).length;
}

function createConnection(
  stateFactory: () => any,
  options: {
    failCleanup?: boolean;
    hangCleanup?: boolean;
    hangAt?: string;
    roleName?: string;
  } = {}
) {
  let serverVersionReads = 0;
  let identityReads = 0;
  let userObjectReads = 0;
  let migrationColumnExactReads = 0;
  let migrationExactReads = 0;
  let extensionInventoryReads = 0;
  let cleanupHandle: ReturnType<typeof setInterval> | undefined;
  const query = vi.fn((statement: string) => {
    if (options.hangAt && sameSql(statement, (PREFLIGHT_SQL_FOR_TESTS as any)[options.hangAt])) {
      return new Promise(() => undefined);
    }
    if (
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.begin) ||
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.statementTimeout) ||
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.lockTimeout) ||
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback)
    ) {
      return Promise.resolve({ rows: [] });
    }
    if (sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.transactionReadOnly)) {
      return Promise.resolve({ rows: [{ transaction_read_only: "on" }] });
    }
    const state = stateFactory();
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.serverVersion)) {
      serverVersionReads += 1;
      const serverVersion =
        state.serverVersionForRead?.(serverVersionReads) || state.serverVersion;
      return Promise.resolve({ rows: serverVersion ? [serverVersion] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.identity)) {
      identityReads += 1;
      const identity =
        state.identityForRead?.(identityReads) ?? state.identity;
      return Promise.resolve({ rows: identity ? [identity] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.roleIdentity)) {
      const roleIdentity = state.roleIdentityForRead?.() ?? {
        role_name: options.roleName ?? state.roleIdentity?.role_name,
      };
      return Promise.resolve({ rows: roleIdentity?.role_name ? [roleIdentity] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)) {
      extensionInventoryReads += 1;
      return Promise.resolve({
        rows:
          state.extensionInventoryForRead?.(extensionInventoryReads) ??
          state.extensionInventory,
      });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationCatalog)) {
      return Promise.resolve({ rows: [state.migrationCatalog] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationColumns)) {
      return Promise.resolve({ rows: state.migrationColumns });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationColumnExact)) {
      migrationColumnExactReads += 1;
      return Promise.resolve({
        rows:
          state.migrationColumnExactForRead?.(migrationColumnExactReads) ||
          state.migrationColumnExact,
      });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationPrimaryKey)) {
      return Promise.resolve({ rows: state.migrationPrimaryKey });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationHistory)) {
      return Promise.resolve({ rows: state.migrationHistory });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationExact)) {
      migrationExactReads += 1;
      const migrationExact =
        state.migrationExactForRead?.(migrationExactReads) || state.migrationExact;
      return Promise.resolve({ rows: migrationExact ? [migrationExact] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects)) {
      userObjectReads += 1;
      return Promise.resolve({
        rows: [
          state.userDefinedObjectsForRead?.(userObjectReads) ||
            state.userDefinedObjects,
        ],
      });
    }
    throw new Error(`Unexpected fixture query: ${statement.slice(0, 32)}`);
  });
  const connection = {
    query,
    close: options.failCleanup
      ? vi.fn().mockRejectedValue(new Error(`${fakeSecret} cleanup failure`))
      : options.hangCleanup
        ? vi.fn(
            () =>
              new Promise(() => {
                cleanupHandle = setInterval(() => undefined, 1_000);
              })
          )
        : vi.fn().mockResolvedValue(undefined),
    clearCleanupHandle() {
      if (cleanupHandle) clearInterval(cleanupHandle);
      cleanupHandle = undefined;
    },
  };
  return connection;
}

function createAdapter({
  directState = baseState(),
  pooledState = directState,
  directFailure,
  pooledFailure,
  directOptions,
  pooledOptions,
}: any = {}) {
  const directConnection = createConnection(() => directState, {
    roleName: "staging_direct",
    ...directOptions,
  });
  const pooledConnection = createConnection(() => pooledState, {
    roleName: "staging_runtime",
    ...pooledOptions,
  });
  const connect = vi.fn(
    (
      kind: string,
      _url?: string,
      _options?: { signal?: AbortSignal }
    ) => {
      void _url;
      void _options;
      if (kind === "direct" && directFailure) return Promise.reject(directFailure);
      if (kind === "pooled" && pooledFailure) return Promise.reject(pooledFailure);
      return Promise.resolve(
        kind === "direct" ? directConnection : pooledConnection
      );
    }
  );
  return { connect, directConnection, pooledConnection };
}

async function runPreflight(adapter: any, environment = validEnvironment()) {
  return verifyStagingDatabasePreflight({
    environment,
    repositoryRoot,
    adapter,
  }) as Promise<any>;
}

function createSanitizedNodeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

async function runCliChild(scenario: string) {
  const entryUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/verify-staging-database-preflight.mjs")
  ).href;
  const coreUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/staging-database-preflight/core.mjs")
  ).href;
  const postflightCoreUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/staging-database-postflight/core.mjs")
  ).href;
  const childSource = `
    import {
      runPreflightCli,
      runStagingPreflightEntrypoint,
    } from ${JSON.stringify(entryUrl)};
    import {
      PREFLIGHT_SQL_FOR_TESTS,
      verifyStagingDatabasePreflight,
    } from ${JSON.stringify(coreUrl)};
    import { POSTFLIGHT_SQL_FOR_TESTS } from ${JSON.stringify(postflightCoreUrl)};
    const scenario = process.argv[2];
    const childSecret = ${JSON.stringify(fakeSecret)};
    const normalize = (value) => value.replaceAll(/\\s+/g, " ").trim();
    const sameSql = (left, right) => normalize(left) === normalize(right);
    const residualSignature = "1259:90003:0";
    const userObjects = {
      total_count: scenario === "residual" ? 1 : 0,
      schema_count: 0,
      relation_count: scenario === "residual" ? 1 : 0,
      routine_count: 0,
      type_count: 0,
      trigger_count: 0,
      rule_count: 0,
      policy_count: 0,
      constraint_count: 0,
      other_count: 0,
      estimated_data_rows: "0",
      object_signature: scenario === "residual"
        ? ["relation:" + residualSignature]
        : [],
      extension_classification_evidence: scenario === "residual"
        ? [
            {
              objectSignature: residualSignature,
              evidenceSignature: "candidate:" + residualSignature,
              evidenceKind: "candidate",
              dependencyType: "none",
              dependentClass: "none",
              referencedClass: "none",
              referencedIsDirectExtensionMember: false,
              triggerConstraintMatches: false,
              ruleName: null,
              relationKind: null,
              constraintType: null,
            },
            {
              objectSignature: residualSignature,
              evidenceSignature: "residual_catalog:" + residualSignature,
              evidenceKind: "residual_catalog",
              dependencyType: "none",
              dependentClass: "pg_class",
              referencedClass: "none",
              referencedIsDirectExtensionMember: false,
              triggerConstraintMatches: false,
              ruleName: null,
              relationKind: null,
              constraintType: null,
            },
          ]
        : [],
      extension_unclassified_count: 0,
      extension_ambiguous_count: 0,
      extension_candidate_signature: scenario === "residual"
        ? [residualSignature]
        : [],
      extension_managed_signature: [],
      extension_residual_signature: scenario === "residual"
        ? [residualSignature]
        : [],
    };
    const state = {
      serverVersion: { server_version_num: "180004" },
      identity: { database_oid: "100", system_identifier: "200" },
      extensionInventory: [],
      migrationCatalog: {
        schema_exists: false,
        table_exists: false,
        objects: [],
      },
      userDefinedObjects: userObjects,
    };
    let activeCleanupHandle;
    if (scenario === "cleanup_timeout") {
      const nativeSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (handler, timeout, ...args) =>
        nativeSetTimeout(handler, timeout === 5_000 ? 25 : timeout, ...args);
    }
    const createConnection = (kind) => ({
      async query(statement) {
        if (
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.begin) ||
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.statementTimeout) ||
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.lockTimeout) ||
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback)
        ) return { rows: [] };
        if (sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.transactionReadOnly)) {
          return { rows: [{ transaction_read_only: "on" }] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.identity)) {
          return { rows: [state.identity] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.roleIdentity)) {
          return {
            rows: [
              {
                role_name:
                  kind === "direct" ? "staging_direct" : "staging_runtime",
              },
            ],
          };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)) {
          return { rows: state.extensionInventory };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.serverVersion)) {
          return { rows: [state.serverVersion] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationCatalog)) {
          return { rows: [state.migrationCatalog] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects)) {
          return scenario === "catalog_unknown"
            ? { rows: [] }
            : { rows: [state.userDefinedObjects] };
        }
        throw new Error(childSecret);
      },
      close() {
        if (scenario === "cleanup_timeout" && kind === "pooled") {
          return new Promise(() => {
            activeCleanupHandle = setInterval(() => undefined, 1_000);
          });
        }
        return Promise.resolve();
      },
    });
    const adapter = {
      async connect(kind) {
        if (scenario === "connection_unknown" && kind === "direct") {
          throw new AggregateError([new Error(childSecret)]);
        }
        return createConnection(kind);
      },
    };
    const environment = {
      ACTUSTUBE_DB_ENV: scenario === "safety" ? "production" : "staging",
      ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "1",
      DIRECT_DATABASE_URL: ${JSON.stringify(directUrl)},
      DATABASE_URL: ${JSON.stringify(pooledUrl)},
      ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-actustube-safe",
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [],
      }),
    };
    const mainFunction = () => verifyStagingDatabasePreflight({
      environment,
      repositoryRoot: process.cwd(),
      adapter,
    });
    const runCliFunction = () => runPreflightCli({
      mainFunction,
      ...(scenario === "formatter_failure"
        ? { formatSummary: () => { throw new Error(childSecret); } }
        : {}),
    });
    if (scenario === "cleanup_timeout") {
      await runStagingPreflightEntrypoint({ runCliFunction });
      process.exit(96);
    }
    await runCliFunction();
    if (
      process.listenerCount("uncaughtException") !== 0 ||
      process.listenerCount("unhandledRejection") !== 0
    ) {
      process.exitCode = 98;
    }
  `;
  return await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-", scenario],
      {
        env: createSanitizedNodeChildEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectChild(new Error("CLI_CHILD_TIMEOUT"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveChild({ exitCode, stdout, stderr });
    });
    child.stdin.end(childSource);
  });
}

const postgresHarnessModule = resolve(
  repositoryRoot,
  "scripts/test-staging-database-preflight-postgres.mjs"
);
const faultLifecycleModule = resolve(
  repositoryRoot,
  "scripts/test-staging-database-fault-lifecycle.mjs"
);

function externalFixtureEnvironment(
  overrides: Partial<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
      "postgresql://actustube_ci_fixture:ci_fixture_only_not_a_secret@127.0.0.1:5432/actustube_ci_fixture",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE: "actustube_ci_fixture",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE: "actustube_ci_fixture",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR: "18",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX: "6",
    ...overrides,
  };
}

function createDeadlineFakeClient({
  connectHang = false,
  queryHang = false,
  endHang = false,
  lateQueryRejection = false,
  hangOnStatement = null as string | null,
  rejectOnStatement = null as string | null,
} = {}) {
  const counters = {
    connect: 0,
    query: [] as string[],
    end: 0,
    destroy: 0,
  };
  const state = {
    connected: false,
    usable: true,
    destroyed: false,
    ended: false,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          counters.destroy += 1;
          state.destroyed = true;
          state.usable = false;
          state.queriesAtDestroy = counters.query.length;
        },
      },
    },
    connect() {
      counters.connect += 1;
      if (connectHang) return new Promise(() => undefined);
      state.connected = true;
      return Promise.resolve(undefined);
    },
    query(statement: string) {
      counters.query.push(statement);
      if (rejectOnStatement === statement) {
        return Promise.reject(new Error("fixed-finite-query-failure"));
      }
      if (lateQueryRejection) {
        return new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("credential-raw-query-late-rejection")),
            35
          );
        });
      }
      return queryHang || hangOnStatement === statement
        ? new Promise(() => undefined)
        : Promise.resolve({ rows: [] });
    },
    end() {
      counters.end += 1;
      state.ended = true;
      state.usable = false;
      return endHang
        ? new Promise(() => undefined)
        : Promise.resolve(undefined);
    },
  };
  return { client, counters, state };
}

const testLegacyOwner = "actustube_ci_usage_legacy_owner";
const testMigrationExecutor = "actustube_ci_usage_migration_executor";
const testFixtureSessionRole = "actustube_ci_fixture";
const testLegacyOwnerOid = "81001";
const testMigrationExecutorOid = "81002";
const testUsageOwnerIdentities = [
  "public.reserve_usage_limits(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.usage_period_boundaries_v1(timestamp with time zone)",
  "public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)",
  "public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.get_usage_status_v1(uuid,integer,timestamp with time zone)",
] as const;

const exactRevokeContracts = [
  {
    label: "revoke-database-create",
    statement: `
      DO $fixture_database_revoke$
      BEGIN
        EXECUTE pg_catalog.format(
          'REVOKE CREATE ON DATABASE %I FROM %I',
          pg_catalog.current_database(),
          '${testMigrationExecutor}'
        );
      END;
      $fixture_database_revoke$;
    `,
    parameters: [],
  },
  {
    label: "revoke-public-executor",
    statement: `REVOKE USAGE, CREATE ON SCHEMA public FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-public-legacy",
    statement: `REVOKE USAGE, CREATE ON SCHEMA public FROM "${testLegacyOwner}"`,
    parameters: [],
  },
  {
    label: "revoke-drizzle-executor",
    statement: `REVOKE USAGE, CREATE ON SCHEMA drizzle FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-ledger-table",
    statement: `REVOKE SELECT, INSERT ON TABLE drizzle.__drizzle_migrations FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-ledger-sequence",
    statement: `REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-legacy-membership",
    statement: `REVOKE "${testLegacyOwner}" FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
] as const;

type ExactRevokeLabel = (typeof exactRevokeContracts)[number]["label"];

function normalizeExactRevokeSql(statement: string) {
  return statement
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function exactRevokeQueryLabel(
  statement: string,
  parameters: unknown[]
): ExactRevokeLabel | null {
  const normalized = normalizeExactRevokeSql(statement);
  const matches = exactRevokeContracts.filter(
    (contract) =>
      normalizeExactRevokeSql(contract.statement) === normalized &&
      JSON.stringify(contract.parameters) === JSON.stringify(parameters)
  );
  return matches.length === 1 ? matches[0].label : null;
}

function validMigrationRolePrecondition(
  overrides: Record<string, unknown> = {}
) {
  return {
    session_role: testFixtureSessionRole,
    effective_role: testMigrationExecutor,
    legacy_function_owner_oid: testLegacyOwnerOid,
    legacy_owner_oid: testLegacyOwnerOid,
    legacy_owner_name: testLegacyOwner,
    migration_executor_oid: testMigrationExecutorOid,
    migration_executor_name: testMigrationExecutor,
    has_legacy_membership: true,
    legacy_owner_restricted: true,
    migration_executor_restricted: true,
    ...overrides,
  };
}

function validInitialMigrationBoundaryRoles() {
  return [
    {
      ordinal: 1,
      role_name: testLegacyOwner,
      role_oid: testLegacyOwnerOid,
      session_role: testFixtureSessionRole,
      effective_role: testFixtureSessionRole,
      role_restricted: true,
      oid_is_separated: true,
    },
    {
      ordinal: 2,
      role_name: testMigrationExecutor,
      role_oid: testMigrationExecutorOid,
      session_role: testFixtureSessionRole,
      effective_role: testFixtureSessionRole,
      role_restricted: true,
      oid_is_separated: true,
    },
  ];
}

function validUsageOwnerPostcondition(): Array<Record<string, any>> {
  return testUsageOwnerIdentities.map((functionIdentity, index) => ({
    function_identity: functionIdentity,
    ordinal: index + 1,
    function_oid: String(82001 + index),
    owner_oid: testLegacyOwnerOid,
    owner_name: testLegacyOwner,
    acl_text: "{fixed_acl}",
    security_definer: false,
    search_path: ["search_path=public, pg_temp"],
  }));
}

function ownerBoundaryQueryLabel(
  statement: string,
  parameters: unknown[] = []
) {
  const exactRevokeLabel = exactRevokeQueryLabel(statement, parameters);
  if (exactRevokeLabel) return exactRevokeLabel;
  if (statement.includes("CREATE ROLE") && statement.includes(testLegacyOwner)) {
    return "create-fixed-roles";
  }
  if (statement.includes("fixture_database_grant")) return "minimal-grants";
  if (statement.startsWith("SET ROLE")) return "set-migration-executor";
  if (statement === "RESET ROLE") return "reset-role";
  if (statement.includes("WITH expected(role_name, ordinal)")) {
    return "initial-role-contract";
  }
  if (statement.includes("AS migration_executor_restricted") &&
      !statement.includes("legacy_function AS")) {
    return "migration-executor-identity";
  }
  if (
    statement.includes("ALTER FUNCTION") &&
    statement.includes("OWNER TO") &&
    !statement.includes("OWNER TO SESSION_USER")
  ) {
    return "legacy-owner-baseline";
  }
  if (statement.trimStart().startsWith("GRANT") &&
      statement.includes(testLegacyOwner) &&
      statement.includes(testMigrationExecutor)) {
    return "legacy-owner-membership";
  }
  if (statement.includes("WITH legacy_function AS")) return "role-precondition";
  if (statement.includes("WITH expected(function_identity, ordinal)")) {
    return "owner-postcondition";
  }
  if (statement.includes("fixed_migration_callback_probe")) {
    return `migration-callback-${String(parameters[0] ?? "unknown")}`;
  }
  if (statement.includes("fixed_before_final_boundary")) {
    return "before-final-boundary";
  }
  if (statement.includes("authority_inventory")) {
    return "temporary-authority-inventory";
  }
  if (statement.includes("unsupported_owned_object")) {
    return "pre-canonical-inventory";
  }
  if (statement.includes("'database'::text AS object_kind")) {
    return "post-canonical-snapshot";
  }
  if (/^ALTER (?:SCHEMA|TABLE|SEQUENCE|TYPE|FUNCTION) /.test(statement)) {
    return "canonical-owner-change";
  }
  if (statement.includes("fixed_postflight_boundary")) {
    return "postflight-boundary";
  }
  return "unknown-fixed-query";
}

function createMigrationOwnerFakeClient({
  initialRoleRows = validInitialMigrationBoundaryRoles(),
  preconditionRows = [validMigrationRolePrecondition()],
  postconditionRows = validUsageOwnerPostcondition(),
  hangOnLabel = null as string | null,
  rejectOnLabel = null as string | null,
} = {}) {
  const state = {
    query: [] as string[],
    parameters: [] as unknown[][],
    labels: [] as string[],
    activeRole: testFixtureSessionRole,
    callbackObservations: [] as Array<{
      kind: string;
      sequence: number;
      client: unknown;
      activeRole: string;
    }>,
    connect: 0,
    end: 0,
    destroy: 0,
    usable: true,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
          state.usable = false;
          state.queriesAtDestroy = state.query.length;
        },
      },
    },
    connect() {
      state.connect += 1;
      return Promise.resolve();
    },
    query(statement: string, parameters: unknown[] = []) {
      state.query.push(statement);
      state.parameters.push(parameters);
      const label = ownerBoundaryQueryLabel(statement, parameters);
      state.labels.push(label);
      if (label === "set-migration-executor") {
        state.activeRole = testMigrationExecutor;
      } else if (label === "reset-role") {
        state.activeRole = testFixtureSessionRole;
      } else if (label.startsWith("migration-callback-")) {
        state.callbackObservations.push({
          kind: label.slice("migration-callback-".length),
          sequence: state.query.length,
          client,
          activeRole: state.activeRole,
        });
      }
      if (label === hangOnLabel) return new Promise(() => undefined);
      if (label === rejectOnLabel) {
        return Promise.reject(new Error("fixed-owner-boundary-failure"));
      }
      if (label === "initial-role-contract") {
        return Promise.resolve({ rows: initialRoleRows });
      }
      if (label === "migration-executor-identity") {
        return Promise.resolve({
          rows: [
            {
              session_role: testFixtureSessionRole,
              effective_role: testMigrationExecutor,
              migration_executor_name: testMigrationExecutor,
              migration_executor_restricted: true,
            },
          ],
        });
      }
      if (label === "role-precondition") {
        return Promise.resolve({ rows: preconditionRows });
      }
      if (label === "owner-postcondition") {
        return Promise.resolve({ rows: postconditionRows });
      }
      return Promise.resolve({ rows: [] });
    },
    end() {
      state.end += 1;
      state.usable = false;
      return Promise.resolve();
    },
  };
  return { client, state };
}

const testRepositoryTables = [
  "analysis_runs",
  "improvement_actions",
  "oauth_accounts",
  "plans",
  "usage_reservation_leases",
  "user_plan_assignments",
  "user_usage_buckets",
  "users",
] as const;
const testRepositoryIndexes = [
  "analysis_runs_id_user_unique",
  "analysis_runs_pkey",
  "analysis_runs_user_analyzed_idx",
  "improvement_actions_analysis_run_unique",
  "improvement_actions_one_planned_per_user",
  "improvement_actions_pkey",
  "improvement_actions_user_updated_idx",
  "oauth_accounts_pkey",
  "oauth_accounts_provider_account_unique",
  "oauth_accounts_user_id_idx",
  "plans_pkey",
  "usage_reservation_leases_created_at_idx",
  "usage_reservation_leases_pkey",
  "usage_reservation_leases_user_metric_idx",
  "user_plan_assignments_one_active_per_user",
  "user_plan_assignments_pkey",
  "user_plan_assignments_plan_code_idx",
  "user_usage_buckets_period_start_idx",
  "user_usage_buckets_pkey",
  "user_usage_buckets_scope_unique",
  "users_pkey",
  "users_status_idx",
] as const;
const testRepositoryEnums = [
  "improvement_action_status",
  "plan_assignment_source",
  "plan_assignment_status",
  "usage_metric",
  "usage_period_kind",
  "user_status",
] as const;
const testCanonicalFunctions = [
  {
    name: "finalize_ai_consult_reservation",
    identity:
      "p_reservation_id uuid, p_user_id uuid, p_analysis_run_id uuid, p_ai_consult_snapshot jsonb, p_created_at timestamp with time zone",
  },
  {
    name: "finalize_channel_analysis_reservation",
    identity:
      "p_reservation_id uuid, p_user_id uuid, p_channel_id character varying, p_channel_title character varying, p_analysis_snapshot jsonb, p_regular_video_count integer, p_short_video_count integer, p_regular_average_views bigint, p_short_average_views bigint, p_analyzed_at timestamp with time zone",
  },
  {
    name: "finalize_usage_reservation",
    identity: "p_reservation_id uuid, p_user_id uuid",
  },
  {
    name: "get_usage_status_v1",
    identity:
      "p_user_id uuid, p_session_version integer, p_now timestamp with time zone",
  },
  {
    name: "recover_stale_usage_reservations",
    identity:
      "p_stale_before timestamp with time zone, p_batch_size integer",
  },
  {
    name: "release_usage_limits",
    identity: "p_reservation_id uuid, p_user_id uuid",
  },
  {
    name: "reserve_usage_limits",
    identity:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
  },
  {
    name: "reserve_usage_limits_v2",
    identity:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
  },
  {
    name: "resolve_effective_usage_plan_v1",
    identity: "p_user_id uuid, p_now timestamp with time zone",
  },
  {
    name: "sync_google_oauth_account",
    identity:
      "p_provider_account_id character varying, p_email character varying, p_name character varying, p_image_url character varying, p_granted_scope text, p_seen_at timestamp with time zone",
  },
  {
    name: "usage_period_boundaries_v1",
    identity: "p_now timestamp with time zone",
  },
] as const;
const testLegacyOwnedFunctionNames = new Set([
  "get_usage_status_v1",
  "reserve_usage_limits",
  "reserve_usage_limits_v2",
  "resolve_effective_usage_plan_v1",
  "usage_period_boundaries_v1",
]);

type TestOwnershipRow = {
  object_kind: string;
  schema_name: string | null;
  object_name: string;
  function_identity: string | null;
  owner_name: string;
};

type TestTemporaryAuthorityRow = {
  authority_kind: string;
  role_name: string;
  role_relation: string | null;
  grantor_name: string | null;
  grantee_name: string | null;
  object_kind: string;
  schema_name: string | null;
  object_name: string;
  column_name: string | null;
  function_identity: string | null;
  privilege_type: string;
  grant_option: boolean;
  granted_role: string | null;
  inherit_option: boolean | null;
  set_option: boolean | null;
};

function sortTestOwnershipRows(rows: TestOwnershipRow[]) {
  const keys = [
    "object_kind",
    "schema_name",
    "object_name",
    "function_identity",
    "owner_name",
  ] as const;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const comparison = String(left[key] ?? "").localeCompare(
        String(right[key] ?? "")
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function sortTestTemporaryAuthorityRows(rows: TestTemporaryAuthorityRow[]) {
  const keys = [
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
  ] as const;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const comparison = String(left[key] ?? "").localeCompare(
        String(right[key] ?? "")
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function testTemporaryAuthorityRow(
  overrides: Partial<TestTemporaryAuthorityRow>
): TestTemporaryAuthorityRow {
  const authorityKind = overrides.authority_kind ?? "explicit_acl";
  const roleName = overrides.role_name ?? testMigrationExecutor;
  const isExplicitAcl = authorityKind === "explicit_acl";
  return {
    authority_kind: authorityKind,
    role_name: roleName,
    role_relation: isExplicitAcl ? "grantee" : null,
    grantor_name: isExplicitAcl ? testFixtureSessionRole : null,
    grantee_name: isExplicitAcl ? roleName : null,
    object_kind: "schema",
    schema_name: null,
    object_name: "fixed_object",
    column_name: null,
    function_identity: null,
    privilege_type: "USAGE",
    grant_option: false,
    granted_role: null,
    inherit_option: null,
    set_option: null,
    ...overrides,
  };
}

function validTemporaryAuthorityRows(): TestTemporaryAuthorityRow[] {
  return sortTestTemporaryAuthorityRows([
    testTemporaryAuthorityRow({
      object_kind: "database",
      object_name: "actustube_ci_fixture",
      privilege_type: "CREATE",
    }),
    ...["CREATE", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        schema_name: "public",
        object_name: "public",
        privilege_type,
      })
    ),
    ...["CREATE", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        role_name: testLegacyOwner,
        schema_name: "public",
        object_name: "public",
        privilege_type,
      })
    ),
    ...["CREATE", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        schema_name: "drizzle",
        object_name: "drizzle",
        privilege_type,
      })
    ),
    ...["INSERT", "SELECT"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        object_kind: "table",
        schema_name: "drizzle",
        object_name: "__drizzle_migrations",
        privilege_type,
      })
    ),
    ...["SELECT", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        object_kind: "sequence",
        schema_name: "drizzle",
        object_name: "__drizzle_migrations_id_seq",
        privilege_type,
      })
    ),
    testTemporaryAuthorityRow({
      authority_kind: "direct_membership",
      object_kind: "role",
      object_name: testLegacyOwner,
      privilege_type: "MEMBER",
      granted_role: testLegacyOwner,
      inherit_option: true,
      set_option: true,
    }),
    testTemporaryAuthorityRow({
      authority_kind: "recursive_membership",
      object_kind: "role",
      object_name: testLegacyOwner,
      privilege_type: "MEMBER",
      granted_role: testLegacyOwner,
    }),
    testTemporaryAuthorityRow({
      authority_kind: "effective_membership",
      object_kind: "role",
      object_name: testLegacyOwner,
      privilege_type: "USAGE",
      granted_role: testLegacyOwner,
    }),
  ]);
}

function grantorSideTemporaryAuthorityRow(
  overrides: Partial<TestTemporaryAuthorityRow>
): TestTemporaryAuthorityRow {
  return testTemporaryAuthorityRow({
    role_name: testMigrationExecutor,
    role_relation: "grantor",
    grantor_name: testMigrationExecutor,
    grantee_name: "unexpected_fixture_grantee",
    ...overrides,
  });
}

function uncoveredAclDependencyRow(
  overrides: Partial<TestTemporaryAuthorityRow> = {}
): TestTemporaryAuthorityRow {
  return testTemporaryAuthorityRow({
    authority_kind: "uncovered_acl_dependency",
    role_name: testMigrationExecutor,
    role_relation: null,
    grantor_name: null,
    grantee_name: null,
    object_kind: "unsupported_acl_dependency",
    schema_name: null,
    object_name: "pg_catalog.pg_class",
    column_name: null,
    function_identity: null,
    privilege_type: "ACL_DEPENDENCY",
    grant_option: false,
    granted_role: null,
    inherit_option: null,
    set_option: null,
    ...overrides,
  });
}

function validPreCanonicalOwnershipRows(): TestOwnershipRow[] {
  return sortTestOwnershipRows([
    ...testRepositoryTables.map((name) => ({
      object_kind: "table",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testMigrationExecutor,
    })),
    ...testRepositoryIndexes.map((name) => ({
      object_kind: "index",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testMigrationExecutor,
    })),
    ...testRepositoryEnums.map((name) => ({
      object_kind: "type",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testMigrationExecutor,
    })),
    ...testCanonicalFunctions.map((entry) => ({
      object_kind: "function",
      schema_name: "public",
      object_name: entry.name,
      function_identity: entry.identity,
      owner_name: testLegacyOwnedFunctionNames.has(entry.name)
        ? testLegacyOwner
        : testMigrationExecutor,
    })),
  ]);
}

function validPostCanonicalOwnershipRows(): TestOwnershipRow[] {
  return sortTestOwnershipRows([
    {
      object_kind: "database",
      schema_name: null,
      object_name: "current_database",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    ...["drizzle", "public"].map((name) => ({
      object_kind: "schema",
      schema_name: name,
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    ...testRepositoryTables.map((name) => ({
      object_kind: "table",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    {
      object_kind: "table",
      schema_name: "drizzle",
      object_name: "__drizzle_migrations",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    ...testRepositoryIndexes.map((name) => ({
      object_kind: "index",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    {
      object_kind: "index",
      schema_name: "drizzle",
      object_name: "__drizzle_migrations_pkey",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    {
      object_kind: "sequence",
      schema_name: "drizzle",
      object_name: "__drizzle_migrations_id_seq",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    ...testRepositoryEnums.map((name) => ({
      object_kind: "type",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    ...testCanonicalFunctions.map((entry) => ({
      object_kind: "function",
      schema_name: "public",
      object_name: entry.name,
      function_identity: entry.identity,
      owner_name: testFixtureSessionRole,
    })),
  ]);
}

type OwnershipCanonicalizationFakeClientOptions = {
  preRows?: TestOwnershipRow[];
  postRows?: TestOwnershipRow[];
  maintenanceRows?: TestOwnershipRow[];
  preAuthorityRows?: TestTemporaryAuthorityRow[];
  postAuthorityRows?: TestTemporaryAuthorityRow[] | null;
  rejectOwnerChangeAt?: number | null;
  hangOwnerChangeAt?: number | null;
  hangOnSnapshot?: boolean;
  hangOnMaintenanceSnapshot?: boolean;
  rejectOnCleanupLabel?: string | null;
  hangOnCleanupLabel?: string | null;
  skipCleanupLabel?: string | null;
  cleanupStatementOverrides?: Partial<Record<ExactRevokeLabel, string>>;
  cleanupParameterOverrides?: Partial<Record<ExactRevokeLabel, unknown[]>>;
  hangOnAuthorityInventoryAt?: number | null;
  events?: string[];
};

function createOwnershipCanonicalizationFakeClient(
  {
    preRows = validPreCanonicalOwnershipRows(),
    postRows = validPostCanonicalOwnershipRows(),
    maintenanceRows,
    preAuthorityRows = validTemporaryAuthorityRows(),
    postAuthorityRows = null as TestTemporaryAuthorityRow[] | null,
    rejectOwnerChangeAt = null as number | null,
    hangOwnerChangeAt = null as number | null,
    hangOnSnapshot = false,
    hangOnMaintenanceSnapshot = false,
    rejectOnCleanupLabel = null as string | null,
    hangOnCleanupLabel = null as string | null,
    skipCleanupLabel = null as string | null,
    cleanupStatementOverrides = {} as Partial<Record<ExactRevokeLabel, string>>,
    cleanupParameterOverrides = {} as Partial<
      Record<ExactRevokeLabel, unknown[]>
    >,
    hangOnAuthorityInventoryAt = null as number | null,
    events = [] as string[],
  }: OwnershipCanonicalizationFakeClientOptions = {}
) {
  const effectiveMaintenanceRows = maintenanceRows ?? postRows;
  const state = {
    connect: 0,
    query: [] as string[],
    parameters: [] as unknown[][],
    labels: [] as string[],
    ownerChanges: [] as string[],
    cleanup: [] as string[],
    snapshotCount: 0,
    authorityInventoryCount: 0,
    authorityRows: [...preAuthorityRows],
    end: 0,
    destroy: 0,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
          state.queriesAtDestroy = state.query.length;
        },
      },
    },
    connect() {
      state.connect += 1;
      return Promise.resolve();
    },
    query(statement: string, parameters: unknown[] = []) {
      const originalRevokeLabel = exactRevokeQueryLabel(statement, parameters);
      const executedStatement = originalRevokeLabel
        ? cleanupStatementOverrides[originalRevokeLabel] ?? statement
        : statement;
      const executedParameters = originalRevokeLabel
        ? cleanupParameterOverrides[originalRevokeLabel] ?? parameters
        : parameters;
      state.query.push(executedStatement);
      state.parameters.push(executedParameters);
      const label = ownerBoundaryQueryLabel(
        executedStatement,
        executedParameters
      );
      state.labels.push(label);
      events.push(label);
      if (label === "pre-canonical-inventory") {
        return Promise.resolve({ rows: preRows });
      }
      if (label === "post-canonical-snapshot") {
        state.snapshotCount += 1;
        const shouldHang =
          (state.snapshotCount === 1 && hangOnSnapshot) ||
          (state.snapshotCount === 2 && hangOnMaintenanceSnapshot);
        return shouldHang
          ? new Promise(() => undefined)
          : Promise.resolve({
              rows:
                state.snapshotCount === 1
                  ? postRows
                  : effectiveMaintenanceRows,
            });
      }
      if (label === "canonical-owner-change") {
        state.ownerChanges.push(executedStatement);
        if (state.ownerChanges.length === hangOwnerChangeAt) {
          return new Promise(() => undefined);
        }
        if (state.ownerChanges.length === rejectOwnerChangeAt) {
          return Promise.reject(new Error("fixed-canonicalization-failure"));
        }
      }
      if (label === "temporary-authority-inventory") {
        state.authorityInventoryCount += 1;
        if (state.authorityInventoryCount === hangOnAuthorityInventoryAt) {
          return new Promise(() => undefined);
        }
        return Promise.resolve({
          rows:
            state.authorityInventoryCount === 1
              ? preAuthorityRows
              : postAuthorityRows ?? state.authorityRows,
        });
      }
      if (label.startsWith("revoke-")) {
        state.cleanup.push(label);
        if (label === hangOnCleanupLabel) return new Promise(() => undefined);
        if (label === rejectOnCleanupLabel) {
          return Promise.reject(new Error("fixed-cleanup-failure"));
        }
        if (label !== skipCleanupLabel) {
          state.authorityRows = state.authorityRows.filter((row) => {
            if (label === "revoke-database-create") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testFixtureSessionRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "database" &&
                row.object_name === "actustube_ci_fixture" &&
                row.privilege_type === "CREATE"
              );
            }
            if (label === "revoke-public-executor") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testFixtureSessionRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "schema" &&
                row.schema_name === "public" &&
                row.object_name === "public" &&
                ["CREATE", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-public-legacy") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testLegacyOwner &&
                row.role_relation === "grantee" &&
                row.grantor_name === testFixtureSessionRole &&
                row.grantee_name === testLegacyOwner &&
                row.object_kind === "schema" &&
                row.schema_name === "public" &&
                row.object_name === "public" &&
                ["CREATE", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-drizzle-executor") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testFixtureSessionRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "schema" &&
                row.schema_name === "drizzle" &&
                row.object_name === "drizzle" &&
                ["CREATE", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-ledger-table") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testFixtureSessionRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "table" &&
                row.schema_name === "drizzle" &&
                row.object_name === "__drizzle_migrations" &&
                ["INSERT", "SELECT"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-ledger-sequence") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testFixtureSessionRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "sequence" &&
                row.schema_name === "drizzle" &&
                row.object_name === "__drizzle_migrations_id_seq" &&
                ["SELECT", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-legacy-membership") {
              return !(
                row.role_name === testMigrationExecutor &&
                row.object_kind === "role" &&
                row.granted_role === testLegacyOwner &&
                row.authority_kind.endsWith("membership")
              );
            }
            return true;
          });
        }
      }
      return Promise.resolve({ rows: [] });
    },
    end() {
      state.end += 1;
      events.push("canonical-close");
      return Promise.resolve();
    },
  };
  return { client, state };
}

function createPostflightBoundaryFakeClient(events: string[] = []) {
  const state = {
    connect: 0,
    query: [] as string[],
    end: 0,
    destroy: 0,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
        },
      },
    },
    connect() {
      state.connect += 1;
      events.push("postflight-connect");
      return Promise.resolve();
    },
    query(statement: string) {
      state.query.push(statement);
      events.push(ownerBoundaryQueryLabel(statement));
      return Promise.resolve({ rows: [] });
    },
    end() {
      state.end += 1;
      events.push("postflight-close");
      return Promise.resolve();
    },
  };
  return { client, state };
}

async function runDirectHarnessInvocation(
  environment: Partial<NodeJS.ProcessEnv> = {}
) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [postgresHarnessModule], {
        env: { ...createSanitizedNodeChildEnvironment(), ...environment },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        rejectChild(new Error("DIRECT_HARNESS_TIMEOUT"));
      }, 5_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectChild(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolveChild({ code, stdout, stderr });
      });
    }
  );
}

describe("connection-only external fixture boundary", () => {
  it("has no database lifecycle authority or lifecycle adapter seam", async () => {
    expect(harnessAuthorityBoundaryForTests()).toEqual({
      databaseProcessAuthority: 0,
      databasePortAuthority: 0,
      databaseFilesystemAuthority: 0,
      databaseTerminationAuthority: 0,
      databaseLifecycleAdapters: 0,
      fixtureOwner: "github_actions_service_container",
      connectionInputs: [
        "ACTUSTUBE_STAGING_HARNESS_DATABASE_URL",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX",
      ],
    });

    const source = await readFile(postgresHarnessModule, "utf8");
    for (const forbidden of [
      "embedded-postgres",
      "EmbeddedPostgres",
      "node:child_process",
      "test-staging-database-fault-lifecycle",
      "runBenignChildLifecycleProbeForTests",
      "spawn(",
      "spawnSync",
      "taskkill",
      "powershell",
      "postmaster.pid",
      "process.kill",
      "mkdtemp",
      "tmpdir",
      "createServer",
      "node:fs",
      "node:net",
      "node:os",
      "databaseDir",
      "persistent: true",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("github_actions_service_container");
    expect(source).toContain("clientFactory");

    const harnessExports = await import(
      "../scripts/test-staging-database-preflight-postgres.mjs"
    );
    expect(Object.keys(harnessExports).sort()).toEqual(
      [
        "EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS",
        "HARNESS_DEADLINE_LIMITS_FOR_TESTS",
        "INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS",
        "TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS",
        "createIndependentDeadlineContextsForTests",
        "externalFixtureSuccessResultForTests",
        "harnessAuthorityBoundaryForTests",
        "runConnectionOnlyHarness",
        "runHarnessDeadlineProbeForTests",
        "runHarnessTransactionBoundaryProbeForTests",
        "runMigrationOwnerBoundaryProbeForTests",
        "runOwnershipCanonicalizationProbeForTests",
        "validateExternalFixtureConfigurationForTests",
        "validateIndependentExtensionInventoryForTests",
      ].sort()
    );

    const connectionFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: externalFixtureEnvironment({
          ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
            "postgresql://actustube_ci_fixture:p@localhost:5432/actustube_ci_fixture",
        }),
        clientFactory: connectionFactory,
      })
    ).rejects.toThrow("EXTERNAL_FIXTURE_URL_INVALID");
    expect(connectionFactory).not.toHaveBeenCalled();

    const faultSource = await readFile(faultLifecycleModule, "utf8");
    expect(faultSource).toContain('from "node:child_process"');
    expect(faultSource).toContain("process.execPath");
    expect(faultSource).toContain("shell: false");
    expect(faultSource).toContain('stdio: ["ignore", "ignore", "ignore", "ipc"]');
    for (const forbidden of [
      "embedded-postgres",
      'from "pg"',
      "drizzle",
      "postgres",
      "node:fs",
      "node:net",
      "createServer",
      "process.kill(",
      "taskkill",
    ]) {
      expect(faultSource.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("fixes every harness-owned deadline at or below the authorized maximum", () => {
    expect(HARNESS_DEADLINE_LIMITS_FOR_TESTS).toMatchObject({
      totalMilliseconds: 300_000,
      connectMilliseconds: 10_000,
      queryMilliseconds: 30_000,
      statementMilliseconds: 20_000,
      lockMilliseconds: 5_000,
      idleTransactionMilliseconds: 20_000,
      closeMilliseconds: 5_000,
    });
    expect(HARNESS_DEADLINE_LIMITS_FOR_TESTS.phaseMilliseconds).toBeLessThanOrEqual(
      HARNESS_DEADLINE_LIMITS_FOR_TESTS.totalMilliseconds
    );
    expect(
      HARNESS_DEADLINE_LIMITS_FOR_TESTS.migrationMilliseconds
    ).toBeLessThanOrEqual(HARNESS_DEADLINE_LIMITS_FOR_TESTS.totalMilliseconds);
  });

  it("exercises the distinct owner boundary in the fixed production order", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    const labels = fake.state.labels;
    expect(result).toMatchObject({
      failureMarker: null,
      timedOut: false,
      activeClientCount: 0,
    });
    expect(labels).toEqual([
      "create-fixed-roles",
      "initial-role-contract",
      "minimal-grants",
      "set-migration-executor",
      "migration-executor-identity",
      "migration-callback-baseline",
      "reset-role",
      "legacy-owner-baseline",
      "legacy-owner-membership",
      "before-final-boundary",
      "set-migration-executor",
      "role-precondition",
      "migration-callback-final",
      "reset-role",
      "owner-postcondition",
      "set-migration-executor",
      "role-precondition",
      "migration-callback-replay",
      "reset-role",
      "owner-postcondition",
    ]);
    expect(result.operationStarts).toMatchObject({
      connect: 1,
      query: 20,
      close: 1,
      migration: 3,
    });
    expect(fake.state).toMatchObject({
      connect: 1,
      end: 1,
      destroy: 0,
      usable: false,
    });
    expect(fake.state.callbackObservations).toHaveLength(3);
    expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
      "baseline",
      "final",
      "replay",
    ]);
    expect(
      fake.state.callbackObservations.every(
        (entry) =>
          entry.client === fake.client &&
          entry.activeRole === testMigrationExecutor
      )
    ).toBe(true);
    const baselineIndex = labels.indexOf("migration-callback-baseline");
    const finalIndex = labels.indexOf("migration-callback-final");
    const replayIndex = labels.indexOf("migration-callback-replay");
    expect(baselineIndex).toBeGreaterThan(labels.indexOf("set-migration-executor"));
    expect(baselineIndex).toBeLessThan(labels.indexOf("reset-role"));
    expect(finalIndex).toBeGreaterThan(labels.indexOf("role-precondition"));
    expect(finalIndex).toBeLessThan(labels.indexOf("reset-role", finalIndex + 1));
    expect(replayIndex).toBeGreaterThan(
      labels.lastIndexOf("role-precondition")
    );
    expect(replayIndex).toBeLessThan(labels.lastIndexOf("reset-role"));
    const preconditionParameterIndexes = labels
      .map((label, index) => (label === "role-precondition" ? index : -1))
      .filter((index) => index >= 0);
    expect(preconditionParameterIndexes).toHaveLength(2);
    for (const index of preconditionParameterIndexes) {
      expect(fake.state.parameters[index]).toEqual([
        testUsageOwnerIdentities[0],
        testLegacyOwner,
        testMigrationExecutor,
      ]);
    }
    const postconditionParameterIndexes = labels
      .map((label, index) => (label === "owner-postcondition" ? index : -1))
      .filter((index) => index >= 0);
    expect(postconditionParameterIndexes).toHaveLength(2);
    for (const index of postconditionParameterIndexes) {
      expect(fake.state.parameters[index]).toEqual([testUsageOwnerIdentities]);
    }
    const grantStatement = fake.state.query[labels.indexOf("minimal-grants")];
    expect(grantStatement).toContain("GRANT USAGE, CREATE ON SCHEMA drizzle");
    expect(grantStatement).toContain(testMigrationExecutor);
    expect(labels.indexOf("minimal-grants")).toBeLessThan(baselineIndex);
    expect(JSON.stringify(result)).not.toMatch(
      /actustube_ci_usage_|alter function|grant create|owner to/i
    );

    const source = await readFile(postgresHarnessModule, "utf8");
    expect(
      source.match(/async function orchestrateUsageMigrationOwnerBoundary/g)
    ).toHaveLength(1);
    expect(source).not.toContain("() => Promise.resolve()");
  });

  it.each([
    ["missing legacy owner", validInitialMigrationBoundaryRoles().slice(1)],
    [
      "duplicate role row",
      [
        validInitialMigrationBoundaryRoles()[0],
        validInitialMigrationBoundaryRoles()[0],
      ],
    ],
    [
      "duplicate role OID",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 1 ? { ...row, role_oid: testLegacyOwnerOid } : row
      ),
    ],
    [
      "noncanonical role OID",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 1 ? { ...row, role_oid: "081002" } : row
      ),
    ],
    [
      "elevated legacy owner",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 0 ? { ...row, role_restricted: false } : row
      ),
    ],
    [
      "session or runtime OID collision",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 0 ? { ...row, oid_is_separated: false } : row
      ),
    ],
    [
      "unknown catalog key",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 1 ? { ...row, unknown_key: true } : row
      ),
    ],
  ])("rejects the initial dual-role contract when %s", async (_label, rows) => {
    const fake = createMigrationOwnerFakeClient({ initialRoleRows: rows });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_INITIAL_ROLE_CONTRACT_MISMATCH"
    );
    expect(fake.state.labels).toEqual([
      "create-fixed-roles",
      "initial-role-contract",
    ]);
    expect(fake.state.callbackObservations).toEqual([]);
    expect(result.operationStarts.migration).toBe(0);
    expect(fake.state.destroy).toBe(0);
    expect(fake.state.end).toBe(1);
  });

  it("grants only the fixed executor USAGE and CREATE on drizzle before baseline Migration", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBeNull();
    const grantIndex = fake.state.labels.indexOf("minimal-grants");
    const grantStatement = fake.state.query[grantIndex];
    expect(grantStatement).toMatch(
      /GRANT USAGE, CREATE ON SCHEMA drizzle\s+TO "actustube_ci_usage_migration_executor";/
    );
    expect(grantStatement).not.toMatch(
      /GRANT USAGE, CREATE ON SCHEMA drizzle[\s\S]*?(?:PUBLIC|actustube_ci_fixture_runtime|actustube_ci_usage_legacy_owner)/
    );
    expect(fake.state.labels.indexOf("initial-role-contract")).toBeLessThan(
      grantIndex
    );
    expect(grantIndex).toBeLessThan(
      fake.state.labels.indexOf("migration-callback-baseline")
    );
  });

  it("rejects a Migration callback that attempts to replace the shared Client", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      callbackScenario: "replace-client",
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_MIGRATION_CALLBACK_REPLACEMENT"
    );
    expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
      "baseline",
    ]);
    expect(fake.state.labels).not.toContain("migration-callback-final");
    expect(fake.state.labels).not.toContain("migration-callback-replay");
  });

  it("starts no later callback after a finite final callback failure", async () => {
    const fake = createMigrationOwnerFakeClient({
      rejectOnLabel: "migration-callback-final",
    });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
      "baseline",
      "final",
    ]);
    expect(fake.state.labels).not.toContain("migration-callback-replay");
    expect(fake.state.labels).not.toContain("owner-postcondition");
  });

  it("starts no reset or later callback after a baseline callback timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = createMigrationOwnerFakeClient({
        hangOnLabel: "migration-callback-baseline",
      });
      const pending = runMigrationOwnerBoundaryProbeForTests({
        client: fake.client,
        expectedSessionRole: testFixtureSessionRole,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(120);
      const result = await pending;
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        destroyed: true,
      });
      expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
        "baseline",
      ]);
      expect(fake.state.labels).not.toContain("reset-role");
      expect(fake.state.labels).not.toContain("migration-callback-final");
      expect(fake.state.labels).not.toContain("migration-callback-replay");
      expect(fake.state.queriesAtDestroy).toBe(fake.state.query.length);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "legacy owner equals Migration executor",
      [
        validMigrationRolePrecondition({
          legacy_function_owner_oid: testMigrationExecutorOid,
          legacy_owner_oid: testMigrationExecutorOid,
          legacy_owner_name: testMigrationExecutor,
        }),
      ],
    ],
    [
      "legacy owner equals session role",
      [validMigrationRolePrecondition({ legacy_owner_name: testFixtureSessionRole })],
    ],
    [
      "legacy function remains owned by Migration executor",
      [
        validMigrationRolePrecondition({
          legacy_function_owner_oid: testMigrationExecutorOid,
        }),
      ],
    ],
    [
      "Migration effective role is legacy owner",
      [validMigrationRolePrecondition({ effective_role: testLegacyOwner })],
    ],
    [
      "legacy membership is missing",
      [validMigrationRolePrecondition({ has_legacy_membership: false })],
    ],
    ["precondition row is missing", []],
    [
      "precondition row is duplicated",
      [validMigrationRolePrecondition(), validMigrationRolePrecondition()],
    ],
    [
      "precondition row has an unknown key",
      [validMigrationRolePrecondition({ unknown_key: true })],
    ],
  ])("rejects %s before the final Migration phase", async (_label, rows) => {
    const fake = createMigrationOwnerFakeClient({ preconditionRows: rows });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_MIGRATION_ROLE_PRECONDITION_MISMATCH"
    );
    const labels = fake.state.labels;
    expect(labels).toContain("role-precondition");
    expect(labels).not.toContain("owner-postcondition");
    expect(result.operationStarts.migration).toBe(1);
    expect(fake.state.destroy).toBe(0);
    expect(fake.state.end).toBe(1);
  });

  it.each([
    [
      "all targets owned by Migration executor",
      validUsageOwnerPostcondition().map((row) => ({
        ...row,
        owner_oid: testMigrationExecutorOid,
        owner_name: testMigrationExecutor,
      })),
    ],
    [
      "all targets owned by session role",
      validUsageOwnerPostcondition().map((row) => ({
        ...row,
        owner_oid: "81003",
        owner_name: testFixtureSessionRole,
      })),
    ],
    [
      "one target owner name mismatch",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 3 ? { ...row, owner_name: "actustube_ci_wrong_owner" } : row
      ),
    ],
    [
      "one target owner OID mismatch",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 4 ? { ...row, owner_oid: "81999" } : row
      ),
    ],
    [
      "duplicate function OID",
      validUsageOwnerPostcondition().map((row, index, rows) =>
        index === 4 ? { ...row, function_oid: rows[0].function_oid } : row
      ),
    ],
    [
      "zero function OID",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 1 ? { ...row, function_oid: "0" } : row
      ),
    ],
    [
      "negative function OID",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 2 ? { ...row, function_oid: "-1" } : row
      ),
    ],
    [
      "noncanonical function OID",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 3 ? { ...row, function_oid: "082004" } : row
      ),
    ],
    [
      "one SECURITY DEFINER function",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 2 ? { ...row, security_definer: true } : row
      ),
    ],
    ["one function missing", validUsageOwnerPostcondition().slice(0, -1)],
    [
      "one unknown function",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 4
          ? { ...row, function_identity: "public.unknown_fixture_function()" }
          : row
      ),
    ],
  ])("rejects the owner postcondition when %s", async (_label, rows) => {
    const fake = createMigrationOwnerFakeClient({ postconditionRows: rows });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_OWNER_POSTCONDITION_MISMATCH"
    );
    expect(fake.state.labels).toContain("owner-postcondition");
    expect(fake.state.destroy).toBe(0);
    expect(fake.state.end).toBe(1);
  });

  it("starts no reset, owner, grant, or postcondition query after a role precondition timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = createMigrationOwnerFakeClient({
        hangOnLabel: "role-precondition",
      });
      const pending = runMigrationOwnerBoundaryProbeForTests({
        client: fake.client,
        expectedSessionRole: testFixtureSessionRole,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(120);
      const result = await pending;
      const labels = fake.state.labels;
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        activeClientCount: 0,
        destroyed: true,
      });
      expect(labels.at(-1)).toBe("role-precondition");
      expect(labels.filter((label) => label === "reset-role")).toHaveLength(1);
      expect(labels).not.toContain("owner-postcondition");
      expect(fake.state.queriesAtDestroy).toBe(fake.state.query.length);
      expect(fake.state.destroy).toBe(1);
      expect(fake.state.end).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds every explicit ACL catalog branch to grantor and grantee coverage with a shared-dependency backstop", () => {
    const sql = TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS;
    const aclSources = [
      "database_entry.datacl",
      "namespace_entry.nspacl",
      "relation_entry.relacl",
      "attribute_entry.attacl",
      "procedure_entry.proacl",
      "type_entry.typacl",
      "default_acl.defaclacl",
    ];
    for (const source of aclSources) {
      expect(sql).toContain(`aclexplode(${source})`);
    }
    expect(
      sql.match(
        /target_role\.oid = acl\.grantee OR target_role\.oid = acl\.grantor/g
      )
    ).toHaveLength(14);
    expect(sql).toContain("dependency_entry.deptype = 'a'");
    expect(sql).toContain("coverage.dbid = dependency_entry.dbid");
    expect(sql).toContain("coverage.classid = dependency_entry.classid");
    expect(sql).toContain("coverage.objid = dependency_entry.objid");
    expect(sql).toContain("coverage.objsubid = dependency_entry.objsubid");
    expect(sql).toContain(
      "coverage.target_role_oid = dependency_entry.refobjid"
    );
    expect(sql).toContain("attribute_entry.attrelid");
    expect(sql).toContain("attribute_entry.attnum::integer");
    expect(sql).toContain("dependency_entry.deptype = 'o'");
  });

  it("canonicalizes only the fixed repository objects before starting postflight once", async () => {
    const events: string[] = [];
    const canonical = createOwnershipCanonicalizationFakeClient({ events });
    const postflight = createPostflightBoundaryFakeClient(events);
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result).toMatchObject({
      failureMarker: null,
      timedOut: false,
      activeClientCount: 0,
    });
    expect(canonical.state.labels[0]).toBe("pre-canonical-inventory");
    expect(canonical.state.labels.at(-1)).toBe("post-canonical-snapshot");
    expect(canonical.state.snapshotCount).toBe(2);
    expect(canonical.state.authorityInventoryCount).toBe(2);
    expect(validTemporaryAuthorityRows()).toHaveLength(14);
    const expectedAclRows = validTemporaryAuthorityRows().filter(
      (row) => row.authority_kind === "explicit_acl"
    );
    expect(expectedAclRows).toHaveLength(11);
    expect(
      expectedAclRows.every(
        (row) =>
          row.role_relation === "grantee" &&
          row.grantor_name === testFixtureSessionRole &&
          row.grantee_name === row.role_name &&
          [testMigrationExecutor, testLegacyOwner].includes(row.role_name)
      )
    ).toBe(true);
    expect(canonical.state.cleanup).toEqual([
      "revoke-database-create",
      "revoke-public-executor",
      "revoke-public-legacy",
      "revoke-drizzle-executor",
      "revoke-ledger-table",
      "revoke-ledger-sequence",
      "revoke-legacy-membership",
    ]);
    const observedRevokeQueries = canonical.state.labels.flatMap(
      (label, index) =>
        label.startsWith("revoke-")
          ? [
              {
                label,
                statement: canonical.state.query[index],
                parameters: canonical.state.parameters[index],
              },
            ]
          : []
    );
    expect(observedRevokeQueries).toHaveLength(7);
    expect(
      observedRevokeQueries.map(({ label, statement, parameters }) => ({
        label,
        statement: normalizeExactRevokeSql(statement),
        parameters,
      }))
    ).toEqual(
      exactRevokeContracts.map(({ label, statement, parameters }) => ({
        label,
        statement: normalizeExactRevokeSql(statement),
        parameters: [...parameters],
      }))
    );
    expect(canonical.state.authorityRows).toEqual([]);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
    expect(canonical.state.ownerChanges).toHaveLength(29);
    expect(
      canonical.state.ownerChanges.every(
        (statement) =>
          statement.endsWith("OWNER TO SESSION_USER") &&
          !statement.includes("REASSIGN OWNED")
      )
    ).toBe(true);
    for (const tableName of testRepositoryTables) {
      expect(canonical.state.ownerChanges).toContain(
        `ALTER TABLE "public"."${tableName}" OWNER TO SESSION_USER`
      );
    }
    for (const enumName of testRepositoryEnums) {
      expect(canonical.state.ownerChanges).toContain(
        `ALTER TYPE "public"."${enumName}" OWNER TO SESSION_USER`
      );
    }
    for (const entry of testCanonicalFunctions) {
      expect(
        canonical.state.ownerChanges.some((statement) =>
          statement.startsWith(`ALTER FUNCTION "public"."${entry.name}"(`)
        )
      ).toBe(true);
    }
    expect(canonical.state.ownerChanges).toContain(
      'ALTER SCHEMA "public" OWNER TO SESSION_USER'
    );
    expect(canonical.state.ownerChanges).toContain(
      'ALTER SCHEMA "drizzle" OWNER TO SESSION_USER'
    );
    expect(canonical.state.ownerChanges).toContain(
      'ALTER TABLE "drizzle"."__drizzle_migrations" OWNER TO SESSION_USER'
    );
    expect(canonical.state.ownerChanges).toContain(
      'ALTER SEQUENCE "drizzle"."__drizzle_migrations_id_seq" OWNER TO SESSION_USER'
    );
    expect(canonical.state.parameters[0]).toEqual([
      [testLegacyOwner, testMigrationExecutor],
    ]);
    expect(canonical.state.parameters.at(-1)).toEqual([["drizzle", "public"]]);
    expect(postflight.state).toEqual({
      connect: 1,
      query: [
        "SELECT 'fixed_postflight_boundary'::text AS fixed_boundary_probe",
      ],
      end: 1,
      destroy: 0,
    });
    expect(events.lastIndexOf("post-canonical-snapshot")).toBeLessThan(
      events.indexOf("canonical-close")
    );
    expect(events.lastIndexOf("temporary-authority-inventory")).toBeLessThan(
      events.lastIndexOf("post-canonical-snapshot")
    );
    expect(events.indexOf("canonical-close")).toBeLessThan(
      events.indexOf("postflight-connect")
    );
    expect(events.filter((event) => event === "postflight-boundary")).toHaveLength(
      1
    );
  });

  it.each([
    ["missing expected authority", validTemporaryAuthorityRows().slice(1)],
    [
      "extra database authority",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "database",
          object_name: "other_database",
          privilege_type: "CONNECT",
        }),
      ]),
    ],
    [
      "duplicate authority",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        validTemporaryAuthorityRows()[0],
      ]),
    ],
    [
      "wrong privilege",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, privilege_type: "CONNECT" } : row
        )
      ),
    ],
    [
      "grant option",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, grant_option: true } : row
        )
      ),
    ],
    [
      "wrong object",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, object_name: "wrong_database" } : row
        )
      ),
    ],
    [
      "wrong grantee",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, grantee_name: testLegacyOwner } : row
        )
      ),
    ],
    [
      "wrong grantor",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, grantor_name: testMigrationExecutor } : row
        )
      ),
    ],
    [
      "unknown ACL relation",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, role_relation: "unknown" } : row
        )
      ),
    ],
    ...([
      [
        "grantor-only database ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "database",
          object_name: "actustube_ci_fixture",
          privilege_type: "CREATE",
        }),
      ],
      [
        "grantor-only schema ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
      ],
      [
        "grantor-only relation ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "table",
          schema_name: "drizzle",
          object_name: "__drizzle_migrations",
          privilege_type: "SELECT",
        }),
      ],
      [
        "grantor-only column ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "column",
          schema_name: "public",
          object_name: "users",
          column_name: "email",
          privilege_type: "SELECT",
        }),
      ],
      [
        "grantor-only function ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "function",
          schema_name: "public",
          object_name: "reserve_usage_limits",
          function_identity:
            "uuid,integer,usage_metric,timestamp with time zone",
          privilege_type: "EXECUTE",
        }),
      ],
      [
        "grantor-only type ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "type",
          schema_name: "public",
          object_name: "usage_metric",
        }),
      ],
      [
        "grantor-only default ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "default_acl",
          schema_name: "public",
          object_name: "r",
          privilege_type: "SELECT",
        }),
      ],
      [
        "grantor-only ACL to PUBLIC",
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
          grantee_name: "PUBLIC",
        }),
      ],
      [
        "grantor-and-grantee ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
          role_relation: "both",
          grantee_name: testMigrationExecutor,
        }),
      ],
    ] as Array<[string, TestTemporaryAuthorityRow]>).map(
      ([label, row]): [string, TestTemporaryAuthorityRow[]] => [
        label,
        sortTestTemporaryAuthorityRows([
          ...validTemporaryAuthorityRows(),
          row,
        ]),
      ]
    ),
    [
      "duplicate grantor row",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
      ]),
    ],
    [
      "uncovered ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow(),
      ]),
    ],
    [
      "unknown catalog ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow({ object_name: "pg_catalog.pg_unknown" }),
      ]),
    ],
    [
      "column ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow({ column_name: "column" }),
      ]),
    ],
    [
      "duplicate ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow(),
        uncoveredAclDependencyRow(),
      ]),
    ],
    [
      "column ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "column",
          schema_name: "public",
          object_name: "users",
          column_name: "email",
          privilege_type: "SELECT",
        }),
      ]),
    ],
    [
      "function ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "function",
          schema_name: "public",
          object_name: "reserve_usage_limits",
          function_identity: "uuid,integer,usage_metric,timestamp with time zone",
          privilege_type: "EXECUTE",
        }),
      ]),
    ],
    [
      "type ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "type",
          schema_name: "public",
          object_name: "usage_metric",
          privilege_type: "USAGE",
        }),
      ]),
    ],
    [
      "default ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "default_acl",
          schema_name: "public",
          object_name: "r",
          privilege_type: "SELECT",
        }),
      ]),
    ],
    [
      "wrong direct membership options",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row) =>
          row.authority_kind === "direct_membership"
            ? { ...row, grant_option: true, set_option: false }
            : row
        )
      ),
    ],
    [
      "unexpected recursive membership",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          authority_kind: "recursive_membership",
          object_kind: "role",
          object_name: "unexpected_parent_role",
          privilege_type: "MEMBER",
          granted_role: "unexpected_parent_role",
        }),
      ]),
    ],
    [
      "owned object",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "table",
          schema_name: "public",
          object_name: "unexpected_owned_table",
          privilege_type: "OWNER",
        }),
      ]),
    ],
    [
      "unsupported shared ownership",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "unsupported_owned_object",
          object_name: "pg_subscription",
          privilege_type: "OWNER",
        }),
      ]),
    ],
    [
      "unknown row key",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0
            ? ({ ...row, unexpected_key: "blocked" } as TestTemporaryAuthorityRow)
            : row
        )
      ),
    ],
  ])(
    "stops before cleanup when the temporary-authority inventory has %s",
    async (_label, preAuthorityRows) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        preAuthorityRows,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        client: canonical.client,
        postflightClient: postflight.client,
        expectedSessionRole: testFixtureSessionRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_PRE_CLEANUP_AUTHORITY_MISMATCH"
      );
      expect(result).toMatchObject({
        timedOut: false,
        activeClientCount: 0,
      });
      expect(canonical.state.cleanup).toEqual([]);
      expect(canonical.state.authorityInventoryCount).toBe(1);
      expect(canonical.state.end).toBe(1);
      expect(canonical.state.destroy).toBe(0);
      expect(postflight.state.connect).toBe(0);
    }
  );

  it.each([
    [
      "database ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "database"
        )!,
      ],
    ],
    [
      "schema ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "schema"
        )!,
      ],
    ],
    [
      "table ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "table"
        )!,
      ],
    ],
    [
      "sequence ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "sequence"
        )!,
      ],
    ],
    [
      "column ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "column",
          schema_name: "public",
          object_name: "users",
          column_name: "email",
          privilege_type: "SELECT",
        }),
      ],
    ],
    [
      "function ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "function",
          schema_name: "public",
          object_name: "reserve_usage_limits",
          function_identity:
            "uuid,integer,usage_metric,timestamp with time zone",
          privilege_type: "EXECUTE",
        }),
      ],
    ],
    [
      "type ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "type",
          schema_name: "public",
          object_name: "usage_metric",
        }),
      ],
    ],
    [
      "default ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "default_acl",
          schema_name: "public",
          object_name: "r",
          privilege_type: "SELECT",
        }),
      ],
    ],
    [
      "direct membership",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.authority_kind === "direct_membership"
        )!,
      ],
    ],
    [
      "recursive membership",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.authority_kind === "recursive_membership"
        )!,
      ],
    ],
    [
      "effective membership",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.authority_kind === "effective_membership"
        )!,
      ],
    ],
    [
      "owned object",
      [
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "table",
          schema_name: "public",
          object_name: "unexpected_owned_table",
          privilege_type: "OWNER",
        }),
      ],
    ],
    [
      "unsupported owned object",
      [
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "unsupported_owned_object",
          object_name: "pg_subscription",
          privilege_type: "OWNER",
        }),
      ],
    ],
    [
      "grantor-side ACL residue",
      [
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
      ],
    ],
    ["uncovered ACL dependency", [uncoveredAclDependencyRow()]],
    [
      "column ACL dependency",
      [uncoveredAclDependencyRow({ column_name: "column" })],
    ],
    [
      "unknown row key",
      [
        {
          ...testTemporaryAuthorityRow({
            object_kind: "column",
            schema_name: "public",
            object_name: "users",
            column_name: "email",
            privilege_type: "SELECT",
          }),
          unexpected_key: "blocked",
        } as TestTemporaryAuthorityRow,
      ],
    ],
    [
      "duplicate residue",
      [validTemporaryAuthorityRows()[0], validTemporaryAuthorityRows()[0]],
    ],
  ])(
    "does not start postflight when cleanup leaves %s",
    async (_label, postAuthorityRows) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        postAuthorityRows,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        client: canonical.client,
        postflightClient: postflight.client,
        expectedSessionRole: testFixtureSessionRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
      );
      expect(result).toMatchObject({
        timedOut: false,
        activeClientCount: 0,
      });
      expect(canonical.state.cleanup).toHaveLength(7);
      expect(canonical.state.snapshotCount).toBe(1);
      expect(canonical.state.labels.at(-1)).toBe(
        "temporary-authority-inventory"
      );
      expect(canonical.state.end).toBe(1);
      expect(canonical.state.destroy).toBe(0);
      expect(postflight.state.connect).toBe(0);
    }
  );

  it.each([
    ["ledger privileges", "revoke-ledger-table", 2],
    ["legacy membership", "revoke-legacy-membership", 3],
  ])(
    "proves the success fixture depends on the %s revoke",
    async (_label, skipCleanupLabel, expectedResidueCount) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        skipCleanupLabel,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        client: canonical.client,
        postflightClient: postflight.client,
        expectedSessionRole: testFixtureSessionRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
      );
      expect(canonical.state.authorityRows).toHaveLength(expectedResidueCount);
      expect(postflight.state.connect).toBe(0);
    }
  );

  it.each([
    [
      "wrong database DO body",
      "revoke-database-create",
      exactRevokeContracts[0].statement.replace(
        "REVOKE CREATE",
        "REVOKE CONNECT"
      ),
    ],
    [
      "wrong database role",
      "revoke-database-create",
      exactRevokeContracts[0].statement.replace(
        testMigrationExecutor,
        "wrong_fixture_role"
      ),
    ],
    [
      "missing current_database()",
      "revoke-database-create",
      exactRevokeContracts[0].statement.replace(
        "pg_catalog.current_database()",
        "'actustube_ci_fixture'"
      ),
    ],
    [
      "wrong schema",
      "revoke-public-executor",
      `REVOKE USAGE, CREATE ON SCHEMA private FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong public-schema role",
      "revoke-public-executor",
      'REVOKE USAGE, CREATE ON SCHEMA public FROM "wrong_fixture_role"',
    ],
    [
      "wrong drizzle-schema role",
      "revoke-drizzle-executor",
      'REVOKE USAGE, CREATE ON SCHEMA drizzle FROM "wrong_fixture_role"',
    ],
    [
      "wrong table",
      "revoke-ledger-table",
      `REVOKE SELECT, INSERT ON TABLE drizzle.wrong_ledger FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong table role",
      "revoke-ledger-table",
      'REVOKE SELECT, INSERT ON TABLE drizzle.__drizzle_migrations FROM "wrong_fixture_role"',
    ],
    [
      "wrong sequence",
      "revoke-ledger-sequence",
      `REVOKE USAGE, SELECT ON SEQUENCE drizzle.wrong_sequence FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong sequence role",
      "revoke-ledger-sequence",
      'REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "wrong_fixture_role"',
    ],
    [
      "wrong privilege",
      "revoke-ledger-table",
      `REVOKE SELECT, UPDATE ON TABLE drizzle.__drizzle_migrations FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong privilege order",
      "revoke-ledger-table",
      `REVOKE INSERT, SELECT ON TABLE drizzle.__drizzle_migrations FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong membership granted role",
      "revoke-legacy-membership",
      `REVOKE "wrong_granted_role" FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong membership member role",
      "revoke-legacy-membership",
      `REVOKE "${testLegacyOwner}" FROM "wrong_member_role"`,
    ],
    [
      "reversed membership direction",
      "revoke-legacy-membership",
      `REVOKE "${testMigrationExecutor}" FROM "${testLegacyOwner}"`,
    ],
    [
      "marker only",
      "revoke-database-create",
      "SELECT 'fixture_database_revoke'::text",
    ],
    [
      "prefix only",
      "revoke-ledger-table",
      "REVOKE SELECT, INSERT ON TABLE drizzle.",
    ],
    [
      "extra trailing executable SQL",
      "revoke-ledger-sequence",
      `REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "${testMigrationExecutor}"; SELECT 1`,
    ],
  ] as const)(
    "keeps authority residue and blocks postflight for %s",
    async (_caseName, label, wrongStatement) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        cleanupStatementOverrides: { [label]: wrongStatement },
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        client: canonical.client,
        postflightClient: postflight.client,
        expectedSessionRole: testFixtureSessionRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
      );
      expect(canonical.state.cleanup).not.toContain(label);
      expect(canonical.state.authorityRows.length).toBeGreaterThan(0);
      expect(postflight.state.connect).toBe(0);
      expect(result).not.toHaveProperty("temporaryAuthorityCleanup");
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain("REVOKE");
      expect(publicResult).not.toContain(testFixtureSessionRole);
      expect(publicResult).not.toContain(testMigrationExecutor);
      expect(publicResult).not.toContain(testLegacyOwner);
    }
  );

  it("requires the exact empty parameter contract before mutating fake authority state", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      cleanupParameterOverrides: { "revoke-ledger-table": ["unexpected"] },
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
    );
    expect(canonical.state.cleanup).not.toContain("revoke-ledger-table");
    expect(canonical.state.authorityRows).toHaveLength(2);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    "revoke-database-create",
    "revoke-public-executor",
    "revoke-public-legacy",
    "revoke-drizzle-executor",
    "revoke-ledger-table",
    "revoke-ledger-sequence",
    "revoke-legacy-membership",
  ])("fails closed when %s rejects", async (rejectOnCleanupLabel) => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      rejectOnCleanupLabel,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(result).toMatchObject({
      timedOut: false,
      activeClientCount: 0,
    });
    expect(canonical.state.cleanup.at(-1)).toBe(rejectOnCleanupLabel);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
    expect(postflight.state.connect).toBe(0);
  });

  it("rechecks canonical owners after the zero-residue snapshot", async () => {
    const maintenanceRows = validPostCanonicalOwnershipRows().map((row, index) =>
      index === 0 ? { ...row, owner_name: testMigrationExecutor } : row
    );
    const canonical = createOwnershipCanonicalizationFakeClient({
      maintenanceRows,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_POST_CANONICAL_SNAPSHOT_MISMATCH"
    );
    expect(canonical.state.authorityRows).toEqual([]);
    expect(canonical.state.snapshotCount).toBe(2);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["missing object", validPreCanonicalOwnershipRows().slice(1)],
    [
      "extra object",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "table",
          schema_name: "public",
          object_name: "unexpected_table",
          function_identity: null,
          owner_name: testMigrationExecutor,
        },
      ],
    ],
    [
      "duplicate object",
      [
        ...validPreCanonicalOwnershipRows(),
        validPreCanonicalOwnershipRows()[0],
      ],
    ],
    [
      "unexpected object kind",
      validPreCanonicalOwnershipRows().map((row, index) =>
        index === 0 ? { ...row, object_kind: "unexpected_relation" } : row
      ),
    ],
    [
      "unexpected executor-owned object",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "function",
          schema_name: "public",
          object_name: "unexpected_executor_function",
          function_identity: "",
          owner_name: testMigrationExecutor,
        },
      ],
    ],
    [
      "unexpected legacy-owned object",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "sequence",
          schema_name: "public",
          object_name: "unexpected_legacy_sequence",
          function_identity: null,
          owner_name: testLegacyOwner,
        },
      ],
    ],
    [
      "shared database ownership",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "shared_database",
          schema_name: null,
          object_name: "current_database",
          function_identity: null,
          owner_name: testMigrationExecutor,
        },
      ],
    ],
    [
      "owner mismatch",
      validPreCanonicalOwnershipRows().map((row, index) =>
        index === 0 ? { ...row, owner_name: testFixtureSessionRole } : row
      ),
    ],
  ])("stops before owner changes when pre-canonical inventory has %s", async (_label, rows) => {
    const canonical = createOwnershipCanonicalizationFakeClient({ preRows: rows });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_PRE_CANONICAL_INVENTORY_MISMATCH"
    );
    expect(canonical.state.ownerChanges).toEqual([]);
    expect(postflight.state).toEqual({
      connect: 0,
      query: [],
      end: 0,
      destroy: 0,
    });
  });

  it("does not start postflight after a finite canonicalization failure", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      rejectOwnerChangeAt: 5,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(canonical.state.ownerChanges).toHaveLength(5);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["missing object", validPostCanonicalOwnershipRows().slice(1)],
    [
      "duplicate object",
      [
        ...validPostCanonicalOwnershipRows(),
        validPostCanonicalOwnershipRows()[0],
      ],
    ],
    [
      "executor residue",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 1 ? { ...row, owner_name: testMigrationExecutor } : row
      ),
    ],
    [
      "legacy owner residue",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 2 ? { ...row, owner_name: testLegacyOwner } : row
      ),
    ],
    [
      "unknown owner",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 3 ? { ...row, owner_name: "unknown_fixture_owner" } : row
      ),
    ],
    [
      "session owner mismatch",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 4 ? { ...row, owner_name: "wrong_session_owner" } : row
      ),
    ],
  ])("does not start postflight when post-canonical snapshot has %s", async (_label, rows) => {
    const canonical = createOwnershipCanonicalizationFakeClient({ postRows: rows });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_POST_CANONICAL_SNAPSHOT_MISMATCH"
    );
    expect(canonical.state.ownerChanges).toHaveLength(29);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["owner change", { hangOwnerChangeAt: 5 }],
    ["post-canonical snapshot", { hangOnSnapshot: true }],
    ["pre-cleanup authority inventory", { hangOnAuthorityInventoryAt: 1 }],
    [
      "temporary authority cleanup",
      { hangOnCleanupLabel: "revoke-ledger-table" },
    ],
    ["zero-residue snapshot", { hangOnAuthorityInventoryAt: 2 }],
    ["maintenance owner snapshot", { hangOnMaintenanceSnapshot: true }],
  ])("bounds a %s timeout and preserves an unrelated Client", async (_label, options) => {
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const canonical = createOwnershipCanonicalizationFakeClient(options);
    const postflight = createPostflightBoundaryFakeClient();
    const unrelated = createDeadlineFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      client: canonical.client,
      postflightClient: postflight.client,
      unrelatedClient: unrelated.client,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits: {
        totalMilliseconds: 100,
        connectMilliseconds: 20,
        queryMilliseconds: 10,
        closeMilliseconds: 20,
        phaseMilliseconds: 20,
        migrationMilliseconds: 20,
      },
    });
    expect(result).toMatchObject({
      failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
      timedOut: true,
      activeClientCount: 0,
    });
    expect(canonical.state.destroy).toBe(1);
    expect(canonical.state.queriesAtDestroy).toBe(canonical.state.query.length);
    expect(postflight.state.connect).toBe(0);
    expect(unrelated.counters).toEqual({
      connect: 1,
      query: [],
      end: 1,
      destroy: 0,
    });
    expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
  });

  it.each([
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
  ] as const)(
    "bounds the non-settling fake Client case %s and destroys only the owned socket",
    async (scenario) => {
      vi.useFakeTimers();
      try {
        const fake = createDeadlineFakeClient({
          connectHang: scenario === "connect-hang",
          queryHang: [
            "raw-query-hang",
            "independent-inventory-hang",
            "cleanup-query-hang",
          ].includes(scenario),
          hangOnStatement:
            scenario === "transaction-hang"
              ? "SELECT fixed_transaction_body_probe"
              : null,
          endHang: scenario === "end-hang",
        });
        const pending = runHarnessDeadlineProbeForTests({
          scenario,
          client: fake.client,
          deadlineLimits: {
            totalMilliseconds: 100,
            connectMilliseconds: 20,
            queryMilliseconds: 20,
            closeMilliseconds: 20,
            phaseMilliseconds: 20,
            migrationMilliseconds: 20,
          },
        });
        await vi.advanceTimersByTimeAsync(120);
        const result = await pending;
        expect(result).toMatchObject({
          scenario,
          failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
          finiteFailure: true,
          destroyCount: 1,
          activeClientCount: 0,
          postTimeoutOperationStarts: 0,
        });
        expect(fake.counters.destroy).toBe(1);
        expect(fake.counters.query).not.toContain("SELECT blocked_after_timeout");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("isolates a timed-out Client from a simultaneously registered unrelated context", async () => {
    vi.useFakeTimers();
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    try {
      const target = createDeadlineFakeClient({
        hangOnStatement: "SELECT fixed_independent_context_probe",
      });
      const unrelated = createDeadlineFakeClient();
      const contexts = await createIndependentDeadlineContextsForTests({
        targetClient: target.client,
        unrelatedClient: unrelated.client,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      expect(contexts.inspectTargetForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 1,
        registered: true,
        usable: true,
        destroyed: false,
      });
      expect(contexts.inspectUnrelatedForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 1,
        registered: true,
        usable: true,
        destroyed: false,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(await contexts.targetOperation).toBe(
        "EXTERNAL_FIXTURE_OPERATION_TIMEOUT"
      );
      expect(target.counters).toMatchObject({
        connect: 1,
        query: ["SELECT fixed_independent_context_probe"],
        end: 0,
        destroy: 1,
      });
      expect(target.state).toMatchObject({
        usable: false,
        destroyed: true,
        queriesAtDestroy: 1,
      });
      expect(contexts.inspectTargetForTests()).toMatchObject({
        timedOut: true,
        activeClientCount: 0,
        registered: false,
        usable: false,
        destroyed: true,
        destroyCount: 1,
        operationStarts: { connect: 1, query: 1, close: 0 },
      });
      expect(unrelated.counters).toEqual({
        connect: 1,
        query: [],
        end: 0,
        destroy: 0,
      });
      expect(unrelated.state).toMatchObject({
        usable: true,
        destroyed: false,
        ended: false,
      });
      expect(contexts.inspectUnrelatedForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 1,
        registered: true,
        usable: true,
        destroyed: false,
        operationStarts: { connect: 1, query: 0, close: 0 },
      });

      await contexts.closeUnrelatedForTests();
      expect(unrelated.counters).toEqual({
        connect: 1,
        query: [],
        end: 1,
        destroy: 0,
      });
      expect(contexts.inspectUnrelatedForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 0,
        registered: false,
        usable: false,
        destroyed: false,
        closed: true,
        operationStarts: { connect: 1, query: 0, close: 1 },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses withRollback and starts no ROLLBACK after a transaction body timeout", async () => {
    vi.useFakeTimers();
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    try {
      const fake = createDeadlineFakeClient({
        hangOnStatement: "SELECT fixed_transaction_body_probe",
      });
      const pending = runHarnessTransactionBoundaryProbeForTests({
        client: fake.client,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;
      expect(fake.counters.query).toEqual([
        "BEGIN",
        "SELECT fixed_transaction_body_probe",
      ]);
      expect(fake.counters.query.filter((query) => query === "ROLLBACK")).toHaveLength(
        0
      );
      expect(fake.counters.query.filter((query) => query === "COMMIT")).toHaveLength(
        0
      );
      expect(fake.counters).toMatchObject({ end: 0, destroy: 1 });
      expect(fake.state.queriesAtDestroy).toBe(2);
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        activeClientCount: 0,
        destroyed: true,
        closed: false,
        operationStarts: { connect: 1, query: 2, close: 0 },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same withRollback path and performs one rollback for a finite body error", async () => {
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const fake = createDeadlineFakeClient({
      rejectOnStatement: "SELECT fixed_transaction_body_probe",
    });
    const result = await runHarnessTransactionBoundaryProbeForTests({
      client: fake.client,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(fake.counters.query).toEqual([
      "BEGIN",
      "SELECT fixed_transaction_body_probe",
      "ROLLBACK",
    ]);
    expect(fake.counters.query.filter((query) => query === "ROLLBACK")).toHaveLength(
      1
    );
    expect(fake.counters.query.filter((query) => query === "COMMIT")).toHaveLength(
      0
    );
    expect(fake.counters).toMatchObject({ end: 1, destroy: 0 });
    expect(result).toMatchObject({
      failureMarker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED",
      timedOut: false,
      activeClientCount: 0,
      destroyed: false,
      closed: true,
      operationStarts: { connect: 1, query: 3, close: 1 },
    });
    expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
  });

  it("uses a short real timer for a non-settling query and handles its late rejection", async () => {
    const fake = createDeadlineFakeClient({ lateQueryRejection: true });
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    const beforeListeners = process.listenerCount("unhandledRejection");
    process.on("unhandledRejection", listener);
    try {
      const result = await runHarnessDeadlineProbeForTests({
        scenario: "raw-query-hang",
        client: fake.client,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 10,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        finiteFailure: true,
        destroyCount: 1,
        activeClientCount: 0,
        postTimeoutOperationStarts: 0,
      });
      expect(result.elapsedMilliseconds).toBeLessThan(1_000);
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(
        /credential|late-rejection|select fixed_deadline_probe/i
      );
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(process.listenerCount("unhandledRejection")).toBe(beforeListeners);
  });

  it("uses a fixed independent extension oracle instead of the production query result", async () => {
    expect(EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS).toEqual([
      { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
    ]);
    expect(
      validateIndependentExtensionInventoryForTests([
        { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
      ])
    ).toEqual({ match: true });
    expect(INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS).toContain(
      "pg_catalog.pg_extension"
    );
    expect(INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS).toContain(
      "pg_catalog.pg_namespace"
    );
    expect(INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS).toContain("ORDER BY");
    expect(sameSql(
      INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS,
      PREFLIGHT_SQL_FOR_TESTS.extensionInventory
    )).toBe(false);
    const source = await readFile(postgresHarnessModule, "utf8");
    expect(source).not.toContain("expectedExtensionInventory(client)");
    expect(source).toContain("fixedExpectedExtensionInventory()");
  });

  it.each([
    ["missing", []],
    [
      "extra",
      [
        { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
        { name: "extra", schema: "public", version: "1.0" },
      ],
    ],
    ["name", [{ name: "wrong", schema: "pg_catalog", version: "1.0" }]],
    ["version", [{ name: "plpgsql", schema: "pg_catalog", version: "2.0" }]],
    ["schema", [{ name: "plpgsql", schema: "public", version: "1.0" }]],
    [
      "unknown key",
      [
        {
          name: "plpgsql",
          schema: "pg_catalog",
          version: "1.0",
          extra: true,
        },
      ],
    ],
  ])("rejects an independent inventory %s mismatch", (_label, rows) => {
    expect(() =>
      validateIndependentExtensionInventoryForTests(rows)
    ).toThrow("EXTERNAL_FIXTURE_EXTENSION_INVENTORY_MISMATCH");
  });

  it.each([
    ["empty inventory / missing row", []],
    ["name mismatch", [{ name: "wrong", schema: "pg_catalog", version: "1.0" }]],
    ["version mismatch", [{ name: "plpgsql", schema: "pg_catalog", version: "2.0" }]],
    ["schema mismatch", [{ name: "plpgsql", schema: "public", version: "1.0" }]],
  ])("rejects the production extension query %s", async (_label, extensions) => {
    const state = baseState();
    state.extensionInventory = extensions;
    const environment = validEnvironment();
    environment.ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS = JSON.stringify({
      schemaVersion: 1,
      extensions: EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS,
    });
    const report = await runPreflight(
      createAdapter({ directState: state, pooledState: state }),
      environment
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("preserves every migrated usage-contract assertion without a caller-supplied Migration path", async () => {
    const source = await readFile(postgresHarnessModule, "utf8");
    for (const required of [
      "verifyOldMigrationCompatibility",
      "verifyPublicAclMigrationFailure",
      "verifyUsageAclInheritance",
      "verifyPlanResolution",
      "verifyReservationLifecycle",
      "EXTERNAL_FIXTURE_PUBLIC_ACL_FAILURE_NOT_ATOMIC",
      "EXTERNAL_FIXTURE_PLAN_FAILURE_CHANGED_STATE",
      "EXTERNAL_FIXTURE_CONCURRENT_RESERVATION_MISMATCH",
      "EXTERNAL_FIXTURE_ONE_TIME_RELEASE_MISMATCH",
      "EXTERNAL_FIXTURE_FINALIZATION_MISMATCH",
      "EXTERNAL_FIXTURE_STALE_RECOVERY_MISMATCH",
      "readMigrationFiles(configuration)",
      "migrations.slice(0, expectedCount)",
    ]) {
      expect(source).toContain(required);
    }
    for (const forbidden of [
      "migrationsFolder =",
      "migrationPath",
      "migrationSql",
      "callerMigration",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it.each(["postgres", "postgresql"])(
    "accepts only the canonical %s numeric-loopback shape",
    (protocol) => {
      const credential = "ci_fixture_only_not_a_secret";
      const result = validateExternalFixtureConfigurationForTests(
        externalFixtureEnvironment({
          ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
            `${protocol}://actustube_ci_fixture:${credential}@127.0.0.1:5432/actustube_ci_fixture`,
        })
      );
      expect(result).toEqual({
        valid: true,
        numericLoopback: true,
        explicitPort: true,
        databaseIdentity: "match",
        roleIdentity: "match",
        postgresqlMajor: 18,
        migrationMax: 6,
      });
      expect(JSON.stringify(result)).not.toContain(credential);
    }
  );

  it.each([
    ["uppercase protocol", "Postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["localhost", "postgresql://actustube_ci_fixture:p@localhost:5432/actustube_ci_fixture"],
    ["DNS host", "postgresql://actustube_ci_fixture:p@db.example.test:5432/actustube_ci_fixture"],
    ["IPv6", "postgresql://actustube_ci_fixture:p@[::1]:5432/actustube_ci_fixture"],
    ["mapped IPv6", "postgresql://actustube_ci_fixture:p@[::ffff:127.0.0.1]:5432/actustube_ci_fixture"],
    ["encoded host", "postgresql://actustube_ci_fixture:p@127%2e0%2e0%2e1:5432/actustube_ci_fixture"],
    ["missing port", "postgresql://actustube_ci_fixture:p@127.0.0.1/actustube_ci_fixture"],
    ["zero port", "postgresql://actustube_ci_fixture:p@127.0.0.1:0/actustube_ci_fixture"],
    ["overflow port", "postgresql://actustube_ci_fixture:p@127.0.0.1:65536/actustube_ci_fixture"],
    ["noncanonical port", "postgresql://actustube_ci_fixture:p@127.0.0.1:05432/actustube_ci_fixture"],
    ["database mismatch", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/other_fixture"],
    ["role mismatch", "postgresql://other_fixture:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["query", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture?sslmode=disable"],
    ["fragment", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture#fragment"],
    ["multi-host", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432,127.0.0.1:5433/actustube_ci_fixture"],
    ["whitespace", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture "],
    ["control", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture\n"],
    ["missing user", "postgresql://:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["missing password", "postgresql://actustube_ci_fixture@127.0.0.1:5432/actustube_ci_fixture"],
    ["encoded user", "postgresql://actustube%5fci_fixture:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["encoded password", "postgresql://actustube_ci_fixture:p%21@127.0.0.1:5432/actustube_ci_fixture"],
    ["encoded database", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube%5fci_fixture"],
  ])("rejects %s before the connection factory is called", async (_label, url) => {
    const clientFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: externalFixtureEnvironment({
          ACTUSTUBE_STAGING_HARNESS_DATABASE_URL: url,
        }),
        clientFactory,
      })
    ).rejects.toThrow(/EXTERNAL_FIXTURE_/);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE", "other_fixture"],
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE", "other_fixture"],
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR", "17"],
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX", "7"],
    ["ACTUSTUBE_STAGING_HARNESS_UNEXPECTED", "1"],
  ])("rejects a mismatched %s before any connection", async (key, value) => {
    const clientFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: externalFixtureEnvironment({ [key]: value }),
        clientFactory,
      })
    ).rejects.toThrow(/EXTERNAL_FIXTURE_/);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("emits the fixed missing-fixture marker and never attempts a connection", async () => {
    const clientFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: {
          NODE_ENV: "test",
          DATABASE_URL:
            "postgresql://generic:ignored@127.0.0.1:5432/generic",
        },
        clientFactory,
      })
    ).rejects.toThrow("EXTERNAL_FIXTURE_NOT_CONFIGURED");
    expect(clientFactory).not.toHaveBeenCalled();

    await expect(
      runDirectHarnessInvocation({
        DATABASE_URL:
          "postgresql://generic:ignored@127.0.0.1:5432/generic",
      })
    ).resolves.toEqual({
      code: 1,
      stdout: "",
      stderr: "EXTERNAL_FIXTURE_NOT_CONFIGURED\n",
    });
  });

  it("keeps credentials and target identity out of all validation output", async () => {
    const environment = externalFixtureEnvironment();
    const publicResult =
      validateExternalFixtureConfigurationForTests(environment);
    const serialized = JSON.stringify(publicResult);
    for (const forbidden of [
      environment.ACTUSTUBE_STAGING_HARNESS_DATABASE_URL,
      "ci_fixture_only_not_a_secret",
      "actustube_ci_fixture",
      "127.0.0.1",
      "5432",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const success = externalFixtureSuccessResultForTests();
    expect(Object.keys(success).sort()).toEqual(
      [
        "extensionClassification",
        "independentExtensionInventory",
        "fixtureConfigured",
        "lifecycleOwner",
        "migrationCount",
        "migrationOrderAndReplay",
        "temporaryAuthorityCleanup",
        "usageMigrationSemantics",
        "deadlineBounded",
        "outputRedaction",
        "postflight",
        "postflightDriftRejected",
        "postgresqlMajor",
        "snapshotDriftRejected",
        "stablePreflight",
        "success",
        "transactionRollback",
        "verifierQueriesReadOnly",
      ].sort()
    );
    const successSerialized = JSON.stringify(success);
    expect(successSerialized).not.toContain("ci_fixture_only_not_a_secret");
    expect(successSerialized).not.toContain("actustube_ci_fixture");
    expect(successSerialized).not.toContain("127.0.0.1");

    const credential = "credential_must_not_be_reported";
    const cli = await runDirectHarnessInvocation(
      externalFixtureEnvironment({
        ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
          `postgresql://actustube_ci_fixture:${credential}@localhost:5432/actustube_ci_fixture`,
      })
    );
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: "EXTERNAL_FIXTURE_VERIFICATION_FAILED\n",
    });
    expect(JSON.stringify(cli)).not.toContain(credential);
  });
});

describe("benign child parent-observed P3 oracle", () => {
  it.each([
    ["correct-nonzero", true, 70, null, ["created", "running", "terminal"]],
    ["correct-signal", true, null, "SIGTERM", ["created", "signal_ready"]],
    ["deadline", true, null, "SIGTERM", ["created", "deadline_pending"]],
    ["wrong-nonzero", false, 71, null, ["created", "running", "terminal"]],
    ["exit-zero", false, 0, null, ["created", "running", "terminal"]],
    ["wrong-signal", false, null, "SIGKILL", ["created", "signal_ready"]],
    ["normal-before-deadline", false, 0, null, ["created", "deadline_pending"]],
    ["pre-phase-failure", false, 73, null, []],
    ["unexpected-normal-after-phase", false, 0, null, ["created", "running"]],
    ["forged-terminal-reason", false, 71, null, ["created", "running"]],
    ["duplicate-phase", false, 70, null, ["created"]],
    ["malformed-phase", false, 70, null, ["created"]],
    ["replayed-phase", false, 70, null, ["created", "running"]],
  ] as const)("classifies the actual %s child from parent events", async (
    mode,
    accepted,
    expectedCode,
    expectedSignal,
    expectedPhases
  ) => {
    const result = await runBenignChildLifecycleProbeForTests(mode);
    expect(result.accepted).toBe(accepted);
    expect(result.authenticatedPhases).toEqual(expectedPhases);
    expect(result.exitObservation).toMatchObject({
      count: 1,
      code: expectedCode,
      signal: expectedSignal,
      timestampMilliseconds: expect.any(Number),
    });
    expect(result.closeObservation).toMatchObject({
      count: 1,
      code: expectedCode,
      signal: expectedSignal,
      timestampMilliseconds: expect.any(Number),
    });
    expect(result.closeObservation.timestampMilliseconds).toBeGreaterThanOrEqual(
      result.exitObservation.timestampMilliseconds
    );
    expect(result.errorObservation).toEqual({
      count: 0,
      timestampMilliseconds: null,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "accepted",
        "authenticatedPhases",
        "closeObservation",
        "deadlineAlive",
        "errorObservation",
        "exitObservation",
        "messageContract",
        "mode",
        "phaseContract",
        "schemaVersion",
        "terminalContract",
      ].sort()
    );
    for (const key of ["exitObservation", "closeObservation"] as const) {
      expect(Object.keys(result[key]).sort()).toEqual(
        ["code", "count", "signal", "timestampMilliseconds"].sort()
      );
    }
    expect(Object.keys(result.errorObservation).sort()).toEqual(
      ["count", "timestampMilliseconds"].sort()
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/pid|ppid|capabilityToken|occurrenceId/i);
  }, 10_000);

  it("requires the deadline child to be alive at the parent deadline", async () => {
    const result = await runBenignChildLifecycleProbeForTests("deadline", {
      deadlineMilliseconds: 100,
    });
    expect(result).toMatchObject({
      accepted: true,
      messageContract: true,
      phaseContract: true,
      terminalContract: true,
      deadlineAlive: true,
      authenticatedPhases: ["created", "deadline_pending"],
      exitObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
      closeObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
    });
  });

  it("accepts the exact nonzero code and exact signal only", async () => {
    const nonzero = await runBenignChildLifecycleProbeForTests("correct-nonzero");
    expect(nonzero).toMatchObject({
      accepted: true,
      exitObservation: {
        count: 1,
        code: 70,
        signal: null,
        timestampMilliseconds: expect.any(Number),
      },
      closeObservation: {
        count: 1,
        code: 70,
        signal: null,
        timestampMilliseconds: expect.any(Number),
      },
    });
    const signaled = await runBenignChildLifecycleProbeForTests("correct-signal");
    expect(signaled).toMatchObject({
      accepted: true,
      exitObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
      closeObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
    });
  });

  it("closes every fixed benign child that this suite actually spawned", () => {
    expect(benignChildLifecycleCountersForTests()).toEqual({
      spawned: 16,
      closed: 16,
    });
  });
});

describe("terminal abort propagation", () => {
  it("rejects an already-aborted run before DB open", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = createAdapter();
    const report = await (verifyStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture,
      signal: controller.signal,
    });

    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("DATABASE_OPERATION_ABORTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("stops scheduling main queries after abort and uses cleanup", async () => {
    const controller = new AbortController();
    const fixture = createAdapter();
    const statements: string[] = [];
    const report = await (verifyStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture,
      signal: controller.signal,
      onQuery: (statement: string) => {
        statements.push(statement);
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)) {
          controller.abort();
        }
      },
    });

    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("DATABASE_OPERATION_ABORTED");
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(fixture.connect.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    expect(fixture.connect.mock.calls[1]?.[2]?.signal).toBe(controller.signal);
    expect(
      countSqlCalls(fixture.directConnection, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)
    ).toBe(0);
    expect(
      countSqlCalls(fixture.directConnection, PREFLIGHT_SQL_FOR_TESTS.migrationCatalog)
    ).toBe(0);
    expect(fixture.directConnection.close).toHaveBeenCalledOnce();
    expect(statements.some((statement) => sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback))).toBe(true);
  });
});

describe("staging extension inventory", () => {
  const extensions = [
    { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
    { name: "vector", schema: "extensions", version: "0.8.0" },
  ];

  it("accepts an order-independent exact inventory", async () => {
    const state = baseState();
    state.extensionInventory = [...extensions].reverse();
    const environment = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions,
      }),
    };
    const report = await runPreflight(createAdapter({ directState: state }), environment);
    expect(report.exitCode).toBe(0);
    expect(report.extensionInventory).toBe("match");
  });

  it("preserves no-env precedence and requires the inventory", async () => {
    const noEnvFixture = createAdapter();
    const noEnv = await runPreflight(noEnvFixture, {});
    expect(noEnv.failure.checkId).toBe("STAGING_ENVIRONMENT_REQUIRED");
    expect(noEnvFixture.connect).not.toHaveBeenCalled();

    const environment = validEnvironment();
    delete environment.ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS;
    const missingFixture = createAdapter();
    const missing = await runPreflight(missingFixture, environment);
    expect(missing.exitCode).toBe(2);
    expect(missing.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_REQUIRED");
    expect(missingFixture.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed, dangerous, duplicate, and bounded input", async () => {
    const invalidValues = [
      "",
      "{",
      JSON.stringify({ schemaVersion: 1, extensions: [], extra: true }),
      '{"schemaVersion":1,"extensions":[],"__proto__":{}}',
      JSON.stringify({ schemaVersion: 1, extensions: [{ name: "x", schema: "public", version: "1" }, { name: "x", schema: "public", version: "2" }] }),
      JSON.stringify({ schemaVersion: 1, extensions: [{ name: "bad/name", schema: "public", version: "1" }] }),
      JSON.stringify({ schemaVersion: 1, extensions: [{ name: "bad\u0000name", schema: "public", version: "1" }] }),
      JSON.stringify({ schemaVersion: 1, extensions: "not-an-array" }),
      " ".repeat(STAGING_EXTENSION_INVENTORY_LIMITS.jsonBytes + 1),
    ];
    for (const raw of invalidValues) {
      const fixture = createAdapter();
      const report = await runPreflight(fixture, {
        ...validEnvironment(),
        ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: raw,
      });
      expect(report.exitCode).toBe(2);
      expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_INVALID");
      expect(fixture.connect).not.toHaveBeenCalled();
    }
    expect(() =>
      parseExpectedStagingExtensions({
        ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
          schemaVersion: 1,
          extensions: Array.from(
            { length: STAGING_EXTENSION_INVENTORY_LIMITS.entries + 1 },
            (_, index) => ({ name: `x${index}`, schema: "public", version: "1" })
          ),
        }),
      })
    ).toThrow("STAGING_EXTENSION_INVENTORY_INVALID");
  });

  it("fails closed when actual inventory is unavailable", async () => {
    const state = baseState();
    state.extensionInventory = null;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_UNAVAILABLE");
  });

  it("rejects an unexpected actual extension", async () => {
    const state = baseState();
    state.extensionInventory = [extensions[0]];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("rejects an extension version mismatch", async () => {
    const state = baseState();
    state.extensionInventory = [{ ...extensions[0], version: "2.0" }];
    const environment = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [extensions[0]],
      }),
    };
    const report = await runPreflight(createAdapter({ directState: state }), environment);
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("rejects an extension schema mismatch", async () => {
    const state = baseState();
    state.extensionInventory = [{ ...extensions[0], schema: "public" }];
    const environment = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [extensions[0]],
      }),
    };
    const report = await runPreflight(createAdapter({ directState: state }), environment);
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("rejects direct, pooled, and after-snapshot drift", async () => {
    const expected = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [extensions[0]],
      }),
    };
    const matching = baseState();
    matching.extensionInventory = [extensions[0]];
    const pooledMismatch = baseState();
    pooledMismatch.extensionInventory = [extensions[1]];
    const pooledReport = await runPreflight(
      createAdapter({ directState: matching, pooledState: pooledMismatch }),
      expected
    );
    expect(pooledReport.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
    expect(pooledReport.extensionInventory).toBe("not_verified");

    const afterMismatch = baseState();
    afterMismatch.extensionInventoryForRead = (read: number) =>
      read === 1 ? [extensions[0]] : [extensions[1]];
    const afterReport = await runPreflight(
      createAdapter({ directState: afterMismatch, pooledState: matching }),
      expected
    );
    expect(afterReport.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
    expect(afterReport.extensionInventory).toBe("not_verified");
  });
});

describe("staging database preflight safety gate", () => {
  it("passes a pristine database without a migration schema", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture);
    expect(report).toMatchObject({
      exitCode: 0,
      directConnection: "pass",
      pooledConnection: "pass",
      directPooledIdentity: "match",
      postgresqlVersion: {
        direct: "supported",
        pooled: "supported",
        directAfter: "supported",
        pooledAfter: "supported",
      },
      expectedIdentity: "match",
      initialState: "pristine",
      applicationTables: 0,
      applicationFunctions: 0,
      applicationData: 0,
      partialSchema: "none",
      readOnlyInvariant: "pass",
      cleanup: "pass",
      secretRedaction: "pass",
    });
    expect(report.userDefinedObjects.direct.total).toBe(0);
    expect(report.userDefinedObjects.pooled.total).toBe(0);
    expect(report.userDefinedObjects.directAfter.total).toBe(0);
    expect(report.userDefinedObjects.pooledAfter.total).toBe(0);
    expect(report.migrationHistory).toMatchObject({
      applied: 0,
      pending: 7,
      duplicates: 0,
      unknown: 0,
    });
    expect(report.migrationHistory.pendingTags).toHaveLength(7);
  });

  it("passes the exact Drizzle migration table with zero rows", async () => {
    const fixture = createAdapter({ directState: emptyMigrationTableState() });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(0);
    expect(report.initialState).toBe("empty_migration_table");
    expect(report.migrationHistory.applied).toBe(0);
  });

  it.each([
    ["missing environment", { ACTUSTUBE_DB_ENV: undefined }, 2],
    ["wrong environment", { ACTUSTUBE_DB_ENV: "production" }, 2],
    ["case mismatch", { ACTUSTUBE_DB_ENV: "Staging" }, 2],
    ["missing confirmation", { ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: undefined }, 2],
    ["bad confirmation", { ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "true" }, 2],
    ["missing direct URL", { DIRECT_DATABASE_URL: undefined }, 2],
    ["missing pooled URL", { DATABASE_URL: undefined }, 2],
    ["missing expected identity", { ACTUSTUBE_EXPECTED_STAGING_IDENTITY: undefined }, 3],
  ])("rejects %s before connecting", async (_label, override, exitCode) => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      ...override,
    });
    expect(report.exitCode).toBe(exitCode);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects a pooled URL in the direct slot", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DIRECT_DATABASE_URL: pooledUrl,
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_ENDPOINT_KIND_REJECTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects a direct URL in the pooled slot", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DATABASE_URL: directUrl,
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("POOLED_ENDPOINT_KIND_REJECTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects an unknown query before it can supply a staging marker", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DIRECT_DATABASE_URL:
        "postgresql://migration:dummy-password@ep-actustube-safe.example.test/app?application_name=staging",
      DATABASE_URL:
        "postgresql://runtime:dummy-password@ep-actustube-safe-pooler.example.test/app?application_name=staging",
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_URL_QUERY_REJECTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", "DIRECT_URL_AUTHORITY_REJECTED"],
    ["pooled", "POOLED_URL_AUTHORITY_REJECTED"],
    ["both", "DIRECT_URL_AUTHORITY_REJECTED"],
  ] as const)(
    "rejects an encoded database authority in %s before connecting",
    async (side, checkId) => {
      const fixture = createAdapter();
      const environment = validEnvironment();
      if (side === "direct" || side === "both") {
        environment.DIRECT_DATABASE_URL = directUrl.replace(
          "staging_database",
          "app%2Fstaging"
        );
      }
      if (side === "pooled" || side === "both") {
        environment.DATABASE_URL = pooledUrl.replace(
          "staging_database",
          "app%2Fstaging"
        );
      }
      const report = await runPreflight(fixture, environment);
      expect(report.exitCode).toBe(2);
      expect(report.failure.checkId).toBe(checkId);
      expect(fixture.connect).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("app%2Fstaging");
    }
  );

  it("rejects direct and pooled URL target mismatch", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DATABASE_URL: pooledUrl.replace("staging_database", "other_staging"),
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_POOLED_TARGET_MISMATCH");
  });

  it("rejects expected provider identity mismatch", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-other-staging",
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("EXPECTED_STAGING_IDENTITY_MISMATCH");
    expect(report.expectedIdentity).toBe("fail");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("keeps a missing expected provider identity not verified", async () => {
    const fixture = createAdapter();
    const environment = validEnvironment();
    delete environment.ACTUSTUBE_EXPECTED_STAGING_IDENTITY;
    const report = await runPreflight(fixture, environment);
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("EXPECTED_STAGING_IDENTITY_REQUIRED");
    expect(report.expectedIdentity).toBe("not_verified");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects different logical databases behind direct and pooled endpoints", async () => {
    const pooledState = baseState();
    pooledState.identity = { database_oid: "101", system_identifier: "200" };
    const fixture = createAdapter({ pooledState });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(1);
    expect(report.directPooledIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("LOGICAL_DATABASE_IDENTITY_MISMATCH");
  });

  it("rejects an actual database role that differs from the validated URL role", async () => {
    const directState = baseState();
    directState.roleIdentityForRead = () => ({
      role_name: "different_staging_role",
    });
    const report = await runPreflight(
      createAdapter({ directState, pooledState: baseState() })
    );
    expect(report.exitCode).toBe(1);
    expect(report.databaseRoleIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("DIRECT_ROLE_IDENTITY_MISMATCH");
  });

  it("rejects a logical database identity change between before and after reads", async () => {
    const directState = baseState();
    directState.identityForRead = (read: number) => ({
      database_oid: read === 1 ? "100" : "101",
      system_identifier: "200",
    });
    const report = await runPreflight(
      createAdapter({ directState, pooledState: baseState() })
    );
    expect(report.exitCode).toBe(1);
    expect(report.directPooledIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("LOGICAL_DATABASE_IDENTITY_MISMATCH");
  });

  it("rejects different logical databases in the after snapshots", async () => {
    const pooledState = baseState();
    pooledState.identityForRead = (read: number) => ({
      database_oid: read === 1 ? "100" : "101",
      system_identifier: "200",
    });
    const report = await runPreflight(
      createAdapter({ directState: baseState(), pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.directPooledIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("LOGICAL_DATABASE_IDENTITY_MISMATCH");
  });

  it("accepts PostgreSQL 18 and reports only a fixed support status", async () => {
    const report = await runPreflight(createAdapter());
    expect(report.exitCode).toBe(0);
    expect(report.postgresqlVersion).toEqual({
      direct: "supported",
      pooled: "supported",
      directAfter: "supported",
      pooledAfter: "supported",
    });
    expect(JSON.stringify(report)).not.toContain("180004");
  });

  it("prohibits migration on PostgreSQL 17 before version-specific catalog queries", async () => {
    const state = baseState();
    state.serverVersion.server_version_num = "170009";
    const fixture = createAdapter({ directState: state });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_UNSUPPORTED");
    expect(countSqlCalls(fixture.directConnection, PREFLIGHT_SQL_FOR_TESTS.identity)).toBe(0);
  });

  it("fails closed when the PostgreSQL version is unavailable", async () => {
    const state = baseState();
    delete state.serverVersion.server_version_num;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_UNAVAILABLE");
  });

  it("rejects a direct and pooled PostgreSQL version difference", async () => {
    const directState = baseState();
    const pooledState = baseState();
    pooledState.serverVersion.server_version_num = "180005";
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_MISMATCH");
  });

  it("rejects a PostgreSQL version change between before and after reads", async () => {
    const state = baseState();
    state.serverVersionForRead = (read: number) => ({
      server_version_num: read === 1 ? "180004" : "180005",
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_CHANGED");
  });
});

describe("empty migration and application state", () => {
  it("rejects a migration schema without the migration table", async () => {
    const state = baseState();
    state.migrationCatalog.schema_exists = true;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SCHEMA_PARTIAL");
  });

  it("rejects unexpected objects in an otherwise empty migration schema", async () => {
    const state = emptyMigrationTableState();
    state.migrationCatalog.objects.push("r:unexpected");
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SCHEMA_PARTIAL");
  });

  it("rejects an invalid empty migration table shape", async () => {
    const state = emptyMigrationTableState();
    state.migrationColumns = state.migrationColumns.slice(1);
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_COLUMN_COUNT_MISMATCH");
  });

  it("accepts the three exact fresh Drizzle migration columns", async () => {
    const report = await runPreflight(
      createAdapter({ directState: emptyMigrationTableState() })
    );
    expect(report.exitCode).toBe(0);
  });

  it.each([
    ["generated hash column", 1, "generated_kind", "s"],
    ["generated created_at column", 2, "generated_kind", "s"],
    ["identity column", 0, "identity_kind", "d"],
    ["domain-backed column", 1, "type_kind", "d"],
    ["noncanonical collation", 1, "collation_is_canonical", false],
    ["inherited column", 2, "inherited_count", 1],
    ["nonlocal column", 2, "is_local", false],
    ["column ACL", 1, "acl_is_default", false],
    ["column option", 1, "options_are_default", false],
    ["column FDW option", 1, "fdw_options_are_default", false],
    ["column storage drift", 1, "storage_kind", "p"],
    ["column compression drift", 1, "compression_kind", "p"],
    ["column statistics drift", 1, "statistics_are_default", false],
    ["column relation mapping drift", 1, "relation_is_canonical", false],
    ["column type length drift", 0, "type_length", 8],
    ["column pass-by-value drift", 0, "passed_by_value", false],
    ["column alignment drift", 2, "alignment", "i"],
    ["column default-presence drift", 1, "has_default", true],
  ])("rejects %s", async (_label, index, field, value) => {
    const state = emptyMigrationTableState();
    state.migrationColumnExact[index][field] = value;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_MISMATCH");
  });

  it("rejects a physically retained dropped column", async () => {
    const state = emptyMigrationTableState();
    state.migrationColumnExact.push({
      ...state.migrationColumnExact[2],
      position: 4,
      column_name: "dropped",
      is_dropped: true,
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_MISMATCH");
  });

  it("fails closed when an exact column catalog field is unavailable", async () => {
    const state = emptyMigrationTableState();
    delete state.migrationColumnExact[1].generated_kind;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_UNAVAILABLE");
  });

  it("rejects a direct and pooled exact-column catalog difference", async () => {
    const directState = emptyMigrationTableState();
    const pooledState = emptyMigrationTableState();
    pooledState.migrationColumnExact[1].storage_kind = "p";
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_MISMATCH");
  });

  it("rejects a before and after exact-column catalog change", async () => {
    const state = emptyMigrationTableState();
    state.migrationColumnExactForRead = (read: number) => {
      const rows = migrationColumnExact.map((row) => ({ ...row }));
      if (read > 1) rows[1].storage_kind = "p";
      return rows;
    };
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("READ_ONLY_INVARIANT_MISMATCH");
  });

  it("rejects one partially applied known migration", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const state = emptyMigrationTableState();
    state.migrationHistory = [
      {
        id: "1",
        hash: specification.migrations[0].hash,
        created_at: specification.migrations[0].createdAt,
      },
    ];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_NOT_EMPTY");
  });

  it("rejects all seven already applied migrations", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const state = emptyMigrationTableState();
    state.migrationHistory = specification.migrations.map((entry, index) => ({
      id: String(index + 1),
      hash: entry.hash,
      created_at: entry.createdAt,
    }));
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_NOT_EMPTY");
  });

  it("rejects an unknown migration", async () => {
    const state = emptyMigrationTableState();
    state.migrationHistory = [
      { id: "1", hash: "0".repeat(64), created_at: "1" },
    ];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_UNKNOWN");
  });

  it("rejects duplicate migration history", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const state = emptyMigrationTableState();
    const migration = specification.migrations[0];
    state.migrationHistory = [
      { id: "1", hash: migration.hash, created_at: migration.createdAt },
      { id: "1", hash: migration.hash, created_at: migration.createdAt },
    ];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_DUPLICATE");
  });

  it.each([
    ["unknown public table", "relation_count"],
    ["view", "relation_count"],
    ["materialized view", "relation_count"],
    ["foreign table", "relation_count"],
    ["partitioned table", "relation_count"],
    ["sequence", "relation_count"],
    ["index", "relation_count"],
    ["separate user schema", "schema_count"],
    ["unknown function or procedure", "routine_count"],
    ["enum, domain, or composite type", "type_count"],
    ["trigger", "trigger_count"],
    ["rule", "rule_count"],
    ["policy", "policy_count"],
    ["constraint", "constraint_count"],
    ["other user-defined catalog object", "other_count"],
  ])("rejects residual %s", async (_label, field) => {
    const state = residualState(field);
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
    expect(report.userDefinedObjects.direct.total).toBe(1);
  });

  it("rejects an unknown table with residual data", async () => {
    const state = residualState("relation_count", {
      estimatedDataRows: "2",
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_DATA_PRESENT");
    expect(report.userDefinedObjects.direct.estimatedDataRows).toBe(2);
  });

  it("fails closed when catalog rows cannot be completely classified", async () => {
    const state = residualState("relation_count");
    state.userDefinedObjects.object_signature = [];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("limits extension exclusions to direct membership and two catalog-proven internal classes", async () => {
    const sql = PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects;
    expect(sql).toContain("pg_depend");
    expect(sql).toContain("pg_extension");
    expect(sql).toContain("extension_direct");
    expect(sql).toContain("extension_internal");
    expect(sql).toContain("extension_classification");
    expect(sql).toContain("extension_managed");
    expect(sql).toContain("dependency_entry.deptype = 'e'");
    expect(sql).toContain("dependency_entry.deptype = 'i'");
    expect(sql).not.toMatch(/deptype\s+(?:IN\s*\([^)]*'a'|=\s*'a')/i);
    expect(sql).not.toContain("extnamespace");
    expect(sql).toContain("rule_entry.rulename = '_RETURN'");
    expect(sql).toContain("relation_entry.relkind IN ('v', 'm')");
    expect(sql).toContain("trigger_entry.tgconstraint = constraint_entry.oid");
    expect(sql).toContain("constraint_entry.contype = 'f'");
    expect(sql).toContain("extension_classification_evidence");
    expect(sql).toContain("extension_candidate_signature");
    expect(sql).toContain("extension_managed_signature");
    expect(sql).toContain("extension_residual_signature");
    expect(sql).toContain("pg_catalog");
    expect(sql).toContain("information_schema");
    expect(sql).toContain("^pg_toast");
    expect(sql).toContain("^pg_temp");
    for (const catalog of [
      "pg_class",
      "pg_proc",
      "pg_type",
      "pg_trigger",
      "pg_rewrite",
      "pg_policy",
      "pg_constraint",
      "pg_event_trigger",
      "pg_foreign_data_wrapper",
      "pg_publication",
      "pg_subscription",
      "pg_default_acl",
      "pg_largeobject_metadata",
    ]) {
      expect(sql).toContain(catalog);
    }
    expect(sql).not.toMatch(/owner/i);
    expect(sql).not.toMatch(/provider/i);
    expect(sql).not.toContain("$1");
    const report = await runPreflight(createAdapter());
    expect(report.exitCode).toBe(0);
  });

  it("binds the external fixture gate to the production classification SQL", async () => {
    expect(PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects).toContain(
      PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS
    );
    const source = await readFile(postgresHarnessModule, "utf8");
    expect(source).toContain("PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS");
    expect(source).toContain("unclassified_count");
    expect(source).toContain("ambiguous_count");
    expect(source).toContain("classification_count");
    expect(source).toContain("complete_dependency_count");
  });

  it.each([
    [
      "direct extension member",
      {
        dependencyType: "e",
        dependentClass: "other_catalog",
        referencedClass: "pg_extension",
      },
      true,
      "other_count",
      0,
    ],
    [
      "view return rule with an internal dependency on a direct member",
      {
        dependencyType: "i",
        dependentClass: "pg_rewrite",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
        ruleName: "_RETURN",
        relationKind: "v",
      },
      true,
      "rule_count",
      0,
    ],
    [
      "foreign-key enforcement trigger with an internal dependency on a direct constraint",
      {
        dependencyType: "i",
        dependentClass: "pg_trigger",
        referencedClass: "pg_constraint",
        referencedIsDirectExtensionMember: true,
        triggerConstraintMatches: true,
        constraintType: "f",
      },
      true,
      "trigger_count",
      0,
    ],
    [
      "named constraint added to an extension table",
      {
        dependencyType: "a",
        dependentClass: "pg_constraint",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      false,
      "constraint_count",
      1,
    ],
    [
      "index added to an extension table",
      {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      false,
      "relation_count",
      1,
    ],
    [
      "trigger added to an extension table",
      {
        dependencyType: "a",
        dependentClass: "pg_trigger",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      false,
      "trigger_count",
      1,
    ],
    [
      "schema matching only extnamespace",
      {
        dependencyType: "n",
        dependentClass: "pg_namespace",
        referencedClass: "pg_extension",
      },
      false,
      "schema_count",
      1,
    ],
    [
      "provider or extension-like name without membership",
      {
        dependencyType: "n",
        dependentClass: "pg_namespace",
        referencedClass: "other_catalog",
      },
      false,
      "schema_count",
      1,
    ],
  ])(
    "classifies %s through the Production catalog validation path",
    async (_label, evidence, managed, residualField, expectedExit) => {
      const state = extensionClassificationState(evidence, {
        managed,
        residualField,
      });
      const report = await runPreflight(
        createAdapter({ directState: state })
      );
      expect(report.exitCode).toBe(expectedExit);
      if (expectedExit === 1) {
        expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
      }
    }
  );

  it("fails closed when extension classification evidence is incomplete", async () => {
    const state = extensionClassificationState(
      { referencedClass: "pg_extension" },
      { managed: true }
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects false-clean SQL residual signatures for residual classifier evidence", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      { residualField: "relation_count" }
    );
    state.userDefinedObjects.total_count = 0;
    state.userDefinedObjects.relation_count = 0;
    state.userDefinedObjects.object_signature = [];
    state.userDefinedObjects.extension_residual_signature = [];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects a managed signature that SQL also reports as residual", async () => {
    const signature = "1259:90004:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.total_count = 1;
    state.userDefinedObjects.relation_count = 1;
    state.userDefinedObjects.object_signature = [`relation:${signature}`];
    state.userDefinedObjects.extension_residual_signature = [signature];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects direct membership mixed with residual dependency evidence", async () => {
    const signature = "1259:90010:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "residual", {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects approved internal dependency mixed with residual evidence", async () => {
    const signature = "2618:90011:0";
    const state = extensionClassificationState(
      {
        dependencyType: "i",
        dependentClass: "pg_rewrite",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
        ruleName: "_RETURN",
        relationKind: "v",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "residual", {
        dependencyType: "a",
        dependentClass: "pg_rewrite",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("accepts managed support with normal neutral dependency evidence", async () => {
    const signature = "1259:90015:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "neutral", {
        dependencyType: "n",
        dependentClass: "pg_class",
        referencedClass: "pg_namespace",
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(0);
  });

  it("classifies residual support with normal neutral evidence as residual", async () => {
    const signature = "1259:90016:0";
    const state = extensionClassificationState(
      {
        dependencyType: "n",
        dependentClass: "pg_class",
        referencedClass: "pg_namespace",
      },
      { signature, residualField: "relation_count" }
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
  });

  it("rejects mixed evidence even when SQL reports only residual", async () => {
    const signature = "1259:90012:0";
    const state = extensionClassificationState(
      {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      { signature, residualField: "relation_count" }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "managed", {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects neutral-only evidence as unclassified", async () => {
    const signature = "1259:90013:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence =
      state.userDefinedObjects.extension_classification_evidence.filter(
        (entry: any) => entry.evidenceKind === "candidate"
      );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects an unknown evidence classification", async () => {
    const state = extensionClassificationState(
      {
        evidenceKind: "unknown",
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects duplicate evidence signatures", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_classification_evidence.push({
      ...state.userDefinedObjects.extension_classification_evidence[1],
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects evidence linked to a candidate outside the candidate set", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence("1259:90014:0", "orphan", {
        dependencyType: "e",
        referencedClass: "pg_extension",
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects a candidate with no evidence", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_classification_evidence = [];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it.each([
    ["missing", []],
    ["duplicate", ["1259:90002:0", "1259:90002:0"]],
  ])("rejects a %s classification candidate", async (_label, candidates) => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_candidate_signature = candidates;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects a valid direct and pooled classification difference", async () => {
    const directState = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90005:0" }
    );
    const pooledState = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90006:0" }
    );
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("DIRECT_POOLED_STATE_MISMATCH");
  });

  it("rejects a valid classification change between before and after reads", async () => {
    const first = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90007:0" }
    ).userDefinedObjects;
    const second = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90008:0" }
    ).userDefinedObjects;
    const state = baseState();
    state.userDefinedObjectsForRead = (read: number) =>
      read === 1 ? first : second;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("READ_ONLY_INVARIANT_MISMATCH");
  });

  it("rejects a provider-like name without catalog extension ownership", async () => {
    const internalSignature = "2615:90009:0";
    const state = residualState("schema_count", {
      signature: internalSignature,
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
    expect(JSON.stringify(report)).not.toContain(internalSignature);
  });

  it("rejects direct clean and pooled dirty", async () => {
    const report = await runPreflight(
      createAdapter({ pooledState: residualState("relation_count") })
    );
    expect(report.exitCode).toBe(1);
    expect(report.userDefinedObjects.direct.total).toBe(0);
    expect(report.userDefinedObjects.pooled.total).toBe(1);
  });

  it("rejects direct dirty and pooled clean", async () => {
    const report = await runPreflight(
      createAdapter({
        directState: residualState("routine_count"),
        pooledState: baseState(),
      })
    );
    expect(report.exitCode).toBe(1);
    expect(report.userDefinedObjects.direct.total).toBe(1);
    expect(report.userDefinedObjects.pooled.total).toBe(0);
  });

  it("rejects an added CHECK constraint on the empty migration table", async () => {
    const state = emptyMigrationTableState();
    state.migrationExact.constraint_count = 4;
    state.migrationExact.unexpected_constraint_count = 1;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_CONSTRAINT_SHAPE_MISMATCH");
  });

  it("rejects an altered serial sequence", async () => {
    const state = emptyMigrationTableState();
    state.migrationExact.sequence_increment = "2";
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_SHAPE_MISMATCH");
  });

  it("accepts only the unused current sequence state", async () => {
    const state = emptyMigrationTableState();
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(0);
    expect(report.migrationSequenceState).toEqual({
      direct: "unused",
      pooled: "unused",
      directAfter: "unused",
      pooledAfter: "unused",
    });
  });

  it.each([
    ["advanced last_value", "sequence_last_value", "2"],
    ["is_called true", "sequence_is_called", true],
  ])("rejects sequence current state with %s", async (_label, field, value) => {
    const state = emptyMigrationTableState();
    state.migrationExact[field] = value;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_STATE_MISMATCH");
  });

  it("rejects differing direct and pooled sequence current state", async () => {
    const directState = emptyMigrationTableState();
    const pooledState = emptyMigrationTableState();
    pooledState.migrationExact.sequence_is_called = true;
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_STATE_MISMATCH");
  });

  it("rejects a before/after sequence current-state change", async () => {
    const state = emptyMigrationTableState();
    state.migrationExactForRead = (read: number) => ({
      ...state.migrationExact,
      sequence_is_called: read === 1 ? false : true,
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_STATE_MISMATCH");
  });

  it("fails closed when sequence current state is unavailable", async () => {
    const state = emptyMigrationTableState();
    delete state.migrationExact.sequence_last_value;
    delete state.migrationExact.sequence_is_called;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe(
      "MIGRATION_SEQUENCE_STATE_UNAVAILABLE"
    );
  });

  it.each([
    ["trigger", "trigger_count", 1, "MIGRATION_TRIGGER_PRESENT"],
    ["rule", "rule_count", 1, "MIGRATION_RULE_PRESENT"],
    ["policy", "policy_count", 1, "MIGRATION_POLICY_PRESENT"],
    [
      "table relation property",
      "table_row_security",
      true,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table physical attribute count",
      "table_attribute_count",
      4,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table index flag",
      "table_has_index",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table ACL",
      "table_acl_is_default",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table tablespace",
      "table_tablespace_is_default",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table shared flag",
      "table_is_shared",
      true,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table rewrite mapping",
      "table_rewrite_is_zero",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table row type mapping",
      "table_row_type_is_canonical",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table TOAST mapping",
      "table_toast_mapping_is_canonical",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table access method",
      "table_access_method",
      "unexpected",
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "catalog namespace mapping",
      "object_namespaces_are_canonical",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "NOT NULL constraint metadata",
      "not_null_constraints_exact",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "object owner relationship",
      "object_owner_is_consistent",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "index relation property",
      "index_is_valid",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index exclusion flag",
      "index_is_exclusion",
      true,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index tablespace",
      "index_tablespace_is_default",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index shared flag",
      "index_is_shared",
      true,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index rewrite mapping",
      "index_rewrite_is_zero",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index row type mapping",
      "index_row_type_is_zero",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index replica identity",
      "index_replica_identity",
      "d",
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index fixed boolean",
      "index_is_ready",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index vector coverage",
      "index_vector_lengths_are_canonical",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index relation mapping",
      "index_relation_mapping_is_canonical",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index immediate flag",
      "index_is_immediate",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index operator class",
      "index_operator_class_is_canonical",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "sequence ACL",
      "sequence_acl_is_default",
      false,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence access method",
      "sequence_access_method_is_zero",
      false,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence tablespace",
      "sequence_tablespace_is_default",
      false,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence replica identity",
      "sequence_replica_identity",
      "d",
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence ownership",
      "sequence_owned_by_count",
      0,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence default dependency",
      "default_sequence_dependency_count",
      0,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "constraint enforcement",
      "constraint_enforcement_is_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint period",
      "constraint_period_is_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint namespace relation index mapping",
      "constraint_mapping_is_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint action chars",
      "constraint_action_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint foreign-key arrays",
      "constraint_foreign_key_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint exclusion array",
      "constraint_exclusion_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint expression",
      "constraint_expression_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "NOT NULL constraint conkey set",
      "not_null_constraint_keys_exact",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "NOT NULL constraint canonical names",
      "not_null_constraint_names_exact",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
  ])(
    "rejects an unexpected migration-table %s",
    async (_label, field, value, checkId) => {
      const state = emptyMigrationTableState();
      state.migrationExact[field] = value;
      const report = await runPreflight(createAdapter({ directState: state }));
      expect(report.exitCode).toBe(1);
      expect(report.failure.checkId).toBe(checkId);
    }
  );

  it("fails closed when an exact PostgreSQL 18 catalog field is unavailable", async () => {
    const state = emptyMigrationTableState();
    delete state.migrationExact.constraint_enforcement_is_canonical;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("MIGRATION_EXACT_CATALOG_UNAVAILABLE");
  });
});

describe("connections, read-only invariant, cleanup, and output", () => {
  it("rolls back and closes both connections after success", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(0);
    for (const connection of [
      fixture.directConnection,
      fixture.pooledConnection,
    ]) {
      expect(
        countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.rollback)
      ).toBe(2);
      expect(
        countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.begin)
      ).toBe(2);
      expect(connection.close).toHaveBeenCalledOnce();
    }
  });

  it("cleans up both connections after a verified state failure", async () => {
    const fixture = createAdapter({
      directState: residualState("relation_count"),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(1);
    for (const connection of [
      fixture.directConnection,
      fixture.pooledConnection,
    ]) {
      expect(
        countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.rollback)
      ).toBe(1);
      expect(connection.close).toHaveBeenCalledOnce();
    }
  });

  it("classifies a direct connection failure without exposing its error", async () => {
    const fixture = createAdapter({
      directFailure: new Error(`${fakeSecret} ${directUrl}`),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(report.directConnection).toBe("fail");
    expect(report.failure.status).toBe("not_verified");
    expect(JSON.stringify(report)).not.toContain(fakeSecret);
  });

  it("classifies a pooled connection failure and closes direct", async () => {
    const fixture = createAdapter({
      pooledFailure: new AggregateError([new Error(`${fakeSecret} ${pooledUrl}`)]),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(report.pooledConnection).toBe("fail");
    expect(report.failure.status).toBe("not_verified");
    expect(fixture.directConnection.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain(fakeSecret);
  });

  it("fails closed on a bounded query timeout", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: any, timeout?: number, ...args: any[]) =>
        nativeSetTimeout(
          handler,
          timeout === 20_000 ? 0 : timeout,
          ...args
        )) as typeof setTimeout);
    try {
      const fixture = createAdapter({ directOptions: { hangAt: "identity" } });
      const report = await runPreflight(fixture);
      expect(report.exitCode).toBe(3);
      expect(report.failure.checkId).toBe("DATABASE_QUERY_TIMEOUT");
      expect(report.failure.status).toBe("not_verified");
      for (const connection of [
        fixture.directConnection,
        fixture.pooledConnection,
      ]) {
        expect(
          countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.rollback)
        ).toBe(1);
        expect(connection.close).toHaveBeenCalledOnce();
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("fails closed when connection cleanup fails", async () => {
    const fixture = createAdapter({ pooledOptions: { failCleanup: true } });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(report.cleanup).toBe("not_verified");
    expect(report.failure.checkId).toBe("CONNECTION_CLEANUP_UNVERIFIED");
  });

  it("fails closed when connection cleanup times out", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: any, timeout?: number, ...args: any[]) =>
        nativeSetTimeout(
          handler,
          timeout === 5_000 ? 0 : timeout,
          ...args
        )) as typeof setTimeout);
    try {
      const fixture = createAdapter({ pooledOptions: { hangCleanup: true } });
      try {
        const report = await runPreflight(fixture);
        expect(report.exitCode).toBe(3);
        expect(report.cleanup).toBe("not_verified");
        expect(report.failure.checkId).toBe("CONNECTION_CLEANUP_UNVERIFIED");
        expect(fixture.connect).toHaveBeenCalledTimes(2);
        expect(
          countSqlCalls(
            fixture.directConnection,
            POSTFLIGHT_SQL_FOR_TESTS.rollback
          )
        ).toBe(2);
        expect(fixture.directConnection.close).toHaveBeenCalledOnce();
      } finally {
        fixture.directConnection.clearCleanupHandle();
        fixture.pooledConnection.clearCleanupHandle();
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("does not retry a failed connection", async () => {
    const fixture = createAdapter({
      directFailure: new Error(fakeSecret),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(fixture.connect).toHaveBeenCalledOnce();
  });

  it("detects a before/after state change", async () => {
    const state = baseState();
    state.userDefinedObjectsForRead = (read: number) =>
      read === 1
        ? state.userDefinedObjects
        : residualState("relation_count").userDefinedObjects;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("READ_ONLY_INVARIANT_MISMATCH");
    expect(report.userDefinedObjects.direct.total).toBe(0);
    expect(report.userDefinedObjects.directAfter.total).toBe(1);
  });

  it("emits no write-capable SQL", async () => {
    const statements: string[] = [];
    const fixture = createAdapter();
    const report = await (verifyStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture as any,
      onQuery: (statement: string) => statements.push(statement),
    });
    expect(report.exitCode).toBe(0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(() => assertReadOnlySql(statement)).not.toThrow();
      expect(statement).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO)\b/i
      );
    }
  });

  it("keeps fake secrets out of stdout for nested driver errors", async () => {
    const output: string[] = [];
    const fixture = createAdapter({
      directFailure: Object.assign(new Error(`${fakeSecret} ${directUrl}`), {
        cause: new AggregateError([new Error(encodeURIComponent(directUrl))]),
      }),
    });
    const report = await (executeStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture,
      stdout: (line: string) => output.push(line),
    });
    expect(report.exitCode).toBe(3);
    const serialized = output.join("\n");
    expect(serialized).toContain(PARENT_ENVIRONMENT_NOTICE);
    for (const secret of [
      fakeSecret,
      directUrl,
      pooledUrl,
      encodeURIComponent(directUrl),
      "staging_direct",
      "staging_runtime",
      "staging_database",
      "ep-actustube-safe",
      "sslmode=require",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("preserves exit code 3 after a fatal event", () => {
    const assigned: number[] = [];
    const output: string[] = [];
    const fatal = createFatalExitLatch({
      stdout: (line: string) => {
        output.push(line);
      },
      setExitCode: (code: number) => assigned.push(code),
    });
    fatal.latch("UNCAUGHT_EXCEPTION");
    fatal.setReportExitCode(0);
    expect(assigned).toEqual([3, 3]);
    expect(output.join("\n")).not.toContain(fakeSecret);
  });

  it.each([0, 1, 2])(
    "removes fatal listeners after resolved CLI exit %i",
    async (exitCode) => {
      const processObject = Object.assign(new EventEmitter(), {
        exitCode: undefined as number | undefined,
      });
      const mainReport =
        exitCode === 0
          ? await runPreflight(createAdapter())
          : {
              ...createPreflightBaseReport(),
              overallStatus: "fail",
              failure: {
                checkId:
                  exitCode === 1
                    ? "USER_DEFINED_OBJECT_PRESENT"
                    : "STAGING_ENVIRONMENT_REQUIRED",
                status: "fail",
              },
              exitCode,
            };
      await (runPreflightCli as any)({
        mainFunction: async () => mainReport,
        processObject,
        stdout: vi.fn(),
      });
      expect(processObject.exitCode).toBe(exitCode);
      expect(processObject.listenerCount("uncaughtException")).toBe(0);
      expect(processObject.listenerCount("unhandledRejection")).toBe(0);
    }
  );

  it("removes fatal listeners and redacts a top-level failure", async () => {
    const processObject = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined,
    });
    const output: string[] = [];
    await (runPreflightCli as any)({
      mainFunction: async () => {
        throw Object.assign(new AggregateError([new Error(fakeSecret)]), {
          cause: new Error(fakeSecret),
          stack: fakeSecret,
        });
      },
      processObject,
      stdout: (line: string) => output.push(line),
    });
    expect(processObject.exitCode).toBe(3);
    expect(processObject.listenerCount("uncaughtException")).toBe(0);
    expect(processObject.listenerCount("unhandledRejection")).toBe(0);
    expect(output.join("\n")).not.toContain(fakeSecret);
  });

  it("keeps exit 3 latched after a fatal process event", async () => {
    const processObject = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined,
    });
    let resolveMain:
      | ((report: ReturnType<typeof createPreflightBaseReport>) => void)
      | undefined;
    const output: string[] = [];
    const running = (runPreflightCli as any)({
      mainFunction: () =>
        new Promise<ReturnType<typeof createPreflightBaseReport>>(
          (resolvePromise) => {
            resolveMain = resolvePromise;
          }
        ),
      processObject,
      stdout: (line: string) => output.push(line),
    });
    processObject.emit("uncaughtException", new Error(fakeSecret));
    resolveMain?.(createPreflightBaseReport());
    await running;
    expect(processObject.exitCode).toBe(3);
    expect(processObject.listenerCount("uncaughtException")).toBe(0);
    expect(processObject.listenerCount("unhandledRejection")).toBe(0);
    expect(output.join("\n")).not.toContain(fakeSecret);
  });

  it.each([
    ["pristine", 0],
    ["residual", 1],
    ["safety", 2],
    ["connection_unknown", 3],
    ["catalog_unknown", 3],
  ])(
    "runs the real CLI core/formatter/cleanup path for %s with OS code %i",
    async (scenario, exitCode) => {
      const result = await runCliChild(scenario);
      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).not.toContain(fakeSecret);
      expect(result.stderr).not.toContain(fakeSecret);
      expect(result.stderr).toBe("");
      const jsonLines = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("{"));
      expect(jsonLines).toHaveLength(1);
      const report = JSON.parse(jsonLines[0]);
      expect(report.exitCode).toBe(exitCode);
      expect(Object.keys(report.userDefinedObjects).sort()).toEqual([
        "direct",
        "directAfter",
        "pooled",
        "pooledAfter",
      ]);
      expect(
        result.stdout.match(/ActusTube staging database preflight/g) || []
      ).toHaveLength(1);
      expect(result.stdout).toContain(`exit code: ${exitCode}`);
    }
  );

  it("emits exit 1 JSON and human summary exactly once without escalation", async () => {
    const result = await runCliChild("residual");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{"))).toHaveLength(1);
    expect(
      result.stdout.match(/ActusTube staging database preflight/g) || []
    ).toHaveLength(1);
    expect(result.stdout.match(/exit code: 1/g) || []).toHaveLength(1);
    expect(result.stdout).not.toContain("PREFLIGHT_TOP_LEVEL_FAILURE");
  });

  it("forces only the reported exit 3 path to end an active cleanup handle", async () => {
    const result = await runCliChild("cleanup_timeout");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(fakeSecret);
    const report = JSON.parse(
      result.stdout.split(/\r?\n/).find((line) => line.startsWith("{")) || "{}"
    );
    expect(report.failure).toEqual({
      checkId: "CONNECTION_CLEANUP_UNVERIFIED",
      status: "not_verified",
    });
    expect(result.stdout).toContain("exit code: 3");
  });

  it("converts a formatter exception to one secret-safe exit 3 report", async () => {
    const result = await runCliChild("formatter_failure");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(fakeSecret);
    const jsonLines = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"));
    expect(jsonLines).toHaveLength(1);
    expect(JSON.parse(jsonLines[0]).failure.checkId).toBe(
      "PREFLIGHT_FORMATTER_FAILURE"
    );
    expect(
      result.stdout.match(/ActusTube staging database preflight/g) || []
    ).toHaveLength(1);
  });

  it("does not report unverified database counts as zero", async () => {
    const output: string[] = [];
    const fixture = createAdapter();
    const report = await (executeStagingDatabasePreflight as any)({
      environment: {},
      repositoryRoot,
      adapter: fixture,
      stdout: (line: string) => output.push(line),
    });
    expect(report.exitCode).toBe(2);
    expect(report.migrationHistory.status).toBe("not_verified");
    expect(report.migrationHistory.applied).toBe("not_verified");
    expect(report.applicationTables).toBe("not_verified");
    expect(output.join("\n")).not.toContain("application tables: 0");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("formats a partial verified-failure report defensively", () => {
    const summary = formatHumanSummary({
      exitCode: 1,
      failure: { checkId: "USER_DEFINED_OBJECT_PRESENT", status: "fail" },
    } as any);
    expect(summary).toContain("user-defined objects (direct): not_verified");
    expect(summary).toContain("user-defined objects (pooled after): not_verified");
    expect(summary).toContain("failure check: USER_DEFINED_OBJECT_PRESENT");
    expect(summary).toContain("exit code: 1");
  });

  it("covers exit codes 0, 1, 2, and 3", async () => {
    const valid = await runPreflight(createAdapter());
    const stateMismatch = residualState("relation_count");
    const invalidState = await runPreflight(
      createAdapter({ directState: stateMismatch })
    );
    const invalidSafety = await runPreflight(createAdapter(), {
      ...validEnvironment(),
      ACTUSTUBE_DB_ENV: "production",
    });
    const unknown = await runPreflight(
      createAdapter({ directFailure: new Error(fakeSecret) })
    );
    expect([valid.exitCode, invalidState.exitCode, invalidSafety.exitCode, unknown.exitCode])
      .toEqual([0, 1, 2, 3]);
  });

  it("does not invoke migration or postflight commands", async () => {
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8")
    );
    expect(packageJson.scripts["db:preflight:staging"]).toBe(
      "node scripts/verify-staging-database-preflight.mjs"
    );
    const entry = await readFile(
      "scripts/verify-staging-database-preflight.mjs",
      "utf8"
    );
    expect(entry).not.toContain("drizzle-kit");
    expect(entry).not.toContain("db:migrate");
    expect(entry).not.toContain("db:verify:staging");
    expect(entry).not.toContain("verify-staging-database-postflight");
  });
});
