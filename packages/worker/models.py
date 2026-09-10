from enum import Enum
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    PENDING = "pending"
    SUBMITTED = "submitted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class FailureType(str, Enum):
    RATE_LIMIT = "rate_limit"
    CONTENT_POLICY = "content_policy"
    INVALID_INPUT = "invalid_input"
    TIMEOUT = "timeout"
    NETWORK_ERROR = "network_error"
    UNKNOWN = "unknown"


class Capability(str, Enum):
    IMAGE_TO_VIDEO = "IMAGE_TO_VIDEO"
    TEXT_TO_VIDEO = "TEXT_TO_VIDEO"


class Job(BaseModel):
    """
    适配 MVP Task 表的 Job 模型
    兼容旧字段（可选），支持新的简化字段
    """
    # 核心字段
    id: str
    status: str

    # MVP Task 表字段
    createdBy: str = Field(alias="created_by")
    prompt: str
    imageUrl: Optional[str] = Field(default=None, alias="image_url")
    videoUrl: Optional[str] = Field(default=None, alias="video_url")
    errorMsg: Optional[str] = Field(default=None, alias="error_msg")
    cost: Optional[float] = None
    createdAt: str = Field(alias="created_at")
    completedAt: Optional[str] = Field(default=None, alias="completed_at")

    # 旧字段（兼容性，全部可选，有默认值）
    workflowHash: Optional[str] = Field(default="simple-video-gen", alias="workflow_hash")
    workflowName: Optional[str] = Field(default="Simple Video Generation", alias="workflow_name")
    capability: str = "IMAGE_TO_VIDEO"  # 默认图生视频
    providerProfile: str = Field(default="seedance", alias="provider_profile")
    params: Optional[Dict[str, Any]] = None
    # v1 创建的任务把完整入参放在 request_snapshot 里（requestSnapshot.params），
    # 必须读出来，否则 image_asset_id / ratio / duration 会被静默丢弃。
    requestSnapshot: Optional[Dict[str, Any]] = Field(default=None, alias="request_snapshot")
    providerTaskId: Optional[str] = Field(default=None, alias="provider_task_id")
    attemptId: Optional[str] = Field(default=None, alias="attempt_id")
    attemptNo: Optional[int] = Field(default=None, alias="attempt_no")
    attemptStatus: Optional[str] = Field(default=None, alias="attempt_status")
    attemptProvider: Optional[str] = Field(default=None, alias="attempt_provider")
    attemptModel: Optional[str] = Field(default=None, alias="attempt_model")
    attemptSubmittedAt: Optional[str] = Field(default=None, alias="attempt_submitted_at")
    failureType: Optional[str] = Field(default=None, alias="failure_type")
    retryCount: int = Field(default=0, alias="retry_count")
    maxRetries: int = Field(default=3, alias="max_retries")
    actualCostCny: Optional[float] = Field(default=None, alias="actual_cost_cny")
    costStatus: Optional[str] = Field(default=None, alias="cost_status")
    providerUsage: Optional[Dict[str, Any]] = Field(default=None, alias="provider_usage")
    pricingVersion: Optional[str] = Field(default=None, alias="pricing_version")
    submittedAt: Optional[str] = Field(default=None, alias="submitted_at")
    finishedAt: Optional[str] = Field(default=None, alias="finished_at")

    class Config:
        populate_by_name = True

    def get_params(self) -> Dict[str, Any]:
        """构建 Provider 参数。

        v1 创建的任务把完整入参放在 requestSnapshot.params 中，优先使用它；
        旧接口创建的任务退回 prompt / imageUrl 两个 MVP 字段。
        """
        if self.params:
            return dict(self.params)

        snapshot_params = (
            self.requestSnapshot.get("params")
            if isinstance(self.requestSnapshot, dict)
            else None
        )
        params: Dict[str, Any] = (
            dict(snapshot_params) if isinstance(snapshot_params, dict) else {}
        )

        # MVP 字段作为兜底，不覆盖 v1 显式传入的同名参数。
        params.setdefault("prompt", self.prompt)
        if self.imageUrl and not params.get("image_url"):
            params["image_url"] = self.imageUrl

        return params


class TaskCreateRequest(BaseModel):
    # 对外测试接口使用的最小入参模型；实际执行链路优先读取 Backend 作业队列。
    capability: Capability
    profile: str
    params: Dict[str, Any]


class TaskStatusResponse(BaseModel):
    task_id: str
    status: JobStatus
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class ProviderTaskStatus(BaseModel):
    # Provider 返回的执行结果标准化后模型，当前依赖 status/result_url/usage。
    id: str
    status: str
    result_url: Optional[str] = None
    error_message: Optional[str] = None
    progress: Optional[int] = None
    usage: Optional[dict] = None  # {"completion_tokens": int, "total_tokens": int}
