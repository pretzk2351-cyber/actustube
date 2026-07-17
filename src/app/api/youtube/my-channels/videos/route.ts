import { NextResponse } from "next/server";

import { parseYouTubeChannelId } from "@/app/lib/api-validation";
import {
  ExternalServiceError,
  fetchJsonWithTimeout,
  getServerOAuthAccessToken,
  handleApiError,
  requireApiUserId,
  unauthorizedResponse,
  youtubeAuthorizationRequiredResponse,
} from "@/app/lib/api-security";

export async function GET(req: Request) {
  try {
    const userId = await requireApiUserId();
    if (!userId) return unauthorizedResponse();

    const { searchParams } = new URL(req.url);
    const channelId = parseYouTubeChannelId(searchParams.get("channelId"));
    const accessToken = await getServerOAuthAccessToken(req);
    if (!accessToken) return youtubeAuthorizationRequiredResponse();

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("channelId", channelId);
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("order", "date");
    url.searchParams.set("type", "video");

    const data = await fetchJsonWithTimeout<any>(
      url,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      }
    );

    const videos =
      data.items?.map((item: any) => ({
        videoId: item.id?.videoId ?? "",
        title: item.snippet?.title ?? "",
        thumbnail:
          item.snippet?.thumbnails?.medium?.url ??
          item.snippet?.thumbnails?.default?.url ??
          "",
        publishedAt: item.snippet?.publishedAt ?? "",
      })) ?? [];

    return NextResponse.json({ videos });
  } catch (error) {
    if (error instanceof ExternalServiceError && error.isAuthorizationError) {
      return youtubeAuthorizationRequiredResponse();
    }

    return handleApiError("youtube-my-channel-videos", error);
  }
}
