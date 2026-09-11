# Attempt and Asset Traceability Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐真实 Seedance 链路的 Attempt 模型/时间追溯、输入 Asset 上传完成确认、hash 并发唯一性和历史 hash 盘点能力，且不发起新的付费 Provider 调用。

**Architecture:** Worker 仍通过现有私有状态接口更新 Task/Attempt，但在实际 Provider 调用边界写入 effective model 和三个时间点；Asset 仍使用现有表，通过客户端 PUT 后调用完成确认接口，由 Backend 使用 OSS HEAD 校验并推进 `inspectionStatus`。数据库用 `(ownerId, role, fileHash)` 约束解决并发重复，历史数据只提供 dry-run/backfill 工具，不自动删除或合并。

**Tech Stack:** NestJS, Prisma/PostgreSQL, ali-oss, Python 3, httpx, pytest, Jest.

**Spec:** `docs/2026-09-10/真实出片后链路缺口分析.md`

## Global Constraints

- Preview 必须继续以 `status='preview'` 落库且不能被 Worker claim。
- Production 仍由 `VIDEO_FLOW_PRODUCTION_ACTORS` 白名单控制，默认关闭。
- Provider 提交结果不确定时必须进入 `requires_review`，不得自动重投。
- 本轮不得发起真实 Seedance/Ark 生成任务。
- 不覆盖、不清理现有未提交修改。
- 历史 Asset 第一轮只盘点或回填 hash，不自动删除、合并或改写 Task `requestSnapshot`。

---

### Task 1: Attempt effective model and lifecycle timestamps

**Files:**
- Modify: `packages/backend/src/tasks/tasks.service.ts`
- Modify: `packages/backend/src/tasks/task-claim.service.ts`
- Modify: `packages/backend/src/tasks/tasks.service.spec.ts`
- Modify: `packages/backend/src/tasks/task-claim.service.spec.ts`
- Modify: `packages/worker/models.py`
- Modify: `packages/worker/executor.py`
- Modify: `packages/worker/tests/test_comfyui_executor.py`
- Modify: `packages/worker/tests/test_provider_submission_recovery.py`

**Interfaces:**
- Consumes: `Job.requestSnapshot.params`, `ExecutionAttempt.model/submittedAt/startedAt/finishedAt`.
- Produces: Worker status payload fields `attemptModel`, `startedAt`, `finishedAt`; recovery uses `attemptSubmittedAt`.

- [ ] Add failing Backend tests proving `attemptModel`, `startedAt`, and `finishedAt` are mapped into the Attempt update rather than Task fields.
- [ ] Run the focused Jest tests and confirm they fail because `attemptModel` is not accepted or persisted.
- [ ] Extend `AttemptUpdatePayload` and `TasksService.update()` with `attemptModel` mapping.
- [ ] Add failing Worker tests proving the actual/default Seedance model is sent before Provider submission and terminal updates include `finishedAt`.
- [ ] Run focused pytest tests and confirm the expected payload fields are absent.
- [ ] Extend `update_job_status()` with `attempt_model`, `started_at`, and `finished_at` parameters.
- [ ] Compute the effective model from Provider params using the same default used by `SeedanceAdapter` and persist it before external submission.
- [ ] Set `submittedAt` only when `providerTaskId` is persisted; preserve the pre-call uncertain-submission marker.
- [ ] Make recovery timeout use `attemptSubmittedAt`, with `submittedAt` only as legacy fallback.
- [ ] Run focused Backend and Worker tests until green.

### Task 2: Asset upload completion and OSS verification

**Files:**
- Modify: `packages/backend/src/assets/asset-presign.service.ts`
- Create: `packages/backend/src/assets/asset-presign.service.spec.ts`
- Modify: `packages/backend/src/assets/assets.service.ts`
- Modify: `packages/backend/src/assets/assets.service.spec.ts`
- Modify: `packages/backend/src/v1/assets/v1-assets.controller.ts`
- Modify: `packages/backend/src/v1/assets/v1-assets.controller.spec.ts`
- Modify: `packages/backend/src/v1/internal/v1-worker.controller.ts`
- Modify: `packages/comfyui-video-flow-client/client.py`
- Modify: `packages/comfyui-video-flow-client/tests/test_client.py`

