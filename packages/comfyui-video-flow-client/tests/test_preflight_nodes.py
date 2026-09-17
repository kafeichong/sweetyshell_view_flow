import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
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
    assert n.ReferenceImageInput.IS_CHANGED() != n.ReferenceImageInput.IS_CHANGED()
    assert n.ReferenceVideoInput.IS_CHANGED() != n.ReferenceVideoInput.IS_CHANGED()
    assert n.ReferenceAudioInput.IS_CHANGED() != n.ReferenceAudioInput.IS_CHANGED()
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
    preview_result = n.RequestPreview().check(config, policy, request)
    checked = preview_result['result'][0]
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
    report = json.loads(preview_result['ui']['text'][0])
    assert 'request' not in report
    assert report['effectiveRequest'] == request['intent']
    assert report['mediaTransfer'] == {
        'uploaded': False,
        'willUploadDuringPreview': False,
    }
    assert report['productionAdmission']['blockers'] == [{'code': 'WORKFLOW_NOT_READY'}]
    assert report['quote']['quoteDigest'] == 'quote-digest'


def test_production_without_current_preflight_runs_preview_and_stops_before_upload(tmp_path, monkeypatch):
    request = inputs(tmp_path, monkeypatch)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    policy = n.ExecutionPolicy().execute('production')[0]
    calls = []
    record = {
        'preflightId': 'fresh-preview',
        'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        'willCallProvider': False,
        'willUploadMedia': False,
        'effectiveRequest': request['intent'],
        'requestCheck': {'status': 'passed', 'items': []},
        'productionAdmission': {'canSubmit': True, 'blockers': []},
        'intentDigest': 'intent-digest',
        'quote': {'quoteDigest': 'quote-digest', 'status': 'estimated'},
    }

    class Client:
        def __init__(self, _config):
            self.client = self

        def receipt_store(self, root):
            from receipts import ReceiptStore
            return ReceiptStore(root)

        def _headers(self):
            return {}

        def get_current_task_for_slot(self, execution_slot_id):
            calls.append(('get-current', execution_slot_id))
            return {'executionSlotId': execution_slot_id, 'currentTask': None}

        def post(self, url, **kwargs):
            calls.append(('preview', url, kwargs['json']))
            return SimpleNamespace(status_code=201, json=lambda: record)

        def upload_media(self, *_args, **_kwargs):
            raise AssertionError('invalid preflight must not upload')

    monkeypatch.setattr(n, 'VideoFlowClient', Client)

    checked = n.RequestPreview().check(config, policy, request)['result'][0]
    result = n.CreateTask().submit(
        config,
        policy,
        checked,
        execution_slot_id='slot-1',
    )

    assert result['result'][0] == {
        'mode': 'preview',
        'execution_slot_id': 'slot-1',
        'preflight_id': 'fresh-preview',
        'requires_second_queue': True,
    }
    report = json.loads(result['ui']['text'][0])
    assert '再次 Queue' in report['message']
    assert report['effectiveRequest'] == request['intent']
    assert report['requestCheck']['status'] == 'passed'
    assert report['mediaTransfer']['uploaded'] is False
    assert report['quote']['quoteDigest'] == 'quote-digest'
    assert report['productionAdmission']['canSubmit'] is True
    assert calls == [
        ('get-current', 'slot-1'),
        ('preview', 'https://test/api/v1/tasks/preflight', request['intent']),
    ]
    assert n.store(config).load(n.fingerprint(request['intent']))['preflightId'] == 'fresh-preview'


def test_unknown_mode_rejected_and_production_does_not_use_one_time_confirmation():
    with pytest.raises(ValueError):
        n.ExecutionPolicy().execute('unknown')

    assert n.ExecutionPolicy.INPUT_TYPES()['required'] == {
        'mode': (['preview', 'production'], {'default': 'preview'}),
    }
    assert n.ExecutionPolicy().execute('production') == ({'mode': 'production'},)


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

    assert next(node for node in nodes.values() if node['type'] == 'VideoFlowExecutionPolicy')['widgets_values'] == ['preview']
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
    assert policy['widgets_values'] == ['preview']
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


def test_multi_reference_request_preserves_mixed_media_descriptors():
    media = [
        {'descriptor': {'role': 'reference_image', 'sha256': 'a' * 64}},
        {'descriptor': {'role': 'reference_video', 'sha256': 'b' * 64}},
        {'descriptor': {'role': 'reference_audio', 'sha256': 'c' * 64}},
    ]
    request = n.MultiReferenceRequest().build(media, '文案和全模态参考', 15, '9:16', '1080p')[0]

    assert request['intent']['workflowKey'] == 'seedance.omni-reference.v1'
    assert [item['role'] for item in request['intent']['media']] == [
        'reference_image', 'reference_video', 'reference_audio',
    ]
    assert request['intent']['generation'] == {'duration': 15, 'ratio': '9:16', 'resolution': '1080p',
                                               'generateAudio': True, 'watermark': False, 'outputFormat': 'mp4'}


def test_reference_media_inputs_chain_arbitrary_mixed_items_with_stable_role_slots(tmp_path, monkeypatch):
    for name in ('image-1.png', 'image-2.png', 'clip.mp4', 'sound.wav'):
        (tmp_path / name).write_bytes(name.encode())
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(
        get_input_directory=lambda: str(tmp_path),
        get_annotated_filepath=lambda name: str(tmp_path / name),
    ))
    monkeypatch.setattr(n, 'inspect_media', lambda path, role, slot_id: {
        'path': str(path),
        'descriptor': {'slotId': slot_id, 'role': role, 'sha256': role},
    })

    assert n.ReferenceImageInput.INPUT_TYPES()['optional'] == {
        'reference_media': ('VIDEO_FLOW_LOCAL_MEDIA_LIST',),
    }
    first = n.ReferenceImageInput().inspect('image-1.png')[0]
    video = n.ReferenceVideoInput().inspect('clip.mp4', first)[0]
    second = n.ReferenceImageInput().inspect('image-2.png', video)[0]
    media = n.ReferenceAudioInput().inspect('sound.wav', second)[0]

    assert [item['descriptor']['role'] for item in media] == [
        'reference_image', 'reference_video', 'reference_image', 'reference_audio',
    ]
    assert [item['descriptor']['slotId'] for item in media] == [
        'reference-image-1', 'reference-video-1', 'reference-image-2', 'reference-audio-1',
    ]


