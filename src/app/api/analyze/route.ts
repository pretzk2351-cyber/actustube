import { NextResponse } from "next/server";

import {
  isValidYouTubeChannelId,
  isValidYouTubeVideoId,
  parseYouTubeChannelId,
  parseYouTubeChannelUrl,
  readJsonObject,
  RequestValidationError,
} from "@/app/lib/api-validation";
import {
  ExternalServiceError,
  fetchJsonWithTimeout,
  handleApiError,
  OPENAI_API_TIMEOUT_MS,
  requireApiUserId,
  serverConfigurationErrorResponse,
  unauthorizedResponse,
} from "@/app/lib/api-security";

type Video = {
  videoId: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
  duration: number;
  view: number;
  like: number;
  comment: number;
};

type YouTubeChannelListResponse = {
  items?: Array<{ id?: unknown }>;
};

type YouTubeSearchResponse = {
  items?: Array<{ id?: { videoId?: unknown } }>;
};

type YouTubeVideoListResponse = {
  items?: Array<{
    id: string;
    snippet: {
      title: string;
      thumbnails: { medium: { url: string } };
      publishedAt: string;
    };
    contentDetails: { duration: string };
    statistics: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
  }>;
};

type OpenAIChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

function parseDuration(d: string) {
  const m = d.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  return (Number(m?.[1] || 0) * 60) + Number(m?.[2] || 0);
}

async function getChannelId(handle: string, key: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("forHandle", handle);
  url.searchParams.set("key", key);

  const data = await fetchJsonWithTimeout<YouTubeChannelListResponse>(url, {
    cache: "no-store",
  });
  const channelId = data.items?.[0]?.id;

  if (typeof channelId !== "string" || !isValidYouTubeChannelId(channelId)) {
    throw new ExternalServiceError();
  }

  return channelId;
}

async function getVideos(channelId: string, key: string) {
  const listUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  listUrl.searchParams.set("part", "snippet");
  listUrl.searchParams.set("channelId", channelId);
  listUrl.searchParams.set("maxResults", "50");
  listUrl.searchParams.set("order", "date");
  listUrl.searchParams.set("type", "video");
  listUrl.searchParams.set("key", key);

  const list = await fetchJsonWithTimeout<YouTubeSearchResponse>(listUrl, {
    cache: "no-store",
  });
  const items = Array.isArray(list.items) ? list.items : [];
  const ids = items
    .map((item) => item.id?.videoId)
    .filter(
      (videoId: unknown): videoId is string =>
        typeof videoId === "string" && isValidYouTubeVideoId(videoId)
    );

  if (ids.length === 0) return [];

  const detailUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  detailUrl.searchParams.set("part", "snippet,contentDetails,statistics");
  detailUrl.searchParams.set("id", ids.join(","));
  detailUrl.searchParams.set("key", key);

  const detail = await fetchJsonWithTimeout<YouTubeVideoListResponse>(detailUrl, {
    cache: "no-store",
  });
  const detailItems = Array.isArray(detail.items) ? detail.items : [];

  return detailItems.map((v) => ({
    videoId: v.id,
    title: v.snippet.title,
    thumbnail: v.snippet.thumbnails.medium.url,
    publishedAt: v.snippet.publishedAt,
    duration: parseDuration(v.contentDetails.duration),
    view: Number(v.statistics.viewCount || 0),
    like: Number(v.statistics.likeCount || 0),
    comment: Number(v.statistics.commentCount || 0),
  }));
}

function split(videos: Video[]) {
  const normal: Video[] = [];
  const shorts: Video[] = [];

  for (const v of videos) {
    if (v.duration <= 180 && shorts.length < 10) shorts.push(v);
    else if (v.duration > 180 && normal.length < 10) normal.push(v);

    if (shorts.length === 10 && normal.length === 10) break;
  }

  return { normal, shorts };
}

function score(videos: Video[]) {
  if (!videos.length) return 0;

  const avg = videos.reduce((s, v) => s + v.view, 0) / videos.length;
  const max = Math.max(...videos.map((v) => v.view), 1);

  const eng =
    videos.reduce(
      (s, v) => s + (v.view ? (v.like + v.comment) / v.view : 0),
      0
    ) / videos.length;

  return Math.round((avg / max) * 60 + eng * 40);
}

function buildPriority(n: number, s: number) {
  const list: string[] = [];

  if (n < 60) list.push("通常動画の改善を優先");
  if (s < 60) list.push("ショート動画の改善を優先");
  if (n > s) list.push("通常動画の強みを維持");
  if (s > n) list.push("ショートの伸びを強化");

  return list;
}

function buildPrompt(n: number, s: number) {
  return `
短く箇条書きのみで出力

通常:
- 傾向:
- 問題:
- 改善:

ショート:
- 傾向:
- 問題:
- 改善:

行動:
- 
- 
- 

条件:
・1行は短く
・抽象禁止
・行動可能な内容のみ
・無駄な説明禁止

スコア:
通常 ${n}
ショート ${s}
`;
}

async function analyze(prompt: string, apiKey: string) {
  const data = await fetchJsonWithTimeout<OpenAIChatCompletionResponse>(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
      }),
      cache: "no-store",
    },
    OPENAI_API_TIMEOUT_MS
  );

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new ExternalServiceError();
  }

  return content;
}

export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    if (!userId) return unauthorizedResponse();

    const body = await readJsonObject(req, 8 * 1024);
    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!youtubeApiKey || !openaiApiKey) {
      return serverConfigurationErrorResponse();
    }

    let channelId = "";

    // ===== URLモード =====
    if (body.mode === "manual_url") {
      const identifier = parseYouTubeChannelUrl(body.url);
      channelId =
        identifier.type === "channelId"
          ? identifier.value
          : await getChannelId(identifier.value, youtubeApiKey);
    } else if (body.mode === "my_channel") {
      // The user identity always comes from the server session. Only the channel
      // identifier is accepted from the request and is validated independently.
      channelId = parseYouTubeChannelId(body.channelId);
    } else {
      throw new RequestValidationError("mode must be manual_url or my_channel.");
    }

    const videos = await getVideos(channelId, youtubeApiKey);
    const { normal, shorts } = split(videos);

    const nScore = score(normal);
    const sScore = score(shorts);

    const report = await analyze(buildPrompt(nScore, sScore), openaiApiKey);

    return NextResponse.json({
      normal,
      shorts,
      nScore,
      sScore,
      priority: buildPriority(nScore, sScore),
      report,
    });
  } catch (error) {
    return handleApiError("analyze", error);
  }
}
