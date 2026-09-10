import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from comfyui_workflow import (  # noqa: E402
    ComfyUIWorkflowError,
    extract_history_outputs,
    load_workflow,
    validate_api_workflow,
    validate_dry_run_workflow,
)

WORKFLOWS_DIR = Path(__file__).resolve().parents[3] / "workflows"
# 这些测试校验的是 ComfyUI 导出的 workflow JSON（仓库外部资产）。
# 文件缺失时显式跳过，而不是把"资产缺失"伪装成代码回归。
requires_reviewed_workflows = unittest.skipUnless(
    WORKFLOWS_DIR.is_dir(),
    f"reviewed ComfyUI workflow exports are missing under {WORKFLOWS_DIR}",
)


WORKFLOW_PATH = Path(__file__).resolve().parents[3] / "workflows" / "seedance-text-to-video-dry-run.comfy.json"
API_WORKFLOW_PATH = Path(__file__).resolve().parents[3] / "workflows" / "seedance-text-to-video-dry-run.api.json"
AUTHORIZED_PORTRAIT_WORKFLOW_PATH = (
    Path(__file__).resolve().parents[3]
    / "workflows"
    / "seedance-2.0-authorized-portrait-dry-run.comfy.json"
)
AUTHORIZED_PORTRAIT_API_WORKFLOW_PATH = (
    Path(__file__).resolve().parents[3]
    / "workflows"
    / "seedance-2.0-authorized-portrait-dry-run.api.json"
)
FIRST_LAST_FRAME_WORKFLOW_PATH = (
    Path(__file__).resolve().parents[3]
    / "workflows"
    / "seedance-2.5-first-last-frame-structured-v1.comfy.json"
)
FIRST_LAST_FRAME_API_WORKFLOW_PATH = (
    Path(__file__).resolve().parents[3]
    / "workflows"
    / "seedance-2.5-first-last-frame-structured-v1.api.json"
)


