"use strict";

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
const crypto = process.getBuiltinModule("crypto");
if (!fs || !path || !crypto) {
  throw new Error("GUARD_MARKER_BUILTIN_MODULE_REQUIRED");
}
const { randomUUID } = crypto;

const MARKER_SCHEMA_VERSION = 1;
const MARKER_VERSION = 2;
const EXPECTED_PROBE_OPERATION = "dns";
const EXPECTED_PROBE_VIOLATION_COUNT = 1;
const PROCESS_OCCURRENCE_KEY = Symbol.for(
  "actustube.testNetworkGuard.processOccurrence"
);
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROBE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NEGATIVE_FIXTURE_ROOT_KEY =
  "ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT";
const NEGATIVE_FIXTURE_CHILD_KEY =
  "ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD";
const NEGATIVE_FIXTURE_SEGMENTS = Object.freeze([
  "negative-fixtures",
  "ordinary-guarded-dns-unexpected",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NORMAL_PROCESS_ROLES = new Set([
  "corepack",
  "npm",
  "drizzle-kit",
  "node-child",
]);
const MARKER_ROLES = new Set([
  ...NORMAL_PROCESS_ROLES,
  "guard-config-offline",
  "guard-config-credential-proxy",
  "guard-config-credential-auth",
  "guard-config-credential-user",
  "guard-config-credential-proxy-auth",
  "guard-config-credential-proxy-user",
  "guard-config-credential-auth-user",
  "guard-config-credential-proxy-auth-user",
  "guard-config-credential-unknown",
  "network_violation",
]);
const ALLOWED_PAYLOAD_FIELDS = Object.freeze([
  "schemaVersion",
  "runId",
  "occurrenceId",
  "role",
  "pid",
  "ppid",
  "createdAt",
  "markerVersion",
]);

class GuardMarkerError extends Error {
  constructor(code) {
    super(code);
    this.name = "GuardMarkerError";
    this.code = code;
  }
}

function fail(code) {
  throw new GuardMarkerError(code);
}

function validateRunId(runId) {
  if (
    typeof runId !== "string" ||
    !RUN_ID_PATTERN.test(runId) ||
    runId.includes("..") ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    fail("GUARD_MARKER_RUN_ID_INVALID");
  }
  return runId;
}

function validateProbeId(probeId) {
  if (
    typeof probeId !== "string" ||
    !PROBE_ID_PATTERN.test(probeId) ||
    probeId.includes("..") ||
    probeId.includes("/") ||
    probeId.includes("\\")
  ) {
    fail("GUARD_EXPECTED_PROBE_ID_INVALID");
  }
  return probeId;
}

function validateRole(role) {
  if (typeof role !== "string" || !MARKER_ROLES.has(role)) {
    fail("GUARD_MARKER_ROLE_INVALID");
  }
  return role;
}

function validateOccurrenceId(occurrenceId) {
  if (typeof occurrenceId !== "string" || !UUID_PATTERN.test(occurrenceId)) {
    fail("GUARD_MARKER_OCCURRENCE_ID_INVALID");
  }
  return occurrenceId;
}

function validatePid(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function validateMarkerDirectory(markerDirectory) {
  if (
    typeof markerDirectory !== "string" ||
    !path.isAbsolute(markerDirectory) ||
    markerDirectory.split(/[\\/]/).includes("..")
  ) {
    fail("GUARD_MARKER_DIRECTORY_REQUIRED");
  }
  return markerDirectory;
}

function assertNoSymlinkComponents(targetPath) {
  const resolved = path.resolve(validateMarkerDirectory(targetPath));
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      fail("GUARD_EVIDENCE_PATH_UNAVAILABLE");
    }
    if (stats.isSymbolicLink()) fail("GUARD_EVIDENCE_SYMLINK_REJECTED");
  }
  return resolved;
}

function ensureDirectory(rootDirectory, segments) {
  const root = assertNoSymlinkComponents(rootDirectory);
  let rootStats;
  try {
    rootStats = fs.lstatSync(root);
  } catch {
    fail("GUARD_EVIDENCE_RUN_ROOT_REQUIRED");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail("GUARD_EVIDENCE_RUN_ROOT_INVALID");
  }

  let current = root;
  for (const segment of segments) {
    const candidate = path.resolve(current, segment);
    const relative = path.relative(root, candidate);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("GUARD_EVIDENCE_PATH_ESCAPE");
    }
    try {
      fs.mkdirSync(candidate, { recursive: false });
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        fail("GUARD_EVIDENCE_DIRECTORY_CREATE_FAILED");
      }
    }
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch {
      fail("GUARD_EVIDENCE_PATH_UNAVAILABLE");
    }
    if (stats.isSymbolicLink()) fail("GUARD_EVIDENCE_SYMLINK_REJECTED");
    if (!stats.isDirectory()) fail("GUARD_EVIDENCE_DIRECTORY_INVALID");
    current = candidate;
  }
  return current;
}

