import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSanitizedEnvironment,
  isSafeHarnessTemporaryPath,
} from "./usage-migration-harness-safety.mjs";

const repositoryRoot = process.cwd();
const workerPath = join(
  repositoryRoot,
  "scripts",
  "verify-staging-database-postflight-postgres.mjs"
);
const maximumOutputBytes = 128 * 1024;
const workerTimeoutMilliseconds = 10 * 60 * 1000;

function terminateOwnedProcessTree(child) {
  if (!child.pid) return;
  child.kill();
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      shell: false,
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
  }
}

async function removeOwnedRoot(disposableRoot) {
  if (!isSafeHarnessTemporaryPath(disposableRoot, tmpdir())) {
    throw new Error("POSTFLIGHT_HARNESS_PATH_REJECTED");
  }
  await rm(disposableRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

async function runWorker(mode, timeoutMilliseconds = workerTimeoutMilliseconds) {
  const disposableRoot = await mkdtemp(join(tmpdir(), "actustube-pg-"));
  if (!isSafeHarnessTemporaryPath(disposableRoot, tmpdir())) {
    throw new Error("POSTFLIGHT_HARNESS_PATH_REJECTED");
  }
  const nonce = randomUUID();
  await writeFile(join(disposableRoot, ".actustube-harness-owner"), nonce, {
    encoding: "utf8",
    flag: "wx",
  });

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, mode, disposableRoot, nonce],
      {
        cwd: repositoryRoot,
        env: createSanitizedEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishFailure = async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateOwnedProcessTree(child);
      try {
        await removeOwnedRoot(disposableRoot);
      } catch {
        reject(new Error("POSTFLIGHT_HARNESS_PARENT_CLEANUP_FAILED"));
        return;
      }
      reject(new Error(code));
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maximumOutputBytes) {
        void finishFailure("POSTFLIGHT_HARNESS_OUTPUT_LIMIT");
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
    child.on("error", () => void finishFailure("POSTFLIGHT_HARNESS_START_FAILED"));
    const timer = setTimeout(
      () => void finishFailure("POSTFLIGHT_HARNESS_TIMEOUT"),
      timeoutMilliseconds
    );
    timer.unref();
    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await removeOwnedRoot(disposableRoot);
      } catch {
        reject(new Error("POSTFLIGHT_HARNESS_PARENT_CLEANUP_FAILED"));
        return;
      }
      const lastLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      let result;
      try {
        result = lastLine ? JSON.parse(lastLine) : null;
      } catch {
        reject(new Error("POSTFLIGHT_HARNESS_OUTPUT_INVALID"));
        return;
      }
      if (code !== 0 || signal || !result?.success || stderr.trim()) {
        reject(
          new Error(
            [result?.errorCode, result?.verificationStep, result?.lastCheckId]
              .filter((value) => /^[A-Za-z0-9_-]+$/.test(String(value || "")))
              .join("_") || "POSTFLIGHT_HARNESS_FAILED"
          )
        );
        return;
      }
      if (
        result.disposable_cleanup_complete !== true ||
        result.postgres_process_residual !== false ||
        result.disposable_data_residual !== false
      ) {
        reject(new Error("POSTFLIGHT_HARNESS_CLEANUP_UNVERIFIED"));
        return;
      }
      resolve(result);
    });
  });
}

try {
  const result = await runWorker("--actustube-postflight-worker");
  let timeoutCleanup = false;
  try {
    await runWorker("--actustube-postflight-timeout-worker", 750);
  } catch (error) {
    timeoutCleanup = error?.message === "POSTFLIGHT_HARNESS_TIMEOUT";
  }
  if (!timeoutCleanup) throw new Error("POSTFLIGHT_HARNESS_TIMEOUT_PROBE_FAILED");
  console.log(
    JSON.stringify({
      ...result,
      parent_timeout_cleanup: true,
    })
  );
} catch (error) {
  console.error(
    JSON.stringify({
      success: false,
      errorCode:
        error instanceof Error
          ? error.message
              .replaceAll(/[^A-Z0-9_]/gi, "_")
              .toUpperCase()
              .slice(0, 96)
          : "POSTFLIGHT_HARNESS_LAUNCHER_FAILED",
    })
  );
  process.exitCode = 1;
}
