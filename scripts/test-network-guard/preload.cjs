"use strict";

const net = process.getBuiltinModule("net");
const tls = process.getBuiltinModule("tls");
const dgram = process.getBuiltinModule("dgram");
const dns = process.getBuiltinModule("dns");
const dnsPromises = process.getBuiltinModule("dns/promises");
const crypto = process.getBuiltinModule("crypto");
const nodeModule = process.getBuiltinModule("module");
const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
if (
  !net ||
  !tls ||
  !dgram ||
  !dns ||
  !dnsPromises ||
  !crypto ||
  !fs ||
  !path ||
  !nodeModule ||
  typeof nodeModule.syncBuiltinESMExports !== "function"
) {
  throw new Error("NETWORK_GUARD_BUILTIN_MODULE_REQUIRED");
}
const { randomUUID } = crypto;

const {
  EXPECTED_PROBE_OPERATION,
  EXPECTED_PROBE_VIOLATION_COUNT,
  beginProcessOccurrence,
  claimExpectedProbe,
  createGuardEvidenceLayout,
  createMarker,
  markProcessOccurrenceActive,
  validateGuardObserverLayout,
  validateRunId,
} = module.require("./marker.cjs");

const occurrence = beginProcessOccurrence();
if (!occurrence.firstEvaluation) {
  return;
}

const runRoot = process.env.ACTUSTUBE_NETWORK_GUARD_MARKER_DIR;
const runId = process.env.ACTUSTUBE_NETWORK_GUARD_RUN_ID;
const probeId = process.env.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_ID;
const expectedProbeChild =
  process.env.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_CHILD === "1";
if (!runRoot) {
  throw new Error("NETWORK_GUARD_MARKER_DIRECTORY_REQUIRED");
}
try {
  validateRunId(runId);
} catch {
  throw new Error("NETWORK_GUARD_RUN_ID_REQUIRED");
}

let observerLayout;
let evidenceLayout;
try {
  observerLayout = validateGuardObserverLayout(runRoot);
  evidenceLayout = createGuardEvidenceLayout({ runRoot, probeId });
} catch {
  throw new Error("NETWORK_GUARD_EVIDENCE_LAYOUT_INVALID");
}

if (observerLayout) {
  const observerRequestId = randomUUID();
  const observerRequestName = `${process.pid}-${observerRequestId}`;
  const observerRequestPath = path.join(
    observerLayout.observerRequestRoot,
    `${observerRequestName}.request`
  );
  const observerAckPath = path.join(
    observerLayout.observerAckRoot,
    `${observerRequestName}.ack`
  );
  fs.writeFileSync(observerRequestPath, "observe", { flag: "wx" });
  const observerAckDeadline = Date.now() + 5_000;
  while (!fs.existsSync(observerAckPath) && Date.now() < observerAckDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(observerAckPath)) {
    throw new Error("NETWORK_GUARD_OBSERVER_ACK_REQUIRED");
  }
}

const commandText = process.argv.slice(0, 3).join(" ").toLowerCase();
const role = commandText.includes("corepack")
  ? "corepack"
  : commandText.includes("npm-cli")
    ? "npm"
    : commandText.includes("drizzle")
      ? "drizzle-kit"
      : "node-child";

function writeMarker(
  markerDirectory,
  markerRole,
  occurrenceId = occurrence.occurrenceId
) {
  return createMarker({
    markerDirectory,
    runId,
    occurrenceId,
    role: markerRole,
    pid: process.pid,
    ppid: process.ppid,
  });
}

writeMarker(evidenceLayout.occurrenceDirectory, role);
markProcessOccurrenceActive();

if (Boolean(probeId) !== expectedProbeChild) {
  throw new Error("NETWORK_GUARD_EXPECTED_PROBE_CHILD_REQUIRED");
}

if (evidenceLayout.probeId) {
  try {
    claimExpectedProbe({
      expectedViolationDirectory: evidenceLayout.expectedViolationDirectory,
      runId,
      probeId: evidenceLayout.probeId,
      occurrenceId: occurrence.occurrenceId,
      pid: process.pid,
      ppid: process.ppid,
    });
  } catch {
    throw new Error("NETWORK_GUARD_EXPECTED_PROBE_CLAIM_REJECTED");
  }
}

function rejectConfiguration(markerRole, code) {
  writeMarker(
    evidenceLayout.unexpectedViolationDirectory,
    markerRole,
    randomUUID()
  );
  throw new Error(code);
}

const requiredEnvironment = {
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};
for (const [key, expected] of Object.entries(requiredEnvironment)) {
  if (process.env[key] !== expected) {
    rejectConfiguration(
      "guard-config-offline",
      "NETWORK_GUARD_OFFLINE_CONFIGURATION_REQUIRED"
    );
  }
}

