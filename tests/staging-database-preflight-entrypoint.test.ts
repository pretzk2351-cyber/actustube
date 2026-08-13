/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { createPreflightBaseReport } from "../scripts/staging-database-preflight/core.mjs";
import { EXPECTED_MIGRATION_TAGS } from "../scripts/staging-database-postflight/manifest.mjs";
import {
  isDirectPreflightInvocation,
  runPreflightCli,
  runStagingPreflightEntrypoint,
} from "../scripts/verify-staging-database-preflight.mjs";

const runCli = runPreflightCli as any;
const runEntrypoint = runStagingPreflightEntrypoint as any;

type ProcessFixture = EventEmitter & {
  exitCode: number | undefined;
};

function createProcessFixture(): ProcessFixture {
  return Object.assign(new EventEmitter(), {
    exitCode: undefined as number | undefined,
  });
}

function successReport() {
  const zeroCounts = () => ({
    total: 0,
    estimatedDataRows: 0,
    schemas: 0,
    relations: 0,
    routines: 0,
    types: 0,
    triggers: 0,
    rules: 0,
    policies: 0,
    constraints: 0,
    other: 0,
  });
  return {
    ...createPreflightBaseReport(),
    postgresqlVersion: {
      direct: "supported",
      pooled: "supported",
      directAfter: "supported",
      pooledAfter: "supported",
    },
    directConnection: "pass",
    pooledConnection: "pass",
    connectionAuthority: "match",
    directPooledIdentity: "match",
    databaseRoleIdentity: "match",
    expectedIdentity: "match",
    extensionInventory: "match",
    initialState: "pristine",
    migrationCatalog: "pass",
    migrationHistory: {
      status: "pass",
      expected: EXPECTED_MIGRATION_TAGS.length,
      applied: 0,
      pending: EXPECTED_MIGRATION_TAGS.length,
      pendingTags: [...EXPECTED_MIGRATION_TAGS],
      duplicates: 0,
      unknown: 0,
    },
    applicationTables: 0,
    applicationFunctions: 0,
    applicationData: 0,
    userDefinedObjects: {
      direct: zeroCounts(),
      pooled: zeroCounts(),
      directAfter: zeroCounts(),
      pooledAfter: zeroCounts(),
    },
    migrationSequenceState: {
      direct: "not_applicable",
      pooled: "not_applicable",
      directAfter: "not_applicable",
      pooledAfter: "not_applicable",
    },
    partialSchema: "none",
    readOnlyInvariant: "pass",
    beforeAfterComparison: "match",
    cleanup: "pass",
    overallStatus: "pass",
    exitCode: 0,
  };
}

function unverifiedReport(checkId = "PREFLIGHT_TEST_UNVERIFIED") {
  return {
    ...createPreflightBaseReport(),
    failure: { checkId, status: "not_verified" },
    exitCode: 3,
  };
}

function expectOneReportPair(output: string[]) {
  expect(output).toHaveLength(1);
  const buffer = output[0];
  const firstNewline = buffer.indexOf("\n");
  expect(firstNewline).toBeGreaterThan(0);
  const report = JSON.parse(buffer.slice(0, firstNewline));
  expect(report).toHaveProperty("exitCode");
  expect(buffer.match(/ActusTube staging database preflight/g) || []).toHaveLength(1);
  expect(buffer.endsWith("\n")).toBe(true);
}

function expectNoFatalListeners(processFixture: ProcessFixture) {
  expect(processFixture.listenerCount("uncaughtException")).toBe(0);
  expect(processFixture.listenerCount("unhandledRejection")).toBe(0);
}

function abortAwareMain() {
  return ({ signal }: { signal: AbortSignal }) =>
    new Promise<ReturnType<typeof successReport>>((resolve) => {
      signal.addEventListener("abort", () => resolve(successReport()), {
        once: true,
      });
    });
}

