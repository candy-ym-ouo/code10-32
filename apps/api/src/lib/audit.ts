import type { FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { hashIp } from "./security.js";

export type AuditResult = "SUCCESS" | "FAILURE";
export type AuditClient = Prisma.TransactionClient | typeof prisma;

interface AuditEntry {
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: AuditResult;
  ipHash: string;
  traceId: string;
  metadata?: Prisma.InputJsonValue;
}

function buildEntry(
  request: FastifyRequest,
  action: string,
  resource: string,
  resourceId: string | null,
  result: AuditResult,
  metadata?: Record<string, unknown>,
): AuditEntry {
  return {
    userId: request.authUser?.id ?? null,
    action,
    resource,
    resourceId,
    result,
    ipHash: hashIp(request.ip),
    traceId: request.id,
    metadata: metadata as Prisma.InputJsonValue | undefined,
  };
}

/**
 * Write an audit log. Throws on failure so callers can decide whether that
 * failure is fatal to the request or must be degraded.
 */
export async function audit(
  request: FastifyRequest,
  action: string,
  resource: string,
  resourceId: string | null,
  result: AuditResult,
  metadata?: Record<string, unknown>,
  client: AuditClient = prisma,
): Promise<void> {
  await client.auditLog.create({ data: buildEntry(request, action, resource, resourceId, result, metadata) });
}

/**
 * Best-effort audit. Never throws; returns false when the audit row could not
 * be written. Used after the business commit already succeeded, so an audit
 * outage must not erase or lie about the real operation result.
 */
export async function tryAudit(
  request: FastifyRequest,
  action: string,
  resource: string,
  resourceId: string | null,
  result: AuditResult,
  metadata?: Record<string, unknown>,
  client: AuditClient = prisma,
): Promise<boolean> {
  try {
    await client.auditLog.create({ data: buildEntry(request, action, resource, resourceId, result, metadata) });
    return true;
  } catch (error) {
    request.log.warn({ err: error, action, resource, resourceId }, "audit log write failed; degraded");
    return false;
  }
}

/**
 * Recover a previously-degraded audit on an idempotent retry: inserts the
 * missing row only if no matching row already exists (e.g. written by a
 * concurrent recovery).
 */
export async function recoverAudit(
  request: FastifyRequest,
  action: string,
  resource: string,
  resourceId: string | null,
  result: AuditResult,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const entry = buildEntry(request, action, resource, resourceId, result, metadata);
  const existing = await prisma.auditLog.findFirst({
    where: {
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      ...(entry.userId ? { userId: entry.userId } : {}),
    },
    select: { id: true },
  });
  if (existing) return true;
  return tryAudit(request, action, resource, resourceId, result, metadata);
}
