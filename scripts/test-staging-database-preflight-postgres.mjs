import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
const RESULT_SCHEMA_VERSION = 1;
const OCCURRENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_OS_ENVIRONMENT_KEYS = Object.freeze([
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
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

export const POSTGRES_HARNESS_TIMEOUTS = Object.freeze({
  initialise: 30_000,
  startSpawn: 5_000,
  ready: 20_000,
  testExecution: 60_000,
  stop: 10_000,
  forcedCleanup: 10_000,
  faultPhase: 1_500,
});

function valueForKey(source, expectedKey) {
  const actualKey = Object.keys(source).find(
    (key) => key.toUpperCase() === expectedKey
  );
  return actualKey ? source[actualKey] : undefined;
}

export function createPostgresHarnessEnvironment(source = process.env) {
  const environment = {};
  const windowsRoot =
    valueForKey(source, "SYSTEMROOT") || valueForKey(source, "WINDIR");
  for (const key of SAFE_OS_ENVIRONMENT_KEYS) {
    const value = valueForKey(source, key);
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  if (windowsRoot) {
    environment.SYSTEMROOT = windowsRoot;
    environment.WINDIR = windowsRoot;
    environment.COMSPEC = join(windowsRoot, "System32", "cmd.exe");
    environment.PATH = [
      join(windowsRoot, "System32"),
      join(windowsRoot, "System32", "Wbem"),
      join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";");
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    environment.OS = "Windows_NT";
  }
  return environment;
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

export async function allocatePostgresHarnessPort() {
  if (process.platform === "win32") {
    const environment = createPostgresHarnessEnvironment(process.env);
    assertSanitizedEnvironment(environment);
    const powershell = absoluteWindowsTool(
      environment,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const source = String.raw`
$ErrorActionPreference = 'Stop'
$address = [System.Net.IPAddress]::Parse('127.0.0.1')
if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'ADDRESS_FAMILY_MISMATCH'
}
$listener = [System.Net.Sockets.TcpListener]::new($address, 0)
$port = 0
try {
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
} finally {
  $listener.Stop()
}
if ($port -lt 1 -or $port -gt 65535) { throw 'PORT_RANGE_INVALID' }
[Console]::Out.Write($port)
`;
    const result = spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
      {
        encoding: "utf8",
        env: environment,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      }
    );
    const port = Number(result.stdout.trim());
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      result.stderr.trim() !== "" ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
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

async function waitForProcessExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (isProcessAlive(pid) && Date.now() < deadline) await delay(50);
  return !isProcessAlive(pid);
}

async function waitForPortRelease(port, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await isPortReleased(port)) return true;
    await delay(50);
  }
  return isPortReleased(port);
}

function absoluteWindowsTool(environment, ...parts) {
  const windowsRoot = environment.SYSTEMROOT || environment.WINDIR;
  if (!windowsRoot) throw new Error("POSTGRES_HARNESS_WINDOWS_ROOT_REQUIRED");
  return join(windowsRoot, ...parts);
}

function queryWindowsParentPid(pid, environment) {
  if (process.platform !== "win32") return undefined;
  const powershell = absoluteWindowsTool(
    environment,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const source = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if($null -eq $p){exit 3}; [Console]::Out.Write($p.ParentProcessId)`;
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
    {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    }
  );
  if (result.status === 3) return undefined;
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("POSTGRES_HARNESS_PROCESS_RELATION_UNAVAILABLE");
  }
  const parentPid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error("POSTGRES_HARNESS_PROCESS_RELATION_INVALID");
  }
  return parentPid;
}

function findWindowsDescendantProcesses(rootPids, environment) {
  if (process.platform !== "win32" || rootPids.length === 0) return [];
  const powershell = absoluteWindowsTool(
    environment,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const roots = rootPids.map((pid) => Number(pid)).join(",");
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$known = [Collections.Generic.HashSet[int]]::new()
@(${roots}) | ForEach-Object { [void]$known.Add([int]$_) }
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)
$result = [Collections.Generic.List[object]]::new()
do {
  $added = $false
  foreach ($candidate in $all) {
    $candidatePid = [int]$candidate.ProcessId
    if (
      $candidatePid -ne $PID -and
      -not $known.Contains($candidatePid) -and
      $known.Contains([int]$candidate.ParentProcessId)
    ) {
      [void]$known.Add($candidatePid)
      $result.Add([ordered]@{
        pid = $candidatePid
        parentPid = [int]$candidate.ParentProcessId
        name = [string]$candidate.Name
        commandLine = [string]$candidate.CommandLine
      })
      $added = $true
    }
  }
} while ($added)
if ($result.Count -gt 0) { $result | ConvertTo-Json -Compress }
`;
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source],
    {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    }
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("POSTGRES_HARNESS_DESCENDANT_QUERY_FAILED");
  }
  if (!result.stdout.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("POSTGRES_HARNESS_DESCENDANT_QUERY_INVALID");
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function validateEmbeddedPostgresDescendants(descendants, rootPids) {
  const knownParents = new Set(rootPids);
  const embeddedRoot = normalizePathForComparison(
    join(repositoryRoot, "node_modules", "@embedded-postgres")
  ).replaceAll("\\", "/");
  for (const entry of descendants) {
    const commandLine = String(entry?.commandLine || "")
      .replaceAll("\\", "/")
      .toLowerCase();
    if (
      !Number.isSafeInteger(entry?.pid) ||
      entry.pid <= 0 ||
      !Number.isSafeInteger(entry?.parentPid) ||
      !knownParents.has(entry.parentPid) ||
      String(entry.name).toLowerCase() !== "postgres.exe" ||
      !commandLine.includes(embeddedRoot)
    ) {
      throw new Error("POSTGRES_HARNESS_DESCENDANT_IDENTITY_MISMATCH");
    }
    knownParents.add(entry.pid);
  }
  return descendants;
}

function findOwnedPostgresDescendants(rootPids, environment) {
  return validateEmbeddedPostgresDescendants(
    findWindowsDescendantProcesses(rootPids, environment),
    rootPids
  );
}

async function terminateOwnedPostgresDescendants(rootPids, environment) {
  const deadline = Date.now() + POSTGRES_HARNESS_TIMEOUTS.forcedCleanup;
  while (Date.now() < deadline) {
    const descendants = findOwnedPostgresDescendants(rootPids, environment);
    if (descendants.length === 0) return;
    for (const entry of descendants.toReversed()) {
      if (isProcessAlive(entry.pid)) {
        terminateExactProcessTree(entry.pid, environment);
      }
    }
    for (const entry of descendants) {
      const remaining = Math.max(1, deadline - Date.now());
      if (!(await waitForProcessExit(entry.pid, remaining))) {
        throw new Error("POSTGRES_HARNESS_DESCENDANT_REMAINED");
      }
    }
  }
  if (findOwnedPostgresDescendants(rootPids, environment).length > 0) {
    throw new Error("POSTGRES_HARNESS_DESCENDANT_REMAINED");
  }
}

function terminateExactProcessTree(pid, environment) {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    const taskkill = absoluteWindowsTool(
      environment,
      "System32",
      "taskkill.exe"
    );
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: POSTGRES_HARNESS_TIMEOUTS.forcedCleanup,
      windowsHide: true,
    });
    if (result.error || result.signal || ![0, 128].includes(result.status)) {
      throw new Error("POSTGRES_HARNESS_FORCED_CLEANUP_FAILED");
    }
    return;
  }
  process.kill(pid, "SIGKILL");
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
    !Array.isArray(state.ownedProcesses)
  ) {
    throw new Error("POSTGRES_HARNESS_OWNERSHIP_MISMATCH");
  }
  for (const entry of state.ownedProcesses) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.pid) ||
      entry.pid <= 0 ||
      entry.parentPid !== ownership.harnessPid ||
      !["postgres", "fault-worker"].includes(entry.role)
    ) {
      throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_INVALID");
    }
  }
  return state;
}

