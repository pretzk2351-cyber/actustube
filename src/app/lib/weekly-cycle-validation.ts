import { RequestValidationError, type JsonObject } from "./api-validation";
import {
  IMPROVEMENT_ACTION_STATUSES,
  type AIConsultSnapshot,
  type ImprovementActionStatus,
} from "./weekly-cycle-types";

export const MAX_ACTION_TITLE_LENGTH = 200;
export const MAX_ACTION_DESCRIPTION_LENGTH = 2_000;
export const MAX_RESULT_NOTE_LENGTH = 2_000;
export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_HISTORY_LIMIT = 20;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function requireObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${field} must be an object.`);
  }
  return value as JsonObject;
}

function requireText(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false
) {
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field} must be a string.`);
  }

  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) {
    throw new RequestValidationError(`${field} has an invalid length.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new RequestValidationError(`${field} contains invalid characters.`);
  }
  return normalized;
}

export function parseUuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RequestValidationError(`${field} must be a valid identifier.`);
  }
  return value;
}

export function isImprovementActionStatus(
  value: unknown
): value is ImprovementActionStatus {
  return IMPROVEMENT_ACTION_STATUSES.some((status) => status === value);
}

export function parseImprovementActionCreate(value: unknown) {
  const body = requireObject(value, "request body");
  return {
    analysisRunId: parseUuid(body.analysisRunId, "analysisRunId"),
    title: requireText(body.title, "title", MAX_ACTION_TITLE_LENGTH),
    description: requireText(
      body.description,
      "description",
      MAX_ACTION_DESCRIPTION_LENGTH,
      true
    ),
  };
}

export function parseImprovementActionUpdate(value: unknown) {
  const body = requireObject(value, "request body");
  const update: {
    title?: string;
    description?: string;
    status?: "completed" | "skipped";
    resultNote?: string;
  } = {};

  if (body.title !== undefined) {
    update.title = requireText(body.title, "title", MAX_ACTION_TITLE_LENGTH);
  }
  if (body.description !== undefined) {
    update.description = requireText(
      body.description,
      "description",
      MAX_ACTION_DESCRIPTION_LENGTH,
      true
    );
  }
  if (body.status !== undefined) {
    if (body.status !== "completed" && body.status !== "skipped") {
      throw new RequestValidationError("status must be completed or skipped.");
    }
    update.status = body.status;
    update.resultNote = requireText(
      body.resultNote,
      "resultNote",
      MAX_RESULT_NOTE_LENGTH
    );
  } else if (body.resultNote !== undefined) {
    throw new RequestValidationError("resultNote requires a terminal status.");
  }

  if (Object.keys(update).length === 0) {
    throw new RequestValidationError("At least one update field is required.");
  }
  return update;
}

export function parseHistoryLimit(value: string | null) {
  if (value === null || value === "") return DEFAULT_HISTORY_LIMIT;
  if (!/^\d+$/.test(value)) {
    throw new RequestValidationError("limit must be an integer.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new RequestValidationError(
      `limit must be between 1 and ${MAX_HISTORY_LIMIT}.`
    );
  }
  return limit;
}

function requireStringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new RequestValidationError(`${field} must be a short array.`);
  }
  return value.map((item, index) =>
    requireText(item, `${field}[${index}]`, 1_000)
  );
}

export function parseAIConsultSnapshot(value: unknown): AIConsultSnapshot {
  const result = requireObject(value, "AI consultation result");
  return {
    overallDiagnosis: requireText(
      result.overallDiagnosis,
      "overallDiagnosis",
      4_000
    ),
    strongPoints: requireStringArray(result.strongPoints, "strongPoints"),
    weakPoints: requireStringArray(result.weakPoints, "weakPoints"),
    currentImprovements: requireStringArray(
      result.currentImprovements,
      "currentImprovements"
    ),
    nextSuggestions: requireStringArray(
      result.nextSuggestions,
      "nextSuggestions"
    ),
  };
}
