import { auth } from "@/auth";
import type { Session } from "next-auth";
import { getToken, type JWT } from "next-auth/jwt";
import { NextResponse } from "next/server";

import { RequestValidationError } from "./api-validation";
import { getValidGoogleToken } from "./google-oauth-token";

export const YOUTUBE_API_TIMEOUT_MS = 10_000;
export const OPENAI_API_TIMEOUT_MS = 30_000;
const INTERNAL_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ExternalServiceError extends Error {
  readonly status: number | null;

  constructor(status: number | null = null) {
    super("External service request failed.");
    this.name = "ExternalServiceError";
    this.status = status;
  }

  get isAuthorizationError() {
    return this.status === 401 || this.status === 403;
  }
}

export class ExternalServiceTimeoutError extends Error {
  constructor() {
    super("External service request timed out.");
    this.name = "ExternalServiceTimeoutError";
  }
}

export class ServerConfigurationError extends Error {
  constructor() {
    super("The server is not configured for this operation.");
    this.name = "ServerConfigurationError";
  }
}

export async function requireApiUserId(session?: Session | null) {
  const currentSession = session === undefined ? await auth() : session;
  const userId = currentSession?.user?.id;

  if (typeof userId !== "string" || userId.length === 0 || userId.length > 255) {
    return null;
  }

  return userId;
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

export function youtubeAuthorizationRequiredResponse() {
  return NextResponse.json(
    { error: "YouTube authorization is required." },
    { status: 403 }
  );
}

export function serverConfigurationErrorResponse() {
  return NextResponse.json(
    { error: "The service is temporarily unavailable." },
    { status: 500 }
  );
}

function logSafeServerError(context: string, error: unknown) {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const status = error instanceof ExternalServiceError ? error.status : null;

  console.error(`${context} failed`, { errorName, status });
}

export function handleApiError(context: string, error: unknown) {
  if (error instanceof RequestValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  logSafeServerError(context, error);

  if (error instanceof ExternalServiceTimeoutError || isTimeoutError(error)) {
    return NextResponse.json(
      { error: "The external service timed out." },
      { status: 504 }
    );
  }

  if (error instanceof ExternalServiceError) {
    return NextResponse.json(
      { error: "The external service request failed." },
      { status: 502 }
    );
  }

  if (error instanceof ServerConfigurationError) {
    return serverConfigurationErrorResponse();
  }

  return NextResponse.json(
    { error: "An internal server error occurred." },
    { status: 500 }
  );
}

export function isTimeoutError(error: unknown) {
  if (!(error instanceof Error)) return false;

  return [
    "AbortError",
    "TimeoutError",
    "APIConnectionTimeoutError",
    "ExternalServiceTimeoutError",
  ].includes(error.name);
}

export async function fetchJsonWithTimeout<T>(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = YOUTUBE_API_TIMEOUT_MS
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ExternalServiceTimeoutError();
    }

    throw new ExternalServiceError();
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new ExternalServiceError(response.status);
  }

  if (!response.ok) {
    throw new ExternalServiceError(response.status);
  }

  return data as T;
}

function getAuthSecrets(): string | string[] | null {
  const secrets: string[] = [];
  const primarySecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

  if (primarySecret) secrets.push(primarySecret);

  for (let index = 1; index <= 5; index += 1) {
    const rotatedSecret = process.env[`AUTH_SECRET_${index}`];
    if (!rotatedSecret) break;
    secrets.push(rotatedSecret);
  }

  if (secrets.length === 0) return null;
  return secrets.length === 1 ? secrets[0] : secrets;
}

function cookieHeaderContains(cookieHeader: string, cookieName: string) {
  return cookieHeader.split(";").some((entry) => {
    const name = entry.trim().split("=", 1)[0];
    return name === cookieName || name.startsWith(`${cookieName}.`);
  });
}

async function findServerJwtToken(
  request: Request,
  accepts: (token: JWT) => boolean
) {
  const secret = getAuthSecrets();
  if (!secret) throw new ServerConfigurationError();

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieNames = ["__Secure-authjs.session-token", "authjs.session-token"];

  for (const cookieName of cookieNames) {
    if (!cookieHeaderContains(cookieHeader, cookieName)) continue;

    const token = await getToken({
      req: request,
      secret,
      cookieName,
      salt: cookieName,
    });
    if (token && accepts(token)) return token;
  }

  return null;
}

export async function getServerUsageIdentity(
  request: Request,
  expectedUserId: string
) {
  const token = await findServerJwtToken(
    request,
    (candidate) => candidate.internalUserId === expectedUserId
  );
  const sessionVersion = token?.sessionVersion;

  if (
    !token ||
    typeof token.internalUserId !== "string" ||
    !INTERNAL_USER_ID_PATTERN.test(token.internalUserId) ||
    !Number.isSafeInteger(sessionVersion) ||
    (sessionVersion as number) < 1
  ) {
    return null;
  }

  return {
    userId: token.internalUserId,
    sessionVersion: sessionVersion as number,
  };
}

export async function getServerOAuthAccessToken(
  request: Request,
  expectedUserId: string
) {
  const token = await findServerJwtToken(
    request,
    (candidate) => candidate.internalUserId === expectedUserId
  );
  if (token) {
    const googleToken = await getValidGoogleToken(token);

    if (googleToken.status === "success") return googleToken.accessToken;
    if (googleToken.status === "reauthentication_required") return null;
    if (googleToken.status === "configuration_error") {
      throw new ServerConfigurationError();
    }
    if (googleToken.timedOut) throw new ExternalServiceTimeoutError();
    throw new ExternalServiceError();
  }

  return null;
}
