import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findMigrationsDir(): string {
  const candidates = [
    join(process.cwd(), "apps/api/prisma/migrations"),
    join(dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations"),
    join(process.cwd(), "prisma/migrations"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "202609290001_init", "migration.sql")));
  if (!found) throw new Error("prisma migrations directory not found");
  return found;
}

const migrationsDir = findMigrationsDir();

// Only executes SQL syntax/features that PGlite supports; exercises the exact
// DDL Prisma migrate deploy would run for the idempotency table.
describe("idempotency migration (Postgres semantics via PGlite)", () => {
  it("applies all migrations and enforces unique (user_id, key) + conditional claim", async () => {
    const db = new PGlite();
    try {
      for (const dir of ["202609290001_init", "202609290002_reuse_audio_objects", "202610040001_idempotency_keys"]) {
        const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
        await db.exec(sql);
      }

      await db.query(
        `INSERT INTO users (id, email, password_hash, display_name, updated_at) VALUES
         ('11111111-1111-1111-1111-111111111111', 'a@example.com', 'x', 'A', now()),
         ('22222222-2222-2222-2222-222222222222', 'b@example.com', 'x', 'B', now())`,
      );

      const base = `INSERT INTO idempotency_keys
        (id, user_id, key, resource_type, request_hash, status, updated_at, expires_at)
        VALUES ($1, $2, $3, 'PRACTICE_SESSION:CREATE', $4, 'CREATING', now(), now() + interval '1 day')`;

      // Same key, two different users: allowed (unique is scoped per user)
      await db.query(base, ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "11111111-1111-1111-1111-111111111111", "key-0001", "h1"]);
      await db.query(base, ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "22222222-2222-2222-2222-222222222222", "key-0001", "h1"]);

      // Same (user, key) twice is rejected
      await expect(
        db.query(base, ["cccccccc-cccc-cccc-cccc-cccccccccccc", "11111111-1111-1111-1111-111111111111", "key-0001", "h2"]),
      ).rejects.toMatchObject({ code: "23505" });

      // Conditional claim: only the first CREATING -> COMPLETED update wins
      const first = await db.query(
        `UPDATE idempotency_keys SET status = 'COMPLETED', resource_id = '33333333-3333-3333-3333-333333333333'
         WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'CREATING'`,
      );
      expect(first.rowCount).toBe(1);
      const second = await db.query(
        `UPDATE idempotency_keys SET status = 'COMPLETED'
         WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'CREATING'`,
      );
      expect(second.rowCount).toBe(0);

      // The stored snapshot JSON round-trips
      await db.query(
        `UPDATE idempotency_keys SET response_body = $1::jsonb, status_code = 201, audit_status = 'PENDING'
         WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
        [JSON.stringify({ session: { id: "33333333-3333-3333-3333-333333333333" }, warnings: ["AUDIT_PENDING"] })],
      );
      const row = await db.query<{ response_body: { warnings: string[] } }>(
        `SELECT response_body FROM idempotency_keys WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'`,
      );
      expect(row.rows[0]!.response_body.warnings).toEqual(["AUDIT_PENDING"]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
