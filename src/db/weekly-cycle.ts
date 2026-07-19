import "server-only";

import { sql, type SQL } from "drizzle-orm";

import type {
  AIConsultSnapshot,
  AnalysisHistoryItem,
  ChannelAnalysisSnapshot,
  ImprovementActionStatus,
  ImprovementActionView,
  WeeklyCycleHistoryResponse,
} from "@/app/lib/weekly-cycle-types";

import { getDatabase, type Database } from "./client";

type DatabaseExecutor = Pick<Database, "execute">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export type FinalizeChannelAnalysisInput = {
  reservationId: string;
  userId: string;
  snapshot: ChannelAnalysisSnapshot;
  analyzedAt?: Date;
};

export type FinalizeAIConsultInput = {
  reservationId: string;
  userId: string;
  analysisRunId: string;
  aiConsult: AIConsultSnapshot;
  createdAt?: Date;
};

export type HistoryCursor = { analyzedAt: Date; id: string };

export type CreateImprovementActionInput = {
  userId: string;
  analysisRunId: string;
  title: string;
  description: string;
};

export type UpdateImprovementActionInput = {
  userId: string;
  actionId: string;
  title?: string;
  description?: string;
  status?: "completed" | "skipped";
  resultNote?: string;
};

export class WeeklyCyclePersistenceError extends Error {
  constructor() {
    super("Weekly improvement cycle data could not be updated.");
    this.name = "WeeklyCyclePersistenceError";
  }
}

export class WeeklyCycleNotFoundError extends Error {
  constructor() {
    super("The requested weekly improvement cycle item was not found.");
    this.name = "WeeklyCycleNotFoundError";
  }
}

export class WeeklyCycleConflictError extends Error {
  constructor() {
    super("A planned improvement action already exists or cannot be changed.");
    this.name = "WeeklyCycleConflictError";
  }
}

function assertUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new WeeklyCyclePersistenceError();
}

function safeDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new WeeklyCyclePersistenceError();
  return date;
}

function safeInteger(value: unknown) {
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    throw new WeeklyCyclePersistenceError();
  }
  return number;
}

function safeAverage(videos: ChannelAnalysisSnapshot["regularVideos"]) {
  if (videos.length === 0) return 0;
  const total = videos.reduce((sum, video) => {
    const views = Number(video.viewCount);
    if (!Number.isSafeInteger(views) || views < 0) {
      throw new WeeklyCyclePersistenceError();
    }
    return sum + views;
  }, 0);
  if (!Number.isSafeInteger(total)) throw new WeeklyCyclePersistenceError();
  return Math.round(total / videos.length);
}

function normalizeChannelFinalization(input: FinalizeChannelAnalysisInput) {
  assertUuid(input.reservationId);
  assertUuid(input.userId);
  if (
    !CHANNEL_ID_PATTERN.test(input.snapshot.channelId) ||
    input.snapshot.channelTitle.trim().length === 0 ||
    input.snapshot.channelTitle.trim().length > 200 ||
    input.snapshot.regularVideos.length > 50 ||
    input.snapshot.shortVideos.length > 50
  ) {
    throw new WeeklyCyclePersistenceError();
  }
  const analyzedAt = input.analyzedAt ?? new Date();
  if (Number.isNaN(analyzedAt.getTime())) throw new WeeklyCyclePersistenceError();
  return {
    ...input,
    analyzedAt,
    regularVideoCount: input.snapshot.regularVideos.length,
    shortVideoCount: input.snapshot.shortVideos.length,
    regularAverageViews: safeAverage(input.snapshot.regularVideos),
    shortAverageViews: safeAverage(input.snapshot.shortVideos),
  };
}

export function buildFinalizeChannelAnalysisQuery(
  input: FinalizeChannelAnalysisInput
): SQL {
  const normalized = normalizeChannelFinalization(input);
  return sql`
    SELECT "public"."finalize_channel_analysis_reservation"(
      ${normalized.reservationId}::uuid,
      ${normalized.userId}::uuid,
      ${normalized.snapshot.channelId}::varchar,
      ${normalized.snapshot.channelTitle.trim()}::varchar,
      ${JSON.stringify(normalized.snapshot)}::jsonb,
      ${normalized.regularVideoCount}::integer,
      ${normalized.shortVideoCount}::integer,
      ${normalized.regularAverageViews}::bigint,
      ${normalized.shortAverageViews}::bigint,
      ${normalized.analyzedAt.toISOString()}::timestamp with time zone
    ) AS "analysisRunId"
  `;
}

