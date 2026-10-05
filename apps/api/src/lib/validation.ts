import { z } from "zod";
import { AppError, validationError } from "./errors.js";

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

const idempotencyKeySchema = z.string().uuid();

export function parseClientRequestId(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !idempotencyKeySchema.safeParse(value).success) {
    throw new AppError(400, "VALIDATION_ERROR", "Idempotency-Key 必须是有效的 UUID");
  }
  return value;
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
