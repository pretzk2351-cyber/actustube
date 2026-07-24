import "server-only";

import { isValidYouTubeChannelId } from "./api-validation";
import { ExternalServiceError, fetchJsonWithTimeout } from "./api-security";

export type OwnedYouTubeChannel = {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
};

type YouTubeChannelListResponse = {
  items?: Array<{
    id?: unknown;
    snippet?: {
      title?: unknown;
      description?: unknown;
      thumbnails?: {
        default?: { url?: unknown };
        medium?: { url?: unknown };
      };
    };
  }>;
};

function optionalBoundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length <= maxLength ? value : "";
}

export async function fetchOwnedYouTubeChannels(
  accessToken: string
): Promise<OwnedYouTubeChannel[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  url.searchParams.set("maxResults", "50");

  const data = await fetchJsonWithTimeout<YouTubeChannelListResponse>(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (data.items !== undefined && !Array.isArray(data.items)) {
    throw new ExternalServiceError();
  }

  return (data.items ?? []).map((item) => {
    if (typeof item.id !== "string" || !isValidYouTubeChannelId(item.id)) {
      throw new ExternalServiceError();
    }

    return {
      id: item.id,
      title: optionalBoundedString(item.snippet?.title, 200),
      description: optionalBoundedString(item.snippet?.description, 5_000),
      thumbnail:
        optionalBoundedString(item.snippet?.thumbnails?.default?.url, 2_048) ||
        optionalBoundedString(item.snippet?.thumbnails?.medium?.url, 2_048),
    };
  });
}
