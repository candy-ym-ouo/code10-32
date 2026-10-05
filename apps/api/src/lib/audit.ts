import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { hashIp } from "./security.js";

export interface AuditContext {
  userId: string | null;
  ip: string;
  traceId: string;
}

export function getAuditContext(request: FastifyRequest): AuditContext {
  return {
    userId: request.authUser?.id ?? null,
    ip: request.ip,
    traceId: request.id,
  };
}

export async function writeAuditLog(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  context: AuditContext,
  action: string,
  resource: string,
  resourceId: string | null,
  result: "SUCCESS" | "FAILURE",
  metadata?: Record<string, unknown>,
): Promise<void> {
  await client.auditLog.create({
    data: {
      userId: context.userId,
      action,
      resource,
      resourceId,
      result,
      ipHash: hashIp(context.ip),
      traceId: context.traceId,
      metadata: metadata as never,
    },
  });
}

export async function audit(
  request: FastifyRequest,
  action: string,
  resource: string,
  resourceId: string | null,
  result: "SUCCESS" | "FAILURE",
  metadata?: Record<string, unknown>,
): Promise<void> {
  await writeAuditLog(prisma, getAuditContext(request), action, resource, resourceId, result, metadata);
}
