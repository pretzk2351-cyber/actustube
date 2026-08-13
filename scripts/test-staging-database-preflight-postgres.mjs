import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, writeSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  realpath,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";

import {
  PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS,
  PREFLIGHT_SQL_FOR_TESTS,
  verifyStagingDatabasePreflight,
} from "./staging-database-preflight/core.mjs";
import { POSTFLIGHT_SQL_FOR_TESTS } from "./staging-database-postflight/core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), "..");
const LIFECYCLE_FILE = "lifecycle-state.json";
const ROOT_CLAIM_FILE = "root-claim.json";
const OWNED_ROOT_PREFIX = "actustube-preflight-owned-";
const ROOT_CLAIM_SCHEMA_VERSION = 1;
const IPC_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 2;
const OCCURRENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_OS_ENVIRONMENT_KEYS = Object.freeze([
  "COMSPEC",
  // Windows injects these profile identity keys into a child even when the
  // supplied positive env omits them. They are allowlisted for presence only;
  // sourceEnvironment never supplies their values and reports never emit them.
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "OS",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);
const SAFE_OS_ENVIRONMENT_KEY_SET = new Set(SAFE_OS_ENVIRONMENT_KEYS);
const FORBIDDEN_CHILD_ENVIRONMENT_KEY =
  /(?:DATABASE_URL|DIRECT_DATABASE_URL|^PG|PROXY|CREDENTIAL|TOKEN|SECRET|PASSWORD|AUTHORIZATION|NODE_OPTIONS)/i;
const HARNESS_MODES = Object.freeze([
  "integration",
  "ready_hang",
  "partial_start_throw",
  "stop_hang",
  "child_crash",
]);
const FAULT_CONTRACTS = Object.freeze({
  ready_hang: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "ready_pending"]),
    terminalReason: "FORCED_CLEANUP_READY_HANG",
  }),
  partial_start_throw: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "partial_start_failure"]),
    terminalReason: "CHILD_EXIT_PARTIAL_START_THROW",
  }),
  stop_hang: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "ready", "stopping"]),
    terminalReason: "FORCED_CLEANUP_STOP_HANG",
  }),
  child_crash: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "child_crash"]),
    terminalReason: "CHILD_EXIT_CRASH",
  }),
});

export const POSTGRES_HARNESS_TIMEOUTS = Object.freeze({
  initialise: 30_000,
  startSpawn: 5_000,
  ready: 20_000,
  testExecution: 60_000,
  stop: 10_000,
  forcedCleanup: 10_000,
  faultPhase: 1_500,
});

export const POSTGRES_HARNESS_FAULT_CONTRACTS = FAULT_CONTRACTS;

function valueForKey(source, expectedKey) {
  const actualKey = Object.keys(source).find(
    (key) => key.toUpperCase() === expectedKey
  );
  return actualKey ? source[actualKey] : undefined;
}

function assertRegularCanonicalFile(path, expectedParent, expectedBasename) {
  if (!isAbsolute(path) || basename(path).toLowerCase() !== expectedBasename) {
    throw new Error("POSTGRES_HARNESS_UTILITY_IDENTITY_INVALID");
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("POSTGRES_HARNESS_UTILITY_IDENTITY_INVALID");
  }
  const canonical = realpathSync.native(path);
  if (
    normalizePathForComparison(dirname(canonical)) !==
    normalizePathForComparison(expectedParent)
  ) {
    throw new Error("POSTGRES_HARNESS_UTILITY_IDENTITY_INVALID");
  }
  return canonical;
}

function resolveTrustedWindowsPlatform(candidateRoot) {
  if (process.platform !== "win32") {
    return Object.freeze({ platform: process.platform });
  }

  // Trust boundary: derive the OS volume from the already-running Node binary,
  // then require the fixed Windows directory on that volume. Caller-provided
  // SYSTEMROOT/WINDIR/PATH values never select an executable. A nonstandard
  // installation fails closed instead of falling back to PATH or an env value.
  const derivedRoot = join(parse(realpathSync.native(process.execPath)).root, "Windows");
  const requestedRoot = candidateRoot || derivedRoot;
  if (
    normalizePathForComparison(requestedRoot) !==
    normalizePathForComparison(derivedRoot)
  ) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const rootMetadata = lstatSync(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const windowsRoot = realpathSync.native(requestedRoot);
  if (
    normalizePathForComparison(windowsRoot) !==
    normalizePathForComparison(derivedRoot)
  ) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const system32 = realpathSync.native(join(windowsRoot, "System32"));
  const system32Metadata = lstatSync(system32);
  if (!system32Metadata.isDirectory() || system32Metadata.isSymbolicLink()) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const powershellDirectory = realpathSync.native(
    join(system32, "WindowsPowerShell", "v1.0")
  );
  const powershell = assertRegularCanonicalFile(
    join(powershellDirectory, "powershell.exe"),
    powershellDirectory,
    "powershell.exe"
  );
  const taskkill = assertRegularCanonicalFile(
    join(system32, "taskkill.exe"),
    system32,
    "taskkill.exe"
  );
  const commandInterpreter = assertRegularCanonicalFile(
    join(system32, "cmd.exe"),
    system32,
    "cmd.exe"
  );
  return Object.freeze({
    platform: "win32",
    windowsRoot,
    system32,
    powershellDirectory,
    powershell,
    taskkill,
    commandInterpreter,
  });
}

export function createPostgresHarnessEnvironment(
  sourceEnvironment = process.env,
  ownedRoot = join(tmpdir(), `${OWNED_ROOT_PREFIX}environment-contract`)
) {
  const trusted = resolveTrustedWindowsPlatform();
  const environment = {};
  if (trusted.platform === "win32") {
    const ownedTemporaryDirectory = join(ownedRoot, "temporary");
    environment.SYSTEMROOT = trusted.windowsRoot;
    environment.WINDIR = trusted.windowsRoot;
    environment.SYSTEMDRIVE = parse(trusted.windowsRoot).root.slice(0, 2);
    environment.COMSPEC = trusted.commandInterpreter;
    environment.PATH = [trusted.system32, trusted.powershellDirectory].join(";");
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    environment.OS = "Windows_NT";
    environment.TEMP = ownedTemporaryDirectory;
    environment.TMP = ownedTemporaryDirectory;
  }
  const forbiddenSourceValues = Object.entries(sourceEnvironment)
    .filter(([key, value]) => FORBIDDEN_CHILD_ENVIRONMENT_KEY.test(key) && value)
    .map(([, value]) => value);
  if (
    forbiddenSourceValues.some((value) =>
      Object.values(environment).includes(value)
    )
  ) {
    throw new Error("POSTGRES_HARNESS_ENVIRONMENT_SEPARATION_FAILED");
  }
  return environment;
}

export function validateWindowsUtilityAuthorityForTests(candidateRoot) {
  const trusted = resolveTrustedWindowsPlatform(candidateRoot);
  return {
    platform: trusted.platform,
    powershellBasename:
      trusted.platform === "win32" ? basename(trusted.powershell) : undefined,
    taskkillBasename:
      trusted.platform === "win32" ? basename(trusted.taskkill) : undefined,
  };
}

function assertSanitizedEnvironment(environment) {
  const keys = Object.keys(environment);
  if (
    keys.some((key) => !SAFE_OS_ENVIRONMENT_KEY_SET.has(key.toUpperCase())) ||
    keys.some((key) => FORBIDDEN_CHILD_ENVIRONMENT_KEY.test(key))
  ) {
    throw new Error("POSTGRES_HARNESS_ENVIRONMENT_REJECTED");
  }
}

function assertEnvironmentBoundToOwnedRoot(environment, root) {
  const temporary = valueForKey(environment, "TEMP");
  const temporaryAlias = valueForKey(environment, "TMP");
  if (
    !temporary ||
    temporary !== temporaryAlias ||
    !isAbsolute(temporary) ||
    !isPathWithin(root, temporary)
  ) {
    throw new Error("POSTGRES_HARNESS_TEMPORARY_ROOT_REJECTED");
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function cancelableDelay(milliseconds, value) {
  let timer;
  let settled = false;
  const promise = new Promise((resolveDelay) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveDelay(value);
    }, milliseconds);
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    },
  };
}