def test_unused_reference_slot_passes_the_upstream_list_through_untouched(monkeypatch):
    monkeypatch.setattr(n, 'inspect_product', lambda filename, role, slot_id: {
        'filename': filename,
        'descriptor': {'slotId': slot_id, 'role': role, 'metadata': {}},
    })

    # 槽位留在"（不使用）"时既不该读文件、也不该改动上游列表——创意不需要为了留下
    # 空槽去右键旁路节点或删连线。
    first = n.ReferenceImageInput().inspect('image-1.png')[0]
    skipped_image = n.ReferenceImageInput().inspect(n.UNUSED_MEDIA_CHOICE, first)[0]
    skipped_video = n.ReferenceVideoInput().inspect(n.UNUSED_MEDIA_CHOICE, skipped_image)[0]
    media = n.ReferenceAudioInput().inspect('sound.wav', skipped_video)[0]

    assert skipped_image == first
    assert skipped_video == first
    assert [item['descriptor']['role'] for item in media] == ['reference_image', 'reference_audio']
    assert [item['descriptor']['slotId'] for item in media] == ['reference-image-1', 'reference-audio-1']


def test_unused_choice_comes_first_with_tooltip_and_never_on_fixed_count_image_nodes(tmp_path, monkeypatch):
    (tmp_path / 'image-1.png').write_bytes(b'x')
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(get_input_directory=lambda: str(tmp_path)))

    # 放第一位：ComfyUI 的 COMBO 以第一项为默认值，所以新加的节点、以及模板里多摆的
    # 槽位默认都是空的，不会悄悄带上第一个文件——"没动过 = 没用上"。
    choices, options = n.ReferenceImageInput.INPUT_TYPES()['required']['image']
    assert choices == [n.UNUSED_MEDIA_CHOICE, 'image-1.png']
    # 空槽要有文字说明兜底（官方的 per-input tooltip 位），提示里必须点出"至少一个"。
    assert '至少要有一个参考素材' in options['tooltip']

    # 首帧与首尾帧的图片数量是官方规定的（1 张 / 2 张），不能提供这个选项，
    # 否则用户会以为可以少给一张。
    for cls in (n.FirstFrameInput, n.FirstLastFrameInput):
        for spec in cls.INPUT_TYPES()['required'].values():
            assert n.UNUSED_MEDIA_CHOICE not in spec[0]


def test_text_request_prompt_carries_the_official_writing_guidance():
    # 官方提示词公式与两条硬口径（长度建议、反向描述只对字幕/音频有效）要出现在用户悬停看得到的地方。
    tooltip = n.TextRequest.INPUT_TYPES()['required']['prompt'][1]['tooltip']

    assert '分镜' in tooltip and '镜头 N' in tooltip
    # 骨架里写着【景别】【运镜】，得让用户知道这些格子能填什么词。
    assert '景别' in tooltip and '特写' in tooltip and '运镜' in tooltip and '环绕' in tooltip
    assert '500' in tooltip
    assert '反向' in tooltip and '字幕' in tooltip
    assert n.TextRequest.DESCRIPTION.strip()


def test_multi_reference_warns_that_edit_style_prompts_are_judged_as_another_task_type():
    # 官方明确：模型仍会结合提示词判定任务类型，与提交时指定的不一致就异步失败。
    # 客户端拦不住语义，只能在用户看得到的地方把写法说清楚。
    description = n.MultiReferenceRequest.DESCRIPTION
    prompt_spec = n.MultiReferenceRequest.INPUT_TYPES()['required']['prompt']

    assert '编辑' in description and '延长' in description and '异步失败' in description
    assert 'tooltip' in prompt_spec[1]
    assert '编辑' in prompt_spec[1]['tooltip'] and '延长' in prompt_spec[1]['tooltip']


def test_reference_nodes_carry_descriptions_and_do_not_validate_link_inputs():
    # 三个参考节点与请求节点都要有 DESCRIPTION（官方的节点级说明位），
    # 否则"可以留空"这件事只存在于代码里，用户看不到。
    for cls in (n.ReferenceImageInput, n.ReferenceVideoInput, n.ReferenceAudioInput, n.MultiReferenceRequest):
        assert cls.DESCRIPTION.strip()

    # reference_media 是连线输入，ComfyUI 在**校验阶段**给链接输入传 None
    # （execution.py 的 get_input_data → mark_missing 分支，因为那时还没有节点执行过），
    # 所以这里绝不能有 VALIDATE_INPUTS：有它必然恒报"没有素材"，连给了一张图也一样。
    assert 'VALIDATE_INPUTS' not in n.MultiReferenceRequest.__dict__

    # "一个都没选"改在执行阶段报，文案要能把人指回正确的操作。
    with pytest.raises(ValueError, match='至少需要一个参考素材'):
        n.MultiReferenceRequest().build([], '提示词')


def test_reference_media_inputs_enforce_official_item_limits(monkeypatch):
    monkeypatch.setattr(n, 'inspect_product', lambda filename, role, slot_id: {
        'filename': filename,
        'descriptor': {'slotId': slot_id, 'role': role, 'metadata': {}},
    })

    images = []
    for index in range(30):
        images = n.ReferenceImageInput().inspect(f'image-{index}.png', images)[0]
    assert len(images) == 30
    with pytest.raises(ValueError, match='参考图片最多 30 张'):
        n.ReferenceImageInput().inspect('image-31.png', images)

    videos = []
    for index in range(10):
        videos = n.ReferenceVideoInput().inspect(f'video-{index}.mp4', videos)[0]
    assert len(videos) == 10
    with pytest.raises(ValueError, match='参考视频最多 10 段'):
        n.ReferenceVideoInput().inspect('video-11.mp4', videos)

    audios = []
    for index in range(10):
        audios = n.ReferenceAudioInput().inspect(f'audio-{index}.wav', audios)[0]
    assert len(audios) == 10
    with pytest.raises(ValueError, match='参考音频最多 10 段'):
        n.ReferenceAudioInput().inspect('audio-11.wav', audios)