export async function finalizeChannelAnalysisWithDatabase(
  database: DatabaseExecutor,
  input: FinalizeChannelAnalysisInput
) {
  try {
    const row = (await database.execute(buildFinalizeChannelAnalysisQuery(input)))
      .rows[0] as Record<string, unknown> | undefined;
    const id = row?.analysisRunId;
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw new WeeklyCyclePersistenceError();
    }
    return id;
  } catch (error) {
    if (error instanceof WeeklyCyclePersistenceError) throw error;
    throw new WeeklyCyclePersistenceError();
  }
}

export function finalizeChannelAnalysis(input: FinalizeChannelAnalysisInput) {
  return finalizeChannelAnalysisWithDatabase(getDatabase(), input);
}

export function buildFinalizeAIConsultQuery(input: FinalizeAIConsultInput): SQL {
  assertUuid(input.reservationId);
  assertUuid(input.userId);
  assertUuid(input.analysisRunId);
  const createdAt = input.createdAt ?? new Date();
  if (Number.isNaN(createdAt.getTime())) throw new WeeklyCyclePersistenceError();
  return sql`
    SELECT "public"."finalize_ai_consult_reservation"(
      ${input.reservationId}::uuid,
      ${input.userId}::uuid,
      ${input.analysisRunId}::uuid,
      ${JSON.stringify(input.aiConsult)}::jsonb,
      ${createdAt.toISOString()}::timestamp with time zone
    ) AS "finalized"
  `;
}

export async function finalizeAIConsultWithDatabase(
  database: DatabaseExecutor,
  input: FinalizeAIConsultInput
) {
  try {
    const row = (await database.execute(buildFinalizeAIConsultQuery(input))).rows[0] as
      | Record<string, unknown>
      | undefined;
    if (typeof row?.finalized !== "boolean" || !row.finalized) {
      throw new WeeklyCyclePersistenceError();
    }
    return true;
  } catch (error) {
    if (error instanceof WeeklyCyclePersistenceError) throw error;
    throw new WeeklyCyclePersistenceError();
  }
}

export function finalizeAIConsult(input: FinalizeAIConsultInput) {
  return finalizeAIConsultWithDatabase(getDatabase(), input);
}

export async function analysisRunBelongsToUserWithDatabase(
  database: DatabaseExecutor,
  userId: string,
  analysisRunId: string
) {
  assertUuid(userId);
  assertUuid(analysisRunId);
  try {
    const result = await database.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM public.analysis_runs AS run
        WHERE run.id = ${analysisRunId}::uuid
          AND run.user_id = ${userId}::uuid
      ) AS "exists"
    `);
    const exists = (result.rows[0] as Record<string, unknown> | undefined)?.exists;
    if (typeof exists !== "boolean") throw new WeeklyCyclePersistenceError();
    return exists;
  } catch (error) {
    if (error instanceof WeeklyCyclePersistenceError) throw error;
    throw new WeeklyCyclePersistenceError();
  }
}

export function analysisRunBelongsToUser(userId: string, analysisRunId: string) {
  return analysisRunBelongsToUserWithDatabase(
    getDatabase(),
    userId,
    analysisRunId
  );
}

export async function weeklyCycleIdentityIsValidWithDatabase(
  database: DatabaseExecutor,
  input: { userId: string; sessionVersion: number }
) {
  assertUuid(input.userId);
  if (!Number.isSafeInteger(input.sessionVersion) || input.sessionVersion < 1) {
    throw new WeeklyCyclePersistenceError();
  }
  try {
    const result = await database.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM public.users AS app_user
        WHERE app_user.id = ${input.userId}::uuid
          AND app_user.status = 'active'
          AND app_user.session_version = ${input.sessionVersion}::integer
      ) AS "valid"
    `);
    const valid = (result.rows[0] as Record<string, unknown> | undefined)?.valid;
    if (typeof valid !== "boolean") throw new WeeklyCyclePersistenceError();
    return valid;
  } catch (error) {
    if (error instanceof WeeklyCyclePersistenceError) throw error;
    throw new WeeklyCyclePersistenceError();
  }
}

export function weeklyCycleIdentityIsValid(input: {
  userId: string;
  sessionVersion: number;
}) {
  return weeklyCycleIdentityIsValidWithDatabase(getDatabase(), input);
}

