#!/usr/bin/env python3
"""Persistent, loopback-only ComfyUI acceptance environment.

This is test infrastructure. It deliberately starts the contract Backend fixture,
never the production bootstrap, and refuses to run while an Ark credential exists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlparse


READY_WORKFLOWS = (
    "seedance.text-to-video.v1",
    "seedance.reference-image-to-video.v1",
    "seedance.first-frame-to-video.v1",
    "seedance.first-last-frame-to-video.v1",
    "seedance.omni-reference.v1",
    "seedance.video-edit.v1",
    "seedance.video-extend.v1",
    "seedance.audio-reference-to-video.v1",
)
DEFAULT_RUNTIME_ROOT = Path("/tmp/video-flow-comfy-acceptance")
DEFAULT_DB_PORT = 55434
DEFAULT_PROVIDER_PORT = 19093
DEFAULT_BACKEND_PORT = 3400
DEFAULT_WORKER_PORT = 8011
PROJECT_NAME = "video-flow-comfy-acceptance"
PROCESS_MARKERS = {
    "fake_provider": "fake_provider.py",
    "backend": "contract-backend.cjs",
    "worker": "uvicorn main:app",
}


class PreparedRuntime(NamedTuple):
    root: Path
    token_file: Path
    workflow_dir: Path
    log_dir: Path
    output_dir: Path
    audit_dir: Path


def assert_safe_environment() -> None:
    if os.getenv("VOLCENGINE_ACCESS_KEY", "").strip():
        raise RuntimeError("REAL_PROVIDER_CREDENTIAL_FORBIDDEN")


def assert_loopback_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("LOOPBACK_URL_REQUIRED")


def without_proxy_environment(source: dict[str, str]) -> dict[str, str]:
    proxy_names = {
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
        "NO_PROXY", "no_proxy",
    }
    result = {key: value for key, value in source.items() if key not in proxy_names}
    result["NO_PROXY"] = "127.0.0.1,localhost"
    result["no_proxy"] = "127.0.0.1,localhost"
    return result


def _write_private(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def acceptance_actor_token(runtime_root: Path) -> str:
    token_file = runtime_root.resolve() / "actor.token"
    if token_file.is_file():
        token = token_file.read_text(encoding="utf-8").strip()
        if not token.startswith("vf_acceptance_") or len(token) < 32:
            raise RuntimeError(f"INVALID_ACCEPTANCE_TOKEN_FILE:{token_file}")
        token_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        return token
    token = f"vf_acceptance_{secrets.token_hex(32)}"
    _write_private(token_file, token + "\n")
    return token


def prepare_runtime(
    *,
    repo_root: Path,
    runtime_root: Path,
    backend_url: str,
    actor_token: str,
) -> PreparedRuntime:
    assert_loopback_url(backend_url)
    repo_root = repo_root.resolve()
    runtime_root = runtime_root.resolve()
    source_workflows = repo_root / "packages" / "comfyui-video-flow-client" / "workflows"
    workflow_dir = runtime_root / "workflows"
    log_dir = runtime_root / "logs"
    output_dir = runtime_root / "worker-output"
    audit_dir = runtime_root / "worker-audit"
    for directory in (workflow_dir, log_dir, output_dir, audit_dir):
        directory.mkdir(parents=True, exist_ok=True)

    templates = sorted(source_workflows.glob("*-preflight-v1.comfy.json"))
    if len(templates) != 8:
        raise RuntimeError(f"EXPECTED_8_WORKFLOW_TEMPLATES_FOUND_{len(templates)}")
    for source in templates:
        workflow = json.loads(source.read_text(encoding="utf-8"))
        config_nodes = [node for node in workflow.get("nodes", []) if node.get("type") == "VideoFlowConfig"]
        if len(config_nodes) != 1:
            raise RuntimeError(f"EXPECTED_ONE_CONFIG_NODE:{source.name}")
        config_nodes[0]["widgets_values"][0] = backend_url
        target = workflow_dir / source.name
        target.write_text(
            json.dumps(workflow, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )

    token_file = runtime_root / "actor.token"
    _write_private(token_file, actor_token.rstrip("\n") + "\n")
    return PreparedRuntime(runtime_root, token_file, workflow_dir, log_dir, output_dir, audit_dir)


def write_state(
    runtime: PreparedRuntime,
    pids: dict[str, int],
    *,
    database_port: int,
    provider_port: int,
    backend_port: int,
    worker_port: int,
) -> Path:
    state = {
        "version": 1,
        "projectName": PROJECT_NAME,
        "runtimeRoot": str(runtime.root),
        "tokenFile": str(runtime.token_file),
        "workflowDir": str(runtime.workflow_dir),
        "logDir": str(runtime.log_dir),
        "outputDir": str(runtime.output_dir),
        "auditDir": str(runtime.audit_dir),
        "pids": pids,
        "ports": {
            "database": database_port,
            "provider": provider_port,
            "backend": backend_port,
            "worker": worker_port,
        },
    }
    state_path = runtime.root / "state.json"
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    state_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return state_path


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _state_path(runtime_root: Path) -> Path:
    return runtime_root.resolve() / "state.json"


def _read_state(runtime_root: Path) -> dict:
    path = _state_path(runtime_root)
    if not path.is_file():
        raise RuntimeError(f"ACCEPTANCE_ENV_NOT_STARTED:{path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _run(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def worker_environment(
    common_env: dict[str, str],
    *,
    backend_port: int,
    provider_port: int,
    worker_port: int,
    worker_token: str,
    runtime: PreparedRuntime,
) -> dict[str, str]:
    return {
        **common_env,
        # Worker 的运行日志走 print()，而 stdout 重定向到文件或管道时是块缓冲。
        # 不设这个变量，本轮验收实测到 worker.log 停更 18 分钟而 Worker 仍在正常
        # 完成任务；排查只能依赖审计 JSONL。日志必须先落盘再谈"可排查"。
        "PYTHONUNBUFFERED": "1",
        "BACKEND_URL": f"http://127.0.0.1:{backend_port}",
        "WORKER_SERVICE_TOKEN": worker_token,
        "WORKER_PORT": str(worker_port),
        "VIDEO_FLOW_AUDIT_DIR": str(runtime.audit_dir),
        "COMFYUI_OUTPUT_DIR": str(runtime.output_dir),
        "OSS_ENDPOINT": f"http://127.0.0.1:{provider_port}",
        "OSS_CNAME": "1",
        "JOB_POLL_INTERVAL": "1",
        "TASK_STATUS_CHECK_INTERVAL": "1",
    }


def _start_process(command: list[str], *, cwd: Path, env: dict[str, str], log_path: Path) -> int:
    log = log_path.open("ab", buffering=0)
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log.close()
    return process.pid


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def _wait_for_port(port: int, *, process_pid: int, label: str) -> None:
    for _ in range(100):
        if _port_open(port):
            return
        try:
            os.kill(process_pid, 0)
        except OSError as error:
            raise RuntimeError(f"{label}_EXITED_BEFORE_READY") from error
        time.sleep(0.1)
    raise RuntimeError(f"{label}_START_TIMEOUT")


def _docker_compose(repo_root: Path, db_port: int) -> tuple[list[str], dict[str, str]]:
    command = [
        "docker", "compose", "-p", PROJECT_NAME,
        "-f", str(repo_root / "scripts" / "compose.contract.yml"),
    ]
    env = {**os.environ, "VIDEO_FLOW_CONTRACT_DB_PORT": str(db_port)}
    return command, env


def _seed_database(repo_root: Path, db_port: int, actor_token: str) -> None:
    token_hash = hashlib.sha256(actor_token.encode("utf-8")).hexdigest()
    compose, env = _docker_compose(repo_root, db_port)
    sql = f"""