function createGuardEvidenceLayout({
  runRoot,
  probeId,
  environment = process.env,
}) {
  const safeRoot = assertNoSymlinkComponents(runRoot);
  const occurrenceDirectory = ensureDirectory(safeRoot, ["occurrences"]);
  const operationalUnexpectedViolationDirectory = ensureDirectory(safeRoot, [
    "violations",
    "unexpected",
  ]);
  const expectedProbeRoot = ensureDirectory(safeRoot, [
    "violations",
    "expected",
  ]);
  const safeProbeId =
    probeId === undefined || probeId === null
      ? null
      : validateProbeId(probeId);
  const hasNegativeFixtureRoot = Object.hasOwn(
    environment,
    NEGATIVE_FIXTURE_ROOT_KEY
  );
  const hasNegativeFixtureChild = Object.hasOwn(
    environment,
    NEGATIVE_FIXTURE_CHILD_KEY
  );
  if (hasNegativeFixtureRoot !== hasNegativeFixtureChild) {
    fail("GUARD_NEGATIVE_FIXTURE_ENVIRONMENT_INCOMPLETE");
  }
  if (
    hasNegativeFixtureChild &&
    environment[NEGATIVE_FIXTURE_CHILD_KEY] !== "1"
  ) {
    fail("GUARD_NEGATIVE_FIXTURE_CHILD_INVALID");
  }
  if (hasNegativeFixtureRoot && safeProbeId) {
    fail("GUARD_NEGATIVE_FIXTURE_PROBE_CONFLICT");
  }

  let negativeFixtureRoot = null;
  let unexpectedViolationDirectory =
    operationalUnexpectedViolationDirectory;
  if (hasNegativeFixtureRoot) {
    const configuredRoot = environment[NEGATIVE_FIXTURE_ROOT_KEY];
    if (typeof configuredRoot !== "string" || configuredRoot.length === 0) {
      fail("GUARD_NEGATIVE_FIXTURE_ROOT_INVALID");
    }
    const resolvedConfiguredRoot = assertNoSymlinkComponents(configuredRoot);
    const expectedFixtureRoot = path.resolve(
      safeRoot,
      ...NEGATIVE_FIXTURE_SEGMENTS
    );
    const fixtureRelative = path.relative(safeRoot, resolvedConfiguredRoot);
    if (
      resolvedConfiguredRoot !== expectedFixtureRoot ||
      !fixtureRelative ||
      fixtureRelative === ".." ||
      fixtureRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(fixtureRelative) ||
      fixtureRelative.split(path.sep).includes("..")
    ) {
      fail("GUARD_NEGATIVE_FIXTURE_ROOT_INVALID");
    }
    negativeFixtureRoot = ensureDirectory(
      safeRoot,
      NEGATIVE_FIXTURE_SEGMENTS
    );
    unexpectedViolationDirectory = ensureDirectory(safeRoot, [
      ...NEGATIVE_FIXTURE_SEGMENTS,
      "violations",
      "unexpected",
    ]);
  }
  const expectedViolationDirectory = safeProbeId
    ? ensureDirectory(expectedProbeRoot, [safeProbeId])
    : null;
  const evidenceDirectories = [
    occurrenceDirectory,
    operationalUnexpectedViolationDirectory,
    expectedProbeRoot,
    ...(negativeFixtureRoot
      ? [negativeFixtureRoot, unexpectedViolationDirectory]
      : []),
  ].map((directory) => path.resolve(directory));
  if (new Set(evidenceDirectories).size !== evidenceDirectories.length) {
    fail("GUARD_NEGATIVE_FIXTURE_DIRECTORY_COLLISION");
  }
  return {
    runRoot: safeRoot,
    occurrenceDirectory,
    operationalUnexpectedViolationDirectory,
    unexpectedViolationDirectory,
    expectedProbeRoot,
    expectedViolationDirectory,
    negativeFixtureRoot,
    negativeFixtureViolationDirectory: negativeFixtureRoot
      ? unexpectedViolationDirectory
      : null,
    negativeFixtureChild: hasNegativeFixtureChild,
    probeId: safeProbeId,
  };
}