class ComfyUIWorkflowTests(unittest.TestCase):
    @requires_reviewed_workflows
    def test_repository_workflow_is_accepted_as_dry_run(self):
        workflow = load_workflow(WORKFLOW_PATH)
        validate_dry_run_workflow(workflow)

    @requires_reviewed_workflows
    def test_repository_api_workflow_is_accepted_as_dry_run(self):
        workflow = load_workflow(API_WORKFLOW_PATH)
        validate_dry_run_workflow(workflow)

        self.assertEqual(workflow["1"]["class_type"], "SeedanceArkPromptBuilder")
        self.assertIn("inputs", workflow["1"])

    @requires_reviewed_workflows
    def test_first_last_frame_structured_workflows_are_accepted(self):
        # UI-format graph validates as a dry run and exposes the structured builder.
        ui_workflow = load_workflow(FIRST_LAST_FRAME_WORKFLOW_PATH)
        validate_dry_run_workflow(ui_workflow)
        builder = next(
            node
            for node in ui_workflow["nodes"]
            if node["type"] == "SeedanceArkFirstLastFrameStructuredRequestBuilder"
        )
        input_names = {item["name"] for item in builder["inputs"]}
        self.assertTrue({"positive", "negative", "shots"}.issubset(input_names))
        self.assertTrue({"first_frame_image", "last_frame_image"}.issubset(input_names))
        self.assertEqual(builder["widgets_values"][3], 5)
        self.assertIs(builder["widgets_values"][4], False)

        # API-format graph passes the stricter executor validator too.
        api_workflow = load_workflow(FIRST_LAST_FRAME_API_WORKFLOW_PATH)
        validate_api_workflow(api_workflow)
        builder_inputs = api_workflow["8"]["inputs"]
        self.assertIn("positive", builder_inputs)
        self.assertIn("negative", builder_inputs)
        self.assertIn("shots", builder_inputs)

    @requires_reviewed_workflows
    def test_first_last_frame_workflow_rejects_invalid_safety_flags_and_duplicate_hard_nodes(self):
        api_workflow = load_workflow(FIRST_LAST_FRAME_API_WORKFLOW_PATH)
        api_workflow["1"]["inputs"]["mode"] = "live"
        with self.assertRaises(ComfyUIWorkflowError):
            validate_api_workflow(api_workflow)

        # A non-repeatable node type must still not appear twice.
        dup_workflow = load_workflow(FIRST_LAST_FRAME_API_WORKFLOW_PATH)
        dup_workflow["99"] = dict(dup_workflow["10"])
        with self.assertRaisesRegex(ComfyUIWorkflowError, "duplicate node type"):
            validate_api_workflow(dup_workflow)

    @requires_reviewed_workflows
    def test_authorized_portrait_workflows_are_safe_and_use_a_blank_trusted_asset_slot(self):
        ui_workflow = load_workflow(AUTHORIZED_PORTRAIT_WORKFLOW_PATH)
        validate_dry_run_workflow(ui_workflow)
        request_builder = next(
            node
            for node in ui_workflow["nodes"]
            if node["type"] == "SeedanceArkRequestBuilder"
        )
        self.assertEqual(request_builder["widgets_values"][1], "doubao-seedance-2-0-260128")
        # ComfyUI preserves a legacy boolean widget slot before output_count.
        # Without it, media_json ("{}") shifts into output_count and execution
        # fails before the request preview node can run.
        self.assertIs(request_builder["widgets_values"][8], False)
        self.assertEqual(request_builder["widgets_values"][9], 1)
        self.assertEqual(request_builder["widgets_values"][10], "{}")
        self.assertIn(
            "③ 粘贴已授权人像 Asset ID",
            request_builder["title"],
        )

        api_workflow = load_workflow(AUTHORIZED_PORTRAIT_API_WORKFLOW_PATH)
        validate_dry_run_workflow(api_workflow)
        request_inputs = api_workflow["2"]["inputs"]
        self.assertEqual(request_inputs["model"], "doubao-seedance-2-0-260128")
        self.assertEqual(request_inputs["reference_image_url"], "")
        self.assertEqual(request_inputs["reference_video_url"], "")

    @requires_reviewed_workflows
    def test_api_execution_policy_link_requires_existing_policy_node(self):
        for link in (("missing", 0), ("1", 0)):
            with self.subTest(link=link):
                workflow = load_workflow(API_WORKFLOW_PATH)
                workflow["4"]["inputs"]["execution_policy"] = list(link)
                with self.assertRaisesRegex(ComfyUIWorkflowError, "execution_policy"):
                    validate_dry_run_workflow(workflow)

    def test_api_workflow_requires_node_map_class_type_and_inputs(self):
        invalid_workflows = (
            {"nodes": []},
            {"1": {"inputs": {}}},
            {"1": {"class_type": "SeedanceArkPromptBuilder"}},
        )
        for workflow in invalid_workflows:
            with self.subTest(workflow=workflow), self.assertRaises(ComfyUIWorkflowError):
                validate_dry_run_workflow(workflow)

    def test_load_workflow_rejects_malformed_json_and_non_object(self):
        with tempfile.TemporaryDirectory() as directory:
            malformed = Path(directory) / "bad.json"
            malformed.write_text("{", encoding="utf-8")
            with self.assertRaises(ComfyUIWorkflowError):
                load_workflow(malformed)

            array = Path(directory) / "array.json"
            array.write_text("[]", encoding="utf-8")
            with self.assertRaises(ComfyUIWorkflowError):
                load_workflow(array)

    @requires_reviewed_workflows
    def test_invalid_safety_flags_are_rejected(self):
        workflow = load_workflow(WORKFLOW_PATH)
        policy = next(node for node in workflow["nodes"] if node["type"] == "SeedanceArkExecutionPolicy")
        policy["widgets_values"][0] = "live"
        with self.assertRaises(ComfyUIWorkflowError):
            validate_dry_run_workflow(workflow)

        workflow = load_workflow(WORKFLOW_PATH)
        policy = next(node for node in workflow["nodes"] if node["type"] == "SeedanceArkExecutionPolicy")
        policy["widgets_values"][1] = True
        with self.assertRaises(ComfyUIWorkflowError):
            validate_dry_run_workflow(workflow)

    @requires_reviewed_workflows
    def test_create_task_cannot_add_overridable_safety_values(self):
        workflow = load_workflow(WORKFLOW_PATH)
        create_task = next(node for node in workflow["nodes"] if node["type"] == "SeedanceArkCreateTask")
        create_task["widgets_values"] = [True, True]
        with self.assertRaises(ComfyUIWorkflowError):
            validate_dry_run_workflow(workflow)

    @requires_reviewed_workflows
    def test_missing_required_node_is_rejected(self):
        workflow = load_workflow(WORKFLOW_PATH)
        workflow["nodes"] = [node for node in workflow["nodes"] if node["type"] != "SeedanceArkCreateTask"]
        with self.assertRaisesRegex(ComfyUIWorkflowError, "CreateTask"):
            validate_dry_run_workflow(workflow)

    def test_history_extracts_file_metadata_only(self):
        history = {
            "prompt-1": {
                "outputs": {
                    "7": {
                        "videos": [{"filename": "clip.mp4", "subfolder": "", "type": "output", "cost": 99}],
                        "images": [{"filename": "poster.png", "subfolder": "preview", "type": "temp"}],
                    }
                }
            }
        }
        result = extract_history_outputs(history)
        self.assertEqual(sorted(result, key=lambda item: item["filename"]), [
            {"filename": "clip.mp4", "subfolder": "", "type": "output"},
            {"filename": "poster.png", "subfolder": "preview", "type": "temp"},
        ])
        self.assertNotIn("cost", result[0])

    def test_history_rejects_malformed_output_metadata(self):
        cases = (
            {"outputs": []},
            {"outputs": "invalid"},
            {"prompt-1": {"outputs": []}},
            {"prompt-1": {"outputs": {"7": {"videos": {}}}}},
            {"prompt-1": {"outputs": {"7": {"videos": [{"filename": "clip.mp4"}]}}}},
        )
        for history in cases:
            with self.subTest(history=history), self.assertRaises(ComfyUIWorkflowError):
                extract_history_outputs(history)


if __name__ == "__main__":
    unittest.main()
