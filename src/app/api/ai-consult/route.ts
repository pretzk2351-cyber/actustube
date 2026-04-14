import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const consultSchema = {
  name: "youtube_consult_result",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      overallDiagnosis: {
        type: "string",
      },
      strongPoints: {
        type: "array",
        items: { type: "string" },
      },
      weakPoints: {
        type: "array",
        items: { type: "string" },
      },
      currentImprovements: {
        type: "array",
        items: { type: "string" },
      },
      nextSuggestions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [
      "overallDiagnosis",
      "strongPoints",
      "weakPoints",
      "currentImprovements",
      "nextSuggestions",
    ],
  },
  strict: true,
} as const;

export async function POST(request: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY が設定されていません" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { aiSummary } = body;

    if (!aiSummary) {
      return NextResponse.json(
        { error: "aiSummary が渡されていません" },
        { status: 400 }
      );
    }

    const systemPrompt = `
あなたは、YouTube運用の実務コンサルタントです。
目的は、投稿主が今日から具体的に動ける改善提案を出すことです。

必ず守ること:
- 抽象的な言い方を避ける
- 具体的に何をすればいいかを書く
- できるだけ動画タイトルを使う
- 中学生でも理解できる言葉にする
- 一般論ではなく、このチャンネル専用の助言にする
- nextSuggestions は次回以降の動画作成内容・構成・作り方が分かるようにする
- currentImprovements は現時点ですぐ直せる改善点にする
`;

    const userPrompt = `
以下は無料版MVPの分析データです。
通常動画10本とショート10本を前提に、無料版として価値のあるコンサル出力を作ってください。

分析データ:
${JSON.stringify(aiSummary, null, 2)}
`;

    const response = await client.responses.create({
      model: "gpt-5.4-mini",
      store: false,
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: consultSchema.name,
          schema: consultSchema.schema,
          strict: true,
        },
      },
    });

    const outputText = response.output_text;

    if (!outputText) {
      return NextResponse.json(
        { error: "AIからの応答が空でした" },
        { status: 500 }
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      return NextResponse.json(
        {
          error: "AIの出力をJSONとして解析できませんでした",
          raw: outputText,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "不明なエラー",
      },
      { status: 500 }
    );
  }
}