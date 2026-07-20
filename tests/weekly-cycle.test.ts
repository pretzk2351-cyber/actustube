import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  parseAIConsultSnapshot,
  parseImprovementActionCreate,
  parseImprovementActionUpdate,
} from "@/app/lib/weekly-cycle-validation";
import {
  analysisRuns,
  improvementActions,
  improvementActionStatusEnum,
} from "@/db/schema";
import {
  buildFinalizeAIConsultQuery,
  buildFinalizeChannelAnalysisQuery,
  createImprovementActionWithDatabase,
  finalizeAIConsultWithDatabase,
  finalizeChannelAnalysisWithDatabase,
  listWeeklyCyclesWithDatabase,
  updateImprovementActionWithDatabase,
  weeklyCycleIdentityIsValidWithDatabase,
  getPostgresErrorDetails,
  WeeklyCycleActionAlreadyExistsError,
  WeeklyCycleConflictError,
  WeeklyCycleNotFoundError,
  WeeklyCyclePersistenceError,
} from "@/db/weekly-cycle";

const USER_ID = "9e7b7a4c-6fc8-448d-bcb5-4331fa8910a9";
const OTHER_USER_ID = "2f5e100f-f94d-4b36-a3e4-a6f41a722d1d";
const RESERVATION_ID = "a95fa157-5f30-42ca-97ea-d7ba4f23f331";
const ANALYSIS_RUN_ID = "3ecce3e0-2dd5-4b57-9a4a-f26b4c7793b3";
const ACTION_ID = "267c7d5d-d722-4a64-bcf2-13058333109c";

const snapshot = {
  plan: "free",
  channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
  channelTitle: "Test Channel",
  channelDescription: "Description",
  subscriberCount: "100",
  videoCount: "2",
  viewCount: "300",
  regularVideos: [
    {
      id: "aaaaaaaaaaa",
      title: "Regular",
      publishedAt: "2026-07-18T00:00:00.000Z",
      thumbnail: "https://example.test/regular.jpg",
      viewCount: "200",
      isShort: false,
    },
  ],
  shortVideos: [
    {
      id: "bbbbbbbbbbb",
      title: "Short",
      publishedAt: "2026-07-17T00:00:00.000Z",
      thumbnail: "https://example.test/short.jpg",
      viewCount: "100",
      isShort: true,
    },
  ],
};

const consultation = {
  overallDiagnosis: "Diagnosis",
  strongPoints: ["Strength"],
  weakPoints: ["Weakness"],
  currentImprovements: ["Improve the opening"],
  nextSuggestions: ["Test a result-first structure"],
};

function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTION_ID,
    analysisRunId: ANALYSIS_RUN_ID,
    title: "Improve the opening",
    description: "Show the result first",
    status: "planned",
    resultNote: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("weekly cycle validation", () => {
  it("accepts bounded create and terminal update inputs", () => {
    expect(
      parseImprovementActionCreate({
        analysisRunId: ANALYSIS_RUN_ID,
        title: " Improve the opening ",
        description: " Show the result first\nand compare the response ",
      })
    ).toEqual({
      analysisRunId: ANALYSIS_RUN_ID,
      title: "Improve the opening",
      description: "Show the result first\nand compare the response",
    });
    expect(
      parseImprovementActionUpdate({
        status: "completed",
        resultNote: " Retention improved ",
      })
    ).toEqual({ status: "completed", resultNote: "Retention improved" });
  });

  it.each([
    { status: "invalid", resultNote: "x" },
    { status: "completed", resultNote: "" },
    { resultNote: "orphan note" },
    {},
  ])("rejects invalid action updates", (input) => {
    expect(() => parseImprovementActionUpdate(input)).toThrow();
  });

  it("validates the persisted AI consultation shape", () => {
    expect(parseAIConsultSnapshot(consultation)).toEqual(consultation);
    expect(() => parseAIConsultSnapshot({ ...consultation, strongPoints: "x" })).toThrow();
  });
});