def test_multi_reference_request_accepts_fifty_items_and_rejects_invalid_collections():
    media = [
        {'descriptor': {'role': 'reference_image', 'slotId': f'reference-image-{index}', 'metadata': {}}}
        for index in range(1, 31)
    ] + [
        {'descriptor': {'role': 'reference_video', 'slotId': f'reference-video-{index}', 'metadata': {'durationSeconds': 3}}}
        for index in range(1, 11)
    ] + [
        {'descriptor': {'role': 'reference_audio', 'slotId': f'reference-audio-{index}', 'metadata': {'durationSeconds': 3}}}
        for index in range(1, 11)
    ]

    request = n.MultiReferenceRequest().build(media, '使用全部参考素材', 30, '16:9', '1080p')[0]
    assert len(request['intent']['media']) == 50

    with pytest.raises(ValueError, match='至少需要一个参考素材'):
        n.MultiReferenceRequest().build([], '没有参考素材')
    with pytest.raises(ValueError, match='参考素材总数最多 50 个'):
        n.MultiReferenceRequest().build(media + [media[0]], '素材超限')


def test_video_edit_request_freezes_official_special_fields_and_requires_video():
    video = {'descriptor': {
        'slotId': 'reference-video-1', 'role': 'reference_video',
        'metadata': {'durationSeconds': 12},
    }}

    request = n.VideoEditRequest().build([video], '只保留主角', '1080p')[0]

    assert request['intent']['workflowKey'] == 'seedance.video-edit.v1'
    assert request['intent']['generation'] == {
        'duration': -1, 'ratio': 'adaptive', 'resolution': '1080p',
        'generateAudio': True, 'watermark': False, 'outputFormat': 'mov',
    }
    assert request['intent']['media'] == [video['descriptor']]

    with pytest.raises(ValueError, match='至少需要一段参考视频'):
        n.VideoEditRequest().build([], '没有视频')
    with pytest.raises(ValueError, match='至少需要一段参考视频'):
        n.VideoEditRequest().build([{'descriptor': {'role': 'reference_image', 'metadata': {}}}], '只有图片')
    with pytest.raises(ValueError, match='编辑输入视频时长必须为 4–30 秒'):
        n.VideoEditRequest().build([{'descriptor': {
            'role': 'reference_video', 'metadata': {'durationSeconds': 3},
        }}], '视频过短')


def test_video_extend_request_freezes_official_special_fields_and_requires_video():
    video = {'descriptor': {
        'slotId': 'reference-video-1', 'role': 'reference_video',
        'metadata': {'durationSeconds': 12},
    }}
    image = {'descriptor': {
        'slotId': 'reference-image-1', 'role': 'reference_image',
        'metadata': {'width': 1280, 'height': 720},
    }}

    request = n.VideoExtendRequest().build(
        [video, image], '向后延长 @video1，让 @image1 中的角色入画', 30, '1080p'
    )[0]

    assert request['intent']['workflowKey'] == 'seedance.video-extend.v1'
    assert request['intent']['generation'] == {
        'duration': 30, 'ratio': 'adaptive', 'resolution': '1080p',
        'generateAudio': True, 'watermark': False, 'outputFormat': 'mov',
    }
    assert request['intent']['media'] == [video['descriptor'], image['descriptor']]
    assert n.VideoExtendRequest.INPUT_TYPES()['required']['duration'][0] == list(range(4, 31))

    with pytest.raises(ValueError, match='至少需要一段参考视频'):
        n.VideoExtendRequest().build([], '向后延长')
    with pytest.raises(ValueError, match='至少需要一段参考视频'):
        n.VideoExtendRequest().build([image], '向后延长')


def test_audio_reference_request_accepts_only_audio_and_exposes_ordinary_generation_fields():
    audios = [
        {'descriptor': {
            'slotId': f'reference-audio-{index}', 'role': 'reference_audio',
            'metadata': {'durationSeconds': 5},
        }}
        for index in range(1, 3)
    ]

    request = n.AudioReferenceRequest().build(audios, '参考两段声音生成画面', 30, '9:16', '1080p')[0]

    assert request['intent']['workflowKey'] == 'seedance.audio-reference-to-video.v1'
    assert request['intent']['generation'] == {
        'duration': 30, 'ratio': '9:16', 'resolution': '1080p',
        'generateAudio': True, 'watermark': False, 'outputFormat': 'mp4',
    }
    assert request['intent']['media'] == [item['descriptor'] for item in audios]
    assert n.AudioReferenceRequest.INPUT_TYPES()['required']['duration'][0] == list(range(4, 31))

    with pytest.raises(ValueError, match='至少需要一段参考音频'):
        n.AudioReferenceRequest().build([], '没有音频')
    with pytest.raises(ValueError, match='只接受参考音频'):
        n.AudioReferenceRequest().build(audios + [{
            'descriptor': {'slotId': 'reference-image-1', 'role': 'reference_image', 'metadata': {}}
        }], '混入图片')