**Interfaces:**
- Consumes: `POST /api/v1/assets/upload-ticket`, OSS signed PUT, `Asset.fileHash/sizeBytes/mimeType`.
- Produces: `POST /api/v1/assets/:id/complete`, `Asset.inspectionStatus='uploaded'`, persisted bucket, guarded download resolution.

- [ ] Add failing controller/service tests for successful completion, missing OSS object, size mismatch, MIME mismatch, hash metadata mismatch, and cross-actor access.
- [ ] Run focused Jest tests and confirm failures are due to the missing completion API and state transition.
- [ ] Extend presigned upload headers with `x-oss-meta-sha256` when a hash exists.
- [ ] Add an OSS HEAD method that normalizes content length, content type, and SHA-256 metadata.
- [ ] Add `AssetsService.markUploaded()` and `findOwnedUploaded()` behavior.
- [ ] Add `POST /api/v1/assets/:id/complete`; verify object metadata before setting bucket and `inspectionStatus='uploaded'`.
- [ ] Reject public and Worker download resolution when the input Asset is not uploaded.
- [ ] Add failing client test proving completion is called after PUT and before returning the Asset ticket.
- [ ] Run the client test and confirm it fails because only PUT currently occurs.
- [ ] Add `complete_upload()` and call it from `upload_media()` after successful PUT.
- [ ] Run focused Backend and client tests until green.

### Task 3: Concurrent hash uniqueness

**Files:**
- Modify: `packages/backend/prisma/schema.prisma`
- Create: `packages/backend/prisma/migrations/20260910193000_add_asset_owner_role_hash_unique/migration.sql`
- Modify: `packages/backend/src/v1/assets/v1-assets.controller.ts`
- Modify: `packages/backend/src/v1/assets/v1-assets.controller.spec.ts`

**Interfaces:**
- Consumes: `Asset.ownerId`, `Asset.role`, `Asset.fileHash`.
- Produces: one canonical input Asset per `(ownerId, role, fileHash)` and conflict recovery by re-reading it.

- [ ] Add a failing controller test where Asset creation throws Prisma `P2002` and the controller must return the row created by the concurrent request.
- [ ] Run the focused test and confirm the conflict currently escapes.
- [ ] Add `@@unique([ownerId, role, fileHash])` to Prisma schema and a matching migration.
- [ ] Catch only the matching Prisma uniqueness error, re-read by owner/hash, and return its upload ticket.
- [ ] Run Prisma generation, focused tests, and build.

### Task 4: Historical Asset hash dry-run/backfill utility

**Files:**
- Create: `scripts/backfill_asset_hashes.py`
- Create: `packages/worker/tests/test_backfill_asset_hashes.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Backend `DATABASE_URL`, OSS configuration already used by the project, input Asset rows with null `file_hash`.
- Produces: JSON/console dry-run report; updates only when `--apply` is explicitly supplied.

- [ ] Add failing tests using fake row/object adapters for hash calculation, missing objects, duplicate grouping, dry-run no-write behavior, and explicit apply behavior.
- [ ] Run the focused pytest test and confirm the script API is missing.
- [ ] Implement streaming SHA-256 calculation and a report containing totals, missing objects, failures, duplicate groups, and proposed updates.
- [ ] Require explicit `--apply`; default mode must make no database writes.
- [ ] On apply, update only rows whose object was fetched and hashed successfully; never delete or merge rows.
- [ ] Document required environment variables without including credentials.
- [ ] Run focused tests until green.

### Task 5: Full verification and documentation update

**Files:**
- Modify: `docs/2026-09-10/真实出片后链路缺口分析.md`

**Interfaces:**
- Consumes: completed implementation and test output.
- Produces: evidence-bounded completion status with unresolved production operations listed separately.

- [ ] Run `cd packages/backend && npm run prisma:generate`.
- [ ] Run `cd packages/backend && npm run build && npx jest`.
- [ ] Run `cd packages/comfyui-video-flow-client && python -m pytest` using an available project-compatible interpreter.
- [ ] Run `cd packages/worker && pytest`.
- [ ] Run the historical hash tool in help/test mode only; do not connect to or mutate production.
- [ ] Update the analysis document with implemented files, validation commands, and remaining deployment/billing/credential actions.
- [ ] Inspect `git diff --check` and `git status --short`; do not commit unless separately requested.
