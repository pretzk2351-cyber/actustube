import assert from "node:assert/strict";

import { neon } from "@neondatabase/serverless";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  console.log("Usage-limit integration test skipped: TEST_DATABASE_URL is not set.");
  process.exit(0);
}

const database = neon(testDatabaseUrl);
const createdUserIds = [];

async function createUser({
  status = "active",
  sessionVersion = 1,
  withPlan = true,
} = {}) {
  const rows = await database`
    INSERT INTO public.users (status, session_version)
    VALUES (${status}, ${sessionVersion})
    RETURNING id
  `;
  const userId = rows[0].id;
  createdUserIds.push(userId);

  if (withPlan) {
    await database`
      INSERT INTO public.user_plan_assignments (
        user_id,
        plan_code,
        status,
        source,
        starts_at
      )
      VALUES (
        ${userId}::uuid,
        'free',
        'active',
        'system',
        '2020-01-01T00:00:00Z'
      )
    `;
  }

  return userId;
}

async function reserve(userId, metric, now, sessionVersion = 1) {
  const rows = await database`
    SELECT *
    FROM public.reserve_usage_limits(
      ${userId}::uuid,
      ${sessionVersion}::integer,
      ${metric}::public.usage_metric,
      ${now}::timestamp with time zone
    )
  `;
  return rows[0];
}

async function bucketCounts(userId, metric) {
  return database`
    SELECT
      period_kind AS "periodKind",
      used_count AS "usedCount",
      limit_snapshot AS "limitSnapshot"
    FROM public.user_usage_buckets
    WHERE user_id = ${userId}::uuid
      AND metric = ${metric}::public.usage_metric
    ORDER BY period_kind
  `;
}

async function run() {
  const concurrentUser = await createUser();
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, () =>
      reserve(
        concurrentUser,
        "channel_analysis",
        "2026-07-18T12:00:00.000Z"
      )
    )
  );
  assert.equal(concurrent.filter((result) => result.allowed).length, 2);
  assert.deepEqual(await bucketCounts(concurrentUser, "channel_analysis"), [
    { periodKind: "day", usedCount: 2, limitSnapshot: 2 },
    { periodKind: "month", usedCount: 2, limitSnapshot: 5 },
  ]);

  const independentUser = await createUser();
  const independent = await Promise.all([
    reserve(
      independentUser,
      "channel_analysis",
      "2026-07-18T12:00:00.000Z"
    ),
    reserve(independentUser, "ai_consult", "2026-07-18T12:00:00.000Z"),
  ]);
  assert.equal(independent[0].allowed, true);
  assert.equal(independent[0].daily_limit, 2);
  assert.equal(independent[0].monthly_limit, 5);
  assert.equal(independent[1].allowed, true);
  assert.equal(independent[1].daily_limit, 1);
  assert.equal(independent[1].monthly_limit, 3);

  const monthlyUser = await createUser();
  for (let day = 1; day <= 5; day += 1) {
    const result = await reserve(
      monthlyUser,
      "channel_analysis",
      `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`
    );
    assert.equal(result.allowed, true);
  }
  const monthlyDenied = await reserve(
    monthlyUser,
    "channel_analysis",
    "2026-08-06T12:00:00.000Z"
  );
  assert.equal(monthlyDenied.denial_reason, "monthly_limit_reached");

  const versionedUser = await createUser({ sessionVersion: 2 });
  assert.equal(
    (
      await reserve(
        versionedUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z",
        1
      )
    ).denial_reason,
    "session_version_mismatch"
  );

  const inactiveUser = await createUser({ status: "suspended" });
  assert.equal(
    (
      await reserve(
        inactiveUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z"
      )
    ).denial_reason,
    "user_inactive"
  );
  await database`
    UPDATE public.users
    SET status = 'deleted'
    WHERE id = ${inactiveUser}::uuid
  `;
  assert.equal(
    (
      await reserve(
        inactiveUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z"
      )
    ).denial_reason,
    "user_inactive"
  );

  const planlessUser = await createUser({ withPlan: false });
  assert.equal(
    (
      await reserve(
        planlessUser,
        "channel_analysis",
        "2026-09-01T12:00:00.000Z"
      )
    ).denial_reason,
    "no_active_plan"
  );

  console.log({
    concurrentAllowed: 2,
    channelAnalysisLimits: { daily: 2, monthly: 5 },
    aiConsultLimits: { daily: 1, monthly: 3 },
    stateDenialsVerified: true,
  });
}

try {
  await run();
} catch (error) {
  console.error({
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
} finally {
  for (const userId of createdUserIds) {
    try {
      await database`
        DELETE FROM public.users
        WHERE id = ${userId}::uuid
      `;
    } catch {
      process.exitCode = 1;
    }
  }
}
