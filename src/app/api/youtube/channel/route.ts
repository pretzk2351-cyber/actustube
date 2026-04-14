import { NextRequest, NextResponse } from "next/server";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

type ChannelIdentifier =
  | { type: "channelId"; value: string }
  | { type: "handle"; value: string };

function extractChannelIdentifier(input: string): ChannelIdentifier | null {
  try {
    const url = new URL(input);

    if (
      !url.hostname.includes("youtube.com") &&
      !url.hostname.includes("youtu.be")
    ) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "channel" && parts[1]) {
      return { type: "channelId", value: parts[1] };
    }

    if (parts[0] && parts[0].startsWith("@")) {
      return { type: "handle", value: parts[0] };
    }

    return null;
  } catch {
    return null;
  }
}

function parseISODurationToSeconds(duration: string) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);

  if (!match) return 0;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  return hours * 3600 + minutes * 60 + seconds;
}

async function safeJsonFetch(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("YouTube API がJSONを返しませんでした");
  }

  if (!res.ok) {
    throw new Error(data?.error?.message || "YouTube API エラー");
  }

  return data;
}

async function getChannelIdFromHandle(handle: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("forHandle", handle.replace("@", ""));
  url.searchParams.set("key", YOUTUBE_API_KEY!);

  const data = await safeJsonFetch(url.toString());
  const item = data.items?.[0];

  if (!item?.id) {
    throw new Error("ハンドルからチャンネルを特定できませんでした");
  }

  return item.id as string;
}

async function getChannelInfo(channelId: string) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails,snippet,statistics");
  url.searchParams.set("id", channelId);
  url.searchParams.set("key", YOUTUBE_API_KEY!);

  const data = await safeJsonFetch(url.toString());
  const item = data.items?.[0];

  if (!item) {
    throw new Error("チャンネルが見つかりませんでした");
  }

  return {
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? "",
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

  while (ids.length < limit) {
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

    const data = await safeJsonFetch(playlistUrl.toString());
    const items = data.items ?? [];

    ids.push(
      ...items
        .map((item: any) => item.contentDetails?.videoId)
        .filter(Boolean)
    );

    nextPageToken = data.nextPageToken ?? "";

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

  const allVideos: any[] = [];

  for (const chunk of chunks) {
    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
    videosUrl.searchParams.set("id", chunk.join(","));
    videosUrl.searchParams.set("key", YOUTUBE_API_KEY!);

    const data = await safeJsonFetch(videosUrl.toString());
    allVideos.push(...(data.items ?? []));
  }

  return allVideos.map((video: any) => {
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
    if (!YOUTUBE_API_KEY) {
      return NextResponse.json(
        { error: "YOUTUBE_API_KEY が設定されていません" },
        { status: 500 }
      );
    }

    const input = request.nextUrl.searchParams.get("url");
    const plan = request.nextUrl.searchParams.get("plan") ?? "free";

    if (!input) {
      return NextResponse.json(
        { error: "チャンネルURLを指定してください" },
        { status: 400 }
      );
    }

    const parsed = extractChannelIdentifier(input);

    if (!parsed) {
      return NextResponse.json(
        {
          error:
            "対応している形式は https://www.youtube.com/@handle または /channel/xxxx です",
        },
        { status: 400 }
      );
    }

    const perTypeLimit = plan === "standard" ? 50 : 10;
    const fetchPoolSize = plan === "standard" ? 120 : 50;

    const channelId =
      parsed.type === "channelId"
        ? parsed.value
        : await getChannelIdFromHandle(parsed.value);

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
      fetchPoolSize
    );
    const allVideos = await getVideos(uploadVideoIds);

    const sortedByDate = [...allVideos].sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );

    const regularVideos = sortedByDate
      .filter((video) => !video.isShort)
      .slice(0, perTypeLimit);

    const shortVideos = sortedByDate
      .filter((video) => video.isShort)
      .slice(0, perTypeLimit);

    return NextResponse.json({
      plan,
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
    const message =
      error instanceof Error ? error.message : "不明なエラーが発生しました";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}