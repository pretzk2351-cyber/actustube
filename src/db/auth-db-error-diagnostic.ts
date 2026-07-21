const MAX_ERROR_GRAPH_DEPTH = 4;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 512;
const MAX_DIAGNOSTIC_IDENTIFIER_LENGTH = 128;

const REDACTED = "[REDACTED]";

type UnknownRecord = Record<PropertyKey, unknown>;

type SafeErrorIdentity = {
  name: string | null;
  code: string | null;
};

export type GoogleAccountSyncDiagnostic = {
  error: {
    name: string | null;
  };
  neonDbError: {
    name: string | null;
    message: string | null;
    code: string | null;
    severity: string | null;
    detail: string | null;
    hint: string | null;
    where: string | null;
    schema: string | null;
    table: string | null;
    column: string | null;
    constraint: string | null;
    routine: string | null;
    sourceError: SafeErrorIdentity & {
      cause: SafeErrorIdentity;
    };
  };
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? (value as UnknownRecord)
    : null;
}

function readProperty(value: unknown, property: PropertyKey): unknown {
  const record = asRecord(value);
  if (!record) return undefined;

  try {
    return Reflect.get(record, property);
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const normalized = String(value).trim();
  if (
    !normalized ||
    normalized.length > MAX_DIAGNOSTIC_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_.:-]+$/.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function safeDiagnosticText(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!normalized) return null;

  // Drizzle query errors contain the SQL and bound parameter values. Those
  // messages are intentionally omitted instead of attempting partial redaction.
  if (
    /\b(?:query|params?)\s*:/i.test(normalized) ||
    /\b(?:select|insert|update|delete|merge|call|create|alter|drop)\b\s+/i.test(
      normalized
    )
  ) {
    return null;
  }

  normalized = normalized
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, REDACTED)
    .replace(/\b(?:ya29\.|1\/\/)[A-Za-z0-9._-]+\b/gi, REDACTED)
    .replace(
      /\b(?:authorization|cookie|access[\s_-]?token|refresh[\s_-]?token|id[\s_-]?token|client[\s_-]?id|client[\s_-]?secret|database[\s_-]?url|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      REDACTED
    )
    .replace(
      /\b(?:google[\s_-]?(?:id|sub)|provider[\s_-]?account[\s_-]?id|sub|email|user(?:name)?|name|image(?:[\s_-]?url)?)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      REDACTED
    )
    .replace(/([?&][A-Za-z0-9_.-]+)=([^&#\s]+)/g, `$1=${REDACTED}`)
    .replace(/(\([^)]*\)\s*=\s*)\([^)]*\)/g, `$1(${REDACTED})`)
    .replace(
      /\b(user|role|database)\s+(?:"[^"]*"|'[^']*'|[^,;]+)/gi,
      `$1 ${REDACTED}`
    )
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, REDACTED)
    .replace(/\b\d{16,}\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, REDACTED);

  if (normalized.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
    return `${normalized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 1)}…`;
  }

  return normalized;
}

function errorIdentity(value: unknown): SafeErrorIdentity {
  return {
    name: safeIdentifier(readProperty(value, "name")),
    code: safeIdentifier(readProperty(value, "code")),
  };
}

function findNeonDbError(error: unknown): UnknownRecord | null {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const record = asRecord(current.value);
    if (!record || visited.has(record)) continue;
    visited.add(record);

    if (safeIdentifier(readProperty(record, "name")) === "NeonDbError") {
      return record;
    }

    if (current.depth >= MAX_ERROR_GRAPH_DEPTH) continue;

    queue.push(
      { value: readProperty(record, "cause"), depth: current.depth + 1 },
      {
        value: readProperty(record, "sourceError"),
        depth: current.depth + 1,
      }
    );
  }

  return null;
}

export function buildGoogleAccountSyncDiagnostic(
  error: unknown
): GoogleAccountSyncDiagnostic {
  const neonDbError = findNeonDbError(error);
  const sourceError = readProperty(neonDbError, "sourceError");
  const sourceErrorCause = readProperty(sourceError, "cause");

  return {
    error: {
      name: safeIdentifier(readProperty(error, "name")),
    },
    neonDbError: {
      name: safeIdentifier(readProperty(neonDbError, "name")),
      message: safeDiagnosticText(readProperty(neonDbError, "message")),
      code: safeIdentifier(readProperty(neonDbError, "code")),
      severity: safeIdentifier(readProperty(neonDbError, "severity")),
      detail: safeDiagnosticText(readProperty(neonDbError, "detail")),
      hint: safeDiagnosticText(readProperty(neonDbError, "hint")),
      where: safeDiagnosticText(readProperty(neonDbError, "where")),
      schema: safeIdentifier(readProperty(neonDbError, "schema")),
      table: safeIdentifier(readProperty(neonDbError, "table")),
      column: safeIdentifier(readProperty(neonDbError, "column")),
      constraint: safeIdentifier(readProperty(neonDbError, "constraint")),
      routine: safeIdentifier(readProperty(neonDbError, "routine")),
      sourceError: {
        ...errorIdentity(sourceError),
        cause: errorIdentity(sourceErrorCause),
      },
    },
  };
}
