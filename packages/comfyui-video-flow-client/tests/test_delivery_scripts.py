import os
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
    assert "-m\npip\ninstall\n-r" in install_log.read_text(encoding="utf-8")
    installed_token = home / ".video-flow/token"
    assert installed_token.read_text(encoding="utf-8").strip() == "vf_test_token"
    assert stat.S_IMODE(installed_token.stat().st_mode) == 0o600


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
