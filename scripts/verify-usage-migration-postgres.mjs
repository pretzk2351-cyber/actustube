import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repositoryRoot = process.cwd();
const embeddedEntry = process.env.ACTUSTUBE_EMBEDDED_POSTGRES_ENTRY;

if (
  process.env.ACTUSTUBE_DISPOSABLE_POSTGRES !== "1" ||
  !embeddedEntry ||
  !isAbsolute(embeddedEntry)
) {
  console.error({
    success: false,
    errorCode: "DISPOSABLE_POSTGRES_NOT_CONFIGURED",
  });
  process.exit(1);
}

const migrationFiles = Array.from(
  { length: 7 },
  (_, index) =>
    [
      "0000_crazy_spyke.sql",
      "0001_fix_google_oauth_account_variable_conflict.sql",
      "0002_add_atomic_usage_reservation.sql",
      "0003_add_usage_reservation_release.sql",
      "0004_add_stale_reservation_recovery.sql",
      "0005_silky_mystique.sql",
      "0006_usage_status_plan_snapshot.sql",
    ][index]
).map((file) => join(repositoryRoot, "drizzle", file));

const role = {
  legacyOwner: "fixture_legacy_owner",
  migrationExecutor: "fixture_migration_executor",
  explicitRuntime: "fixture_runtime_explicit",
  runtimeGroup: "fixture_runtime_group",
  membershipRuntime: "fixture_runtime_member",
  deniedRuntime: "fixture_runtime_denied",
  publicProbe: "fixture_public_probe",
};

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Unsafe fixture identifier.");
  }
  return `"${value}"`;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.unref();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("No disposable PostgreSQL port was available."));
        return;
      }
      const { port } = address;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const databaseDirectory = await mkdtemp(join(tmpdir(), "actustube-pg-"));
const adminPassword = randomUUID();
const port = await findFreePort();
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(embeddedEntry).href
);
const postgres = new EmbeddedPostgres({
  databaseDir: databaseDirectory,
  user: "fixture_admin",
  password: adminPassword,
  port,
  persistent: false,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  onLog: () => undefined,
  onError: () => undefined,
});

