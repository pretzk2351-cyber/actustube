import { Client, Pool } from "@neondatabase/serverless";

const POOL_CLOSE_TIMEOUT_MILLISECONDS = 5_000;

export function getNeonDriverEffectiveAuthority(connectionString) {
  const client = new Client({ connectionString });
  return Object.freeze({
    host: String(client.host).toLowerCase(),
    port: Number(client.port),
    database: String(client.database),
    user: String(client.user),
  });
}

async function endPoolWithinDeadline(pool) {
  let timer;
  try {
    await Promise.race([
      pool.end(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("POOL_CLOSE_TIMEOUT")),
          POOL_CLOSE_TIMEOUT_MILLISECONDS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createNeonPostflightAdapter() {
  return {
    async connect(_kind, connectionString) {
      const pool = new Pool({
        connectionString,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 5_000,
        max: 1,
      });
      pool.on("error", () => {
        // Pool errors are converted to fixed postflight classifications upstream.
      });
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        await endPoolWithinDeadline(pool).catch(() => {});
        throw error;
      }
      let closed = false;
      return {
        query(statement, parameters) {
          return client.query(statement, parameters);
        },
        async close() {
          if (closed) return;
          closed = true;
          client.release(true);
          await endPoolWithinDeadline(pool);
        },
      };
    },
  };
}
