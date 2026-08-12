/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  const directConnection = createConnection(() => directState, directOptions);
  const pooledConnection = createConnection(() => pooledState, pooledOptions);
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

let semanticPostgres:
  | {
      cluster: EmbeddedPostgres;
      root: string;
      started: boolean;
    }
  | undefined;
let semanticPostgresStart: Promise<EmbeddedPostgres> | undefined;

function findSemanticPostgresPort() {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!windowsRoot) {
    throw new Error("PREFLIGHT_SEMANTIC_PORT_PLATFORM_UNAVAILABLE");
  }
  const powershell = join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$address = [System.Net.IPAddress]::Parse('127.0.0.1')
if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'ADDRESS_FAMILY_MISMATCH'
}
$listener = [System.Net.Sockets.TcpListener]::new($address, 0)
$port = 0
try {
  $listener.Start()
  $endpoint = [System.Net.IPEndPoint]$listener.LocalEndpoint
  $port = $endpoint.Port
} finally {
  $listener.Stop()
}
if ($port -lt 1 -or $port -gt 65535) {
  throw 'PORT_RANGE_INVALID'
}
[ordered]@{
  port = $port
  addressFamily = $address.AddressFamily.ToString()
  released = $true
} | ConvertTo-Json -Compress
`;
  const environment = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : []
    )
  ) as NodeJS.ProcessEnv;
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
    {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    }
  );
  if (
    result.error ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stderr.trim() !== ""
  ) {
    throw new Error("PREFLIGHT_SEMANTIC_PORT_UNAVAILABLE");
  }
  let allocation: unknown;
  try {
    allocation = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("PREFLIGHT_SEMANTIC_PORT_INVALID");
  }
  if (
    !allocation ||
    typeof allocation !== "object" ||
    !Number.isSafeInteger((allocation as any).port) ||
    (allocation as any).port < 1 ||
    (allocation as any).port > 65535 ||
    (allocation as any).addressFamily !== "InterNetwork" ||
    (allocation as any).released !== true
  ) {
    throw new Error("PREFLIGHT_SEMANTIC_PORT_INVALID");
  }
  return allocation as {
    port: number;
    addressFamily: "InterNetwork";
    released: true;
  };
}

const semanticPostgresPortAllocation = findSemanticPostgresPort();

async function getSemanticPostgres() {
  semanticPostgresStart ??= (async () => {
    const root = await mkdtemp(
      join(tmpdir(), "actustube-preflight-semantic-")
    );
    const cluster = new EmbeddedPostgres({
      databaseDir: join(root, "database"),
      user: "preflight_semantic_admin",
      password: randomUUID(),
      port: semanticPostgresPortAllocation.port,
      persistent: true,
      authMethod: "scram-sha-256",
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--no-sync"],
      postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
      onLog: () => undefined,
      onError: () => undefined,
    });
    semanticPostgres = { cluster, root, started: false };
    await cluster.initialise();
    await cluster.start();
    semanticPostgres.started = true;
    return cluster;
  })();
  return semanticPostgresStart;
}

async function queryExtensionClassification({
  managed,
  residual,
}: {
  managed: boolean;
  residual: boolean;
}) {
  const cluster = await getSemanticPostgres();
  const client = cluster.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  try {
    const managedSql = managed
      ? "SELECT 'pg_class'::pg_catalog.regclass::oid, 90001::oid, 0"
      : "SELECT 0::oid, 0::oid, 0 WHERE false";
    const residualSql = residual
      ? "SELECT 'relation'::text, 'pg_class'::pg_catalog.regclass::oid, 90001::oid, 0"
      : "SELECT ''::text, 0::oid, 0::oid, 0 WHERE false";
    return await client.query(`
      WITH extension_classification(
        object_signature,
        evidence_signature,
        evidence_kind,
        dependency_type,
        dependent_class,
        referenced_class,
        referenced_is_direct_extension_member,
        rule_name,
        relation_kind,
        trigger_constraint_matches,
        constraint_type
      ) AS (
        VALUES (
          '1259:90001:0'::text,
          'dependency:1259:90001:0:fixture'::text,
          'dependency'::text,
          'e'::text,
          'pg_class'::text,
          'pg_extension'::text,
          false,
          NULL::text,
          NULL::text,
          false,
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
        (
          SELECT count(*)::integer
          FROM extension_dependency_evidence
          WHERE classification_count = 0
        ) AS unclassified_count,
        (
          SELECT count(*)::integer
          FROM extension_dependency_evidence
          WHERE classification_count > 1
        ) AS ambiguous_count,
        (
          SELECT min(classification_count)::integer
          FROM extension_dependency_evidence
        ) AS classification_count,
        (
          SELECT count(*)::integer
          FROM extension_classification_complete
          WHERE evidence_kind = 'dependency'
        ) AS complete_dependency_count
    `);
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  if (!semanticPostgres) return;
  if (semanticPostgres.started) await semanticPostgres.cluster.stop();
  await rm(semanticPostgres.root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
});

beforeAll(async () => {
  await getSemanticPostgres();
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
  it("allocates and releases a numeric IPv4 port without DNS", () => {
    const dns = process.getBuiltinModule("dns");
    if (!dns) throw new Error("PREFLIGHT_SEMANTIC_DNS_MODULE_UNAVAILABLE");
    const lookup = vi.spyOn(dns, "lookup");
    try {
      const allocation = findSemanticPostgresPort();
      expect(allocation.port).toBeGreaterThan(0);
      expect(allocation.port).toBeLessThanOrEqual(65535);
      expect(allocation.addressFamily).toBe("InterNetwork");
      expect(allocation.released).toBe(true);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

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

  it("does not accept a staging marker supplied only by a URL query value", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DIRECT_DATABASE_URL:
        "postgresql://migration:dummy-password@ep-actustube-safe.example.test/app?application_name=staging",
      DATABASE_URL:
        "postgresql://runtime:dummy-password@ep-actustube-safe-pooler.example.test/app?application_name=staging",
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_STAGING_MARKER_REQUIRED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

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

  it("keeps every dependency evidence row in the actual production classification SQL", async () => {
    expect(PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects).toContain(
      PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS
    );
    const result = await queryExtensionClassification({
      managed: false,
      residual: false,
    });
    expect(result.rows[0]).toMatchObject({
      evidence_count: 1,
      complete_dependency_count: 1,
    });
  });

  it("marks dependency evidence outside both managed and residual sets as unclassified", async () => {
    const result = await queryExtensionClassification({
      managed: false,
      residual: false,
    });
    expect(result.rows[0]).toMatchObject({
      classification_count: 0,
      unclassified_count: 1,
      ambiguous_count: 0,
    });
  });

  it("accepts dependency evidence with exactly one SQL classification", async () => {
    const result = await queryExtensionClassification({
      managed: true,
      residual: false,
    });
    expect(result.rows[0]).toMatchObject({
      classification_count: 1,
      unclassified_count: 0,
      ambiguous_count: 0,
    });
  });

  it("marks dependency evidence in both managed and residual sets as ambiguous", async () => {
    const result = await queryExtensionClassification({
      managed: true,
      residual: true,
    });
    expect(result.rows[0]).toMatchObject({
      classification_count: 2,
      unclassified_count: 0,
      ambiguous_count: 1,
    });
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
      ).toBe(1);
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
        ).toBe(1);
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
      await (runPreflightCli as any)({
        mainFunction: async () => ({
          ...createPreflightBaseReport(),
          ...(exitCode === 0
            ? {
                extensionInventory: "match",
                initialState: "pristine",
                migrationHistory: {
                  status: "pass",
                  expected: 7,
                  applied: 0,
                  pending: 7,
                  pendingTags: [
                    "0000_crazy_spyke",
                    "0001_fix_google_oauth_account_variable_conflict",
                    "0002_add_atomic_usage_reservation",
                    "0003_add_usage_reservation_release",
                    "0004_add_stale_reservation_recovery",
                    "0005_silky_mystique",
                    "0006_usage_status_plan_snapshot",
                  ],
                  duplicates: 0,
                  unknown: 0,
                },
                applicationTables: 0,
                applicationFunctions: 0,
                applicationData: 0,
                partialSchema: "none",
                readOnlyInvariant: "pass",
                cleanup: "pass",
              }
            : {
                failure: {
                  checkId:
                    exitCode === 1
                      ? "USER_DEFINED_OBJECT_PRESENT"
                      : "STAGING_ENVIRONMENT_REQUIRED",
                  status: "fail",
                },
              }),
          exitCode,
        }),
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