function parseAction(row: Record<string, unknown>, prefix = ""): ImprovementActionView {
  const get = (name: string) =>
    row[
      prefix
        ? `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`
        : name
    ];
  const status = get("status");
  if (
    typeof get("id") !== "string" ||
    !UUID_PATTERN.test(get("id") as string) ||
    typeof get("analysisRunId") !== "string" ||
    !UUID_PATTERN.test(get("analysisRunId") as string) ||
    typeof get("title") !== "string" ||
    typeof get("description") !== "string" ||
    !["planned", "completed", "skipped"].includes(String(status))
  ) {
    throw new WeeklyCyclePersistenceError();
  }
  return {
    id: get("id") as string,
    analysisRunId: get("analysisRunId") as string,
    title: get("title") as string,
    description: get("description") as string,
    status: status as ImprovementActionStatus,
    resultNote: typeof get("resultNote") === "string" ? (get("resultNote") as string) : null,
    createdAt: safeDate(get("createdAt")).toISOString(),
    updatedAt: safeDate(get("updatedAt")).toISOString(),
    completedAt: get("completedAt") ? safeDate(get("completedAt")).toISOString() : null,
  };
}

export function encodeHistoryCursor(cursor: HistoryCursor) {
  assertUuid(cursor.id);
  if (Number.isNaN(cursor.analyzedAt.getTime())) throw new WeeklyCyclePersistenceError();
  return Buffer.from(
    JSON.stringify([cursor.analyzedAt.toISOString(), cursor.id]),
    "utf8"
  ).toString("base64url");
}

export function decodeHistoryCursor(value: string | null): HistoryCursor | null {
  if (!value) return null;
  try {
    if (value.length > 256) throw new Error("cursor too long");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("bad cursor");
    const analyzedAt = safeDate(parsed[0]);
    const id = String(parsed[1]);
    assertUuid(id);
    return { analyzedAt, id };
  } catch {
    throw new WeeklyCyclePersistenceError();
  }
}

export async function listWeeklyCyclesWithDatabase(
  database: DatabaseExecutor,
  input: { userId: string; limit: number; cursor?: HistoryCursor | null }
): Promise<WeeklyCycleHistoryResponse> {
  assertUuid(input.userId);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
    throw new WeeklyCyclePersistenceError();
  }
  const cursorClause = input.cursor
    ? sql`AND (run.analyzed_at, run.id) < (${input.cursor.analyzedAt.toISOString()}::timestamp with time zone, ${input.cursor.id}::uuid)`
    : sql``;

  try {
    const [historyResult, plannedResult] = await Promise.all([
      database.execute(sql`
        SELECT
          run.id,
          run.channel_id AS "channelId",
          run.channel_title AS "channelTitle",
          run.analyzed_at AS "analyzedAt",
          run.regular_video_count AS "regularVideoCount",
          run.short_video_count AS "shortVideoCount",
          run.regular_average_views AS "regularAverageViews",
          run.short_average_views AS "shortAverageViews",
          (run.ai_consult_snapshot IS NOT NULL) AS "hasAIConsult",
          run.ai_consult_created_at AS "aiConsultCreatedAt",
          action.id AS "actionId",
          action.analysis_run_id AS "actionAnalysisRunId",
          action.title AS "actionTitle",
          action.description AS "actionDescription",
          action.status AS "actionStatus",
          action.result_note AS "actionResultNote",
          action.created_at AS "actionCreatedAt",
          action.updated_at AS "actionUpdatedAt",
          action.completed_at AS "actionCompletedAt"
        FROM public.analysis_runs AS run
        LEFT JOIN public.improvement_actions AS action
          ON action.analysis_run_id = run.id
          AND action.user_id = run.user_id
        WHERE run.user_id = ${input.userId}::uuid
          ${cursorClause}
        ORDER BY run.analyzed_at DESC, run.id DESC
        LIMIT ${input.limit + 1}
      `),
      database.execute(sql`
        SELECT
          action.id,
          action.analysis_run_id AS "analysisRunId",
          action.title,
          action.description,
          action.status,
          action.result_note AS "resultNote",
          action.created_at AS "createdAt",
          action.updated_at AS "updatedAt",
          action.completed_at AS "completedAt"
        FROM public.improvement_actions AS action
        WHERE action.user_id = ${input.userId}::uuid
          AND action.status = 'planned'
        LIMIT 1
      `),
    ]);

    const rawRows = historyResult.rows as Record<string, unknown>[];
    const hasMore = rawRows.length > input.limit;
    const pageRows = rawRows.slice(0, input.limit);
    const items: AnalysisHistoryItem[] = pageRows.map((row) => {
      const id = row.id;
      if (
        typeof id !== "string" ||
        !UUID_PATTERN.test(id) ||
        typeof row.channelId !== "string" ||
        typeof row.channelTitle !== "string" ||
        typeof row.hasAIConsult !== "boolean"
      ) {
        throw new WeeklyCyclePersistenceError();
      }
      return {
        id,
        channelId: row.channelId,
        channelTitle: row.channelTitle,
        analyzedAt: safeDate(row.analyzedAt).toISOString(),
        regularVideoCount: safeInteger(row.regularVideoCount),
        shortVideoCount: safeInteger(row.shortVideoCount),
        regularAverageViews: safeInteger(row.regularAverageViews),
        shortAverageViews: safeInteger(row.shortAverageViews),
        hasAIConsult: row.hasAIConsult,
        aiConsultCreatedAt: row.aiConsultCreatedAt
          ? safeDate(row.aiConsultCreatedAt).toISOString()
          : null,
        action: row.actionId ? parseAction(row, "action") : null,
      };
    });
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeHistoryCursor({
            analyzedAt: safeDate(last.analyzedAt),
            id: String(last.id),
          })
        : null;
    const plannedRow = plannedResult.rows[0] as Record<string, unknown> | undefined;
    return {
      items,
      plannedAction: plannedRow ? parseAction(plannedRow) : null,
      nextCursor,
    };
  } catch (error) {
    if (error instanceof WeeklyCyclePersistenceError) throw error;
    throw new WeeklyCyclePersistenceError();
  }
}

