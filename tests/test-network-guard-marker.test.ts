import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

type MarkerPayload = {
  schemaVersion: number;
  runId: string;
  occurrenceId: string;
  role: string;
  pid: number;
  ppid: number;
  createdAt: string;
  markerVersion: number;
};

type MarkerApi = {
  ALLOWED_PAYLOAD_FIELDS: readonly string[];
  analyzeOccurrenceCompleteness(input: {
    launches: Array<{
      pid: number;
      ppid: number;
      role: string;
      occurrenceId: string;
    }>;
    markers: MarkerPayload[];
    runId: string;
  }): {
    complete: boolean;
    missingMarkerOccurrenceCount: number;
    orphanMarkerOccurrenceCount: number;
    duplicateOccurrenceIdCount: number;
    occurrenceBindingMismatchCount: number;
    perPid: Array<{
      pid: number;
      launchOccurrenceCount: number;
      markerOccurrenceCount: number;
    }>;
  };
  beginProcessOccurrence(
    globalObject: Record<PropertyKey, unknown>,
    occurrenceIdFactory: () => string
  ): { firstEvaluation: boolean; occurrenceId: string };
  claimExpectedProbe(input: {
    expectedViolationDirectory: string;
    runId: string;
    probeId: string;
    occurrenceId: string;
    pid: number;
    ppid: number;
  }): {
    claimPath: string;
    payload: {
      runId: string;
      probeId: string;
      expectedOperation: "dns";
      expectedViolationCount: 1;
      occurrenceId: string;
      pid: number;
      ppid: number;
    };
  };
  createGuardEvidenceLayout(input: {
    runRoot: string;
    probeId?: string;
    environment?: NodeJS.ProcessEnv;
  }): {
    occurrenceDirectory: string;
    operationalUnexpectedViolationDirectory: string;
    unexpectedViolationDirectory: string;
    expectedProbeRoot: string;
    expectedViolationDirectory: string | null;
    negativeFixtureRoot: string | null;
    negativeFixtureViolationDirectory: string | null;
    negativeFixtureChild: boolean;
    probeId: string | null;
  };
  createMarker(input: Record<string, unknown>): {
    filename: string;
    markerPath: string;
    payload: MarkerPayload;
  };
  summarizeGuardedNodeNetworkEvents(input: {
    unexpectedViolationEvents: unknown[];
    expectedBlockedDnsProbeEvents: unknown[];
  }): {
    guardedNodeApiUnexpectedViolation: number;
    expectedBlockedDnsProbe: number;
    successfulGuardedNodeApiExternalConnection: "NOT VERIFIED";
    nativeChildExternalConnection: "NOT VERIFIED";
  };
  validateGuardObserverLayout(runRoot: string): {
    observerAckRoot: string;
    observerRequestRoot: string;
  } | null;
};

const require = createRequire(import.meta.url);
const markerApi = require(
  "../scripts/test-network-guard/marker.cjs"
) as MarkerApi;

const RUN_ID = "round8_marker_test";
const PID = 4242;
const PPID = 2424;
const OCCURRENCE_A = "00000000-0000-4000-8000-000000000001";
const OCCURRENCE_B = "00000000-0000-4000-8000-000000000002";
const temporaryDirectories = new Set<string>();

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "actustube-guard-marker-"));
  temporaryDirectories.add(directory);
  return directory;
}

function createMarker(
  directory: string,
  occurrenceId = OCCURRENCE_A,
  extra: Record<string, unknown> = {}
) {
  return markerApi.createMarker({
    markerDirectory: directory,
    runId: RUN_ID,
    occurrenceId,
    role: "node-child",
    pid: PID,
    ppid: PPID,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  });
}

function readPayload(markerPath: string): MarkerPayload {
  return JSON.parse(readFileSync(markerPath, "utf8")) as MarkerPayload;
}

function launchFromMarker(marker: MarkerPayload) {
  return {
    pid: marker.pid,
    ppid: marker.ppid,
    role: marker.role,
    occurrenceId: marker.occurrenceId,
  };
}

function markerFilenames(directory: string) {
  return existsSync(directory)
    ? readdirSync(directory).filter(
        (filename) => filename.endsWith(".json") && filename !== "probe-owner.json"
      )
    : [];
}

