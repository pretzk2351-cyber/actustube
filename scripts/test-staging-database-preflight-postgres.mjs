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
const LEGACY_USAGE_SIGNATURE =
  "public.reserve_usage_limits(uuid,integer,public.usage_metric,timestamp with time zone)";
const VERSIONED_USAGE_SIGNATURES = Object.freeze([
  "public.usage_period_boundaries_v1(timestamp with time zone)",
  "public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)",
  "public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.get_usage_status_v1(uuid,integer,timestamp with time zone)",
]);
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

class HarnessIssue extends Error {
  constructor(code) {
    super(code);
    this.name = "HarnessIssue";
    this.code = code;
  }
}

function requireHarness(condition, code) {
  if (!condition) throw new HarnessIssue(code);
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

async function withClient(context, clientFactory, credentials, operation) {
  const ownedClient = await openClient(context, clientFactory, credentials);
  try {
    return await operation(ownedClient.proxy, ownedClient);
  } finally {
    await closeOwnedClient(context, ownedClient);
  }
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

async function applyMigrationCount(context, client, expectedCount) {
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
  await runBoundedPhase(
    context,
    "migration",
    context.limits.migrationMilliseconds,
    () =>
      database.dialect.migrate(
        migrations.slice(0, expectedCount),
        database.session,
        configuration
      )
  );
}

async function configureUsageMigrationBaseline(client) {
  const roles = USAGE_FIXTURE_ROLES;
  await client.query(`
    CREATE ROLE ${quoteIdentifier(roles.explicitRuntime)} NOLOGIN;
    CREATE ROLE ${quoteIdentifier(roles.runtimeGroup)} NOLOGIN;
    CREATE ROLE ${quoteIdentifier(roles.membershipRuntime)} NOLOGIN;
    CREATE ROLE ${quoteIdentifier(roles.deniedRuntime)} NOLOGIN;
    CREATE ROLE ${quoteIdentifier(roles.publicProbe)} NOLOGIN;
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

async function verifyPublicAclMigrationFailure(context, client) {
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${LEGACY_USAGE_SIGNATURE} TO PUBLIC`
  );
  await expectDatabaseFailure(
    () => applyMigrationCount(context, client, EXPECTED_MIGRATION_COUNT),
    "P0001"
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

async function applyMigrationsAndRuntimeAcl(
  context,
  clientFactory,
  configuration,
  specification
) {
  requireHarness(
    specification.migrations.length === EXPECTED_MIGRATION_COUNT &&
      specification.migrations.at(-1)?.tag.startsWith("0006_"),
    "EXTERNAL_FIXTURE_MIGRATION_CONTRACT_MISMATCH"
  );
  let legacyAclHash;
  await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await client.query(
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
      );
      await applyMigrationCount(context, client, EXPECTED_MIGRATION_MAX);
      await assertMigrationLedger(client, EXPECTED_MIGRATION_MAX);
      await verifyOldMigrationCompatibility(context, client);
      await configureUsageMigrationBaseline(client);
      await verifyPublicAclMigrationFailure(context, client);
      legacyAclHash = (
        await client.query(
          `SELECT pg_catalog.md5(proacl::text) AS acl_hash
           FROM pg_catalog.pg_proc
           WHERE oid = pg_catalog.to_regprocedure($1)`,
          [LEGACY_USAGE_SIGNATURE]
        )
      ).rows?.[0]?.acl_hash;
      requireHarness(
        typeof legacyAclHash === "string",
        "EXTERNAL_FIXTURE_LEGACY_ACL_UNAVAILABLE"
      );
      await applyMigrationCount(context, client, EXPECTED_MIGRATION_COUNT);
      await assertMigrationLedger(client, EXPECTED_MIGRATION_COUNT);
      await applyMigrationCount(context, client, EXPECTED_MIGRATION_COUNT);
      await assertMigrationLedger(client, EXPECTED_MIGRATION_COUNT);
    }
  );
  await verifyUsageAclInheritance(
    context,
    clientFactory,
    configuration,
    legacyAclHash
  );
  await verifyPlanResolution(context, clientFactory, configuration);
  await verifyReservationLifecycle(context, clientFactory, configuration);
  await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    (client) => configureRuntimeAcl(client, configuration)
  );
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
  legacyAclHash
) {
  await withClient(
    context,
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
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
 *   environment?: NodeJS.ProcessEnv,
 *   clientFactory?: ((credentials: object) => object),
 *   deadlineLimits?: object,
 * }} [options]
 */
export async function runConnectionOnlyHarness(options = {}) {
  const {
    environment = process.env,
    clientFactory,
    deadlineLimits,
  } = options;
  const context = createDeadlineContext(deadlineLimits);
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
      await assertFixtureIdentity(client, configuration);
      await createEmptyMigrationLedger(client);
      return await verifyIndependentExtensionInventory(client);
    }
  );

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

  await verifyExtensionClassificationMatrix(
    context,
    resolvedClientFactory,
    configuration
  );
  await applyMigrationsAndRuntimeAcl(
    context,
    resolvedClientFactory,
    configuration,
    specification
  );
  await verifyTransactionRollback(context, resolvedClientFactory, configuration);

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

  await withClient(
    context,
    resolvedClientFactory,
    fixtureCredentials(configuration),
    (client) =>
      client.query("CREATE TABLE public.external_fixture_postflight_drift (id integer)")
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

  return publicSuccessResult();
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
    const ownedClient = await openClient(context, () => client, {});
    if (scenario === "total-deadline-exhausted") {
      context.absoluteDeadline = performance.now() - 1;
      await ownedClient.proxy.query("SELECT fixed_deadline_probe");
    } else if (scenario === "raw-query-hang") {
      await ownedClient.proxy.query("SELECT fixed_deadline_probe");
    } else if (scenario === "transaction-hang") {
      await ownedClient.proxy.query("BEGIN");
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
    const marker =
      error instanceof HarnessIssue &&
      error.code === "EXTERNAL_FIXTURE_NOT_CONFIGURED"
        ? "EXTERNAL_FIXTURE_NOT_CONFIGURED"
        : "EXTERNAL_FIXTURE_VERIFICATION_FAILED";
    process.stderr.write(`${marker}\n`);
    process.exitCode = 1;
  }
}
