from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from comfyui_status import build_dry_run_cost_fields, map_comfyui_status
from comfyui_workflow import (
    ComfyUIWorkflowError,
    extract_history_outputs,
    load_workflow,
    validate_api_workflow,
)
from models import Job


class ComfyUIExecutionError(RuntimeError):
    """Raised when a local ComfyUI dry-run cannot produce a usable result."""


@dataclass
class ComfyUIExecutionResult:
    """The non-billable result of one opt-in ComfyUI execution."""

    prompt_id: str
    status: str
    outputs: list[dict[str, Any]] = field(default_factory=list)
    actual_cost: float | None = None
    cost_status: str = "unavailable"
    provider_usage: dict[str, Any] | None = None
    pricing_version: str | None = None
    error: str | None = None


class ComfyUIDryRunExecutor:
    """Submit and observe a previously reviewed, local dry-run workflow."""

    def __init__(
        self,
        client: Any,
        workflow_path: str | Path,
        output_dir: str | Path,
        *,
        poll_interval: float = 2.0,
        max_attempts: int = 180,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        client_id: str | None = None,
        on_submitted: Callable[[Job, str], Awaitable[Any]] | None = None,
    ):
        if poll_interval < 0:
            raise ValueError("poll_interval must not be negative")
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self.client = client
        self.workflow_path = Path(workflow_path)
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.poll_interval = poll_interval
        self.max_attempts = max_attempts
        self._sleep = sleep
        self.client_id = client_id
        self._on_submitted = on_submitted

    async def execute(self, job: Job) -> ComfyUIExecutionResult:
        """Run the validated graph and return only local, non-billable metadata."""
        # 先加载并校验工作流，再决定是恢复已提交任务，还是提交新任务。
        workflow = load_workflow(self.workflow_path)
        validate_api_workflow(workflow)

        existing_prompt_id = job.providerTaskId
        if job.status in {"submitted", "running"} and not existing_prompt_id:
            return self._failed_result(
                "",
                "Submitted or running ComfyUI job is missing provider_task_id prompt_id",
            )
        if existing_prompt_id:
            if job.status not in {"submitted", "running"}:
                return self._failed_result(
                    existing_prompt_id,
                    "Existing provider_task_id cannot be safely resumed from this job status",
                )
            prompt_id = existing_prompt_id
        else:
            prompt_id = await self.client.queue_prompt(
                workflow,
                client_id=self.client_id,
            )
            if not isinstance(prompt_id, str) or not prompt_id.strip():
                raise ComfyUIExecutionError("ComfyUI returned an invalid prompt_id")
            if self._on_submitted is not None:
                await self._on_submitted(job, prompt_id)

        last_history: dict[str, Any] = {}
        for attempt in range(self.max_attempts):
            last_history = await self.client.history(prompt_id)
            status = map_comfyui_status(last_history)

            if status == "completed":
                try:
                    outputs = extract_history_outputs(last_history)
                    outputs = self._locate_outputs(outputs)
                except (ComfyUIWorkflowError, ComfyUIExecutionError) as exc:
                    return self._failed_result(prompt_id, str(exc))

                if not outputs:
                    return self._failed_result(
                        prompt_id,
                        "ComfyUI completed without output files",
                    )
                return self._result(prompt_id, "completed", outputs)

            if status == "failed":
                return self._failed_result(
                    prompt_id,
                    self._history_error(last_history),
                )

            if attempt + 1 < self.max_attempts:
                await self._sleep(self.poll_interval)

        return self._failed_result(
            prompt_id,
            "ComfyUI execution did not complete within the polling limit",
        )

    def _locate_outputs(self, outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # 将 history 中的相对输出路径映射为绝对路径，并确保文件确实落在 output_dir 内。
        located: list[dict[str, Any]] = []
        for metadata in outputs:
            filename = metadata["filename"]
            subfolder = metadata["subfolder"]
            candidate = (self.output_dir / subfolder / filename).resolve()
            try:
                candidate.relative_to(self.output_dir)
            except ValueError as exc:
                raise ComfyUIExecutionError(
                    f"ComfyUI output escapes output directory: {filename}"
                ) from exc
            if not candidate.is_file():
                raise ComfyUIExecutionError(
                    f"ComfyUI output file is missing: {candidate}"
                )
            located.append({**metadata, "local_path": str(candidate)})
        return located

    @staticmethod
    def _history_error(history: dict[str, Any]) -> str:
        # 历史对象结构异常时返回通用错误，避免把底层结构问题吞掉。
        if not isinstance(history, dict):
            return "ComfyUI returned malformed history"
        return "ComfyUI execution failed"

    @staticmethod
    def _result(
        prompt_id: str,
        status: str,
        outputs: list[dict[str, Any]],
        error: str | None = None,
    ) -> ComfyUIExecutionResult:
        # 把通用字段和 dry-run 成本字段打包成统一返回值。
        return ComfyUIExecutionResult(
            prompt_id=prompt_id,
            status=status,
            outputs=outputs,
            error=error,
            **build_dry_run_cost_fields(),
        )

    @classmethod
    def _failed_result(cls, prompt_id: str, error: str) -> ComfyUIExecutionResult:
        return cls._result(prompt_id, "failed", [], error)
