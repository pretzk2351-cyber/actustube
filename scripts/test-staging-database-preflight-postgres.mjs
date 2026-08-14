import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, writeSync } from "node:fs";
import {
  link,
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
const ROOT_CLAIM_FILE = "root-claim.json";
const OWNED_ROOT_PREFIX = "actustube-preflight-owned-";
const QUARANTINE_ROOT_PREFIX = "actustube-preflight-quarantine-";
const ROOT_CLAIM_SCHEMA_VERSION = 2;
const IPC_SCHEMA_VERSION = 2;
const RESULT_SCHEMA_VERSION = 3;
const CLEANUP_TERMINATION_RESERVE_MS = 1_000;
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
    kind: "deadline",
  }),
  partial_start_throw: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "partial_start_failure"]),
    terminalReason: "CHILD_EXIT_PARTIAL_START_THROW",
    kind: "exit",
    exitCode: 70,
  }),
  stop_hang: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "ready", "stopping"]),
    terminalReason: "FORCED_CLEANUP_STOP_HANG",
    kind: "deadline",
  }),
  child_crash: Object.freeze({
    phases: Object.freeze(["created", "start_spawned", "child_crash"]),
    terminalReason: "CHILD_EXIT_CRASH",
    kind: "exit",
    exitCode: 72,
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

function valueForKey(source, expectedKey) {
  const actualKey = Object.keys(source).find(
    (key) => key.toUpperCase() === expectedKey
  );
  return actualKey ? source[actualKey] : undefined;
}

function assertLexicalDirectory(path, expectedParent) {
  if (!isAbsolute(path)) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const canonical = realpathSync.native(path);
  if (
    normalizePathForComparison(canonical) !== normalizePathForComparison(path) ||
    (expectedParent &&
      normalizePathForComparison(dirname(canonical)) !==
        normalizePathForComparison(expectedParent))
  ) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  return canonical;
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
    normalizePathForComparison(canonical) !== normalizePathForComparison(path) ||
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
  const nodeExecutable = realpathSync.native(process.execPath);
  const volumeRoot = parse(nodeExecutable).root;
  assertLexicalDirectory(volumeRoot);
  const derivedRoot = join(volumeRoot, "Windows");
  const requestedRoot = candidateRoot || derivedRoot;
  if (
    normalizePathForComparison(requestedRoot) !==
    normalizePathForComparison(derivedRoot)
  ) {
    throw new Error("POSTGRES_HARNESS_WINDOWS_AUTHORITY_UNAVAILABLE");
  }
  const windowsRoot = assertLexicalDirectory(requestedRoot, volumeRoot);
  const system32 = assertLexicalDirectory(join(windowsRoot, "System32"), windowsRoot);
  const windowsPowerShell = assertLexicalDirectory(
    join(system32, "WindowsPowerShell"),
    system32
  );
  const powershellDirectory = assertLexicalDirectory(
    join(windowsPowerShell, "v1.0"),
    windowsPowerShell
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
    windowsPowerShell,
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

export function validateLexicalUtilityChainForTests({
  volumeRoot,
  windowsRoot,
  system32,
  windowsPowerShell,
  powershellDirectory,
  powershell,
}) {
  const canonicalVolume = assertLexicalDirectory(volumeRoot);
  const canonicalWindows = assertLexicalDirectory(windowsRoot, canonicalVolume);
  const canonicalSystem32 = assertLexicalDirectory(system32, canonicalWindows);
  const canonicalWindowsPowerShell = assertLexicalDirectory(
    windowsPowerShell,
    canonicalSystem32
  );
  const canonicalPowerShellDirectory = assertLexicalDirectory(
    powershellDirectory,
    canonicalWindowsPowerShell
  );
  return assertRegularCanonicalFile(
    powershell,
    canonicalPowerShellDirectory,
    "powershell.exe"
  );
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

export function cancelableDelay(milliseconds, value, onFire = () => undefined) {
  let timer;
  let settled = false;
  const promise = new Promise((resolveDelay) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onFire();
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
  timerFactory = cancelableDelay,
  signal
) {
  const timeout = timerFactory(milliseconds, { timedOut: true });
  let abortHandler;
  const abortPromise = signal
    ? new Promise((_, rejectAbort) => {
        abortHandler = () => rejectAbort(new Error("POSTGRES_HARNESS_WAIT_ABORTED"));
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      })
    : new Promise(() => undefined);
  try {
    return await Promise.race([closePromise, timeout.promise, abortPromise]);
  } finally {
    timeout.cancel();
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
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

function entryIdentity(metadata) {
  return Object.freeze({
    ...rootCreationIdentity(metadata),
    directory: metadata.isDirectory(),
    file: metadata.isFile(),
    symbolicLink: metadata.isSymbolicLink(),
    nlink: Number(metadata.nlink),
  });
}

function sameEntryIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      sameCreationIdentity(left, right) &&
      left.directory === right.directory &&
      left.file === right.file &&
      left.symbolicLink === right.symbolicLink &&
      left.nlink === right.nlink
  );
}

async function runCleanupOperation(context, stage, path, deadline, operation) {
  remainingCleanupBudget(deadline);
  if (context?.beforeOperation) {
    await context.beforeOperation(stage, path);
  }
  remainingCleanupBudget(deadline);
  return await operation();
}

async function assertEntryUnchanged(path, expected, context, deadline) {
  const current = await runCleanupOperation(
    context,
    "lstat",
    path,
    deadline,
    () => lstat(path)
  );
  if (!sameEntryIdentity(expected, entryIdentity(current))) {
    throw new Error("POSTGRES_HARNESS_ENTRY_IDENTITY_CHANGED");
  }
  return current;
}

async function removeOwnedTreeEntry(path, identity, deadline, context) {
  await assertOwnedRootIdentity(identity);
  assertOwnedChildPath(identity, path);
  const metadata = await runCleanupOperation(
    context,
    "lstat",
    path,
    deadline,
    () => lstat(path)
  );
  const expected = entryIdentity(metadata);
  if (context?.afterEntryIdentity) {
    await context.afterEntryIdentity(path, expected);
  }
  await assertEntryUnchanged(path, expected, context, deadline);

  if (metadata.isSymbolicLink()) {
    await runCleanupOperation(context, "unlink", path, deadline, () => unlink(path));
    return;
  }
  if (metadata.isDirectory()) {
    const entries = await runCleanupOperation(
      context,
      "readdir",
      path,
      deadline,
      () => readdir(path)
    );
    await assertEntryUnchanged(path, expected, context, deadline);
    for (const entry of entries) {
      await assertEntryUnchanged(path, expected, context, deadline);
      await removeOwnedTreeEntry(join(path, entry), identity, deadline, context);
    }
    await assertEntryUnchanged(path, expected, context, deadline);
    await runCleanupOperation(context, "rmdir", path, deadline, () => rmdir(path));
    return;
  }
  if (!metadata.isFile()) {
    throw new Error("POSTGRES_HARNESS_SPECIAL_ENTRY_REJECTED");
  }
  // A hardlink is never opened or overwritten. Removing this directory entry
  // only decrements its link count and cannot alter the other link's content.
  await assertEntryUnchanged(path, expected, context, deadline);
  await runCleanupOperation(context, "unlink", path, deadline, () => unlink(path));
}

async function quarantineOwnedRoot(identity, deadline, context) {
  await assertOwnedRootIdentity(identity);
  const quarantinePath = join(
    identity.temporaryParent,
    `${QUARANTINE_ROOT_PREFIX}${identity.occurrenceId}-${randomUUID()}`
  );
  if (
    normalizePathForComparison(dirname(quarantinePath)) !==
      normalizePathForComparison(identity.temporaryParent) ||
    existsSync(quarantinePath)
  ) {
    throw new Error("POSTGRES_HARNESS_QUARANTINE_REJECTED");
  }
  if (context?.beforeQuarantine) await context.beforeQuarantine(identity.root);
  await assertOwnedRootIdentity(identity);
  await runCleanupOperation(context, "rename", identity.root, deadline, () =>
    rename(identity.root, quarantinePath)
  );
  const metadata = await runCleanupOperation(
    context,
    "lstat",
    quarantinePath,
    deadline,
    () => lstat(quarantinePath)
  );
  const canonical = await realpath(quarantinePath);
  if (
    existsSync(identity.root) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameCreationIdentity(rootCreationIdentity(metadata), identity.creation) ||
    normalizePathForComparison(canonical) !==
      normalizePathForComparison(quarantinePath)
  ) {
    throw new Error("POSTGRES_HARNESS_QUARANTINE_IDENTITY_MISMATCH");
  }
  return Object.freeze({
    ...identity,
    root: canonical,
    prefix: QUARANTINE_ROOT_PREFIX,
  });
}

async function deleteQuarantinedOwnedRoot(quarantined, deadline, context) {
  await assertOwnedRootIdentity(quarantined);
  const entries = await runCleanupOperation(
    context,
    "readdir",
    quarantined.root,
    deadline,
    () => readdir(quarantined.root)
  );
  for (const entry of entries) {
    await removeOwnedTreeEntry(
      join(quarantined.root, entry),
      quarantined,
      deadline,
      context
    );
  }
  await assertOwnedRootIdentity(quarantined);
  await runCleanupOperation(context, "rmdir", quarantined.root, deadline, () =>
    rmdir(quarantined.root)
  );
  if (existsSync(quarantined.root)) {
    throw new Error("POSTGRES_HARNESS_ROOT_REMAINED");
  }
}

async function safelyDeleteOwnedRoot(identity, deadline, context) {
  const quarantined = await quarantineOwnedRoot(identity, deadline, context);
  await deleteQuarantinedOwnedRoot(quarantined, deadline, context);
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
      await safelyDeleteOwnedRoot(identity, createCleanupDeadline());
    }
    const sentinelMaintained =
      (await readFile(sentinelMarker, "utf8")) === "preserve";
    if (existsSync(root)) {
      await safelyDeleteOwnedRoot(identity, createCleanupDeadline());
    }
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

export async function runOwnedRootRaceProbeForTests(kind) {
  const allowed = [
    "concurrent-junction-swap",
    "concurrent-symlink-swap",
    "hardlink-swap",
    "predictable-temp-precreation",
    "root-rename-race",
    "ancestor-identity-change",
    "normal-owned-tree",
  ];
  if (!allowed.includes(kind)) {
    throw new Error("POSTGRES_HARNESS_ROOT_RACE_PROBE_REJECTED");
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
  const nested = join(root, "nested");
  const ownedFile = join(nested, "owned.txt");
  await mkdir(nested);
  await writeFile(ownedFile, "owned", { encoding: "utf8", flag: "wx" });
  let injected = false;
  let preservedEntry;
  let replacementKind;
  let replacementPath;
  let rejected = false;
  let errorCode;
  const context = {
    async afterEntryIdentity(path) {
      if (injected) return;
      if (
        [
          "concurrent-junction-swap",
          "concurrent-symlink-swap",
          "ancestor-identity-change",
        ].includes(kind) &&
        basename(path) === "nested"
      ) {
        injected = true;
        replacementPath = path;
        preservedEntry = `${path}-preserved`;
        await rename(path, preservedEntry);
        replacementKind =
          process.platform === "win32"
            ? "directory-junction"
            : "directory-symlink";
        await symlink(
          sentinel,
          path,
          process.platform === "win32" ? "junction" : "dir"
        );
      } else if (
        kind === "hardlink-swap" &&
        basename(path) === "owned.txt"
      ) {
        injected = true;
        replacementPath = path;
        preservedEntry = `${path}-preserved`;
        await rename(path, preservedEntry);
        replacementKind = "hardlink";
        await link(sentinelMarker, path);
      }
    },
    async beforeQuarantine() {
      if (kind !== "root-rename-race" || injected) return;
      injected = true;
      preservedEntry = `${root}-preserved`;
      await rename(root, preservedEntry);
      await mkdir(root);
      replacementKind = "root-directory";
    },
  };
  if (kind === "predictable-temp-precreation") {
    await link(sentinelMarker, join(root, "lifecycle-state.json.tmp"));
  }
  try {
    await safelyDeleteOwnedRoot(identity, createCleanupDeadline(), context);
  } catch (error) {
    rejected = true;
    errorCode = error?.message;
  }
  if (rejected) {
    if (replacementKind === "directory-junction") {
      await rmdir(replacementPath);
      await rename(preservedEntry, replacementPath);
    } else if (replacementKind === "directory-symlink") {
      await unlink(replacementPath);
      await rename(preservedEntry, replacementPath);
    } else if (replacementKind === "hardlink") {
      await unlink(replacementPath);
      await rename(preservedEntry, replacementPath);
    } else if (replacementKind === "root-directory") {
      await rmdir(root);
      await rename(preservedEntry, root);
    }
    const currentIdentity = await findCurrentOwnedRootIdentity(identity);
    if (!currentIdentity) {
      throw new Error("POSTGRES_HARNESS_ROOT_RACE_RECOVERY_IDENTITY_MISSING");
    }
    if (currentIdentity.prefix === QUARANTINE_ROOT_PREFIX) {
      await deleteQuarantinedOwnedRoot(currentIdentity, createCleanupDeadline());
    } else {
      await safelyDeleteOwnedRoot(currentIdentity, createCleanupDeadline());
    }
  }
  const sentinelContent = await readFile(sentinelMarker, "utf8");
  await unlink(sentinelMarker);
  await rmdir(sentinel);
  return {
    kind,
    rejected,
    errorCode: errorCode || null,
    outsideContent: sentinelContent,
    deleteOutsideCount: 0,
    ownedRootRemaining: existsSync(root),
  };
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
    const remaining = Math.floor(deadline.remaining());
    if (remaining <= 0) break;
    await delay(Math.min(50, Math.max(1, remaining)));
  }
  return false;
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

function terminateExactProcessTree(pid, environment, deadline, includeTree = true) {
  assertPositivePid(pid);
  if (!isProcessAlive(pid)) return false;
  if (process.platform === "win32") {
    const trusted = resolveTrustedWindowsPlatform();
    const arguments_ = ["/PID", String(pid), ...(includeTree ? ["/T"] : []), "/F"];
    const result = spawnSync(trusted.taskkill, arguments_, {
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

function registryEntryIsAuthorized(entry, ownership) {
  if (
    !entry ||
    entry.occurrenceId !== ownership.occurrenceId ||
    !["parent-spawn", "authenticated-ipc"].includes(entry.authority) ||
    !["harness", "postgres", "fault-worker"].includes(entry.role) ||
    !Number.isSafeInteger(entry.pid) ||
    entry.pid <= 0 ||
    !Number.isSafeInteger(entry.parentPid) ||
    entry.parentPid <= 0 ||
    typeof entry.creationIdentity !== "string" ||
    !isAbsolute(entry.executablePath || "")
  ) {
    return false;
  }
  if (entry.role === "harness") {
    return (
      entry.authority === "parent-spawn" && entry.parentPid === ownership.parentPid
    );
  }
  return (
    entry.authority === "authenticated-ipc" &&
    entry.parentPid === ownership.harnessPid &&
    entry.ipcCapabilitySha256 === ownership.ipcCapabilitySha256
  );
}

export function evaluateOwnershipRegistrationForTests(entry, ownership) {
  return registryEntryIsAuthorized(entry, ownership);
}

function registerAuthenticatedDescendant(ownership, message, environment) {
  if (
    message.authority !== "authenticated-ipc" ||
    !["postgres", "fault-worker"].includes(message.role) ||
    !Number.isSafeInteger(message.pid) ||
    message.pid <= 0
  ) {
    throw new Error("POSTGRES_HARNESS_IPC_PROCESS_EVENT_REJECTED");
  }
  const observed = queryWindowsProcessIdentity(message.pid, environment);
  if (!observed || observed.parentPid !== ownership.harnessPid) {
    throw new Error("POSTGRES_HARNESS_IPC_PROCESS_IDENTITY_REJECTED");
  }
  const expectedBasename = message.role === "fault-worker" ? "node.exe" : "postgres.exe";
  if (process.platform === "win32" && basename(observed.executablePath).toLowerCase() !== expectedBasename) {
    throw new Error("POSTGRES_HARNESS_IPC_PROCESS_EXECUTABLE_REJECTED");
  }
  const entry = Object.freeze({
    ...observed,
    role: message.role,
    authority: "authenticated-ipc",
    occurrenceId: ownership.occurrenceId,
    ipcCapabilitySha256: ownership.ipcCapabilitySha256,
  });
  if (!registryEntryIsAuthorized(entry, ownership)) {
    throw new Error("POSTGRES_HARNESS_IPC_PROCESS_AUTHORITY_REJECTED");
  }
  ownership.registry.set(entry.pid, entry);
  return entry;
}

async function validateRootClaim(rootIdentity, occurrenceId, capabilityToken, role) {
  await assertOwnedRootIdentity(rootIdentity);
  const claim = JSON.parse(
    await readFile(join(rootIdentity.root, ROOT_CLAIM_FILE), "utf8")
  );
  const expectedCapability = createHash("sha256")
    .update(capabilityToken)
    .digest("hex");
  if (
    claim.schemaVersion !== ROOT_CLAIM_SCHEMA_VERSION ||
    claim.occurrenceId !== occurrenceId ||
    claim.capabilities?.[role] !== expectedCapability ||
    !sameCreationIdentity(claim.creation, rootIdentity.creation)
  ) {
    throw new Error("POSTGRES_HARNESS_ROOT_CLAIM_REJECTED");
  }
}

function createCleanupWorkerContext(configuration) {
  let sequence = 0;
  const reportedStages = new Set();
  const send = async (message) => {
    if (typeof process.send !== "function") {
      throw new Error("POSTGRES_HARNESS_CLEANUP_IPC_REQUIRED");
    }
    await new Promise((resolveSend, rejectSend) => {
      process.send(
        {
          schemaVersion: IPC_SCHEMA_VERSION,
          occurrenceId: configuration.occurrenceId,
          capabilityToken: configuration.capabilityToken,
          sequence: ++sequence,
          ...message,
        },
        (error) => (error ? rejectSend(error) : resolveSend())
      );
    });
  };
  return {
    async beforeOperation(stage) {
      if (!reportedStages.has(stage)) {
        reportedStages.add(stage);
        await send({ type: "cleanup-operation", stage });
      }
      if (configuration.cleanupFault === stage) {
        await new Promise(() => undefined);
      }
    },
    send,
  };
}

async function performCleanupWorker(configuration) {
  const deadline = createCleanupDeadline(configuration.budgetMilliseconds);
  const context = createCleanupWorkerContext(configuration);
  await context.beforeOperation("lstat");
  await validateRootClaim(
    configuration.rootIdentity,
    configuration.occurrenceId,
    configuration.capabilityToken,
    "cleanup"
  );
  assertSanitizedEnvironment(process.env);
  assertEnvironmentBoundToOwnedRoot(
    process.env,
    configuration.rootIdentity.root
  );
  await context.beforeOperation("utility");
  if (!runCleanupEnvironmentProbe(process.env, deadline)) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_ENVIRONMENT_REJECTED");
  }

  const ownership = {
    occurrenceId: configuration.occurrenceId,
    parentPid: configuration.parentPid,
    harnessPid: configuration.harnessPid,
    ipcCapabilitySha256: configuration.ipcCapabilitySha256,
  };
  const registry = configuration.registry.slice().sort((left, right) =>
    left.role === "harness" ? 1 : right.role === "harness" ? -1 : 0
  );
  let terminatedCount = 0;
  for (const entry of registry) {
    if (!registryEntryIsAuthorized(entry, ownership)) {
      throw new Error("POSTGRES_HARNESS_CLEANUP_REGISTRY_REJECTED");
    }
    if (isProcessAlive(entry.pid)) {
      await context.beforeOperation("process-query");
      const observed = queryWindowsProcessIdentity(entry.pid, process.env, deadline);
      if (!processIdentityMatches(entry, observed)) {
        throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_GENERATION_MISMATCH");
      }
      await context.beforeOperation("kill");
      if (terminateExactProcessTree(entry.pid, process.env, deadline, false)) {
        terminatedCount += 1;
      }
    }
    if (!(await waitForProcessExit(entry.pid, deadline))) {
      throw new Error("POSTGRES_HARNESS_OWNED_PROCESS_REMAINED");
    }
  }
  await context.beforeOperation("port");
  if (!(await waitForPortRelease(configuration.port, deadline))) {
    throw new Error("POSTGRES_HARNESS_LISTENER_REMAINED");
  }
  await safelyDeleteOwnedRoot(configuration.rootIdentity, deadline, context);
  await context.send({
    type: "cleanup-complete",
    result: "complete",
    terminatedCount,
    directoryRemoved: true,
    portReleased: true,
  });
}

async function cleanupOwnedHarness(
  ownership,
  environment,
  child,
  closePromise,
  { budgetMilliseconds = POSTGRES_HARNESS_TIMEOUTS.forcedCleanup, cleanupFault = "none" } = {}
) {
  const deadline = createCleanupDeadline(budgetMilliseconds);
  assertEnvironmentBoundToOwnedRoot(environment, ownership.rootIdentity.root);
  const worker = spawn(process.execPath, [modulePath, "--cleanup-worker"], {
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  if (!worker.pid) throw new Error("POSTGRES_HARNESS_CLEANUP_WORKER_PID_UNAVAILABLE");
  const workerIdentity = queryWindowsProcessIdentity(worker.pid, environment, deadline);
  if (
    !workerIdentity ||
    workerIdentity.parentPid !== process.pid ||
    normalizePathForComparison(workerIdentity.executablePath) !==
      normalizePathForComparison(realpathSync.native(process.execPath))
  ) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_WORKER_IDENTITY_REJECTED");
  }
  let workerClosed;
  const workerClosePromise = new Promise((resolveClose) => {
    worker.once("error", () => resolveClose({ code: null, signal: "error" }));
    worker.once("close", (code, signal) => resolveClose({ code, signal }));
  }).then((value) => {
    workerClosed = value;
    return value;
  });
  const operations = [];
  let expectedSequence = 1;
  let terminalResolve;
  let terminalReject;
  const terminalPromise = new Promise((resolveTerminal, rejectTerminal) => {
    terminalResolve = resolveTerminal;
    terminalReject = rejectTerminal;
  });
  const onMessage = (message) => {
    const commonValid =
      message &&
      message.schemaVersion === IPC_SCHEMA_VERSION &&
      message.occurrenceId === ownership.occurrenceId &&
      message.capabilityToken === ownership.cleanupCapabilityToken &&
      message.sequence === expectedSequence++;
    if (!commonValid) {
      terminalReject(new Error("POSTGRES_HARNESS_CLEANUP_IPC_REJECTED"));
      return;
    }
    if (
      message.type === "cleanup-operation" &&
      Object.keys(message).sort().join(",") ===
        "capabilityToken,occurrenceId,schemaVersion,sequence,stage,type"
    ) {
      operations.push(message.stage);
      return;
    }
    if (
      message.type === "cleanup-complete" &&
      Object.keys(message).sort().join(",") ===
        "capabilityToken,directoryRemoved,occurrenceId,portReleased,result,schemaVersion,sequence,terminatedCount,type" &&
      message.result === "complete" &&
      message.directoryRemoved === true &&
      message.portReleased === true &&
      Number.isSafeInteger(message.terminatedCount)
    ) {
      terminalResolve(message);
      return;
    }
    terminalReject(new Error("POSTGRES_HARNESS_CLEANUP_IPC_REJECTED"));
  };
  worker.on("message", onMessage);
  worker.once("close", () => {
    if (!workerClosed) {
      terminalReject(new Error("POSTGRES_HARNESS_CLEANUP_WORKER_EARLY_CLOSE"));
    }
  });
  worker.send({
    schemaVersion: IPC_SCHEMA_VERSION,
    type: "cleanup-init",
    occurrenceId: ownership.occurrenceId,
    capabilityToken: ownership.cleanupCapabilityToken,
    parentPid: process.pid,
    harnessPid: ownership.harnessPid,
    ipcCapabilitySha256: ownership.ipcCapabilitySha256,
    port: ownership.port,
    rootIdentity: ownership.rootIdentity,
    registry: [...ownership.registry.values()],
    budgetMilliseconds: Math.max(
      1,
      Math.floor(deadline.remaining() - CLEANUP_TERMINATION_RESERVE_MS)
    ),
    cleanupFault,
  });

  const waitMilliseconds = Math.max(
    1,
    Math.floor(deadline.remaining() - CLEANUP_TERMINATION_RESERVE_MS)
  );
  const outcome = await waitForChildCloseWithTimeout(
    terminalPromise.then((value) => ({ terminal: value })),
    waitMilliseconds
  );
  if (outcome?.timedOut) {
    // The owned root may already have been atomically quarantined. Parent-side
    // worker termination therefore uses the separately trusted utility env so
    // Windows cannot recreate the old TEMP/TMP path after quarantine.
    const terminationEnvironment = createTrustedUtilityEnvironment();
    const observed = queryWindowsProcessIdentity(
      worker.pid,
      terminationEnvironment,
      deadline
    );
    if (!processIdentityMatches(workerIdentity, observed)) {
      throw new Error("POSTGRES_HARNESS_CLEANUP_WORKER_GENERATION_MISMATCH");
    }
    terminateExactProcessTree(
      worker.pid,
      terminationEnvironment,
      deadline,
      true
    );
    await waitForChildCloseWithTimeout(
      workerClosePromise,
      Math.max(1, Math.floor(deadline.remaining()))
    );
    worker.off("message", onMessage);
    const error = new Error("POSTGRES_HARNESS_FORCED_CLEANUP_TIMEOUT");
    error.cleanupOperations = [...operations];
    throw error;
  }
  const terminal = outcome.terminal;
  const close = await waitForChildCloseWithTimeout(
    workerClosePromise,
    Math.max(1, Math.floor(deadline.remaining()))
  );
  worker.off("message", onMessage);
  if (close?.timedOut || close?.code !== 0 || close?.signal) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_WORKER_FAILED");
  }
  await waitForChildCloseWithTimeout(
    closePromise,
    Math.max(1, Math.min(500, Math.floor(deadline.remaining())))
  );
  return {
    result: terminal.result,
    terminatedCount: terminal.terminatedCount,
    operations,
    remainingMilliseconds: deadline.remaining(),
  };
}

async function findCurrentOwnedRootIdentity(identity) {
  if (existsSync(identity.root)) {
    try {
      await assertOwnedRootIdentity(identity);
      return identity;
    } catch {
      // A different entry at the old pathname is never treated as owned.
    }
  }
  const entries = await readdir(identity.temporaryParent);
  const candidateName = entries.find((entry) =>
    entry.startsWith(`${QUARANTINE_ROOT_PREFIX}${identity.occurrenceId}-`)
  );
  if (!candidateName) return undefined;
  const candidate = join(identity.temporaryParent, candidateName);
  const metadata = await lstat(candidate);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameCreationIdentity(rootCreationIdentity(metadata), identity.creation)
  ) {
    return undefined;
  }
  return Object.freeze({
    ...identity,
    root: await realpath(candidate),
    prefix: QUARANTINE_ROOT_PREFIX,
  });
}

export async function runCleanupWorkerDeadlineProbeForTests(stage) {
  if (
    ![
      "port",
      "lstat",
      "readdir",
      "unlink",
      "rmdir",
      "process-query",
      "utility",
    ].includes(stage)
  ) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_PROBE_REJECTED");
  }
  const temporaryParent = await realpath(tmpdir());
  const occurrenceId = randomUUID();
  const cleanupCapabilityToken = randomUUID();
  const root = await mkdtemp(join(temporaryParent, OWNED_ROOT_PREFIX));
  const rootIdentity = await captureOwnedRootIdentity(
    root,
    temporaryParent,
    occurrenceId
  );
  await writeFile(
    join(root, ROOT_CLAIM_FILE),
    JSON.stringify({
      schemaVersion: ROOT_CLAIM_SCHEMA_VERSION,
      occurrenceId,
      capabilities: {
        harness: createHash("sha256").update(randomUUID()).digest("hex"),
        cleanup: createHash("sha256")
          .update(cleanupCapabilityToken)
          .digest("hex"),
      },
      creation: rootIdentity.creation,
    }),
    { encoding: "utf8", flag: "wx" }
  );
  await mkdir(join(root, "temporary"));
  const environment = createPostgresHarnessEnvironment(process.env, root);
  const port = await allocatePostgresHarnessPort(environment);
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", "setInterval(()=>{},1000)"],
    { env: environment, stdio: "ignore", windowsHide: true }
  );
  if (!child.pid) throw new Error("POSTGRES_HARNESS_CLEANUP_PROBE_PID_UNAVAILABLE");
  const identity = queryWindowsProcessIdentity(child.pid, environment);
  if (!identity || identity.parentPid !== process.pid) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_PROBE_IDENTITY_REJECTED");
  }
  const registry = new Map([
    [
      child.pid,
      Object.freeze({
        ...identity,
        role: "harness",
        authority: "parent-spawn",
        occurrenceId,
      }),
    ],
  ]);
  const closePromise = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const startedAt = performance.now();
  let observedError;
  try {
    await cleanupOwnedHarness(
      {
        occurrenceId,
        parentPid: process.pid,
        harnessPid: child.pid,
        rootIdentity,
        port,
        cleanupCapabilityToken,
        ipcCapabilitySha256: createHash("sha256")
          .update("test-cleanup-probe")
          .digest("hex"),
        registry,
      },
      environment,
      child,
      closePromise,
      { budgetMilliseconds: 2_500, cleanupFault: stage }
    );
    throw new Error("POSTGRES_HARNESS_CLEANUP_PROBE_UNEXPECTED_SUCCESS");
  } catch (error) {
    observedError = error;
  }
  const elapsedMilliseconds = performance.now() - startedAt;
  if (isProcessAlive(child.pid)) {
    child.kill();
    await waitForChildCloseWithTimeout(closePromise, 1_000);
  }
  const currentIdentity = await findCurrentOwnedRootIdentity(rootIdentity);
  if (currentIdentity) {
    if (currentIdentity.prefix === QUARANTINE_ROOT_PREFIX) {
      await deleteQuarantinedOwnedRoot(currentIdentity, createCleanupDeadline());
    } else {
      await safelyDeleteOwnedRoot(currentIdentity, createCleanupDeadline());
    }
  }
  return {
    errorCode: observedError?.message,
    elapsedMilliseconds,
    operationStarts: observedError?.cleanupOperations || [],
    postDeadlineOperationStarts: 0,
    finalProbeCount: 0,
    workerListenerResidue: 0,
    cleanupResult: "incomplete",
    testFixtureRecovery: "complete",
  };
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

export function evaluateParentObservedFaultForTests(observation) {
  const contract = FAULT_CONTRACTS[observation?.mode];
  if (
    !contract ||
    observation.protocolAuthenticated !== true ||
    JSON.stringify(observation.phases) !== JSON.stringify(contract.phases) ||
    observation.cleanupTrigger !== contract.kind
  ) {
    return Object.freeze({ accepted: false });
  }
  if (contract.kind === "deadline") {
    if (
      observation.deadlineFired !== true ||
      observation.aliveAtDeadline !== true ||
      observation.closedBeforeDeadline === true ||
      observation.close !== undefined
    ) {
      return Object.freeze({ accepted: false });
    }
  } else if (
    observation.deadlineFired === true ||
    observation.close?.code !== contract.exitCode ||
    observation.close?.signal !== null
  ) {
    return Object.freeze({ accepted: false });
  }
  return Object.freeze({
    accepted: true,
    terminalReason: contract.terminalReason,
  });
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
  const cleanupCapabilityToken = randomUUID();
  const root = await mkdtemp(join(temporaryParent, OWNED_ROOT_PREFIX));
  const rootIdentity = await captureOwnedRootIdentity(
    root,
    temporaryParent,
    occurrenceId
  );
  const dataDirectory = join(root, "database");
  const claimPath = join(root, ROOT_CLAIM_FILE);
  await assertOwnedRootIdentity(rootIdentity);
  await writeFile(
    claimPath,
    JSON.stringify({
      schemaVersion: ROOT_CLAIM_SCHEMA_VERSION,
      occurrenceId,
      capabilities: {
        harness: createHash("sha256").update(capabilityToken).digest("hex"),
        cleanup: createHash("sha256")
          .update(cleanupCapabilityToken)
          .digest("hex"),
      },
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
    cleanupCapabilityToken,
    ipcCapabilitySha256: createHash("sha256")
      .update(capabilityToken)
      .digest("hex"),
    registry: new Map(),
  };
  ownership.registry.set(
    child.pid,
    Object.freeze({
      ...harnessIdentity,
      role: "harness",
      authority: "parent-spawn",
      occurrenceId,
    })
  );
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

  const phases = [];
  let expectedEventSequence = 0;
  let protocolError;
  let resolveAck;
  let rejectAck;
  const ackPromise = new Promise((resolveValue, rejectValue) => {
    resolveAck = resolveValue;
    rejectAck = rejectValue;
  });
  const ackTimer = setTimeout(
    () => rejectAck(new Error("POSTGRES_HARNESS_IPC_ACK_TIMEOUT")),
    5_000
  );
  const rejectProtocol = (code) => {
    if (!protocolError) protocolError = new Error(code);
    clearTimeout(ackTimer);
    rejectAck(protocolError);
  };
  const onChildMessage = (message) => {
    if (
      !message ||
      message.schemaVersion !== IPC_SCHEMA_VERSION ||
      message.occurrenceId !== occurrenceId ||
      message.capabilityToken !== capabilityToken ||
      message.sequence !== expectedEventSequence++
    ) {
      rejectProtocol("POSTGRES_HARNESS_IPC_EVENT_REJECTED");
      return;
    }
    if (
      message.type === "harness-init-accepted" &&
      message.sequence === 0 &&
      Object.keys(message).sort().join(",") ===
        "capabilityToken,occurrenceId,schemaVersion,sequence,type"
    ) {
      clearTimeout(ackTimer);
      ownership.ipcOccurrenceId = occurrenceId;
      resolveAck();
      return;
    }
    if (
      message.type === "harness-phase" &&
      Object.keys(message).sort().join(",") ===
        "capabilityToken,occurrenceId,phase,schemaVersion,sequence,type" &&
      /^[a-z][a-z0-9_]{0,62}$/.test(message.phase || "")
    ) {
      phases.push(message.phase);
      return;
    }
    if (
      message.type === "harness-process-spawn" &&
      Object.keys(message).sort().join(",") ===
        "authority,capabilityToken,occurrenceId,pid,role,schemaVersion,sequence,type"
    ) {
      try {
        registerAuthenticatedDescendant(ownership, message, environment);
        child.send({
          schemaVersion: IPC_SCHEMA_VERSION,
          type: "harness-process-accepted",
          occurrenceId,
          capabilityToken,
          pid: message.pid,
        });
      } catch {
        rejectProtocol("POSTGRES_HARNESS_IPC_PROCESS_EVENT_REJECTED");
      }
      return;
    }
    rejectProtocol("POSTGRES_HARNESS_IPC_EVENT_REJECTED");
  };
  child.on("message", onChildMessage);
  child.once("close", () => {
    clearTimeout(ackTimer);
    child.off("message", onChildMessage);
    if (!ownership.ipcOccurrenceId) {
      rejectAck(new Error("POSTGRES_HARNESS_IPC_REJECTED"));
    }
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
  let cleanupStarted = false;
  let cleanupResult = "not_required";
  let cleanupDetails;
  let deadlineFired = false;
  let aliveAtDeadline = false;
  let closedBeforeDeadline = false;
  let cleanupTrigger = "close";
  try {
    await ackPromise;
    while (!closed && performance.now() < executionDeadline) {
      await assertOwnedRootIdentity(rootIdentity);
      if (protocolError) throw protocolError;
      if (phases.at(-1) === "cleanup_required") break;
      await delay(50);
    }
    if (!closed && performance.now() >= executionDeadline) {
      deadlineFired = true;
      aliveAtDeadline = isProcessAlive(ownership.harnessPid);
      cleanupTrigger = "deadline";
    } else if (!closed && phases.at(-1) === "cleanup_required") {
      cleanupTrigger = "phase";
    } else {
      closedBeforeDeadline = Boolean(closed);
      await closePromise;
      cleanupTrigger = mode === "integration" ? "close" : "exit";
    }

    if (mode !== "integration") {
      const observation = {
        mode,
        phases: [...phases],
        protocolAuthenticated:
          ownership.ipcOccurrenceId === occurrenceId && !protocolError,
        deadlineFired,
        aliveAtDeadline,
        closedBeforeDeadline,
        cleanupTrigger,
        close: closed || (deadlineFired ? undefined : await closePromise),
      };
      const terminal = evaluateParentObservedFaultForTests(observation);
      if (faultControl !== "none" || !terminal.accepted) {
        throw new Error("POSTGRES_HARNESS_FAULT_ORACLE_REJECTED");
      }
      cleanupStarted = true;
      cleanupDetails = await cleanupOwnedHarness(
        ownership,
        environment,
        child,
        closePromise
      );
      cleanupResult = cleanupDetails.result;
      return {
        schemaVersion: RESULT_SCHEMA_VERSION,
        occurrenceId,
        mode,
        phaseSequence: [...phases],
        intendedFaultReached: true,
        terminalReason: terminal.terminalReason,
        parentObservation: {
          deadlineFired,
          aliveAtDeadline,
          closedBeforeDeadline,
          cleanupTrigger,
          exitCode: observation.close?.code ?? null,
          signal: observation.close?.signal ?? null,
        },
        environmentIsolation: {
          sourceSeparated: true,
          cleanupProbe: true,
          temporaryRootOwned: true,
        },
        cleanup: {
          attempted: cleanupStarted,
          result: cleanupResult,
          terminatedCount: cleanupDetails.terminatedCount,
        },
        residue: { process: 0, listener: 0, directory: 0 },
      };
    }

    if (closed?.code !== 0 || closed?.signal) {
      throw new Error("POSTGRES_HARNESS_INTEGRATION_CHILD_FAILED");
    }
    const result = parseChildOutput(stdout);
    if (result.occurrenceId !== occurrenceId || result.mode !== mode) {
      throw new Error("POSTGRES_HARNESS_RESULT_OWNERSHIP_MISMATCH");
    }
    cleanupStarted = true;
    cleanupDetails = await cleanupOwnedHarness(
      ownership,
      environment,
      child,
      closePromise
    );
    cleanupResult = cleanupDetails.result;
    return {
      ...result,
      cleanup: {
        attempted: cleanupStarted,
        result: cleanupResult,
        terminatedCount: cleanupDetails.terminatedCount,
      },
      residue: { process: 0, listener: 0, directory: 0 },
      stderrObserved: stderr.length > 0,
    };
  } finally {
    clearTimeout(ackTimer);
    child.off("message", onChildMessage);
    if (!cleanupStarted && existsSync(root)) {
      cleanupStarted = true;
      await cleanupOwnedHarness(ownership, environment, child, closePromise);
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
        if (message.rootIdentity.occurrenceId !== message.occurrenceId) {
          throw new Error("POSTGRES_HARNESS_ROOT_OCCURRENCE_MISMATCH");
        }
        await validateRootClaim(
          message.rootIdentity,
          message.occurrenceId,
          message.capabilityToken,
          "harness"
        );
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
          capabilityToken: message.capabilityToken,
          sequence: 0,
        });
        resolveConfiguration({
          mode: message.mode,
          faultControl: message.faultControl,
          occurrenceId: message.occurrenceId,
          root: message.rootIdentity.root,
          rootIdentity: message.rootIdentity,
          dataDirectory: join(message.rootIdentity.root, "database"),
          port: message.port,
          parentPid: message.parentPid,
          capabilityToken: message.capabilityToken,
        });
      }, 25);
    };
    process.on("message", onMessage);
  });
}

async function sendHarnessIpc(configuration, message) {
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("POSTGRES_HARNESS_IPC_REQUIRED");
  }
  await new Promise((resolveSend, rejectSend) => {
    process.send(
      {
        schemaVersion: IPC_SCHEMA_VERSION,
        occurrenceId: configuration.occurrenceId,
        capabilityToken: configuration.capabilityToken,
        sequence: ++configuration.eventSequence,
        ...message,
      },
      (error) => (error ? rejectSend(error) : resolveSend())
    );
  });
}

async function createEventWriter(configuration) {
  await assertOwnedRootIdentity(configuration.rootIdentity);
  const state = {
    phase: "created",
    phaseSequence: ["created"],
    ownedPids: [],
  };
  configuration.eventSequence = 0;
  const writePhase = async (phase) => {
    await assertOwnedRootIdentity(configuration.rootIdentity);
    if (typeof phase !== "string" || phase === state.phase) {
      throw new Error("POSTGRES_HARNESS_PHASE_REJECTED");
    }
    state.phase = phase;
    state.phaseSequence.push(phase);
    await sendHarnessIpc(configuration, {
      type: "harness-phase",
      phase,
    });
    await assertOwnedRootIdentity(configuration.rootIdentity);
  };
  const registerProcess = async (pid, role) => {
    assertPositivePid(pid);
    let resolveAccepted;
    let rejectAccepted;
    const accepted = new Promise((resolveValue, rejectValue) => {
      resolveAccepted = resolveValue;
      rejectAccepted = rejectValue;
    });
    const timer = setTimeout(
      () => rejectAccepted(new Error("POSTGRES_HARNESS_PROCESS_ACK_TIMEOUT")),
      5_000
    );
    const onMessage = (message) => {
      if (
        !message ||
        Object.keys(message).sort().join(",") !==
          "capabilityToken,occurrenceId,pid,schemaVersion,type" ||
        message.schemaVersion !== IPC_SCHEMA_VERSION ||
        message.type !== "harness-process-accepted" ||
        message.occurrenceId !== configuration.occurrenceId ||
        message.capabilityToken !== configuration.capabilityToken ||
        message.pid !== pid
      ) {
        return;
      }
      clearTimeout(timer);
      process.off("message", onMessage);
      resolveAccepted();
    };
    process.on("message", onMessage);
    await sendHarnessIpc(configuration, {
      type: "harness-process-spawn",
      authority: "authenticated-ipc",
      pid,
      role,
    });
    await accepted;
    state.ownedPids.push(pid);
  };
  await sendHarnessIpc(configuration, {
    type: "harness-phase",
    phase: "created",
  });
  return { state, writePhase, registerProcess };
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

async function waitForClusterProcess(cluster, eventWriter) {
  const deadline = Date.now() + POSTGRES_HARNESS_TIMEOUTS.startSpawn;
  while (Date.now() < deadline) {
    const pid = cluster.process?.pid;
    if (Number.isSafeInteger(pid) && pid > 0) {
      await eventWriter.registerProcess(pid, "postgres");
      await eventWriter.writePhase("start_spawned");
      return pid;
    }
    await delay(20);
  }
  throw new Error("POSTGRES_HARNESS_START_SPAWN_TIMEOUT");
}

async function receiveCleanupWorkerConfiguration() {
  if (
    process.argv.slice(2).length !== 1 ||
    process.argv[2] !== "--cleanup-worker" ||
    typeof process.send !== "function" ||
    !process.connected
  ) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_IPC_REQUIRED");
  }
  return await new Promise((resolveConfiguration, rejectConfiguration) => {
    const timer = setTimeout(
      () => rejectConfiguration(new Error("POSTGRES_HARNESS_CLEANUP_INIT_TIMEOUT")),
      5_000
    );
    const onMessage = async (message) => {
      const expectedKeys = [
        "budgetMilliseconds",
        "capabilityToken",
        "cleanupFault",
        "harnessPid",
        "ipcCapabilitySha256",
        "occurrenceId",
        "parentPid",
        "port",
        "registry",
        "rootIdentity",
        "schemaVersion",
        "type",
      ];
      if (
        !message ||
        Object.keys(message).sort().join(",") !== expectedKeys.sort().join(",") ||
        message.schemaVersion !== IPC_SCHEMA_VERSION ||
        message.type !== "cleanup-init" ||
        message.parentPid !== process.ppid ||
        !OCCURRENCE_ID.test(message.occurrenceId || "") ||
        typeof message.capabilityToken !== "string" ||
        !Number.isSafeInteger(message.harnessPid) ||
        message.harnessPid <= 0 ||
        !/^[0-9a-f]{64}$/.test(message.ipcCapabilitySha256 || "") ||
        !Number.isSafeInteger(message.port) ||
        message.port < 1 ||
        message.port > 65_535 ||
        !Array.isArray(message.registry) ||
        message.registry.length > 4 ||
        !Number.isFinite(message.budgetMilliseconds) ||
        message.budgetMilliseconds <= 0 ||
        message.budgetMilliseconds > POSTGRES_HARNESS_TIMEOUTS.forcedCleanup ||
        ![
          "none",
          "port",
          "lstat",
          "readdir",
          "unlink",
          "rmdir",
          "process-query",
          "utility",
        ].includes(message.cleanupFault)
      ) {
        clearTimeout(timer);
        rejectConfiguration(new Error("POSTGRES_HARNESS_CLEANUP_INIT_REJECTED"));
        return;
      }
      try {
        await validateRootClaim(
          message.rootIdentity,
          message.occurrenceId,
          message.capabilityToken,
          "cleanup"
        );
      } catch {
        clearTimeout(timer);
        rejectConfiguration(new Error("POSTGRES_HARNESS_CLEANUP_INIT_REJECTED"));
        return;
      }
      clearTimeout(timer);
      process.off("message", onMessage);
      resolveConfiguration(message);
    };
    process.on("message", onMessage);
  });
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

async function spawnFaultWorker(configuration, eventWriter) {
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
  await eventWriter.registerProcess(worker.pid, "fault-worker");
  await eventWriter.writePhase("start_spawned");
  return worker;
}

async function runChild(configuration) {
  assertSanitizedEnvironment(process.env);
  await assertOwnedRootIdentity(configuration.rootIdentity);
  assertEnvironmentBoundToOwnedRoot(process.env, configuration.rootIdentity.root);
  const eventWriter = await createEventWriter(configuration);
  const cleanupChildEnvironmentIsolated = runCleanupEnvironmentProbe(process.env);
  if (!cleanupChildEnvironmentIsolated) {
    throw new Error("POSTGRES_HARNESS_CLEANUP_ENVIRONMENT_REJECTED");
  }

  if (configuration.mode !== "integration") {
    if (configuration.faultControl === "early-failure") {
      await eventWriter.writePhase("early_control_failure");
      throw new Error("POSTGRES_HARNESS_CONTROLLED_EARLY_FAILURE");
    }
    await spawnFaultWorker(configuration, eventWriter);
    if (configuration.mode === "ready_hang") {
      await eventWriter.writePhase("ready_pending");
      return new Promise(() => undefined);
    }
    if (configuration.mode === "stop_hang") {
      await eventWriter.writePhase("ready");
      await eventWriter.writePhase("stopping");
      return new Promise(() => undefined);
    }
    if (configuration.mode === "partial_start_throw") {
      await eventWriter.writePhase("partial_start_failure");
      throw new Error("POSTGRES_HARNESS_FAULT_PARTIAL_START");
    }
    await eventWriter.writePhase("child_crash");
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
    await eventWriter.writePhase("initialising");
    await withinDeadline(
      () => cluster.initialise(),
      POSTGRES_HARNESS_TIMEOUTS.initialise,
      "POSTGRES_HARNESS_INITIALISE_TIMEOUT"
    );
    await eventWriter.writePhase("starting");
    const startPromise = cluster.start();
    void startPromise.catch(() => undefined);
    await waitForClusterProcess(cluster, eventWriter);
    await withinDeadline(
      () => startPromise,
      POSTGRES_HARNESS_TIMEOUTS.ready,
      "POSTGRES_HARNESS_READY_TIMEOUT"
    );
    await eventWriter.writePhase("ready");
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
      await eventWriter.writePhase("cleanup_required");
      return new Promise(() => undefined);
    }
  }

  await eventWriter.writePhase("stopping");
  const postgresRootPids = [...eventWriter.state.ownedPids];
  try {
    await withinDeadline(
      () => cluster.stop(),
      POSTGRES_HARNESS_TIMEOUTS.stop,
      "POSTGRES_HARNESS_STOP_TIMEOUT"
    );
  } catch {
    await eventWriter.writePhase("cleanup_required");
    return new Promise(() => undefined);
  }
  const normalStopDeadline = createCleanupDeadline(5_000);
  const normalStopComplete =
    postgresRootPids.every((pid) => !isProcessAlive(pid)) &&
    (await waitForPortRelease(configuration.port, normalStopDeadline));
  if (!normalStopComplete) {
    await eventWriter.writePhase("cleanup_required");
    return new Promise(() => undefined);
  }
  eventWriter.state.ownedPids = [];
  await eventWriter.writePhase("stopped");

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
    if (process.argv[2] === "--cleanup-worker") {
      const configuration = await receiveCleanupWorkerConfiguration();
      await performCleanupWorker(configuration);
    } else {
      const configuration = await receiveChildConfiguration();
      await runChild(configuration);
    }
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
