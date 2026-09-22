import { pathToFileURL } from "node:url";

import { verifyStagingDatabasePostflight } from "./staging-database-postflight/core.mjs";
import { createNeonPostflightAdapter } from "./staging-database-postflight/neon-adapter.mjs";

export const PARENT_ENVIRONMENT_NOTICE =
  "このscriptは親shellの環境変数を削除できません。呼出し元processからstaging DB用環境変数を削除し、不要ならterminalを閉じてください。";

export function formatHumanSummary(report) {
  return [
    "ActusTube staging database postflight",
    `direct connection: ${report.directConnection}`,
    `pooled connection: ${report.pooledConnection}`,
    `same logical database: ${report.sameLogicalDatabase}`,
    `migration history: ${report.migrationHistory.status}`,
    `schema: ${report.schema}`,
    `functions: ${report.functions}`,
    `ownership: ${report.ownership}`,
    `ACL: ${report.acl}`,
    `PUBLIC EXECUTE: ${report.publicExecute}`,
    `runtime privileges: ${report.runtimePrivileges}`,
    `read-only smoke: ${report.readOnlySmoke}`,
    `data counts unchanged: ${report.dataCountsUnchanged}`,
    ...(report.failure
      ? [
          `failure check: ${report.failure.checkId}`,
          `failure status: ${report.failure.status}`,
        ]
      : []),
    `exit code: ${report.exitCode}`,
    PARENT_ENVIRONMENT_NOTICE,
  ].join("\n");
}
export async function executeStagingDatabasePostflight({
  environment = process.env,
  repositoryRoot = process.cwd(),
  adapter = createNeonPostflightAdapter(),
  allowLoopback = false,
  onQuery,
  uuidFactory,
  stdout = (line) => console.log(line),
} = {}) {
  const report = await verifyStagingDatabasePostflight({
    environment,
    repositoryRoot,
    adapter,
    allowLoopback,
    onQuery,
    uuidFactory,
  });
  stdout(JSON.stringify(report));
  stdout(formatHumanSummary(report));
  return report;
}

async function main() {
  return executeStagingDatabasePostflight();
}

export function createFatalExitLatch({
  stdout = (line) => console.log(line),
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  let fatal = false;
  let reported = false;
  const latch = (checkId) => {
    fatal = true;
    if (!reported) {
      reported = true;
      const report = {
        environment: "staging",
        directConnection: "not_verified",
        pooledConnection: "not_verified",
        sameLogicalDatabase: "not_verified",
        migrationHistory: {
          status: "not_verified",
          expected: 7,
          actual: 0,
          pending: 7,
          duplicates: 0,
          unknown: 0,
        },
        schema: "not_verified",
        functions: "not_verified",
        ownership: "not_verified",
        acl: "not_verified",
        publicExecute: "not_verified",
        defaultPrivileges: "not_verified",
        securityMode: "not_verified",
        searchPath: "not_verified",
        runtimePrivileges: "not_verified",
        rlsPolicies: "not_verified",
        readOnlySmoke: "not_verified",
        dataCountsUnchanged: "not_verified",
        exitCode: 3,
        failure: { checkId, status: "not_verified" },
      };
      stdout(JSON.stringify(report));
      stdout(formatHumanSummary(report));
    }
    setExitCode(3);
  };
  return {
    latch,
    setReportExitCode(code) {
      setExitCode(fatal ? 3 : code);
    },
  };
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const fatalExit = createFatalExitLatch();
  process.once("uncaughtException", () => fatalExit.latch("UNCAUGHT_EXCEPTION"));
  process.once("unhandledRejection", () => fatalExit.latch("UNHANDLED_REJECTION"));
  main()
    .then((report) => fatalExit.setReportExitCode(report.exitCode))
    .catch(() => fatalExit.latch("POSTFLIGHT_TOP_LEVEL_FAILURE"));
}
