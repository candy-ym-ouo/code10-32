import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// In-memory fakes stand in for Prisma. They implement exactly the calls the
// create route + session-service make, letting us verify the HTTP contract
// (idempotent replay, degraded audit truthfulness, key reuse) without a DB.

type IdemRow = {
  id: string;
  userId: string;
  key: string;
  resourceType: string;
  requestHash: string;
  status: "CREATING" | "COMPLETED";
  resourceId: string | null;
  statusCode: number | null;
  responseBody: unknown;
  auditStatus: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

const { fakeState, makePrisma } = vi.hoisted(() => {
  const state: {
    sessions: Map<string, Record<string, unknown>>;
    auditLogs: Array<{ action: string; resourceId: string | null; userId: string | null }>;
    keys: Map<string, IdemRow>;
    auditShouldFail: boolean;
    clock: number;
  } = {
    sessions: new Map(),
    auditLogs: [],
    keys: new Map(),
    auditShouldFail: false,
    clock: Date.now(),
  };

  const idemIndex = (userId: string, key: string) => `${userId}:${key}`;

  function makePrisma() {
    const idempotency = {
      findUnique: vi.fn(async ({ where }: { where: { userId_key: { userId: string; key: string } } }) =>
        state.keys.get(idemIndex(where.userId_key.userId, where.userId_key.key)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: IdemRow }) => {
        const index = idemIndex(data.userId, data.key);
        if (state.keys.has(index)) {
          const error = new Error("unique violation") as Error & { code: string };
          error.code = "P2002";
          throw error;
        }
        const row: IdemRow = {
          ...data,
          id: data.id ?? crypto.randomUUID(),
          createdAt: new Date(state.clock),
          updatedAt: new Date(state.clock),
        };
        state.keys.set(index, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<IdemRow> }) => {
        for (const row of state.keys.values()) {
          if (row.id === where.id) Object.assign(row, data, { updatedAt: new Date(++state.clock) });
        }
        return {};
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; status?: string; resourceId?: string }; data: Partial<IdemRow> }) => {
          let count = 0;
          for (const row of state.keys.values()) {
            if (row.id !== where.id) continue;
            if (where.status && row.status !== where.status) continue;
            if (where.resourceId && row.resourceId !== where.resourceId) continue;
            Object.assign(row, data, { updatedAt: new Date(++state.clock) });
            count += 1;
          }
          return { count };
        },
      ),
    };

    const practiceSession = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = crypto.randomUUID();
        const row = { id, ...data, status: "DRAFT", version: 0 };
        state.sessions.set(id, row);
        return row;
      }),
    };

    const auditLog = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (state.auditShouldFail) throw new Error("audit db unavailable");
        state.auditLogs.push({
          action: String(data.action),
          resourceId: data.resourceId as string,
          userId: data.userId as string,
        });
        return { id: crypto.randomUUID() };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.auditLogs.some((row) => row.action === where.action && row.resourceId === where.resourceId)
          ? { id: "existing" }
          : null,
      ),
    };

    const client = { idempotencyKey: idempotency, practiceSession, auditLog };
    const tx = { practiceSession, idempotencyKey: { updateMany: idempotency.updateMany } };
    return {
      ...client,
      $transaction: vi.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx)),
    };
  }

  return { fakeState: state, makePrisma };
});

vi.mock("../src/lib/prisma.js", () => ({ prisma: makePrisma() }));
// Avoid loading the native argon2 binding (incompatible prebuilt in this environment)
vi.mock("../src/lib/security.js", () => ({ hashIp: (ip: string) => `ip:${ip}` }));

import Fastify from "fastify";
import type { FastifyError } from "fastify";
import sessionRoutes from "../src/routes/sessions.js";
import { AppError, sendError } from "../src/lib/errors.js";

