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


def test_comfyui_image_input_uses_shared_inspector_without_retaining_file_bytes(tmp_path, monkeypatch):
    path = tmp_path / 'product.png'
    Image.new('RGB', (500, 500)).save(path)
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(
        get_input_directory=lambda: str(tmp_path),
        get_annotated_filepath=lambda _: str(path),
    ))

    inspected = n.inspect_product('product.png', 'first_frame', 'first-frame')

    assert inspected['path'] == str(path.resolve())
    assert 'data' not in inspected
    assert inspected['descriptor']['slotId'] == 'first-frame'
    assert inspected['descriptor']['role'] == 'first_frame'


def test_all_image_input_nodes_force_same_filename_to_be_reinspected():
    assert n.ProductInput.IS_CHANGED() != n.ProductInput.IS_CHANGED()
    assert n.MultiReferenceInput.IS_CHANGED() != n.MultiReferenceInput.IS_CHANGED()
    assert n.FirstFrameInput.IS_CHANGED() != n.FirstFrameInput.IS_CHANGED()
    assert n.FirstLastFrameInput.IS_CHANGED() != n.FirstLastFrameInput.IS_CHANGED()


def test_preview_only_sends_descriptors_and_skips_paid_chain(tmp_path, monkeypatch):
    request = inputs(tmp_path, monkeypatch)
    calls = []
    record = {'preflightId': 'p1', 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
              'willCallProvider': False, 'willUploadMedia': False, 'effectiveRequest': request['intent'],
              'requestCheck': {'status': 'passed', 'items': []},
              'productionAdmission': {'canSubmit': False, 'blockers': [{'code': 'WORKFLOW_NOT_READY'}]},
              'intentDigest': 'intent-digest', 'quote': {'quoteDigest': 'quote-digest', 'status': 'unavailable'}}
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
    assert calls[0][1]['contractVersion'] == 2
    assert set(calls[0][1]['media'][0]) == {'slotId', 'sha256', 'role', 'mimeType', 'sizeBytes', 'metadata'}
    assert 'data' not in json.dumps(calls[0][1]).replace('metadata', '')
    assert 'path' not in json.dumps(calls[0][1])


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


def test_product_request_exposes_creative_generation_options():
    inputs = n.ProductRequest.INPUT_TYPES()['required']

    assert inputs['duration'][0] == list(range(4, 31))
    assert inputs['ratio'][0] == ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
    assert inputs['resolution'][0] == ['480p', '720p', '1080p']


def test_text_request_builds_prompt_only_workflow_intent():
    request = n.TextRequest().build('一只猫在草地上奔跑', 30, '9:16', '1080p')[0]['intent']

    assert request['workflowKey'] == 'seedance.text-to-video.v1'
    assert request['media'] == []
    assert request['contractVersion'] == 2
    assert request['generation'] == {'duration': 30, 'ratio': '9:16', 'resolution': '1080p',
                                     'generateAudio': True, 'watermark': False, 'outputFormat': 'mp4'}


def test_text_to_video_template_is_preview_only_and_has_no_media_input():
    from pathlib import Path
    workflow = json.loads((Path(__file__).parents[1] / 'workflows/seedance-text-to-video-preflight-v1.comfy.json').read_text())
    nodes = {node['id']: node for node in workflow['nodes']}

    assert next(node for node in nodes.values() if node['type'] == 'VideoFlowExecutionPolicy')['widgets_values'] == ['preview', False]
    assert next(node for node in nodes.values() if node['type'] == 'VideoFlowTextRequest')['type'] == 'VideoFlowTextRequest'
    assert not any(node['type'] == 'VideoFlowProductInput' for node in nodes.values())


@pytest.mark.parametrize('name, request_type, input_type', [
    ('seedance-first-frame-to-video-preflight-v1.comfy.json', 'VideoFlowFirstFrameRequest', 'VideoFlowFirstFrameInput'),
    ('seedance-first-last-frame-to-video-preflight-v1.comfy.json', 'VideoFlowFirstLastFrameRequest', 'VideoFlowFirstLastFrameInput'),
])
def test_frame_workflow_templates_are_preview_only_and_connected(name, request_type, input_type):
    from pathlib import Path
    workflow = json.loads((Path(__file__).parents[1] / 'workflows' / name).read_text())
    nodes = {node['id']: node for node in workflow['nodes']}
    policy = next(node for node in nodes.values() if node['type'] == 'VideoFlowExecutionPolicy')
    assert policy['widgets_values'] == ['preview', False]
    assert any(node['type'] == request_type for node in nodes.values())
    assert any(node['type'] == input_type for node in nodes.values())
    for link_id, source, output, target, inlet, kind in workflow['links']:
        assert link_id in nodes[source]['outputs'][output]['links']
        assert nodes[source]['outputs'][output]['type'] == kind
        assert nodes[target]['inputs'][inlet]['link'] == link_id


