import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
const BENIGN_CHILD_SCHEMA_VERSION = 1;
const BENIGN_CHILD_TIMEOUT_MS = 2_000;

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

function createPgClientFactory() {
  return ({ host, port, database, role, password }) =>
    new Client({
      host,
      port,
      database,
      user: role,
      password,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
    });
}

async function openClient(clientFactory, credentials) {
  const client = await clientFactory(credentials);
  requireHarness(
    client &&
      typeof client.connect === "function" &&
      typeof client.query === "function" &&
      typeof client.end === "function",
    "EXTERNAL_FIXTURE_CONNECTION_FACTORY_INVALID"
  );
  await client.connect();
  return client;
}

async function withClient(clientFactory, credentials, operation) {
  const client = await openClient(clientFactory, credentials);
  try {
    return await operation(client);
  } finally {
    await client.end();
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

function createAdapter(clientFactory, credentialsForKind) {
  return {
    async connect(kind) {
      const client = await openClient(clientFactory, credentialsForKind(kind));
      return {
        query(statement, parameters = []) {
          return client.query(statement, parameters);
        },
        close() {
          return client.end();
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

async function expectedExtensionInventory(client) {
  const result = await client.query(PREFLIGHT_SQL_FOR_TESTS.extensionInventory);
  return JSON.stringify({ schemaVersion: 1, extensions: result.rows });
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
  configuration,
  clientFactory,
  extensions,
  betweenSnapshotTransactions
) {
  const statements = [];
  const adapter = createAdapter(clientFactory, () =>
    fixtureCredentials(configuration)
  );
  const report = await verifyStagingDatabasePreflight({
    environment: preflightEnvironment(configuration, extensions),
    repositoryRoot,
    adapter,
    allowLoopback: true,
    onQuery(statement) {
      assertReadOnlySql(statement);
      statements.push(statement);
    },
    betweenSnapshotTransactions,
  });
  return { report, statements };
}

async function queryExtensionClassification(
  clientFactory,
  configuration,
  { managed, residual }
) {
  return withClient(
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

async function verifyExtensionClassificationMatrix(clientFactory, configuration) {
  const cases = [
    { managed: true, residual: false, expected: [1, 0, 0, 1, 1] },
    { managed: false, residual: true, expected: [1, 0, 0, 1, 1] },
    { managed: false, residual: false, expected: [1, 1, 0, 0, 1] },
    { managed: true, residual: true, expected: [1, 0, 1, 2, 1] },
  ];
  for (const entry of cases) {
    const row = await queryExtensionClassification(
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

async function applyMigrationsAndRuntimeAcl(
  clientFactory,
  configuration,
  specification
) {
  requireHarness(
    specification.migrations.length === EXPECTED_MIGRATION_COUNT &&
      specification.migrations.at(-1)?.tag.startsWith("0006_"),
    "EXTERNAL_FIXTURE_MIGRATION_CONTRACT_MISMATCH"
  );
  await withClient(
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await client.query(
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
      );
      await migrate(drizzle(client), {
        migrationsFolder: join(repositoryRoot, "drizzle"),
      });
      await assertMigrationLedger(client, EXPECTED_MIGRATION_COUNT);
      await migrate(drizzle(client), {
        migrationsFolder: join(repositoryRoot, "drizzle"),
      });
      await assertMigrationLedger(client, EXPECTED_MIGRATION_COUNT);
      await client.query(`
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
  );
}

async function verifyTransactionRollback(clientFactory, configuration) {
  await withClient(
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
        await client.query("ROLLBACK");
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

async function runPostflight(clientFactory, configuration) {
  const { environment, secretParts } = postflightEnvironment(configuration);
  const output = [];
  const statements = [];
  const adapter = createAdapter(clientFactory, (kind) =>
    kind === "direct"
      ? fixtureCredentials(configuration)
      : fixtureCredentials(configuration, {
          role: RUNTIME_ROLE,
          password: RUNTIME_PASSWORD,
        })
  );
  const report = await executeStagingDatabasePostflight({
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
  });
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
    migrationOrderAndReplay: true,
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

export async function runConnectionOnlyHarness({
  environment = process.env,
  clientFactory = createPgClientFactory(),
} = {}) {
  const configuration = validateExternalFixtureConfiguration(environment);
  requireHarness(
    typeof clientFactory === "function",
    "EXTERNAL_FIXTURE_CONNECTION_FACTORY_INVALID"
  );
  const specification = await loadRepositorySpecification(repositoryRoot);
  requireHarness(
    specification.migrations.length === configuration.expectedMigrationMax + 1,
    "EXTERNAL_FIXTURE_MIGRATION_CONTRACT_MISMATCH"
  );

  const extensions = await withClient(
    clientFactory,
    fixtureCredentials(configuration),
    async (client) => {
      await assertFixtureIdentity(client, configuration);
      await createEmptyMigrationLedger(client);
      return expectedExtensionInventory(client);
    }
  );

  const stable = await runStablePreflight(
    configuration,
    clientFactory,
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
    configuration,
    clientFactory,
    extensions,
    async () => {
      await withClient(
        clientFactory,
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
    clientFactory,
    fixtureCredentials(configuration),
    (client) => client.query("DROP TABLE public.external_fixture_snapshot_drift")
  );

  await verifyExtensionClassificationMatrix(clientFactory, configuration);
  await applyMigrationsAndRuntimeAcl(
    clientFactory,
    configuration,
    specification
  );
  await verifyTransactionRollback(clientFactory, configuration);

  const postflight = await runPostflight(clientFactory, configuration);
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
    clientFactory,
    fixtureCredentials(configuration),
    (client) =>
      client.query("CREATE TABLE public.external_fixture_postflight_drift (id integer)")
  );
  const postflightDrift = await runPostflight(clientFactory, configuration);
  requireHarness(
    postflightDrift.report.exitCode === 1 &&
      postflightDrift.report.failure?.checkId === "TABLE_SET_MISMATCH",
    "EXTERNAL_FIXTURE_POSTFLIGHT_DRIFT_NOT_REJECTED"
  );
  await withClient(
    clientFactory,
    fixtureCredentials(configuration),
    (client) => client.query("DROP TABLE public.external_fixture_postflight_drift")
  );

  return publicSuccessResult();
}

const BENIGN_CHILD_SOURCE = String.raw`
const SCHEMA = 1;
let initialized = false;
let sequence = 0;
let binding;
let lastMessage;
const exactMessage = (phase) => ({
  schemaVersion: SCHEMA,
  occurrenceId: binding.occurrenceId,
  capabilityToken: binding.capabilityToken,
  sequence: ++sequence,
  phase,
});
const send = (phase) => new Promise((resolveSend) => {
  lastMessage = exactMessage(phase);
  process.send(lastMessage, resolveSend);
});
const sendRaw = (message) => new Promise((resolveSend) => {
  process.send(message, resolveSend);
});
process.once('message', async (message) => {
  if (initialized || !message || message.schemaVersion !== SCHEMA) process.exit(79);
  initialized = true;
  binding = message;
  const mode = binding.mode;
  if (mode === 'pre-phase-failure') process.exit(73);
  await send('created');
  if (mode === 'duplicate-phase') {
    await sendRaw(lastMessage);
    process.exit(70);
  }
  if (mode === 'malformed-phase') {
    await sendRaw({ phase: 'running' });
    process.exit(70);
  }
  if (mode === 'replayed-phase') {
    await send('running');
    await sendRaw({ ...lastMessage, sequence: 1 });
    process.exit(70);
  }
  if (mode === 'correct-signal' || mode === 'wrong-signal') {
    await send('signal_ready');
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'deadline') {
    await send('deadline_pending');
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'normal-before-deadline') {
    await send('deadline_pending');
    process.exit(0);
  }
  await send('running');
  if (mode === 'unexpected-normal-after-phase') process.exit(0);
  if (mode === 'forged-terminal-reason') {
    await sendRaw({ ...exactMessage('terminal'), reason: 'claimed' });
    process.exit(71);
  }
  await send('terminal');
  if (mode === 'wrong-nonzero') process.exit(71);
  if (mode === 'exit-zero') process.exit(0);
  process.exit(70);
});
`;

const BENIGN_CONTRACTS = Object.freeze({
  "correct-nonzero": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "wrong-nonzero": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "exit-zero": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "correct-signal": {
    phases: ["created", "signal_ready"],
    signal: "SIGTERM",
  },
  "wrong-signal": {
    phases: ["created", "signal_ready"],
    signal: "SIGTERM",
  },
  deadline: {
    phases: ["created", "deadline_pending"],
    signal: "SIGTERM",
    deadline: true,
  },
  "normal-before-deadline": {
    phases: ["created", "deadline_pending"],
    signal: "SIGTERM",
    deadline: true,
  },
  "pre-phase-failure": {
    phases: ["created"],
    exitCode: 70,
  },
  "unexpected-normal-after-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "forged-terminal-reason": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "duplicate-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "malformed-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "replayed-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
});

function exactOwnKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

export async function runBenignChildLifecycleProbeForTests(
  mode,
  { deadlineMilliseconds = 150 } = {}
) {
  const contract = BENIGN_CONTRACTS[mode];
  requireHarness(Boolean(contract), "BENIGN_CHILD_MODE_INVALID");
  requireHarness(
    Number.isSafeInteger(deadlineMilliseconds) &&
      deadlineMilliseconds >= 50 &&
      deadlineMilliseconds <= 1_000,
    "BENIGN_CHILD_DEADLINE_INVALID"
  );
  const occurrenceId = randomUUID();
  const capabilityToken = randomUUID();
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", BENIGN_CHILD_SOURCE],
    {
      env: {},
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    }
  );

  return new Promise((resolveProbe, rejectProbe) => {
    const messages = [];
    const exitEvents = [];
    const closeEvents = [];
    const errorEvents = [];
    let deadlineAlive = false;
    let settled = false;
    let deadlineTimer;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const authenticatedMessages = messages.filter(
        (message, index) =>
          exactOwnKeys(message, [
            "schemaVersion",
            "occurrenceId",
            "capabilityToken",
            "sequence",
            "phase",
          ]) &&
          message.schemaVersion === BENIGN_CHILD_SCHEMA_VERSION &&
          message.occurrenceId === occurrenceId &&
          message.capabilityToken === capabilityToken &&
          message.sequence === index + 1 &&
          typeof message.phase === "string"
      );
      const messageContract =
        messages.length > 0 && authenticatedMessages.length === messages.length;
      const authenticatedPhases = authenticatedMessages.map(
        (message) => message.phase
      );
      const phaseContract =
        messageContract &&
        JSON.stringify(authenticatedPhases) === JSON.stringify(contract.phases);
      const exit = exitEvents[0];
      const close = closeEvents[0];
      const processError = errorEvents[0];
      const terminalContract =
        exitEvents.length === 1 &&
        closeEvents.length === 1 &&
        exit?.code === close?.code &&
        exit?.signal === close?.signal &&
        (contract.exitCode !== undefined
          ? exit?.code === contract.exitCode && exit?.signal === null
          : exit?.code === null && exit?.signal === contract.signal);
      const deadlineContract = contract.deadline ? deadlineAlive : true;
      resolveProbe({
        schemaVersion: BENIGN_CHILD_SCHEMA_VERSION,
        mode,
        accepted:
          messageContract &&
          phaseContract &&
          terminalContract &&
          deadlineContract &&
          errorEvents.length === 0,
        messageContract,
        phaseContract,
        terminalContract,
        authenticatedPhases,
        deadlineAlive,
        exitObservation: {
          count: exitEvents.length,
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          timestampMilliseconds: exit?.timestampMilliseconds ?? null,
        },
        closeObservation: {
          count: closeEvents.length,
          code: close?.code ?? null,
          signal: close?.signal ?? null,
          timestampMilliseconds: close?.timestampMilliseconds ?? null,
        },
        errorObservation: {
          count: errorEvents.length,
          timestampMilliseconds: processError?.timestampMilliseconds ?? null,
        },
      });
    };

    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectProbe(new HarnessIssue("BENIGN_CHILD_OBSERVATION_TIMEOUT"));
    }, BENIGN_CHILD_TIMEOUT_MS);

    child.on("message", (message) => {
      messages.push(message);
      if (
        messages.length === 2 &&
        message?.phase === "signal_ready" &&
        (mode === "correct-signal" || mode === "wrong-signal")
      ) {
        child.kill(mode === "correct-signal" ? "SIGTERM" : "SIGKILL");
      }
    });
    child.once("error", () => {
      errorEvents.push({ timestampMilliseconds: performance.now() });
    });
    child.on("exit", (code, signal) => {
      exitEvents.push({
        code,
        signal,
        timestampMilliseconds: performance.now(),
      });
    });
    child.on("close", (code, signal) => {
      closeEvents.push({
        code,
        signal,
        timestampMilliseconds: performance.now(),
      });
      finish();
    });

    if (contract.deadline) {
      deadlineTimer = setTimeout(() => {
        deadlineAlive = exitEvents.length === 0 && closeEvents.length === 0;
        if (deadlineAlive) child.kill("SIGTERM");
      }, deadlineMilliseconds);
    }

    child.send({
      schemaVersion: BENIGN_CHILD_SCHEMA_VERSION,
      occurrenceId,
      capabilityToken,
      mode,
    });
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