export function listWeeklyCycles(input: {
  userId: string;
  limit: number;
  cursor?: HistoryCursor | null;
}) {
  return listWeeklyCyclesWithDatabase(getDatabase(), input);
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function createImprovementActionWithDatabase(
  database: DatabaseExecutor,
  input: CreateImprovementActionInput
) {
  assertUuid(input.userId);
  assertUuid(input.analysisRunId);
  try {
    const result = await database.execute(sql`
      INSERT INTO public.improvement_actions (
        user_id, analysis_run_id, title, description, status
      )
      SELECT
        ${input.userId}::uuid,
        run.id,
        ${input.title},
        ${input.description},
        'planned'
      FROM public.analysis_runs AS run
      WHERE run.id = ${input.analysisRunId}::uuid
        AND run.user_id = ${input.userId}::uuid
      RETURNING
        id,
        analysis_run_id AS "analysisRunId",
        title,
        description,
        status,
        result_note AS "resultNote",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new WeeklyCycleNotFoundError();
    return parseAction(row);
  } catch (error) {
    if (
      error instanceof WeeklyCycleNotFoundError ||
      error instanceof WeeklyCyclePersistenceError
    ) {
      throw error;
    }
    if (isUniqueViolation(error)) throw new WeeklyCycleConflictError();
    throw new WeeklyCyclePersistenceError();
  }
}

export function createImprovementAction(input: CreateImprovementActionInput) {
  return createImprovementActionWithDatabase(getDatabase(), input);
}

export async function updateImprovementActionWithDatabase(
  database: DatabaseExecutor,
  input: UpdateImprovementActionInput
) {
  assertUuid(input.userId);
  assertUuid(input.actionId);
  try {
    const currentResult = await database.execute(sql`
      SELECT title, description, status
      FROM public.improvement_actions
      WHERE id = ${input.actionId}::uuid
        AND user_id = ${input.userId}::uuid
      LIMIT 1
    `);
    const current = currentResult.rows[0] as Record<string, unknown> | undefined;
    if (!current) throw new WeeklyCycleNotFoundError();
    if (current.status !== "planned") throw new WeeklyCycleConflictError();

    const title = input.title ?? String(current.title);
    const description = input.description ?? String(current.description);
    const status = input.status ?? "planned";
    const resultNote = input.status ? input.resultNote ?? null : null;
    const result = await database.execute(sql`
      UPDATE public.improvement_actions
      SET
        title = ${title},
        description = ${description},
        status = ${status}::public.improvement_action_status,
        result_note = ${resultNote},
        completed_at = CASE WHEN ${status} = 'completed' THEN now() ELSE NULL END,
        updated_at = now()
      WHERE id = ${input.actionId}::uuid
        AND user_id = ${input.userId}::uuid
        AND status = 'planned'
      RETURNING
        id,
        analysis_run_id AS "analysisRunId",
        title,
        description,
        status,
        result_note AS "resultNote",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
    `);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new WeeklyCycleConflictError();
    return parseAction(row);
  } catch (error) {
    if (
      error instanceof WeeklyCycleNotFoundError ||
      error instanceof WeeklyCycleConflictError ||
      error instanceof WeeklyCyclePersistenceError
    ) {
      throw error;
    }
    throw new WeeklyCyclePersistenceError();
  }
}

export function updateImprovementAction(input: UpdateImprovementActionInput) {
  return updateImprovementActionWithDatabase(getDatabase(), input);
}
