import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const BENIGN_CHILD_SCHEMA_VERSION = 1;
const BENIGN_CHILD_TIMEOUT_MS = 2_000;
const BENIGN_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
]);

class FaultLifecycleIssue extends Error {
  constructor(code) {
    super(code);
    this.name = "FaultLifecycleIssue";
    this.code = code;
  }
}

function requireFaultLifecycle(condition, code) {
  if (!condition) throw new FaultLifecycleIssue(code);
}

function createBenignChildEnvironment() {
  return Object.fromEntries(
    BENIGN_ENVIRONMENT_KEYS.flatMap((key) =>
      typeof process.env[key] === "string" ? [[key, process.env[key]]] : []
    )
  );
}

const BENIGN_CHILD_SOURCE = String.raw`
const SCHEMA = 1;
let initialized = false;
let sequence = 0;
let binding;
let lastMessage;
const exactMessage = (phase) => ({
  schemaVersion: SCHEMA,
  occurrenceId: binding.occurrenceId,
  capabilityToken: binding.capabilityToken,
  sequence: ++sequence,
  phase,
});
const send = (phase) => new Promise((resolveSend) => {
  lastMessage = exactMessage(phase);
  process.send(lastMessage, resolveSend);
});
const sendRaw = (message) => new Promise((resolveSend) => {
  process.send(message, resolveSend);
});
process.once('message', async (message) => {
  if (initialized || !message || message.schemaVersion !== SCHEMA) process.exit(79);
  initialized = true;
  binding = message;
  const mode = binding.mode;
  if (mode === 'pre-phase-failure') process.exit(73);
  await send('created');
  if (mode === 'duplicate-phase') {
    await sendRaw(lastMessage);
    process.exit(70);
  }
  if (mode === 'malformed-phase') {
    await sendRaw({ phase: 'running' });
    process.exit(70);
  }
  if (mode === 'replayed-phase') {
    await send('running');
    await sendRaw({ ...lastMessage, sequence: 1 });
    process.exit(70);
  }
  if (mode === 'correct-signal' || mode === 'wrong-signal') {
    await send('signal_ready');
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'deadline') {
    await send('deadline_pending');
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'normal-before-deadline') {
    await send('deadline_pending');
    process.exit(0);
  }
  await send('running');
  if (mode === 'unexpected-normal-after-phase') process.exit(0);
  if (mode === 'forged-terminal-reason') {
    await sendRaw({ ...exactMessage('terminal'), reason: 'claimed' });
    process.exit(71);
  }
  await send('terminal');
  if (mode === 'wrong-nonzero') process.exit(71);
  if (mode === 'exit-zero') process.exit(0);
  process.exit(70);
});
`;

const BENIGN_CONTRACTS = Object.freeze({
  "correct-nonzero": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "wrong-nonzero": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "exit-zero": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "correct-signal": {
    phases: ["created", "signal_ready"],
    signal: "SIGTERM",
  },
  "wrong-signal": {
    phases: ["created", "signal_ready"],
    signal: "SIGTERM",
  },
  deadline: {
    phases: ["created", "deadline_pending"],
    signal: "SIGTERM",
    deadline: true,
  },
  "normal-before-deadline": {
    phases: ["created", "deadline_pending"],
    signal: "SIGTERM",
    deadline: true,
  },
  "pre-phase-failure": {
    phases: ["created"],
    exitCode: 70,
  },
  "unexpected-normal-after-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "forged-terminal-reason": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "duplicate-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "malformed-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
  "replayed-phase": {
    phases: ["created", "running", "terminal"],
    exitCode: 70,
  },
});

const lifecycleCounters = {
  spawned: 0,
  closed: 0,
};

function exactOwnKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

export function benignChildLifecycleCountersForTests() {
  return Object.freeze({ ...lifecycleCounters });
}