def test_first_and_last_frame_requests_preserve_media_roles_and_order(tmp_path, monkeypatch):
    first = {'descriptor': {'role': 'first_frame', 'sha256': 'a' * 64}}
    last = {'descriptor': {'role': 'last_frame', 'sha256': 'b' * 64}}

    request = n.FirstLastFrameRequest().build(first, last, '从第一帧过渡到最后一帧', 30, 'adaptive', '1080p')[0]['intent']

    assert request['workflowKey'] == 'seedance.first-last-frame-to-video.v1'
    assert [item['role'] for item in request['media']] == ['first_frame', 'last_frame']
    assert request['generation'] == {'duration': 30, 'ratio': 'adaptive', 'resolution': '1080p',
                                     'generateAudio': True, 'watermark': False, 'outputFormat': 'mp4'}


def test_multi_reference_request_preserves_all_reference_image_descriptors():
    media = [
        {'descriptor': {'role': 'reference_image', 'sha256': 'a' * 64}},
        {'descriptor': {'role': 'reference_image', 'sha256': 'b' * 64}},
    ]
    request = n.MultiReferenceRequest().build(media, '文案和两张参考图', 15, '9:16', '1080p')[0]

    assert request['intent']['workflowKey'] == 'seedance.omni-reference.v1'
    assert len(request['intent']['media']) == 2
    assert all(item['role'] == 'reference_image' for item in request['intent']['media'])
    assert request['intent']['generation'] == {'duration': 15, 'ratio': '9:16', 'resolution': '1080p',
                                               'generateAudio': True, 'watermark': False, 'outputFormat': 'mp4'}


def test_multi_reference_template_is_preview_only():
    from pathlib import Path
    workflow = json.loads((Path(__file__).parents[1] / 'workflows/seedance-multi-reference-preflight-v1.comfy.json').read_text())
    policy = next(node for node in workflow['nodes'] if node['type'] == 'VideoFlowExecutionPolicy')
    assert policy['widgets_values'] == ['preview', False]
    assert any(node['type'] == 'VideoFlowMultiReferenceRequest' for node in workflow['nodes'])


def test_confirmed_submission_reuses_receipt_without_uploading_again(tmp_path, monkeypatch):
    import httpx
    from client import VideoFlowClient
    request = inputs(tmp_path, monkeypatch)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    calls = []
    record = {'preflightId': 'p1', 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
              'willCallProvider': False, 'willUploadMedia': False, 'effectiveRequest': request['intent'],
              'requestCheck': {'status': 'passed', 'items': []},
              'productionAdmission': {'canSubmit': True, 'blockers': []},
              'intentDigest': 'intent-digest', 'quote': {'quoteDigest': 'quote-digest', 'status': 'estimated'}}
    def handle(req):
        calls.append((req.method, req.url.path))
        if req.url.path.endswith('/preflight'): return httpx.Response(201, json=record)
        if req.url.path.endswith('/check'): return httpx.Response(200, json=record)
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


def test_policy_preview_returns_comfyui_video_player_payload(tmp_path, monkeypatch):
    output = tmp_path / 'output'
    video = output / 'video-flow' / 'task.mp4'
    video.parent.mkdir(parents=True)
    video.write_bytes(b'video')
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(get_output_directory=lambda: str(output)))

    result = n.PolicyPreview().preview(str(video))

    assert result['result'] == (str(video),)
    assert result['ui']['images'] == [{'filename': 'task.mp4', 'subfolder': 'video-flow', 'type': 'output'}]
    assert result['ui']['animated'] == (True,)


def test_policy_preview_rejects_video_outside_comfyui_output(tmp_path, monkeypatch):
    output = tmp_path / 'output'
    video = tmp_path / 'outside.mp4'
    video.write_bytes(b'video')
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(get_output_directory=lambda: str(output)))

    with pytest.raises(ValueError, match='output'):
        n.PolicyPreview().preview(str(video))


def test_policy_preview_without_video_only_shows_message():
    result = n.PolicyPreview().preview('')

    assert result['result'] == ('',)
    assert '未生成视频' in result['ui']['text'][0]
