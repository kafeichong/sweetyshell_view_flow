import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from PIL import Image
import preflight_nodes as n
from config import VideoFlowConfig


def inputs(tmp_path, monkeypatch):
    path = tmp_path / 'product.png'
    Image.new('RGB', (500, 500)).save(path)
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(get_input_directory=lambda: str(tmp_path), get_annotated_filepath=lambda _: str(path)))
    media = n.ProductInput().inspect('product.png')[0]
    return n.ProductRequest().build(media, 'product')[0]


def test_preview_only_sends_descriptors_and_skips_paid_chain(tmp_path, monkeypatch):
    request = inputs(tmp_path, monkeypatch)
    calls = []
    record = {'preflightId': 'p1', 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(), 'willCallProvider': False, 'willUploadMedia': False, 'effectiveSpec': {'version': '1'}}
    class Client:
        def __init__(self, config): self.client = self
        def _headers(self): return {}
        def post(self, url, **kwargs):
            calls.append((url, kwargs['json']))
            return SimpleNamespace(status_code=201, json=lambda: record)
    monkeypatch.setattr(n, 'VideoFlowClient', Client)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    policy = n.ExecutionPolicy().execute()[0]
    checked = n.RequestPreview().check(config, policy, request)['result'][0]
    task = n.CreateTask().submit(config, policy, checked)[0]
    n.WaitTask().wait(config, task)
    result = n.DownloadResult().download(config, task)
    assert result['result'] == ('',)
    assert len(calls) == 1
    assert calls[0][0].endswith('/preflight')
    assert set(calls[0][1]['media'][0]) == {'sha256', 'role', 'mimeType', 'sizeBytes', 'metadata'}
    assert 'data' not in json.dumps(calls[0][1]).replace('metadata', '')


def test_skip_preview_and_changed_input_cannot_upload(tmp_path, monkeypatch):
    request = inputs(tmp_path, monkeypatch)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    policy = n.ExecutionPolicy().execute('production', True)[0]
    with pytest.raises(ValueError, match='尚未通过 Preview'):
        n.RequestPreview().check(config, policy, request)
    n.store(config).save(n.fingerprint(request['intent']), {'preflightId': 'p1', 'expiresAt': '2000-01-01T00:00:00+00:00'})
    with pytest.raises(ValueError, match='过期'):
        n.RequestPreview().check(config, policy, request)
    request['intent']['prompt']['positive'] = 'changed'
    with pytest.raises(ValueError, match='尚未通过 Preview'):
        n.RequestPreview().check(config, policy, request)


def test_unknown_mode_and_missing_confirmation_rejected():
    with pytest.raises(ValueError): n.ExecutionPolicy().execute('unknown', True)
    with pytest.raises(ValueError): n.ExecutionPolicy().execute('production', False)


def test_confirmed_submission_reuses_receipt_without_uploading_again(tmp_path, monkeypatch):
    import httpx
    from client import VideoFlowClient
    request = inputs(tmp_path, monkeypatch)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    calls = []
    record = {'preflightId': 'p1', 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(), 'willCallProvider': False, 'willUploadMedia': False, 'effectiveSpec': {'version': '1'}}
    def handle(req):
        calls.append((req.method, req.url.path))
        if req.url.path.endswith('/preflight'): return httpx.Response(201, json=record)
        if req.url.path.endswith('/check'): return httpx.Response(200, json={'valid': True})
        if req.url.path.endswith('/upload-ticket'): return httpx.Response(201, json={'assetId': 'a1', 'alreadyUploaded': True})
        if req.method == 'POST' and req.url.path.endswith('/tasks'):
            body = json.loads(req.content)
            assert body['preflightId'] == 'p1' and body['confirmLiveSubmission'] is True
            assert body['mode'] == 'production'
            assert body['media'] == [{'assetId': 'a1', 'role': 'reference_image'}]
            return httpx.Response(201, json={'id': 't1'})
        if req.url.path.endswith('/tasks/t1'): return httpx.Response(200, json={'id': 't1'})
        raise AssertionError(str(req.url))
    monkeypatch.setattr(n, 'VideoFlowClient', lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handle))))
    n.RequestPreview().check(config, n.ExecutionPolicy().execute()[0], request)
    policy = n.ExecutionPolicy().execute('production', True)[0]
    checked = n.RequestPreview().check(config, policy, request)['result'][0]
    assert n.CreateTask().submit(config, policy, checked)[0]['task_id'] == 't1'
    assert n.CreateTask().submit(config, policy, checked)[0]['task_id'] == 't1'
    assert calls.count(('POST', '/api/v1/assets/upload-ticket')) == 1
    assert calls.count(('POST', '/api/v1/tasks')) == 1
    assert calls.index(('GET', '/api/v1/tasks/preflight/p1/check')) < calls.index(('POST', '/api/v1/assets/upload-ticket'))


def test_workflow_links_resolve_and_default_is_preview():
    from pathlib import Path
    workflow = json.loads((Path(__file__).parents[1] / 'workflows/seedance-product-preflight-v1.comfy.json').read_text())
    nodes = {node['id']: node for node in workflow['nodes']}
    policy = next(node for node in nodes.values() if node['type'] == 'VideoFlowExecutionPolicy')
    assert policy['widgets_values'] == ['preview', False]
    for link_id, source, output, target, inlet, kind in workflow['links']:
        assert link_id in nodes[source]['outputs'][output]['links']
        assert nodes[source]['outputs'][output]['type'] == kind
        assert nodes[target]['inputs'][inlet]['link'] == link_id
        assert nodes[target]['inputs'][inlet]['type'] == kind