def test_multi_reference_template_is_preview_only():
    from pathlib import Path
    workflow = json.loads((Path(__file__).parents[1] / 'workflows/seedance-multi-reference-preflight-v1.comfy.json').read_text())
    policy = next(node for node in workflow['nodes'] if node['type'] == 'VideoFlowExecutionPolicy')
    assert policy['widgets_values'] == ['preview']
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
    created = False
    def handle(req):
        nonlocal created
        calls.append((req.method, req.url.path))
        if req.url.path.endswith('/preflight'): return httpx.Response(201, json=record)
        if '/slots/' in req.url.path:
            return httpx.Response(200, json={
                'executionSlotId': 'slot-1',
                'currentTask': {'id': 't1', 'clientDeliveryStatus': 'pending'} if created else None,
            })
        if req.url.path.endswith('/check'): return httpx.Response(200, json=record)
        if req.url.path.endswith('/upload-ticket'): return httpx.Response(201, json={'assetId': 'a1', 'alreadyUploaded': True})
        if req.method == 'POST' and req.url.path.endswith('/tasks'):
            body = json.loads(req.content)
            assert body == {
                'mode': 'production',
                'preflightId': 'p1',
                'executionSlotId': 'slot-1',
                'media': [{'slotId': 'reference-image', 'assetId': 'a1'}],
            }
            created = True
            return httpx.Response(201, json={'id': 't1'})
        if req.url.path.endswith('/tasks/t1'): return httpx.Response(200, json={'id': 't1'})
        raise AssertionError(str(req.url))
    monkeypatch.setattr(n, 'VideoFlowClient', lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handle))))
    n.RequestPreview().check(config, n.ExecutionPolicy().execute()[0], request)
    policy = n.ExecutionPolicy().execute('production')[0]
    checked = n.RequestPreview().check(config, policy, request)['result'][0]
    first = n.CreateTask().submit(config, policy, checked, execution_slot_id='slot-1')['result'][0]
    second = n.CreateTask().submit(config, policy, checked, execution_slot_id='slot-1')['result'][0]
    assert first['task_id'] == second['task_id'] == 't1'
    assert first['recovered'] is False
    assert second['recovered'] is True
    assert calls.count(('POST', '/api/v1/assets/upload-ticket')) == 1
    assert calls.count(('POST', '/api/v1/tasks')) == 1
    assert calls.index(('GET', '/api/v1/tasks/slots/slot-1/current')) < calls.index(('GET', '/api/v1/tasks/preflight/p1/check'))
    assert calls.index(('GET', '/api/v1/tasks/preflight/p1/check')) < calls.index(('POST', '/api/v1/assets/upload-ticket'))


def test_confirmed_create_reports_the_task_id_through_the_ui_channel(tmp_path, monkeypatch):
    """成功提交必须带 ui 通道。

    ComfyUI 只在节点返回 `ui` 键时才发 `executed` 事件（execution.py:563），
    缺了它，用户在整个链路里看不到 taskId —— 而报障、查询和重新取片都要用它。
    """
    import httpx
    from client import VideoFlowClient

    request = inputs(tmp_path, monkeypatch)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    record = {
        'preflightId': 'p1', 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        'willCallProvider': False, 'willUploadMedia': False, 'effectiveRequest': request['intent'],
        'requestCheck': {'status': 'passed', 'items': []},
        'productionAdmission': {'canSubmit': True, 'blockers': []},
        'intentDigest': 'intent-digest', 'quote': {'quoteDigest': 'quote-digest', 'status': 'estimated'},
    }

    def handle(req):
        if req.url.path.endswith('/preflight'): return httpx.Response(201, json=record)
        if '/slots/' in req.url.path:
            return httpx.Response(200, json={'executionSlotId': 'slot-1', 'currentTask': None})
        if req.url.path.endswith('/check'): return httpx.Response(200, json=record)
        if req.url.path.endswith('/upload-ticket'):
            return httpx.Response(201, json={'assetId': 'a1', 'alreadyUploaded': True})
        if req.method == 'POST' and req.url.path.endswith('/tasks'):
            return httpx.Response(201, json={'id': 't1', 'executionPlan': {'reserveCny': '7.560000'}})
        raise AssertionError(str(req.url))

    monkeypatch.setattr(
        n, 'VideoFlowClient',
        lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handle))),
    )
    n.RequestPreview().check(config, n.ExecutionPolicy().execute()[0], request)
    policy = n.ExecutionPolicy().execute('production')[0]
    checked = n.RequestPreview().check(config, policy, request)['result'][0]

    submitted = n.CreateTask().submit(config, policy, checked, execution_slot_id='slot-1')

    assert submitted['result'][0]['task_id'] == 't1'
    assert 'ui' in submitted, '成功提交必须带 ui 通道，否则前端收不到 executed 事件'
    lines = submitted['ui']['text']
    assert len(lines) == 1
    notice = lines[0]
    assert 't1' in notice and 'slot-1' in notice and '7.560000' in notice
    # 默认脱敏：不含凭证、URL，也不含提示词原文。
    assert 'token' not in notice
    assert 'http' not in notice
    assert request['intent']['prompt']['positive'] not in notice


def test_existing_slot_task_recovers_before_expired_preflight_or_current_admission(tmp_path, monkeypatch):
    request = inputs(tmp_path, monkeypatch)
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    calls = []

    class Client:
        def __init__(self, _config):
            pass

        def receipt_store(self, root):
            from receipts import ReceiptStore
            return ReceiptStore(root)

        def get_current_task_for_slot(self, execution_slot_id):
            calls.append(('get-current', execution_slot_id))
            return {
                'executionSlotId': execution_slot_id,
                'currentTask': {
                    'id': 'task-paid-1',
                    'status': 'running',
                    'clientDeliveryStatus': 'pending',
                },
            }

        def upload_media(self, *_args, **_kwargs):
            raise AssertionError('recovery must not upload media')

        def create_task_with_receipt(self, **_kwargs):
            raise AssertionError('recovery must not create another task')

    monkeypatch.setattr(n, 'VideoFlowClient', Client)
    n.store(config).save(n.fingerprint(request['intent']), {
        'preflightId': 'expired-preflight',
        'expiresAt': '2000-01-01T00:00:00+00:00',
        'productionAdmission': {'canSubmit': False, 'blockers': [{'code': 'PRODUCTION_PAUSED'}]},
    })
    policy = n.ExecutionPolicy().execute('production')[0]

    checked = n.RequestPreview().check(config, policy, request)['result'][0]
    result = n.CreateTask().submit(
        config,
        policy,
        checked,
        generation_version=1,
        execution_slot_id='slot-1',
    )['result'][0]

    assert result == {
        'mode': 'production',
        'task_id': 'task-paid-1',
        'execution_slot_id': 'slot-1',
        'recovered': True,
    }
    assert calls == [('get-current', 'slot-1')]


