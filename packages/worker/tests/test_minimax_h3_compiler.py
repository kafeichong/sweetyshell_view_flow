import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import GenerationRequest, GenerationSpec, MediaSpec, PromptSpec  # noqa: E402
from providers.minimax_compiler import (  # noqa: E402
    MINIMAX_H3_MODEL,
    compile_minimax_h3_request,
)


def _img(role: str, url: str = "https://cdn.example.com/img.png") -> MediaSpec:
    return MediaSpec(
        media_type="image",
        role=role,
        source={"kind": "public_url", "value": url},
    )


def _video(url: str = "https://cdn.example.com/clip.mp4") -> MediaSpec:
    return MediaSpec(
        media_type="video",
        role="reference_video",
        source={"kind": "public_url", "value": url},
    )


def _audio(url: str = "https://cdn.example.com/sound.mp3") -> MediaSpec:
    return MediaSpec(
        media_type="audio",
        role="reference_audio",
        source={"kind": "public_url", "value": url},
    )


def _request(
    media=(),
    ratio="16:9",
    duration=5,
    resolution="2K",
    prompt="素材图1 中的人物执行视频1 的动作，保持人物外观一致",
    watermark=False,
) -> GenerationRequest:
    return GenerationRequest(
        capability="REFERENCE_TO_VIDEO",
        prompt=PromptSpec(positive=prompt),
        generation=GenerationSpec(
            duration=duration,
            ratio=ratio,
            resolution=resolution,
            watermark=watermark,
        ),
        media=list(media),
        provider={"name": "minimax", "model": MINIMAX_H3_MODEL},
    )


