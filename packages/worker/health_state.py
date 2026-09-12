"""Worker 存活判定：心跳与实际执行进展必须分开。

最容易骗过监控的做法，是让某个后台线程每秒更新一次时间戳，于是"进程还在"
被当成"工作正常"。这里把三件事分开记录：

- 主循环是否还在跑（loopAlive）：循环退出或有未捕获异常即置 false；
- 主循环最近一次推进（lastLoopTickAt）：停滞同样判不健康；
- 当前活跃任务最近一次 Provider 轮询是否成功（providerPollLastOkAt）：
  有任务在跑但轮询长时间没成功，说明卡住了，不能靠循环心跳掩盖。

反过来，一个正常轮询中的长生成任务（几十分钟）应当被视为存活——不能因为
"任务还没结束"就报不健康。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from audit_log import strip_url_secrets

# 判定"最近"的默认窗口：主循环 2 分钟没有推进就算停摆（轮询间隔通常为秒级）。
DEFAULT_STALE_AFTER_SECONDS = 120.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    return moment.isoformat() if moment else None


def _age_seconds(moment: Optional[datetime], now: datetime) -> Optional[float]:
    if moment is None:
        return None
    return (now - moment).total_seconds()


class HealthState:
    """进程内的健康状态机；/ready 只读它，不自己编造健康。"""

    def __init__(self, *, stale_after_seconds: float = DEFAULT_STALE_AFTER_SECONDS):
        self.stale_after_seconds = max(1.0, float(stale_after_seconds))
        self.loop_alive = False
        self.loop_exit_reason: Optional[str] = None
        self.last_loop_tick_at: Optional[datetime] = None
        self.backend_last_ok_at: Optional[datetime] = None
        self.backend_last_error: Optional[str] = None
        self.provider_poll_last_ok_at: Optional[datetime] = None
        self.active_task_id: Optional[str] = None
        self.active_task_started_at: Optional[datetime] = None

    # ---- 主循环 ----
    def mark_loop_started(self, now: Optional[datetime] = None) -> None:
        self.loop_alive = True
        self.loop_exit_reason = None
        self.last_loop_tick_at = now or _now()

    def mark_loop_tick(self, now: Optional[datetime] = None) -> None:
        self.last_loop_tick_at = now or _now()

    def mark_loop_stopped(self, reason: str = "stopped", now: Optional[datetime] = None) -> None:
        """循环退出（正常取消或未捕获异常）：即使时间戳还在更新也不再 ready。"""
        self.loop_alive = False
        self.loop_exit_reason = reason
        self.active_task_id = None

    # ---- Backend 通信 ----
    def mark_backend_ok(self, now: Optional[datetime] = None) -> None:
        self.backend_last_ok_at = now or _now()
        self.backend_last_error = None

    def mark_backend_error(self, error: str) -> None:
        self.backend_last_error = error

    # ---- 任务执行进展 ----
    def task_started(self, task_id: str, now: Optional[datetime] = None) -> None:
        self.active_task_id = task_id
        self.active_task_started_at = now or _now()

    def task_finished(self, task_id: Optional[str] = None) -> None:
        # 只有当前活跃任务才能被清空：并发收尾不会把新任务的状态抹掉。
        if task_id is not None and self.active_task_id != task_id:
            return
        self.active_task_id = None
        self.active_task_started_at = None

    def mark_provider_poll_ok(self, now: Optional[datetime] = None) -> None:
        self.provider_poll_last_ok_at = now or _now()

    # ---- 对外快照 ----
    def snapshot(self, *, admission_paused: bool = False, now: Optional[datetime] = None) -> Dict[str, Any]:
        moment = now or _now()
        loop_stale = _age_seconds(self.last_loop_tick_at, moment)
        poll_stale = _age_seconds(self.provider_poll_last_ok_at, moment)

        loop_alive = bool(self.loop_alive) and loop_stale is not None and loop_stale <= self.stale_after_seconds

        # 有活跃任务时以 Provider 轮询为准：循环还在转不代表任务在推进。
        if loop_alive and self.active_task_id is not None:
            execution_alive = poll_stale is not None and poll_stale <= self.stale_after_seconds
        else:
            execution_alive = loop_alive

        reasons = []
        if not self.loop_alive:
            reasons.append(self.loop_exit_reason or "poll loop is not running")
        elif loop_stale is None or loop_stale > self.stale_after_seconds:
            reasons.append("poll loop has not advanced recently")
        if self.active_task_id is not None and not execution_alive:
            reasons.append("active task provider polling stalled")

        ready = loop_alive and execution_alive

        return {
            "ready": ready,
            "loopAlive": loop_alive,
            "backendLastOkAt": _iso(self.backend_last_ok_at),
            # 错误原文可能嵌着带签名的 URL：探针也要脱敏后再输出。
            "backendLastError": (
                strip_url_secrets(self.backend_last_error) if self.backend_last_error else None
            ),
            "providerPollLastOkAt": _iso(self.provider_poll_last_ok_at),
            "activeTaskId": self.active_task_id,
            "activeTaskAgeSeconds": _age_seconds(self.active_task_started_at, moment),
            "admissionPaused": admission_paused,
            "lastLoopTickAt": _iso(self.last_loop_tick_at),
            "reasons": reasons,
        }
