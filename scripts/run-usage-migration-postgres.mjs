import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSanitizedEnvironment,
  isSafeHarnessTemporaryPath,
  sanitizeDiagnostic,
} from "./usage-migration-harness-safety.mjs";

const repositoryRoot = process.cwd();
const workerPath = join(
  repositoryRoot,
  "scripts",
  "verify-usage-migration-postgres.mjs"
);
const maximumOutputBytes = 64 * 1024;
const workerTimeoutMilliseconds = 10 * 60 * 1000;
const timeoutProbeMilliseconds = 500;

function terminateOwnedProcessTree(child) {
  if (!child.pid) return;
  child.kill();
  if (process.platform === "win32") {
    spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        encoding: "utf8",
        shell: false,
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
      }
    );
  }
}

async function cleanupOwnedTemporaryRoot(disposableRoot, temporaryRoot) {
  if (!isSafeHarnessTemporaryPath(disposableRoot, temporaryRoot)) {
    throw new Error("HARNESS_TEMPORARY_PATH_REJECTED");
  }
  await rm(disposableRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

async function runWorker(
  mode,
  { timeoutMilliseconds = workerTimeoutMilliseconds } = {}
) {
  const temporaryRoot = tmpdir();
  let disposableRoot;
  try {
    disposableRoot = await mkdtemp(join(temporaryRoot, "actustube-pg-"));
    if (!isSafeHarnessTemporaryPath(disposableRoot, temporaryRoot)) {
      throw new Error("HARNESS_TEMPORARY_PATH_REJECTED");
    }
    const ownershipNonce = randomUUID();
    await writeFile(
      join(disposableRoot, ".actustube-harness-owner"),
      ownershipNonce,
      { encoding: "utf8", flag: "wx" }
    );

    return await runOwnedWorker({
      disposableRoot,
      mode,
      ownershipNonce,
      temporaryRoot,
      timeoutMilliseconds,
    });
  } catch (error) {
    if (
      disposableRoot &&
      isSafeHarnessTemporaryPath(disposableRoot, temporaryRoot)
    ) {
      try {
        await cleanupOwnedTemporaryRoot(disposableRoot, temporaryRoot);
      } catch {
        throw Object.assign(new Error("HARNESS_PARENT_CLEANUP_FAILED"), {
          errorCode: "HARNESS_PARENT_CLEANUP_FAILED",
        });
      }
    }
    if (error && typeof error === "object" && "errorCode" in error) {
      throw error;
    }
    throw Object.assign(new Error("HARNESS_TEMPORARY_SETUP_FAILED"), {
      errorCode: "HARNESS_TEMPORARY_SETUP_FAILED",
    });
  }
}

function runOwnedWorker({
  disposableRoot,
  mode,
  ownershipNonce,
  temporaryRoot,
  timeoutMilliseconds,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [workerPath, mode, disposableRoot, ownershipNonce], {
        cwd: repositoryRoot,
        env: createSanitizedEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      void cleanupOwnedTemporaryRoot(disposableRoot, temporaryRoot)
        .then(() =>
          reject(
            Object.assign(new Error("HARNESS_WORKER_START"), {
              errorCode: "HARNESS_WORKER_START",
            })
          )
        )
        .catch(() =>
          reject(
            Object.assign(new Error("HARNESS_PARENT_CLEANUP_FAILED"), {
              errorCode: "HARNESS_PARENT_CLEANUP_FAILED",
            })
          )
        );
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (errorCode, diagnostic) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminateOwnedProcessTree(child);
      void cleanupOwnedTemporaryRoot(disposableRoot, temporaryRoot)
        .then(() =>
          reject(
            Object.assign(new Error(sanitizeDiagnostic(diagnostic)), {
              errorCode,
            })
          )
        )
        .catch(() =>
          reject(
            Object.assign(new Error("HARNESS_PARENT_CLEANUP_FAILED"), {
              errorCode: "HARNESS_PARENT_CLEANUP_FAILED",
            })
          )
        );
    };

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maximumOutputBytes) {
        fail("HARNESS_OUTPUT_LIMIT", "Worker output exceeded the safe limit.");
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => fail("HARNESS_WORKER_START", error.message));

    const timeout = setTimeout(
      () => fail("HARNESS_WORKER_TIMEOUT", "Worker timed out."),
      timeoutMilliseconds
    );
    timeout.unref();

    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        await cleanupOwnedTemporaryRoot(disposableRoot, temporaryRoot);
      } catch {
        reject(
          Object.assign(new Error("HARNESS_PARENT_CLEANUP_FAILED"), {
            errorCode: "HARNESS_PARENT_CLEANUP_FAILED",
          })
        );
        return;
      }
      const line = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .at(-1);
      let result;
      try {
        result = line ? JSON.parse(line) : null;
      } catch {
        reject(
          Object.assign(
            new Error(sanitizeDiagnostic(stderr || "Invalid worker output.")),
            { errorCode: "HARNESS_WORKER_OUTPUT" }
          )
        );
        return;
      }
      if (code !== 0 || signal || !result || typeof result !== "object") {
        reject(
          Object.assign(
            new Error(
              sanitizeDiagnostic(
                result?.errorCode || stderr || "Worker did not complete."
              )
            ),
            { errorCode: result?.errorCode || "HARNESS_WORKER_FAILED" }
          )
        );
        return;
      }
      resolve(result);
    });
  });
}

