import { NextRequest, NextResponse } from "next/server";

import {
  isValidYouTubeVideoId,
  parseYouTubeChannelId,
} from "@/app/lib/api-validation";
import {
  ExternalServiceError,
  fetchJsonWithTimeout,
  getServerOAuthAccessToken,
  getServerUsageIdentity,
  handleApiError,
  requireApiUserId,
  serverConfigurationErrorResponse,
  unauthorizedResponse,
  youtubeAuthorizationRequiredResponse,
} from "@/app/lib/api-security";
import {
  publicUsage,
  assertApiUsageCompatibility,
  preflightApiUsageForIdentity,
  prepareApiUsage,
  reauthenticationRequiredResponse,
  reserveApiUsageForIdentity,
  runWithUsageReservation,
} from "@/app/lib/usage-limit-api";
import type { ChannelAnalysisSnapshot } from "@/app/lib/weekly-cycle-types";
import { fetchOwnedYouTubeChannels } from "@/app/lib/youtube-owned-channels";
import { finalizeChannelAnalysis } from "@/db/weekly-cycle";

const FETCH_POOL_SIZE = 50;
const NO_ANALYZABLE_VIDEOS_CODE = "NO_ANALYZABLE_VIDEOS";

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

async function getChannelInfo(channelId: string, apiKey: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails,snippet,statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", apiKey);

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

async function getUploadVideoIds(
  playlistId: string,
  limit: number,
  apiKey: string
) {
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
    playlistUrl.searchParams.set("key", apiKey);

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

async function getVideos(videoIds: string[], apiKey: string) {
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
    videosUrl.searchParams.set("key", apiKey);

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

    const identity = await getServerUsageIdentity(request, userId);
    if (!identity) return reauthenticationRequiredResponse();

    const channelId = parseYouTubeChannelId(
      request.nextUrl.searchParams.get("channelId")
    );

    const usageCompatibility = await assertApiUsageCompatibility();
    const usagePreparation = await prepareApiUsage(usageCompatibility);
    const usagePreflight = await preflightApiUsageForIdentity(
      identity,
      "channel_analysis"
    );
    if (!usagePreflight.allowed) return usagePreflight.response;

    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    if (!youtubeApiKey) {
      return serverConfigurationErrorResponse();
    }

    const accessToken = await getServerOAuthAccessToken(request, userId);
    if (!accessToken) return youtubeAuthorizationRequiredResponse();

    const ownedChannels = await fetchOwnedYouTubeChannels(accessToken);
    if (!ownedChannels.some((channel) => channel.id === channelId)) {
      return NextResponse.json(
        {
          error: "The selected YouTube channel is not available.",
          code: "YOUTUBE_CHANNEL_NOT_OWNED",
        },
        { status: 403 }
      );
    }

    const usageResult = await reserveApiUsageForIdentity(
      identity,
      "channel_analysis",
      usagePreparation
    );
    if (!usageResult.allowed) return usageResult.response;

    let analysisRunId: string | null = null;
    const result = await runWithUsageReservation(
      usageResult.reservation,
      userId,
      async () => {
        const {
          uploadsPlaylistId,
          channelTitle,
          channelDescription,
          subscriberCount,
          videoCount,
          viewCount,
        } = await getChannelInfo(channelId, youtubeApiKey);

        const uploadVideoIds = await getUploadVideoIds(
          uploadsPlaylistId,
          FETCH_POOL_SIZE,
          youtubeApiKey
        );
        const allVideos = await getVideos(uploadVideoIds, youtubeApiKey);

        const sortedByDate = [...allVideos].sort(
          (a, b) =>
            new Date(b.publishedAt).getTime() -
            new Date(a.publishedAt).getTime()
        );

        const regularVideos = sortedByDate
          .filter((video) => !video.isShort)
          .slice(0, usageResult.reservation.regularVideoLimit);

        const shortVideos = sortedByDate
          .filter((video) => video.isShort)
          .slice(0, usageResult.reservation.shortsVideoLimit);

        return {
          plan: usageResult.reservation.canonicalPlanKey,
          channelId,
          channelTitle,
          channelDescription,
          subscriberCount,
          videoCount,
          viewCount,
          regularVideos,
          shortVideos,
        } satisfies ChannelAnalysisSnapshot;
      },
      {
        releaseWhen: (snapshot) =>
          snapshot.regularVideos.length === 0 && snapshot.shortVideos.length === 0,
        finalize: async (snapshot) => {
          analysisRunId = await finalizeChannelAnalysis({
            reservationId: usageResult.reservation.reservationId,
            userId,
            snapshot,
          });
          return true;
        },
      }
    );

    if (result.regularVideos.length === 0 && result.shortVideos.length === 0) {
      return NextResponse.json({
        code: NO_ANALYZABLE_VIDEOS_CODE,
        channelId: result.channelId,
        channelTitle: result.channelTitle,
        regularVideos: [],
        shortVideos: [],
      });
    }

    if (!analysisRunId) {
      throw new Error("AnalysisHistoryFinalizationFailed");
    }

    return NextResponse.json({
      ...result,
      analysisRunId,
      usage: publicUsage(usageResult.reservation),
    });
  } catch (error) {
    if (error instanceof ExternalServiceError && error.isAuthorizationError) {
      return youtubeAuthorizationRequiredResponse();
    }

    return handleApiError("youtube-channel", error);
  }
}