class MiniMaxH3CompilerTests(unittest.TestCase):
    def test_t2v_payload_shape(self):
        compiled = compile_minimax_h3_request(_request(media=(), ratio="16:9"))

        self.assertEqual(compiled["model"], MINIMAX_H3_MODEL)
        self.assertEqual(compiled["resolution"], "2K")
        self.assertEqual(compiled["duration"], 5)
        self.assertEqual(compiled["ratio"], "16:9")
        self.assertEqual(compiled["content"][0]["type"], "text")
        self.assertIn("视频1 的动作", compiled["content"][0]["text"])
        self.assertEqual(len(compiled["content"]), 1)
        self.assertNotIn("aigc_watermark", compiled)

    def test_t2v_rejects_adaptive_ratio(self):
        with self.assertRaisesRegex(ValueError, "adaptive"):
            compile_minimax_h3_request(_request(media=(), ratio="adaptive"))

    def test_i2v_first_frame_single_maps_role_and_adaptive_ratio(self):
        compiled = compile_minimax_h3_request(
            _request(media=[_img("first_frame", url="https://cdn.example.com/frame.png")])
        )

        self.assertEqual(compiled["ratio"], "adaptive")
        image_item = compiled["content"][1]
        self.assertEqual(image_item["type"], "image_url")
        self.assertEqual(image_item["role"], "first_frame")
        self.assertEqual(image_item["image_url"]["url"], "https://cdn.example.com/frame.png")

    def test_fl2v_first_and_last_frames(self):
        compiled = compile_minimax_h3_request(
            _request(media=[
                _img("first_frame", url="https://cdn.example.com/start.png"),
                _img("last_frame", url="https://cdn.example.com/end.png"),
            ])
        )

        roles = [item.get("role") for item in compiled["content"] if item["type"] != "text"]
        self.assertEqual(roles, ["first_frame", "last_frame"])
        self.assertEqual(compiled["ratio"], "adaptive")

    def test_r2v_image_plus_video_merge_is_the_image_video_workflow(self):
        """素材图 + 已有视频 → 合成一条新视频：图给身份、视频给动作。"""
        compiled = compile_minimax_h3_request(
            _request(media=[
                _img("subject_reference", url="https://cdn.example.com/talent.png"),
                _video("https://cdn.example.com/existing-motion.mp4"),
            ])
        )

        non_text = [item for item in compiled["content"] if item["type"] != "text"]
        self.assertEqual(len(non_text), 2)
        self.assertEqual(non_text[0]["type"], "image_url")
        self.assertEqual(non_text[0]["role"], "reference_image")
        self.assertEqual(non_text[1]["type"], "video_url")
        self.assertEqual(non_text[1]["role"], "reference_video")
        # r2va honors an explicit valid ratio (GenerationSpec default 16:9)…
        self.assertEqual(compiled["ratio"], "16:9")

    def test_r2v_defaults_to_adaptive_when_ratio_is_adaptive(self):
        compiled = compile_minimax_h3_request(
            _request(
                media=[_img("subject_reference"), _video()],
                ratio="adaptive",
            )
        )
        self.assertEqual(compiled["ratio"], "adaptive")

    def test_r2v_image_video_audio_combination(self):
        compiled = compile_minimax_h3_request(
            _request(media=[
                _img("reference_image", url="https://cdn.example.com/product.png"),
                _video("https://cdn.example.com/motion.mp4"),
                _audio("https://cdn.example.com/voice.mp3"),
            ])
        )

        types = [item["type"] for item in compiled["content"] if item["type"] != "text"]
        self.assertEqual(types, ["image_url", "video_url", "audio_url"])

    def test_subject_and_style_reference_map_to_reference_image(self):
        compiled = compile_minimax_h3_request(
            _request(media=[
                _img("subject_reference", url="https://cdn.example.com/person.png"),
                _img("style_reference", url="https://cdn.example.com/style.png"),
            ])
        )

        non_text = [item for item in compiled["content"] if item["type"] != "text"]
        self.assertTrue(all(item["role"] == "reference_image" for item in non_text))

    def test_frames_and_reference_roles_are_mutually_exclusive(self):
        with self.assertRaisesRegex(ValueError, "互斥"):
            compile_minimax_h3_request(
                _request(media=[
                    _img("first_frame", url="https://cdn.example.com/start.png"),
                    _video("https://cdn.example.com/motion.mp4"),
                ])
            )

    def test_duration_must_be_integer_between_4_and_15(self):
        with self.assertRaisesRegex(ValueError, "duration"):
            compile_minimax_h3_request(_request(duration=3))
        with self.assertRaisesRegex(ValueError, "duration"):
            compile_minimax_h3_request(_request(duration=16))
        with self.assertRaisesRegex(ValueError, "duration"):
            compile_minimax_h3_request(_request(duration=5.0))

    def test_resolution_rejects_720p_without_silent_fallback(self):
        with self.assertRaisesRegex(ValueError, "768P"):
            compile_minimax_h3_request(_request(resolution="720p"))
        with self.assertRaisesRegex(ValueError, "resolution"):
            compile_minimax_h3_request(_request(resolution="1080P"))

    def test_wrong_model_is_rejected(self):
        request = _request()
        request.provider["model"] = "MiniMax-Hailuo-2.3"
        with self.assertRaisesRegex(ValueError, MINIMAX_H3_MODEL):
            compile_minimax_h3_request(request)

    def test_reference_image_count_over_nine_rejected(self):
        media = [_img("reference_image", url=f"https://cdn.example.com/{i}.png") for i in range(10)]
        with self.assertRaisesRegex(ValueError, "9 reference images"):
            compile_minimax_h3_request(_request(media=media))

    def test_total_file_cap_of_twelve(self):
        # Per-type counts stay within limits (8 images / 3 videos / 2 audios);
        # only the 12-file total is exceeded (13 files).
        media = [
            _img("reference_image", url=f"https://cdn.example.com/i{i}.png") for i in range(8)
        ] + [
            _video(f"https://cdn.example.com/v{i}.mp4") for i in range(3)
        ] + [
            _audio(f"https://cdn.example.com/a{i}.mp3") for i in range(2)
        ]
        with self.assertRaisesRegex(ValueError, "12 media files"):
            compile_minimax_h3_request(_request(media=media))

    def test_audio_alone_is_not_a_valid_reference_input(self):
        with self.assertRaisesRegex(ValueError, "音频不能单独"):
            compile_minimax_h3_request(_request(media=[_audio()]))

    def test_local_media_source_is_rejected_before_compile(self):
        media = MediaSpec(
            media_type="video",
            role="reference_video",
            source={"kind": "local_path", "value": "/tmp/clip.mp4"},
        )
        with self.assertRaisesRegex(ValueError, "public_url or data_url"):
            compile_minimax_h3_request(_request(media=[media]))

    def test_role_type_mismatch_is_rejected(self):
        media = MediaSpec(
            media_type="video",
            role="reference_image",
            source={"kind": "public_url", "value": "https://cdn.example.com/x.mp4"},
        )
        with self.assertRaisesRegex(ValueError, "media_type"):
            compile_minimax_h3_request(_request(media=[media]))

    def test_prompt_over_7000_chars_rejected(self):
        with self.assertRaisesRegex(ValueError, "7000"):
            compile_minimax_h3_request(_request(prompt="字" * 7001))

    def test_watermark_maps_to_aigc_watermark(self):
        compiled = compile_minimax_h3_request(_request(media=[_video()], watermark=True))
        self.assertTrue(compiled["aigc_watermark"])

    def test_r2v_explicit_ratio_is_honored(self):
        compiled = compile_minimax_h3_request(
            _request(media=[_img("reference_image"), _video()], ratio="9:16")
        )
        self.assertEqual(compiled["ratio"], "9:16")


if __name__ == "__main__":
    unittest.main()
