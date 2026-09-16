import os
import re
import stat
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENT_DIR = Path(__file__).resolve().parents[1]


def _write_executable(path: Path, content: str):
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def test_installer_copies_client_and_protects_token(tmp_path):
    comfy_root = tmp_path / "ComfyUI"
    python_path = comfy_root / ".venv/bin/python"
    python_path.parent.mkdir(parents=True)
    install_log = tmp_path / "pip.log"
    _write_executable(
        python_path,
        '#!/bin/sh\nprintf "%s\\n" "$@" >> "$INSTALL_LOG"\n',
    )
    (comfy_root / "custom_nodes").mkdir()
    token_source = tmp_path / "actor-token"
    token_source.write_text("vf_test_token\n", encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()

    env = {**os.environ, "HOME": str(home), "INSTALL_LOG": str(install_log)}
    subprocess.run(
        [str(CLIENT_DIR / "install.sh"), str(comfy_root), str(token_source)],
        check=True,
        env=env,
        text=True,
        capture_output=True,
    )

    target = comfy_root / "custom_nodes/video_flow_client"
    assert (target / "client.py").is_file()
    assert (target / "requirements.txt").is_file()
    # T07/T08 新增的模块与资源必须一起送达：漏装会让同事的节点直接 import 失败。
    assert (target / "receipts.py").is_file()
    assert (target / "execution_slot.py").is_file()
    assert (target / "submission_state.py").is_file()
    assert not (target / "workflows" / "seedance-image-to-video-v1.comfy.json").exists()
    assert not (target / "workflows" / "seedance-image-to-video-preview-v1.comfy.json").exists()
    assert not (target / "workflows" / "seedance-text-to-video-preview-v1.comfy.json").exists()
    assert not (target / "examples" / "seedance-production.json").exists()
    assert (target / "examples/seedance-resume.json").is_file()
    assert (target / "examples/seedance-resume.json").is_file()
    assert (target / "web/js/video_flow_status.js").is_file()
    assert "-m\npip\ninstall\n-r" in install_log.read_text(encoding="utf-8")
    installed_token = home / ".video-flow/token"
    assert installed_token.read_text(encoding="utf-8").strip() == "vf_test_token"
    assert stat.S_IMODE(installed_token.stat().st_mode) == 0o600


def test_client_version_is_declared_and_reported_by_the_installer(tmp_path):
    """交付版本必须存在、格式可解析，并由安装器打印出来。

    排查"同事装的是哪一版"全靠它；安装脚本用 sed 解析 `__init__.py` 里那一行，
    所以格式变了会静默变成"未知"，这里钉住。
    """
    source = (CLIENT_DIR / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'^CLIENT_VERSION = "(\d{4}-\d{2}-\d{2}\.\d+)"$', source, flags=re.MULTILINE)
    assert match, "CLIENT_VERSION 必须形如 2026-09-16.1，且独占一行"
    version = match.group(1)

    comfy_root = tmp_path / "ComfyUI"
    python_path = comfy_root / ".venv/bin/python"
    python_path.parent.mkdir(parents=True)
    _write_executable(python_path, "#!/bin/sh\nexit 0\n")
    (comfy_root / "custom_nodes").mkdir()
    token_source = tmp_path / "actor-token"
    token_source.write_text("vf_test_token\n", encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()

    completed = subprocess.run(
        [str(CLIENT_DIR / "install.sh"), str(comfy_root), str(token_source)],
        check=True,
        env={**os.environ, "HOME": str(home)},
        text=True,
        capture_output=True,
    )

    assert version in completed.stdout


def _fake_comfy_root(base: Path) -> Path:
    """造一个"看起来像 ComfyUI 根目录"的目录：有 custom_nodes 和可执行的 venv python。"""
    root = base / "ComfyUI"
    (root / ".venv/bin").mkdir(parents=True)
    _write_executable(root / ".venv/bin/python", "#!/bin/sh\nexit 0\n")
    (root / "custom_nodes").mkdir()
    return root


def _write_desktop_manifest(home: Path, install_path: Path):
    """Comfy Desktop 的安装记录：真正的根是 installPath 的子目录 ComfyUI/。"""
    manifest = home / "Library/Application Support/Comfy Desktop/installations.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(f'[{{"id": "inst-1", "installPath": "{install_path}"}}]', encoding="utf-8")


def test_find_root_prefers_explicit_override_and_never_silently_falls_back(tmp_path):
    finder = CLIENT_DIR / "find_comfyui_root.sh"
    root = _fake_comfy_root(tmp_path)

    found = subprocess.run(
        [str(finder)], check=True, text=True, capture_output=True,
        env={**os.environ, "VIDEO_FLOW_COMFYUI_ROOT": str(root)},
    )
    assert found.stdout.strip() == str(root)

    # 显式指定的路径无效时必须失败，而不是悄悄换用别的目录——否则会把客户端装错地方。
    missing = subprocess.run(
        [str(finder)], text=True, capture_output=True,
        env={**os.environ, "VIDEO_FLOW_COMFYUI_ROOT": str(tmp_path / "nope")},
    )
    assert missing.returncode == 1


def test_find_root_reads_the_comfy_desktop_install_record(tmp_path):
    finder = CLIENT_DIR / "find_comfyui_root.sh"
    home = tmp_path / "home"
    home.mkdir()
    root = _fake_comfy_root(tmp_path / "desktop-install")
    _write_desktop_manifest(home, root.parent)

    found = subprocess.run(
        [str(finder)], check=True, text=True, capture_output=True,
        env={
            **os.environ,
            "HOME": str(home),
            # 把常见位置换成不存在的路径，确保命中的是 Desktop 记录，而不是开发机上的真实安装。
            "VIDEO_FLOW_COMFYUI_CANDIDATES": str(tmp_path / "not-here"),
        },
    )
    assert found.stdout.strip() == str(root)

    nothing = subprocess.run(
        [str(finder)], text=True, capture_output=True,
        env={**os.environ, "HOME": str(tmp_path / "empty-home"), "VIDEO_FLOW_COMFYUI_CANDIDATES": str(tmp_path / "not-here")},
    )
    assert nothing.returncode == 1


def test_one_click_installer_installs_into_a_comfy_desktop_instance(tmp_path):
    """同事那台就是 Comfy Desktop：安装器要能自己找到 installPath/ComfyUI。"""
    home = tmp_path / "home"
    home.mkdir()
    root = _fake_comfy_root(tmp_path / "desktop-install")
    _write_desktop_manifest(home, root.parent)
    token_source = tmp_path / "actor-token"
    token_source.write_text("vf_test_token\n", encoding="utf-8")

    subprocess.run(
        [str(CLIENT_DIR / "install_creative.command")],
        check=True, text=True, capture_output=True,
        env={
            **os.environ,
            "HOME": str(home),
            "VIDEO_FLOW_NONINTERACTIVE": "1",
            "VIDEO_FLOW_TOKEN_FILE": str(token_source),
            "VIDEO_FLOW_COMFYUI_CANDIDATES": str(tmp_path / "not-here"),
        },
    )

    assert (root / "custom_nodes/video_flow_client/client.py").is_file()


def test_installer_never_touches_other_custom_nodes(tmp_path):
    comfy_root = tmp_path / "ComfyUI"
    python_path = comfy_root / ".venv/bin/python"
    python_path.parent.mkdir(parents=True)
    _write_executable(python_path, "#!/bin/sh\nexit 0\n")
    custom_nodes = comfy_root / "custom_nodes"
    custom_nodes.mkdir(parents=True)

    # 同事自己的节点：安装器只应动 video_flow_client 与备份目录。
    colleague = custom_nodes / "colleague_node"
    colleague.mkdir()
    (colleague / "node.py").write_text("# colleague's node\n", encoding="utf-8")

    token_source = tmp_path / "actor-token"
    token_source.write_text("vf_test_token\n", encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()

    subprocess.run(
        [str(CLIENT_DIR / "install.sh"), str(comfy_root), str(token_source)],
        check=True,
        env={**os.environ, "HOME": str(home)},
        text=True,
        capture_output=True,
    )

    assert (colleague / "node.py").read_text(encoding="utf-8") == "# colleague's node\n"
    assert (custom_nodes / "video_flow_client/client.py").is_file()


def test_installer_keeps_previous_version_outside_custom_nodes(tmp_path):
    comfy_root = tmp_path / "ComfyUI"
    python_path = comfy_root / ".venv/bin/python"
    python_path.parent.mkdir(parents=True)
    _write_executable(python_path, "#!/bin/sh\nexit 0\n")
    target = comfy_root / "custom_nodes/video_flow_client"
    target.mkdir(parents=True)
    (target / "old-version.txt").write_text("old", encoding="utf-8")

    subprocess.run(
        [str(CLIENT_DIR / "install.sh"), str(comfy_root)],
        check=True,
        env={**os.environ, "HOME": str(tmp_path)},
        text=True,
        capture_output=True,
    )

    assert not list((comfy_root / "custom_nodes").glob("video_flow_client.backup.*"))
    backups = list(
        (comfy_root / ".video-flow-backups").glob("video_flow_client.*")
    )
    assert len(backups) == 1
    assert (backups[0] / "old-version.txt").read_text(encoding="utf-8") == "old"


def test_creative_installer_uses_supplied_comfyui_and_secure_token_file(tmp_path):
    comfy_root = tmp_path / "ComfyUI"
    python_path = comfy_root / ".venv/bin/python"
    python_path.parent.mkdir(parents=True)
    _write_executable(python_path, "#!/bin/sh\nexit 0\n")
    (comfy_root / "custom_nodes").mkdir()
    token_source = tmp_path / "creative-token"
    token_source.write_text("vf_creative_token\n", encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()

    result = subprocess.run(
        [str(CLIENT_DIR / "install_creative.command")],
        check=True,
        env={
            **os.environ,
            "HOME": str(home),
            "VIDEO_FLOW_COMFYUI_ROOT": str(comfy_root),
            "VIDEO_FLOW_TOKEN_FILE": str(token_source),
            "VIDEO_FLOW_NONINTERACTIVE": "1",
        },
        text=True,
        capture_output=True,
    )

    assert (comfy_root / "custom_nodes/video_flow_client/nodes.py").is_file()
    installed_token = home / ".video-flow/token"
    assert installed_token.read_text(encoding="utf-8").strip() == "vf_creative_token"
    assert stat.S_IMODE(installed_token.stat().st_mode) == 0o600
    assert "vf_creative_token" not in result.stdout
    assert "vf_creative_token" not in result.stderr


def test_installer_accepts_token_already_at_destination(tmp_path):
    comfy_root = tmp_path / "ComfyUI"
    python_path = comfy_root / ".venv/bin/python"
    python_path.parent.mkdir(parents=True)
    _write_executable(python_path, "#!/bin/sh\nexit 0\n")
    (comfy_root / "custom_nodes").mkdir()
    home = tmp_path / "home"
    token_source = home / ".video-flow/token"
    token_source.parent.mkdir(parents=True)
    token_source.write_text("vf_existing_token\n", encoding="utf-8")
    token_source.chmod(0o600)

    subprocess.run(
        [str(CLIENT_DIR / "install.sh"), str(comfy_root), str(token_source)],
        check=True,
        env={**os.environ, "HOME": str(home)},
        text=True,
        capture_output=True,
    )

    assert token_source.read_text(encoding="utf-8").strip() == "vf_existing_token"
    assert stat.S_IMODE(token_source.stat().st_mode) == 0o600


def test_admin_credential_script_never_prints_issued_token(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_executable(
        fake_bin / "curl",
        "#!/bin/sh\n"
        "case \"$*\" in\n"
        "  *'/revoke'*) printf '%s\\n' '{\"actorId\":\"alice\",\"status\":\"revoked\"}' ;;\n"
        "  *) printf '%s\\n' '{\"actorId\":\"alice\",\"token\":\"vf_test_token\"}' ;;\n"
        "esac\n",
    )
    token_output = tmp_path / "alice-token"
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "VIDEO_FLOW_ADMIN_TOKEN": "admin-test-token",
    }

    issued = subprocess.run(
        [
            str(REPO_ROOT / "scripts/video_flow_credential.sh"),
            "issue",
            "alice",
            "Alice",
            str(token_output),
        ],
        check=True,
        env=env,
        text=True,
        capture_output=True,
    )
    assert token_output.read_text(encoding="utf-8").strip() == "vf_test_token"
    assert stat.S_IMODE(token_output.stat().st_mode) == 0o600
    assert "vf_test_token" not in issued.stdout

    revoked = subprocess.run(
        [str(REPO_ROOT / "scripts/video_flow_credential.sh"), "revoke", "alice"],
        check=True,
        env=env,
        text=True,
        capture_output=True,
    )
    assert "revoked" in revoked.stdout


def test_preview_smoke_uses_existing_actor_token_without_admin_token(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    curl_log = tmp_path / "curl.log"
    _write_executable(
        fake_bin / "curl",
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CURL_LOG"\nprintf \'%s\\n\' '
        "'{\"id\":\"preview-task\",\"status\":\"preview\",\"preview\":{\"willCallProvider\":false}}'\n",
    )
    home = tmp_path / "home"
    token_file = home / ".video-flow/token"
    token_file.parent.mkdir(parents=True)
    token_file.write_text("vf_existing_actor_token\n", encoding="utf-8")
    token_file.chmod(0o600)
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "HOME": str(home),
        "CURL_LOG": str(curl_log),
        "MODE": "preview",
    }
    env.pop("VIDEO_FLOW_ADMIN_TOKEN", None)
    env.pop("VIDEO_FLOW_TOKEN", None)
    env.pop("VIDEO_FLOW_TOKEN_FILE", None)

    result = subprocess.run(
        [str(REPO_ROOT / "scripts/seedance_cli_smoke.sh")],
        check=True,
        env=env,
        text=True,
        capture_output=True,
    )

    assert "mode=preview" in result.stdout
    assert "Bearer vf_existing_actor_token" in curl_log.read_text(encoding="utf-8")
