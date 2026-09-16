"""
ComfyUI 扩展的 API 代理
前端通过这个代理访问 backend API，避免在浏览器中暴露 Token
"""
import aiohttp
import server
from aiohttp import web
from .config import VideoFlowConfig


routes = server.PromptServer.instance.routes


@routes.get("/video_flow/api/consumption/overview")
async def proxy_consumption_overview(request):
    """代理消费概览请求"""
    config = VideoFlowConfig.from_env()

    if not config.token:
        return web.json_response(
            {"error": "未配置 Token，请设置 VIDEO_FLOW_TOKEN 环境变量或 ~/.video-flow/token 文件"},
            status=401
        )

    async with aiohttp.ClientSession() as session:
        url = f"{config.backend_url}/api/v1/consumption/overview"
        headers = {"Authorization": f"Bearer {config.token}"}

        try:
            async with session.get(url, headers=headers) as resp:
                data = await resp.json()
                return web.json_response(data, status=resp.status)
        except Exception as e:
            return web.json_response(
                {"error": f"请求失败: {str(e)}"},
                status=500
            )


@routes.get("/video_flow/api/tasks")
async def proxy_tasks(request):
    """代理任务列表请求"""
    config = VideoFlowConfig.from_env()

    if not config.token:
        return web.json_response(
            {"error": "未配置 Token"},
            status=401
        )

    limit = request.query.get('limit', '10')

    async with aiohttp.ClientSession() as session:
        url = f"{config.backend_url}/api/v1/tasks?limit={limit}"
        headers = {"Authorization": f"Bearer {config.token}"}

        try:
            async with session.get(url, headers=headers) as resp:
                data = await resp.json()
                return web.json_response(data, status=resp.status)
        except Exception as e:
            return web.json_response(
                {"error": f"请求失败: {str(e)}"},
                status=500
            )


@routes.get("/video_flow/api/tasks/{task_id}/detail")
async def proxy_task_detail(request):
    """代理任务详情请求"""
    config = VideoFlowConfig.from_env()

    if not config.token:
        return web.json_response(
            {"error": "未配置 Token"},
            status=401
        )

    task_id = request.match_info['task_id']

    async with aiohttp.ClientSession() as session:
        url = f"{config.backend_url}/api/v1/tasks/{task_id}/detail"
        headers = {"Authorization": f"Bearer {config.token}"}

        try:
            async with session.get(url, headers=headers) as resp:
                data = await resp.json()
                return web.json_response(data, status=resp.status)
        except Exception as e:
            return web.json_response(
                {"error": f"请求失败: {str(e)}"},
                status=500
            )


@routes.get("/video_flow/api/config")
async def get_config_status(request):
    """返回配置状态（不返回 Token 本身）"""
    config = VideoFlowConfig.from_env()

    return web.json_response({
        "hasToken": bool(config.token),
        "backendUrl": config.backend_url,
        "message": "Token 已配置" if config.token else "未配置 Token，请设置 VIDEO_FLOW_TOKEN 环境变量或 ~/.video-flow/token 文件"
    })
