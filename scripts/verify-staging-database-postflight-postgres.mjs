import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pgPackage from "pg";

import { executeStagingDatabasePostflight } from "./verify-staging-database-postflight.mjs";
import { assertReadOnlySql } from "./staging-database-postflight/safety.mjs";
import {
  FORBIDDEN_ENVIRONMENT_NAME,
  isSafeHarnessTemporaryPath,
} from "./usage-migration-harness-safety.mjs";

const { Client } = pgPackage;
const repositoryRoot = process.cwd();
const workerMode = process.argv[2];
const disposableRoot = resolve(process.argv[3] || "");
const ownerNonce = process.argv[4];
const timeoutMode = workerMode === "--actustube-postflight-timeout-worker";

if (
  process.argv.length !== 5 ||
  ![
    "--actustube-postflight-worker",
    "--actustube-postflight-timeout-worker",
  ].includes(workerMode) ||
  !isSafeHarnessTemporaryPath(disposableRoot, tmpdir())
) {
  console.error(JSON.stringify({ success: false, errorCode: "POSTFLIGHT_WORKER_REJECTED" }));
  process.exit(1);
}
assert.equal(
  await readFile(join(disposableRoot, ".actustube-harness-owner"), "utf8"),
  ownerNonce
);
assert.deepEqual(
  Object.keys(process.env).filter((key) => FORBIDDEN_ENVIRONMENT_NAME.test(key)),
  []
);
if (process.platform !== "win32") {
  console.error(JSON.stringify({ success: false, errorCode: "WINDOWS_BIND_REQUIRED" }));
  process.exit(1);
}

if (timeoutMode) {
  await new Promise(() => {
    setInterval(() => undefined, 1_000);
  });
}

const role = {
  migration: "fixture_postflight_migration",
  runtime: "fixture_postflight_runtime",
  unexpected: "fixture_postflight_unexpected",
};
const passwords = {
  admin: randomUUID(),
  migration: randomUUID(),
  runtime: randomUUID(),
};
const databaseNames = {
  primary: "fixture_postflight_primary",
  mismatch: "fixture_postflight_mismatch",
  broken: "fixture_postflight_broken",
  acl: "fixture_postflight_acl",
  implicitAcl: "fixture_postflight_implicit_acl",
  defaultAcl: "fixture_postflight_default_acl",
  defaultUnexpected: "fixture_postflight_default_unexpected",
  grantOption: "fixture_postflight_grant_option",
  columnAcl: "fixture_postflight_column_acl",
  sequenceAcl: "fixture_postflight_sequence_acl",
  drizzleUnexpected: "fixture_postflight_drizzle_unexpected",
  drizzleColumnAcl: "fixture_postflight_drizzle_column_acl",
  unknownObject: "fixture_postflight_unknown_object",
  unknownFunction: "fixture_postflight_unknown_function",
  unknownEnum: "fixture_postflight_unknown_enum",
  functionDefault: "fixture_postflight_function_default",
  history: "fixture_postflight_history",
};

function quoteIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/);
  return `"${value}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.unref();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("POSTFLIGHT_PORT_UNAVAILABLE"));
        return;
      }
      listener.close((error) =>
        error ? reject(error) : resolvePort(address.port)
      );
    });
  });
}

const port = await findFreePort();
const databaseDirectory = join(disposableRoot, "database");
const postgres = new EmbeddedPostgres({
  databaseDir: databaseDirectory,
  user: "fixture_postflight_admin",
  password: passwords.admin,
  port,
  // The harness owns and verifies removal of the guarded temporary root after
  // every PostgreSQL process has exited. Avoid the library's earlier Windows
  // data-directory removal racing with PostgreSQL child-process shutdown.
  persistent: true,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  onLog: () => undefined,
  onError: () => undefined,
});

const originalSocketConnect = Socket.prototype.connect;
let externalConnections = 0;
let loopbackConnections = 0;
Socket.prototype.connect = function guardedConnect(...argumentsList) {
  const first = argumentsList[0];
  const host =
    first && typeof first === "object"
      ? first.host
      : typeof first === "number"
        ? argumentsList[1]
        : undefined;
  const localSocket =
    typeof first === "string" ||
    (first && typeof first === "object" && typeof first.path === "string");
  if (!localSocket && host !== "127.0.0.1" && host !== "::1") {
    externalConnections += 1;
    throw new Error("NON_LOOPBACK_DATABASE_CONNECTION_BLOCKED");
  }
  loopbackConnections += 1;
  return originalSocketConnect.apply(this, argumentsList);
};

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(processId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!processExists(processId)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !processExists(processId);
}

function clientConfig(database, user, password) {
  return {
    host: "127.0.0.1",
    port,
    database,
    user,
    password,
    connectionTimeoutMillis: 10_000,
  };
}

async function withClient(config, operation) {
  const client = new Client(config);
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function adminQuery(database, statement) {
  return withClient(
    clientConfig(database, "fixture_postflight_admin", passwords.admin),
    (client) => client.query(statement)
  );
}

async function createFixtureDatabase(database) {
  await adminQuery(
    "postgres",
    `CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(role.migration)}`
  );
  await withClient(
    clientConfig(database, role.migration, passwords.migration),
    async (client) => {
      await client.query(
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
      );
      await migrate(drizzle(client), { migrationsFolder: join(repositoryRoot, "drizzle") });
    }
  );
  await adminQuery(
    database,
    `
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
      ALTER ROLE ${quoteIdentifier(role.runtime)} SET search_path = public, pg_temp;
      GRANT USAGE ON SCHEMA public, drizzle TO ${quoteIdentifier(role.runtime)};
      GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${quoteIdentifier(role.runtime)};
      GRANT SELECT, INSERT, UPDATE ON TABLE
        public.users,
        public.oauth_accounts,
        public.user_usage_buckets,
        public.analysis_runs,
        public.improvement_actions
        TO ${quoteIdentifier(role.runtime)};
      GRANT SELECT ON TABLE
        public.plans,
        public.user_plan_assignments
        TO ${quoteIdentifier(role.runtime)};
      GRANT SELECT, INSERT, DELETE ON TABLE
        public.usage_reservation_leases
        TO ${quoteIdentifier(role.runtime)};
      GRANT USAGE ON TYPE
        public.user_status,
        public.plan_assignment_status,
        public.plan_assignment_source,
        public.usage_metric,
        public.usage_period_kind,
        public.improvement_action_status
        TO ${quoteIdentifier(role.runtime)};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${quoteIdentifier(role.runtime)};
    `
  );
}

function createAdapter({ directDatabase, pooledDatabase }) {
  return {
    async connect(kind) {
      const isDirect = kind === "direct";
      const client = new Client(
        clientConfig(
          isDirect ? directDatabase : pooledDatabase,
          isDirect ? role.migration : role.runtime,
          isDirect ? passwords.migration : passwords.runtime
        )
      );
      await client.connect();
      return {
        query: (statement, parameters) => client.query(statement, parameters),
        close: () => client.end(),
      };
    },
  };
}

function localEnvironment(databaseLabel) {
  const directUrl = `postgresql://local-direct:local-secret@127.0.0.1:${port}/${databaseLabel}`;
  const pooledUrl = `postgresql://local-runtime:local-secret@127.0.0.1:${port}/${databaseLabel}`;
  return {
    ACTUSTUBE_DB_ENV: "staging",
    ACTUSTUBE_ALLOW_STAGING_DB_VERIFY: "1",
    DIRECT_DATABASE_URL: directUrl,
    DATABASE_URL: pooledUrl,
    ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "local-postflight-fixture",
  };
}