describe("atomic analysis and AI persistence", () => {
  it("builds server-owned atomic finalization queries", () => {
    const analysisQuery = new PgDialect().sqlToQuery(
      buildFinalizeChannelAnalysisQuery({
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        snapshot,
        analyzedAt: new Date("2026-07-19T00:00:00.000Z"),
      })
    );
    const aiQuery = new PgDialect().sqlToQuery(
      buildFinalizeAIConsultQuery({
        reservationId: RESERVATION_ID,
        userId: USER_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        aiConsult: consultation,
        createdAt: new Date("2026-07-19T01:00:00.000Z"),
      })
    );

    expect(analysisQuery.sql).toContain("finalize_channel_analysis_reservation");
    expect(analysisQuery.params).toContain(RESERVATION_ID);
    expect(analysisQuery.params).toContain(USER_ID);
    expect(analysisQuery.params).toContain(200);
    expect(analysisQuery.params).toContain(100);
    expect(aiQuery.sql).toContain("finalize_ai_consult_reservation");
    expect(aiQuery.params).toContain(ANALYSIS_RUN_ID);
    expect(JSON.stringify({ analysisQuery, aiQuery })).not.toMatch(
      /access_token|refresh_token|api[_-]?key/i
    );
  });

  it("returns only valid atomic finalization results", async () => {
    await expect(
      finalizeChannelAnalysisWithDatabase(
        { execute: vi.fn(async () => ({ rows: [{ analysisRunId: ANALYSIS_RUN_ID }] })) } as never,
        { reservationId: RESERVATION_ID, userId: USER_ID, snapshot }
      )
    ).resolves.toBe(ANALYSIS_RUN_ID);
    await expect(
      finalizeAIConsultWithDatabase(
        { execute: vi.fn(async () => ({ rows: [{ finalized: true }] })) } as never,
        {
          reservationId: RESERVATION_ID,
          userId: USER_ID,
          analysisRunId: ANALYSIS_RUN_ID,
          aiConsult: consultation,
        }
      )
    ).resolves.toBe(true);
    await expect(
      finalizeAIConsultWithDatabase(
        { execute: vi.fn(async () => ({ rows: [{ finalized: false }] })) } as never,
        {
          reservationId: RESERVATION_ID,
          userId: USER_ID,
          analysisRunId: ANALYSIS_RUN_ID,
          aiConsult: consultation,
        }
      )
    ).rejects.toBeInstanceOf(WeeklyCyclePersistenceError);
  });
});

