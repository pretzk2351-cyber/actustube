import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "This endpoint is no longer available.",
      code: "ENDPOINT_GONE",
    },
    { status: 410 }
  );
}