INSERT INTO actor_credentials (id, actor_id, name, token_hash, status, daily_limit_cny, monthly_limit_cny)
VALUES (gen_random_uuid(), 'comfy-acceptance-actor', 'ComfyUI local acceptance', '{token_hash}', 'active', 100000, 1000000)
ON CONFLICT (actor_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, status = 'active', daily_limit_cny = 100000, monthly_limit_cny = 1000000;
INSERT INTO production_gates (id, paused, reason) VALUES ('production', false, 'isolated ComfyUI acceptance')
ON CONFLICT (id) DO UPDATE SET paused = false, reason = 'isolated ComfyUI acceptance';
"""
    _run(compose + ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "video_contract", "-d", "video_flow_contract", "-c", sql], cwd=repo_root, env=env)


def start(runtime_root: Path, db_port: int, provider_port: int, backend_port: int, worker_port: int) -> None:
    assert_safe_environment()
    for port in (db_port, provider_port, backend_port, worker_port):
        if _port_open(port):
            raise RuntimeError(f"PORT_ALREADY_IN_USE:{port}")
    if _state_path(runtime_root).exists():
        raise RuntimeError(f"ACCEPTANCE_STATE_ALREADY_EXISTS:{_state_path(runtime_root)}")

    repo_root = _repo_root()
    actor_token = acceptance_actor_token(runtime_root)
    runtime = prepare_runtime(
        repo_root=repo_root,
        runtime_root=runtime_root,
        backend_url=f"http://127.0.0.1:{backend_port}",
        actor_token=actor_token,
    )
    for name in ("fake-provider.log", "backend.log", "worker.log"):
        (runtime.log_dir / name).write_bytes(b"")
    pids: dict[str, int] = {}
    try:
        compose, compose_env = _docker_compose(repo_root, db_port)
        _run(compose + ["up", "-d", "--wait", "postgres"], cwd=repo_root, env=compose_env)
        database_url = f"postgresql://video_contract:video_contract@127.0.0.1:{db_port}/video_flow_contract"
        backend_root = repo_root / "packages" / "backend"
        migration_env = {
            **os.environ,
            "VIDEO_FLOW_TEST_MODE": "1",
            "VOLCENGINE_ACCESS_KEY": "",
            "DATABASE_URL": database_url,
            "VIDEO_FLOW_PROVIDER_BASE_URL": f"http://127.0.0.1:{provider_port}/api/v3",
        }
        _run(["npx", "prisma", "migrate", "deploy"], cwd=backend_root, env=migration_env)
        _run(["npm", "run", "build"], cwd=backend_root, env=migration_env)
        _seed_database(repo_root, db_port, actor_token)

        worker_python = repo_root / "packages" / "worker" / "venv" / "bin" / "python"
        if not worker_python.is_file():
            worker_python = Path(sys.executable)
        provider_env = {
            **os.environ,
            "VOLCENGINE_ACCESS_KEY": "",
            "VIDEO_FLOW_FAKE_PROVIDER_PORT": str(provider_port),
            "VIDEO_FLOW_FAKE_PROVIDER_PUBLIC_URL": f"http://127.0.0.1:{provider_port}",
        }
        pids["fake_provider"] = _start_process(
            [str(worker_python), str(repo_root / "scripts" / "fake_provider.py")],
            cwd=repo_root,
            env=provider_env,
            log_path=runtime.log_dir / "fake-provider.log",
        )
        _wait_for_port(provider_port, process_pid=pids["fake_provider"], label="FAKE_PROVIDER")

        worker_token = f"worker-{secrets.token_hex(32)}"
        admin_token = f"admin-{secrets.token_hex(32)}"
        common_env = {
            **without_proxy_environment(migration_env),
            "VIDEO_FLOW_ADMIN_TOKEN": admin_token,
            "VIDEO_FLOW_WORKER_TOKEN": worker_token,
            "VIDEO_FLOW_PRODUCTION_ACTORS": "comfy-acceptance-actor",
            "VIDEO_FLOW_CONTRACT_READY_WORKFLOWS": ",".join(READY_WORKFLOWS),
            "VIDEO_FLOW_DAILY_TASK_LIMIT": "100000",
            "VIDEO_FLOW_FAKE_OSS_BASE_URL": f"http://127.0.0.1:{provider_port}",
            "OSS_ACCESS_KEY_ID": "fake-oss-access-key",
            "OSS_ACCESS_KEY_SECRET": "fake-oss-secret",
            "OSS_BUCKET": "fake-oss-bucket",
            "OSS_REGION": "oss-cn-beijing",
        }
        backend_env = {**common_env, "PORT": str(backend_port)}
        pids["backend"] = _start_process(
            ["node", "test/contract-backend.cjs"],
            cwd=backend_root,
            env=backend_env,
            log_path=runtime.log_dir / "backend.log",
        )
        _wait_for_port(backend_port, process_pid=pids["backend"], label="BACKEND")

        worker_env = worker_environment(
            common_env,
            backend_port=backend_port,
            provider_port=provider_port,
            worker_port=worker_port,
            worker_token=worker_token,
            runtime=runtime,
        )
        pids["worker"] = _start_process(
            [
                str(worker_python), "-m", "uvicorn", "main:app",
                "--host", "127.0.0.1", "--port", str(worker_port),
            ],
            cwd=repo_root / "packages" / "worker",
            env=worker_env,
            log_path=runtime.log_dir / "worker.log",
        )
        _wait_for_port(worker_port, process_pid=pids["worker"], label="WORKER")
        write_state(
            runtime,
            pids,
            database_port=db_port,
            provider_port=provider_port,
            backend_port=backend_port,
            worker_port=worker_port,
        )
    except Exception:
        _stop_processes(pids)
        compose, compose_env = _docker_compose(repo_root, db_port)
        subprocess.run(compose + ["down", "-v"], cwd=repo_root, env=compose_env, check=False)
        raise

    print_summary(_read_state(runtime_root))


def _stop_processes(pids: dict[str, int]) -> None:
    for pid in reversed(list(pids.values())):
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
    deadline = time.time() + 3
    while time.time() < deadline:
        if not any(_pid_alive(pid) for pid in pids.values()):
            return
        time.sleep(0.1)
    for pid in pids.values():
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _process_command(pid: int) -> str:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def validate_recorded_processes(pids: dict[str, int]) -> dict[str, int]:
    for name, pid in pids.items():
        marker = PROCESS_MARKERS.get(name)
        if marker is None:
            raise RuntimeError(f"UNKNOWN_RECORDED_PROCESS:{name}")
        if _pid_alive(pid) and marker not in _process_command(pid):
            raise RuntimeError(f"PID_COMMAND_MISMATCH:{name}:{pid}")
    return pids


def stop(runtime_root: Path) -> None:
    state = _read_state(runtime_root)
    pids = {key: int(value) for key, value in state.get("pids", {}).items()}
    _stop_processes(validate_recorded_processes(pids))
    repo_root = _repo_root()
    compose, env = _docker_compose(repo_root, int(state["ports"]["database"]))
    _run(compose + ["down", "-v"], cwd=repo_root, env=env)
    _state_path(runtime_root).unlink(missing_ok=True)
    print(f"已停止验收环境；日志保留在 {state['logDir']}")


def print_summary(state: dict) -> None:
    ports = state["ports"]
    print("ComfyUI 本地隔离验收环境已启动")
    print(f"Backend: http://127.0.0.1:{ports['backend']}")
    print(f"Worker: http://127.0.0.1:{ports['worker']}/ready")
    print(f"Fake Provider: http://127.0.0.1:{ports['provider']}/api/v3/__test__/stats")
    print(f"临时 token: {state['tokenFile']}")
    print(f"临时 workflows: {state['workflowDir']}")
    print(f"日志: {state['logDir']}")


def status(runtime_root: Path) -> None:
    state = _read_state(runtime_root)
    print_summary(state)
    for name, pid in state["pids"].items():
        print(f"{name}: {'running' if _pid_alive(int(pid)) else 'stopped'} (pid {pid})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "status", "stop", "paths"))
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    parser.add_argument("--database-port", type=int, default=DEFAULT_DB_PORT)
    parser.add_argument("--provider-port", type=int, default=DEFAULT_PROVIDER_PORT)
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--worker-port", type=int, default=DEFAULT_WORKER_PORT)
    args = parser.parse_args()
    try:
        if args.command == "start":
            start(args.runtime_root, args.database_port, args.provider_port, args.backend_port, args.worker_port)
        elif args.command == "stop":
            stop(args.runtime_root)
        else:
            status(args.runtime_root)
        return 0
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
