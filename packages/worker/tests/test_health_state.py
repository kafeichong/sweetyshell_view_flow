import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from health_state import HealthState  # noqa: E402

BASE = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)


def at(seconds: int) -> datetime:
    return BASE + timedelta(seconds=seconds)


class HealthStateTests(unittest.TestCase):
    def test_fresh_start_is_not_ready(self):
        state = HealthState()

        snapshot = state.snapshot(now=BASE)

        # 循环还没跑起来就不能报 ready：进程活着不等于工作正常。
        self.assertFalse(snapshot["ready"])
        self.assertFalse(snapshot["loopAlive"])

    def test_running_idle_loop_is_ready(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)

        snapshot = state.snapshot(now=at(30))

        self.assertTrue(snapshot["ready"])
        self.assertTrue(snapshot["loopAlive"])

    def test_long_generation_with_healthy_polling_stays_ready(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)
        state.task_started("task-1", now=BASE)

        # 40 分钟的长生成，只要轮询正常推进就仍然健康。
        for seconds in range(0, 2400, 60):
            state.mark_loop_tick(now=at(seconds))
            state.mark_provider_poll_ok(now=at(seconds))

        snapshot = state.snapshot(now=at(2400))

        self.assertTrue(snapshot["ready"])
        self.assertEqual(snapshot["activeTaskId"], "task-1")
        self.assertEqual(snapshot["activeTaskAgeSeconds"], 2400)

    def test_stalled_task_polling_is_not_hidden_by_loop_ticks(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)
        state.task_started("task-1", now=BASE)
        state.mark_provider_poll_ok(now=BASE)

        # 主循环照常每秒推进，但任务早已不再有成功的轮询。
        for seconds in range(1, 600, 10):
            state.mark_loop_tick(now=at(seconds))

        snapshot = state.snapshot(now=at(600))

        self.assertFalse(snapshot["ready"])
        self.assertTrue(snapshot["loopAlive"])
        self.assertIn("active task provider polling stalled", snapshot["reasons"])

    def test_crashed_loop_is_not_ready_even_with_fresh_timestamps(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)
        state.mark_loop_tick(now=at(599))
        state.mark_backend_ok(now=at(599))
        state.mark_loop_stopped("poll loop crashed: RuntimeError", now=at(599))

        snapshot = state.snapshot(now=at(600))

        self.assertFalse(snapshot["ready"])
        self.assertFalse(snapshot["loopAlive"])
        self.assertIn("RuntimeError", " ".join(snapshot["reasons"]))

    def test_stale_loop_tick_is_not_ready(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)

        snapshot = state.snapshot(now=at(600))

        self.assertFalse(snapshot["ready"])
        self.assertIn("poll loop has not advanced recently", snapshot["reasons"])

    def test_finished_task_clears_active_state(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)
        state.task_started("task-1", now=BASE)
        state.mark_provider_poll_ok(now=BASE)

        state.task_finished("task-1")
        for seconds in range(1, 120, 10):
            state.mark_loop_tick(now=at(seconds))

        snapshot = state.snapshot(now=at(120))

        # 任务结束后不再用它的轮询时间判定健康。
        self.assertTrue(snapshot["ready"])
        self.assertIsNone(snapshot["activeTaskId"])

    def test_finishing_another_task_does_not_clear_the_active_one(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)
        state.task_started("task-new", now=BASE)

        state.task_finished("task-old")

        self.assertEqual(state.snapshot(now=at(10))["activeTaskId"], "task-new")

    def test_snapshot_exposes_only_health_fields(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)
        state.mark_backend_ok(now=BASE)
        state.mark_provider_poll_ok(now=BASE)

        snapshot = state.snapshot(admission_paused=True, now=at(10))

        # /ready 是内部端点，但也不该顺手把配置或凭证带出去。
        self.assertEqual(
            set(snapshot),
            {
                "ready",
                "loopAlive",
                "backendLastOkAt",
                "backendLastError",
                "providerPollLastOkAt",
                "activeTaskId",
                "activeTaskAgeSeconds",
                "admissionPaused",
                "lastLoopTickAt",
                "reasons",
            },
        )
        self.assertTrue(snapshot["admissionPaused"])
        self.assertIsNotNone(snapshot["backendLastOkAt"])

    def test_backend_error_is_reported_until_the_next_success(self):
        state = HealthState()
        state.mark_loop_started(now=BASE)

        state.mark_backend_error("connection refused")
        self.assertEqual(state.snapshot(now=at(5))["backendLastError"], "connection refused")

        state.mark_backend_ok(now=at(10))
        self.assertIsNone(state.snapshot(now=at(10))["backendLastError"])


if __name__ == "__main__":
    unittest.main()