describe("history ownership and improvement actions", () => {
  it("checks active status and session version using the internal user ID", async () => {
    const execute = vi.fn(async () => ({ rows: [{ valid: true }] }));
    await expect(
      weeklyCycleIdentityIsValidWithDatabase({ execute } as never, {
        userId: USER_ID,
        sessionVersion: 7,
      })
    ).resolves.toBe(true);

    const built = new PgDialect().sqlToQuery(
      (execute.mock.calls as unknown[][])[0][0] as import("drizzle-orm").SQL
    );
    expect(built.params).toEqual([USER_ID, 7]);
    expect(built.sql).toContain("app_user.status = 'active'");
    expect(built.sql).toContain("app_user.session_version");
  });

  it("scopes history queries to the internal user and limits the page", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: ANALYSIS_RUN_ID,
            channelId: snapshot.channelId,
            channelTitle: snapshot.channelTitle,
            analyzedAt: "2026-07-19T00:00:00.000Z",
            regularVideoCount: 1,
            shortVideoCount: 1,
            regularAverageViews: "200",
            shortAverageViews: "100",
            hasAIConsult: true,
            aiConsultCreatedAt: "2026-07-19T01:00:00.000Z",
            actionId: ACTION_ID,
            actionAnalysisRunId: ANALYSIS_RUN_ID,
            actionTitle: "Improve the opening",
            actionDescription: "Show the result first",
            actionStatus: "completed",
            actionResultNote: "Retention improved",
            actionCreatedAt: "2026-07-19T00:00:00.000Z",
            actionUpdatedAt: "2026-07-20T00:00:00.000Z",
            actionCompletedAt: "2026-07-20T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await listWeeklyCyclesWithDatabase({ execute } as never, {
      userId: USER_ID,
      limit: 10,
    });
    const built = new PgDialect().sqlToQuery(
      (execute.mock.calls as unknown[][])[0][0] as import("drizzle-orm").SQL
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: ANALYSIS_RUN_ID,
      regularAverageViews: 200,
      shortAverageViews: 100,
      action: expect.objectContaining({
        id: ACTION_ID,
        status: "completed",
        resultNote: "Retention improved",
      }),
    });
    expect(built.params).toContain(USER_ID);
    expect(built.params).toContain(11);
    expect(built.params).not.toContain(OTHER_USER_ID);
    expect(built.sql).toContain("run.user_id");
  });

  it("rejects a missing or other-user analysis when creating an action", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));

    await expect(
      createImprovementActionWithDatabase({ execute } as never, {
        userId: USER_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Improve the opening",
        description: "",
      })
    ).rejects.toBeInstanceOf(WeeklyCycleNotFoundError);

    const built = new PgDialect().sqlToQuery(
      (execute.mock.calls as unknown[][])[0][0] as import("drizzle-orm").SQL
    );
    expect(built.params).toContain(USER_ID);
    expect(built.params).toContain(ANALYSIS_RUN_ID);
    expect(built.sql).toContain("run.user_id");
  });

  it("maps a wrapped analysis-action unique constraint to its safe conflict", async () => {
    const databaseError = new Error("wrapped query failure", {
      cause: Object.assign(new Error("private DB detail"), {
        code: "23505",
        constraint: "improvement_actions_analysis_run_unique",
      }),
    });
    const execute = vi.fn(async () => {
      throw databaseError;
    });

    await expect(
      createImprovementActionWithDatabase({ execute } as never, {
        userId: USER_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Second action",
        description: "",
      })
    ).rejects.toBeInstanceOf(WeeklyCycleActionAlreadyExistsError);
  });

  it("preserves the planned-action conflict mapping", async () => {
    const databaseError = Object.assign(new Error("private DB detail"), {
      code: "23505",
      constraint: "improvement_actions_one_planned_per_user",
    });
    const execute = vi.fn(async () => {
      throw databaseError;
    });

    await expect(
      createImprovementActionWithDatabase({ execute } as never, {
        userId: USER_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Second planned action",
        description: "",
      })
    ).rejects.toBeInstanceOf(WeeklyCycleConflictError);
  });

  it("does not misclassify another unique constraint", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("private DB detail"), {
        code: "23505",
        constraint: "another_unique_constraint",
      });
    });

    await expect(
      createImprovementActionWithDatabase({ execute } as never, {
        userId: USER_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        title: "Action",
        description: "",
      })
    ).rejects.toBeInstanceOf(WeeklyCyclePersistenceError);
  });

  it("bounds wrapped error traversal and avoids cause cycles", () => {
    const inner = Object.assign(new Error("private DB detail"), {
      code: "23505",
      constraint: "improvement_actions_analysis_run_unique",
    });
    const outer = new Error("query failed", { cause: inner });
    expect(getPostgresErrorDetails(outer)).toEqual({
      code: "23505",
      constraint: "improvement_actions_analysis_run_unique",
    });

    const cyclic = new Error("cycle") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(getPostgresErrorDetails(cyclic)).toEqual({
      code: null,
      constraint: null,
    });
  });

  it("stores completed status and the result note for an owned planned action", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ title: "Improve the opening", description: "Show result first", status: "planned" }],
      })
      .mockResolvedValueOnce({
        rows: [
          actionRow({
            status: "completed",
            resultNote: "Retention improved",
            completedAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
          }),
        ],
      });

    const result = await updateImprovementActionWithDatabase({ execute } as never, {
      userId: USER_ID,
      actionId: ACTION_ID,
      status: "completed",
      resultNote: "Retention improved",
    });
    const updateQuery = new PgDialect().sqlToQuery(
      execute.mock.calls[1][0] as unknown as import("drizzle-orm").SQL
    );

    expect(result).toMatchObject({
      status: "completed",
      resultNote: "Retention improved",
      completedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(updateQuery.params).toContain(USER_ID);
    expect(updateQuery.params).toContain(ACTION_ID);
    expect(updateQuery.params).toContain("Retention improved");
  });
});

describe("weekly cycle migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0005_silky_mystique.sql"),
    "utf8"
  );

  it("adds the minimum tables, ownership constraint, and planned uniqueness", () => {
    expect(improvementActionStatusEnum.enumValues).toEqual([
      "planned",
      "completed",
      "skipped",
    ]);
    expect(getTableConfig(analysisRuns).name).toBe("analysis_runs");
    expect(getTableConfig(improvementActions).name).toBe("improvement_actions");
    expect(migration).toContain("improvement_actions_owned_analysis_fk");
    expect(migration).toContain("improvement_actions_analysis_run_unique");
    expect(migration).toContain("improvement_actions_one_planned_per_user");
    expect(migration).toContain("WHERE \"improvement_actions\".\"status\" = 'planned'");
  });

  it("atomically consumes leases only when history or AI persistence succeeds", () => {
    expect(migration).toContain("finalize_channel_analysis_reservation");
    expect(migration).toContain("finalize_ai_consult_reservation");
    expect(migration.match(/DELETE FROM public\.usage_reservation_leases/g)).toHaveLength(2);
    expect(migration).toContain("INSERT INTO public.analysis_runs");
    expect(migration).toContain("UPDATE public.analysis_runs AS run");
    expect(migration.match(/SECURITY INVOKER/g)).toHaveLength(2);
    expect(migration.match(/SET search_path = public, pg_temp/g)).toHaveLength(2);
    expect(migration.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(2);
    expect(migration).not.toMatch(/access_token|refresh_token|api[_-]?key/i);
  });
});
