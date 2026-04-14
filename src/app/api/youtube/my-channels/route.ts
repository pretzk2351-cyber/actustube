import { NextResponse } from "next/server";
import { auth } from "@/auth";

export async function GET() {
  try {
    const session = await auth();

    if (!session || !(session as any).accessToken) {
      return NextResponse.json(
        { error: "ログイン情報がありません" },
        { status: 401 }
      );
    }

    const accessToken = (session as any).accessToken;

    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
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
          error: "YouTubeチャンネル取得に失敗しました",
          detail: data,
        },
        { status: 500 }
      );
    }

    const channels =
      data.items?.map((item: any) => ({
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
    console.error("my-channels route error:", error);

    return NextResponse.json(
      { error: "サーバーエラーが発生しました" },
      { status: 500 }
    );
  }
}