function runGuardedDnsChild(
  source: string,
  {
    module = false,
    probeId,
    negativeFixture = false,
  }: { module?: boolean; probeId?: string; negativeFixture?: boolean }
) {
  if (probeId && negativeFixture) {
    throw new Error("GUARD_NEGATIVE_FIXTURE_PROBE_CONFLICT");
  }
  const preloadPath = resolve("scripts/test-network-guard/preload.cjs");
  const inheritedMarkerDirectory =
    process.env.ACTUSTUBE_NETWORK_GUARD_MARKER_DIR;
  const inheritedRunId = process.env.ACTUSTUBE_NETWORK_GUARD_RUN_ID;
  if (Boolean(inheritedMarkerDirectory) !== Boolean(inheritedRunId)) {
    throw new Error("GUARD_INHERITED_ENVIRONMENT_INCOMPLETE");
  }
  const useInheritedGuard = Boolean(inheritedMarkerDirectory && inheritedRunId);
  const runRoot = useInheritedGuard
    ? inheritedMarkerDirectory!
    : temporaryDirectory();
  const occurrenceDirectory = join(runRoot, "occurrences");
  const expectedViolationDirectory = probeId
    ? join(runRoot, "violations", "expected", probeId)
    : null;
  const unexpectedViolationDirectory = join(
    runRoot,
    "violations",
    "unexpected"
  );
  const negativeFixtureRoot = join(
    runRoot,
    "negative-fixtures",
    "ordinary-guarded-dns-unexpected"
  );
  const negativeFixtureViolationDirectory = join(
    negativeFixtureRoot,
    "violations",
    "unexpected"
  );
  const occurrenceFilesBefore = new Set(markerFilenames(occurrenceDirectory));
  const expectedFilesBefore = new Set(
    expectedViolationDirectory
      ? markerFilenames(expectedViolationDirectory)
      : []
  );
  const unexpectedFilesBefore = new Set(
    markerFilenames(unexpectedViolationDirectory)
  );
  const negativeFixtureFilesBefore = new Set(
    markerFilenames(negativeFixtureViolationDirectory)
  );
  const environment = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : []
    )
  ) as NodeJS.ProcessEnv;
  Object.assign(environment, {
    ACTUSTUBE_NETWORK_GUARD_MARKER_DIR: runRoot,
    ACTUSTUBE_NETWORK_GUARD_RUN_ID: useInheritedGuard
      ? inheritedRunId
      : "round10_dns_test",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NODE_OPTIONS: `--require=${preloadPath}`,
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  });
  delete environment.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_ID;
  delete environment.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_CHILD;
  delete environment.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT;
  delete environment.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD;
  if (probeId) {
    environment.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_ID = probeId;
    environment.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_CHILD = "1";
  }
  if (negativeFixture) {
    environment.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT =
      negativeFixtureRoot;
    environment.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD = "1";
  }
  const result = spawnSync(
    process.execPath,
    [
      ...(module ? ["--input-type=module"] : []),
      "--eval",
      source,
    ],
    {
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    }
  );
  const newMarkers = (directory: string, filesBefore: Set<string>) =>
    markerFilenames(directory)
      .filter((filename) => !filesBefore.has(filename))
      .map((filename) => readPayload(join(directory, filename)))
      .filter((marker) => marker.ppid === process.pid);
  return {
    result,
    runRoot,
    occurrenceDirectory,
    unexpectedViolationDirectory,
    negativeFixtureRoot,
    negativeFixtureViolationDirectory,
    occurrenceMarkers: newMarkers(
      occurrenceDirectory,
      occurrenceFilesBefore
    ),
    expectedViolationMarkers: newMarkers(
      expectedViolationDirectory || join(runRoot, "violations", "expected"),
      expectedFilesBefore
    ),
    unexpectedViolationMarkers: newMarkers(
      unexpectedViolationDirectory,
      unexpectedFilesBefore
    ),
    negativeFixtureViolationMarkers: newMarkers(
      negativeFixtureViolationDirectory,
      negativeFixtureFilesBefore
    ),
  };
}

function expectBlockedDnsChild(
  result: ReturnType<typeof runGuardedDnsChild>
) {
  expect(result.result.error).toBeUndefined();
  expect(result.result.status).toBe(0);
  expect(result.result.signal).toBeNull();
  expect(result.result.stdout.trim()).toBe("blocked");
  expect(result.result.stderr).toBe("");
  expect(result.occurrenceMarkers).toHaveLength(1);
  expect(result.occurrenceMarkers[0].role).toBe("node-child");
  expect(result.expectedViolationMarkers).toHaveLength(1);
  expect(result.expectedViolationMarkers[0].role).toBe("network_violation");
  expect(result.unexpectedViolationMarkers).toHaveLength(0);
}

afterEach(() => {
  delete process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT;
  delete process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
    if (existsSync(directory)) {
      throw new Error("GUARD_MARKER_TEST_CLEANUP_FAILED");
    }
  }
  temporaryDirectories.clear();
});