def test_workflow_links_resolve_and_default_is_preview():
    from pathlib import Path
    # 用连线最多的那条（全模态参考）当样本：它同时覆盖素材链与预检/提交链。
    workflow = json.loads((Path(__file__).parents[1] / 'workflows/seedance-multi-reference-preflight-v1.comfy.json').read_text())
    nodes = {node['id']: node for node in workflow['nodes']}
    policy = next(node for node in nodes.values() if node['type'] == 'VideoFlowExecutionPolicy')
    assert policy['widgets_values'] == ['preview']
    for link_id, source, output, target, inlet, kind in workflow['links']:
        assert link_id in nodes[source]['outputs'][output]['links']
        assert nodes[source]['outputs'][output]['type'] == kind
        assert nodes[target]['inputs'][inlet]['link'] == link_id
        assert nodes[target]['inputs'][inlet]['type'] == kind


def test_each_current_template_has_its_own_persistent_execution_slot():
    from pathlib import Path

    workflow_root = Path(__file__).parents[1] / 'workflows'
    # 按目录取而不是写死清单：新增模板时这条自动覆盖，退休的模板（参考图那条）不会漏在名单里。
    names = sorted(path.name for path in workflow_root.glob('*-preflight-v1.comfy.json'))
    assert len(names) == 8, names
    slots = []

    for name in names:
        workflow = json.loads((workflow_root / name).read_text())
        create = next(node for node in workflow['nodes'] if node['type'] == 'VideoFlowConfirmedCreate')
        slot_id, generation_version = create['widgets_values']
        assert slot_id.startswith('slot-template-')
        assert generation_version == 1
        slots.append(slot_id)

    assert len(slots) == len(set(slots))


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


def test_download_persists_verified_file_before_confirmation_and_retries_original_task(tmp_path, monkeypatch):
    from pathlib import Path
    from receipts import ReceiptStore

    output = tmp_path / 'output'
    output.mkdir()
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(
        get_output_directory=lambda: str(output),
    ))
    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    receipts = ReceiptStore(config.receipt_dir)
    calls = []

    class Client:
        def __init__(self, _config):
            pass

        def receipt_store(self, root):
            assert root == config.receipt_dir
            return receipts

        def download_task_result(self, task_id, output_dir):
            calls.append(('download', task_id))
            path = Path(output_dir) / 'task-1.mp4'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'verified-video')
            return {
                'taskId': task_id,
                'assetId': 'asset-1',
                'mimeType': 'video/mp4',
                'sizeBytes': len(b'verified-video'),
                'sha256': 'a36c654f80c9638143e35ed8133c0e877ee2991b598003e3d5fd992f99984cc7',
                'localPath': str(path),
            }

        def confirm_client_delivery(self, task_id):
            calls.append(('confirm', task_id))
            saved = receipts.load('slot:slot-1')
            assert saved['localDeliveryStatus'] == 'downloaded'
            assert Path(saved['localPath']).read_bytes() == b'verified-video'
            if calls.count(('confirm', task_id)) == 1:
                raise RuntimeError('temporary confirmation failure')
            return {'taskId': task_id, 'clientDeliveryStatus': 'delivered'}

    monkeypatch.setattr(n, 'VideoFlowClient', Client)
    task = {
        'mode': 'production',
        'task_id': 'task-1',
        'execution_slot_id': 'slot-1',
        'recovered': True,
    }

    with pytest.raises(RuntimeError, match='confirmation failure'):
        n.DownloadResult().download(config, task)

    assert receipts.load('slot:slot-1')['localDeliveryStatus'] == 'downloaded'
    result = n.DownloadResult().download(config, task)

    assert result['result'] == (str(output / 'video-flow' / 'task-1.mp4'),)
    assert calls == [
        ('download', 'task-1'),
        ('confirm', 'task-1'),
        ('confirm', 'task-1'),
    ]
    assert receipts.load('slot:slot-1')['localDeliveryStatus'] == 'confirmed'


def test_delivered_slot_starts_a_new_idempotent_round_with_the_same_preflight(tmp_path, monkeypatch):
    import httpx
    from client import VideoFlowClient
    from submission_state import record_confirmed, record_downloaded

    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    request = n.TextRequest().build('同一提示词连续生成两个版本', 5, '16:9', '720p')[0]
    record = {
        'preflightId': 'p1',
        'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        'willCallProvider': False,
        'willUploadMedia': False,
        'effectiveRequest': request['intent'],
        'requestCheck': {'status': 'passed', 'items': []},
        'productionAdmission': {'canSubmit': True, 'blockers': []},
        'intentDigest': 'intent-digest',
        'quote': {'quoteDigest': 'quote-digest', 'status': 'estimated'},
    }
    submitted_keys = []

    def handle(req):
        if '/slots/' in req.url.path:
            return httpx.Response(200, json={'executionSlotId': 'slot-1', 'currentTask': None})
        if req.url.path.endswith('/check'):
            return httpx.Response(200, json=record)
        if req.method == 'POST' and req.url.path.endswith('/tasks'):
            submitted_keys.append(req.headers['idempotency-key'])
            return httpx.Response(201, json={'id': f'task-{len(submitted_keys)}'})
        if req.url.path.endswith('/tasks/task-1'):
            return httpx.Response(200, json={'id': 'task-1', 'clientDeliveryStatus': 'delivered'})
        raise AssertionError(str(req.url))

    monkeypatch.setattr(
        n,
        'VideoFlowClient',
        lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handle))),
    )
    n.store(config).save(n.fingerprint(request['intent']), record)
    policy = n.ExecutionPolicy().execute('production')[0]
    checked = n.RequestPreview().check(config, policy, request)['result'][0]

    first = n.CreateTask().submit(config, policy, checked, execution_slot_id='slot-1')['result'][0]
    receipts = VideoFlowClient(config).receipt_store(config.receipt_dir)
    local = tmp_path / 'task-1.mp4'
    local.write_bytes(b'first-version')
    record_downloaded(receipts, 'slot-1', 'task-1', {
        'localPath': str(local),
        'sha256': '8b943375b74c94187dc51dc5a2e225d508f4974b4e388cc5200c787e8df159b0',
        'sizeBytes': len(b'first-version'),
        'assetId': 'asset-1',
        'mimeType': 'video/mp4',
    })
    record_confirmed(receipts, 'slot-1', 'task-1')

    second = n.CreateTask().submit(config, policy, checked, execution_slot_id='slot-1')['result'][0]

    assert first['task_id'] == 'task-1'
    assert second['task_id'] == 'task-2'
    assert len(submitted_keys) == 2
    assert submitted_keys[0] != submitted_keys[1]
    current_receipt = receipts.load('slot:slot-1')
    assert current_receipt['taskId'] == 'task-2'
    assert current_receipt['originalRequest'] == request['intent']
    assert current_receipt['body'] == {
        'mode': 'production',
        'preflightId': 'p1',
        'executionSlotId': 'slot-1',
        'media': [],
    }


