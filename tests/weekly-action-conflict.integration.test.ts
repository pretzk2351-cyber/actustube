import { randomUUID } from "node:crypto";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImprovementActionWithDatabase,
  WeeklyCycleActionAlreadyExistsError,
  WeeklyCycleConflictError,
} from "@/db/weekly-cycle";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;
const createdUserIds: string[] = [];

function createDatabase() {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required.");
  return drizzle(neon(testDatabaseUrl));
}

async function seedAnalysis(
  database: ReturnType<typeof createDatabase>,
  status?: "planned" | "completed" | "skipped"
) {
  const userId = randomUUID();
  const analysisRunId = randomUUID();
  createdUserIds.push(userId);

  await database.execute(sql`
    INSERT INTO public.users (id, name)
    VALUES (${userId}::uuid, 'Weekly duplicate integration test')
  `);
  await database.execute(sql`
    INSERT INTO public.analysis_runs (
      id,
      user_id,
      channel_id,
      channel_title,
      analysis_snapshot,
      regular_video_count,
      short_video_count,
      regular_average_views,
      short_average_views
    )
    VALUES (
      ${analysisRunId}::uuid,
      ${userId}::uuid,
      'UCaaaaaaaaaaaaaaaaaaaaaa',
      'Integration Test Channel',
      '{}'::jsonb,
      0,
      0,
      0,
      0
    )
  `);

  if (status) {
    await database.execute(sql`
      INSERT INTO public.improvement_actions (
        user_id,
        analysis_run_id,
        title,
        description,
        status,
        result_note,
        completed_at
      )
      VALUES (
        ${userId}::uuid,
        ${analysisRunId}::uuid,
        'Existing action',
        'Existing action description',
        ${status}::public.improvement_action_status,
        ${status === "planned" ? null : "Persisted result note"},
        ${status === "completed" ? new Date().toISOString() : null}::timestamp with time zone
      )
    `);
  }

  return { userId, analysisRunId };
}

describeWithPostgres("weekly action conflicts with real PostgreSQL", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    const database = createDatabase();
    while (createdUserIds.length > 0) {
      const userId = createdUserIds.pop();
      if (userId) {
        await database.execute(
          sql`DELETE FROM public.users WHERE id = ${userId}::uuid`
        );
      }
    }
  });

  it.each(["planned", "completed", "skipped"] as const)(
    "maps a duplicate action after %s to the dedicated conflict and preserves the row",
    async (status) => {
      const database = createDatabase();
      const { userId, analysisRunId } = await seedAnalysis(database, status);

      await expect(
        createImprovementActionWithDatabase(database as never, {
          userId,
          analysisRunId,
          title: "Duplicate action",
          description: "Must not be inserted",
        })
      ).rejects.toBeInstanceOf(WeeklyCycleActionAlreadyExistsError);

      const result = await database.execute(sql`
        SELECT status, result_note AS "resultNote"
        FROM public.improvement_actions
        WHERE analysis_run_id = ${analysisRunId}::uuid
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        status,
        resultNote: status === "planned" ? null : "Persisted result note",
      });
    }
  );

  it("preserves the one-planned-action-per-user conflict", async () => {
    const database = createDatabase();
    const { userId } = await seedAnalysis(database, "planned");
    const secondAnalysisRunId = randomUUID();
    await database.execute(sql`
      INSERT INTO public.analysis_runs (
        id, user_id, channel_id, channel_title, analysis_snapshot,
        regular_video_count, short_video_count,
        regular_average_views, short_average_views
      )
      VALUES (
        ${secondAnalysisRunId}::uuid,
        ${userId}::uuid,
        'UCbbbbbbbbbbbbbbbbbbbbbb',
        'Second Integration Test Channel',
        '{}'::jsonb,
        0, 0, 0, 0
      )
    `);

    await expect(
      createImprovementActionWithDatabase(database as never, {
        userId,
        analysisRunId: secondAnalysisRunId,
        title: "Second planned action",
        description: "Must not be inserted",
      })
    ).rejects.toBeInstanceOf(WeeklyCycleConflictError);
  });
});
