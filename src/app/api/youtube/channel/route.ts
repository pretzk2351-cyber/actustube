import { NextRequest, NextResponse } from "next/server";

import {
  isValidYouTubeChannelId,
  isValidYouTubeVideoId,
  parseYouTubeChannelUrl,
} from "@/app/lib/api-validation";
import {
  ExternalServiceError,
  fetchJsonWithTimeout,
  handleApiError,
  requireApiUserId,
  serverConfigurationErrorResponse,
  unauthorizedResponse,
} from "@/app/lib/api-security";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SERVER_PLAN = "free" as const;
const PER_TYPE_LIMIT = 10;
const FETCH_POOL_SIZE = 50;

type YouTubeChannelListResponse = {
  items?: Array<{
    id?: string;
    contentDetails?: { relatedPlaylists?: { uploads?: unknown } };
    snippet?: { title?: string; description?: string };
    statistics?: {
      subscriberCount?: string;
      videoCount?: string;
      viewCount?: string;
    };
  }>;
};

type YouTubePlaylistItemsResponse = {
  items?: Array<{ contentDetails?: { videoId?: unknown } }>;
  nextPageToken?: unknown;
};

type YouTubeVideoItem = {
  id?: string;
  snippet?: {
    title?: string;
    publishedAt?: string;
    thumbnails?: {
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
  statistics?: { viewCount?: string };
  contentDetails?: { duration?: string };
};

type YouTubeVideoListResponse = {
  items?: YouTubeVideoItem[];
};

function parseISODurationToSeconds(duration: string) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);

  if (!match) return 0;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  return hours * 3600 + minutes * 60 + seconds;
}

async function safeJsonFetch<T>(url: URL) {
  return fetchJsonWithTimeout<T>(url, { cache: "no-store" });
}

async function getChannelIdFromHandle(handle: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("forHandle", handle.replace("@", ""));
  url.searchParams.set("key", YOUTUBE_API_KEY!);

  const data = await safeJsonFetch<YouTubeChannelListResponse>(url);
  const item = data.items?.[0];

  if (!item?.id || !isValidYouTubeChannelId(item.id)) {
    throw new ExternalServiceError();
  }

  return item.id;
}

async function getChannelInfo(channelId: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails,snippet,statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", YOUTUBE_API_KEY!);

  const data = await safeJsonFetch<YouTubeChannelListResponse>(url);
  const item = data.items?.[0];

  if (!item) {
    throw new ExternalServiceError();
  }

  const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;
  if (
    typeof uploadsPlaylistId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(uploadsPlaylistId)
  ) {
    throw new ExternalServiceError();
  }

  return {
    uploadsPlaylistId,
    channelTitle: item.snippet?.title ?? "",
    channelDescription: item.snippet?.description ?? "",
    subscriberCount: item.statistics?.subscriberCount ?? "0",
    videoCount: item.statistics?.videoCount ?? "0",
    viewCount: item.statistics?.viewCount ?? "0",
  };
}

async function getUploadVideoIds(playlistId: string, limit: number) {
  let nextPageToken = "";
  const ids: string[] = [];
  const maxPages = Math.ceil(limit / 50) + 1;
  let pageCount = 0;

  while (ids.length < limit && pageCount < maxPages) {
    pageCount += 1;
    const playlistUrl = new URL(
      "https://www.googleapis.com/youtube/v3/playlistItems"
    );
    playlistUrl.searchParams.set("part", "snippet,contentDetails");
    playlistUrl.searchParams.set("playlistId", playlistId);
    playlistUrl.searchParams.set("maxResults", "50");
    playlistUrl.searchParams.set("key", YOUTUBE_API_KEY!);

    if (nextPageToken) {
      playlistUrl.searchParams.set("pageToken", nextPageToken);
    }

    const data = await safeJsonFetch<YouTubePlaylistItemsResponse>(playlistUrl);
    const items = data.items ?? [];

    ids.push(
      ...items
        .map((item) => item.contentDetails?.videoId)
        .filter(
          (videoId: unknown): videoId is string =>
            typeof videoId === "string" && isValidYouTubeVideoId(videoId)
        )
    );

    nextPageToken =
      typeof data.nextPageToken === "string" && data.nextPageToken.length <= 512
        ? data.nextPageToken
        : "";

    if (!nextPageToken) break;
  }

  return ids.slice(0, limit);
}

async function getVideos(videoIds: string[]) {
  if (videoIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    chunks.push(videoIds.slice(i, i + 50));
  }

  const allVideos: YouTubeVideoItem[] = [];

  for (const chunk of chunks) {
    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
    videosUrl.searchParams.set("id", chunk.join(","));
    videosUrl.searchParams.set("key", YOUTUBE_API_KEY!);

    const data = await safeJsonFetch<YouTubeVideoListResponse>(videosUrl);
    allVideos.push(...(data.items ?? []));
  }

  return allVideos.map((video) => {
    const duration = video.contentDetails?.duration ?? "PT0S";
    const seconds = parseISODurationToSeconds(duration);

    return {
      id: video.id,
      title: video.snippet?.title ?? "",
      publishedAt: video.snippet?.publishedAt ?? "",
      thumbnail:
        video.snippet?.thumbnails?.medium?.url ||
        video.snippet?.thumbnails?.default?.url ||
        "",
      viewCount: video.statistics?.viewCount ?? "0",
      duration,
      durationSeconds: seconds,
      isShort: seconds > 0 && seconds <= 60,
    };
  });
}

export async function GET(request: NextRequest) {
  try {
    const userId = await requireApiUserId();
    if (!userId) return unauthorizedResponse();

    const input = request.nextUrl.searchParams.get("url");
    const parsed = parseYouTubeChannelUrl(input);

    if (!YOUTUBE_API_KEY) {
      return serverConfigurationErrorResponse();
    }

    const channelId =
      parsed.type === "channelId"
        ? parsed.value
        : await getChannelIdFromHandle(`@${parsed.value}`);

    const {
      uploadsPlaylistId,
      channelTitle,
      channelDescription,
      subscriberCount,
      videoCount,
      viewCount,
    } = await getChannelInfo(channelId);

    const uploadVideoIds = await getUploadVideoIds(
      uploadsPlaylistId,
      FETCH_POOL_SIZE
    );
    const allVideos = await getVideos(uploadVideoIds);

    const sortedByDate = [...allVideos].sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );

    const regularVideos = sortedByDate
      .filter((video) => !video.isShort)
      .slice(0, PER_TYPE_LIMIT);

    const shortVideos = sortedByDate
      .filter((video) => video.isShort)
      .slice(0, PER_TYPE_LIMIT);

    return NextResponse.json({
      plan: SERVER_PLAN,
      channelId,
      channelTitle,
      channelDescription,
      subscriberCount,
      videoCount,
      viewCount,
      regularVideos,
      shortVideos,
    });
  } catch (error) {
    return handleApiError("youtube-channel", error);
  }
}
