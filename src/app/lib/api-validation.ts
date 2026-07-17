export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_CHANNEL_URL_LENGTH = 512;
export const MAX_CHANNEL_ID_LENGTH = 24;
export const MAX_AI_VIDEOS_PER_TYPE = 50;

const MAX_TITLE_LENGTH = 200;
const MAX_CHANNEL_TITLE_LENGTH = 200;
const MAX_POSTING_FREQUENCY_LENGTH = 100;
const MAX_DATE_LENGTH = 40;
const MAX_VIEW_COUNT = 1_000_000_000_000_000;

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export type JsonObject = Record<string, unknown>;

export type ChannelIdentifier =
  | { type: "channelId"; value: string }
  | { type: "handle"; value: string };

type AISummaryVideo = {
  title: string;
  views: number;
  publishedAt: string;
};

type AISummaryHighlight = {
  title: string;
  views: number;
};

type AISummarySection = {
  count: number;
  averageViews: number;
  postingFrequency: string;
  topVideo: AISummaryHighlight | null;
  lowVideo: AISummaryHighlight | null;
  videos: AISummaryVideo[];
};

export type AISummary = {
  channelTitle: string;
  regular: AISummarySection;
  shorts: AISummarySection;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new RequestValidationError(`${field} must be an object.`);
  }

  return value;
}

function requireString(
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

  if (/[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new RequestValidationError(`${field} contains invalid control characters.`);
  }

  return normalized;
}

function requireSafeInteger(
  value: unknown,
  field: string,
  min: number,
  max: number
) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RequestValidationError(`${field} must be an integer between ${min} and ${max}.`);
  }

  return value as number;
}

async function readRequestText(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");

  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new RequestValidationError("Request body is too large.");
  }

  if (!request.body) {
    throw new RequestValidationError("Request body is required.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new RequestValidationError("Request body is too large.");
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError("Request body must be valid UTF-8.");
  }

  if (text.trim().length === 0) {
    throw new RequestValidationError("Request body is required.");
  }

  return text;
}

export async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<JsonObject> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0].trim();

  if (mediaType !== "application/json") {
    throw new RequestValidationError("Content-Type must be application/json.");
  }

  const text = await readRequestText(request, maxBytes);
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestValidationError("Request body must contain valid JSON.");
  }

  return requireObject(parsed, "request body");
}

export function isValidYouTubeChannelId(value: string) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(value);
}

export function isValidYouTubeVideoId(value: string) {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

function isValidYouTubeHandle(value: string) {
  const characterLength = Array.from(value).length;
  return (
    characterLength >= 1 &&
    characterLength <= 30 &&
    /^[\p{L}\p{N}._-]+$/u.test(value)
  );
}

export function parseYouTubeChannelUrl(input: unknown): ChannelIdentifier {
  const raw = requireString(input, "url", MAX_CHANNEL_URL_LENGTH);
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new RequestValidationError("url must be a valid YouTube channel URL.");
  }

  const allowedHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

  if (
    !["https:", "http:"].includes(url.protocol) ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new RequestValidationError("url must use an allowed YouTube host.");
  }

  let parts: string[];
  try {
    parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new RequestValidationError("url contains invalid path encoding.");
  }

  if (parts[0] === "channel" && parts[1] && isValidYouTubeChannelId(parts[1])) {
    return { type: "channelId", value: parts[1] };
  }

  if (parts[0]?.startsWith("@")) {
    const handle = parts[0].slice(1);
    if (isValidYouTubeHandle(handle)) {
      return { type: "handle", value: handle };
    }
  }

  throw new RequestValidationError(
    "url must contain a valid @handle or /channel/UC... identifier."
  );
}

export function parseYouTubeChannelId(value: unknown, field = "channelId") {
  const channelId = requireString(value, field, MAX_CHANNEL_ID_LENGTH);

  if (!isValidYouTubeChannelId(channelId)) {
    throw new RequestValidationError(`${field} has an invalid format.`);
  }

  return channelId;
}

function parseHighlight(value: unknown, field: string): AISummaryHighlight | null {
  if (value === null) return null;

  const item = requireObject(value, field);
  return {
    title: requireString(item.title, `${field}.title`, MAX_TITLE_LENGTH),
    views: requireSafeInteger(item.views, `${field}.views`, 0, MAX_VIEW_COUNT),
  };
}

function parseSummaryVideo(value: unknown, field: string): AISummaryVideo {
  const video = requireObject(value, field);
  const publishedAt = requireString(
    video.publishedAt,
    `${field}.publishedAt`,
    MAX_DATE_LENGTH
  );

  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new RequestValidationError(`${field}.publishedAt must be a valid date.`);
  }

  return {
    title: requireString(video.title, `${field}.title`, MAX_TITLE_LENGTH),
    views: requireSafeInteger(video.views, `${field}.views`, 0, MAX_VIEW_COUNT),
    publishedAt,
  };
}

function parseSummarySection(value: unknown, field: string): AISummarySection {
  const section = requireObject(value, field);

  if (!Array.isArray(section.videos) || section.videos.length > MAX_AI_VIDEOS_PER_TYPE) {
    throw new RequestValidationError(`${field}.videos has too many items.`);
  }

  const videos = section.videos.map((video, index) =>
    parseSummaryVideo(video, `${field}.videos[${index}]`)
  );
  const count = requireSafeInteger(
    section.count,
    `${field}.count`,
    0,
    MAX_AI_VIDEOS_PER_TYPE
  );

  if (count !== videos.length) {
    throw new RequestValidationError(`${field}.count must match videos.length.`);
  }

  return {
    count,
    averageViews: requireSafeInteger(
      section.averageViews,
      `${field}.averageViews`,
      0,
      MAX_VIEW_COUNT
    ),
    postingFrequency: requireString(
      section.postingFrequency,
      `${field}.postingFrequency`,
      MAX_POSTING_FREQUENCY_LENGTH
    ),
    topVideo: parseHighlight(section.topVideo, `${field}.topVideo`),
    lowVideo: parseHighlight(section.lowVideo, `${field}.lowVideo`),
    videos,
  };
}

export function parseAISummary(value: unknown): AISummary {
  const summary = requireObject(value, "aiSummary");

  return {
    channelTitle: requireString(
      summary.channelTitle,
      "aiSummary.channelTitle",
      MAX_CHANNEL_TITLE_LENGTH
    ),
    regular: parseSummarySection(summary.regular, "aiSummary.regular"),
    shorts: parseSummarySection(summary.shorts, "aiSummary.shorts"),
  };
}
