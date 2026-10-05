-- AlterTable
ALTER TABLE "practice_sessions" ADD COLUMN "client_request_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "practice_sessions_user_id_client_request_id_key" ON "practice_sessions"("user_id", "client_request_id");
