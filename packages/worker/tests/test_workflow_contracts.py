import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import (  # noqa: E402
    GenerationRequest,
    GenerationSpec,
    MediaSpec,
    PromptSpec,
    UnifiedResult,
)
from providers.seedance_compiler import compile_seedance_request  # noqa: E402
from providers.minimax_compiler import compile_minimax_request  # noqa: E402
from providers.capabilities import get_capability_profile  # noqa: E402
from providers.seedance_adapter import SeedanceAdapter  # noqa: E402
from recovery import cost_status, format_cost, is_stale_job, should_resume_job  # noqa: E402
from comfyui_workflow import validate_dry_run_workflow  # noqa: E402


class WorkflowContractTests(unittest.TestCase):
    def test_reference_edit_ui_and_api_workflows_share_the_safe_node_contract(self):
        workflow_root = Path(__file__).resolve().parents[3] / "workflows"
        ui = json.loads(
            (workflow_root / "seedance-2.5-reference-edit-v1.comfy.json")
            .read_text(encoding="utf-8")
        )
        api = json.loads(
            (workflow_root / "seedance-2.5-reference-edit-v1.api.json")
            .read_text(encoding="utf-8")
        )

        validate_dry_run_workflow(ui)
        validate_dry_run_workflow(api)

        expected_types = {
            "SeedanceArkExecutionPolicy",
            "SeedanceArkMediaInput",
            "SeedanceArkMediaValidator",
            "SeedanceArkUploadImage",
            "SeedanceArkUploadVideo",
            "SeedanceArkReferenceEditRequestBuilder",
            "SeedanceArkReferenceEditRequestPreview",
            "SeedanceArkReferenceEditCreateTask",
            "SeedanceArkWaitTask",
            "SeedanceArkDownloadVideo",
            "SeedanceArkPreviewSaveVideo",
        }
        self.assertEqual({node["type"] for node in ui["nodes"]}, expected_types)
        self.assertEqual({node["class_type"] for node in api.values()}, expected_types)

        ui_nodes = {node["type"]: node for node in ui["nodes"]}
        api_nodes = {node["class_type"]: node for node in api.values()}
        self.assertEqual(
            ui_nodes["SeedanceArkExecutionPolicy"]["widgets_values"],
            ["preview", False],
        )
        self.assertEqual(
            api_nodes["SeedanceArkExecutionPolicy"]["inputs"],
            {"mode": "preview", "confirm_live_submission": False},
        )
        builder_inputs = api_nodes["SeedanceArkReferenceEditRequestBuilder"]["inputs"]
        self.assertEqual(builder_inputs["ratio"], "16:9")
        self.assertEqual(builder_inputs["duration"], 5)
        self.assertIs(builder_inputs["generate_audio"], False)
        self.assertNotIn("model", builder_inputs)
        self.assertNotIn("role", builder_inputs)
        for node in ui["nodes"]:
            self.assertNotIn("model", {item["name"] for item in node.get("inputs", [])})
            self.assertNotIn("role", {item["name"] for item in node.get("inputs", [])})
        for node in api.values():
            self.assertNotIn("model", node["inputs"])
            self.assertNotIn("role", node["inputs"])

        self.assertEqual(
            api_nodes["SeedanceArkUploadImage"]["inputs"]["image_path"], ["2", 0]
        )
        self.assertEqual(
            api_nodes["SeedanceArkUploadVideo"]["inputs"]["video_path"], ["2", 1]
        )
        self.assertEqual(
            api_nodes["SeedanceArkUploadImage"]["inputs"]["validation_json"], ["3", 0]
        )
        self.assertEqual(
            api_nodes["SeedanceArkUploadVideo"]["inputs"]["validation_json"], ["3", 0]
        )
        self.assertEqual(builder_inputs["reference_image"], ["4", 0])
        self.assertEqual(builder_inputs["reference_video"], ["5", 0])
        for node_type in (
            "SeedanceArkUploadImage",
            "SeedanceArkUploadVideo",
            "SeedanceArkReferenceEditRequestPreview",
            "SeedanceArkReferenceEditCreateTask",
            "SeedanceArkWaitTask",
            "SeedanceArkDownloadVideo",
            "SeedanceArkPreviewSaveVideo",
        ):
            self.assertEqual(api_nodes[node_type]["inputs"]["execution_policy"], ["1", 0])
        self.assertEqual(
            api_nodes["SeedanceArkReferenceEditRequestPreview"]["inputs"]["request_json"],
            ["6", 0],
        )
        self.assertEqual(
            api_nodes["SeedanceArkReferenceEditCreateTask"]["inputs"]["request_json"],
            ["7", 0],
        )
        create_inputs = api_nodes["SeedanceArkReferenceEditCreateTask"]["inputs"]
        self.assertIs(create_inputs["create_new_paid_version"], False)
        self.assertIs(create_inputs["confirm_new_paid_version"], False)
        create_ui_inputs = {
            item["name"]: item
            for item in ui_nodes["SeedanceArkReferenceEditCreateTask"]["inputs"]
        }
        self.assertIn("create_new_paid_version", create_ui_inputs)
        self.assertIn("confirm_new_paid_version", create_ui_inputs)
        self.assertEqual(api_nodes["SeedanceArkWaitTask"]["inputs"]["task_json"], ["8", 2])
        self.assertEqual(api_nodes["SeedanceArkDownloadVideo"]["inputs"]["task_json"], ["9", 0])
        save_inputs = api_nodes["SeedanceArkPreviewSaveVideo"]["inputs"]
        self.assertIn("metadata_prompt", save_inputs)
        self.assertNotIn("prompt", save_inputs)
        self.assertEqual(save_inputs["reference_image"], ["4", 0])
        self.assertEqual(save_inputs["reference_video"], ["5", 0])
        self.assertEqual(save_inputs["workflow_id"], "seedance-2.5-reference-edit-v1")
        self.assertEqual(save_inputs["workflow_version"], "1.0.0")
        save_ui_inputs = {
            item["name"]
            for item in ui_nodes["SeedanceArkPreviewSaveVideo"]["inputs"]
        }
        self.assertIn("metadata_prompt", save_ui_inputs)
        self.assertNotIn("prompt", save_ui_inputs)

    def test_running_job_with_provider_task_id_is_resumable(self):
        job = {
            "status": "running",
            "provider_task_id": "task-1",
            "submitted_at": "2026-09-01T10:00:00+00:00",
        }

        self.assertTrue(should_resume_job(job))

    def test_running_job_without_provider_task_id_is_not_resumable(self):
        job = {"status": "running", "provider_task_id": None}

        self.assertFalse(should_resume_job(job))

    def test_running_job_is_stale_after_timeout_window(self):
        now = datetime(2026, 9, 1, 10, 20, tzinfo=timezone.utc)
        job = {
            "status": "running",
            "submitted_at": (now - timedelta(minutes=11)).isoformat(),
        }

        self.assertTrue(is_stale_job(job, now=now, timeout_minutes=10))

    def test_actual_cost_rejects_missing_or_invalid_total_tokens(self):
        adapter = SeedanceAdapter.__new__(SeedanceAdapter)

        self.assertIsNone(adapter.calculate_actual_cost({}))
        self.assertIsNone(adapter.calculate_actual_cost({"total_tokens": "bad"}))
        self.assertEqual(adapter.calculate_actual_cost({"total_tokens": 1_000_000}), 70.0)
        self.assertEqual(adapter.pricing_version, "seedance-token-v1")

    def test_unknown_actual_cost_has_safe_log_representation(self):
        self.assertEqual(format_cost(None), "unknown")
        self.assertEqual(format_cost(7.625), "¥7.62")

    def test_cost_status_does_not_treat_missing_usage_as_actual(self):
        self.assertEqual(cost_status(None), "unavailable")
        self.assertEqual(cost_status({}), "unavailable")
        self.assertEqual(cost_status({"total_tokens": 1000}), "confirmed")

    def test_native_text_to_video_workflow_uses_valid_empty_media_json(self):
        workflow_path = (
            Path(__file__).resolve().parents[3]
            / "workflows"
            / "seedance-text-to-video-dry-run.comfy.json"
        )
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        request_builder = next(
            node for node in workflow["nodes"]
            if node["type"] == "SeedanceArkRequestBuilder"
        )

        # RequestBuilder has nine required widgets followed by optional
        # media_json.  Keep this position stable for ComfyUI native imports.
        media_json = request_builder["widgets_values"][9]
        self.assertEqual(json.loads(media_json), {})
        self.assertEqual(request_builder["widgets_values"][8], 1)

    def test_native_image_to_video_workflow_uses_first_frame_upload_chain(self):
        workflow_path = (
            Path(__file__).resolve().parents[3]
            / "workflows"
            / "seedance-image-to-video-first-frame-dry-run.comfy.json"
        )
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        nodes = {node["type"]: node for node in workflow["nodes"]}

        self.assertEqual(
            nodes["SeedanceArkMediaInput"]["outputs"][0]["name"],
            "image_path",
        )
        self.assertEqual(
            nodes["SeedanceArkUploadImage"]["inputs"][0]["name"],
            "image_path",
        )
        request_builder = nodes["SeedanceArkRequestBuilder"]
        self.assertEqual(request_builder["widgets_values"][8], 1)
        self.assertEqual(json.loads(request_builder["widgets_values"][9]), {})
        self.assertEqual(nodes["SeedanceArkExecutionPolicy"]["widgets_values"], ["preview", False])

        upload_link = next(
            link for link in workflow["links"]
            if link[3] == next(node["id"] for node in workflow["nodes"] if node["type"] == "SeedanceArkRequestBuilder")
            and link[4] == 11
        )
        upload_node_id = next(node["id"] for node in workflow["nodes"] if node["type"] == "SeedanceArkUploadImage")
        self.assertEqual(upload_link[1], upload_node_id)

    def test_native_image_to_video_workflow_is_accepted_as_dry_run(self):
        workflow_path = (
            Path(__file__).resolve().parents[3]
            / "workflows"
            / "seedance-image-to-video-first-frame-dry-run.comfy.json"
        )
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        validate_dry_run_workflow(workflow)

    def test_native_text_to_video_workflow_keeps_create_task_in_dry_run(self):
        workflow_path = (
            Path(__file__).resolve().parents[3]
            / "workflows"
            / "seedance-text-to-video-dry-run.comfy.json"
        )
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        create_task = next(
            node for node in workflow["nodes"]
            if node["type"] == "SeedanceArkCreateTask"
        )

        self.assertEqual(create_task["widgets_values"], [])

    def test_native_workflow_reserves_values_for_linked_inputs_on_comfyui_034(self):
        workflow_path = (
            Path(__file__).resolve().parents[3]
            / "workflows"
            / "seedance-text-to-video-dry-run.comfy.json"
        )
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        nodes = {node["type"]: node for node in workflow["nodes"]}

        # ComfyUI 0.34.2 keeps placeholder widget values for standard linked inputs.
        # Custom EXECUTION_POLICY links do not consume a widget placeholder.
        # The execution policy is now the single workflow-level safety control.
        self.assertEqual(nodes["SeedanceArkRequestPreview"]["widgets_values"], [])
        self.assertEqual(nodes["SeedanceArkCreateTask"]["widgets_values"], [])
        self.assertEqual(nodes["SeedanceArkWaitTask"]["widgets_values"], [])
        self.assertEqual(nodes["SeedanceArkDownloadVideo"]["widgets_values"], [])
        self.assertEqual(
            nodes["SeedanceArkPreviewSaveVideo"]["widgets_values"],
            ["", "", "0.1.0", "", "", "doubao-seedance-2-5-260628"],
        )
        policy = nodes["SeedanceArkExecutionPolicy"]
        self.assertEqual(policy["widgets_values"], ["preview", False])
        self.assertEqual(policy["outputs"][0]["links"], [8, 9, 10, 11, 12])

    def test_prompt_spec_preserves_positive_negative_shots_and_constraints(self):
        prompt = PromptSpec(
            positive="产品缓慢旋转",
            negative="不要改变产品结构",
            shots=[{"time": "0-5s", "description": "从正面转到侧面"}],
            constraints=["保持包装文字不变"],
        )

        self.assertEqual(prompt.to_dict()["positive"], "产品缓慢旋转")
        self.assertEqual(prompt.to_dict()["negative"], "不要改变产品结构")
        self.assertEqual(prompt.to_dict()["shots"][0]["time"], "0-5s")
        self.assertEqual(prompt.to_dict()["constraints"], ["保持包装文字不变"])

    def test_generation_request_serializes_provider_agnostic_shape(self):
        request = GenerationRequest(
            capability="TEXT_TO_VIDEO",
            prompt=PromptSpec(positive="一只猫在草地上奔跑"),
            generation=GenerationSpec(duration=5, ratio="16:9", resolution="720p"),
            provider={"name": "seedance", "model": "doubao-seedance-2-0-260128"},
        )

        payload = request.to_dict()

        self.assertEqual(payload["capability"], "TEXT_TO_VIDEO")
        self.assertNotIn("content", payload)
        self.assertEqual(payload["provider"]["name"], "seedance")
        self.assertTrue(payload["execution"]["dry_run"])

    def test_seedance_compiler_maps_prompt_spec_to_ark_content(self):
        request = GenerationRequest(
            capability="TEXT_TO_VIDEO",
            prompt=PromptSpec(
                positive="产品缓慢旋转",
                negative="不要改变产品结构",
                constraints=["保持包装文字不变"],
            ),
            generation=GenerationSpec(duration=5, ratio="16:9", resolution="720p"),
            provider={"name": "seedance", "model": "doubao-seedance-2-0-260128"},
        )

        compiled = compile_seedance_request(request)

        self.assertEqual(compiled["model"], "doubao-seedance-2-0-260128")
        self.assertEqual(compiled["content"][0]["type"], "text")
        self.assertIn("产品缓慢旋转", compiled["content"][0]["text"])
        self.assertIn("不要改变产品结构", compiled["content"][0]["text"])
        self.assertEqual(compiled["duration"], 5)
        self.assertEqual(compiled["ratio"], "16:9")

    def test_seedance_compiler_rejects_unsupported_duration_for_seedance_2(self):
        request = GenerationRequest(
            capability="TEXT_TO_VIDEO",
            prompt=PromptSpec(positive="产品旋转"),
            generation=GenerationSpec(duration=30),
            provider={"name": "seedance", "model": "doubao-seedance-2-0-260128"},
        )

        with self.assertRaisesRegex(ValueError, "duration"):
            compile_seedance_request(request)

    def test_minimax_compiler_maps_first_frame_to_minimax_field(self):
        request = GenerationRequest(
            capability="IMAGE_TO_VIDEO",
            prompt=PromptSpec(positive="产品缓慢旋转"),
            generation=GenerationSpec(duration=6, resolution="1080P"),
            media=[MediaSpec(
                media_type="image",
                role="first_frame",
                source={"kind": "public_url", "value": "https://image"},
            )],
            provider={"name": "minimax", "model": "MiniMax-Hailuo-2.3"},
        )

        compiled = compile_minimax_request(request)

        self.assertEqual(compiled["model"], "MiniMax-Hailuo-2.3")
        self.assertEqual(compiled["first_frame_image"], "https://image")
        self.assertEqual(compiled["duration"], 6)
        self.assertEqual(compiled["resolution"], "1080P")

    def test_minimax_compiler_requires_first_frame_for_image_to_video(self):
        request = GenerationRequest(
            capability="IMAGE_TO_VIDEO",
            prompt=PromptSpec(positive="产品旋转"),
            provider={"name": "minimax", "model": "MiniMax-Hailuo-2.3"},
        )

        with self.assertRaisesRegex(ValueError, "first_frame"):
            compile_minimax_request(request)

    def test_media_spec_requires_known_role_and_serializes_source(self):
        media = MediaSpec(
            media_type="image",
            role="first_frame",
            source={"kind": "local_path", "value": "product.png"},
        )

        self.assertEqual(media.to_dict(), {
            "type": "image",
            "role": "first_frame",
            "source": {"kind": "local_path", "value": "product.png"},
        })

    def test_unified_result_supports_multiple_output_types(self):
        result = UnifiedResult(
            provider_task_id="task-1",
            status="succeeded",
            outputs=[
                {"type": "video", "url": "https://video"},
                {"type": "image", "role": "last_frame", "url": "https://frame"},
            ],
        )

        payload = json.loads(json.dumps(result.to_dict(), ensure_ascii=False))
        self.assertEqual(len(payload["outputs"]), 2)
        self.assertEqual(payload["outputs"][1]["role"], "last_frame")

    def test_capability_profile_does_not_claim_unverified_seedance_25_support(self):
        profile = get_capability_profile("seedance", "doubao-seedance-2-5-260628")

        self.assertEqual(profile["status"], "pending")
        self.assertEqual(profile["capabilities"]["text_to_video"], "pending")

    def test_capability_profile_contains_confirmed_seedance_2_duration_boundary(self):
        profile = get_capability_profile("seedance", "doubao-seedance-2-0-260128")

        self.assertEqual(profile["capabilities"]["text_to_video"], "confirmed")
        self.assertEqual(profile["limits"]["duration_seconds"], {"min": 4, "max": 15})


if __name__ == "__main__":
    unittest.main()