def _file_picker(spec):
    """把两种下拉写法都读成 (选项列表, 附加键)，不是文件选择器就返回 (None, None)。

    两种写法前端都认：老式 `[选项列表, {...}]`（`isComboInputSpecV1`），
    V3 `("COMBO", {"options": [...], ...})`（`getComboSpecComboOptions`）。
    """
    if isinstance(spec[0], list):
        return spec[0], (spec[1] if len(spec) > 1 else {})
    if spec[0] == 'COMBO':
        options = spec[1] or {}
        return options.get('options', []), options
    return None, None


def test_every_file_picking_widget_offers_an_upload(tmp_path, monkeypatch):
    """"选文件"的槽位都得给出把本机文件传进来的办法，但图片/视频和音频走的不是一条路。

    真事：图片节点一直有 `image_upload`，视频漏了，用户报"视频不能上传只能选择"；补上
    `video_upload` 后视频槽出现上传按钮（(`"COMBO"`, {...}) 写法不会丢选项列表，
    `getComboSpecComboOptions` 会从第二个元素里取 options）。

    音频**不能**照抄：前端那条 `audio_upload` 路是写给 LoadAudio 那一族的——它注入的
    AUDIOUPLOAD widget 会去找只有那一族才有的 `audioUI`，我们这种自定义节点上直接抛错；
    另一条注入路（useImageUploadWidget）只认 image_upload / video_upload，明确不认
    audio_upload。所以音频槽刻意不带标志，按钮由 web/audio_upload.js 自己加——两件事
    都要在这里盯住，否则下次很容易有人"顺手统一一下"又把它改回标志。
    """
    (tmp_path / "clip.mp4").write_bytes(b"x")
    monkeypatch.setitem(__import__('sys').modules, 'folder_paths', SimpleNamespace(
        get_input_directory=lambda: str(tmp_path),
        get_annotated_filepath=lambda name: str(tmp_path / name),
    ))

    # 文件选择器的标志：选项里带占位符或「不给素材」哨兵；非文件参数（时长/比例/分辨率）没有。
    FILE_MARKERS = ("（不给素材）", "请选择")
    pickers = []
    for name, cls in sorted(n.CLASSES.items()):
        for key, spec in cls.INPUT_TYPES().get('required', {}).items():
            options, extra = _file_picker(spec)
            if not options or not any(
                isinstance(option, str) and any(marker in option for marker in FILE_MARKERS)
                for option in options
            ):
                continue
            pickers.append(f'{name}.{key}')
            if cls is n.ReferenceAudioInput:
                assert not extra.get('audio_upload'), (
                    '音频槽不该带 audio_upload：前端那条注入路会去取我们节点上没有的 audioUI 后抛错'
                )
            else:
                assert any(k.endswith('_upload') for k in extra), f'{name}.{key} 是文件选择器但没有上传标志'

    # 首帧/首尾帧×2/产品图 + 参考音频/参考图/参考视频：少一个就说明漏了
    assert pickers == [
        # 上传入库的那个槽位真的在选本机文件，所以它**是**文件选择器，必须有上传标志。
        'VideoFlowArkUploadInput.image',
        'VideoFlowFirstFrameInput.image',
        'VideoFlowFirstLastFrameInput.first_image',
        'VideoFlowFirstLastFrameInput.last_image',
        'VideoFlowProductInput.image',
        'VideoFlowReferenceAudioInput.audio',
        'VideoFlowReferenceImageInput.image',
        'VideoFlowReferenceVideoInput.video',
    ], pickers

    # 音频槽的按钮改由扩展提供：文件要在，要挂在音频节点上，要走通用上传入口。
    extension = Path(n.__file__).with_name('web') / 'audio_upload.js'
    assert extension.is_file(), '音频上传按钮的扩展丢了，音频槽就没有上传功能了'
    source = extension.read_text(encoding='utf-8')
    assert 'VideoFlowReferenceAudioInput' in source, '扩展没挂到音频节点上'
    assert '/upload/image' in source, '扩展没有走 ComfyUI 的通用上传入口'
    # 只查代码，注释里可以随便解释这条规矩（这一行下面的断言就是例子）。
    code = "\n".join(line.split("//")[0] for line in source.splitlines())
    # 盯的是**语义**不是那个单词在不在：显式写 `= false` 与完全不写等价（都是 falsy，
    # 都渲染），真要命的是写成真值。原先按子串判，被一句 `options.canvasOnly = false`
    # 误伤过一次——那句是修按钮可见性时加的，注释里同时写着"不能带 canvasOnly"。
    for line in code.splitlines():
        if 'canvasOnly' in line:
            assert 'true' not in line.lower(), (
                '按钮的 canvasOnly 被设成真值就只会在经典画布里显示：Nodes 2.0 的 '
                'widgetRegistry 用 `!options.canvasOnly && !!widget.type` 决定渲不渲染'
            )


