/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  closeReadOnlyConnection,
  loadRepositorySpecification,
  validateColumns,
  validateConstraints,
  validateDirectPrivileges,
  validateEnums,
  validateFunctions,
  validateIndexes,
  validateMigrationHistory,
  validateRuntimePrivileges,
  validateTablesAndSecurity,
  verifyStagingDatabasePostflight,
} from "../scripts/staging-database-postflight/core.mjs";
import {
  EXPECTED_FUNCTIONS,
  RUNTIME_TABLE_PRIVILEGES,
} from "../scripts/staging-database-postflight/manifest.mjs";
import {
  PostflightIssue,
  assertReadOnlySql,
  redactDiagnostic,
  validateSafetyGate,
} from "../scripts/staging-database-postflight/safety.mjs";
import {
  PARENT_ENVIRONMENT_NOTICE,
  createFatalExitLatch,
  executeStagingDatabasePostflight,
} from "../scripts/verify-staging-database-postflight.mjs";

const repositoryRoot = process.cwd();
const directUrl =
  "postgresql://staging_direct:dummy-password@ep-actustube-safe.example.test/staging_database?sslmode=require";
const pooledUrl =
  "postgresql://staging_runtime:dummy-password@ep-actustube-safe-pooler.example.test/staging_database?sslmode=require";

function validEnvironment(): any {
  return {
    ACTUSTUBE_DB_ENV: "staging",
    ACTUSTUBE_ALLOW_STAGING_DB_VERIFY: "1",
    DIRECT_DATABASE_URL: directUrl,
    DATABASE_URL: pooledUrl,
    ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-actustube-safe",
  };
}

function issueCode(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PostflightIssue);
    return (error as PostflightIssue).code;
  }
  throw new Error("Expected a PostflightIssue.");
}