async function cleanupOwnedHarness(ownership, lastState, environment) {
  const state = validateLifecycleState(lastState, ownership);
  const ownedProcesses = state?.ownedProcesses || [];
  for (const entry of ownedProcesses) {
    if (!isProcessAlive(entry.pid)) continue;
    const observedParent = queryWindowsParentPid(entry.pid, environment);
    if (observedParent !== undefined && observedParent !== ownership.harnessPid) {
      throw new Error("POSTGRES_HARNESS_PROCESS_RELATION_MISMATCH");
    }
  }
  const postgresRootPids = ownedProcesses
    .filter((entry) => entry.role === "postgres")
    .map((entry) => entry.pid);

  if (isProcessAlive(ownership.harnessPid)) {
    terminateExactProcessTree(ownership.harnessPid, environment);
  }
  if (
    !(await waitForProcessExit(
      ownership.harnessPid,
      POSTGRES_HARNESS_TIMEOUTS.forcedCleanup
    ))
  ) {
    throw new Error("POSTGRES_HARNESS_PROCESS_REMAINED");
  }
  for (const entry of ownedProcesses) {
    if (isProcessAlive(entry.pid)) terminateExactProcessTree(entry.pid, environment);
    if (
      !(await waitForProcessExit(
        entry.pid,
        POSTGRES_HARNESS_TIMEOUTS.forcedCleanup
      ))
    ) {
      throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_REMAINED");
    }
  }
  await terminateOwnedPostgresDescendants(postgresRootPids, environment);
  if (
    !(await waitForPortRelease(
      ownership.port,
      POSTGRES_HARNESS_TIMEOUTS.forcedCleanup
    ))
  ) {
    throw new Error("POSTGRES_HARNESS_LISTENER_REMAINED");
  }
  await rm(ownership.dataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  if (existsSync(ownership.dataDirectory)) {
    throw new Error("POSTGRES_HARNESS_DATA_DIRECTORY_REMAINED");
  }
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
} = {}) {
  if (
    ![
      "integration",
      "fault-ready-hang",
      "fault-partial-throw",
      "fault-stop-hang",
      "fault-crash",
    ].includes(mode)
  ) {
    throw new Error("POSTGRES_HARNESS_MODE_REJECTED");
  }
  const environment = createPostgresHarnessEnvironment(sourceEnvironment);
  assertSanitizedEnvironment(environment);
  const root = await mkdtemp(join(tmpdir(), "actustube-preflight-owned-"));
  const dataDirectory = join(root, "database");
  const statePath = join(root, LIFECYCLE_FILE);
  const occurrenceId = randomUUID();
  const port = await allocatePostgresHarnessPort();
  const args = [
    modulePath,
    "--child",
    `--mode=${mode}`,
    `--occurrence=${occurrenceId}`,
    `--root=${root}`,
    `--port=${port}`,
    `--parent=${process.pid}`,
  ];
  const child = spawn(process.execPath, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error("POSTGRES_HARNESS_PID_UNAVAILABLE");
  const ownership = {
    occurrenceId,
    harnessPid: child.pid,
    parentPid: process.pid,
    root,
    dataDirectory,
    port,
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
    return value;
  });

  const executionTimeout =
    mode === "integration"
      ? POSTGRES_HARNESS_TIMEOUTS.initialise +
        POSTGRES_HARNESS_TIMEOUTS.startSpawn +
        POSTGRES_HARNESS_TIMEOUTS.ready +
        POSTGRES_HARNESS_TIMEOUTS.testExecution +
        POSTGRES_HARNESS_TIMEOUTS.stop
      : POSTGRES_HARNESS_TIMEOUTS.faultPhase;
  const deadline = Date.now() + executionTimeout;
  let state;
  let forcedCleanup = false;
  try {
    while (!closed && Date.now() < deadline) {
      const candidate = await readLifecycleState(statePath);
      if (candidate) state = validateLifecycleState(candidate, ownership);
      if (state?.phase === "cleanup_required") break;
      await delay(50);
    }
    if (!closed && (state?.phase === "cleanup_required" || Date.now() >= deadline)) {
      forcedCleanup = true;
      await cleanupOwnedHarness(ownership, state, environment);
      await Promise.race([closePromise, delay(1_000)]);
    } else {
      await closePromise;
    }
    const finalCandidate = await readLifecycleState(statePath);
    if (finalCandidate) state = validateLifecycleState(finalCandidate, ownership);

    if (closed?.code !== 0 || closed?.signal) {
      if (!forcedCleanup) {
        forcedCleanup = true;
        await cleanupOwnedHarness(ownership, state, environment);
      }
      return {
        mode,
        outcome: "expected_failure",
        ownership,
        forcedCleanup,
        processRemaining: isProcessAlive(ownership.harnessPid),
        listenerRemaining: !(await isPortReleased(port)),
        dataDirectoryRemaining: existsSync(dataDirectory),
        failurePhase:
          typeof state?.phase === "string" ? state.phase : "not_observed",
        childErrorCode: /^POSTGRES_HARNESS_[A-Z0-9_]+$/.test(stderr.trim())
          ? stderr.trim()
          : "POSTGRES_HARNESS_CHILD_FAILURE",
        stderrObserved: stderr.length > 0,
      };
    }

    const result = parseChildOutput(stdout);
    if (result.occurrenceId !== occurrenceId || result.mode !== mode) {
      throw new Error("POSTGRES_HARNESS_RESULT_OWNERSHIP_MISMATCH");
    }
    if (existsSync(dataDirectory) || !(await isPortReleased(port))) {
      throw new Error("POSTGRES_HARNESS_NORMAL_CLEANUP_INCOMPLETE");
    }
    return {
      ...result,
      ownership,
      forcedCleanup,
      processRemaining: isProcessAlive(ownership.harnessPid),
      listenerRemaining: false,
      dataDirectoryRemaining: false,
      stderrObserved: stderr.length > 0,
    };
  } finally {
    if (
      isProcessAlive(ownership.harnessPid) ||
      existsSync(dataDirectory) ||
      !(await isPortReleased(port))
    ) {
      const candidate = await readLifecycleState(statePath);
      await cleanupOwnedHarness(ownership, candidate || state, environment);
    }
    if (existsSync(dataDirectory)) {
      throw new Error("POSTGRES_HARNESS_DATA_DIRECTORY_REMAINED");
    }
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
}

function parseChildArguments(argv) {
  if (argv[0] !== "--child") throw new Error("POSTGRES_HARNESS_CHILD_FLAG_REQUIRED");
  const values = Object.fromEntries(
    argv.slice(1).map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 2) throw new Error("POSTGRES_HARNESS_ARGUMENT_INVALID");
      return [entry.slice(2, separator), entry.slice(separator + 1)];
    })
  );
  const port = Number(values.port);
  const parentPid = Number(values.parent);
  const root = values.root;
  if (
    ![
      "integration",
      "fault-ready-hang",
      "fault-partial-throw",
      "fault-stop-hang",
      "fault-crash",
    ].includes(values.mode) ||
    !OCCURRENCE_ID.test(values.occurrence || "") ||
    !isAbsolute(root || "") ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    process.ppid !== parentPid
  ) {
    throw new Error("POSTGRES_HARNESS_ARGUMENT_REJECTED");
  }
  const canonicalRoot = realpathSync(root);
  const dataDirectory = join(canonicalRoot, "database");
  if (
    !canonicalRoot.startsWith(realpathSync(tmpdir())) ||
    !isPathWithin(canonicalRoot, dataDirectory)
  ) {
    throw new Error("POSTGRES_HARNESS_ROOT_REJECTED");
  }
  return {
    mode: values.mode,
    occurrenceId: values.occurrence,
    root: canonicalRoot,
    dataDirectory,
    statePath: join(canonicalRoot, LIFECYCLE_FILE),
    port,
    parentPid,
  };
}