function requireTrue(value, errorCode) {
  if (value !== true) {
    throw Object.assign(new Error(errorCode), { errorCode });
  }
}

try {
  const verification = await runWorker("--actustube-disposable-worker");
  const verificationFailureCode = [
    "HARNESS_VERIFICATION_FAILED",
    verification.verificationStep,
    verification.errorCode,
  ]
    .filter(Boolean)
    .join("_")
    .replaceAll(/[^A-Za-z0-9_\-]/g, "_")
    .slice(0, 96);
  if (verification.success !== true) {
    throw Object.assign(
      new Error(
        sanitizeDiagnostic(
          verification.diagnosticMessage || verificationFailureCode
        )
      ),
      { errorCode: verificationFailureCode }
    );
  }
  requireTrue(
    verification.disposable_cleanup_complete,
    "HARNESS_SUCCESS_CLEANUP_FAILED"
  );
  requireTrue(
    verification.postgres_process_residual === false,
    "HARNESS_SUCCESS_PROCESS_RESIDUAL"
  );
  requireTrue(
    verification.disposable_data_residual === false,
    "HARNESS_SUCCESS_DATA_RESIDUAL"
  );

  const cleanupFailure = await runWorker(
    "--actustube-cleanup-failure-worker"
  );
  requireTrue(cleanupFailure.success, "HARNESS_FAILURE_PROBE_FAILED");
  requireTrue(
    cleanupFailure.intentional_failure_triggered,
    "HARNESS_FAILURE_NOT_TRIGGERED"
  );
  requireTrue(
    cleanupFailure.disposable_cleanup_complete,
    "HARNESS_FAILURE_CLEANUP_FAILED"
  );
  requireTrue(
    cleanupFailure.postgres_process_residual === false,
    "HARNESS_FAILURE_PROCESS_RESIDUAL"
  );
  requireTrue(
    cleanupFailure.disposable_data_residual === false,
    "HARNESS_FAILURE_DATA_RESIDUAL"
  );

  let parentTimeoutCleanup = false;
  try {
    await runWorker("--actustube-parent-timeout-worker", {
      timeoutMilliseconds: timeoutProbeMilliseconds,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "errorCode" in error &&
      error.errorCode === "HARNESS_WORKER_TIMEOUT"
    ) {
      parentTimeoutCleanup = true;
    } else {
      throw error;
    }
  }
  requireTrue(parentTimeoutCleanup, "HARNESS_PARENT_TIMEOUT_PROBE_FAILED");

  console.log(
    JSON.stringify({
      ...verification,
      intentional_failure_cleanup: true,
      parent_timeout_cleanup: true,
    })
  );
} catch (error) {
  console.error(
    JSON.stringify({
      success: false,
      errorCode:
        error && typeof error === "object" && "errorCode" in error
          ? String(error.errorCode).slice(0, 48)
          : "HARNESS_LAUNCHER_FAILED",
      diagnosticMessage:
        error instanceof Error ? sanitizeDiagnostic(error.message) : null,
    })
  );
  process.exitCode = 1;
}