export async function runBenignChildLifecycleProbeForTests(
  mode,
  { deadlineMilliseconds = 150 } = {}
) {
  const contract = BENIGN_CONTRACTS[mode];
  requireFaultLifecycle(Boolean(contract), "BENIGN_CHILD_MODE_INVALID");
  requireFaultLifecycle(
    Number.isSafeInteger(deadlineMilliseconds) &&
      deadlineMilliseconds >= 50 &&
      deadlineMilliseconds <= 1_000,
    "BENIGN_CHILD_DEADLINE_INVALID"
  );
  const occurrenceId = randomUUID();
  const capabilityToken = randomUUID();
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", BENIGN_CHILD_SOURCE],
    {
      env: createBenignChildEnvironment(),
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    }
  );
  lifecycleCounters.spawned += 1;

  return new Promise((resolveProbe, rejectProbe) => {
    const messages = [];
    const exitEvents = [];
    const closeEvents = [];
    const errorEvents = [];
    let deadlineAlive = false;
    let settled = false;
    let deadlineTimer;
    let observationTimeout = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (observationTimeout) {
        rejectProbe(new FaultLifecycleIssue("BENIGN_CHILD_OBSERVATION_TIMEOUT"));
        return;
      }
      const authenticatedMessages = messages.filter(
        (message, index) =>
          exactOwnKeys(message, [
            "schemaVersion",
            "occurrenceId",
            "capabilityToken",
            "sequence",
            "phase",
          ]) &&
          message.schemaVersion === BENIGN_CHILD_SCHEMA_VERSION &&
          message.occurrenceId === occurrenceId &&
          message.capabilityToken === capabilityToken &&
          message.sequence === index + 1 &&
          typeof message.phase === "string"
      );
      const messageContract =
        messages.length > 0 && authenticatedMessages.length === messages.length;
      const authenticatedPhases = authenticatedMessages.map(
        (message) => message.phase
      );
      const phaseContract =
        messageContract &&
        JSON.stringify(authenticatedPhases) === JSON.stringify(contract.phases);
      const exit = exitEvents[0];
      const close = closeEvents[0];
      const processError = errorEvents[0];
      const terminalContract =
        exitEvents.length === 1 &&
        closeEvents.length === 1 &&
        exit?.code === close?.code &&
        exit?.signal === close?.signal &&
        (contract.exitCode !== undefined
          ? exit?.code === contract.exitCode && exit?.signal === null
          : exit?.code === null && exit?.signal === contract.signal);
      const deadlineContract = contract.deadline ? deadlineAlive : true;
      resolveProbe({
        schemaVersion: BENIGN_CHILD_SCHEMA_VERSION,
        mode,
        accepted:
          messageContract &&
          phaseContract &&
          terminalContract &&
          deadlineContract &&
          errorEvents.length === 0,
        messageContract,
        phaseContract,
        terminalContract,
        authenticatedPhases,
        deadlineAlive,
        exitObservation: {
          count: exitEvents.length,
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          timestampMilliseconds: exit?.timestampMilliseconds ?? null,
        },
        closeObservation: {
          count: closeEvents.length,
          code: close?.code ?? null,
          signal: close?.signal ?? null,
          timestampMilliseconds: close?.timestampMilliseconds ?? null,
        },
        errorObservation: {
          count: errorEvents.length,
          timestampMilliseconds: processError?.timestampMilliseconds ?? null,
        },
      });
    };

    const hardTimer = setTimeout(() => {
      observationTimeout = true;
      child.kill("SIGKILL");
    }, BENIGN_CHILD_TIMEOUT_MS);

    child.on("message", (message) => {
      messages.push(message);
      if (
        messages.length === 2 &&
        message?.phase === "signal_ready" &&
        (mode === "correct-signal" || mode === "wrong-signal")
      ) {
        child.kill(mode === "correct-signal" ? "SIGTERM" : "SIGKILL");
      }
    });
    child.once("error", () => {
      errorEvents.push({ timestampMilliseconds: performance.now() });
    });
    child.on("exit", (code, signal) => {
      exitEvents.push({
        code,
        signal,
        timestampMilliseconds: performance.now(),
      });
    });
    child.on("close", (code, signal) => {
      lifecycleCounters.closed += 1;
      closeEvents.push({
        code,
        signal,
        timestampMilliseconds: performance.now(),
      });
      finish();
    });

    if (contract.deadline) {
      deadlineTimer = setTimeout(() => {
        deadlineAlive = exitEvents.length === 0 && closeEvents.length === 0;
        if (deadlineAlive) child.kill("SIGTERM");
      }, deadlineMilliseconds);
    }

    child.send({
      schemaVersion: BENIGN_CHILD_SCHEMA_VERSION,
      occurrenceId,
      capabilityToken,
      mode,
    });
  });
}
