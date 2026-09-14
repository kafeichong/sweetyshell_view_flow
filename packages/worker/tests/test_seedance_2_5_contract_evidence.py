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