function validateContainedExistingDirectory(rootDirectory, candidateDirectory) {
  const safeRoot = assertNoSymlinkComponents(rootDirectory);
  const safeCandidate = assertNoSymlinkComponents(candidateDirectory);
  const relative = path.relative(safeRoot, safeCandidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    fail("GUARD_EVIDENCE_PATH_ESCAPE");
  }
  let stats;
  try {
    stats = fs.lstatSync(safeCandidate);
  } catch {
    fail("GUARD_EVIDENCE_PATH_UNAVAILABLE");
  }
  if (stats.isSymbolicLink()) fail("GUARD_EVIDENCE_SYMLINK_REJECTED");
  if (!stats.isDirectory()) fail("GUARD_EVIDENCE_DIRECTORY_INVALID");
  return safeCandidate;
}

function validateGuardObserverLayout(runRoot) {
  const safeRoot = assertNoSymlinkComponents(runRoot);
  let rootStats;
  try {
    rootStats = fs.lstatSync(safeRoot);
  } catch {
    fail("GUARD_EVIDENCE_RUN_ROOT_REQUIRED");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail("GUARD_EVIDENCE_RUN_ROOT_INVALID");
  }

  const observerAckRoot = path.resolve(safeRoot, "observer-ack");
  const observerRequestRoot = path.resolve(safeRoot, "observer-request");
  const ackExists = fs.existsSync(observerAckRoot);
  const requestExists = fs.existsSync(observerRequestRoot);
  if (ackExists !== requestExists) {
    fail("GUARD_OBSERVER_LAYOUT_INCOMPLETE");
  }
  if (!ackExists) return null;
  return {
    observerAckRoot: validateContainedExistingDirectory(
      safeRoot,
      observerAckRoot
    ),
    observerRequestRoot: validateContainedExistingDirectory(
      safeRoot,
      observerRequestRoot
    ),
  };
}

function claimExpectedProbe({
  expectedViolationDirectory,
  runId,
  probeId,
  occurrenceId,
  pid = process.pid,
  ppid = process.ppid,
}) {
  const directory = assertNoSymlinkComponents(expectedViolationDirectory);
  const payload = {
    schemaVersion: 1,
    runId: validateRunId(runId),
    probeId: validateProbeId(probeId),
    expectedOperation: EXPECTED_PROBE_OPERATION,
    expectedViolationCount: EXPECTED_PROBE_VIOLATION_COUNT,
    occurrenceId: validateOccurrenceId(occurrenceId),
    pid: validatePid(pid, "GUARD_MARKER_PID_INVALID"),
    ppid: validatePid(ppid, "GUARD_MARKER_PPID_INVALID"),
  };
  const claimPath = path.join(directory, "probe-owner.json");
  let descriptor;
  try {
    descriptor = fs.openSync(claimPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      fail("GUARD_EXPECTED_PROBE_ID_DUPLICATE");
    }
    fail("GUARD_EXPECTED_PROBE_CLAIM_FAILED");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        fail("GUARD_EXPECTED_PROBE_CLAIM_FAILED");
      }
    }
  }
  return { claimPath, payload };
}

function beginProcessOccurrence(
  globalObject = globalThis,
  occurrenceIdFactory = randomUUID
) {
  const existing = globalObject[PROCESS_OCCURRENCE_KEY];
  if (existing) {
    return { firstEvaluation: false, occurrenceId: existing.occurrenceId };
  }
  const occurrenceId = validateOccurrenceId(occurrenceIdFactory());
  globalObject[PROCESS_OCCURRENCE_KEY] = {
    occurrenceId,
    state: "initializing",
  };
  return { firstEvaluation: true, occurrenceId };
}

