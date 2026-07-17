import { createHash } from "node:crypto";

import type { Account } from "next-auth";
import type { JWT } from "next-auth/jwt";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;
const FAILURE_CACHE_MS = 5_000;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_CACHE_ENTRIES = 500;

type GoogleTokenSuccess = {
  status: "success";
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
};

type GoogleTokenFailure =
  | { status: "reauthentication_required" }
  | { status: "temporarily_unavailable"; timedOut: boolean }
  | { status: "configuration_error" };

export type GoogleTokenResult = GoogleTokenSuccess | GoogleTokenFailure;

type CachedAccessToken = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
};

type CachedFailure = {
  result: GoogleTokenFailure;
  expiresAt: number;
};

const accessTokenCache = new Map<string, CachedAccessToken>();
const failureCache = new Map<string, CachedFailure>();
const refreshesInFlight = new Map<string, Promise<GoogleTokenResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH
  );
}

function isExpiry(value: unknown, now = Date.now()): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <=
      Math.floor(now / 1_000) + MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  );
}

function isAccessTokenUsable(
  accessToken: unknown,
  accessTokenExpiresAt: unknown,
  now = Date.now()
) {
  return (
    isBoundedToken(accessToken) &&
    isExpiry(accessTokenExpiresAt, now) &&
    now + ACCESS_TOKEN_REFRESH_BUFFER_MS < accessTokenExpiresAt * 1_000
  );
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function getSubjectCachePrefix(subject: unknown) {
  return typeof subject === "string" && subject.length > 0
    ? fingerprint(subject)
    : null;
}

function getCacheKey(token: JWT, refreshToken: string) {
  const subjectPrefix = getSubjectCachePrefix(token.sub);
  return subjectPrefix
    ? `${subjectPrefix}:${fingerprint(refreshToken)}`
    : null;
}

function deleteOldestEntry<T>(cache: Map<string, T>) {
  if (cache.size < MAX_CACHE_ENTRIES) return;

  const oldestKey = cache.keys().next().value;
  if (typeof oldestKey === "string") cache.delete(oldestKey);
}

function cacheAccessToken(key: string | null, result: GoogleTokenSuccess) {
  if (!key) return;

  deleteOldestEntry(accessTokenCache);
  accessTokenCache.set(key, {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    refreshToken: result.refreshToken,
  });
  failureCache.delete(key);
}

function cacheFailure(key: string | null, result: GoogleTokenFailure) {
  if (!key) return;

  deleteOldestEntry(failureCache);
  failureCache.set(key, {
    result,
    expiresAt: Date.now() + FAILURE_CACHE_MS,
  });
}

function getCachedResult(key: string | null): GoogleTokenResult | null {
  if (!key) return null;

  const cachedAccessToken = accessTokenCache.get(key);
  if (cachedAccessToken) {
    if (
      isAccessTokenUsable(
        cachedAccessToken.accessToken,
        cachedAccessToken.accessTokenExpiresAt
      )
    ) {
      return { status: "success", ...cachedAccessToken };
    }

    accessTokenCache.delete(key);
  }

  const cachedFailure = failureCache.get(key);
  if (cachedFailure) {
    if (Date.now() < cachedFailure.expiresAt) return cachedFailure.result;
    failureCache.delete(key);
  }

  return null;
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function requestRefreshedGoogleToken(
  refreshToken: string
): Promise<GoogleTokenResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) return { status: "configuration_error" };

  let response: Response;

  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: "temporarily_unavailable",
      timedOut: isTimeoutError(error),
    };
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch (error) {
    return {
      status: "temporarily_unavailable",
      timedOut: isTimeoutError(error),
    };
  }

  if (!response.ok) {
    if (isRecord(data) && data.error === "invalid_grant") {
      return { status: "reauthentication_required" };
    }

    const configurationErrors = new Set([
      "invalid_client",
      "invalid_request",
      "invalid_scope",
      "unauthorized_client",
      "unsupported_grant_type",
    ]);

    if (
      response.status === 401 ||
      (isRecord(data) &&
        typeof data.error === "string" &&
        configurationErrors.has(data.error))
    ) {
      return { status: "configuration_error" };
    }

    return { status: "temporarily_unavailable", timedOut: false };
  }

  if (!isRecord(data)) {
    return { status: "temporarily_unavailable", timedOut: false };
  }

  const expiresIn = data.expires_in;
  const tokenType = data.token_type;

  if (
    !isBoundedToken(data.access_token) ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_ACCESS_TOKEN_LIFETIME_SECONDS ||
    (tokenType !== undefined &&
      (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer")) ||
    (data.refresh_token !== undefined && !isBoundedToken(data.refresh_token))
  ) {
    return { status: "temporarily_unavailable", timedOut: false };
  }

  return {
    status: "success",
    accessToken: data.access_token,
    accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + expiresIn,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
  };
}

async function refreshGoogleToken(
  token: JWT,
  refreshToken: string
): Promise<GoogleTokenResult> {
  const key = getCacheKey(token, refreshToken);
  const cachedResult = getCachedResult(key);
  if (cachedResult) return cachedResult;

  if (!key) return requestRefreshedGoogleToken(refreshToken);

  const existingRefresh = refreshesInFlight.get(key);
  if (existingRefresh) return existingRefresh;

  let refresh: Promise<GoogleTokenResult>;

  refresh = requestRefreshedGoogleToken(refreshToken).then((result) => {
    if (refreshesInFlight.get(key) !== refresh) return result;

    if (result.status === "success") {
      cacheAccessToken(key, result);
    } else {
      cacheFailure(key, result);
    }

    return result;
  });

  refreshesInFlight.set(key, refresh);

  try {
    return await refresh;
  } finally {
    if (refreshesInFlight.get(key) === refresh) {
      refreshesInFlight.delete(key);
    }
  }
}

export function clearGoogleTokenCache(subject: unknown) {
  const subjectPrefix = getSubjectCachePrefix(subject);
  if (!subjectPrefix) return;

  const keyPrefix = `${subjectPrefix}:`;

  for (const key of accessTokenCache.keys()) {
    if (key.startsWith(keyPrefix)) accessTokenCache.delete(key);
  }

  for (const key of failureCache.keys()) {
    if (key.startsWith(keyPrefix)) failureCache.delete(key);
  }

  for (const key of refreshesInFlight.keys()) {
    if (key.startsWith(keyPrefix)) refreshesInFlight.delete(key);
  }
}

export function storeInitialGoogleToken(token: JWT, account: Account) {
  clearGoogleTokenCache(token.sub);

  token.accessToken = isBoundedToken(account.access_token)
    ? account.access_token
    : undefined;
  token.refreshToken = isBoundedToken(account.refresh_token)
    ? account.refresh_token
    : isBoundedToken(token.refreshToken)
      ? token.refreshToken
      : undefined;
  token.accessTokenExpiresAt = isExpiry(account.expires_at)
    ? account.expires_at
    : undefined;
  token.googleTokenError = undefined;

  return token;
}

export async function getValidGoogleToken(token: JWT): Promise<GoogleTokenResult> {
  const accessToken = token.accessToken;
  const accessTokenExpiresAt = token.accessTokenExpiresAt;

  if (
    isBoundedToken(accessToken) &&
    isExpiry(accessTokenExpiresAt) &&
    isAccessTokenUsable(accessToken, accessTokenExpiresAt)
  ) {
    return {
      status: "success",
      accessToken,
      accessTokenExpiresAt,
      refreshToken: isBoundedToken(token.refreshToken)
        ? token.refreshToken
        : undefined,
    };
  }

  if (token.googleTokenError === "ReauthenticationRequired") {
    return { status: "reauthentication_required" };
  }

  if (!isBoundedToken(token.refreshToken)) {
    return { status: "reauthentication_required" };
  }

  const cachedResult = getCachedResult(
    getCacheKey(token, token.refreshToken)
  );
  if (cachedResult) return cachedResult;

  return refreshGoogleToken(token, token.refreshToken);
}
