import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "comfyui_acceptance_env.py"


def load_module():
    spec = importlib.util.spec_from_file_location("comfyui_acceptance_env", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_rejects_any_real_provider_credential(monkeypatch):
    module = load_module()
    monkeypatch.setenv("VOLCENGINE_ACCESS_KEY", "ark-real-looking-key")

    with pytest.raises(RuntimeError, match="REAL_PROVIDER_CREDENTIAL_FORBIDDEN"):
        module.assert_safe_environment()


def test_prepare_creates_isolated_token_and_local_workflow_copies(tmp_path):
    module = load_module()
    source_root = REPO_ROOT / "packages" / "comfyui-video-flow-client" / "workflows"
    source_hashes = {path.name: sha256(path) for path in source_root.glob("*.comfy.json")}

    result = module.prepare_runtime(
        repo_root=REPO_ROOT,
        runtime_root=tmp_path / "runtime",
        backend_url="http://127.0.0.1:3400",
        actor_token="acceptance-secret",
    )

    assert result.token_file.read_text(encoding="utf-8") == "acceptance-secret\n"
    assert result.token_file.stat().st_mode & 0o777 == 0o600
    assert result.workflow_dir != source_root
    copies = sorted(result.workflow_dir.glob("*.comfy.json"))
    assert len(copies) == 8
    for path in copies:
        workflow = json.loads(path.read_text(encoding="utf-8"))
        config = next(node for node in workflow["nodes"] if node["type"] == "VideoFlowConfig")
        policy = next(node for node in workflow["nodes"] if node["type"] == "VideoFlowExecutionPolicy")
        assert config["widgets_values"][0] == "http://127.0.0.1:3400"
        assert policy["widgets_values"] == ["preview"]

    assert source_hashes == {
        path.name: sha256(path) for path in source_root.glob("*.comfy.json")
    }
    assert not (Path.home() / ".video-flow" / "token").samefile(result.token_file)


def test_runtime_state_never_serializes_actor_token(tmp_path):
    module = load_module()
    runtime = module.prepare_runtime(
        repo_root=REPO_ROOT,
        runtime_root=tmp_path / "runtime",
        backend_url="http://127.0.0.1:3400",
        actor_token="acceptance-secret",
    )

    state_path = module.write_state(
        runtime,
        {"backend": 123, "worker": 456, "fake_provider": 789},
        database_port=55434,
        provider_port=19093,
        backend_port=3400,
        worker_port=8011,
    )

    raw = state_path.read_text(encoding="utf-8")
    state = json.loads(raw)
    assert "acceptance-secret" not in raw
    assert state["tokenFile"] == str(runtime.token_file)
    assert state["pids"]["backend"] == 123


def test_acceptance_actor_token_is_reused_across_environment_restarts(tmp_path):
    module = load_module()
    runtime_root = tmp_path / "runtime"

    first = module.acceptance_actor_token(runtime_root)
    second = module.acceptance_actor_token(runtime_root)

    assert first.startswith("vf_acceptance_")
    assert second == first
    assert (runtime_root / "actor.token").stat().st_mode & 0o777 == 0o600


def test_refuses_non_loopback_acceptance_urls():
    module = load_module()

    with pytest.raises(ValueError, match="LOOPBACK_URL_REQUIRED"):
        module.assert_loopback_url("https://ai.sweetyshell.com")

    module.assert_loopback_url("http://127.0.0.1:3400")
    module.assert_loopback_url("http://localhost:3400")


def test_acceptance_environment_removes_upper_and_lowercase_proxy_variables():
    module = load_module()
    source = {
        "PATH": "/usr/bin",
        "HTTP_PROXY": "http://proxy.test",
        "HTTPS_PROXY": "http://proxy.test",
        "ALL_PROXY": "socks5://proxy.test",
        "http_proxy": "http://proxy.test",
        "https_proxy": "http://proxy.test",
        "all_proxy": "socks5://proxy.test",
        "NO_PROXY": "example.test",
        "no_proxy": "example.test",
    }

    result = module.without_proxy_environment(source)

    assert result == {"PATH": "/usr/bin", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}


def test_stop_validation_rejects_reused_pid(monkeypatch):
    module = load_module()
    monkeypatch.setattr(module, "_pid_alive", lambda _pid: True)
    monkeypatch.setattr(module, "_process_command", lambda _pid: "/usr/bin/python unrelated_service.py")

    with pytest.raises(RuntimeError, match="PID_COMMAND_MISMATCH:backend:321"):
        module.validate_recorded_processes({"backend": 321})


def test_stop_validation_accepts_recorded_acceptance_processes(monkeypatch):
    module = load_module()
    commands = {
        101: "python /repo/scripts/fake_provider.py",
        102: "node test/contract-backend.cjs",
        103: "python -m uvicorn main:app --host 127.0.0.1",
    }
    monkeypatch.setattr(module, "_pid_alive", lambda _pid: True)
    monkeypatch.setattr(module, "_process_command", commands.__getitem__)

    assert module.validate_recorded_processes({
        "fake_provider": 101,
        "backend": 102,
        "worker": 103,
    }) == {"fake_provider": 101, "backend": 102, "worker": 103}
