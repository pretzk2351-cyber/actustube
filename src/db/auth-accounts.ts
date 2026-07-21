import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { buildGoogleAccountSyncDiagnostic } from "./auth-db-error-diagnostic";
import { getDatabase, type Database } from "./client";
import type { UserStatus } from "./schema";

const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 200;
const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_SCOPE_LENGTH = 4096;

export type GoogleAccountInput = {
  providerAccountId: string;
  email?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  grantedScope?: string | null;
};

export type GoogleAccountUser = {
  userId: string;
  status: UserStatus;
  sessionVersion: number;
};

type DatabaseExecutor = Pick<Database, "execute">;

export class InvalidGoogleAccountError extends Error {
  constructor() {
    super("Google account identity is invalid.");
    this.name = "InvalidGoogleAccountError";
  }
}

export class GoogleAccountPersistenceError extends Error {
  constructor() {
    super("Google account could not be persisted.");
    this.name = "GoogleAccountPersistenceError";
  }
}

function optionalString(value: string | null | undefined, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeInput(input: GoogleAccountInput) {
  const providerAccountId = input.providerAccountId.trim();
  if (
    !providerAccountId ||
    providerAccountId.length > MAX_PROVIDER_ACCOUNT_ID_LENGTH
  ) {
    throw new InvalidGoogleAccountError();
  }

  return {
    providerAccountId,
    email: optionalString(input.email, MAX_EMAIL_LENGTH),
    name: optionalString(input.name, MAX_NAME_LENGTH),
    imageUrl: optionalString(input.imageUrl, MAX_IMAGE_URL_LENGTH),
    grantedScope: optionalString(input.grantedScope, MAX_SCOPE_LENGTH),
  };
}

function parseUserRow(row: unknown): GoogleAccountUser {
  if (!row || typeof row !== "object") {
    throw new GoogleAccountPersistenceError();
  }

  const candidate = row as Record<string, unknown>;
  if (
    typeof candidate.userId !== "string" ||
    !["active", "suspended", "deleted"].includes(
      String(candidate.status)
    ) ||
    typeof candidate.sessionVersion !== "number" ||
    !Number.isInteger(candidate.sessionVersion) ||
    candidate.sessionVersion < 1
  ) {
    throw new GoogleAccountPersistenceError();
  }

  return {
    userId: candidate.userId,
    status: candidate.status as UserStatus,
    sessionVersion: candidate.sessionVersion,
  };
}

export function buildGoogleAccountUpsertQuery(
  input: GoogleAccountInput,
  now = new Date()
): SQL {
  const normalized = normalizeInput(input);

  return sql`
    SELECT
      "user_id" AS "userId",
      "account_status" AS "status",
      "session_version" AS "sessionVersion"
    FROM "public"."sync_google_oauth_account"(
      ${normalized.providerAccountId},
      ${normalized.email},
      ${normalized.name},
      ${normalized.imageUrl},
      ${normalized.grantedScope},
      ${now}
    )
  `;
}

export async function syncGoogleAccountWithDatabase(
  database: DatabaseExecutor,
  input: GoogleAccountInput,
  now = new Date()
): Promise<GoogleAccountUser> {
  let result: Awaited<ReturnType<DatabaseExecutor["execute"]>>;

  try {
    result = await database.execute(
      buildGoogleAccountUpsertQuery(input, now)
    );
  } catch (error) {
    try {
      console.error(
        "[auth][google-account-sync-diagnostic]",
        buildGoogleAccountSyncDiagnostic(error)
      );
    } catch {
      // Diagnostic logging must never replace the original persistence error.
    }
    throw error;
  }

  return parseUserRow(result.rows[0]);
}

export async function syncGoogleAccount(
  input: GoogleAccountInput
): Promise<GoogleAccountUser> {
  return syncGoogleAccountWithDatabase(getDatabase(), input);
}
