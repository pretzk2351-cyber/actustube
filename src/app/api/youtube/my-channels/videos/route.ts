import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get("channelId");

    if (!channelId) {
      return NextResponse.json(
        { error: "channelIdがありません" },
        { status: 400 }
      );
    }

    const session = await auth();

    if (!session || !(session as any).accessToken) {
      return NextResponse.json(
        { error: "ログインが必要です" },
        { status: 401 }
      );
    }

    const accessToken = (session as any).accessToken;

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=10&order=date&type=video`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        {
          error: "動画取得に失敗しました",
          detail: data,
        },
        { status: 500 }
      );
    }

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
    console.error("videos route error:", error);

    return NextResponse.json(
      { error: "サーバーエラーが発生しました" },
      { status: 500 }
    );
  }
}