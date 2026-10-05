import { describe, expect, it } from "vitest";
import { hashRequestPayload, readIdempotencyKey, newIdempotencyKey } from "../src/lib/idempotency.js";

describe("readIdempotencyKey", () => {
  function fakeRequest(header: string | undefined) {
    return { headers: { "idempotency-key": header } } as never;
  }

  it("returns null when the header is absent", () => {
    expect(readIdempotencyKey(fakeRequest(undefined))).toBeNull();
  });

  it("accepts a trimmed UUID", () => {
    const key = newIdempotencyKey();
    expect(readIdempotencyKey(fakeRequest(`  ${key} `))).toBe(key);
  });

  it("rejects keys shorter than 8 characters", () => {
    expect(() => readIdempotencyKey(fakeRequest("short"))).toThrowError(/幂等键/);
  });

  it("rejects keys containing non-ASCII characters", () => {
    expect(() => readIdempotencyKey(fakeRequest("练习-key-12345"))).toThrowError(/幂等键/);
  });
});

describe("hashRequestPayload", () => {
  it("produces a stable sha256 hex digest", () => {
    const hash = hashRequestPayload({ title: "练习一", instrument: "钢琴" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashRequestPayload({ title: "练习一", instrument: "钢琴" }));
  });

  it("ignores object key order", () => {
    expect(hashRequestPayload({ a: 1, b: 2 })).toBe(hashRequestPayload({ b: 2, a: 1 }));
  });

  it("distinguishes different payloads", () => {
    expect(hashRequestPayload({ title: "练习一" })).not.toBe(hashRequestPayload({ title: "练习二" }));
  });

  it("treats undefined values as absent", () => {
    expect(hashRequestPayload({ a: 1, focus: undefined })).toBe(hashRequestPayload({ a: 1 }));
  });
});
