import { timingSafeEqual } from "node:crypto";

import { getNeonDriverEffectiveAuthority } from "./neon-adapter.mjs";

export const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  "ACTUSTUBE_DB_ENV",
  "ACTUSTUBE_ALLOW_STAGING_DB_VERIFY",
  "DIRECT_DATABASE_URL",
  "DATABASE_URL",
]);

export const EXPECTED_IDENTITY_KEY = "ACTUSTUBE_EXPECTED_STAGING_IDENTITY";
export const POSTFLIGHT_CONFIRMATION_KEY =
  "ACTUSTUBE_ALLOW_STAGING_DB_VERIFY";
export const PREFLIGHT_CONFIRMATION_KEY =
  "ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const FORBIDDEN_TARGET_PART =
  /(?:^|[-_.\/])(prod(?:uction)?|rehearsal|backup|default|main|template0|template1)(?:$|[-_.\/])/i;
const STAGING_TARGET_PART = /(?:^|[-_.\/])staging(?:$|[-_.\/])/i;
const SAFE_PROVIDER_IDENTITY = /^ep-[a-z0-9](?:[a-z0-9-]{1,125}[a-z0-9])?$/;
const LOCAL_PROVIDER_IDENTITY = "local-postflight-fixture";
const SAFE_DATABASE_QUERY_PARAMETERS = new Map([
  ["channel_binding", new Set(["require"])],
  ["sslmode", new Set(["require"])],
]);
const SAFE_AUTHORITY_IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

export class PostflightIssue extends Error {
  constructor(code, exitCode, status = "fail") {
    super(code);
    this.name = "PostflightIssue";
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
  }
}

function safetyIssue(code) {
  return new PostflightIssue(code, 2, "fail");
}

function notVerifiedIssue(code) {
  return new PostflightIssue(code, 3, "not_verified");
}

function validateDatabaseUrlQuery(rawValue, parsed, kind) {
  const prefix = kind.toUpperCase();
  if (parsed.hash) throw safetyIssue(`${prefix}_URL_FRAGMENT_REJECTED`);

  const queryIndex = rawValue.indexOf("?");
  if (queryIndex === -1) return;
  const fragmentIndex = rawValue.indexOf("#", queryIndex + 1);
  const rawQuery = rawValue.slice(
    queryIndex + 1,
    fragmentIndex === -1 ? undefined : fragmentIndex
  );
  if (rawQuery.length === 0) {
    throw safetyIssue(`${prefix}_URL_QUERY_REJECTED`);
  }

  const seenKeys = new Set();
  for (const rawEntry of rawQuery.split("&")) {
    const separatorIndex = rawEntry.indexOf("=");
    if (
      rawEntry.length === 0 ||
      separatorIndex <= 0 ||
      separatorIndex === rawEntry.length - 1
    ) {
      throw safetyIssue(`${prefix}_URL_QUERY_REJECTED`);
    }

    let decodedKey;
    let decodedValue;
    try {
      decodedKey = decodeURIComponent(
        rawEntry.slice(0, separatorIndex).replaceAll("+", " ")
      ).toLowerCase();
      decodedValue = decodeURIComponent(
        rawEntry.slice(separatorIndex + 1).replaceAll("+", " ")
      );
    } catch {
      throw safetyIssue(`${prefix}_URL_QUERY_REJECTED`);
    }

    const allowedValues = SAFE_DATABASE_QUERY_PARAMETERS.get(decodedKey);
    if (
      decodedKey.length === 0 ||
      decodedValue.length === 0 ||
      seenKeys.has(decodedKey) ||
      !allowedValues?.has(decodedValue)
    ) {
      throw safetyIssue(`${prefix}_URL_QUERY_REJECTED`);
    }
    seenKeys.add(decodedKey);
  }
}