function markProcessOccurrenceActive(globalObject = globalThis) {
  const state = globalObject[PROCESS_OCCURRENCE_KEY];
  if (!state) fail("GUARD_MARKER_PROCESS_OCCURRENCE_REQUIRED");
  state.state = "active";
}

function createMarker({
  markerDirectory,
  runId,
  occurrenceId = randomUUID(),
  role,
  pid = process.pid,
  ppid = process.ppid,
  createdAt = new Date().toISOString(),
}) {
  const safeDirectory = assertNoSymlinkComponents(markerDirectory);
  const safeRunId = validateRunId(runId);
  const safeOccurrenceId = validateOccurrenceId(occurrenceId);
  const safeRole = validateRole(role);
  const safePid = validatePid(pid, "GUARD_MARKER_PID_INVALID");
  const safePpid = validatePid(ppid, "GUARD_MARKER_PPID_INVALID");
  if (
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    fail("GUARD_MARKER_CREATED_AT_INVALID");
  }

  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    runId: safeRunId,
    occurrenceId: safeOccurrenceId,
    role: safeRole,
    pid: safePid,
    ppid: safePpid,
    createdAt,
    markerVersion: MARKER_VERSION,
  };
  const filename = `${safeRole}-${safePid}-${safeOccurrenceId}.json`;
  const markerPath = path.join(safeDirectory, filename);
  let descriptor;
  try {
    fs.mkdirSync(safeDirectory, { recursive: true });
    assertNoSymlinkComponents(safeDirectory);
    descriptor = fs.openSync(markerPath, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      fail("GUARD_MARKER_OCCURRENCE_COLLISION");
    }
    fail("GUARD_MARKER_WRITE_FAILED");
  }

  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch {
    fail("GUARD_MARKER_WRITE_FAILED");
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      fail("GUARD_MARKER_CLOSE_FAILED");
    }
  }
  return { filename, markerPath, payload };
}