const userId = "00000000-0000-0000-0000-000000000001";

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) return sendError(reply, error, request.id);
    request.log.error({ err: error }, "unhandled");
    return sendError(reply, new AppError(500, "INTERNAL_ERROR", "服务暂时不可用"), request.id);
  });
  app.decorate("authenticate", async (request: { authUser?: { id: string } }) => {
    request.authUser = { id: userId };
  });
  await app.register(sessionRoutes, { prefix: "/api/v1/sessions" });
  return app;
}

const validBody = () => ({
  title: "节奏练习",
  instrument: "小提琴",
  startedAt: new Date("2026-10-04T10:00:00.000Z").toISOString(),
});

beforeEach(() => {
  fakeState.sessions.clear();
  fakeState.auditLogs.length = 0;
  fakeState.keys.clear();
  fakeState.auditShouldFail = false;
  fakeState.clock = Date.now();
  vi.clearAllMocks();
});

describe("POST /sessions idempotency", () => {
  it("creates once and replays the same session on keyed retry", async () => {
    const app = await buildServer();
    const key = crypto.randomUUID();
    const first = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ session: { id: string } }>();

    const second = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ session: { id: string }; replayed?: boolean }>();

    expect(secondBody.session.id).toBe(firstBody.session.id);
    expect(secondBody.replayed).toBe(true);
    expect(fakeState.sessions.size).toBe(1);
    expect(fakeState.auditLogs.length).toBe(1);
  });

  it("reports the real degraded result when audit fails, then recovers on keyed retry", async () => {
    const app = await buildServer();
    const key = crypto.randomUUID();

    fakeState.auditShouldFail = true;
    const failed = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(failed.statusCode).toBe(201);
    const failedBody = failed.json<{ session: { id: string }; warnings?: string[] }>();
    expect(failedBody.session).toBeTruthy();
    expect(failedBody.warnings).toEqual(["AUDIT_PENDING"]);
    expect(fakeState.sessions.size).toBe(1);
    expect(fakeState.auditLogs.length).toBe(0);

    // Retry after the audit store recovered: no duplicate session, audit repaired.
    fakeState.auditShouldFail = false;
    const retry = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(retry.statusCode).toBe(201);
    const retryBody = retry.json<{ session: { id: string }; warnings?: string[]; replayed?: boolean }>();
    expect(retryBody.session.id).toBe(failedBody.session.id);
    expect(retryBody.warnings).toBeUndefined();
    expect(retryBody.replayed).toBe(true);
    expect(fakeState.sessions.size).toBe(1);
    expect(fakeState.auditLogs.length).toBe(1);
  });

  it("keeps surfacing AUDIT_PENDING while the audit outage persists", async () => {
    const app = await buildServer();
    const key = crypto.randomUUID();

    fakeState.auditShouldFail = true;
    const first = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(first.statusCode).toBe(201);

    const retry = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(retry.statusCode).toBe(201);
    expect(retry.json<{ warnings?: string[] }>().warnings).toEqual(["AUDIT_PENDING"]);
    expect(fakeState.sessions.size).toBe(1);
    expect(fakeState.auditLogs.length).toBe(0);
  });

  it("rejects reusing a key with a different payload", async () => {
    const app = await buildServer();
    const key = crypto.randomUUID();
    const first = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: validBody() });
    expect(first.statusCode).toBe(201);

    const other = validBody();
    other.title = "完全不同的练习";
    const reused = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": key }, payload: other });
    expect(reused.statusCode).toBe(422);
    expect(reused.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(fakeState.sessions.size).toBe(1);
  });

  it("rejects malformed idempotency keys", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": "bad" }, payload: validBody() });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(fakeState.sessions.size).toBe(0);
  });

  it("still degrades truthfully without a key (legacy client)", async () => {
    const app = await buildServer();
    fakeState.auditShouldFail = true;
    const res = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: validBody() });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ warnings?: string[] }>().warnings).toEqual(["AUDIT_PENDING"]);
    expect(fakeState.sessions.size).toBe(1);
  });
});
