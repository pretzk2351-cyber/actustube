import { NextResponse } from "next/server";
import { auth } from "@/auth";

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

function parseDuration(d: string) {
  const m = d.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  return (Number(m?.[1] || 0) * 60) + Number(m?.[2] || 0);
}

function extractHandle(url: string) {
  const match = url.match(/@([A-Za-z0-9._-]+)/);
  return match ? match[1] : null;
}

async function getChannelId(handle: string, key: string) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${key}`
  );
  const data = await res.json();
  return data.items?.[0]?.id;
}

async function getVideos(channelId: string, key: string) {
  const list = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=50&order=date&type=video&key=${key}`
  ).then((r) => r.json());

  const ids = list.items.map((i: any) => i.id.videoId).join(",");

  const detail = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids}&key=${key}`
  ).then((r) => r.json());

  return detail.items.map((v: any) => ({
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

async function analyze(prompt: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const key = process.env.YOUTUBE_API_KEY!;

    let channelId = "";

    // ===== URLモード =====
    if (body.mode === "manual_url") {
      const handle = extractHandle(body.url);
      if (!handle) throw new Error("URL形式が不正");
      channelId = await getChannelId(handle, key);
    }

    // ===== ログインモード =====
    if (body.mode === "my_channel") {
      const session = await auth();
      if (!session) throw new Error("ログイン必要");
      channelId = body.channelId;
    }

    if (!channelId) throw new Error("チャンネル取得失敗");

    const videos = await getVideos(channelId, key);
    const { normal, shorts } = split(videos);

    const nScore = score(normal);
    const sScore = score(shorts);

    const report = await analyze(buildPrompt(nScore, sScore));

    return NextResponse.json({
      normal,
      shorts,
      nScore,
      sScore,
      priority: buildPriority(nScore, sScore),
      report,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message });
  }
}