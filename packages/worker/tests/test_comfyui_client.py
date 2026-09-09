import asyncio
import json
import sys
import unittest
from pathlib import Path

import httpx


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from comfyui_client import ComfyUIClient, ComfyUIError  # noqa: E402


class ComfyUIClientTests(unittest.TestCase):
    def run_async(self, coroutine):
        return asyncio.run(coroutine)

    def test_health_normalizes_base_url_and_returns_system_stats(self):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"system": {"comfyui_version": "0.34.2"}})

        async def scenario():
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as http_client:
                client = ComfyUIClient("http://comfyui.local/", client=http_client)
                result = await client.health()
                await client.close()
            return result

        result = self.run_async(scenario())

        self.assertEqual(result["system"]["comfyui_version"], "0.34.2")
        self.assertEqual(str(requests[0].url), "http://comfyui.local/system_stats")

    def test_object_info_returns_registered_nodes(self):
        def handler(request):
            self.assertEqual(request.url.path, "/object_info")
            return httpx.Response(200, json={"SeedanceArkCreateTask": {"name": "Create task"}})

        async def scenario():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
                return await ComfyUIClient("http://comfyui.local", client=http_client).object_info()

        result = self.run_async(scenario())

        self.assertEqual(result["SeedanceArkCreateTask"]["name"], "Create task")

    def test_queue_prompt_posts_workflow_and_returns_prompt_id(self):
        workflow = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {}}}

        def handler(request):
            self.assertEqual(request.url.path, "/prompt")
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.content), {"prompt": workflow, "client_id": "worker-1"})
            return httpx.Response(200, json={"prompt_id": "prompt-123"})

        async def scenario():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
                client = ComfyUIClient("http://comfyui.local", client=http_client)
                return await client.queue_prompt(workflow, client_id="worker-1")

        self.assertEqual(self.run_async(scenario()), "prompt-123")

    def test_history_returns_prompt_history_payload(self):
        def handler(request):
            self.assertEqual(request.url.path, "/history/prompt-123")
            return httpx.Response(200, json={"prompt-123": {"status": {"completed": True}}})

        async def scenario():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
                return await ComfyUIClient("http://comfyui.local", client=http_client).history("prompt-123")

        result = self.run_async(scenario())

        self.assertTrue(result["prompt-123"]["status"]["completed"])

    def test_non_success_response_raises_comfyui_error(self):
        def handler(request):
            return httpx.Response(503, json={"error": "unavailable"})

        async def scenario():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
                await ComfyUIClient("http://comfyui.local", client=http_client).health()

        with self.assertRaisesRegex(ComfyUIError, "503"):
            self.run_async(scenario())

    def test_malformed_json_raises_comfyui_error(self):
        def handler(request):
            return httpx.Response(200, content=b"not-json", headers={"content-type": "text/plain"})

        async def scenario():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
                await ComfyUIClient("http://comfyui.local", client=http_client).object_info()

        with self.assertRaisesRegex(ComfyUIError, "JSON"):
            self.run_async(scenario())

    def test_queue_prompt_rejects_missing_or_empty_prompt_id(self):
        payloads = ({"status": "queued"}, {"prompt_id": ""})

        for payload in payloads:
            with self.subTest(payload=payload):
                def handler(request, payload=payload):
                    return httpx.Response(200, json=payload)

                async def scenario():
                    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
                        await ComfyUIClient("http://comfyui.local", client=http_client).queue_prompt({})

                with self.assertRaisesRegex(ComfyUIError, "prompt_id"):
                    self.run_async(scenario())

    def test_close_does_not_close_injected_client(self):
        async def scenario():
            http_client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})))
            client = ComfyUIClient("http://comfyui.local", client=http_client)
            await client.close()
            still_open = not http_client.is_closed
            await http_client.aclose()
            return still_open

        self.assertTrue(self.run_async(scenario()))

    def test_close_closes_owned_client(self):
        async def scenario():
            client = ComfyUIClient("http://comfyui.local")
            await client.close()
            return client._client.is_closed

        self.assertTrue(self.run_async(scenario()))


if __name__ == "__main__":
    unittest.main()
