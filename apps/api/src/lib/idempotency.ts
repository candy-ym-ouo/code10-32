import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

/** 幂等键服务端保留时长（含存储的响应快照）。 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/**
 * 首次请求在业务提交前崩溃后，`CREATING` 记录被视为可接管的时间。
 * 正常请求的事务只会在毫秒级保持该状态。
 */
export const IDEMPOTENCY_INFLIGHT_GRACE_MS = 2 * 60_000;

export const IDEMPOTENCY_RESOURCE_SESSION_CREATE = "PRACTICE_SESSION:CREATE";

export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * 读取并校验 `Idempotency-Key` 请求头（HTTP 头大小写不敏感）。
 * 头存在但格式非法时返回 400；缺失时返回 null，由调用方决定是否强制。
 */
export function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const key = value.trim();
  if (key.length < 8 || key.length > 128 || /[^\x21-\x7e]/.test(key)) {
    throw new AppError(400, "IDEMPOTENCY_KEY_INVALID", "幂等键必须是 8-128 个可见 ASCII 字符");
  }
  return key;
}

/**
 * 计算规范化请求负载的 SHA-256。同一幂等键重试时负载必须一致，
 * 否则视为键被复用，拒绝执行（Stripe 风格）。
 */
export function hashRequestPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
}
