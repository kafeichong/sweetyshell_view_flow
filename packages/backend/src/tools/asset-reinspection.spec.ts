jest.mock('@nestjs/common', () => ({ Injectable: () => () => undefined, Inject: () => () => undefined }));

import { MEDIA_INSPECTOR_VERSION } from '../assets/media-inspector.service';
import { planReinspection, reinspectAssets } from './asset-reinspection';

const craft = (id: string, inspectorVersion: string | null, objectKey = `inputs/${id}`) => ({
  id, objectKey, inspectorVersion,
});

describe('asset reinspection', () => {
  it('treats both a missing and an outdated inspector version as stale', () => {
    const plan = planReinspection([
      craft('current', MEDIA_INSPECTOR_VERSION),
      craft('outdated', '2026-09-15.1'),
      craft('unknown', null),
    ], MEDIA_INSPECTOR_VERSION);

    expect(plan.stale.map((asset) => asset.id)).toEqual(['outdated', 'unknown']);
    expect(plan.upToDate).toBe(1);
  });

  it('does not write anything unless apply is set', async () => {
    const saved: string[] = [];
    const summary = await reinspectAssets([craft('outdated', null)], {
      inspect: async () => ({ kind: 'audio', durationSeconds: 10, audioCodec: 'mp3' }),
      save: async (id) => { saved.push(id); },
    });

    expect(summary).toMatchObject({ scanned: 1, stale: 1, applied: false });
    expect(summary.results).toEqual([{ id: 'outdated', status: 'reinspected' }]);
    expect(saved).toEqual([]);
  });

  it('writes the fresh metadata and the current version when applying', async () => {
    const saved: { id: string; update: unknown }[] = [];
    const summary = await reinspectAssets([craft('outdated', null), craft('ok', MEDIA_INSPECTOR_VERSION)], {
      inspect: async () => ({ kind: 'audio', durationSeconds: 10, audioCodec: 'mp3' }),
      save: async (id, update) => { saved.push({ id, update }); },
      apply: true,
    });

    expect(summary).toMatchObject({ scanned: 2, stale: 1, applied: true });
    expect(saved).toEqual([{
      id: 'outdated',
      update: {
        mediaMetadata: { kind: 'audio', durationSeconds: 10, audioCodec: 'mp3' },
        inspectorVersion: MEDIA_INSPECTOR_VERSION,
      },
    }]);
  });

  it('keeps going when one asset fails to re-inspect', async () => {
    const summary = await reinspectAssets([craft('broken', null), craft('fine', null)], {
      inspect: async (objectKey) => {
        if (objectKey.endsWith('broken')) throw new Error('MEDIA_INSPECTION_FAILED');
        return { kind: 'audio', durationSeconds: 10 };
      },
      save: async () => undefined,
      apply: true,
    });

    expect(summary.results).toEqual([
      { id: 'broken', status: 'failed', reason: 'MEDIA_INSPECTION_FAILED' },
      { id: 'fine', status: 'reinspected' },
    ]);
  });
});
