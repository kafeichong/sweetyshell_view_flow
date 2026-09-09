import json
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recovery import build_cost_audit  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
