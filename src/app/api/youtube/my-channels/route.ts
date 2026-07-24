import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  ExternalServiceError,
  getServerOAuthAccessToken,
  handleApiError,
  requireApiUserId,
  unauthorizedResponse,
  youtubeAuthorizationRequiredResponse,
} from "@/app/lib/api-security";
import { fetchOwnedYouTubeChannels } from "@/app/lib/youtube-owned-channels";

export const GET = auth(async function GET(request) {
  try {
    const userId = await requireApiUserId(request.auth);
    if (!userId) return unauthorizedResponse();

    const accessToken = await getServerOAuthAccessToken(request, userId);
    if (!accessToken) return youtubeAuthorizationRequiredResponse();

    const channels = await fetchOwnedYouTubeChannels(accessToken);

    return NextResponse.json({ channels });
  } catch (error) {
    if (error instanceof ExternalServiceError && error.isAuthorizationError) {
      return youtubeAuthorizationRequiredResponse();
    }

    return handleApiError("youtube-my-channels", error);
  }
});
