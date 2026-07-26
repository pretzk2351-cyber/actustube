import { basename, relative, resolve, sep } from "node:path";

const SAFE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

export const FORBIDDEN_ENVIRONMENT_NAME =
  /(?:DATABASE|POSTGRES|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|NEON|VERCEL|TOKEN|SECRET|PASSWORD|PRIVATE|OAUTH|AUTH_KEY|API_KEY|CONNECTION|^CI$|^CI_)/i;

export function createSanitizedEnvironment(sourceEnvironment) {
  const sanitized = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (
      typeof value === "string" &&
      SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()) &&
      !FORBIDDEN_ENVIRONMENT_NAME.test(key)
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function sanitizeDiagnostic(value) {
  return String(value)
    .replaceAll(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-connection]")
    .replaceAll(
      /(?:DATABASE_URL|DIRECT_DATABASE_URL|PGPASSWORD|TOKEN|SECRET|PASSWORD|API_KEY)\s*[=:]\s*[^\s,;]+/gi,
      "[redacted-setting]"
    )
    .replaceAll(/[A-Za-z]:\\[^\r\n"']+/g, "[redacted-path]")
    .replaceAll(/\/(?:Users|home)\/[^\r\n"']+/g, "[redacted-path]")
    .replaceAll(/[A-Za-z0-9_+/=-]{48,}/g, "[redacted-value]")
    .slice(0, 240);
}

export function isSafeHarnessTemporaryPath(candidate, temporaryRoot) {
  const resolvedRoot = resolve(temporaryRoot);
  const resolvedCandidate = resolve(candidate);
  const childPath = relative(resolvedRoot, resolvedCandidate);
  return (
    childPath !== "" &&
    childPath !== ".." &&
    !childPath.startsWith(`..${sep}`) &&
    basename(resolvedCandidate).startsWith("actustube-pg-")
  );
}
