import importlib.util
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "comfyui_acceptance_env.py"


def load_module():
    spec = importlib.util.spec_from_file_location("comfyui_acceptance_env", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_worker_image_runs_python_unbuffered():
    """Worker 用 print() 输出运行日志，而 Python 的 stdout 落到管道或文件时是块缓冲。

    不设 PYTHONUNBUFFERED 时 `docker logs video-flow-worker` 会滞后于实际状态，
    运维和验收都会对着"看不到任何新内容"的日志排查（2026-09-15 实际观察到
    worker.log 停更 18 分钟、期间 Worker 仍完成了任务）。
    """
    dockerfile = (REPO_ROOT / "packages" / "worker" / "Dockerfile").read_text(encoding="utf-8")

    assert "PYTHONUNBUFFERED" in dockerfile


def test_acceptance_worker_environment_is_unbuffered_and_keeps_its_other_settings(tmp_path):
    module = load_module()
    runtime = module.PreparedRuntime(
        root=tmp_path / "runtime",
        token_file=tmp_path / "runtime" / "actor.token",
        workflow_dir=tmp_path / "runtime" / "workflows",
        log_dir=tmp_path / "runtime" / "logs",
        output_dir=tmp_path / "runtime" / "worker-output",
        audit_dir=tmp_path / "runtime" / "worker-audit",
    )

    env = module.worker_environment(
        {"PATH": "/usr/bin"},
        backend_port=3400,
        provider_port=19093,
        worker_port=8011,
        worker_token="worker-secret",
        runtime=runtime,
    )

    assert env["PYTHONUNBUFFERED"] == "1"
    assert env["PATH"] == "/usr/bin"
    assert env["BACKEND_URL"] == "http://127.0.0.1:3400"
    assert env["WORKER_SERVICE_TOKEN"] == "worker-secret"
    assert env["WORKER_PORT"] == "8011"
    assert env["VIDEO_FLOW_AUDIT_DIR"] == str(runtime.audit_dir)
    assert env["COMFYUI_OUTPUT_DIR"] == str(runtime.output_dir)
    assert env["OSS_ENDPOINT"] == "http://127.0.0.1:19093"
    assert env["OSS_CNAME"] == "1"
    assert env["JOB_POLL_INTERVAL"] == "1"
    assert env["TASK_STATUS_CHECK_INTERVAL"] == "1"
