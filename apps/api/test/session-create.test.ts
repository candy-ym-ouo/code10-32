import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  practiceFindFirst: vi.fn(),
  txPracticeCreate: vi.fn(),
  txAuditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    practiceSession: { findFirst: mocks.practiceFindFirst },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../src/lib/security.js", () => ({
  hashIp: () => "f".repeat(64),
}));

import { createSession } from "../src/services/session-service.js";
import { parseClientRequestId } from "../src/lib/validation.js";
import { AppError } from "../src/lib/errors.js";

const userId = "4f6b8a2c-0000-4000-8000-000000000001";
const clientRequestId = "4f6b8a2c-0000-4000-8000-000000000002";

const input = {
  title: "音阶练习",
  instrument: "小提琴",
  startedAt: new Date("2026-10-04T08:00:00.000Z"),
  focus: null,
  location: null,
  notes: null,
  actualDurationMs: 1_800_000,
};

const auditContext = { userId, ip: "127.0.0.1", traceId: "req-1" };

const createdSession = {
  id: "4f6b8a2c-0000-4000-8000-000000000003",
  userId,
  title: input.title,
  clientRequestId,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      practiceSession: { create: mocks.txPracticeCreate },
      auditLog: { create: mocks.txAuditCreate },
    }),
  );
  mocks.txAuditCreate.mockResolvedValue({});
});

describe("createSession", () => {
  it("在同一事务中创建练习并写入审计日志", async () => {
    mocks.practiceFindFirst.mockResolvedValue(null);
    mocks.txPracticeCreate.mockResolvedValue(createdSession);

    const result = await createSession(userId, input, clientRequestId, auditContext);

    expect(result).toEqual({ session: createdSession, created: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txPracticeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId, clientRequestId, title: input.title }),
    });
    expect(mocks.txAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        action: "SESSION_CREATED",
        resource: "PRACTICE_SESSION",
        resourceId: createdSession.id,
        result: "SUCCESS",
      }),
    });
  });

  it("审计写入失败时整体失败，事务之外不会提交练习", async () => {
    mocks.practiceFindFirst.mockResolvedValue(null);
    mocks.txPracticeCreate.mockResolvedValue(createdSession);
    mocks.txAuditCreate.mockRejectedValue(new Error("audit log unavailable"));

    await expect(createSession(userId, input, clientRequestId, auditContext)).rejects.toThrow(
      "audit log unavailable",
    );
    // 练习创建只发生在（已回滚的）事务内部，不存在事务外的写入路径
    expect(mocks.txPracticeCreate).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("相同 clientRequestId 的重试返回已存在的练习，不重复创建", async () => {
    mocks.practiceFindFirst.mockResolvedValue(createdSession);

    const result = await createSession(userId, input, clientRequestId, auditContext);

    expect(result).toEqual({ session: createdSession, created: false });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txPracticeCreate).not.toHaveBeenCalled();
  });

  it("并发重试撞上唯一约束时返回已提交的练习", async () => {
    mocks.practiceFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(createdSession);
    mocks.txPracticeCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    const result = await createSession(userId, input, clientRequestId, auditContext);

    expect(result).toEqual({ session: createdSession, created: false });
    expect(mocks.practiceFindFirst).toHaveBeenCalledTimes(2);
  });

  it("未携带 clientRequestId 时不做幂等查询，直接创建", async () => {
    mocks.txPracticeCreate.mockResolvedValue({ ...createdSession, clientRequestId: null });

    const result = await createSession(userId, input, null, auditContext);

    expect(result.created).toBe(true);
    expect(mocks.practiceFindFirst).not.toHaveBeenCalled();
    expect(mocks.txPracticeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientRequestId: null }),
    });
  });
});

describe("parseClientRequestId", () => {
  it("缺少请求头时返回 null", () => {
    expect(parseClientRequestId(undefined)).toBeNull();
  });

  it("接受有效的 UUID 请求头", () => {
    expect(parseClientRequestId(clientRequestId)).toBe(clientRequestId);
    expect(parseClientRequestId([clientRequestId])).toBe(clientRequestId);
  });

  it("拒绝非法的幂等键", () => {
    expect(() => parseClientRequestId("not-a-uuid")).toThrowError(AppError);
    expect(() => parseClientRequestId("")).toThrowError(AppError);
    try {
      parseClientRequestId("not-a-uuid");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    }
  });
});
