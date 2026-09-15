import json
from pathlib import Path


FIXTURE = Path(__file__).parent / "fixtures" / "seedance_2_5_reference_edit_official.json"


def test_official_reference_edit_fixture_is_redacted_and_has_the_documented_shape():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    request = fixture["request"]

    assert fixture["source"] == "official-quickstart-shape"
    assert request["model"] == "doubao-seedance-2-5-260628"
    assert request["ratio"] == "adaptive"
    assert request["duration"] == -1
    assert request["generate_audio"] is True
    assert request["watermark"] is True
    assert request["content"][0]["type"] == "text"
    assert [(item["type"], item["role"]) for item in request["content"][1:]] == [
        ("image_url", "reference_image"),
        ("video_url", "reference_video"),
    ]
    assert request["content"][1]["image_url"]["url"].startswith("https://example.invalid/")
    assert request["content"][2]["video_url"]["url"].startswith("https://example.invalid/")
    assert fixture["createResponse"] == {"id": "fixture-task-id"}
    assert fixture["terminalResponseShape"]["content"] == {
        "video_url": "https://example.invalid/result.mp4"
    }


OFFICIAL_MODES_FIXTURE = Path(__file__).parent / "fixtures" / "seedance_2_5_official_modes.json"


def test_steven_provided_official_modes_have_only_documented_contract_fields():
    fixture = json.loads(OFFICIAL_MODES_FIXTURE.read_text(encoding="utf-8"))
    modes = fixture["modes"]

    assert fixture["source"] == "steven-provided-official-ark-examples"
    assert fixture["model"] == "doubao-seedance-2-5-260628"
    assert modes["textToVideo"]["content"] == [{"type": "text", "text": "生成一段四秒视频"}]
    assert modes["textToVideo"]["duration"] == 4
    assert modes["referenceImage"]["content"][1]["role"] == "reference_image"
    assert modes["referenceImage"]["ratio"] == "16:9"
    assert modes["referenceImage"]["duration"] == 30
    assert modes["omniReference"]["omni_reference_task_type"] == "reference"
    assert modes["omniReference"]["output_format"] == "mov"
    assert modes["videoEdit"]["ratio"] == "adaptive"
    assert modes["videoEdit"]["duration"] == -1
    assert modes["videoEdit"]["omni_reference_task_type"] == "edit"
    assert modes["videoExtend"]["duration"] == 11
    assert modes["videoExtend"]["omni_reference_task_type"] == "extend"
    assert modes["firstLastFrame"]["contentRoles"] == [
        ["image_url", "first_frame"],
        ["image_url", "last_frame"],
    ]
    assert modes["firstFrame"]["contentRoles"] == [["image_url", "first_frame"]]
    assert modes["audioReference"]["contentRoles"] == [["audio_url", "reference_audio"]]
    assert modes["audioReference"]["omni_reference_task_type"] == "reference"