def test_admission_failure_names_the_blockers_instead_of_a_bare_message():
    """被闸门挡下时，报错要带服务端给的原因码，不能只说"不满足条件"。

    真事：纯音频那条工作流还没开放，用户在 Production 下只看到"当前不满足正式提交条件"，
    得自己去翻检查报告里的 JSON 才知道是 WORKFLOW_NOT_READY + WORKFLOW_NOT_ENABLED
    （V2_FULL_CHAIN_NOT_COMPLETE）——而被挡下的原因决定了他该找谁、下一步做什么。
    """
    record = {
        "productionAdmission": {
            "canSubmit": False,
            "blockers": [
                {"code": "WORKFLOW_NOT_READY", "message": "WORKFLOW_NOT_READY", "path": "workflowKey", "status": "failed"},
                {"code": "WORKFLOW_NOT_ENABLED", "message": "V2_FULL_CHAIN_NOT_COMPLETE", "path": "workflowKey", "status": "failed"},
                # 只有码、没有原因的条目也要能写出来，不能变成 "None"
                {"code": "QUOTE_UNAVAILABLE", "status": "failed"},
            ],
        },
    }

    assert n.admission_blockers(record) == [
        "WORKFLOW_NOT_READY",
        "WORKFLOW_NOT_ENABLED(V2_FULL_CHAIN_NOT_COMPLETE)",
        "QUOTE_UNAVAILABLE",
    ]
    # 没有 blockers 字段时不要乱写，退回原来的那句话。
    assert n.admission_blockers({}) == []


# ---- 素材库素材（asset://）----
# 含真人人脸的参考素材只能走素材库：直传 URL 会被方舟输入审核拦下。所以这个槽位
# 不读本地文件，descriptor 的每个字段都由服务端登记时给出。

ARK_ASSET_ID = 'asset-20260917115246-cgmtw'
ARK_REGISTERED = {
    'assetId': 'ours-1',
    'arkAssetId': ARK_ASSET_ID,
    'sha256': 'c' * 64,
    'mimeType': 'image/png',
    'sizeBytes': 512219,
    'metadata': {'kind': 'image', 'width': 800, 'height': 1600},
}


def _ark_backend(monkeypatch, assets=None, registered=None, calls=None):
    """把节点用的客户端换成假的；记录每次调用的路径，便于断言"没有上传"。"""
    import httpx
    from client import VideoFlowClient

    calls = calls if calls is not None else []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == '/api/v1/assets/ark' and request.method == 'GET':
            return httpx.Response(200, json={'assets': assets if assets is not None else [
                {'id': ARK_ASSET_ID, 'name': '005', 'assetType': 'Image', 'status': 'Active',
                 'groupId': 'group-1', 'projectName': 'default'},
                # 非 Active 与非图片不该出现在下拉里：选了也用不了。
                {'id': 'asset-processing', 'name': '处理中', 'assetType': 'Image', 'status': 'Processing'},
                {'id': 'asset-video', 'name': '一段视频', 'assetType': 'Video', 'status': 'Active'},
            ]})
        if request.url.path == '/api/v1/assets/ark' and request.method == 'POST':
            return httpx.Response(201, json=registered if registered is not None else ARK_REGISTERED)
        return httpx.Response(404, json={'message': 'unexpected'})

    monkeypatch.setattr(n, 'VideoFlowClient', lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handler))))
    # 选项有缓存，测试之间必须清掉，否则后一条用例看到前一条的列表。
    monkeypatch.setattr(n, '_ARK_CHOICES_CACHE', {'at': 0.0, 'options': None})
    return calls


def test_ark_slot_passes_through_when_unused():
    assert n.ArkAssetInput().inspect(n.ARK_UNUSED_CHOICE, None) == ([],)


def test_ark_slot_puts_the_backend_supplied_fields_into_the_descriptor(tmp_path, monkeypatch):
    """descriptor 必须与服务端登记后的 Asset 行逐字段一致，否则正式提交会被
    PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉——而那时钱已经准备好花了。"""
    _ark_backend(monkeypatch)
    media = n.ArkAssetInput().inspect(f'005 · {ARK_ASSET_ID}', None)[0]

    assert len(media) == 1
    descriptor = media[0]['descriptor']
    assert descriptor == {
        'slotId': 'reference-image-1',
        'role': 'reference_image',
        'sha256': 'c' * 64,
        'mimeType': 'image/png',
        'sizeBytes': 512219,
        'metadata': {'kind': 'image', 'width': 800, 'height': 1600},
        'arkAssetId': ARK_ASSET_ID,
    }
    # 这两项是"这份素材不在本机上"的标记，正式提交要靠它跳过上传。
    assert media[0]['ark_asset_id'] == ARK_ASSET_ID
    assert media[0]['asset_id'] == 'ours-1'


def test_ark_slot_refuses_when_the_backend_omits_a_field_the_descriptor_needs(monkeypatch):
    _ark_backend(monkeypatch, registered={k: v for k, v in ARK_REGISTERED.items() if k != 'sha256'})

    with pytest.raises(ValueError) as error:
        n.ArkAssetInput().inspect(f'005 · {ARK_ASSET_ID}', None)
    assert 'sha256' in str(error.value)


def test_ark_choices_keep_the_sentinel_first_even_when_the_library_is_unreachable(monkeypatch):
    """读不到素材库时，模板里存过的值仍必须有效——否则导入那张画布会
    被前端判成「输入值不可用」。"""
    import httpx
    from client import VideoFlowClient

    def boom(request):
        raise httpx.ConnectError('素材库不可达')

    monkeypatch.setattr(n, 'VideoFlowClient', lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(boom))))
    monkeypatch.setattr(n, '_ARK_CHOICES_CACHE', {'at': 0.0, 'options': None})

    options = n.ark_asset_choices()
    assert options[0] == n.ARK_UNUSED_CHOICE
    assert len(options) == 2 and '读取失败' in options[1]


def test_ark_choices_list_only_active_images_and_never_look_like_a_file_picker(monkeypatch):
    _ark_backend(monkeypatch)
    options = n.ark_asset_choices()

    assert options[0] == n.ARK_UNUSED_CHOICE
    assert options[1] == f'005 · {ARK_ASSET_ID}'
    assert len(options) == 2, options  # 处理中的、非图片的都不该出现
    # 文件选择器是靠这两个子串识别的；撞上就会被要求带上传标志，而素材库槽位不该有。
    assert not any(marker in option for option in options for marker in ('（不给素材）', '请选择'))