function analyzeOccurrenceCompleteness({ launches, markers, runId }) {
  const safeRunId = validateRunId(runId);
  if (!Array.isArray(launches) || !Array.isArray(markers)) {
    fail("GUARD_MARKER_COMPLETENESS_INPUT_INVALID");
  }
  const launchCounts = new Map();
  const launchesByOccurrenceId = new Map();
  for (const launch of launches) {
    const pid = validatePid(launch?.pid, "GUARD_MARKER_PID_INVALID");
    const ppid = validatePid(launch?.ppid, "GUARD_MARKER_PPID_INVALID");
    const occurrenceId = validateOccurrenceId(launch?.occurrenceId);
    const role = validateRole(launch?.role);
    if (!NORMAL_PROCESS_ROLES.has(role)) {
      fail("GUARD_MARKER_ROLE_INVALID");
    }
    if (launchesByOccurrenceId.has(occurrenceId)) {
      fail("GUARD_LAUNCH_OCCURRENCE_ID_DUPLICATE");
    }
    launchesByOccurrenceId.set(occurrenceId, { pid, ppid, role });
    launchCounts.set(pid, (launchCounts.get(pid) ?? 0) + 1);
  }

  const markerCounts = new Map();
  const occurrenceIds = new Set();
  let duplicateOccurrenceIdCount = 0;
  let runIdMismatchCount = 0;
  let roleMismatchCount = 0;
  let occurrenceBindingMismatchCount = 0;
  for (const marker of markers) {
    if (
      !marker ||
      typeof marker !== "object" ||
      Array.isArray(marker) ||
      Object.getPrototypeOf(marker) !== Object.prototype ||
      Object.keys(marker).length !== ALLOWED_PAYLOAD_FIELDS.length ||
      !ALLOWED_PAYLOAD_FIELDS.every((field) => Object.hasOwn(marker, field)) ||
      marker.schemaVersion !== MARKER_SCHEMA_VERSION ||
      marker.markerVersion !== MARKER_VERSION ||
      typeof marker.createdAt !== "string" ||
      !Number.isFinite(Date.parse(marker.createdAt))
    ) {
      fail("GUARD_MARKER_PAYLOAD_INVALID");
    }
    const pid = validatePid(marker?.pid, "GUARD_MARKER_PID_INVALID");
    validatePid(marker.ppid, "GUARD_MARKER_PPID_INVALID");
    validateRunId(marker.runId);
    validateOccurrenceId(marker.occurrenceId);
    validateRole(marker.role);
    markerCounts.set(pid, (markerCounts.get(pid) ?? 0) + 1);
    if (marker.runId !== safeRunId) runIdMismatchCount++;
    if (!NORMAL_PROCESS_ROLES.has(marker.role)) roleMismatchCount++;
    if (occurrenceIds.has(marker.occurrenceId)) duplicateOccurrenceIdCount++;
    occurrenceIds.add(marker.occurrenceId);
    const launch = launchesByOccurrenceId.get(marker.occurrenceId);
    if (
      launch &&
      (launch.pid !== marker.pid ||
        launch.ppid !== marker.ppid ||
        launch.role !== marker.role)
    ) {
      occurrenceBindingMismatchCount++;
    }
  }

  const pids = new Set([...launchCounts.keys(), ...markerCounts.keys()]);
  const missingMarkerOccurrenceCount = [...launchesByOccurrenceId.keys()].filter(
    (occurrenceId) => !occurrenceIds.has(occurrenceId)
  ).length;
  const orphanMarkerOccurrenceCount = [...occurrenceIds].filter(
    (occurrenceId) => !launchesByOccurrenceId.has(occurrenceId)
  ).length;
  const perPid = [...pids]
    .sort((left, right) => left - right)
    .map((pid) => {
      const launchOccurrenceCount = launchCounts.get(pid) ?? 0;
      const markerOccurrenceCount = markerCounts.get(pid) ?? 0;
      const missing = Math.max(
        launchOccurrenceCount - markerOccurrenceCount,
        0
      );
      const orphan = Math.max(
        markerOccurrenceCount - launchOccurrenceCount,
        0
      );
      return {
        pid,
        launchOccurrenceCount,
        markerOccurrenceCount,
        missingMarkerOccurrenceCount: missing,
        orphanMarkerOccurrenceCount: orphan,
      };
    });

  const result = {
    launchOccurrenceCount: launches.length,
    markerOccurrenceCount: markers.length,
    uniqueLaunchPidCount: launchCounts.size,
    uniqueMarkerPidCount: markerCounts.size,
    missingMarkerOccurrenceCount,
    orphanMarkerOccurrenceCount,
    duplicateOccurrenceIdCount,
    runIdMismatchCount,
    roleMismatchCount,
    occurrenceBindingMismatchCount,
    perPid,
  };
  return {
    ...result,
    complete:
      missingMarkerOccurrenceCount === 0 &&
      orphanMarkerOccurrenceCount === 0 &&
      duplicateOccurrenceIdCount === 0 &&
      runIdMismatchCount === 0 &&
      roleMismatchCount === 0 &&
      occurrenceBindingMismatchCount === 0,
  };
}

function summarizeGuardedNodeNetworkEvents({
  unexpectedViolationEvents,
  expectedBlockedDnsProbeEvents,
}) {
  for (const events of [
    unexpectedViolationEvents,
    expectedBlockedDnsProbeEvents,
  ]) {
    if (!Array.isArray(events)) {
      fail("GUARD_NETWORK_EVENT_INVENTORY_INVALID");
    }
  }
  return {
    guardedNodeApiUnexpectedViolation: unexpectedViolationEvents.length,
    expectedBlockedDnsProbe: expectedBlockedDnsProbeEvents.length,
    successfulGuardedNodeApiExternalConnection: "NOT VERIFIED",
    nativeChildExternalConnection: "NOT VERIFIED",
  };
}

module.exports = {
  ALLOWED_PAYLOAD_FIELDS,
  EXPECTED_PROBE_OPERATION,
  EXPECTED_PROBE_VIOLATION_COUNT,
  GuardMarkerError,
  NORMAL_PROCESS_ROLES,
  analyzeOccurrenceCompleteness,
  beginProcessOccurrence,
  claimExpectedProbe,
  createGuardEvidenceLayout,
  createMarker,
  markProcessOccurrenceActive,
  summarizeGuardedNodeNetworkEvents,
  validateGuardObserverLayout,
  validateOccurrenceId,
  validateProbeId,
  validateRole,
  validateRunId,
};
