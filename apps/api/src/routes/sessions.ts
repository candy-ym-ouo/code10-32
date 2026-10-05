import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { completionSchema, sessionBatchSchema, sessionCreateSchema, sessionListQuerySchema, sessionUpdateSchema } from "@practice/contracts";
import { z } from "zod";
import { parseOrThrow } from "../lib/validation.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { audit, recoverAudit, tryAudit } from "../lib/audit.js";
import { hashRequestPayload, readIdempotencyKey } from "../lib/idempotency.js";
import {
  archiveSession,
  beginSessionCreate,
  commitSessionCreate,
  completeSession,
  getCompletionMissing,
  getSessionForUser,
  listSessions,
  markSessionCreateAuditResult,
  requestSessionDeletion,
  startReview,
  updateSession,
} from "../services/session-service.js";

const deleteSchema = z.object({ confirmationTitle: z.string().min(1).max(120) });

type StoredCreateBody = { session: Prisma.PracticeSessionGetPayload<object>; warnings?: string[] };

/**
 * Replays a completed create request with the same idempotency key.
 *
 * The response reflects the real result: if the audit was degraded (or the
 * first attempt crashed right after commit), this retry recovers the missing
 * audit row once; the stored snapshot is then upgraded so later replays also
 * report the recovered state. The session is never created twice.
 */
async function replaySessionCreate(
  request: FastifyRequest,
  idempotency: { id: string; resourceId: string | null; auditStatus: string; responseBody: Prisma.JsonValue | null },
): Promise<{ status: number; body: StoredCreateBody & { replayed?: true } }> {
  const stored = (idempotency.responseBody as StoredCreateBody | null) ?? null;
  const session = stored?.session ?? null;

  if (idempotency.auditStatus !== "SUCCESS" && idempotency.resourceId && session) {
    const recovered = await recoverAudit(request, "SESSION_CREATED", "PRACTICE_SESSION", idempotency.resourceId, "SUCCESS");
    if (recovered) {
      const body = { session };
      await prisma.idempotencyKey.update({
        where: { id: idempotency.id },
        data: { auditStatus: "SUCCESS", responseBody: body as unknown as Prisma.InputJsonValue },
      });
      return { status: 201, body: { ...body, replayed: true as const } };
    }
  }

  if (!session || !stored) {
    throw new AppError(404, "RESOURCE_NOT_FOUND", "幂等记录对应的练习不存在，请重新创建");
  }
  return {
    status: 201,
    body: { session, ...(stored.warnings ? { warnings: stored.warnings } : {}), replayed: true as const },
  };
}

const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const query = parseOrThrow(sessionListQuerySchema, request.query);
    return listSessions(request.authUser!.id, query);
  });

  app.post("/", async (request, reply) => {
    const userId = request.authUser!.id;
    const input = parseOrThrow(sessionCreateSchema, request.body);
    if (input.startedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(400, "VALIDATION_ERROR", "练习开始时间不能晚于当前时间 5 分钟以上");
    }

    const key = readIdempotencyKey(request);

    // Legacy path for clients that do not send an idempotency key. The
    // session is the source of truth: if the post-commit audit fails we
    // still return 201 with a warning instead of a false 5xx that makes the
    // client create a second session.
    if (!key) {
      const created = await prisma.practiceSession.create({
        data: {
          userId,
          title: input.title,
          instrument: input.instrument,
          focus: input.focus ?? null,
          location: input.location ?? null,
          notes: input.notes ?? null,
          startedAt: input.startedAt,
          actualDurationMs: input.actualDurationMs ?? 0,
        },
      });
      const auditOk = await tryAudit(request, "SESSION_CREATED", "PRACTICE_SESSION", created.id, "SUCCESS");
      return reply.status(201).send({ session: created, ...(auditOk ? {} : { warnings: ["AUDIT_PENDING"] }) });
    }

    const gate = await beginSessionCreate(userId, key, hashRequestPayload(input));
    if (gate.outcome === "completed") {
      const replay = await replaySessionCreate(request, {
        id: gate.idempotency.id,
        resourceId: gate.idempotency.resourceId,
        auditStatus: gate.idempotency.auditStatus,
        responseBody: gate.idempotency.responseBody,
      });
      return reply.status(replay.status).send(replay.body);
    }

    // The marker is CREATING during the transaction; a crash here leaves it
    // for the grace-window recovery rather than creating a second session.
    const committed = await commitSessionCreate(userId, gate.idempotencyId, input);

    const auditOk = await tryAudit(request, "SESSION_CREATED", "PRACTICE_SESSION", committed.session.id, "SUCCESS");
    const result = await markSessionCreateAuditResult(gate.idempotencyId, committed.session.id, committed.session, auditOk);
    return reply.status(201).send({ session: result.session, ...(result.warnings.length ? { warnings: result.warnings } : {}) });
  });

  app.post("/batch/archive", async (request) => {
    const input = parseOrThrow(sessionBatchSchema, request.body);
    const result = await prisma.practiceSession.updateMany({
      where: { id: { in: input.ids }, userId: request.authUser!.id, status: "COMPLETED" },
      data: { status: "ARCHIVED", archivedAt: new Date(), version: { increment: 1 } },
    });
    return { archivedCount: result.count };
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { session: await getSessionForUser(request.authUser!.id, id) };
  });

  app.patch("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(sessionUpdateSchema, request.body);
    if (input.startedAt && input.startedAt.getTime() > Date.now() + 5 * 60_000) {
      throw new AppError(400, "VALIDATION_ERROR", "练习开始时间不能晚于当前时间 5 分钟以上");
    }
    const session = await updateSession(request.authUser!.id, id, input);
    return { session };
  });

  app.post("/:id/start-review", async (request) => {
    const { id } = request.params as { id: string };
    return { session: await startReview(request.authUser!.id, id) };
  });

  app.get("/:id/completion-check", async (request) => {
    const { id } = request.params as { id: string };
    const missing = await getCompletionMissing(request.authUser!.id, id);
    return { complete: missing.length === 0, missing };
  });

  app.post("/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(completionSchema, request.body);
    const session = await completeSession(request.authUser!.id, id, input);
    await audit(request, "SESSION_COMPLETED", "PRACTICE_SESSION", id, "SUCCESS");
    return { session, statisticsInvalidated: true };
  });

  app.post("/:id/archive", async (request) => {
    const { id } = request.params as { id: string };
    const session = await archiveSession(request.authUser!.id, id);
    await audit(request, "SESSION_ARCHIVED", "PRACTICE_SESSION", id, "SUCCESS");
    return { session };
  });

  app.post("/:id/restore", async (request) => {
    const { id } = request.params as { id: string };
    const session = await archiveSession(request.authUser!.id, id, true);
    return { session };
  });

  app.delete("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(deleteSchema, request.body);
    const result = await requestSessionDeletion(request.authUser!.id, id, input.confirmationTitle);
    await audit(request, "SESSION_DELETE_REQUESTED", "PRACTICE_SESSION", id, "SUCCESS");
    return result;
  });
};

export default sessionRoutes;