def test_ark_selection_fails_loudly_instead_of_uploading_a_local_file(tmp_path, monkeypatch):
    calls = _ark_backend(monkeypatch)

    with pytest.raises(ValueError) as error:
        n.ArkAssetInput().inspect(f'{n.ARK_LIST_UNAVAILABLE_PREFIX}，稍后重试：素材库不可达）', None)
    assert '读不到素材库' in str(error.value)
    assert calls == []


def test_confirmed_submission_binds_a_library_asset_without_uploading_anything(tmp_path, monkeypatch):
    """素材库素材没有本地文件可读，正式提交必须**直接绑定**登记好的那条 Asset：
    既不读文件，也不再上传一次。多传一次不只是浪费，还会在预检的逐字段比对上对不齐。"""
    import httpx
    from client import VideoFlowClient

    seen = []
    record_holder = {}

    def handle(req):
        seen.append((req.method, req.url.path))
        if req.url.path == '/api/v1/assets/ark' and req.method == 'GET':
            return httpx.Response(200, json={'assets': [
                {'id': ARK_ASSET_ID, 'name': '005', 'assetType': 'Image', 'status': 'Active',
                 'groupId': 'g1', 'projectName': 'default'},
            ]})
        if req.url.path == '/api/v1/assets/ark' and req.method == 'POST':
            return httpx.Response(201, json=ARK_REGISTERED)
        if req.url.path.endswith('/preflight'):
            return httpx.Response(201, json=record_holder['record'])
        if '/slots/' in req.url.path:
            return httpx.Response(200, json={'executionSlotId': 'slot-ark', 'currentTask': None})
        if req.url.path.endswith('/check'):
            return httpx.Response(200, json=record_holder['record'])
        if req.method == 'POST' and req.url.path.endswith('/tasks'):
            record_holder['submitted'] = req.content.decode('utf-8')
            return httpx.Response(201, json={'id': 'task-ark-1', 'executionPlan': {'reserveCny': '6.111000'}})
        raise AssertionError(f'这条用例不该打到 {req.url.path}')

    monkeypatch.setattr(n, '_ARK_CHOICES_CACHE', {'at': 0.0, 'options': None})
    monkeypatch.setattr(n, 'VideoFlowClient', lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handle))))

    config = VideoFlowConfig('https://test', 'token', receipt_dir=str(tmp_path / 'receipts'))
    media = n.ArkAssetInput().inspect(f'005 · {ARK_ASSET_ID}', None)[0]
    intent = {
        'contractVersion': 2,
        'workflowKey': 'seedance.omni-reference.v1',
        'prompt': {'positive': '素材库人像口播'},
        'generation': n.generation_request(4, '9:16', '720p'),
        'media': [item['descriptor'] for item in media],
    }
    request = {'intent': intent, 'media': media}
    record_holder['record'] = {
        'preflightId': 'p-ark', 'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        'willCallProvider': False, 'willUploadMedia': False, 'effectiveRequest': intent,
        'requestCheck': {'status': 'passed', 'items': []},
        'productionAdmission': {'canSubmit': True, 'blockers': []},
        'intentDigest': 'd', 'quote': {'quoteDigest': 'q', 'status': 'estimated'},
    }

    # 先 Preview 一次：正式提交是从回执里读那条预检记录的（既有链路就是这么走的）。
    n.RequestPreview().check(config, n.ExecutionPolicy().execute()[0], request)
    policy = n.ExecutionPolicy().execute('production')[0]
    checked = n.RequestPreview().check(config, policy, request)['result'][0]
    submitted = n.CreateTask().submit(config, policy, checked, execution_slot_id='slot-ark')

    assert submitted['result'][0]['task_id'] == 'task-ark-1'
    # 关键：**没有**走上传票据那条路。
    assert not any(path.endswith('/upload-ticket') for _, path in seen), seen
    # 绑定的是登记时那一条我方 Asset，槽位来自 descriptor。
    payload = json.loads(record_holder['submitted'])
    assert payload['media'] == [{'slotId': 'reference-image-1', 'assetId': 'ours-1'}]


def test_ark_upload_publishes_the_local_file_and_returns_a_usable_asset(tmp_path, monkeypatch):
    """本机文件 → 我方存储 → 推给方舟入库，产出的槽位直接能接请求节点。

    含真人人脸的参考素材只能走素材库，没有这个入口创意就得先去控制台传一次。
    """
    import sys
    import httpx
    from client import VideoFlowClient

    path = tmp_path / 'look.png'
    Image.new('RGB', (500, 500)).save(path)
    monkeypatch.setitem(sys.modules, 'folder_paths', SimpleNamespace(
        get_input_directory=lambda: str(tmp_path),
        get_annotated_filepath=lambda _: str(path),
    ))

    seen = []

    def handle(req):
        seen.append((req.method, req.url.path))
        if req.url.path.endswith('/upload-ticket'):
            # 内容寻址：同一个文件第二次 Queue 会命中这里，不会再传一次。
            return httpx.Response(201, json={'assetId': 'a1', 'alreadyUploaded': True, 'inspectionStatus': 'verified'})
        if req.url.path.endswith('/assets/ark/publish'):
            return httpx.Response(201, json={'assetId': 'a1', 'arkAssetId': ARK_ASSET_ID, 'arkGroupId': 'g1'})
        raise AssertionError(f'不该打到 {req.url.path}')

    monkeypatch.setattr(n, 'VideoFlowClient', lambda cfg: VideoFlowClient(cfg, httpx.Client(transport=httpx.MockTransport(handle))))

    media = n.ArkUploadInput().inspect('look.png', None)[0]

    assert media[0]['ark_asset_id'] == ARK_ASSET_ID
    assert media[0]['asset_id'] == 'a1'
    assert media[0]['descriptor']['arkAssetId'] == ARK_ASSET_ID
    # descriptor 的字段来自**本机检查**，服务端会用自己的检查逐字段比对——两边同源才对得上。
    assert media[0]['descriptor']['sha256'] == n.inspect_product('look.png')['descriptor']['sha256']
    assert any(p.endswith('/assets/ark/publish') for _, p in seen), seen


def test_ark_upload_passes_through_when_unused():
    assert n.ArkUploadInput().inspect(n.UNUSED_MEDIA_CHOICE, None) == ([],)