const forbiddenCredentialKeys = Object.keys(process.env).filter(
  (key) =>
    /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(
      key
    ) ||
    /(?:^|_)proxy$/i.test(key) ||
    /(?:authToken|_auth)$/i.test(key) ||
    /^npm_config_.*(?:password|username)$/i.test(key)
);
if (forbiddenCredentialKeys.length > 0) {
  const categories = [
    forbiddenCredentialKeys.some((key) => /proxy/i.test(key)) ? "proxy" : null,
    forbiddenCredentialKeys.some((key) => /token|auth/i.test(key))
      ? "auth"
      : null,
    forbiddenCredentialKeys.some((key) => /password|username/i.test(key))
      ? "user"
      : null,
  ]
    .filter(Boolean)
    .join("-");
  rejectConfiguration(
    `guard-config-credential-${categories || "unknown"}`,
    "NETWORK_GUARD_CREDENTIAL_ENVIRONMENT_REJECTED"
  );
}

let expectedProbeViolationCount = 0;

function rejectNetwork(code) {
  let violationDirectory = evidenceLayout.unexpectedViolationDirectory;
  let rejectionCode = code;
  if (evidenceLayout.probeId) {
    if (
      code === "DNS_NETWORK_REJECTED" &&
      EXPECTED_PROBE_OPERATION === "dns" &&
      expectedProbeViolationCount < EXPECTED_PROBE_VIOLATION_COUNT
    ) {
      expectedProbeViolationCount += 1;
      violationDirectory = evidenceLayout.expectedViolationDirectory;
    } else {
      violationDirectory =
        evidenceLayout.operationalUnexpectedViolationDirectory;
      rejectionCode =
        code === "DNS_NETWORK_REJECTED"
          ? "NETWORK_GUARD_EXPECTED_PROBE_COUNT_EXCEEDED"
          : "NETWORK_GUARD_EXPECTED_PROBE_OPERATION_MISMATCH";
    }
  }
  writeMarker(violationDirectory, "network_violation", randomUUID());
  throw new Error(rejectionCode);
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]"]);

function isPipe(value) {
  return typeof value === "string" && !/^\d+$/.test(value);
}

function connectionHost(argumentsList) {
  const first = argumentsList[0];
  if (Array.isArray(first)) return connectionHost(first);
  if (isPipe(first)) return { pipe: true, host: null };
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return { pipe: true, host: null };
    return { pipe: false, host: first.host ?? first.hostname ?? null };
  }
  return {
    pipe: false,
    host: typeof argumentsList[1] === "string" ? argumentsList[1] : null,
  };
}

function requireLoopback(argumentsList, code) {
  const target = connectionHost(argumentsList);
  if (!target.pipe && !loopbackHosts.has(target.host)) {
    rejectNetwork(code);
  }
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...argumentsList) {
  requireLoopback(argumentsList, "NON_LOOPBACK_TCP_REJECTED");
  return originalSocketConnect.apply(this, argumentsList);
};

const originalTlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...argumentsList) {
  requireLoopback(argumentsList, "NON_LOOPBACK_TLS_REJECTED");
  return originalTlsConnect.apply(this, argumentsList);
};

const originalServerListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...argumentsList) {
  requireLoopback(argumentsList, "NON_LOOPBACK_LISTENER_REJECTED");
  return originalServerListen.apply(this, argumentsList);
};

dgram.Socket.prototype.connect = function blockedDatagramConnect() {
  rejectNetwork("DATAGRAM_NETWORK_REJECTED");
};
dgram.Socket.prototype.send = function blockedDatagramSend() {
  rejectNetwork("DATAGRAM_NETWORK_REJECTED");
};
dgram.Socket.prototype.bind = function blockedDatagramBind() {
  rejectNetwork("DATAGRAM_NETWORK_REJECTED");
};

const dnsMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
const resolverMethods = dnsMethods.filter(
  (method) => method !== "lookup" && method !== "lookupService"
);

function blockedDnsOperation() {
  rejectNetwork("DNS_NETWORK_REJECTED");
}

function blockedDnsPromiseOperation() {
  try {
    rejectNetwork("DNS_NETWORK_REJECTED");
  } catch (error) {
    return Promise.reject(error);
  }
}

for (const method of dnsMethods) {
  if (typeof dns[method] === "function") {
    dns[method] = blockedDnsOperation;
  }
  if (typeof dnsPromises[method] === "function") {
    dnsPromises[method] = blockedDnsPromiseOperation;
  }
}

for (const method of resolverMethods) {
  if (typeof dns.Resolver?.prototype?.[method] === "function") {
    dns.Resolver.prototype[method] = blockedDnsOperation;
  }
  if (typeof dnsPromises.Resolver?.prototype?.[method] === "function") {
    dnsPromises.Resolver.prototype[method] = blockedDnsPromiseOperation;
  }
}

nodeModule.syncBuiltinESMExports();

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("verbatim");
}