async function createStateWriter(configuration) {
  const state = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    occurrenceId: configuration.occurrenceId,
    harnessPid: process.pid,
    parentPid: configuration.parentPid,
    root: configuration.root,
    dataDirectory: configuration.dataDirectory,
    port: configuration.port,
    phase: "created",
    ownedProcesses: [],
  };
  const writeState = async (patch = {}) => {
    Object.assign(state, patch);
    const temporaryPath = `${configuration.statePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state), {
      encoding: "utf8",
      flag: "w",
    });
    await rename(temporaryPath, configuration.statePath);
  };
  await writeState();
  return { state, writeState };
}

function runCleanupEnvironmentProbe() {
  const source = `const forbidden=${FORBIDDEN_CHILD_ENVIRONMENT_KEY.toString()};const keys=Object.keys(process.env);const allowed=new Set(${JSON.stringify(SAFE_OS_ENVIRONMENT_KEYS)});const pass=keys.every(k=>allowed.has(k.toUpperCase())&&!forbidden.test(k));process.stdout.write(pass?'pass':'fail');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
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
      stateWriter.state.ownedProcesses = [
        { pid, parentPid: process.pid, role: "postgres" },
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
  const source = `import {createServer} from 'node:net';const forbidden=${FORBIDDEN_CHILD_ENVIRONMENT_KEY.toString()};const allowed=new Set(${JSON.stringify(SAFE_OS_ENVIRONMENT_KEYS)});const environmentIsolated=Object.keys(process.env).every(k=>allowed.has(k.toUpperCase())&&!forbidden.test(k));const server=createServer();server.listen(Number(process.argv[1]),'127.0.0.1',()=>{process.stdout.write(JSON.stringify({pid:process.pid,ppid:process.ppid,environmentIsolated})+'\\n')});setInterval(()=>{},1000);`;
  const worker = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, String(configuration.port)],
    {
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
  stateWriter.state.ownedProcesses = [
    { pid: worker.pid, parentPid: process.pid, role: "fault-worker" },
  ];
  await stateWriter.writeState({ phase: "start_spawned" });
  return worker;
}

async function runChild(configuration) {
  assertSanitizedEnvironment(process.env);
  const stateWriter = await createStateWriter(configuration);
  const cleanupChildEnvironmentIsolated = runCleanupEnvironmentProbe();
  if (!cleanupChildEnvironmentIsolated) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_ENVIRONMENT_REJECTED");
  }

  if (configuration.mode !== "integration") {
    await spawnFaultWorker(configuration, stateWriter);
    if (configuration.mode === "fault-ready-hang") {
      await stateWriter.writeState({ phase: "ready_pending" });
      return new Promise(() => undefined);
    }
    if (configuration.mode === "fault-stop-hang") {
      await stateWriter.writeState({ phase: "stopping" });
      return new Promise(() => undefined);
    }
    if (configuration.mode === "fault-partial-throw") {
      await stateWriter.writeState({ phase: "partial_start_failure" });
      setImmediate(() => {
        throw new Error("POSTGRES_HARNESS_FAULT_PARTIAL_START");
      });
      return new Promise(() => undefined);
    }
    await stateWriter.writeState({ phase: "child_crash" });
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
  let forcedCleanupUsed = false;
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
  const normalStopComplete =
    postgresRootPids.every((pid) => !isProcessAlive(pid)) &&
    findOwnedPostgresDescendants(postgresRootPids, process.env).length === 0 &&
    (await waitForPortRelease(configuration.port, 5_000));
  if (!normalStopComplete) {
    forcedCleanupUsed = true;
    for (const pid of postgresRootPids) {
      if (isProcessAlive(pid)) terminateExactProcessTree(pid, process.env);
    }
    await terminateOwnedPostgresDescendants(postgresRootPids, process.env);
    for (const pid of postgresRootPids) {
      if (
        !(await waitForProcessExit(
          pid,
          POSTGRES_HARNESS_TIMEOUTS.forcedCleanup
        ))
      ) {
        await stateWriter.writeState({ phase: "cleanup_required" });
        return new Promise(() => undefined);
      }
    }
    if (
      !(await waitForPortRelease(
        configuration.port,
        POSTGRES_HARNESS_TIMEOUTS.forcedCleanup
      ))
    ) {
      await stateWriter.writeState({ phase: "cleanup_required" });
      return new Promise(() => undefined);
    }
  }
  stateWriter.state.ownedProcesses = [];
  await stateWriter.writeState({ phase: "stopped" });
  await rm(configuration.dataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  if (existsSync(configuration.dataDirectory)) {
    await stateWriter.writeState({ phase: "cleanup_required" });
    return new Promise(() => undefined);
  }
  await stateWriter.writeState({ phase: "cleaned" });

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
      normalStopSucceeded: !forcedCleanupUsed,
      forcedCleanupUsed,
      processRemaining: false,
      listenerRemaining: false,
      dataDirectoryRemaining: false,
    },
    ...(integration ? { integration } : {}),
  };
  writeSync(1, `${JSON.stringify(result)}\n`);
  if (failure) process.exitCode = 1;
}

if (process.argv.includes("--child")) {
  try {
    const configuration = parseChildArguments(process.argv.slice(2));
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