function parseDatabaseUrl(rawValue, kind, { allowLoopback = false } = {}) {
  const prefix = kind.toUpperCase();
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw safetyIssue(`${prefix}_URL_REQUIRED`);
  }

  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw safetyIssue(`${prefix}_URL_INVALID`);
  }

  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw safetyIssue(`${prefix}_URL_PROTOCOL_REJECTED`);
  }
  validateDatabaseUrlQuery(rawValue, parsed, kind);
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw safetyIssue(`${prefix}_TARGET_UNCLASSIFIED`);
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const databasePath = parsed.pathname.slice(1);
  const decodedUsername = parsed.username || "";
  let decodedPassword;
  try {
    decodedPassword = decodeURIComponent(parsed.password || "");
  } catch {
    throw safetyIssue(`${prefix}_URL_INVALID`);
  }
  if (
    !SAFE_AUTHORITY_IDENTIFIER.test(databasePath) ||
    !SAFE_AUTHORITY_IDENTIFIER.test(decodedUsername)
  ) {
    throw safetyIssue(`${prefix}_URL_AUTHORITY_REJECTED`);
  }
  if (!decodedUsername) {
    throw safetyIssue(`${prefix}_ROLE_UNAVAILABLE`);
  }

  const port = Number(parsed.port || "5432");
  let driverAuthority;
  try {
    driverAuthority = getNeonDriverEffectiveAuthority(rawValue);
  } catch {
    throw safetyIssue(`${prefix}_URL_INVALID`);
  }
  const safetyAuthority = {
    host: hostname,
    port,
    database: databasePath,
    user: decodedUsername,
  };
  if (
    driverAuthority.host !== safetyAuthority.host ||
    driverAuthority.port !== safetyAuthority.port ||
    driverAuthority.database !== safetyAuthority.database ||
    driverAuthority.user !== safetyAuthority.user
  ) {
    throw safetyIssue(`${prefix}_DRIVER_AUTHORITY_MISMATCH`);
  }
  const stagingClassificationMetadata = [
    driverAuthority.host,
    driverAuthority.database.toLowerCase(),
    driverAuthority.user,
  ].join("/");
  const forbiddenTargetMetadata = [
    stagingClassificationMetadata,
  ].join("/");
  if (FORBIDDEN_TARGET_PART.test(forbiddenTargetMetadata)) {
    throw safetyIssue(`${prefix}_FORBIDDEN_TARGET`);
  }

  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(hostname);
  if (isLoopback && !allowLoopback) {
    throw safetyIssue(`${prefix}_LOOPBACK_REJECTED`);
  }

  let normalizedHost = hostname;
  let isPooled = false;
  let providerIdentity = LOCAL_PROVIDER_IDENTITY;
  if (!isLoopback) {
    const labels = hostname.split(".");
    isPooled = labels[0].endsWith("-pooler");
    if (isPooled) labels[0] = labels[0].slice(0, -"-pooler".length);
    providerIdentity = labels[0];
    normalizedHost = labels.join(".");
    if ((kind === "direct" && isPooled) || (kind === "pooled" && !isPooled)) {
      throw safetyIssue(`${prefix}_ENDPOINT_KIND_REJECTED`);
    }
    if (!STAGING_TARGET_PART.test(stagingClassificationMetadata)) {
      throw safetyIssue(`${prefix}_STAGING_MARKER_REQUIRED`);
    }
  }

  return {
    rawValue,
    targetKey: `${normalizedHost}\u0000${port}\u0000${databasePath}`,
    authority: driverAuthority,
    role: decodedUsername,
    isLoopback,
    isPooled,
    providerIdentity,
    secretParts: [
      rawValue,
      parsed.username,
      parsed.password,
      parsed.hostname,
      decodedUsername,
      decodedPassword,
      databasePath,
      parsed.search,
    ].filter(Boolean),
  };
}

