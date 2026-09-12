import json
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recovery import build_cost_audit, build_provider_outcome  # noqa: E402
from submission_journal import sanitize_usage  # noqa: E402
from providers.seedance_adapter import SeedanceAdapter  # noqa: E402


class CostAuditTests(unittest.TestCase):
    def test_confirmed_usage_builds_actual_cost_audit(self):
        usage = json.loads(
            (Path(__file__).parent / "fixtures" / "provider_usage_confirmed.json")
            .read_text(encoding="utf-8")
        )
        adapter = SeedanceAdapter.__new__(SeedanceAdapter)
        actual_cost = adapter.calculate_actual_cost(usage)

        self.assertEqual(
            build_cost_audit(
                usage,
                actual_cost=actual_cost,
                pricing_version=adapter.pricing_version,
            ),
            {
                "actual_cost": 0.07,
                "cost_status": "confirmed",
                "provider_usage": usage,
                "pricing_version": "seedance-token-v1",
            },
        )

    def test_missing_usage_builds_unavailable_cost_audit(self):
        usage = json.loads(
            (Path(__file__).parent / "fixtures" / "provider_usage_missing.json")
            .read_text(encoding="utf-8")
        )

        self.assertEqual(
            build_cost_audit(usage, actual_cost=None, pricing_version="seedance-token-v1"),
            {
                "actual_cost": None,
                "cost_status": "unavailable",
                "provider_usage": None,
                "pricing_version": None,
            },
        )


class ProviderOutcomePayloadTests(unittest.TestCase):
    """终态回写只带原始事实：金额一律由 Backend 核算，Worker 不参与定价。"""

    def test_payload_carries_only_provider_facts(self):
        payload = build_provider_outcome(
            "succeeded",
            {"total_tokens": 1000},
            provider_task_id="provider-1",
        )

        self.assertEqual(
            payload,
            {
                "status": "succeeded",
                "providerTaskId": "provider-1",
                "usage": {"total_tokens": 1000},
            },
        )

    def test_payload_never_includes_money_or_pricing(self):
        payload = build_provider_outcome(
            "succeeded",
            {"total_tokens": 1000},
            provider_task_id="provider-1",
            error_code="CONTENT_POLICY",
        )

        for forbidden in (
            "actualCostCny",
            "cost",
            "costStatus",
            "pricingVersion",
            "estimatedCostCny",
            "unitPrice",
            "reserveCny",
        ):
            self.assertNotIn(forbidden, payload)

    def test_payload_keeps_failed_status_evidence(self):
        payload = build_provider_outcome("failed", None, error_code="Task failed: policy")

        self.assertEqual(payload, {"status": "failed", "errorCode": "Task failed: policy"})
        # 没有 usage 时不伪造金额字段，让 Backend 走"保留预占 + 人工核查"。
        self.assertNotIn("usage", payload)

    def test_payload_copies_usage_instead_of_aliasing_caller_dict(self):
        usage = {"total_tokens": 10}
        payload = build_provider_outcome("succeeded", usage)
        payload["usage"]["total_tokens"] = 999

        self.assertEqual(usage["total_tokens"], 10)


class UsageSanitizingTests(unittest.TestCase):
    """journal 只能留下可核对的整数 token 计数，其余字段一律丢弃。"""

    def test_keeps_only_integer_token_fields(self):
        self.assertEqual(
            sanitize_usage(
                {
                    "total_tokens": 1000,
                    "completion_tokens": 880,
                    "prompt_tokens": 120,
                    "video_url": "https://provider.test/v.mp4",
                    "prompt": "product",
                }
            ),
            {"total_tokens": 1000, "completion_tokens": 880, "prompt_tokens": 120},
        )

    def test_drops_non_integer_and_negative_counts(self):
        self.assertEqual(
            sanitize_usage({"total_tokens": 1.5, "prompt_tokens": -1}),
            None,
        )
        self.assertEqual(sanitize_usage({"total_tokens": True}), None)

    def test_non_mapping_usage_is_dropped(self):
        for value in (None, "1000", [1, 2], 1000):
            self.assertIsNone(sanitize_usage(value))


if __name__ == "__main__":
    unittest.main()
