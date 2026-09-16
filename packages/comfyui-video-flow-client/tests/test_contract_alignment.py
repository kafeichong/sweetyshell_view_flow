"""客户端本地预检用的上限，必须与发货合同里的数字一致。

合同是服务端复验用的真值，客户端这一份只是为了在用户点 Queue 之前尽早给出提示——
两份数字漂移过一次就会变成"客户端说行、服务端说不行"或者反过来，所以在这里钉死。

安装到同事机器上的客户端目录里没有 `contracts/`，那种情况下跳过（仓库内跑才校验）。
"""

import json
from pathlib import Path

import pytest

import preflight_nodes as n


CONTRACT_PATH = Path(__file__).resolve().parents[3] / "contracts" / "seedance-workflows.v2.json"


@pytest.mark.skipif(not CONTRACT_PATH.exists(), reason="安装副本没有 contracts/，只在仓库内校验")
def test_reference_media_limits_match_the_shipped_contract():
    media = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))["media"]

    assert n.REFERENCE_MEDIA_LIMITS["reference_image"][0] == media["image"]["maximumCount"]
    assert n.REFERENCE_MEDIA_LIMITS["reference_video"][0] == media["video"]["maximumCount"]
    assert n.REFERENCE_MEDIA_LIMITS["reference_audio"][0] == media["audio"]["maximumCount"]
    assert n.REFERENCE_MEDIA_TOTAL_LIMIT == media["maximumReferenceCount"]


@pytest.mark.skipif(not CONTRACT_PATH.exists(), reason="安装副本没有 contracts/，只在仓库内校验")
def test_contract_keeps_the_content_rules_that_the_client_explains_to_users():
    """合同里必须留着这几条规则：客户端给用户看的提示与校验都引用它们。

    规则本身来自官方创建任务接口文档（见合同 contentRules.source 与 evidence），
    这里断言的是"别在改合同时把它们删掉"。
    """
    rules = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))["contentRules"]

    assert rules["minimumReferenceMaterials"] == 1
    assert "reference_image" in rules["minimumReferenceMaterialsRule"]
    assert set(rules["taskTypeExclusivity"]["taskTypes"]) == {
        "first_frame_to_video", "first_last_frame_to_video", "omni_reference",
    }
    assert rules["omniReferenceTaskType"]["values"] == ["auto", "reference", "edit", "extend"]
    assert "总帧数" in rules["durationReturnSemantics"]["formula"]
