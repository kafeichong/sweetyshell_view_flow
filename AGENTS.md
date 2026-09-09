# Repository Guidelines

## Project Structure & Module Organization
This repository is a two-package workspace:

- `packages/backend/`：NestJS API 服务（源码在 `packages/backend/src`），数据库模型在 `packages/backend/prisma/schema.prisma`。
- `packages/worker/`：Python FastAPI Worker（服务入口 `main.py`，任务执行器 `executor.py`，配置 `config.py`，适配器在 `packages/worker/providers/`，测试在 `packages/worker/tests/`）。
- 根目录不包含统一入口脚本；请按子包分别处理依赖与运行环境。
- 开发时请忽略并避免提交环境产物：`venv/`、`__pycache__/`、`.pyc`、下载缓存目录等临时文件。

## Build, Test, and Development Commands
- Backend（NestJS）：
  - `cd packages/backend && npm install`
  - `npm run build`：生成 `dist/`。
  - `npm run dev`：热重载启动。
  - `npm run start`：本地启动。
  - `npm run start:prod`：生产模式启动 `dist/main`。
  - Prisma：`npm run prisma:generate` / `npm run prisma:migrate` / `npm run prisma:studio`。
- Worker（Python）：
  - `cd packages/worker`
  - `python -m venv venv && source venv/bin/activate`
  - `pip install -r requirements.txt`
  - `python main.py`（启动 Worker 主入口，或用 `npm run dev` / `npm run start` 调用同一虚拟环境命令）。

## Coding Style & Naming Conventions
- Python：4 空格缩进，函数和变量用 `snake_case`，类用 `PascalCase`，优先使用类型注解；尽量保持现有 FastAPI/Pydantic 风格。
- TypeScript（NestJS）：2 空格缩进、`camelCase` 命名、文件名小写加下划线或短横线均可（保持现有风格），保留现有模块边界（`module`、`service`、`controller`）。
- 配置与可观察性优先：新增配置项需同步在 `.env` 说明中体现用途和默认值。

## Testing Guidelines
- Worker 测试框架为 `pytest`（见 `requirements.txt`），测试文件遵循 `test_*.py`。
- 推荐命令：
  - `cd packages/worker && pytest`
  - `cd packages/worker && pytest packages/worker/tests/test_*.py`（按模块分组）。
- Backend 当前仓库未发现现成的后端测试脚本；如新增请放在标准的 `__tests__` / `*.spec.ts` 结构，并在提交说明中注明覆盖范围。

## Commit & Pull Request Guidelines
- 当前路径下未发现 `.git` 元数据，无法直接读取到该仓库已有提交消息规范；建议暂按统一约定提交，例如 `feat: ...`、`fix: ...`、`chore: ...`。
- PR 建议包含：变更说明、影响范围、影响的文件清单、运行验证命令（至少列出对应包的 `build/test/dev` 命令），以及环境变量或密钥变更说明。

## Security & Configuration Tips
- 所有外部调用密钥（如 Provider/API、OSS、数据库）必须通过环境变量注入，不要写入代码和提交中。
- 本地测试账号与 token 不得混用生产环境；涉及视频素材、任务状态、计费逻辑改动时务必标注风险与回滚方案。