export async function waitForChildCloseWithTimeout(
  closePromise,
  milliseconds,
  timerFactory = cancelableDelay
) {
  const timeout = timerFactory(milliseconds, { timedOut: true });
  try {
    return await Promise.race([closePromise, timeout.promise]);
  } finally {
    timeout.cancel();
  }
}

async function withinDeadline(operation, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizePathForComparison(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathWithin(parent, child) {
  const normalizedParent = `${normalizePathForComparison(parent)}${process.platform === "win32" ? "\\" : "/"}`;
  return normalizePathForComparison(child).startsWith(normalizedParent);
}

function createCleanupDeadline(
  budgetMilliseconds = POSTGRES_HARNESS_TIMEOUTS.forcedCleanup,
  now = () => performance.now()
) {
  if (!Number.isFinite(budgetMilliseconds) || budgetMilliseconds <= 0) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_DEADLINE_INVALID");
  }
  const startedAt = now();
  const expiresAt = startedAt + budgetMilliseconds;
  return Object.freeze({
    startedAt,
    expiresAt,
    now,
    remaining() {
      return Math.max(0, expiresAt - now());
    },
  });
}

function remainingCleanupBudget(deadline) {
  const remaining = Math.floor(deadline.remaining());
  if (remaining <= 0) {
    throw new Error("POSTGRES_HARNESS_FORCED_CLEANUP_TIMEOUT");
  }
  return remaining;
}

export function runCleanupDeadlineContractForTests(
  stageCosts,
  budgetMilliseconds = Number(POSTGRES_HARNESS_TIMEOUTS.forcedCleanup)
) {
  let current = 0;
  let utilitySpawnCount = 0;
  let killCount = 0;
  const deadline = createCleanupDeadline(budgetMilliseconds, () => current);
  const remainingByStage = [];
  for (const stage of stageCosts) {
    const remaining = deadline.remaining();
    remainingByStage.push(remaining);
    if (remaining <= 0) break;
    if (stage.kind === "utility") utilitySpawnCount += 1;
    if (stage.kind === "kill") killCount += 1;
    current = Math.min(budgetMilliseconds, current + stage.duration);
  }
  return {
    elapsed: current,
    remainingByStage,
    utilitySpawnCount,
    killCount,
    expired: deadline.remaining() <= 0,
  };
}

function rootCreationIdentity(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    birthtimeMs: metadata.birthtimeMs,
  });
}

function sameCreationIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function captureOwnedRootIdentity(root, temporaryParent, occurrenceId) {
  if (!isAbsolute(root) || !OCCURRENCE_ID.test(occurrenceId)) {
    throw new Error("POSTGRES_HARNESS_ROOT_IDENTITY_INVALID");
  }
  const canonicalTemporaryParent = await realpath(temporaryParent);
  const canonicalRoot = await realpath(root);
  const metadata = await lstat(root);
  const forbiddenPaths = [
    canonicalTemporaryParent,
    await realpath(repositoryRoot),
    await realpath(homedir()),
    parse(canonicalRoot).root,
  ].map(normalizePathForComparison);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    normalizePathForComparison(dirname(canonicalRoot)) !==
      normalizePathForComparison(canonicalTemporaryParent) ||
    !basename(canonicalRoot).startsWith(OWNED_ROOT_PREFIX) ||
    forbiddenPaths.includes(normalizePathForComparison(canonicalRoot))
  ) {
    throw new Error("POSTGRES_HARNESS_ROOT_IDENTITY_INVALID");
  }
  return Object.freeze({
    temporaryParent: canonicalTemporaryParent,
    root: canonicalRoot,
    prefix: OWNED_ROOT_PREFIX,
    occurrenceId,
    creation: rootCreationIdentity(metadata),
  });
}

async function assertOwnedRootIdentity(identity) {
  const metadata = await lstat(identity.root);
  const canonicalRoot = await realpath(identity.root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    normalizePathForComparison(canonicalRoot) !==
      normalizePathForComparison(identity.root) ||
    normalizePathForComparison(dirname(canonicalRoot)) !==
      normalizePathForComparison(identity.temporaryParent) ||
    !basename(canonicalRoot).startsWith(identity.prefix) ||
    !sameCreationIdentity(rootCreationIdentity(metadata), identity.creation)
  ) {
    throw new Error("POSTGRES_HARNESS_ROOT_EXCHANGED");
  }
}

function assertOwnedChildPath(identity, path) {
  if (!isAbsolute(path) || !isPathWithin(identity.root, path)) {
    throw new Error("POSTGRES_HARNESS_ROOT_CHILD_REJECTED");
  }
}

async function removeOwnedTreeEntry(path, identity, deadline) {
  remainingCleanupBudget(deadline);
  await assertOwnedRootIdentity(identity);
  assertOwnedChildPath(identity, path);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("POSTGRES_HARNESS_REPARSE_ENTRY_REJECTED");
  }
  if (metadata.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) {
      await removeOwnedTreeEntry(join(path, entry), identity, deadline);
    }
    remainingCleanupBudget(deadline);
    await rmdir(path);
    return;
  }
  if (!metadata.isFile()) {
    throw new Error("POSTGRES_HARNESS_SPECIAL_ENTRY_REJECTED");
  }
  remainingCleanupBudget(deadline);
  await unlink(path);
}

async function safelyDeleteOwnedRoot(identity, deadline) {
  await assertOwnedRootIdentity(identity);
  for (const entry of await readdir(identity.root)) {
    await removeOwnedTreeEntry(join(identity.root, entry), identity, deadline);
  }
  remainingCleanupBudget(deadline);
  await assertOwnedRootIdentity(identity);
  await rmdir(identity.root);
  if (existsSync(identity.root)) {
    throw new Error("POSTGRES_HARNESS_ROOT_REMAINED");
  }
}