async function runVerification(adapter, databaseLabel) {
  const output = [];
  const queries = [];
  const report = await executeStagingDatabasePostflight({
    environment: localEnvironment(databaseLabel),
    repositoryRoot,
    adapter,
    allowLoopback: true,
    onQuery: (statement) => queries.push(statement),
    stdout: (line) => output.push(line),
  });
  for (const statement of queries) assertReadOnlySql(statement);
  const serialized = output.join("\n");
  for (const forbidden of [
    "local-secret",
    "local-direct",
    "local-runtime",
    databaseLabel,
    String(port),
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  return { report, queries, serialized };
}

let results = { success: false };
let postgresStarted = false;
let postmasterPid;
let verificationStep = "initialize";
let lastCheckId = null;
try {
  verificationStep = "postgres-start";
  await postgres.initialise();
  await postgres.start();
  postgresStarted = true;
  postmasterPid = Number(
    (await readFile(join(databaseDirectory, "postmaster.pid"), "utf8"))
      .split(/\r?\n/)[0]
      .trim()
  );
  assert.equal(processExists(postmasterPid), true);

  verificationStep = "role-provision";
  await adminQuery(
    "postgres",
    `
      CREATE ROLE ${quoteIdentifier(role.migration)}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(passwords.migration)};
      CREATE ROLE ${quoteIdentifier(role.runtime)}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(passwords.runtime)};
      CREATE ROLE ${quoteIdentifier(role.unexpected)}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    `
  );
  for (const database of Object.values(databaseNames)) {
    verificationStep = "database-provision";
    await createFixtureDatabase(database);
  }

  verificationStep = "normal-postflight";
  const success = await runVerification(
    createAdapter({
      directDatabase: databaseNames.primary,
      pooledDatabase: databaseNames.primary,
    }),
    "local-fixture"
  );
  lastCheckId = success.report.failure?.checkId || null;
  assert.equal(success.report.exitCode, 0);
  assert.equal(success.report.sameLogicalDatabase, "pass");

  verificationStep = "logical-database-mismatch";
  const mismatch = await runVerification(
    createAdapter({
      directDatabase: databaseNames.primary,
      pooledDatabase: databaseNames.mismatch,
    }),
    "local-fixture"
  );
  assert.equal(mismatch.report.exitCode, 1);
  assert.equal(mismatch.report.sameLogicalDatabase, "fail");

  verificationStep = "schema-failure";
  await adminQuery(
    databaseNames.broken,
    "ALTER TABLE public.users DROP COLUMN image_url"
  );
  const broken = await runVerification(
    createAdapter({
      directDatabase: databaseNames.broken,
      pooledDatabase: databaseNames.broken,
    }),
    "local-fixture"
  );
  assert.equal(broken.report.exitCode, 1);
  assert.equal(broken.report.failure?.checkId, "COLUMN_SET_MISMATCH");

  verificationStep = "acl-failure";
  await adminQuery(
    databaseNames.acl,
    "GRANT EXECUTE ON FUNCTION public.get_usage_status_v1(uuid, integer, timestamp with time zone) TO PUBLIC"
  );
  const acl = await runVerification(
    createAdapter({
      directDatabase: databaseNames.acl,
      pooledDatabase: databaseNames.acl,
    }),
    "local-fixture"
  );
  assert.equal(acl.report.exitCode, 1);
  assert.equal(acl.report.failure?.checkId, "FUNCTION_PUBLIC_EXECUTE_PRESENT");

  verificationStep = "implicit-acl-failure";
  await adminQuery(
    databaseNames.implicitAcl,
    `
      DROP FUNCTION public.usage_period_boundaries_v1(timestamp with time zone);
      CREATE FUNCTION public.usage_period_boundaries_v1(
        p_now timestamp with time zone DEFAULT statement_timestamp()
      )
      RETURNS TABLE (
        daily_period_start timestamp with time zone,
        daily_reset_at timestamp with time zone,
        monthly_period_start timestamp with time zone,
        monthly_reset_at timestamp with time zone
      )
      LANGUAGE sql
      STABLE
      SECURITY INVOKER
      SET search_path = public, pg_temp
      AS $$
        SELECT
          date_trunc('day', p_now),
          date_trunc('day', p_now) + interval '1 day',
          date_trunc('month', p_now),
          date_trunc('month', p_now) + interval '1 month'
      $$;
    `
  );
  const implicitAcl = await runVerification(
    createAdapter({
      directDatabase: databaseNames.implicitAcl,
      pooledDatabase: databaseNames.implicitAcl,
    }),
    "local-fixture"
  );
  assert.equal(implicitAcl.report.exitCode, 1);
  assert.equal(
    implicitAcl.report.failure?.checkId,
    "FUNCTION_PUBLIC_EXECUTE_PRESENT"
  );

  verificationStep = "default-acl-failure";
  await adminQuery(
    databaseNames.defaultAcl,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(role.migration)}
       GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
  );
  const defaultAcl = await runVerification(
    createAdapter({
      directDatabase: databaseNames.defaultAcl,
      pooledDatabase: databaseNames.defaultAcl,
    }),
    "local-fixture"
  );
  assert.equal(defaultAcl.report.exitCode, 1);
  assert.equal(
    defaultAcl.report.failure?.checkId,
    "DEFAULT_PUBLIC_PRIVILEGE_PRESENT"
  );

  verificationStep = "default-unexpected-grantee-failure";
  await adminQuery(
    databaseNames.defaultUnexpected,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(role.migration)}
       GRANT SELECT ON TABLES TO ${quoteIdentifier(role.runtime)}`
  );
  const defaultUnexpected = await runVerification(
    createAdapter({
      directDatabase: databaseNames.defaultUnexpected,
      pooledDatabase: databaseNames.defaultUnexpected,
    }),
    "local-fixture"
  );
  assert.equal(defaultUnexpected.report.exitCode, 1);
  assert.equal(
    defaultUnexpected.report.failure?.checkId,
    "DEFAULT_PRIVILEGE_UNEXPECTED_GRANTEE"
  );

  verificationStep = "grant-option-failure";
  await adminQuery(
    databaseNames.grantOption,
    `GRANT SELECT ON TABLE public.users TO ${quoteIdentifier(role.runtime)} WITH GRANT OPTION`
  );
  const grantOption = await runVerification(
    createAdapter({
      directDatabase: databaseNames.grantOption,
      pooledDatabase: databaseNames.grantOption,
    }),
    "local-fixture"
  );
  assert.equal(grantOption.report.exitCode, 1);
  assert.equal(grantOption.report.failure?.checkId, "TABLE_GRANT_OPTION_PRESENT");

  verificationStep = "column-acl-failure";
  await adminQuery(
    databaseNames.columnAcl,
    `GRANT SELECT (email) ON TABLE public.users TO ${quoteIdentifier(role.runtime)}`
  );
  const columnAcl = await runVerification(
    createAdapter({
      directDatabase: databaseNames.columnAcl,
      pooledDatabase: databaseNames.columnAcl,
    }),
    "local-fixture"
  );
  assert.equal(columnAcl.report.exitCode, 1);
  assert.equal(columnAcl.report.failure?.checkId, "COLUMN_LEVEL_PRIVILEGE_PRESENT");

  verificationStep = "sequence-select-failure";
  await adminQuery(
    databaseNames.sequenceAcl,
    `GRANT SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO ${quoteIdentifier(role.runtime)}`
  );
  const sequenceAcl = await runVerification(
    createAdapter({
      directDatabase: databaseNames.sequenceAcl,
      pooledDatabase: databaseNames.sequenceAcl,
    }),
    "local-fixture"
  );
  assert.equal(sequenceAcl.report.exitCode, 1);
  assert.equal(
    sequenceAcl.report.failure?.checkId,
    "RUNTIME_SEQUENCE_PRIVILEGE_EXCESS"
  );

  verificationStep = "drizzle-unexpected-grantee-failure";
  await adminQuery(
    databaseNames.drizzleUnexpected,
    `GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${quoteIdentifier(role.unexpected)}`
  );
  const drizzleUnexpected = await runVerification(
    createAdapter({
      directDatabase: databaseNames.drizzleUnexpected,
      pooledDatabase: databaseNames.drizzleUnexpected,
    }),
    "local-fixture"
  );
  assert.equal(drizzleUnexpected.report.exitCode, 1);
  assert.equal(
    drizzleUnexpected.report.failure?.checkId,
    "RUNTIME_MIGRATION_HISTORY_PRIVILEGE_MISMATCH"
  );

  verificationStep = "drizzle-column-acl-failure";
  await adminQuery(
    databaseNames.drizzleColumnAcl,
    `GRANT SELECT (hash) ON TABLE drizzle.__drizzle_migrations TO ${quoteIdentifier(role.runtime)}`
  );
  const drizzleColumnAcl = await runVerification(
    createAdapter({
      directDatabase: databaseNames.drizzleColumnAcl,
      pooledDatabase: databaseNames.drizzleColumnAcl,
    }),
    "local-fixture"
  );
  assert.equal(drizzleColumnAcl.report.exitCode, 1);
  assert.equal(
    drizzleColumnAcl.report.failure?.checkId,
    "COLUMN_LEVEL_PRIVILEGE_PRESENT"
  );

  verificationStep = "unknown-object-failure";
  await adminQuery(
    databaseNames.unknownObject,
    "CREATE TABLE public.unexpected_manual_object (id integer PRIMARY KEY)"
  );
  const unknownObject = await runVerification(
    createAdapter({
      directDatabase: databaseNames.unknownObject,
      pooledDatabase: databaseNames.unknownObject,
    }),
    "local-fixture"
  );
  assert.equal(unknownObject.report.exitCode, 1);
  assert.equal(unknownObject.report.failure?.checkId, "TABLE_SET_MISMATCH");

  verificationStep = "unknown-function-failure";
  await adminQuery(
    databaseNames.unknownFunction,
    `CREATE FUNCTION public.unexpected_manual_function()
       RETURNS integer
       LANGUAGE sql
       SECURITY INVOKER
       SET search_path = public, pg_temp
       AS $$ SELECT 1 $$`
  );
  const unknownFunction = await runVerification(
    createAdapter({
      directDatabase: databaseNames.unknownFunction,
      pooledDatabase: databaseNames.unknownFunction,
    }),
    "local-fixture"
  );
  assert.equal(unknownFunction.report.exitCode, 1);
  assert.equal(unknownFunction.report.failure?.checkId, "FUNCTION_SET_MISMATCH");

  verificationStep = "unknown-enum-failure";
  await adminQuery(
    databaseNames.unknownEnum,
    "CREATE TYPE public.unexpected_manual_enum AS ENUM ('x')"
  );
  const unknownEnum = await runVerification(
    createAdapter({
      directDatabase: databaseNames.unknownEnum,
      pooledDatabase: databaseNames.unknownEnum,
    }),
    "local-fixture"
  );
  assert.equal(unknownEnum.report.exitCode, 1);
  assert.equal(unknownEnum.report.failure?.checkId, "ENUM_SET_MISMATCH");

  verificationStep = "function-default-failure";
  const functionDefinition = await adminQuery(
    databaseNames.functionDefault,
    `SELECT pg_catalog.pg_get_functiondef(
       'public.usage_period_boundaries_v1(timestamp with time zone)'::regprocedure
     ) AS definition`
  );
  const originalDefinition = functionDefinition.rows[0]?.definition;
  assert.equal(typeof originalDefinition, "string");
  const changedDefinition = originalDefinition.replace(
    "DEFAULT statement_timestamp()",
    "DEFAULT clock_timestamp()"
  );
  assert.notEqual(changedDefinition, originalDefinition);
  await adminQuery(databaseNames.functionDefault, changedDefinition);
  const functionDefault = await runVerification(
    createAdapter({
      directDatabase: databaseNames.functionDefault,
      pooledDatabase: databaseNames.functionDefault,
    }),
    "local-fixture"
  );
  assert.equal(functionDefault.report.exitCode, 1);
  assert.equal(functionDefault.report.failure?.checkId, "FUNCTION_BEHAVIOR_MISMATCH");

  verificationStep = "history-failure";
  await adminQuery(
    databaseNames.history,
    "UPDATE drizzle.__drizzle_migrations SET hash = repeat('0', 64) WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)"
  );
  const history = await runVerification(
    createAdapter({
      directDatabase: databaseNames.history,
      pooledDatabase: databaseNames.history,
    }),
    "local-fixture"
  );
  assert.equal(history.report.exitCode, 1);
  assert.equal(history.report.failure?.checkId, "MIGRATION_HISTORY_HASH_MISMATCH");

  assert.equal(externalConnections, 0);
  assert.ok(loopbackConnections > 0);
  results = {
    success: true,
    normal_postflight: true,
    direct_pooled_mismatch_rejected: true,
    intentional_schema_failure_rejected: true,
    intentional_acl_failure_rejected: true,
    implicit_public_execute_rejected: true,
    default_public_privilege_rejected: true,
    default_unexpected_grantee_rejected: true,
    grant_option_rejected: true,
    column_acl_rejected: true,
    sequence_select_rejected: true,
    drizzle_unexpected_grantee_rejected: true,
    drizzle_column_acl_rejected: true,
    unknown_object_rejected: true,
    unknown_function_rejected: true,
    unknown_enum_rejected: true,
    function_default_drift_rejected: true,
    intentional_migration_hash_failure_rejected: true,
    postflight_queries_read_only: true,
    output_redaction: true,
    local_separate_role_connection: true,
    real_transaction_pooler_behavior: "not_tested",
    external_database_connections: 0,
    parent_database_environment_inherited: false,
  };
} catch {
  results = {
    success: false,
    verificationStep,
    lastCheckId:
      typeof lastCheckId === "string" && /^[A-Z0-9_]+$/.test(lastCheckId)
        ? lastCheckId
        : null,
    errorCode: "POSTFLIGHT_LOCAL_VERIFICATION_FAILED",
  };
  process.exitCode = 1;
} finally {
  let stopped = true;
  try {
    if (postgresStarted) await postgres.stop();
  } catch {
    stopped = false;
  }
  let exited = postmasterPid ? await waitForExit(postmasterPid) : true;
  if (!exited && postmasterPid) {
    spawnSync("taskkill.exe", ["/PID", String(postmasterPid), "/T", "/F"], {
      encoding: "utf8",
      shell: false,
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
    exited = await waitForExit(postmasterPid);
  }
  Socket.prototype.connect = originalSocketConnect;
  let removed = false;
  try {
    if (exited && isSafeHarnessTemporaryPath(disposableRoot, tmpdir())) {
      await rm(disposableRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
      removed = true;
    }
  } catch {
    removed = false;
  }
  const cleanup = exited && removed;
  results = {
    ...results,
    postgres_stop_api_succeeded: stopped,
    disposable_cleanup_complete: cleanup,
    postgres_process_residual: !exited,
    disposable_data_residual: !removed,
  };
  if (!cleanup) process.exitCode = 1;
}

console.log(JSON.stringify(results));