describe("test network guard occurrence markers", () => {
  it("creates different markers for two process occurrences with the same PID", () => {
    const directory = temporaryDirectory();
    const first = createMarker(directory, OCCURRENCE_A);
    const second = createMarker(directory, OCCURRENCE_B);

    expect(first.filename).not.toBe(second.filename);
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it("does not collide with a legacy PID-only marker", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, `${PID}-node-child.json`), "legacy\n", "utf8");

    const marker = createMarker(directory);

    expect(existsSync(marker.markerPath)).toBe(true);
    expect(readFileSync(join(directory, `${PID}-node-child.json`), "utf8")).toBe(
      "legacy\n"
    );
  });

  it("fails closed without overwriting when an occurrence ID collides", () => {
    const directory = temporaryDirectory();
    const first = createMarker(directory);
    const original = readFileSync(first.markerPath, "utf8");
    let collision: unknown;

    try {
      createMarker(directory);
    } catch (error) {
      collision = error;
    }

    expect(collision).toMatchObject({
      code: "GUARD_MARKER_OCCURRENCE_COLLISION",
      message: "GUARD_MARKER_OCCURRENCE_COLLISION",
    });
    expect(readFileSync(first.markerPath, "utf8")).toBe(original);
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("builds the filename from role, PID, and occurrence ID", () => {
    const directory = temporaryDirectory();
    const marker = createMarker(directory);

    expect(basename(marker.markerPath)).toBe(
      `node-child-${PID}-${OCCURRENCE_A}.json`
    );
  });

  it("writes only the payload allowlist fields", () => {
    const directory = temporaryDirectory();
    const marker = createMarker(directory);
    const payload = readPayload(marker.markerPath);

    expect(Object.keys(payload).sort()).toEqual(
      [...markerApi.ALLOWED_PAYLOAD_FIELDS].sort()
    );
  });

  it("omits environment values, URLs, hosts, paths, and credentials", () => {
    const directory = temporaryDirectory();
    const forbiddenValue = "fixture-value-not-for-payload";
    const marker = createMarker(directory, OCCURRENCE_A, {
      environmentValue: forbiddenValue,
      urlValue: "https://guard.example.test/resource",
      hostValue: "database.example.test",
      pathValue: directory,
      credentialValue: forbiddenValue,
    });
    const serialized = readFileSync(marker.markerPath, "utf8");

    expect(serialized).not.toContain(forbiddenValue);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("database.example.test");
    expect(serialized).not.toContain(directory);
  });

  it("rejects invalid run IDs and path traversal", () => {
    const directory = temporaryDirectory();
    for (const runId of ["", "../escape", "bad/escape", "bad\\escape"]) {
      expect(() => createMarker(directory, OCCURRENCE_A, { runId })).toThrow(
        "GUARD_MARKER_RUN_ID_INVALID"
      );
    }
    expect(readdirSync(directory)).toHaveLength(0);
  });

  it("does not create another marker for duplicate preload in one process", () => {
    const directory = temporaryDirectory();
    const isolatedGlobal: Record<PropertyKey, unknown> = {};
    const first = markerApi.beginProcessOccurrence(
      isolatedGlobal,
      () => OCCURRENCE_A
    );
    if (first.firstEvaluation) createMarker(directory, first.occurrenceId);
    const second = markerApi.beginProcessOccurrence(
      isolatedGlobal,
      () => OCCURRENCE_B
    );
    if (second.firstEvaluation) createMarker(directory, second.occurrenceId);

    expect(first.firstEvaluation).toBe(true);
    expect(second).toEqual({
      firstEvaluation: false,
      occurrenceId: OCCURRENCE_A,
    });
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("passes occurrence completeness for two launches and two markers on one PID", () => {
    const directory = temporaryDirectory();
    const markers = [
      createMarker(directory, OCCURRENCE_A).payload,
      createMarker(directory, OCCURRENCE_B).payload,
    ];
    const result = markerApi.analyzeOccurrenceCompleteness({
      launches: markers.map(launchFromMarker),
      markers,
      runId: RUN_ID,
    });

    expect(result.complete).toBe(true);
    expect(result.perPid).toEqual([
      expect.objectContaining({
        pid: PID,
        launchOccurrenceCount: 2,
        markerOccurrenceCount: 2,
      }),
    ]);
  });

  it("fails occurrence completeness for two launches and one marker on one PID", () => {
    const directory = temporaryDirectory();
    const marker = createMarker(directory, OCCURRENCE_A).payload;
    const result = markerApi.analyzeOccurrenceCompleteness({
      launches: [
        launchFromMarker(marker),
        {
          pid: PID,
          ppid: PPID,
          role: "node-child",
          occurrenceId: OCCURRENCE_B,
        },
      ],
      markers: [marker],
      runId: RUN_ID,
    });

    expect(result.complete).toBe(false);
    expect(result.missingMarkerOccurrenceCount).toBe(1);
    expect(result.orphanMarkerOccurrenceCount).toBe(0);
    expect(result.duplicateOccurrenceIdCount).toBe(0);
  });

  it("fails closed when an occurrence marker does not match the exact schema", () => {
    const directory = temporaryDirectory();
    const valid = createMarker(directory, OCCURRENCE_A).payload;
    const missingOccurrenceId = { ...valid } as Partial<MarkerPayload>;
    delete missingOccurrenceId.occurrenceId;
    expect(() =>
      markerApi.analyzeOccurrenceCompleteness({
        launches: [launchFromMarker(valid)],
        markers: [missingOccurrenceId as MarkerPayload],
        runId: RUN_ID,
      })
    ).toThrow("GUARD_MARKER_PAYLOAD_INVALID");
    expect(() =>
      markerApi.analyzeOccurrenceCompleteness({
        launches: [launchFromMarker(valid)],
        markers: [{ ...valid, unexpected: "field" } as MarkerPayload],
        runId: RUN_ID,
      })
    ).toThrow("GUARD_MARKER_PAYLOAD_INVALID");
  });

  it("fails occurrence completeness when launch and marker binding differs", () => {
    const directory = temporaryDirectory();
    const marker = createMarker(directory, OCCURRENCE_A).payload;
    const result = markerApi.analyzeOccurrenceCompleteness({
      launches: [
        {
          ...launchFromMarker(marker),
          ppid: marker.ppid + 1,
        },
      ],
      markers: [marker],
      runId: RUN_ID,
    });

    expect(result.complete).toBe(false);
    expect(result.occurrenceBindingMismatchCount).toBe(1);
  });

  it("blocks callback dns.lookup with exactly one network violation", () => {
    const child = runGuardedDnsChild(`
      const dns = process.getBuiltinModule("dns");
      try {
        dns.lookup("guard.example.test", () => undefined);
        process.exitCode = 9;
      } catch (error) {
        if (error?.message !== "DNS_NETWORK_REJECTED") process.exitCode = 8;
        else console.log("blocked");
      }
    `, { probeId: "callback-lookup" });
    expectBlockedDnsChild(child);
  });

  it("passes only the fixed child environment and exact guard preload", () => {
    const secretKey = "ACTUSTUBE_TEST_SECRET_SHOULD_NOT_INHERIT";
    const previousSecret = process.env[secretKey];
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const exactNodeOptions = `--require=${resolve(
      "scripts/test-network-guard/preload.cjs"
    )}`;
    process.env[secretKey] = "fixture-sensitive";
    process.env.NODE_OPTIONS = "--trace-warnings";
    try {
      const child = runGuardedDnsChild(
        `
          if (
            process.env.${secretKey} === undefined &&
            process.env.NODE_OPTIONS === ${JSON.stringify(exactNodeOptions)}
          ) {
            console.log("isolated");
          } else {
            process.exitCode = 9;
          }
        `,
        {}
      );
      expect(child.result.error).toBeUndefined();
      expect(child.result.status).toBe(0);
      expect(child.result.signal).toBeNull();
      expect(child.result.stdout.trim()).toBe("isolated");
      expect(child.result.stderr).toBe("");
    } finally {
      if (previousSecret === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previousSecret;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it("blocks CommonJS dns/promises.lookup", () => {
    const child = runGuardedDnsChild(`
      void (async () => {
        const dnsPromises = process.getBuiltinModule("dns/promises");
        try {
          await dnsPromises.lookup("guard.example.test");
          process.exitCode = 9;
        } catch (error) {
          if (error?.message !== "DNS_NETWORK_REJECTED") process.exitCode = 8;
          else console.log("blocked");
        }
      })();
    `, { probeId: "cjs-promise-lookup" });
    expectBlockedDnsChild(child);
  });

  it("blocks ESM node:dns/promises.lookup", () => {
    const child = runGuardedDnsChild(
      `
        const dnsPromises = await import("node:dns/promises");
        try {
          await dnsPromises.lookup("guard.example.test");
          process.exitCode = 9;
        } catch (error) {
          if (error?.message !== "DNS_NETWORK_REJECTED") process.exitCode = 8;
          else console.log("blocked");
        }
      `,
      { module: true, probeId: "esm-promise-lookup" }
    );
    expectBlockedDnsChild(child);
  });

  it("blocks callback Resolver.resolve4", () => {
    const child = runGuardedDnsChild(`
      const dns = process.getBuiltinModule("dns");
      try {
        new dns.Resolver().resolve4("guard.example.test", () => undefined);
        process.exitCode = 9;
      } catch (error) {
        if (error?.message !== "DNS_NETWORK_REJECTED") process.exitCode = 8;
        else console.log("blocked");
      }
    `, { probeId: "callback-resolver-resolve4" });
    expectBlockedDnsChild(child);
  });

  it("blocks promise Resolver.resolve4", () => {
    const child = runGuardedDnsChild(`
      void (async () => {
        const dnsPromises = process.getBuiltinModule("dns/promises");
        try {
          await new dnsPromises.Resolver().resolve4("guard.example.test");
          process.exitCode = 9;
        } catch (error) {
          if (error?.message !== "DNS_NETWORK_REJECTED") process.exitCode = 8;
          else console.log("blocked");
        }
      })();
    `, { probeId: "promise-resolver-resolve4" });
    expectBlockedDnsChild(child);
  });

  it("blocks TCP, TLS, listener, and datagram APIs before their originals", () => {
    const child = runGuardedDnsChild(
      `
        const net = process.getBuiltinModule("net");
        const tls = process.getBuiltinModule("tls");
        const dgram = process.getBuiltinModule("dgram");
        const operations = [
          {
            code: "NON_LOOPBACK_TCP_REJECTED",
            run: () => net.Socket.prototype.connect.call({}, {
              host: "203.0.113.1",
              port: 443,
            }),
          },
          {
            code: "NON_LOOPBACK_TLS_REJECTED",
            run: () => tls.connect({ host: "203.0.113.1", port: -1 }),
          },
          {
            code: "NON_LOOPBACK_LISTENER_REJECTED",
            run: () => net.Server.prototype.listen.call({}, {
              host: "0.0.0.0",
              port: 0,
            }),
          },
          {
            code: "DATAGRAM_NETWORK_REJECTED",
            run: () => dgram.Socket.prototype.connect.call({}, 9, "203.0.113.1"),
          },
          {
            code: "DATAGRAM_NETWORK_REJECTED",
            run: () => dgram.Socket.prototype.send.call({}, "x", 9, "203.0.113.1"),
          },
          {
            code: "DATAGRAM_NETWORK_REJECTED",
            run: () => dgram.Socket.prototype.bind.call({}, 0, "0.0.0.0"),
          },
        ];
        let blocked = 0;
        for (const operation of operations) {
          try {
            operation.run();
          } catch (error) {
            if (error?.message === operation.code) blocked += 1;
            else throw error;
          }
        }
        if (blocked === operations.length) console.log("blocked");
        else process.exitCode = 9;
      `,
      {}
    );
    expect(child.result.error).toBeUndefined();
    expect(child.result.status).toBe(0);
    expect(child.result.signal).toBeNull();
    expect(child.result.stdout.trim()).toBe("blocked");
    expect(child.result.stderr).toBe("");
    expect(child.occurrenceMarkers).toHaveLength(1);
    expect(child.expectedViolationMarkers).toHaveLength(0);
    expect(child.unexpectedViolationMarkers).toHaveLength(6);
  });

  it("rejects Windows remote named pipes before connect and records an occurrence", () => {
    const preloadPath = resolve("scripts/test-network-guard/preload.cjs");
    const localPipe = "\\\\.\\pipe\\actustube-local";
    const remotePipe = "\\\\server\\pipe\\actustube-remote";
    const slashRemotePipe = "//server/pipe/actustube-remote";
    const extendedRemotePipe = "\\\\?\\UNC\\server\\pipe\\actustube-remote";
    const posixSocket = "/tmp/actustube-local.sock";
    const child = runGuardedDnsChild(
      `
        const net = process.getBuiltinModule("net");
        const guard = require(${JSON.stringify(preloadPath)});
        const localPipe = ${JSON.stringify(localPipe)};
        const remoteTargets = [
          [${JSON.stringify(remotePipe)}],
          [${JSON.stringify(slashRemotePipe)}],
          [${JSON.stringify(extendedRemotePipe)}],
          [{ path: ${JSON.stringify(remotePipe)} }],
        ];
        let remoteOriginalCalls = 0;
        const remoteCodes = [];
        for (const argumentsList of remoteTargets) {
          try {
            guard.invokeGuardedConnection(
              () => { remoteOriginalCalls += 1; },
              null,
              argumentsList,
              "NON_LOOPBACK_TCP_REJECTED",
              {
                platform: "win32",
                reject: (code) => { throw new Error(code); },
              }
            );
          } catch (error) {
            remoteCodes.push(error?.message);
          }
        }
        let localOriginalCalls = 0;
        guard.invokeGuardedConnection(
          () => { localOriginalCalls += 1; },
          null,
          [localPipe],
          "NON_LOOPBACK_TCP_REJECTED",
          { platform: "win32", reject: (code) => { throw new Error(code); } }
        );
        guard.invokeGuardedConnection(
          () => { localOriginalCalls += 1; },
          null,
          [${JSON.stringify(posixSocket)}],
          "NON_LOOPBACK_TCP_REJECTED",
          { platform: "linux", reject: (code) => { throw new Error(code); } }
        );
        guard.invokeGuardedConnection(
          () => { localOriginalCalls += 1; },
          null,
          [{ host: "127.0.0.1", port: 5432 }],
          "NON_LOOPBACK_TCP_REJECTED",
          { platform: "win32", reject: (code) => { throw new Error(code); } }
        );
        let actualGuardCode = null;
        try {
          net.Socket.prototype.connect.call({}, ${JSON.stringify(remotePipe)});
        } catch (error) {
          actualGuardCode = error?.message;
        }
        console.log(JSON.stringify({
          localPipe: guard.connectionTarget([localPipe], "win32"),
          remotePipe: guard.connectionTarget([${JSON.stringify(remotePipe)}], "win32"),
          slashRemotePipe: guard.connectionTarget([${JSON.stringify(slashRemotePipe)}], "win32"),
          extendedRemotePipe: guard.connectionTarget([${JSON.stringify(extendedRemotePipe)}], "win32"),
          optionsRemotePipe: guard.connectionTarget([{ path: ${JSON.stringify(remotePipe)} }], "win32"),
          posixSocket: guard.connectionTarget([${JSON.stringify(posixSocket)}], "linux"),
          loopback: guard.connectionTarget([{ host: "127.0.0.1", port: 5432 }], "win32"),
          remoteOriginalCalls,
          localOriginalCalls,
          remoteCodes,
          actualGuardCode,
        }));
      `,
      {}
    );

    expect(child.result.error).toBeUndefined();
    expect(child.result.status).toBe(0);
    expect(child.result.signal).toBeNull();
    expect(child.result.stderr).toBe("");
    const result = JSON.parse(child.result.stdout.trim());
    expect(result.localPipe).toMatchObject({ pipe: true, localPipe: true });
    for (const key of [
      "remotePipe",
      "slashRemotePipe",
      "extendedRemotePipe",
      "optionsRemotePipe",
    ]) {
      expect(result[key]).toMatchObject({ pipe: true, localPipe: false });
    }
    expect(result.posixSocket).toMatchObject({ pipe: true, localPipe: true });
    expect(result.loopback).toEqual({ pipe: false, host: "127.0.0.1" });
    expect(result.remoteOriginalCalls).toBe(0);
    expect(result.localOriginalCalls).toBe(3);
    expect(result.remoteCodes).toEqual(
      Array(4).fill("REMOTE_NAMED_PIPE_REJECTED")
    );
    expect(result.actualGuardCode).toBe("REMOTE_NAMED_PIPE_REJECTED");
    expect(child.unexpectedViolationMarkers).toHaveLength(1);
    expect(child.unexpectedViolationMarkers[0].role).toBe("network_violation");
  });

  it("allows exactly one expected DNS violation and rejects other probe use", () => {
    const child = runGuardedDnsChild(
      `
        const dns = process.getBuiltinModule("dns");
        const net = process.getBuiltinModule("net");
        const errors = [];
        for (const operation of [
          () => dns.lookup("guard.example.test", () => undefined),
          () => dns.lookup("guard.example.test", () => undefined),
          () => net.Socket.prototype.connect.call({}, {
            host: "203.0.113.1",
            port: 443,
          }),
        ]) {
          try {
            operation();
          } catch (error) {
            errors.push(error?.message);
          }
        }
        const expected = [
          "DNS_NETWORK_REJECTED",
          "NETWORK_GUARD_EXPECTED_PROBE_COUNT_EXCEEDED",
          "NETWORK_GUARD_EXPECTED_PROBE_OPERATION_MISMATCH",
        ];
        if (JSON.stringify(errors) === JSON.stringify(expected)) {
          console.log("blocked");
        } else {
          process.exitCode = 9;
        }
      `,
      { probeId: "single-dns-probe" }
    );
    expect(child.result.error).toBeUndefined();
    expect(child.result.status).toBe(0);
    expect(child.result.signal).toBeNull();
    expect(child.result.stdout.trim()).toBe("blocked");
    expect(child.result.stderr).toBe("");
    expect(child.expectedViolationMarkers).toHaveLength(1);
    expect(child.unexpectedViolationMarkers).toHaveLength(2);
    expect(child.negativeFixtureViolationMarkers).toHaveLength(0);
  });

  it("guards the complete callback, promise, and Resolver DNS inventory", () => {
    const child = runGuardedDnsChild(
      `
        const callbackMethods = ${JSON.stringify([
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
        ])};
        const resolverMethods = callbackMethods.filter(
          (method) => method !== "lookup" && method !== "lookupService"
        );
        const dns = process.getBuiltinModule("dns");
        const dnsPromises = process.getBuiltinModule("dns/promises");
        const esmDns = await import("node:dns");
        const esmDnsPromises = await import("node:dns/promises");
        const missing = [];
        let blockedCount = 0;
        function expectSyncBlock(operation) {
          try {
            operation();
          } catch (error) {
            if (error?.message === "DNS_NETWORK_REJECTED") blockedCount++;
            else throw error;
          }
        }
        async function expectPromiseBlock(operation) {
          try {
            await operation();
          } catch (error) {
            if (error?.message === "DNS_NETWORK_REJECTED") blockedCount++;
            else throw error;
          }
        }
        for (const method of callbackMethods) {
          if (dns[method]?.name !== "blockedDnsOperation") missing.push(method);
          if (esmDns[method] !== dns[method]) missing.push("esm-" + method);
          if (dnsPromises[method]?.name !== "blockedDnsPromiseOperation") {
            missing.push("promise-" + method);
          }
          if (esmDnsPromises[method] !== dnsPromises[method]) {
            missing.push("esm-promise-" + method);
          }
          expectSyncBlock(() => dns[method]("guard.example.test", () => undefined));
          await expectPromiseBlock(() => dnsPromises[method]("guard.example.test"));
        }
        for (const method of resolverMethods) {
          if (dns.Resolver.prototype[method]?.name !== "blockedDnsOperation") {
            missing.push("resolver-" + method);
          }
          if (
            dnsPromises.Resolver.prototype[method]?.name !==
            "blockedDnsPromiseOperation"
          ) {
            missing.push("promise-resolver-" + method);
          }
          expectSyncBlock(() =>
            new dns.Resolver()[method]("guard.example.test", () => undefined)
          );
          await expectPromiseBlock(() =>
            new dnsPromises.Resolver()[method]("guard.example.test")
          );
        }
        if (missing.length !== 0 || blockedCount !== 60) process.exitCode = 9;
        else console.log("blocked");
      `,
      { module: true, negativeFixture: true }
    );
    expect(child.result.error).toBeUndefined();
    expect(child.result.status).toBe(0);
    expect(child.result.signal).toBeNull();
    expect(child.result.stdout.trim()).toBe("blocked");
    expect(child.result.stderr).toBe("");
    expect(child.occurrenceMarkers).toHaveLength(1);
    expect(child.expectedViolationMarkers).toHaveLength(0);
    expect(child.unexpectedViolationMarkers).toHaveLength(0);
    expect(child.negativeFixtureViolationMarkers).toHaveLength(60);
  });

  it("classifies an expected probe violation without creating an unexpected violation", () => {
    const runRoot = temporaryDirectory();
    const layout = markerApi.createGuardEvidenceLayout({
      runRoot,
      probeId: "classification-probe",
    });
    createMarker(layout.expectedViolationDirectory!, OCCURRENCE_A, {
      role: "network_violation",
    });

    expect(markerFilenames(layout.expectedViolationDirectory!)).toHaveLength(1);
    expect(markerFilenames(layout.unexpectedViolationDirectory)).toHaveLength(0);
  });

  it("keeps one common occurrence marker for an expected probe child", () => {
    const runRoot = temporaryDirectory();
    const layout = markerApi.createGuardEvidenceLayout({
      runRoot,
      probeId: "occurrence-probe",
    });
    const occurrenceMarker = createMarker(
      layout.occurrenceDirectory,
      OCCURRENCE_A
    );
    const claim = markerApi.claimExpectedProbe({
      expectedViolationDirectory: layout.expectedViolationDirectory!,
      runId: RUN_ID,
      probeId: "occurrence-probe",
      occurrenceId: OCCURRENCE_A,
      pid: PID,
      ppid: PPID,
    });

    expect(markerFilenames(layout.occurrenceDirectory)).toHaveLength(1);
    expect(readPayload(occurrenceMarker.markerPath).occurrenceId).toBe(
      claim.payload.occurrenceId
    );
    expect(claim.payload.expectedOperation).toBe("dns");
    expect(claim.payload.expectedViolationCount).toBe(1);
  });

  it("fails closed for invalid, duplicate, and symlinked expected probe evidence", () => {
    const runRoot = temporaryDirectory();
    for (const probeId of ["", "../escape", "bad/escape", "bad\\escape"]) {
      expect(() =>
        markerApi.createGuardEvidenceLayout({ runRoot, probeId })
      ).toThrow("GUARD_EXPECTED_PROBE_ID_INVALID");
    }

    const layout = markerApi.createGuardEvidenceLayout({
      runRoot,
      probeId: "unique-probe",
    });
    const claim = {
      expectedViolationDirectory: layout.expectedViolationDirectory!,
      runId: RUN_ID,
      probeId: "unique-probe",
      occurrenceId: OCCURRENCE_A,
      pid: PID,
      ppid: PPID,
    };
    markerApi.claimExpectedProbe(claim);
    expect(() => markerApi.claimExpectedProbe(claim)).toThrow(
      "GUARD_EXPECTED_PROBE_ID_DUPLICATE"
    );

    const symlinkRoot = temporaryDirectory();
    const symlinkTarget = temporaryDirectory();
    symlinkSync(symlinkTarget, join(symlinkRoot, "violations"), "junction");
    expect(() =>
      markerApi.createGuardEvidenceLayout({
        runRoot: symlinkRoot,
        probeId: "symlink-probe",
      })
    ).toThrow("GUARD_EVIDENCE_SYMLINK_REJECTED");
  });

  it("validates observer containment and reparse points before a request write", () => {
    const runRoot = temporaryDirectory();
    const escapedTarget = temporaryDirectory();
    mkdirSync(join(runRoot, "observer-ack"));
    symlinkSync(
      escapedTarget,
      join(runRoot, "observer-request"),
      "junction"
    );

    expect(() => markerApi.validateGuardObserverLayout(runRoot)).toThrow(
      "GUARD_EVIDENCE_SYMLINK_REJECTED"
    );
    expect(readdirSync(escapedTarget)).toHaveLength(0);
  });

  it("derives guarded Node network counts from event inventory", () => {
    const summary = markerApi.summarizeGuardedNodeNetworkEvents({
      unexpectedViolationEvents: [{ id: 1 }],
      expectedBlockedDnsProbeEvents: [{ id: 2 }, { id: 3 }],
    });
    expect(summary).toEqual({
      guardedNodeApiUnexpectedViolation: 1,
      expectedBlockedDnsProbe: 2,
      successfulGuardedNodeApiExternalConnection: "NOT VERIFIED",
      nativeChildExternalConnection: "NOT VERIFIED",
    });
    expect(summary).not.toHaveProperty(
      "successful" + "ExternalConnectionCount"
    );
    expect(summary).not.toHaveProperty("externalConnections");
  });

  it("keeps expected probe authority in the dedicated DNS child", () => {
    expect(process.env.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_ID).toBeUndefined();
    const child = runGuardedDnsChild(
      `
        const dns = require("node:dns");
        try { dns.lookup("guard.example.test", () => undefined); }
        catch (error) {
          if (error?.message === "DNS_NETWORK_REJECTED") console.log("blocked");
          else process.exitCode = 8;
        }
      `,
      { probeId: "dedicated-dns-probe" }
    );
    expectBlockedDnsChild(child);
  });

  it("classifies an ordinary guarded DNS violation as unexpected", () => {
    expect(process.env.ACTUSTUBE_NETWORK_GUARD_EXPECTED_PROBE_ID).toBeUndefined();
    expect(
      process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT
    ).toBeUndefined();
    expect(
      process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD
    ).toBeUndefined();
    const child = runGuardedDnsChild(
      `
        if (
          process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD !== "1" ||
          typeof process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT !== "string"
        ) {
          process.exitCode = 7;
        }
        const dns = require("node:dns");
        try { dns.lookup("guard.example.test", () => undefined); }
        catch (error) {
          if (error?.message === "DNS_NETWORK_REJECTED") console.log("blocked");
          else process.exitCode = 8;
        }
      `,
      { negativeFixture: true }
    );
    expect(child.result.status).toBe(0);
    expect(child.result.signal).toBeNull();
    expect(child.result.stdout.trim()).toBe("blocked");
    expect(child.result.stderr).toBe("");
    expect(child.occurrenceMarkers).toHaveLength(1);
    expect(child.occurrenceDirectory).toBe(
      join(child.runRoot, "occurrences")
    );
    expect(child.expectedViolationMarkers).toHaveLength(0);
    expect(child.unexpectedViolationMarkers).toHaveLength(0);
    expect(child.negativeFixtureViolationMarkers).toHaveLength(1);
    expect(child.negativeFixtureViolationMarkers[0].role).toBe(
      "network_violation"
    );
    expect(child.negativeFixtureRoot).not.toBe(
      child.unexpectedViolationDirectory
    );
    expect(child.negativeFixtureViolationDirectory).not.toBe(
      child.unexpectedViolationDirectory
    );
    expect(markerFilenames(child.unexpectedViolationDirectory)).toHaveLength(0);
    expect(
      markerFilenames(child.negativeFixtureViolationDirectory)
    ).toHaveLength(1);

    const ordinaryChild = runGuardedDnsChild(
      `
        if (
          process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT === undefined &&
          process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD === undefined
        ) console.log("isolated");
        else process.exitCode = 7;
      `,
      {}
    );
    expect(ordinaryChild.result.status).toBe(0);
    expect(ordinaryChild.result.signal).toBeNull();
    expect(ordinaryChild.result.stdout.trim()).toBe("isolated");
    expect(ordinaryChild.expectedViolationMarkers).toHaveLength(0);
    expect(ordinaryChild.unexpectedViolationMarkers).toHaveLength(0);
    expect(ordinaryChild.negativeFixtureViolationMarkers).toHaveLength(0);
    expect(
      process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_ROOT
    ).toBeUndefined();
    expect(
      process.env.ACTUSTUBE_NETWORK_GUARD_NEGATIVE_FIXTURE_CHILD
    ).toBeUndefined();
  });
});