export async function runOwnedRootSafetyProbeForTests(kind) {
  if (!["root-exchange", "nested-link"].includes(kind)) {
    throw new Error("POSTGRES_HARNESS_ROOT_PROBE_REJECTED");
  }
  const temporaryParent = await realpath(tmpdir());
  const occurrenceId = randomUUID();
  const root = await mkdtemp(join(temporaryParent, OWNED_ROOT_PREFIX));
  const identity = await captureOwnedRootIdentity(
    root,
    temporaryParent,
    occurrenceId
  );
  const sentinel = await mkdtemp(join(temporaryParent, "actustube-unrelated-"));
  const sentinelMarker = join(sentinel, "sentinel.txt");
  await writeFile(sentinelMarker, "preserve", { encoding: "utf8", flag: "wx" });
  let rejected = false;
  try {
    if (kind === "root-exchange") {
      const preservedRoot = `${root}-preserved`;
      await rename(root, preservedRoot);
      await symlink(sentinel, root, process.platform === "win32" ? "junction" : "dir");
      try {
        await assertOwnedRootIdentity(identity);
      } catch (error) {
        rejected = error?.message === "POSTGRES_HARNESS_ROOT_EXCHANGED";
      } finally {
        await rmdir(root);
        await rename(preservedRoot, root);
      }
    } else {
      const link = join(root, "nested-link");
      await symlink(sentinel, link, process.platform === "win32" ? "junction" : "dir");
      try {
        await safelyDeleteOwnedRoot(identity, createCleanupDeadline());
      } catch (error) {
        rejected = error?.message === "POSTGRES_HARNESS_REPARSE_ENTRY_REJECTED";
      } finally {
        await rmdir(link);
      }
    }
    const sentinelMaintained =
      (await readFile(sentinelMarker, "utf8")) === "preserve";
    await safelyDeleteOwnedRoot(identity, createCleanupDeadline());
    await unlink(sentinelMarker);
    await rmdir(sentinel);
    return {
      rejected,
      sentinelMaintained,
      ownedRootRemaining: existsSync(root),
    };
  } catch (error) {
    if (existsSync(root)) {
      try {
        await safelyDeleteOwnedRoot(identity, createCleanupDeadline());
      } catch {
        // Preserve an unknown or exchanged root for fail-closed inspection.
      }
    }
    throw error;
  }
}

function createTrustedUtilityEnvironment() {
  const trusted = resolveTrustedWindowsPlatform();
  if (trusted.platform !== "win32") return {};
  const trustedTemporary = realpathSync.native(join(trusted.windowsRoot, "Temp"));
  return {
    SYSTEMROOT: trusted.windowsRoot,
    WINDIR: trusted.windowsRoot,
    SYSTEMDRIVE: parse(trusted.windowsRoot).root.slice(0, 2),
    COMSPEC: trusted.commandInterpreter,
    PATH: [trusted.system32, trusted.powershellDirectory].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    OS: "Windows_NT",
    TEMP: trustedTemporary,
    TMP: trustedTemporary,
  };
}

export async function allocatePostgresHarnessPort(environment) {
  if (process.platform === "win32") {
    const utilityEnvironment = environment || createTrustedUtilityEnvironment();
    assertSanitizedEnvironment(utilityEnvironment);
    const source = String.raw`
$ErrorActionPreference = 'Stop'
$address = [System.Net.IPAddress]::Parse('127.0.0.1')
$listener = [System.Net.Sockets.TcpListener]::new($address, 0)
try {
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  if ($port -lt 1 -or $port -gt 65535) { throw 'PORT_RANGE_INVALID' }
  [Console]::Out.Write($port)
} finally {
  $listener.Stop()
}
`;
    const output = runTrustedPowerShell(
      source,
      utilityEnvironment,
      undefined,
      "POSTGRES_HARNESS_PORT_INVALID"
    );
    const port = Number(output.trim());
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("POSTGRES_HARNESS_PORT_INVALID");
    }
    return port;
  }
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("POSTGRES_HARNESS_PORT_INVALID");
  }
  return port;
}

async function isPortReleased(port) {
  const server = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", resolveListen);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid, deadline) {
  while (isProcessAlive(pid) && deadline.remaining() > 0) {
    await delay(Math.min(50, Math.max(1, Math.floor(deadline.remaining()))));
  }
  return !isProcessAlive(pid);
}

async function waitForPortRelease(port, deadline) {
  while (deadline.remaining() > 0) {
    if (await isPortReleased(port)) return true;
    await delay(Math.min(50, Math.max(1, Math.floor(deadline.remaining()))));
  }
  return isPortReleased(port);
}

function assertPositivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("POSTGRES_HARNESS_PID_INVALID");
  }
}

