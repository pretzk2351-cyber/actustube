import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  ExternalServiceError,
  fetchJsonWithTimeout,
  getServerOAuthAccessToken,
  handleApiError,
  requireApiUserId,
  unauthorizedResponse,
  youtubeAuthorizationRequiredResponse,
} from "@/app/lib/api-security";

type YouTubeChannelListResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      thumbnails?: {
        default?: { url?: string };
        medium?: { url?: string };
      };
    };
  }>;
};

export const GET = auth(async function GET(request) {
  try {
    const userId = await requireApiUserId(request.auth);
    if (!userId) return unauthorizedResponse();

    const accessToken = await getServerOAuthAccessToken(request, userId);
    if (!accessToken) return youtubeAuthorizationRequiredResponse();

    const data = await fetchJsonWithTimeout<YouTubeChannelListResponse>(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      }
    );

    const channels =
      data.items?.map((item) => ({
        id: item.id ?? "",
        title: item.snippet?.title ?? "",
        description: item.snippet?.description ?? "",
        thumbnail:
          item.snippet?.thumbnails?.default?.url ??
          item.snippet?.thumbnails?.medium?.url ??
          "",
      })) ?? [];

    return NextResponse.json({ channels });
  } catch (error) {
    if (error instanceof ExternalServiceError && error.isAuthorizationError) {
      return youtubeAuthorizationRequiredResponse();
    }

    return handleApiError("youtube-my-channels", error);
  }
});
