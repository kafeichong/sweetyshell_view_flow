import { Injectable, Logger } from '@nestjs/common';
import { appendFile, chmod, mkdir, readdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';

export const REDACTED = '[redacted]';
export const EVIDENCE_MISSING = 'evidence_missing';

const SENSITIVE_WORDS = new Set([
  'token',
  'authorization',
  'auth',
  'prompt',
  'password',
  'passwd',
  'secret',
  'credential',
  'credentials',
  'signature',
  'apikey',
]);

const EVENTS_FILE_PREFIX = 'events-';
const EVENTS_FILE_SUFFIX = '.jsonl';

function keyWords(key: string): string[] {
  return key
    .split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  if (keyWords(key).some((word) => SENSITIVE_WORDS.has(word))) {
    return true;
  }
  const compact = key.replace(/[_-]/g, '').toLowerCase();
  return compact === 'apikey' || compact === 'accesstoken';
}

/** URL 只留 scheme/host/path：query 与 fragment 常带签名或 token。 */
export function stripUrlSecrets(value: string): string {
  if (!value.includes('://')) {
    return value;
  }
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return REDACTED;
  }
}

/** 递归脱敏：敏感键整字段替换，URL 去 query，其余原样保留。 */
export function sanitizeEvent(event: unknown): unknown {
  if (Array.isArray(event)) {
    return event.map((item) => sanitizeEvent(item));
  }
  if (event && typeof event === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
      sanitized[key] = isSensitiveKey(key) ? REDACTED : sanitizeEvent(value);
    }
    return sanitized;
  }
  if (typeof event === 'string') {
    return stripUrlSecrets(event);
  }
  return event;
}

export type AuditEventInput = {
  event: string;
  level?: 'info' | 'warning' | 'error';
  taskId?: string | null;
  attemptId?: string | null;
  providerTaskId?: string | null;
  stage?: string | null;
  code?: string | null;
  requestId?: string | null;
  [field: string]: unknown;
};

/**
 * 结构化审计事件：人工处置、准入拒绝这类动作要留下"谁在什么时候改了什么"。
 *
 * 脱敏在写盘之前完成，不依赖日志采集器兜底；写失败只告警，不影响正在处理的
 * 请求——审计是旁路证据，不是业务本身。
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  private get directory(): string | null {
    const configured = (process.env.VIDEO_FLOW_AUDIT_DIR ?? '').trim();
    return configured || null;
  }

  isConfigured(): boolean {
    return this.directory !== null;
  }

  pathFor(moment: Date = new Date()): string | null {
    const directory = this.directory;
    if (!directory) return null;
    const stamp = moment.toISOString().slice(0, 10);
    return join(directory, `${EVENTS_FILE_PREFIX}${stamp}${EVENTS_FILE_SUFFIX}`);
  }

  async emit(input: AuditEventInput): Promise<Record<string, unknown> | null> {
    const path = this.pathFor();
    if (!path) {
      this.logger.warn(`audit dir not configured; dropped event ${input.event}`);
      return null;
    }

    const record: Record<string, unknown> = {
      at: new Date().toISOString(),
      level: input.level ?? 'info',
      component: 'backend',
      ...input,
    };
    const sanitized = sanitizeEvent(record) as Record<string, unknown>;

    try {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf-8', mode: 0o600 });
      await chmod(path, 0o600);
    } catch (error) {
      this.logger.warn(`audit write failed for ${input.event}: ${String(error)}`);
    }

    return sanitized;
  }

  async read(taskId?: string): Promise<{ available: boolean; reason?: string; records: Record<string, unknown>[] }> {
    const directory = this.directory;
    if (!directory) {
      return { available: false, reason: 'audit_dir_not_configured', records: [] };
    }

    let files: string[];
    try {
      files = (await readdir(directory)).filter(
        (name) => name.startsWith(EVENTS_FILE_PREFIX) && name.endsWith(EVENTS_FILE_SUFFIX),
      );
    } catch {
      // 目录不存在或不给读权限：明确说"证据缺失"，不能报成"没有记录"。
      return { available: false, reason: EVIDENCE_MISSING, records: [] };
    }

    const records: Record<string, unknown>[] = [];
    for (const file of files.sort()) {
      try {
        const content = await readFile(join(directory, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            if (taskId && record.taskId !== taskId) continue;
            records.push(record);
          } catch {
            continue;
          }
        }
      } catch {
        return { available: false, reason: 'audit_dir_not_readable', records };
      }
    }

    return { available: true, records };
  }

  /** 按保留期清理事件文件；不触碰其它证据文件。 */
  async rotate(retentionDays = 30, now: Date = new Date()): Promise<string[]> {
    const directory = this.directory;
    if (!directory) return [];

    const cutoff = new Date(now.getTime() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      return [];
    }

    const removed: string[] = [];
    for (const file of files) {
      if (!file.startsWith(EVENTS_FILE_PREFIX) || !file.endsWith(EVENTS_FILE_SUFFIX)) {
        continue;
      }
      const stamp = file.slice(EVENTS_FILE_PREFIX.length, -EVENTS_FILE_SUFFIX.length);
      const written = new Date(`${stamp}T00:00:00.000Z`);
      if (Number.isNaN(written.getTime()) || written >= cutoff) continue;
      try {
        await unlink(join(directory, file));
        removed.push(file);
      } catch {
        continue;
      }
    }
    return removed;
  }
}