function runTrustedPowerShell(source, environment, deadline, errorCode) {
  const trusted = resolveTrustedWindowsPlatform();
  if (trusted.platform !== "win32") {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const timeout = deadline ? remainingCleanupBudget(deadline) : 5_000;
  const result = spawnSync(
    trusted.powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
    {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout,
      windowsHide: true,
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    const error = new Error(errorCode);
    error.utilityStatus = result.status;
    throw error;
  }
  if (result.stderr.trim() !== "") {
    throw new Error(errorCode);
  }
  return result.stdout;
}

function queryWindowsProcessIdentity(pid, environment, deadline) {
  assertPositivePid(pid);
  if (process.platform !== "win32") {
    return Object.freeze({
      pid,
      parentPid: pid === process.pid ? process.ppid : undefined,
      creationIdentity: "unsupported-platform",
      executablePath: realpathSync.native(process.execPath),
    });
  }
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]${pid}
$candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
if ($null -eq $candidate) { [Console]::Out.Write('absent'); exit 0 }
$identity = [ordered]@{
  pid = [int]$candidate.ProcessId
  parentPid = [int]$candidate.ParentProcessId
  creationIdentity = [string]$candidate.CreationDate.ToUniversalTime().Ticks
  executablePath = [string]$candidate.ExecutablePath
}
[Console]::Out.Write(($identity | ConvertTo-Json -Compress))
`;
  const output = runTrustedPowerShell(
    source,
    environment,
    deadline,
    "POSTGRES_HARNESS_PROCESS_IDENTITY_UNAVAILABLE"
  );
  if (output === "absent") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("POSTGRES_HARNESS_PROCESS_IDENTITY_INVALID");
  }
  if (
    parsed.pid !== pid ||
    !Number.isSafeInteger(parsed.parentPid) ||
    parsed.parentPid <= 0 ||
    !/^\d+$/.test(parsed.creationIdentity || "") ||
    !isAbsolute(parsed.executablePath || "")
  ) {
    throw new Error("POSTGRES_HARNESS_PROCESS_IDENTITY_INVALID");
  }
  const executablePath = realpathSync.native(parsed.executablePath);
  return Object.freeze({
    pid,
    parentPid: parsed.parentPid,
    creationIdentity: parsed.creationIdentity,
    executablePath,
  });
}

function processIdentityMatches(expected, observed) {
  return Boolean(
    expected &&
      observed &&
      expected.pid === observed.pid &&
      expected.parentPid === observed.parentPid &&
      expected.creationIdentity === observed.creationIdentity &&
      normalizePathForComparison(expected.executablePath) ===
        normalizePathForComparison(observed.executablePath)
  );
}

export function evaluateHarnessTerminationIdentityForTests({
  childState,
  expected,
  observed,
  occurrenceId,
  ipcOccurrenceId,
}) {
  if (
    childState?.pid !== expected?.pid ||
    childState?.exitCode !== null ||
    childState?.signalCode !== null ||
    childState?.closed === true ||
    occurrenceId !== ipcOccurrenceId
  ) {
    return false;
  }
  return processIdentityMatches(expected, observed);
}

export function invokeTerminationOnlyForExactIdentityForTests(
  contract,
  terminate
) {
  if (!evaluateHarnessTerminationIdentityForTests(contract)) return false;
  terminate();
  return true;
}

function terminateExactProcessTree(pid, environment, deadline) {
  assertPositivePid(pid);
  if (!isProcessAlive(pid)) return false;
  if (process.platform === "win32") {
    const trusted = resolveTrustedWindowsPlatform();
    const result = spawnSync(trusted.taskkill, ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: remainingCleanupBudget(deadline),
      windowsHide: true,
    });
    if (result.error || result.signal || ![0, 128].includes(result.status)) {
      throw new Error("POSTGRES_HARNESS_FORCED_CLEANUP_FAILED");
    }
    return true;
  }
  remainingCleanupBudget(deadline);
  process.kill(pid, "SIGKILL");
  return true;
}

async function readLifecycleState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function validateLifecycleState(state, ownership) {
  if (!state || typeof state !== "object") return undefined;
  if (
    state.schemaVersion !== RESULT_SCHEMA_VERSION ||
    state.occurrenceId !== ownership.occurrenceId ||
    state.harnessPid !== ownership.harnessPid ||
    state.parentPid !== ownership.parentPid ||
    normalizePathForComparison(state.root) !==
      normalizePathForComparison(ownership.root) ||
    normalizePathForComparison(state.dataDirectory) !==
      normalizePathForComparison(ownership.dataDirectory) ||
    state.port !== ownership.port ||
    !Array.isArray(state.phaseSequence) ||
    !Array.isArray(state.ownedProcesses)
  ) {
    throw new Error("POSTGRES_HARNESS_OWNERSHIP_MISMATCH");
  }
  for (const entry of state.ownedProcesses) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.pid) ||
      entry.pid <= 0 ||
      !Number.isSafeInteger(entry.parentPid) ||
      entry.parentPid <= 0 ||
      typeof entry.creationIdentity !== "string" ||
      !isAbsolute(entry.executablePath || "") ||
      !["postgres", "fault-worker"].includes(entry.role)
    ) {
      throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_INVALID");
    }
  }
  return state;
}

function exactProcessIdentityFromState(entry) {
  return {
    pid: entry.pid,
    parentPid: entry.parentPid,
    creationIdentity: entry.creationIdentity,
    executablePath: entry.executablePath,
  };
}

async function cleanupOwnedHarness(
  ownership,
  lastState,
  environment,
  child,
  closePromise
) {
  const deadline = createCleanupDeadline();
  await assertOwnedRootIdentity(ownership.rootIdentity);
  const state = validateLifecycleState(lastState, ownership);
  const ownedProcesses = state?.ownedProcesses || [];
  assertEnvironmentBoundToOwnedRoot(environment, ownership.rootIdentity.root);
  if (!runCleanupEnvironmentProbe(environment, deadline)) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_ENVIRONMENT_REJECTED");
  }

  if (
    child.exitCode === null &&
    child.signalCode === null &&
    isProcessAlive(ownership.harnessPid)
  ) {
    const observedHarness = queryWindowsProcessIdentity(
      ownership.harnessPid,
      environment,
      deadline
    );
    if (
      !evaluateHarnessTerminationIdentityForTests({
        childState: {
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          closed: ownership.childClosed,
        },
        expected: ownership.harnessIdentity,
        observed: observedHarness,
        occurrenceId: ownership.occurrenceId,
        ipcOccurrenceId: ownership.ipcOccurrenceId,
      })
    ) {
      throw new Error("POSTGRES_HARNESS_PROCESS_GENERATION_MISMATCH");
    }
    terminateExactProcessTree(ownership.harnessPid, environment, deadline);
  }
  if (!(await waitForProcessExit(ownership.harnessPid, deadline))) {
    throw new Error("POSTGRES_HARNESS_PROCESS_REMAINED");
  }
  await waitForChildCloseWithTimeout(
    closePromise,
    Math.min(1_000, remainingCleanupBudget(deadline))
  );
  for (const entry of ownedProcesses) {
    if (isProcessAlive(entry.pid)) {
      const observed = queryWindowsProcessIdentity(entry.pid, environment, deadline);
      if (!processIdentityMatches(exactProcessIdentityFromState(entry), observed)) {
        throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_GENERATION_MISMATCH");
      }
      terminateExactProcessTree(entry.pid, environment, deadline);
    }
    if (!(await waitForProcessExit(entry.pid, deadline))) {
      throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_REMAINED");
    }
  }
  if (!(await waitForPortRelease(ownership.port, deadline))) {
    throw new Error("POSTGRES_HARNESS_LISTENER_REMAINED");
  }
  await safelyDeleteOwnedRoot(ownership.rootIdentity, deadline);
  return { result: "complete", remainingMilliseconds: deadline.remaining() };
}

function parseChildOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`POSTGRES_HARNESS_OUTPUT_INVALID_${lines.length}`);
  }
  const result = JSON.parse(lines[0]);
  if (
    !result ||
    result.schemaVersion !== RESULT_SCHEMA_VERSION ||
    !["pass", "fail"].includes(result.outcome)
  ) {
    throw new Error("POSTGRES_HARNESS_RESULT_INVALID");
  }
  return result;
}

export async function runOwnedPostgresHarness({
  mode = "integration",
  sourceEnvironment = process.env,
  protocolFault = "none",
  faultControl = "none",
} = {}) {
  if (!HARNESS_MODES.includes(mode)) {
    throw new Error("POSTGRES_HARNESS_MODE_REJECTED");
  }
  if (
    !["none", "wrong-token", "duplicate-init", "unknown-init-key"].includes(
      protocolFault
    )
  ) {
    throw new Error("POSTGRES_HARNESS_PROTOCOL_FAULT_REJECTED");
  }
  if (!["none", "early-failure"].includes(faultControl)) {
    throw new Error("POSTGRES_HARNESS_FAULT_CONTROL_REJECTED");
  }

  const temporaryParent = await realpath(tmpdir());
  const occurrenceId = randomUUID();
  const capabilityToken = randomUUID();
  const root = await mkdtemp(join(temporaryParent, OWNED_ROOT_PREFIX));
  const rootIdentity = await captureOwnedRootIdentity(
    root,
    temporaryParent,
    occurrenceId
  );
  const dataDirectory = join(root, "database");
  const statePath = join(root, LIFECYCLE_FILE);
  const claimPath = join(root, ROOT_CLAIM_FILE);
  await assertOwnedRootIdentity(rootIdentity);
  await writeFile(
    claimPath,
    JSON.stringify({
      schemaVersion: ROOT_CLAIM_SCHEMA_VERSION,
      occurrenceId,
      capabilitySha256: createHash("sha256")
        .update(capabilityToken)
        .digest("hex"),
      creation: rootIdentity.creation,
    }),
    { encoding: "utf8", flag: "wx" }
  );
  await assertOwnedRootIdentity(rootIdentity);
  await mkdir(join(root, "temporary"), { recursive: false });
  const environment = createPostgresHarnessEnvironment(
    sourceEnvironment,
    rootIdentity.root
  );
  assertSanitizedEnvironment(environment);
  const port = await allocatePostgresHarnessPort(environment);
  const child = spawn(process.execPath, [modulePath, "--ipc-child"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error("POSTGRES_HARNESS_PID_UNAVAILABLE");
  const harnessIdentity = queryWindowsProcessIdentity(child.pid, environment);
  if (
    !harnessIdentity ||
    harnessIdentity.parentPid !== process.pid ||
    normalizePathForComparison(harnessIdentity.executablePath) !==
      normalizePathForComparison(realpathSync.native(process.execPath))
  ) {
    throw new Error("POSTGRES_HARNESS_SPAWN_IDENTITY_MISMATCH");
  }
  const ownership = {
    occurrenceId,
    harnessPid: child.pid,
    parentPid: process.pid,
    root,
    dataDirectory,
    port,
    rootIdentity,
    harnessIdentity,
    ipcOccurrenceId: undefined,
    childClosed: false,
  };
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-1_000_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1_000_000);
  });
  let closed;
  const closePromise = new Promise((resolveClose) => {
    child.once("error", () => resolveClose({ code: null, signal: "error" }));
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  }).then((value) => {
    closed = value;
    ownership.childClosed = true;
    return value;
  });

  const ackPromise = new Promise((resolveAck, rejectAck) => {
    const timer = setTimeout(
      () => rejectAck(new Error("POSTGRES_HARNESS_IPC_ACK_TIMEOUT")),
      5_000
    );
    child.once("message", (message) => {
      clearTimeout(timer);
      if (
        !message ||
        Object.keys(message).sort().join(",") !==
          "occurrenceId,schemaVersion,type" ||
        message.schemaVersion !== IPC_SCHEMA_VERSION ||
        message.type !== "harness-init-accepted" ||
        message.occurrenceId !== occurrenceId
      ) {
        rejectAck(new Error("POSTGRES_HARNESS_IPC_ACK_INVALID"));
        return;
      }
      ownership.ipcOccurrenceId = message.occurrenceId;
      resolveAck();
    });
    child.once("close", () => {
      clearTimeout(timer);
      rejectAck(new Error("POSTGRES_HARNESS_IPC_REJECTED"));
    });
  });
  const initMessage = {
    schemaVersion: IPC_SCHEMA_VERSION,
    type: "harness-init",
    occurrenceId,
    capabilityToken:
      protocolFault === "wrong-token" ? randomUUID() : capabilityToken,
    mode,
    faultControl,
    port,
    parentPid: process.pid,
    rootIdentity,
  };
  if (protocolFault === "unknown-init-key") initMessage.unknown = true;
  child.send(initMessage);
  if (protocolFault === "duplicate-init") child.send(initMessage);

  const executionTimeout =
    mode === "integration"
      ? POSTGRES_HARNESS_TIMEOUTS.initialise +
        POSTGRES_HARNESS_TIMEOUTS.startSpawn +
        POSTGRES_HARNESS_TIMEOUTS.ready +
        POSTGRES_HARNESS_TIMEOUTS.testExecution +
        POSTGRES_HARNESS_TIMEOUTS.stop
      : POSTGRES_HARNESS_TIMEOUTS.faultPhase;
  const executionDeadline = performance.now() + executionTimeout;
  let state;
  let cleanupAttempted = false;
  let cleanupResult = "not_required";
  try {
    await ackPromise;
    while (!closed && performance.now() < executionDeadline) {
      await assertOwnedRootIdentity(rootIdentity);
      const candidate = await readLifecycleState(statePath);
      if (candidate) state = validateLifecycleState(candidate, ownership);
      if (state?.phase === "cleanup_required") break;
      await delay(50);
    }
    if (
      !closed &&
      (state?.phase === "cleanup_required" ||
        performance.now() >= executionDeadline)
    ) {
      cleanupAttempted = true;
      const cleanup = await cleanupOwnedHarness(
        ownership,
        state,
        environment,
        child,
        closePromise
      );
      cleanupResult = cleanup.result;
    } else {
      await closePromise;
    }
    if (!cleanupAttempted) {
      const finalCandidate = await readLifecycleState(statePath);
      if (finalCandidate) state = validateLifecycleState(finalCandidate, ownership);
    }

    if (mode !== "integration") {
      if (!cleanupAttempted) {
        cleanupAttempted = true;
        const cleanup = await cleanupOwnedHarness(
          ownership,
          state,
          environment,
          child,
          closePromise
        );
        cleanupResult = cleanup.result;
      }
      const contract = FAULT_CONTRACTS[mode];
      if (
        faultControl !== "none" ||
        !contract ||
        state?.intendedFaultReached !== true ||
        state?.terminalReason !== contract.terminalReason ||
        JSON.stringify(state.phaseSequence) !== JSON.stringify(contract.phases)
      ) {
        throw new Error("POSTGRES_HARNESS_FAULT_ORACLE_REJECTED");
      }
      return {
        schemaVersion: RESULT_SCHEMA_VERSION,
        occurrenceId,
        mode,
        phaseSequence: state.phaseSequence,
        intendedFaultReached: true,
        terminalReason: state.terminalReason,
        environmentIsolation: {
          sourceSeparated: true,
          cleanupProbe: true,
          temporaryRootOwned: true,
        },
        cleanup: { attempted: cleanupAttempted, result: cleanupResult },
        residue: {
          process: isProcessAlive(ownership.harnessPid) ? 1 : 0,
          listener: (await isPortReleased(port)) ? 0 : 1,
          directory: existsSync(root) ? 1 : 0,
        },
      };
    }

    if (closed?.code !== 0 || closed?.signal) {
      throw new Error("POSTGRES_HARNESS_INTEGRATION_CHILD_FAILED");
    }
    const result = parseChildOutput(stdout);
    if (result.occurrenceId !== occurrenceId || result.mode !== mode) {
      throw new Error("POSTGRES_HARNESS_RESULT_OWNERSHIP_MISMATCH");
    }
    if (!(await isPortReleased(port))) {
      throw new Error("POSTGRES_HARNESS_NORMAL_CLEANUP_INCOMPLETE");
    }
    cleanupAttempted = true;
    const cleanup = await cleanupOwnedHarness(
      ownership,
      state,
      environment,
      child,
      closePromise
    );
    cleanupResult = cleanup.result;
    return {
      ...result,
      cleanup: { attempted: cleanupAttempted, result: cleanupResult },
      residue: { process: 0, listener: 0, directory: 0 },
      stderrObserved: stderr.length > 0,
    };
  } finally {
    if (!cleanupAttempted && existsSync(root)) {
      if (!closed) {
        await waitForChildCloseWithTimeout(closePromise, 1_000);
      }
      const candidate = await readLifecycleState(statePath);
      await cleanupOwnedHarness(
        ownership,
        candidate || state,
        environment,
        child,
        closePromise
      );
    }
  }
}

async function receiveChildConfiguration() {
  if (
    process.argv.slice(2).length !== 1 ||
    process.argv[2] !== "--ipc-child" ||
    typeof process.send !== "function" ||
    !process.connected
  ) {
    throw new Error("POSTGRES_HARNESS_IPC_REQUIRED");
  }
  return await new Promise((resolveConfiguration, rejectConfiguration) => {
    let accepted = false;
    let settleTimer;
    const initTimer = setTimeout(
      () => rejectConfiguration(new Error("POSTGRES_HARNESS_IPC_INIT_TIMEOUT")),
      5_000
    );
    const reject = (code) => {
      clearTimeout(initTimer);
      if (settleTimer) clearTimeout(settleTimer);
      rejectConfiguration(new Error(code));
    };
    const onMessage = async (message) => {
      if (accepted) {
        reject("POSTGRES_HARNESS_IPC_DUPLICATE_INIT");
        return;
      }
      const expectedKeys = [
        "capabilityToken",
        "faultControl",
        "mode",
        "occurrenceId",
        "parentPid",
        "port",
        "rootIdentity",
        "schemaVersion",
        "type",
      ];
      if (
        !message ||
        Object.keys(message).sort().join(",") !== expectedKeys.sort().join(",") ||
        message.schemaVersion !== IPC_SCHEMA_VERSION ||
        message.type !== "harness-init" ||
        !HARNESS_MODES.includes(message.mode) ||
        !["none", "early-failure"].includes(message.faultControl) ||
        !OCCURRENCE_ID.test(message.occurrenceId || "") ||
        typeof message.capabilityToken !== "string" ||
        !Number.isSafeInteger(message.port) ||
        message.port < 1 ||
        message.port > 65_535 ||
        message.parentPid !== process.ppid
      ) {
        reject("POSTGRES_HARNESS_IPC_INIT_REJECTED");
        return;
      }
      accepted = true;
      try {
        await assertOwnedRootIdentity(message.rootIdentity);
        if (message.rootIdentity.occurrenceId !== message.occurrenceId) {
          throw new Error("POSTGRES_HARNESS_ROOT_OCCURRENCE_MISMATCH");
        }
        const claim = JSON.parse(
          await readFile(join(message.rootIdentity.root, ROOT_CLAIM_FILE), "utf8")
        );
        const expectedCapability = createHash("sha256")
          .update(message.capabilityToken)
          .digest("hex");
        if (
          claim.schemaVersion !== ROOT_CLAIM_SCHEMA_VERSION ||
          claim.occurrenceId !== message.occurrenceId ||
          claim.capabilitySha256 !== expectedCapability ||
          !sameCreationIdentity(claim.creation, message.rootIdentity.creation)
        ) {
          throw new Error("POSTGRES_HARNESS_ROOT_CLAIM_REJECTED");
        }
      } catch {
        reject("POSTGRES_HARNESS_ROOT_CLAIM_REJECTED");
        return;
      }
      settleTimer = setTimeout(() => {
        clearTimeout(initTimer);
        process.off("message", onMessage);
        process.send({
          schemaVersion: IPC_SCHEMA_VERSION,
          type: "harness-init-accepted",
          occurrenceId: message.occurrenceId,
        });
        resolveConfiguration({
          mode: message.mode,
          faultControl: message.faultControl,
          occurrenceId: message.occurrenceId,
          root: message.rootIdentity.root,
          rootIdentity: message.rootIdentity,
          dataDirectory: join(message.rootIdentity.root, "database"),
          statePath: join(message.rootIdentity.root, LIFECYCLE_FILE),
          port: message.port,
          parentPid: message.parentPid,
        });
      }, 25);
    };
    process.on("message", onMessage);
  });
}

async function createStateWriter(configuration) {
  await assertOwnedRootIdentity(configuration.rootIdentity);
  const state = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    occurrenceId: configuration.occurrenceId,
    harnessPid: process.pid,
    parentPid: configuration.parentPid,
    root: configuration.root,
    dataDirectory: configuration.dataDirectory,
    port: configuration.port,
    phase: "created",
    phaseSequence: ["created"],
    intendedFaultReached: false,
    terminalReason: null,
    ownedProcesses: [],
  };
  const writeState = async (patch = {}) => {
    await assertOwnedRootIdentity(configuration.rootIdentity);
    if (
      typeof patch.phase === "string" &&
      patch.phase !== state.phase
    ) {
      state.phaseSequence.push(patch.phase);
    }
    Object.assign(state, patch);
    const temporaryPath = `${configuration.statePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state), {
      encoding: "utf8",
      flag: "w",
    });
    await rename(temporaryPath, configuration.statePath);
    await assertOwnedRootIdentity(configuration.rootIdentity);
  };
  await writeState();
  return { state, writeState };
}