function expectedColumnRows(snapshot: Record<string, any>) {
  const rows: Record<string, unknown>[] = [];
  for (const table of Object.values(snapshot.tables) as any[]) {
    for (const column of Object.values(table.columns) as any[]) {
      rows.push({
        table_name: table.name,
        column_name: column.name,
        data_type: column.type.replace(/^varchar/, "character varying"),
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

function expectedConstraintRows(snapshot: Record<string, any>) {
  const actionCode: Record<string, string> = {
    "no action": "a",
    restrict: "r",
    cascade: "c",
    "set null": "n",
    "set default": "d",
  };
  const rows: Record<string, unknown>[] = [];
  for (const table of Object.values(snapshot.tables) as any[]) {
    const primary = (Object.values(table.columns) as any[])
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    if (primary.length) {
      rows.push({
        table_name: table.name,
        constraint_name: `${table.name}_pkey`,
        constraint_type: "p",
        referenced_table: null,
        columns: primary,
        referenced_columns: [],
        expression: null,
        update_action: " ",
        delete_action: " ",
        is_deferrable: false,
        initially_deferred: false,
        is_validated: true,
      });
    }
    for (const constraint of Object.values(table.foreignKeys) as any[]) {
      rows.push({
        table_name: table.name,
        constraint_name: constraint.name,
        constraint_type: "f",
        referenced_table: constraint.tableTo,
        columns: constraint.columnsFrom,
        referenced_columns: constraint.columnsTo,
        expression: null,
        update_action: actionCode[constraint.onUpdate],
        delete_action: actionCode[constraint.onDelete],
        is_deferrable: false,
        initially_deferred: false,
        is_validated: true,
      });
    }
    for (const constraint of Object.values(table.checkConstraints) as any[]) {
      rows.push({
        table_name: table.name,
        constraint_name: constraint.name,
        constraint_type: "c",
        referenced_table: null,
        columns: [],
        referenced_columns: [],
        expression: constraint.value,
        update_action: " ",
        delete_action: " ",
        is_deferrable: false,
        initially_deferred: false,
        is_validated: true,
      });
    }
  }
  return rows.sort((left, right) =>
    `${left.table_name}:${left.constraint_name}`.localeCompare(
      `${right.table_name}:${right.constraint_name}`
    )
  );
}

function expectedIndexRows(snapshot: Record<string, any>) {
  const rows: Record<string, unknown>[] = [];
  for (const table of Object.values(snapshot.tables) as any[]) {
    for (const index of Object.values(table.indexes) as any[]) {
      rows.push({
        table_name: table.name,
        index_name: index.name,
        is_unique: index.isUnique,
        is_valid: true,
        is_ready: true,
        is_live: true,
        method: index.method,
        has_expressions: false,
        columns: index.columns.map((column: any) => column.expression),
        ascending: index.columns.map((column: any) => column.asc),
        nulls_order: index.columns.map((column: any) => column.nulls),
        predicate: index.where ?? null,
      });
    }
  }
  return rows.sort((left, right) =>
    `${left.table_name}:${left.index_name}`.localeCompare(
      `${right.table_name}:${right.index_name}`
    )
  );
}

describe("staging postflight safety gate", () => {
  it("accepts only the exact staging confirmation and matching opaque identity", () => {
    expect(validateSafetyGate(validEnvironment()).directUrl).toBe(directUrl);
  });

  it.each([
    ["missing environment", { ACTUSTUBE_DB_ENV: undefined }],
    ["empty environment", { ACTUSTUBE_DB_ENV: "" }],
    ["production", { ACTUSTUBE_DB_ENV: "production" }],
    ["prod", { ACTUSTUBE_DB_ENV: "prod" }],
    ["rehearsal", { ACTUSTUBE_DB_ENV: "rehearsal" }],
    ["backup", { ACTUSTUBE_DB_ENV: "backup" }],
    ["ambiguous case", { ACTUSTUBE_DB_ENV: "Staging" }],
    ["ambiguous whitespace", { ACTUSTUBE_DB_ENV: "staging " }],
    ["missing confirmation", { ACTUSTUBE_ALLOW_STAGING_DB_VERIFY: undefined }],
    ["bad confirmation", { ACTUSTUBE_ALLOW_STAGING_DB_VERIFY: "true" }],
    ["missing direct", { DIRECT_DATABASE_URL: undefined }],
    ["missing pooled", { DATABASE_URL: undefined }],
    ["malformed direct", { DIRECT_DATABASE_URL: "not-a-url" }],
    [
      "malformed percent encoding",
      {
        DIRECT_DATABASE_URL:
          "postgresql://safe:dummy@ep-safe.example.test/staging%ZZ",
      },
    ],
    ["non PostgreSQL", { DIRECT_DATABASE_URL: "https://example.test/db" }],
  ])("rejects %s before a connection", async (_label, overrides) => {
    const connect = vi.fn();
    const report = await verifyStagingDatabasePostflight({
      environment: { ...validEnvironment(), ...overrides },
      repositoryRoot,
      adapter: { connect },
    });
    expect(report.exitCode).toBe(2);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["production", "rehearsal", "backup", "default", "main", "postgres"])(
    "rejects an explicit forbidden target: %s",
    (target) => {
      const environment = validEnvironment();
      environment.DIRECT_DATABASE_URL = `postgresql://safe:dummy@ep-safe.example.test/${target}`;
      expect(() => validateSafetyGate(environment)).toThrow(PostflightIssue);
    }
  );

  it("rejects direct and pooled target mismatch", () => {
    const environment = validEnvironment();
    environment.DATABASE_URL = pooledUrl.replace("staging_database", "other_database");
    expect(issueCode(() => validateSafetyGate(environment))).toBe(
      "DIRECT_POOLED_TARGET_MISMATCH"
    );
  });

  it("rejects production roles and targets without an explicit staging marker", () => {
    const productionRoles = validEnvironment();
    productionRoles.DIRECT_DATABASE_URL = directUrl.replace(
      "staging_direct",
      "production_owner"
    );
    productionRoles.DATABASE_URL = pooledUrl.replace(
      "staging_runtime",
      "production_runtime"
    );
    expect(issueCode(() => validateSafetyGate(productionRoles))).toBe(
      "DIRECT_FORBIDDEN_TARGET"
    );

    const unclassified = validEnvironment();
    unclassified.DIRECT_DATABASE_URL =
      "postgresql://migration:dummy-password@ep-actustube-safe.example.test/app?sslmode=require";
    unclassified.DATABASE_URL =
      "postgresql://runtime:dummy-password@ep-actustube-safe-pooler.example.test/app?sslmode=require";
    expect(issueCode(() => validateSafetyGate(unclassified))).toBe(
      "DIRECT_STAGING_MARKER_REQUIRED"
    );
  });

  it("requires the separately confirmed provider endpoint identity", () => {
    const environment = validEnvironment();
    environment.ACTUSTUBE_EXPECTED_STAGING_IDENTITY = "ep-other-staging";
    expect(issueCode(() => validateSafetyGate(environment))).toBe(
      "EXPECTED_STAGING_IDENTITY_MISMATCH"
    );
  });

  it("returns NOT VERIFIED without the independently supplied identity", async () => {
    const connect = vi.fn();
    const environment = validEnvironment();
    delete (environment as Partial<typeof environment>)
      .ACTUSTUBE_EXPECTED_STAGING_IDENTITY;
    const report: any = await verifyStagingDatabasePostflight({
      environment,
      repositoryRoot,
      adapter: { connect },
    });
    expect(report.exitCode).toBe(3);
    expect(report.failure).toEqual({
      checkId: "EXPECTED_STAGING_IDENTITY_REQUIRED",
      status: "not_verified",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("classifies direct and pooled connection failures without raw driver details", async () => {
    const directFailure: any = await verifyStagingDatabasePostflight({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: {
        connect: vi.fn().mockRejectedValue(
          Object.assign(new Error(`${directUrl} raw driver detail`), {
            code: "28P01",
          })
        ),
      },
    });
    expect(directFailure.exitCode).toBe(3);
    expect(directFailure.directConnection).toBe("fail");
    expect(directFailure.failure.checkId).toBe("DIRECT_CONNECTION_UNAVAILABLE");

    const directConnection = {
      query: vi.fn((statement: string) =>
        Promise.resolve(
          statement.trim().toUpperCase().startsWith("SHOW")
            ? { rows: [{ transaction_read_only: "on" }] }
            : { rows: [] }
        )
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(directConnection)
      .mockRejectedValueOnce(new AggregateError([new Error(pooledUrl)]));
    const pooledFailure: any = await verifyStagingDatabasePostflight({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: { connect },
    });
    expect(pooledFailure.exitCode).toBe(3);
    expect(pooledFailure.directConnection).toBe("pass");
    expect(pooledFailure.pooledConnection).toBe("fail");
    expect(pooledFailure.failure.checkId).toBe("POOLED_CONNECTION_UNAVAILABLE");
    expect(directConnection.close).toHaveBeenCalledOnce();
  });

  it("bounds rejected and hung connection cleanup", async () => {
    const rejected = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      close: vi.fn().mockRejectedValue(new Error("raw cleanup detail")),
    };
    await expect(closeReadOnlyConnection(rejected)).rejects.toMatchObject({
      code: "CONNECTION_CLEANUP_UNVERIFIED",
      exitCode: 3,
    });

    vi.useFakeTimers();
    try {
      const hung = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        close: vi.fn(() => new Promise(() => undefined)),
      };
      const result = closeReadOnlyConnection(hung);
      const rejection = expect(result).rejects.toMatchObject({
        code: "CONNECTION_CLEANUP_TIMEOUT",
        exitCode: 3,
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("latches fatal exit code 3 against a later success report", () => {
    const assigned: number[] = [];
    const output: string[] = [];
    const fatal = createFatalExitLatch({
      stdout: (line: string) => output.push(line),
      setExitCode: (code: number) => assigned.push(code),
    });
    fatal.latch("UNCAUGHT_EXCEPTION");
    fatal.setReportExitCode(0);
    expect(assigned).toEqual([3, 3]);
    expect(output).toHaveLength(2);

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "import { createFatalExitLatch } from './scripts/verify-staging-database-postflight.mjs'; const fatal=createFatalExitLatch({stdout:()=>{}}); process.once('uncaughtException',()=>fatal.latch('UNCAUGHT_EXCEPTION')); setImmediate(()=>{throw new Error('fixture fatal')}); setTimeout(()=>fatal.setReportExitCode(0),20);",
      ],
      { cwd: repositoryRoot, encoding: "utf8", shell: false, timeout: 10_000 }
    );
    expect(child.status).toBe(3);
    expect(child.stderr).toBe("");
  });
});

describe("secret-safe output", () => {
  it("redacts URLs, encoded URLs, URL parts, nested causes, and AggregateError", () => {
    const rawUrl =
      "postgresql://dummy_user:dummy_password@dummy-host.example.test/dummy_database?sslmode=require";
    const nested = new AggregateError(
      [
        new Error(rawUrl),
        Object.assign(new Error("nested dummy_password"), {
          cause: new Error(encodeURIComponent(rawUrl)),
        }),
      ],
      `host=dummy-host.example.test database=dummy_database user=dummy_user`
    );
    const redacted = redactDiagnostic(nested, [
      rawUrl,
      "dummy_user",
      "dummy_password",
      "dummy-host.example.test",
      "dummy_database",
    ]);
    for (const secret of [
      rawUrl,
      encodeURIComponent(rawUrl),
      "dummy_user",
      "dummy_password",
      "dummy-host.example.test",
      "dummy_database",
      "sslmode=require",
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("emits only fixed classifications when safety validation fails", async () => {
    const output: string[] = [];
    const report = await executeStagingDatabasePostflight({
      environment: {
        ...validEnvironment(),
        ACTUSTUBE_DB_ENV: "production",
      },
      repositoryRoot,
      adapter: { connect: vi.fn() },
      stdout: (line) => output.push(line),
    });
    expect(report.exitCode).toBe(2);
    const serialized = output.join("\n");
    expect(serialized).toContain(PARENT_ENVIRONMENT_NOTICE);
    for (const secret of [
      directUrl,
      pooledUrl,
      "dummy-password",
      "staging_direct",
      "staging_runtime",
      "ep-actustube-safe",
      "staging_database",
      "sslmode=require",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("read-only SQL guard", () => {
  it.each([
    "SELECT 1",
    "WITH value AS (SELECT 1) SELECT * FROM value",
    "SHOW transaction_read_only",
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '15000ms'",
    "ROLLBACK",
    "SELECT has_table_privilege(current_user, 'public.users', 'UPDATE')",
  ])("accepts repository-controlled read-only SQL: %s", (statement) => {
    expect(assertReadOnlySql(statement)).toBeTruthy();
  });

  it.each([
    "INSERT INTO x VALUES (1)",
    "UPDATE x SET y = 1",
    "DELETE FROM x",
    "MERGE INTO x USING y ON true WHEN MATCHED THEN DELETE",
    "CREATE TABLE x(id integer)",
    "ALTER TABLE x ADD COLUMN y integer",
    "DROP TABLE x",
    "TRUNCATE x",
    "GRANT SELECT ON x TO y",
    "REVOKE SELECT ON x FROM y",
    "COMMENT ON TABLE x IS 'x'",
    "VACUUM x",
    "ANALYZE x",
    "COPY x FROM STDIN",
    "CALL unsafe()",
    "DO $$ BEGIN NULL; END $$",
    "REFRESH MATERIALIZED VIEW x",
  ])("rejects write-capable SQL: %s", (statement) => {
    expect(() => assertReadOnlySql(statement)).toThrow(PostflightIssue);
  });
});

describe("repository and migration validation", () => {
  it("loads the exact 0000 through 0006 journal and Drizzle hashes", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    expect(specification.migrations).toHaveLength(7);
    expect(specification.migrations[0].tag).toMatch(/^0000_/);
    expect(specification.migrations[6].tag).toMatch(/^0006_/);
    expect(specification.migrations.every((entry) => entry.hash.length === 64)).toBe(
      true
    );
  });

  it("rejects missing, duplicate, unknown, out-of-order, and hash-mismatched history", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const base = {
      migrationColumns: [
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
      ],
      migrationPrimaryKey: [{ columns: ["id"] }],
      migrationHistory: specification.migrations.map((entry, index) => ({
        id: String(index + 1),
        hash: entry.hash,
        created_at: entry.createdAt,
      })),
    };
    expect(validateMigrationHistory(specification, base).status).toBe("pass");

    const cases = [
      { ...base, migrationHistory: base.migrationHistory.slice(1) },
      {
        ...base,
        migrationHistory: [
          ...base.migrationHistory,
          { ...base.migrationHistory[6], id: "8" },
        ],
      },
      {
        ...base,
        migrationHistory: base.migrationHistory.map((row, index) =>
          index === 6 ? { ...row, hash: "0".repeat(64) } : row
        ),
      },
      {
        ...base,
        migrationHistory: [
          base.migrationHistory[1],
          base.migrationHistory[0],
          ...base.migrationHistory.slice(2),
        ],
      },
      {
        ...base,
        migrationHistory: base.migrationHistory.map((row, index) =>
          index === 6 ? { ...row, id: "1" } : row
        ),
      },
      {
        ...base,
        migrationColumns: base.migrationColumns.map((column, index) =>
          index === 0 ? { ...column, column_default: null } : column
        ),
      },
    ];
    for (const evidence of cases) {
      expect(() => validateMigrationHistory(specification, evidence)).toThrow(
        PostflightIssue
      );
    }
  });

  it("rejects an unexpected migration history table shape", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    expect(() =>
      validateMigrationHistory(specification, {
        migrationColumns: [],
        migrationPrimaryKey: [],
        migrationHistory: [],
      })
    ).toThrow(PostflightIssue);
  });
});

describe("schema and object manifest validation", () => {
  it("validates columns and rejects type, nullability, default, and missing drift", async () => {
    const { snapshot } = await loadRepositorySpecification(repositoryRoot);
    const rows = expectedColumnRows(snapshot);
    expect(() => validateColumns(snapshot, rows)).not.toThrow();
    for (const mutation of [
      rows.slice(1),
      rows.map((row, index) =>
        index === 0 ? { ...row, data_type: "text" } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, not_null: false } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, default_expression: null } : row
      ),
    ]) {
      expect(() => validateColumns(snapshot, mutation)).toThrow(PostflightIssue);
    }
  });

  it("validates constraints and rejects missing, changed check, and changed foreign key", async () => {
    const { snapshot } = await loadRepositorySpecification(repositoryRoot);
    const rows = expectedConstraintRows(snapshot);
    expect(() => validateConstraints(snapshot, rows)).not.toThrow();
    expect(() => validateConstraints(snapshot, rows.slice(1))).toThrow(
      PostflightIssue
    );
    const checkIndex = rows.findIndex((row) => row.constraint_type === "c");
    const changedCheck = rows.map((row, index) =>
      index === checkIndex ? { ...row, expression: "false" } : row
    );
    expect(() => validateConstraints(snapshot, changedCheck)).toThrow(
      PostflightIssue
    );
    const foreignKeyIndex = rows.findIndex((row) => row.constraint_type === "f");
    const changedForeignKey = rows.map((row, index) =>
      index === foreignKeyIndex ? { ...row, referenced_table: "plans" } : row
    );
    expect(() => validateConstraints(snapshot, changedForeignKey)).toThrow(
      PostflightIssue
    );
  });

  it("validates indexes including partial predicates", async () => {
    const { snapshot } = await loadRepositorySpecification(repositoryRoot);
    const rows = expectedIndexRows(snapshot);
    expect(() => validateIndexes(snapshot, rows)).not.toThrow();
    expect(() => validateIndexes(snapshot, rows.slice(1))).toThrow(PostflightIssue);
    const partialIndex = rows.findIndex((row) => row.predicate);
    const changed = rows.map((row, index) =>
      index === partialIndex ? { ...row, predicate: "false" } : row
    );
    expect(() => validateIndexes(snapshot, changed)).toThrow(PostflightIssue);
  });

  it("validates enum values and order", async () => {
    const { snapshot } = await loadRepositorySpecification(repositoryRoot);
    const rows = (Object.values(snapshot.enums) as any[])
      .map((entry) => ({
        enum_name: entry.name,
        owner_oid: "owner",
        values: entry.values,
      }))
      .sort((left, right) => left.enum_name.localeCompare(right.enum_name));
    expect(() => validateEnums(snapshot, rows, "owner")).not.toThrow();
    expect(() =>
      validateEnums(snapshot, [
        { ...rows[0], values: [...rows[0].values].reverse() },
        ...rows.slice(1),
      ], "owner")
    ).toThrow(PostflightIssue);
    expect(() =>
      validateEnums(
        snapshot,
        [{ ...rows[0], owner_oid: "other" }, ...rows.slice(1)],
        "owner"
      )
    ).toThrow(PostflightIssue);
    expect(() =>
      validateEnums(
        snapshot,
        [
          ...rows,
          { enum_name: "unexpected_enum", owner_oid: "owner", values: ["x"] },
        ],
        "owner"
      )
    ).toThrow(PostflightIssue);
  });

  it("validates full function signatures and security attributes", () => {
    const rows = EXPECTED_FUNCTIONS.map((entry) => ({
      function_name: entry.name,
      identity_arguments: entry.identity,
      result_type: entry.result,
      volatility: entry.volatility,
      language: entry.language,
      argument_defaults: entry.argumentDefaults,
      default_expression: entry.defaultExpression,
      returns_set: entry.returnsSet,
      is_strict: false,
      parallel_safety: "u",
      security_definer: false,
      configuration: ["search_path=public, pg_temp"],
      owner_oid: "owner",
      public_execute: false,
      current_role_execute: true,
      unexpected_grantee: false,
      current_grant_option: false,
      source_hash: `source-${entry.name}`,
    }));
    const sourceHashes = new Map(
      EXPECTED_FUNCTIONS.map((entry) => [entry.name, `source-${entry.name}`])
    );
    expect(() =>
      validateFunctions(rows, "owner", { sourceHashes })
    ).not.toThrow();
    expect(() =>
      validateFunctions(rows, "owner", { runtime: true, sourceHashes })
    ).not.toThrow();
    for (const mutation of [
      rows.slice(1),
      rows.map((row, index) =>
        index === 0 ? { ...row, identity_arguments: "uuid" } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, result_type: "text" } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, language: "plpgsql" } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, argument_defaults: row.argument_defaults + 1 } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, default_expression: "clock_timestamp()" } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, returns_set: !row.returns_set } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, security_definer: true } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, configuration: null } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, source_hash: "changed" } : row
      ),
      rows.map((row, index) =>
        index === 0 ? { ...row, public_execute: true } : row
      ),
      [...rows, rows[0]],
    ]) {
      expect(() =>
        validateFunctions(mutation, "owner", { sourceHashes })
      ).toThrow(PostflightIssue);
    }
    expect(() =>
      validateFunctions(
        rows.map((row, index) =>
          index === 0 ? { ...row, unexpected_grantee: true } : row
        ),
        "owner",
        { runtime: true, sourceHashes }
      )
    ).toThrow(PostflightIssue);
    expect(() =>
      validateFunctions(
        rows.map((row, index) =>
          index === 0 ? { ...row, current_grant_option: true } : row
        ),
        "owner",
        { runtime: true, sourceHashes }
      )
    ).toThrow(PostflightIssue);
  });
});

describe("ownership, ACL, RLS, and runtime privilege validation", () => {
  it("requires expected owners, no PUBLIC table privilege, no RLS policy, and exact sequence ownership", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const evidence = {
      tables: specification.expectedTableNames.map((table_name) => ({
        table_name,
        owner_oid: "owner",
        rls_enabled: false,
        rls_forced: false,
        public_any: false,
        unexpected_grantee: false,
        current_grant_option: false,
      })),
      policies: [],
      columnPrivileges: [],
      sequences: [
        {
          schema_name: "drizzle",
          sequence_name: "__drizzle_migrations_id_seq",
          owned_table: "__drizzle_migrations",
          owned_column: "id",
          owner_oid: "owner",
          public_any: false,
          unexpected_grantee: false,
          current_grant_option: false,
        },
      ],
    };
    expect(() =>
      validateTablesAndSecurity(specification, evidence, "owner")
    ).not.toThrow();
    for (const mutation of [
      { ...evidence, tables: evidence.tables.slice(1) },
      {
        ...evidence,
        tables: evidence.tables.map((row, index) =>
          index === 0 ? { ...row, owner_oid: "other" } : row
        ),
      },
      {
        ...evidence,
        tables: evidence.tables.map((row, index) =>
          index === 0 ? { ...row, public_any: true } : row
        ),
      },
      {
        ...evidence,
        tables: evidence.tables.map((row, index) =>
          index === 0 ? { ...row, rls_enabled: true } : row
        ),
      },
      { ...evidence, policies: [{ policy_name: "unexpected" }] },
      {
        ...evidence,
        columnPrivileges: [{ table_name: "users", column_name: "id" }],
      },
      { ...evidence, sequences: [] },
      {
        ...evidence,
        tables: [
          ...evidence.tables,
          {
            table_name: "unexpected_table",
            owner_oid: "owner",
            rls_enabled: false,
            rls_forced: false,
            public_any: false,
            unexpected_grantee: false,
            current_grant_option: false,
          },
        ],
      },
      {
        ...evidence,
        sequences: [
          ...evidence.sequences,
          {
            schema_name: "public",
            sequence_name: "unexpected_sequence",
            owned_table: null,
            owned_column: null,
            owner_oid: "owner",
            public_any: false,
            unexpected_grantee: false,
            current_grant_option: false,
          },
        ],
      },
    ]) {
      expect(() =>
        validateTablesAndSecurity(specification, mutation, "owner")
      ).toThrow(PostflightIssue);
    }
    expect(() =>
      validateTablesAndSecurity(
        specification,
        {
          ...evidence,
          tables: evidence.tables.map((row, index) =>
            index === 0 ? { ...row, current_grant_option: true } : row
          ),
        },
        "owner",
        { runtime: true }
      )
    ).toThrow(PostflightIssue);
  });

  it("requires direct database, schema, migration owners and safe default privileges", () => {
    const evidence = {
      roleSecurity: [{ role_oid: "owner", database_owner_oid: "owner" }],
      schemaOwnership: [
        {
          owner_is_expected: true,
          public_create: false,
          unexpected_create_grantee: false,
          current_usage_grant_option: true,
          current_create_grant_option: true,
          owner_oid: "schema",
        },
      ],
      drizzleOwnership: [
        {
          schema_owner_oid: "owner",
          table_owner_oid: "owner",
          sequence_owner_oid: "owner",
          public_any: false,
          schema_public_any: false,
          schema_unexpected_create_grantee: false,
          schema_current_grant_option: true,
        },
      ],
      defaultPrivileges: [
        {
          kind: "r",
          public_privilege: false,
          unexpected_grantee: false,
          unexpected_grant_option: false,
        },
        {
          kind: "S",
          public_privilege: false,
          unexpected_grantee: false,
          unexpected_grant_option: false,
        },
        {
          kind: "f",
          public_privilege: false,
          unexpected_grantee: false,
          unexpected_grant_option: false,
        },
      ],
    };
    expect(() => validateDirectPrivileges(evidence, "owner")).not.toThrow();
    expect(() =>
      validateDirectPrivileges(
        {
          ...evidence,
          defaultPrivileges: evidence.defaultPrivileges.map((row, index) =>
            index === 2 ? { ...row, public_privilege: true } : row
          ),
        },
        "owner"
      )
    ).toThrow(PostflightIssue);
    expect(() =>
      validateDirectPrivileges(
        {
          ...evidence,
          defaultPrivileges: evidence.defaultPrivileges.map((row, index) =>
            index === 0 ? { ...row, unexpected_grantee: true } : row
          ),
        },
        "owner"
      )
    ).toThrow(PostflightIssue);
    expect(() =>
      validateDirectPrivileges(
        {
          ...evidence,
          schemaOwnership: [
            { ...evidence.schemaOwnership[0], unexpected_create_grantee: true },
          ],
        },
        "owner"
      )
    ).toThrow(PostflightIssue);
    expect(() =>
      validateDirectPrivileges(
        {
          ...evidence,
          drizzleOwnership: [
            { ...evidence.drizzleOwnership[0], schema_public_any: true },
          ],
        },
        "owner"
      )
    ).toThrow(PostflightIssue);
  });

  it("requires a separate least-privilege runtime role and fixed search path", () => {
    const tablePrivileges = Object.entries(RUNTIME_TABLE_PRIVILEGES).flatMap(
      ([table_name, allowedPrivileges]) =>
        [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ].map((privilege) => ({
          table_name,
          privilege,
          allowed: allowedPrivileges.includes(privilege),
        }))
    );
    const evidence = {
      roleSecurity: [
        {
          role_oid: "runtime",
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: true,
          session_role_matches: true,
          any_role_membership: false,
          database_create: false,
          schema_usage: true,
          schema_create: false,
          migration_schema_usage: true,
          migration_schema_create: false,
        },
      ],
      searchPath: [{ search_path: "public, pg_temp" }],
      schemaOwnership: [
        {
          current_usage_grant_option: false,
          current_create_grant_option: false,
        },
      ],
      runtimeOwnerMembership: [{ owner_membership: false }],
      runtimeTablePrivileges: tablePrivileges,
      runtimeSequencePrivileges: [
        {
          sequence_name: "history",
          usage_allowed: false,
          update_allowed: false,
          select_allowed: false,
        },
      ],
      sequences: [
        {
          sequence_name: "history",
          public_any: false,
          unexpected_grantee: false,
          current_grant_option: false,
        },
      ],
      runtimeTypePrivileges: [
        {
          type_name: "analysis_status",
          usage_allowed: true,
          current_grant_option: false,
        },
      ],
      drizzleOwnership: [
        {
          public_any: false,
          unexpected_grantee: false,
          current_select: true,
          current_insert: false,
          current_update: false,
          current_delete: false,
          current_grant_option: false,
          schema_current_grant_option: false,
        },
      ],
    };
    expect(() =>
      validateRuntimePrivileges(evidence, "owner", ["analysis_status"])
    ).not.toThrow();
    for (const mutation of [
      { ...evidence, roleSecurity: [{ ...evidence.roleSecurity[0], role_oid: "owner" }] },
      { ...evidence, roleSecurity: [{ ...evidence.roleSecurity[0], rolsuper: true }] },
      {
        ...evidence,
        roleSecurity: [
          { ...evidence.roleSecurity[0], any_role_membership: true },
        ],
      },
      {
        ...evidence,
        roleSecurity: [{ ...evidence.roleSecurity[0], schema_create: true }],
      },
      { ...evidence, searchPath: [{ search_path: '"$user", public' }] },
      {
        ...evidence,
        runtimeOwnerMembership: [{ owner_membership: true }],
      },
      {
        ...evidence,
        runtimeTablePrivileges: tablePrivileges.map((row, index) =>
          index === 0 ? { ...row, allowed: !row.allowed } : row
        ),
      },
      {
        ...evidence,
        runtimeSequencePrivileges: [
          {
            sequence_name: "history",
            usage_allowed: true,
            update_allowed: false,
            select_allowed: false,
          },
        ],
      },
      {
        ...evidence,
        sequences: [
          { ...evidence.sequences[0], current_grant_option: true },
        ],
      },
      {
        ...evidence,
        runtimeSequencePrivileges: [
          {
            ...evidence.runtimeSequencePrivileges[0],
            select_allowed: true,
          },
        ],
      },
      {
        ...evidence,
        runtimeTypePrivileges: [
          {
            type_name: "analysis_status",
            usage_allowed: false,
            current_grant_option: false,
          },
        ],
      },
      {
        ...evidence,
        schemaOwnership: [
          {
            ...evidence.schemaOwnership[0],
            current_usage_grant_option: true,
          },
        ],
      },
      {
        ...evidence,
        runtimeTypePrivileges: [
          {
            ...evidence.runtimeTypePrivileges[0],
            current_grant_option: true,
          },
        ],
      },
      {
        ...evidence,
        drizzleOwnership: [
          { ...evidence.drizzleOwnership[0], current_grant_option: true },
        ],
      },
      {
        ...evidence,
        drizzleOwnership: [
          { ...evidence.drizzleOwnership[0], unexpected_grantee: true },
        ],
      },
    ]) {
      expect(() =>
        validateRuntimePrivileges(mutation, "owner", ["analysis_status"])
      ).toThrow(PostflightIssue);
    }
  });
});