async function withClient(database, operation) {
  const client = postgres.getPgClient(database, "127.0.0.1");
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function execute(database, text, values = []) {
  return withClient(database, (client) => client.query(text, values));
}

async function scalar(database, text, values = []) {
  const result = await execute(database, text, values);
  const row = result.rows[0];
  return row ? Object.values(row)[0] : undefined;
}

async function applyFiles(database, files, executionRole) {
  const sqlFiles = await Promise.all(
    files.map((file) => readFile(file, "utf8"))
  );

  await withClient(database, async (client) => {
    await client.query("BEGIN");
    try {
      if (executionRole) {
        await client.query(`SET ROLE ${quoteIdentifier(executionRole)}`);
      }
      for (const sqlText of sqlFiles) {
        await client.query(sqlText);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function expectFailure(operation, expectedCode) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "Expected PostgreSQL operation to fail.");
  if (expectedCode) assert.equal(failure.code, expectedCode);
}

async function createRoles() {
  const statements = [
    `CREATE ROLE ${quoteIdentifier(role.legacyOwner)} NOLOGIN`,
    `CREATE ROLE ${quoteIdentifier(role.migrationExecutor)} NOLOGIN`,
    `CREATE ROLE ${quoteIdentifier(role.explicitRuntime)} NOLOGIN`,
    `CREATE ROLE ${quoteIdentifier(role.runtimeGroup)} NOLOGIN`,
    `CREATE ROLE ${quoteIdentifier(role.membershipRuntime)} NOLOGIN`,
    `CREATE ROLE ${quoteIdentifier(role.deniedRuntime)} NOLOGIN`,
    `CREATE ROLE ${quoteIdentifier(role.publicProbe)} NOLOGIN`,
    `GRANT ${quoteIdentifier(role.legacyOwner)} TO ${quoteIdentifier(role.migrationExecutor)}`,
    `GRANT ${quoteIdentifier(role.runtimeGroup)} TO ${quoteIdentifier(role.membershipRuntime)}`,
  ];
  await execute("postgres", statements.join(";\n"));
}

async function configureRoleFixture(database, { publicOnly = false } = {}) {
  const runtimeRoles = [
    role.explicitRuntime,
    role.runtimeGroup,
    role.deniedRuntime,
    role.publicProbe,
  ]
    .map(quoteIdentifier)
    .join(", ");

  await execute(
    database,
    `
      GRANT USAGE ON SCHEMA public TO ${runtimeRoles};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRoles};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRoles};
      GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(role.legacyOwner)};
      GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(role.migrationExecutor)};
      GRANT USAGE ON TYPE public.usage_metric, public.user_status
        TO ${quoteIdentifier(role.migrationExecutor)};
      ALTER FUNCTION public.reserve_usage_limits(
        uuid,
        integer,
        public.usage_metric,
        timestamp with time zone
      ) OWNER TO ${quoteIdentifier(role.legacyOwner)};
      REVOKE ALL PRIVILEGES ON FUNCTION public.reserve_usage_limits(
        uuid,
        integer,
        public.usage_metric,
        timestamp with time zone
      ) FROM PUBLIC;
      ${
        publicOnly
          ? `GRANT EXECUTE ON FUNCTION public.reserve_usage_limits(
              uuid, integer, public.usage_metric, timestamp with time zone
            ) TO PUBLIC;`
          : `GRANT EXECUTE ON FUNCTION public.reserve_usage_limits(
              uuid, integer, public.usage_metric, timestamp with time zone
            ) TO ${quoteIdentifier(role.explicitRuntime)} WITH GRANT OPTION;
            GRANT EXECUTE ON FUNCTION public.reserve_usage_limits(
              uuid, integer, public.usage_metric, timestamp with time zone
            ) TO ${quoteIdentifier(role.runtimeGroup)};`
      }
    `
  );
}

async function queryAsRole(
  database,
  executionRole,
  text,
  values = [],
  { commit = false } = {}
) {
  return withClient(database, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${quoteIdentifier(executionRole)}`);
      const result = await client.query(text, values);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function catalogBoolean(database, text) {
  const value = await scalar(database, text);
  assert.equal(value, true);
  return true;
}

const legacySignature =
  "public.reserve_usage_limits(uuid,integer,public.usage_metric,timestamp with time zone)";
const targetSignatures = [
  "public.usage_period_boundaries_v1(timestamp with time zone)",
  "public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)",
  "public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.get_usage_status_v1(uuid,integer,timestamp with time zone)",
];

function signatureArraySql() {
  return targetSignatures
    .map((signature) => `'${signature.replaceAll("'", "''")}'`)
    .join(", ");
}

async function verifyAclFixture(database, legacyAclHash) {
  const targets = signatureArraySql();
  const ownerMatches = await catalogBoolean(
    database,
    `
      WITH legacy AS (
        SELECT proowner FROM pg_catalog.pg_proc
        WHERE oid = to_regprocedure('${legacySignature}')
      )
      SELECT COUNT(*) = ${targetSignatures.length}
        AND bool_and(p.proowner = legacy.proowner)
      FROM unnest(ARRAY[${targets}]::text[]) AS signature
      CROSS JOIN legacy
      INNER JOIN pg_catalog.pg_proc AS p
        ON p.oid = to_regprocedure(signature)
    `
  );

  const legacyAclPreserved =
    (await scalar(
      database,
      `SELECT md5(proacl::text) = $1
       FROM pg_catalog.pg_proc
       WHERE oid = to_regprocedure('${legacySignature}')`,
      [legacyAclHash]
    )) === true;
  assert.equal(legacyAclPreserved, true);

  const aclEqual = await catalogBoolean(
    database,
    `
      SELECT bool_and(
        NOT EXISTS (
          SELECT acl.grantee, acl.privilege_type, acl.is_grantable
          FROM pg_catalog.pg_proc AS target_proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(target_proc.proacl, acldefault('f', target_proc.proowner))
          ) AS acl
          WHERE target_proc.oid = to_regprocedure(signature)
            AND acl.grantee <> target_proc.proowner
          EXCEPT
          SELECT acl.grantee, acl.privilege_type, acl.is_grantable
          FROM pg_catalog.pg_proc AS legacy_proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(legacy_proc.proacl, acldefault('f', legacy_proc.proowner))
          ) AS acl
          WHERE legacy_proc.oid = to_regprocedure('${legacySignature}')
            AND acl.grantee <> legacy_proc.proowner
        )
        AND NOT EXISTS (
          SELECT acl.grantee, acl.privilege_type, acl.is_grantable
          FROM pg_catalog.pg_proc AS legacy_proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(legacy_proc.proacl, acldefault('f', legacy_proc.proowner))
          ) AS acl
          WHERE legacy_proc.oid = to_regprocedure('${legacySignature}')
            AND acl.grantee <> legacy_proc.proowner
          EXCEPT
          SELECT acl.grantee, acl.privilege_type, acl.is_grantable
          FROM pg_catalog.pg_proc AS target_proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(target_proc.proacl, acldefault('f', target_proc.proowner))
          ) AS acl
          WHERE target_proc.oid = to_regprocedure(signature)
            AND acl.grantee <> target_proc.proowner
        )
      )
      FROM unnest(ARRAY[${targets}]::text[]) AS signature
    `
  );

  const explicitCanExecute = await catalogBoolean(
    database,
    `SELECT bool_and(has_function_privilege(
       '${role.explicitRuntime}',
       to_regprocedure(signature),
       'EXECUTE'
     ))
     FROM unnest(ARRAY[${targets}]::text[]) AS signature`
  );
  const membershipCanExecute = await catalogBoolean(
    database,
    `SELECT bool_and(has_function_privilege(
       '${role.membershipRuntime}',
       to_regprocedure(signature),
       'EXECUTE'
     ))
     FROM unnest(ARRAY[${targets}]::text[]) AS signature`
  );
  const deniedCannotExecute = await catalogBoolean(
    database,
    `SELECT bool_and(NOT has_function_privilege(
       '${role.deniedRuntime}',
       to_regprocedure(signature),
       'EXECUTE'
     ))
     FROM unnest(ARRAY[${targets}]::text[]) AS signature`
  );
  const publicCannotExecute = await catalogBoolean(
    database,
    `SELECT bool_and(
       NOT has_function_privilege(
         '${role.publicProbe}',
         to_regprocedure(signature),
         'EXECUTE'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))
         ) AS acl
         WHERE p.oid = to_regprocedure(signature)
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
       )
     )
     FROM unnest(ARRAY[${targets}]::text[]) AS signature`
  );
  const securityMatches = await catalogBoolean(
    database,
    `WITH legacy AS (
       SELECT prosecdef FROM pg_catalog.pg_proc
       WHERE oid = to_regprocedure('${legacySignature}')
     )
     SELECT bool_and(p.prosecdef = legacy.prosecdef)
     FROM unnest(ARRAY[${targets}]::text[]) AS signature
     CROSS JOIN legacy
     INNER JOIN pg_catalog.pg_proc AS p
       ON p.oid = to_regprocedure(signature)`
  );
  const searchPathFixed = await catalogBoolean(
    database,
    `SELECT bool_and(
       p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     )
     FROM unnest(ARRAY[${targets}, '${legacySignature}']::text[]) AS signature
     INNER JOIN pg_catalog.pg_proc AS p
       ON p.oid = to_regprocedure(signature)`
  );

  const nonExistingUser = "10000000-0000-4000-8000-000000000001";
  for (const executionRole of [role.explicitRuntime, role.membershipRuntime]) {
    const result = await queryAsRole(
      database,
      executionRole,
      `SELECT allowed
       FROM public.reserve_usage_limits_v2(
         $1::uuid,
         1,
         'channel_analysis'::public.usage_metric,
         statement_timestamp()
       )`,
      [nonExistingUser]
    );
    assert.equal(result.rows[0]?.allowed, false);
  }
  await expectFailure(
    () =>
      queryAsRole(
        database,
        role.deniedRuntime,
        `SELECT * FROM public.reserve_usage_limits_v2(
          $1::uuid, 1, 'channel_analysis'::public.usage_metric,
          statement_timestamp()
        )`,
        [nonExistingUser]
      ),
    "42501"
  );
  await expectFailure(
    () =>
      queryAsRole(
        database,
        role.publicProbe,
        `SELECT * FROM public.reserve_usage_limits_v2(
          $1::uuid, 1, 'channel_analysis'::public.usage_metric,
          statement_timestamp()
        )`,
        [nonExistingUser]
      ),
    "42501"
  );

  return {
    migration_created_owner_matches_legacy_owner: ownerMatches,
    legacy_acl_was_preserved: legacyAclPreserved,
    new_acl_is_not_broader_than_legacy_acl: aclEqual,
    allowed_runtime_relation_can_execute: explicitCanExecute,
    membership_runtime_relation_can_execute: membershipCanExecute,
    denied_runtime_relation_cannot_execute: deniedCannotExecute,
    public_cannot_execute: publicCannotExecute,
    security_mode_matches: securityMatches,
    search_path_is_fixed: searchPathFixed,
  };
}

function userStateQuery() {
  return `
    SELECT json_build_object(
      'assignments', (SELECT COUNT(*) FROM public.user_plan_assignments WHERE user_id = $1),
      'buckets', (SELECT COUNT(*) FROM public.user_usage_buckets WHERE user_id = $1),
      'leases', (
        SELECT COUNT(*) FROM public.usage_reservation_leases WHERE user_id = $1
      ),
      'analysis', (SELECT COUNT(*) FROM public.analysis_runs WHERE user_id = $1),
      'ai', (
        SELECT COUNT(*) FROM public.analysis_runs
        WHERE user_id = $1 AND ai_consult_snapshot IS NOT NULL
      ),
      'improvements', (
        SELECT COUNT(*) FROM public.improvement_actions WHERE user_id = $1
      )
    ) AS state
  `;
}

async function expectPlanFailureInTransaction(client, userId) {
  const before = (await client.query(userStateQuery(), [userId])).rows[0].state;

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
    let failure;
    try {
      await client.query(invocation, [userId]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "P0001");
    await client.query("ROLLBACK TO SAVEPOINT expected_plan_failure");
    await client.query("RELEASE SAVEPOINT expected_plan_failure");
  }

  const after = (await client.query(userStateQuery(), [userId])).rows[0].state;
  assert.deepEqual(after, before);
}

async function withRollback(database, operation) {
  return withClient(database, async (client) => {
    await client.query("BEGIN");
    try {
      await operation(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

async function insertUser(client, userId) {
  await client.query(
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1)`,
    [userId]
  );
}

async function verifyPlanResolution(database) {
  await withRollback(database, async (client) => {
    const userId = "20000000-0000-4000-8000-000000000001";
    await insertUser(client, userId);
    const status = await client.query(
      `SELECT available, canonical_plan_key, plan_from_assignment,
              analysis_daily_remaining, ai_monthly_remaining
       FROM public.get_usage_status_v1(
         $1::uuid, 1, '2026-09-01T12:00:00Z'::timestamptz
       )`,
      [userId]
    );
    assert.deepEqual(status.rows[0], {
      available: true,
      canonical_plan_key: "free",
      plan_from_assignment: false,
      analysis_daily_remaining: 2,
      ai_monthly_remaining: 3,
    });
    const reservation = await client.query(
      `SELECT allowed, canonical_plan_key, plan_from_assignment, reservation_id
       FROM public.reserve_usage_limits_v2(
         $1::uuid, 1, 'channel_analysis'::public.usage_metric,
         '2026-09-01T12:00:00Z'::timestamptz
       )`,
      [userId]
    );
    assert.equal(reservation.rows[0].allowed, true);
    assert.equal(reservation.rows[0].canonical_plan_key, "free");
    assert.equal(reservation.rows[0].plan_from_assignment, false);
  });

  await withRollback(database, async (client) => {
    const userId = "20000000-0000-4000-8000-000000000002";
    await insertUser(client, userId);
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
    assert.deepEqual(status.rows[0], {
      available: true,
      canonical_plan_key: "free",
      plan_from_assignment: false,
    });
  });

  const failureScenarios = [
    async (client, userId) => {
      await client.query(
        `INSERT INTO public.user_plan_assignments (
          user_id, plan_code, status, source, starts_at
        ) VALUES ($1, 'free', 'active', 'system', '2026-09-02T00:00:00Z')`,
        [userId]
      );
    },
    async (client, userId) => {
      await client.query(
        `INSERT INTO public.user_plan_assignments (
          user_id, plan_code, status, source, starts_at, ends_at
        ) VALUES (
          $1, 'free', 'active', 'system',
          '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z'
        )`,
        [userId]
      );
    },
    async (client, userId) => {
      await client.query(
        `ALTER TABLE public.user_plan_assignments
         DROP CONSTRAINT user_plan_assignments_plan_code_plans_code_fk`
      );
      await client.query(
        `INSERT INTO public.user_plan_assignments (
           user_id, plan_code, status, source, starts_at
         ) VALUES ($1, 'missing', 'active', 'system', '2026-01-01T00:00:00Z')`,
        [userId]
      );
    },
    async (client, userId) => {
      await client.query(
        "DROP INDEX public.user_plan_assignments_one_active_per_user"
      );
      await client.query(
        `INSERT INTO public.user_plan_assignments (
           user_id, plan_code, status, source, starts_at
         ) VALUES
           ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z'),
           ($1, 'free', 'active', 'manual', '2026-01-02T00:00:00Z')`,
        [userId]
      );
    },
    async (client) => {
      await client.query("DELETE FROM public.plans WHERE code = 'free'");
    },
    async (client) => {
      await client.query(
        `ALTER TABLE public.plans DROP CONSTRAINT plans_pkey CASCADE;
         INSERT INTO public.plans (
           code, name, analysis_daily_limit, analysis_monthly_limit,
           ai_daily_limit, ai_monthly_limit, regular_video_limit,
           shorts_video_limit, history_retention_days, active
         ) VALUES ('free', 'Duplicate', 2, 5, 1, 3, 10, 10, 90, true)`
      );
    },
    async (client) => {
      await client.query("UPDATE public.plans SET active = false WHERE code = 'free'");
    },
    async (client) => {
      await client.query(
        "UPDATE public.plans SET analysis_daily_limit = 3 WHERE code = 'free'"
      );
    },
    async (client) => {
      await client.query(
        `ALTER TABLE public.plans DROP CONSTRAINT plans_limits_nonnegative;
         UPDATE public.plans SET ai_monthly_limit = -1 WHERE code = 'free'`
      );
    },
  ];

  for (const [index, setup] of failureScenarios.entries()) {
    await withRollback(database, async (client) => {
      const userId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      await insertUser(client, userId);
      await setup(client, userId);
      await expectPlanFailureInTransaction(client, userId);
    });
  }

  return {
    assignment_absent_free_fallback: true,
    inactive_and_expired_free_fallback: true,
    active_future_fails_closed: true,
    active_expired_fails_closed: true,
    invalid_active_plan_fails_closed: true,
    multiple_active_fails_closed: true,
    canonical_free_invalid_states_fail_closed: true,
    fail_closed_state_is_unchanged: true,
  };
}

async function verifyReservationLifecycle(database) {
  const concurrentUser = "40000000-0000-4000-8000-000000000001";
  await execute(
    database,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1)`,
    [concurrentUser]
  );
  await execute(
    database,
    `INSERT INTO public.user_plan_assignments (
       user_id, plan_code, status, source, starts_at
     ) VALUES ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z')`,
    [concurrentUser]
  );
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, () =>
      queryAsRole(
        database,
        role.explicitRuntime,
        `SELECT allowed
         FROM public.reserve_usage_limits_v2(
           $1::uuid, 1, 'channel_analysis'::public.usage_metric,
           '2026-09-01T12:00:00Z'::timestamptz
        )`,
        [concurrentUser],
        { commit: true }
      )
    )
  );
  assert.equal(
    concurrent.filter((result) => result.rows[0]?.allowed === true).length,
    2
  );
  assert.equal(
    Number(
      await scalar(
        database,
        `SELECT MAX(used_count)
         FROM public.user_usage_buckets
         WHERE user_id = $1 AND metric = 'channel_analysis'`,
        [concurrentUser]
      )
    ),
    2
  );
  await execute(
    database,
    "DELETE FROM public.users WHERE id = $1::uuid",
    [concurrentUser]
  );

  const releaseUser = "40000000-0000-4000-8000-000000000002";
  await execute(
    database,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1)`,
    [releaseUser]
  );
  await execute(
    database,
    `INSERT INTO public.user_plan_assignments (
       user_id, plan_code, status, source, starts_at
     ) VALUES ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z')`,
    [releaseUser]
  );
  const releasedReservation = await execute(
    database,
    `SELECT reservation_id FROM public.reserve_usage_limits_v2(
       $1::uuid, 1, 'channel_analysis'::public.usage_metric,
       '2026-09-01T12:00:00Z'::timestamptz
     )`,
    [releaseUser]
  );
  const reservationId = releasedReservation.rows[0].reservation_id;
  assert.equal(
    await scalar(
      database,
      `SELECT released FROM public.release_usage_limits($1::uuid, $2::uuid)`,
      [reservationId, releaseUser]
    ),
    true
  );
  assert.equal(
    await scalar(
      database,
      `SELECT released FROM public.release_usage_limits($1::uuid, $2::uuid)`,
      [reservationId, releaseUser]
    ),
    false
  );

  const finalizedReservation = await execute(
    database,
    `SELECT reservation_id FROM public.reserve_usage_limits_v2(
       $1::uuid, 1, 'ai_consult'::public.usage_metric,
       '2026-09-01T12:00:00Z'::timestamptz
     )`,
    [releaseUser]
  );
  assert.equal(
    await scalar(
      database,
      `SELECT public.finalize_usage_reservation($1::uuid, $2::uuid)`,
      [finalizedReservation.rows[0].reservation_id, releaseUser]
    ),
    true
  );

  const staleUser = "40000000-0000-4000-8000-000000000003";
  await execute(
    database,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1)`,
    [staleUser]
  );
  await execute(
    database,
    `INSERT INTO public.user_plan_assignments (
       user_id, plan_code, status, source, starts_at
     ) VALUES ($1, 'free', 'active', 'system', '2026-01-01T00:00:00Z')`,
    [staleUser]
  );
  await execute(
    database,
    `SELECT reservation_id FROM public.reserve_usage_limits_v2(
       $1::uuid, 1, 'channel_analysis'::public.usage_metric,
       '2026-09-01T12:00:00Z'::timestamptz
     )`,
    [staleUser]
  );
  const recoveries = await Promise.all(
    Array.from({ length: 2 }, () =>
      execute(
        database,
        `SELECT public.recover_stale_usage_reservations(
          '2026-09-01T12:15:00Z'::timestamptz,
          10
        ) AS recovered`
      )
    )
  );
  assert.equal(
    recoveries.reduce(
      (total, result) => total + Number(result.rows[0].recovered),
      0
    ),
    1
  );

  await execute(
    database,
    "DELETE FROM public.users WHERE id = ANY($1::uuid[])",
    [[releaseUser, staleUser]]
  );

  return {
    concurrent_reservation_respects_limits: true,
    one_time_release_preserved: true,
    finalization_preserved: true,
    stale_recovery_preserved: true,
  };
}

async function verifyOldMigrationCompatibility(database) {
  const userId = "50000000-0000-4000-8000-000000000001";
  await execute(
    database,
    `INSERT INTO public.users (id, status, session_version)
     VALUES ($1, 'active', 1)`,
    [userId]
  );
  const before = await scalar(database, userStateQuery(), [userId]);
  assert.equal(
    await catalogBoolean(
      database,
      `SELECT to_regprocedure(
         'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)'
       ) IS NULL
       AND to_regprocedure(
         'public.get_usage_status_v1(uuid,integer,timestamp with time zone)'
       ) IS NULL`
    ),
    true
  );
  await expectFailure(
    () =>
      execute(
        database,
        `SELECT * FROM public.reserve_usage_limits_v2(
          $1::uuid, 1, 'channel_analysis'::public.usage_metric,
          statement_timestamp()
        )`,
        [userId]
      ),
    "42883"
  );
  const after = await scalar(database, userStateQuery(), [userId]);
  assert.deepEqual(after, before);
  return {
    versioned_functions_absent_on_0005: true,
    old_migration_state_unchanged: true,
  };
}

let results;
let verificationStep = "initialize";
try {
  await postgres.initialise();
  await postgres.start();
  verificationStep = "create-roles";
  await createRoles();

  for (const database of [
    "fixture_fresh",
    "fixture_upgrade",
    "fixture_public",
    "fixture_old",
  ]) {
    await postgres.createDatabase(database);
  }

  verificationStep = "fresh-migration";
  await applyFiles("fixture_fresh", migrationFiles);
  assert.equal(
    await catalogBoolean(
      "fixture_fresh",
      `SELECT COUNT(*) = ${targetSignatures.length}
       FROM unnest(ARRAY[${signatureArraySql()}]::text[]) AS signature
       WHERE to_regprocedure(signature) IS NOT NULL`
    ),
    true
  );

  verificationStep = "upgrade-baseline";
  await applyFiles("fixture_upgrade", migrationFiles.slice(0, 6));
  await configureRoleFixture("fixture_upgrade");
  const legacyAclHash = await scalar(
    "fixture_upgrade",
    `SELECT md5(proacl::text)
     FROM pg_catalog.pg_proc
     WHERE oid = to_regprocedure('${legacySignature}')`
  );
  verificationStep = "upgrade-migration";
  await applyFiles(
    "fixture_upgrade",
    [migrationFiles[6]],
    role.migrationExecutor
  );

  verificationStep = "acl-verification";
  const acl = await verifyAclFixture("fixture_upgrade", legacyAclHash);
  verificationStep = "plan-resolution";
  const plans = await verifyPlanResolution("fixture_upgrade");
  verificationStep = "reservation-lifecycle";
  const lifecycle = await verifyReservationLifecycle("fixture_upgrade");

  verificationStep = "public-baseline";
  await applyFiles("fixture_public", migrationFiles.slice(0, 6));
  await configureRoleFixture("fixture_public", { publicOnly: true });
  verificationStep = "public-fail-closed";
  await expectFailure(
    () =>
      applyFiles(
        "fixture_public",
        [migrationFiles[6]],
        role.migrationExecutor
      ),
    "P0001"
  );
  assert.equal(
    await catalogBoolean(
      "fixture_public",
      `SELECT to_regprocedure(
         'public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)'
       ) IS NULL
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))
         ) AS acl
         WHERE p.oid = to_regprocedure('${legacySignature}')
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
       )`
    ),
    true
  );

  verificationStep = "old-migration";
  await applyFiles("fixture_old", migrationFiles.slice(0, 6));
  const oldMigration = await verifyOldMigrationCompatibility("fixture_old");

  results = {
    success: true,
    migration_fresh: true,
    migration_0005_to_0006: true,
    public_dependency_fails_closed: true,
    ...acl,
    ...plans,
    ...lifecycle,
    ...oldMigration,
  };
} catch (error) {
  results = {
    success: false,
    errorName: error instanceof Error ? error.name : "UnknownError",
    verificationStep,
    diagnosticMessage:
      error instanceof Error
        ? error.message
            .replaceAll(/fixture_[a-z0-9_]+/g, "[fixture-role]")
            .slice(0, 240)
        : null,
    errorCode:
      error && typeof error === "object" && "code" in error
        ? String(error.code).slice(0, 16)
        : null,
  };
  process.exitCode = 1;
} finally {
  try {
    await postgres.stop();
  } catch {
    process.exitCode = 1;
  }
  try {
    await rm(databaseDirectory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  } catch {
    process.exitCode = 1;
    results = {
      ...results,
      disposable_cleanup_complete: false,
    };
  }
}

console.log(results);