function runCleanupEnvironmentProbe(environment, deadline) {
  const source = `const forbidden=${FORBIDDEN_CHILD_ENVIRONMENT_KEY.toString()};const keys=Object.keys(process.env);const allowed=new Set(${JSON.stringify(SAFE_OS_ENVIRONMENT_KEYS)});const temp=process.env.TEMP||'';const tmp=process.env.TMP||'';const pass=keys.every(k=>allowed.has(k.toUpperCase())&&!forbidden.test(k))&&temp===tmp&&temp.length>0;process.stdout.write(pass?'pass':'fail');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: environment,
    shell: false,
    timeout: deadline ? remainingCleanupBudget(deadline) : 5_000,
    windowsHide: true,
  });
  return (
    !result.error &&
    !result.signal &&
    result.status === 0 &&
    result.stdout === "pass" &&
    result.stderr === ""
  );
}

async function waitForClusterProcess(cluster, stateWriter) {
  const deadline = Date.now() + POSTGRES_HARNESS_TIMEOUTS.startSpawn;
  while (Date.now() < deadline) {
    const pid = cluster.process?.pid;
    if (Number.isSafeInteger(pid) && pid > 0) {
      const identity = queryWindowsProcessIdentity(pid, process.env);
      if (!identity || identity.parentPid !== process.pid) {
        throw new Error("POSTGRES_HARNESS_POSTMASTER_IDENTITY_MISMATCH");
      }
      stateWriter.state.ownedProcesses = [
        { ...identity, role: "postgres" },
      ];
      await stateWriter.writeState({ phase: "start_spawned" });
      return pid;
    }
    await delay(20);
  }
  throw new Error("POSTGRES_HARNESS_START_SPAWN_TIMEOUT");
}

function sameSql(left, right) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  return normalize(left) === normalize(right);
}

function createEmbeddedPreflightAdapter(cluster, database) {
  return {
    async connect() {
      const client = cluster.getPgClient(database, "127.0.0.1");
      await client.connect();
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

async function semanticPreflightEnvironment(cluster, database, configuration) {
  const client = cluster.getPgClient(database, "127.0.0.1");
  await client.connect();
  try {
    const version = await client.query(PREFLIGHT_SQL_FOR_TESTS.serverVersion);
    const extensions = await client.query(
      PREFLIGHT_SQL_FOR_TESTS.extensionInventory
    );
    const user = "preflight_semantic_admin";
    const password = configuration.password;
    const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${configuration.port}/${database}`;
    return {
      versionNumber: String(version.rows[0]?.server_version_num ?? ""),
      environment: {
        ACTUSTUBE_DB_ENV: "staging",
        ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "1",
        DIRECT_DATABASE_URL: url,
        DATABASE_URL: url,
        ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "local-postflight-fixture",
        ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
          schemaVersion: 1,
          extensions: extensions.rows,
        }),
      },
    };
  } finally {
    await client.end();
  }
}