export function validateSafetyGate(environment, options = {}) {
  const confirmationKey =
    options.confirmationKey || POSTFLIGHT_CONFIRMATION_KEY;
  const confirmationErrorCode =
    options.confirmationErrorCode || "STAGING_CONFIRMATION_REQUIRED";
  if (environment.ACTUSTUBE_DB_ENV !== "staging") {
    throw safetyIssue("STAGING_ENVIRONMENT_REQUIRED");
  }
  if (environment[confirmationKey] !== "1") {
    throw safetyIssue(confirmationErrorCode);
  }

  const direct = parseDatabaseUrl(
    environment.DIRECT_DATABASE_URL,
    "direct",
    options
  );
  const pooled = parseDatabaseUrl(environment.DATABASE_URL, "pooled", options);
  if (direct.targetKey !== pooled.targetKey) {
    throw safetyIssue("DIRECT_POOLED_TARGET_MISMATCH");
  }
  if (direct.providerIdentity !== pooled.providerIdentity) {
    throw safetyIssue("DIRECT_POOLED_PROVIDER_IDENTITY_MISMATCH");
  }

  const expectedIdentity = environment[EXPECTED_IDENTITY_KEY];
  const identityFormatAccepted = direct.isLoopback
    ? expectedIdentity === LOCAL_PROVIDER_IDENTITY
    : typeof expectedIdentity === "string" &&
      SAFE_PROVIDER_IDENTITY.test(expectedIdentity);
  if (!identityFormatAccepted) {
    throw notVerifiedIssue("EXPECTED_STAGING_IDENTITY_REQUIRED");
  }
  const calculatedIdentity = Buffer.from(direct.providerIdentity, "utf8");
  const suppliedIdentity = Buffer.from(expectedIdentity, "utf8");
  if (
    calculatedIdentity.length !== suppliedIdentity.length ||
    !timingSafeEqual(calculatedIdentity, suppliedIdentity)
  ) {
    throw safetyIssue("EXPECTED_STAGING_IDENTITY_MISMATCH");
  }

  return {
    directUrl: direct.rawValue,
    pooledUrl: pooled.rawValue,
    directAuthority: direct.authority,
    pooledAuthority: pooled.authority,
    directRole: direct.role,
    pooledRole: pooled.role,
    secretParts: [
      ...direct.secretParts,
      ...pooled.secretParts,
      expectedIdentity,
      encodeURIComponent(direct.rawValue),
      encodeURIComponent(pooled.rawValue),
    ],
  };
}

function collectDiagnosticStrings(value, output, visited, depth) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (typeof value !== "object" || visited.has(value)) return;
  visited.add(value);

  for (const key of ["message", "stack", "code", "detail", "hint", "where"]) {
    try {
      const entry = Reflect.get(value, key);
      if (typeof entry === "string") output.push(entry);
    } catch {
      // Accessors on untrusted error objects are intentionally ignored.
    }
  }
  for (const key of ["cause", "errors"]) {
    try {
      const entry = Reflect.get(value, key);
      if (Array.isArray(entry)) {
        for (const child of entry) {
          collectDiagnosticStrings(child, output, visited, depth + 1);
        }
      } else {
        collectDiagnosticStrings(entry, output, visited, depth + 1);
      }
    } catch {
      // Accessors on untrusted error objects are intentionally ignored.
    }
  }
}

export function redactDiagnostic(value, secretParts = []) {
  const diagnosticParts = [];
  collectDiagnosticStrings(value, diagnosticParts, new Set(), 0);
  let text = diagnosticParts.join("\n");
  const replacements = new Set(
    secretParts
      .flatMap((part) => {
        const normalized = String(part || "");
        return [normalized, encodeURIComponent(normalized)];
      })
      .filter((part) => part.length >= 2)
      .sort((left, right) => right.length - left.length)
  );
  for (const secret of replacements) text = text.split(secret).join("[redacted]");
  return text
    .replaceAll(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-connection]")
    .replaceAll(/postgres(?:ql)?%3A%2F%2F[^\s"'<>]+/gi, "[redacted-connection]")
    .replaceAll(/(?:password|user(?:name)?|role|host|database|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "[redacted-setting]")
    .replaceAll(/[?&][^\s=]+=[^\s&#]*/g, "[redacted-query]")
    .slice(0, 240);
}

export function safeIssueFrom(error, fallbackCode, exitCode = 3) {
  if (error instanceof PostflightIssue) return error;
  return new PostflightIssue(fallbackCode, exitCode, "not_verified");
}

export function assertReadOnlySql(statement) {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw safetyIssue("EMPTY_SQL_REJECTED");
  }
  const normalized = statement
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/--[^\r\n]*/g, " ")
    .trim();
  if (!/^(?:BEGIN\b|SET\s+LOCAL\b|SHOW\b|SELECT\b|WITH\b|ROLLBACK\b)/i.test(normalized)) {
    throw safetyIssue("NON_READ_ONLY_SQL_REJECTED");
  }
  const executableTokens = normalized
    .replaceAll(/'(?:''|[^'])*'/g, "''")
    .replaceAll(/\$[A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z0-9_]*\$/g, "$$");
  if (
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|VACUUM|ANALYZE|COPY\s+FROM|CALL|DO|REFRESH\s+MATERIALIZED\s+VIEW)\b/i.test(
      executableTokens
    )
  ) {
    throw safetyIssue("NON_READ_ONLY_SQL_REJECTED");
  }
  return normalized;
}