describe("staging database preflight entrypoint terminal report gate", () => {
  it("commits a normal report as one synchronous buffer", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const report = await runCli({
      mainFunction: async () => successReport(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
    });

    expect(report.exitCode).toBe(0);
    expect(processFixture.exitCode).toBe(0);
    expectOneReportPair(output);
    expectNoFatalListeners(processFixture);
  });

  it.each([
    [
      "all required checks not verified",
      () => ({ ...createPreflightBaseReport(), exitCode: 0 }),
    ],
    [
      "one required check missing",
      () => {
        const report: any = successReport();
        delete report.extensionInventory;
        return report;
      },
    ],
    [
      "one required check not verified",
      () => ({ ...successReport(), cleanup: "not_verified" }),
    ],
    [
      "a duplicated required migration check",
      () => {
        const report: any = successReport();
        report.migrationHistory = {
          ...report.migrationHistory,
          pendingTags: [
            ...EXPECTED_MIGRATION_TAGS.slice(0, -1),
            EXPECTED_MIGRATION_TAGS[0],
          ],
        };
        return report;
      },
    ],
    [
      "an overall-status contradiction",
      () => ({ ...successReport(), overallStatus: "fail" }),
    ],
  ])("rejects exit zero with %s", async (_label, createReport) => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const report = await runCli({
      mainFunction: async () => createReport(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
    });

    expect(report).toMatchObject({
      exitCode: 3,
      failure: {
        checkId: "PREFLIGHT_PUBLIC_REPORT_INVALID",
        status: "not_verified",
      },
    });
    expect(processFixture.exitCode).toBe(3);
    expectOneReportPair(output);
    expectNoFatalListeners(processFixture);
  });

  it.each([
    ["unhandledRejection", "UNHANDLED_REJECTION"],
    ["uncaughtException", "UNCAUGHT_EXCEPTION"],
  ] as const)(
    "gives %s fatal precedence before commit",
    async (eventName, checkId) => {
      const processFixture = createProcessFixture();
      const output: string[] = [];
      const running = runCli({
        mainFunction: abortAwareMain(),
        processObject: processFixture,
        stdout: (buffer: string) => output.push(buffer),
      });

      processFixture.emit(eventName, new Error("fixture-sensitive"));
      const report = await running;

      expect(report.failure).toEqual({ checkId, status: "not_verified" });
      expect(processFixture.exitCode).toBe(3);
      expectOneReportPair(output);
      expect(output[0]).not.toContain("fixture-sensitive");
      expectNoFatalListeners(processFixture);
    }
  );

  it("lets a fatal event at the terminal barrier replace main", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const report = await runCli({
      mainFunction: async () => successReport(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
      terminalBarrier: async () => {
        processFixture.emit("unhandledRejection", new Error("barrier-fatal"));
      },
    });

    expect(report.failure.checkId).toBe("UNHANDLED_REJECTION");
    expect(processFixture.exitCode).toBe(3);
    expectOneReportPair(output);
    expect(output[0]).not.toContain("barrier-fatal");
    expectNoFatalListeners(processFixture);
  });

  it("emits the fixed fallback once when formatting fails", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const report = await runCli({
      mainFunction: async () => successReport(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
      formatSummary: () => {
        throw new Error("formatter-sensitive");
      },
    });

    expect(report.failure.checkId).toBe("PREFLIGHT_FORMATTER_FAILURE");
    expect(processFixture.exitCode).toBe(3);
    expectOneReportPair(output);
    expect(output[0]).not.toContain("formatter-sensitive");
    expectNoFatalListeners(processFixture);
  });

  it("rejects a non-canonical formatter result without printing it", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const secret = "formatter-returned-secret";
    const report = await runCli({
      mainFunction: async () => successReport(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
      formatSummary: () => secret,
    });

    expect(report.failure.checkId).toBe("PREFLIGHT_FORMATTER_FAILURE");
    expect(processFixture.exitCode).toBe(3);
    expectOneReportPair(output);
    expect(output[0]).not.toContain(secret);
    expectNoFatalListeners(processFixture);
  });

  it("rejects a summary-only pass claim", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const report = await runCli({
      mainFunction: async () => successReport(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
      formatSummary: () => "pass",
    });

    expect(report.failure.checkId).toBe("PREFLIGHT_FORMATTER_FAILURE");
    expect(processFixture.exitCode).toBe(3);
    expect(output.join("\n")).not.toContain("\npass\n");
    expectNoFatalListeners(processFixture);
  });

  it("does not retry after a synchronous writer failure", async () => {
    const processFixture = createProcessFixture();
    let writerCalls = 0;
    const report = await runCli({
      mainFunction: async () => successReport(),
      processObject: processFixture,
      stdout: () => {
        writerCalls += 1;
        throw new Error("writer-sensitive");
      },
    });

    expect(writerCalls).toBe(1);
    expect(report.failure.checkId).toBe("PREFLIGHT_OUTPUT_FAILURE");
    expect(processFixture.exitCode).toBe(3);
    expectNoFatalListeners(processFixture);
  });

  it("keeps the first fatal across multiple events and late main", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const running = runCli({
      mainFunction: abortAwareMain(),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
    });

    processFixture.emit("unhandledRejection", new Error("first-fatal"));
    processFixture.emit("uncaughtException", new Error("second-fatal"));
    const report = await running;

    expect(report.failure.checkId).toBe("UNHANDLED_REJECTION");
    expect(processFixture.exitCode).toBe(3);
    expectOneReportPair(output);
    expect(output[0]).not.toMatch(/first-fatal|second-fatal/);
    expectNoFatalListeners(processFixture);
  });

  it("fails closed without leaking unknown or invalid public report fields", async () => {
    const secret = "postgresql://user:password@secret.example/private";
    const uppercaseSecret = "TOP_SECRET_TOKEN";
    for (const invalidReport of [
      { ...successReport(), rawError: secret },
      { ...successReport(), directConnection: secret },
      {
        ...unverifiedReport(),
        failure: { checkId: uppercaseSecret, status: "not_verified" },
      },
    ]) {
      const processFixture = createProcessFixture();
      const output: string[] = [];
      const report = await runCli({
        mainFunction: async () => invalidReport,
        processObject: processFixture,
        stdout: (buffer: string) => output.push(buffer),
      });

      expect(report.failure).toEqual({
        checkId: "PREFLIGHT_PUBLIC_REPORT_INVALID",
        status: "not_verified",
      });
      expect(processFixture.exitCode).toBe(3);
      expectOneReportPair(output);
      expect(output[0]).not.toContain(secret);
      expect(output[0]).not.toContain(uppercaseSecret);
      expectNoFatalListeners(processFixture);
    }
  });

  it("finishes a fatal report even when main ignores the abort signal", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const running = runCli({
      mainFunction: () => new Promise(() => undefined),
      processObject: processFixture,
      stdout: (buffer: string) => output.push(buffer),
    });

    processFixture.emit("uncaughtException", new Error("ignored-abort-secret"));
    const report = await running;

    expect(report.failure).toEqual({
      checkId: "UNCAUGHT_EXCEPTION",
      status: "not_verified",
    });
    expect(processFixture.exitCode).toBe(3);
    expectOneReportPair(output);
    expect(output[0]).not.toContain("ignored-abort-secret");
    expectNoFatalListeners(processFixture);
  });

  it("forces termination only after an exit-3 CLI report and listener cleanup", async () => {
    const processFixture = createProcessFixture();
    const output: string[] = [];
    const terminated: number[] = [];
    const report = await runEntrypoint({
      runCliFunction: () =>
        runCli({
          mainFunction: async () => unverifiedReport(),
          processObject: processFixture,
          stdout: (buffer: string) => output.push(buffer),
        }),
      terminateProcess: (code: number) => {
        expectNoFatalListeners(processFixture);
        terminated.push(code);
      },
    });

    expect(report.exitCode).toBe(3);
    expect(terminated).toEqual([3]);
    expectOneReportPair(output);

    const normalTerminations: number[] = [];
    await runEntrypoint({
      runCliFunction: async () => successReport(),
      terminateProcess: (code: number) => normalTerminations.push(code),
    });
    expect(normalTerminations).toEqual([]);
  });

  it("matches the direct entry path using canonical Windows path semantics", () => {
    const scriptPath = resolve(
      process.cwd(),
      "scripts/verify-staging-database-preflight.mjs"
    );
    expect(
      isDirectPreflightInvocation({
        moduleUrl: pathToFileURL(scriptPath.toUpperCase()).href,
        argvEntry: scriptPath.toLowerCase(),
        platform: "win32",
        realpath: ((value: string) => value) as any,
      })
    ).toBe(true);
    expect(
      isDirectPreflightInvocation({
        moduleUrl: pathToFileURL(scriptPath).href,
        argvEntry: resolve(process.cwd(), "package.json"),
      })
    ).toBe(false);
  });
});