async function withDatabase(cluster, operation) {
  const database = `preflight_${randomUUID().replaceAll("-", "")}`;
  if (!SAFE_IDENTIFIER.test(database)) throw new Error("POSTGRES_HARNESS_DATABASE_INVALID");
  const admin = cluster.getPgClient("postgres", "127.0.0.1");
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  try {
    return await operation(database);
  } finally {
    const cleanup = cluster.getPgClient("postgres", "127.0.0.1");
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE "${database}"`);
    } finally {
      await cleanup.end();
    }
  }
}

async function queryExtensionClassification(cluster, { managed, residual }) {
  const client = cluster.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  try {
    const managedSql = managed
      ? "SELECT 'pg_class'::pg_catalog.regclass::oid, 90001::oid, 0"
      : "SELECT 0::oid, 0::oid, 0 WHERE false";
    const residualSql = residual
      ? "SELECT 'relation'::text, 'pg_class'::pg_catalog.regclass::oid, 90001::oid, 0"
      : "SELECT ''::text, 0::oid, 0::oid, 0 WHERE false";
    const result = await client.query(`
      WITH extension_classification(
        object_signature, evidence_signature, evidence_kind, dependency_type,
        dependent_class, referenced_class, referenced_is_direct_extension_member,
        rule_name, relation_kind, trigger_constraint_matches, constraint_type
      ) AS (
        VALUES (
          '1259:90001:0'::text,
          'dependency:1259:90001:0:fixture'::text,
          'dependency'::text, 'e'::text, 'pg_class'::text, 'pg_extension'::text,
          false, NULL::text, NULL::text, false, NULL::text
        )
      ), extension_managed(classid, objid, objsubid) AS (
        ${managedSql}
      ), residual_objects(kind, classid, objid, objsubid) AS (
        ${residualSql}
      ), ${PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS}
      SELECT
        (SELECT count(*)::integer FROM extension_dependency_evidence) AS evidence_count,
        (SELECT count(*)::integer FROM extension_dependency_evidence WHERE classification_count = 0) AS unclassified_count,
        (SELECT count(*)::integer FROM extension_dependency_evidence WHERE classification_count > 1) AS ambiguous_count,
        (SELECT min(classification_count)::integer FROM extension_dependency_evidence) AS classification_count,
        (SELECT count(*)::integer FROM extension_classification_complete WHERE evidence_kind = 'dependency') AS complete_dependency_count
    `);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function runIntegration(cluster, configuration) {
  const stable = await withDatabase(cluster, async (database) => {
    const setup = cluster.getPgClient(database, "127.0.0.1");
    await setup.connect();
    try {
      await setup.query("CREATE SCHEMA drizzle");
      await setup.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
    } finally {
      await setup.end();
    }
    const { environment, versionNumber } = await semanticPreflightEnvironment(
      cluster,
      database,
      configuration
    );
    const statements = [];
    const report = await verifyStagingDatabasePreflight({
      environment,
      repositoryRoot,
      adapter: createEmbeddedPreflightAdapter(cluster, database),
      allowLoopback: true,
      onQuery: (statement) => statements.push(statement),
    });
    const queryCounts = Object.fromEntries(
      [
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
      ].map((name) => [
        name,
        statements.filter((statement) =>
          sameSql(statement, PREFLIGHT_SQL_FOR_TESTS[name])
        ).length,
      ])
    );
    return {
      versionNumber,
      report: {
        exitCode: report.exitCode,
        overallStatus: report.overallStatus,
        initialState: report.initialState,
        connectionAuthority: report.connectionAuthority,
        directPooledIdentity: report.directPooledIdentity,
        databaseRoleIdentity: report.databaseRoleIdentity,
        extensionInventory: report.extensionInventory,
        migrationCatalog: report.migrationCatalog,
        readOnlyInvariant: report.readOnlyInvariant,
        beforeAfterComparison: report.beforeAfterComparison,
        cleanup: report.cleanup,
      },
      queryCounts,
      beginCount: statements.filter((statement) =>
        sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.begin)
      ).length,
      rollbackCount: statements.filter((statement) =>
        sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback)
      ).length,
    };
  });

  const drift = await withDatabase(cluster, async (database) => {
    const { environment, versionNumber } = await semanticPreflightEnvironment(
      cluster,
      database,
      configuration
    );
    let thirdSessionWrites = 0;
    const report = await verifyStagingDatabasePreflight({
      environment,
      repositoryRoot,
      adapter: createEmbeddedPreflightAdapter(cluster, database),
      allowLoopback: true,
      betweenSnapshotTransactions: async () => {
        const thirdSession = cluster.getPgClient(database, "127.0.0.1");
        await thirdSession.connect();
        try {
          await thirdSession.query(
            "CREATE TABLE public.preflight_mvcc_drift (id integer)"
          );
          thirdSessionWrites += 1;
        } finally {
          await thirdSession.end();
        }
      },
    });
    return {
      versionNumber,
      thirdSessionWrites,
      exitCode: report.exitCode,
      overallStatus: report.overallStatus,
      beforeAfterComparison: report.beforeAfterComparison,
      failure: report.failure,
      cleanup: report.cleanup,
    };
  });

  const extensionClassifications = [];
  for (const values of [
    { managed: true, residual: false },
    { managed: false, residual: true },
    { managed: false, residual: false },
    { managed: true, residual: true },
  ]) {
    extensionClassifications.push({
      ...values,
      result: await queryExtensionClassification(cluster, values),
    });
  }
  return { stable, drift, extensionClassifications };
}

async function spawnFaultWorker(configuration, stateWriter) {
  await assertOwnedRootIdentity(configuration.rootIdentity);
  const source = `import {createServer} from 'node:net';const forbidden=${FORBIDDEN_CHILD_ENVIRONMENT_KEY.toString()};const allowed=new Set(${JSON.stringify(SAFE_OS_ENVIRONMENT_KEYS)});const environmentIsolated=Object.keys(process.env).every(k=>allowed.has(k.toUpperCase())&&!forbidden.test(k));const server=createServer();server.listen(Number(process.argv[1]),'127.0.0.1',()=>{process.stdout.write(JSON.stringify({pid:process.pid,ppid:process.ppid,environmentIsolated})+'\\n')});setInterval(()=>{},1000);`;
  const worker = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, String(configuration.port)],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }
  );
  const message = await withinDeadline(
    () =>
      new Promise((resolveMessage, rejectMessage) => {
        let buffer = "";
        worker.stdout.setEncoding("utf8");
        worker.stdout.on("data", (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          try {
            resolveMessage(JSON.parse(buffer.slice(0, newline)));
          } catch {
            rejectMessage(new Error("POSTGRES_HARNESS_FAULT_WORKER_INVALID"));
          }
        });
        worker.once("error", rejectMessage);
        worker.once("close", () =>
          rejectMessage(new Error("POSTGRES_HARNESS_FAULT_WORKER_EXITED"))
        );
      }),
    5_000,
    "POSTGRES_HARNESS_FAULT_WORKER_TIMEOUT"
  );
  if (
    message.pid !== worker.pid ||
    message.ppid !== process.pid ||
    message.environmentIsolated !== true
  ) {
    throw new Error("POSTGRES_HARNESS_FAULT_WORKER_OWNERSHIP_MISMATCH");
  }
  const identity = queryWindowsProcessIdentity(worker.pid, process.env);
  if (!identity || identity.parentPid !== process.pid) {
    throw new Error("POSTGRES_HARNESS_FAULT_WORKER_GENERATION_MISMATCH");
  }
  stateWriter.state.ownedProcesses = [
    { ...identity, role: "fault-worker" },
  ];
  await stateWriter.writeState({ phase: "start_spawned" });
  return worker;
}

async function runChild(configuration) {
  assertSanitizedEnvironment(process.env);
  await assertOwnedRootIdentity(configuration.rootIdentity);
  assertEnvironmentBoundToOwnedRoot(process.env, configuration.rootIdentity.root);
  const stateWriter = await createStateWriter(configuration);
  const cleanupChildEnvironmentIsolated = runCleanupEnvironmentProbe(process.env);
  if (!cleanupChildEnvironmentIsolated) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_ENVIRONMENT_REJECTED");
  }

  if (configuration.mode !== "integration") {
    if (configuration.faultControl === "early-failure") {
      await stateWriter.writeState({
        phase: "early_control_failure",
        terminalReason: "CONTROLLED_EARLY_FAILURE",
      });
      throw new Error("POSTGRES_HARNESS_CONTROLLED_EARLY_FAILURE");
    }
    await spawnFaultWorker(configuration, stateWriter);
    if (configuration.mode === "ready_hang") {
      await stateWriter.writeState({
        phase: "ready_pending",
        intendedFaultReached: true,
        terminalReason: FAULT_CONTRACTS.ready_hang.terminalReason,
      });
      return new Promise(() => undefined);
    }
    if (configuration.mode === "stop_hang") {
      await stateWriter.writeState({ phase: "ready" });
      await stateWriter.writeState({
        phase: "stopping",
        intendedFaultReached: true,
        terminalReason: FAULT_CONTRACTS.stop_hang.terminalReason,
      });
      return new Promise(() => undefined);
    }
    if (configuration.mode === "partial_start_throw") {
      await stateWriter.writeState({
        phase: "partial_start_failure",
        intendedFaultReached: true,
        terminalReason: FAULT_CONTRACTS.partial_start_throw.terminalReason,
      });
      setImmediate(() => {
        throw new Error("POSTGRES_HARNESS_FAULT_PARTIAL_START");
      });
      return new Promise(() => undefined);
    }
    await stateWriter.writeState({
      phase: "child_crash",
      intendedFaultReached: true,
      terminalReason: FAULT_CONTRACTS.child_crash.terminalReason,
    });
    process.exit(72);
  }

  const password = randomUUID();
  const cluster = new EmbeddedPostgres({
    databaseDir: configuration.dataDirectory,
    user: "preflight_semantic_admin",
    password,
    port: configuration.port,
    persistent: true,
    authMethod: "scram-sha-256",
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--no-sync"],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: () => undefined,
    onError: () => undefined,
  });
  let integration;
  let failure;
  try {
    await assertOwnedRootIdentity(configuration.rootIdentity);
    await stateWriter.writeState({ phase: "initialising" });
    await withinDeadline(
      () => cluster.initialise(),
      POSTGRES_HARNESS_TIMEOUTS.initialise,
      "POSTGRES_HARNESS_INITIALISE_TIMEOUT"
    );
    await stateWriter.writeState({ phase: "starting" });
    const startPromise = cluster.start();
    void startPromise.catch(() => undefined);
    await waitForClusterProcess(cluster, stateWriter);
    await withinDeadline(
      () => startPromise,
      POSTGRES_HARNESS_TIMEOUTS.ready,
      "POSTGRES_HARNESS_READY_TIMEOUT"
    );
    await stateWriter.writeState({ phase: "ready" });
    integration = await withinDeadline(
      () => runIntegration(cluster, { ...configuration, password }),
      POSTGRES_HARNESS_TIMEOUTS.testExecution,
      "POSTGRES_HARNESS_TEST_TIMEOUT"
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : "POSTGRES_HARNESS_FAILURE";
    if (
      [
        "POSTGRES_HARNESS_INITIALISE_TIMEOUT",
        "POSTGRES_HARNESS_START_SPAWN_TIMEOUT",
      ].includes(failure)
    ) {
      await stateWriter.writeState({ phase: "cleanup_required" });
      return new Promise(() => undefined);
    }
  }

  await stateWriter.writeState({ phase: "stopping" });
  const postgresRootPids = stateWriter.state.ownedProcesses
    .filter((entry) => entry.role === "postgres")
    .map((entry) => entry.pid);
  try {
    await withinDeadline(
      () => cluster.stop(),
      POSTGRES_HARNESS_TIMEOUTS.stop,
      "POSTGRES_HARNESS_STOP_TIMEOUT"
    );
  } catch {
    await stateWriter.writeState({ phase: "cleanup_required" });
    return new Promise(() => undefined);
  }
  const normalStopDeadline = createCleanupDeadline(5_000);
  const normalStopComplete =
    postgresRootPids.every((pid) => !isProcessAlive(pid)) &&
    (await waitForPortRelease(configuration.port, normalStopDeadline));
  if (!normalStopComplete) {
    await stateWriter.writeState({ phase: "cleanup_required" });
    return new Promise(() => undefined);
  }
  stateWriter.state.ownedProcesses = [];
  await stateWriter.writeState({ phase: "stopped" });

  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    occurrenceId: configuration.occurrenceId,
    mode: configuration.mode,
    outcome: failure ? "fail" : "pass",
    environmentIsolation: {
      lifecycle: true,
      cleanupChild: cleanupChildEnvironmentIsolated,
    },
    lifecycle: {
      normalStopAttempted: true,
      normalStopSucceeded: true,
      parentCleanupRequired: true,
      processRemaining: false,
      listenerRemaining: false,
    },
    ...(integration ? { integration } : {}),
  };
  writeSync(1, `${JSON.stringify(result)}\n`);
  if (failure) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] &&
  normalizePathForComparison(process.argv[1]) === normalizePathForComparison(modulePath);

if (invokedDirectly) {
  try {
    const configuration = await receiveChildConfiguration();
    await runChild(configuration);
    process.exit(process.exitCode || 0);
  } catch (error) {
    const code =
      error instanceof Error && /^POSTGRES_HARNESS_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "POSTGRES_HARNESS_CHILD_FAILURE";
    writeSync(2, `${code}\n`);
    process.exit(70);
  }
}
