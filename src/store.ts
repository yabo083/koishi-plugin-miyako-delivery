import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describeError, isRecord, readErrorCode } from './guard';
import type { DeliveryTarget } from './types';

/** 单条幂等记录：`pending` 已落盘但未确认发送，按「已投递」对待 */
export interface SeenRecord {
  state: 'pending' | 'sent';
  at: number;
  attempts: number;
  /** 该记录使用的去重窗口；缺省按默认窗口（旧记录兼容） */
  windowMs?: number;
}

/** 状态文件文档结构（version 用于未来迁移） */
export interface StoreDocument {
  version: 1;
  seen: Record<string, SeenRecord>;
  slots: Record<string, string>;
}

/** 预置记录（播种/迁移）：只写 `sent`，不发送消息 */
export interface MarkEntry {
  scope: string;
  dedupeKey: string;
  /** 已解析的目标键（`targetKey()` 的产物） */
  key: string;
  /** 该记录的去重窗口，缺省用默认窗口 */
  windowMs?: number;
}

export interface DeliveryStoreOptions {
  /** 绝对路径（由服务层按 `ctx.baseDir` 解析） */
  path: string;
  /** 默认去重窗口，也是清理过期 `sent` 记录的阈值 */
  dedupeWindowMs: number;
  /** 可注入时钟，默认 `Date.now` */
  now?: () => number;
  /** 损坏隔离等诊断输出，默认丢弃 */
  warn?: (message: string) => void;
}

/** 复合去重键的分隔符：业务键与目标键都不得包含 NUL */
const KEY_SEPARATOR = '\u0000';

/** 目标键：频道与私聊共用 `channel:`，相册按群 + 相册 ID 隔离 */
export function targetKey(target: DeliveryTarget): string {
  if (target.kind === 'album') return `album:${target.channelId}/${target.albumId}`;
  return `channel:${target.channelId}`;
}

/** 复合去重键：`scope \0 dedupeKey \0 targetKey`，保证多目标各自独立占位 */
export function compositeKey(scope: string, dedupeKey: string, key: string): string {
  return [scope, dedupeKey, key].join(KEY_SEPARATOR);
}

function createEmptyDocument(): StoreDocument {
  return { version: 1, seen: {}, slots: {} };
}

function parseSeenRecord(value: unknown): SeenRecord {
  if (!isRecord(value)) throw new Error('seen 记录不是对象');
  const { state, at, attempts, windowMs } = value;
  if (state !== 'pending' && state !== 'sent') throw new Error('seen.state 非法');
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new Error('seen.at 非法');
  if (typeof attempts !== 'number' || !Number.isFinite(attempts)) throw new Error('seen.attempts 非法');
  if (windowMs !== undefined && (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0)) {
    throw new Error('seen.windowMs 非法');
  }
  return windowMs === undefined ? { state, at, attempts } : { state, at, attempts, windowMs };
}

function parseDocument(text: string): StoreDocument {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('根节点不是对象');
  if (parsed.version !== 1) throw new Error(`不支持的状态文件版本：${String(parsed.version)}`);

  const document = createEmptyDocument();

  const seen = parsed.seen;
  if (seen !== undefined) {
    if (!isRecord(seen)) throw new Error('seen 不是对象');
    for (const [key, value] of Object.entries(seen)) {
      document.seen[key] = parseSeenRecord(value);
    }
  }

  const slots = parsed.slots;
  if (slots !== undefined) {
    if (!isRecord(slots)) throw new Error('slots 不是对象');
    for (const [slot, dayKey] of Object.entries(slots)) {
      if (typeof dayKey !== 'string') throw new Error(`slots.${slot} 不是字符串`);
      document.slots[slot] = dayKey;
    }
  }

  return document;
}

/**
 * JSON 状态库（Write-Ahead 幂等 + 日切水位）。
 *
 * 语义约定：
 * - 所有写操作串行化（Promise 队列），单次写入为「同目录临时文件 + rename」原子替换；
 * - 进程崩溃遗留的 `pending` 一律视为已投递（宁可少发，绝不重复）；
 * - 写入时按去重窗口清理过期 `sent` 记录，`pending` 永不清理；
 * - 文件损坏隔离为 `*.corrupt-<ts>` 并以空库启动。
 */
export class DeliveryStore {
  readonly path: string;
  private readonly dedupeWindowMs: number;
  /** 已出现过的最大去重窗口：更长窗口的调用方（如订阅源 365 天）不能被默认窗口提前清理 */
  private maxWindowMs: number;
  private readonly clock: () => number;
  private readonly warn: (message: string) => void;
  private document: StoreDocument | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeliveryStoreOptions) {
    this.path = options.path;
    this.dedupeWindowMs = options.dedupeWindowMs;
    this.maxWindowMs = options.dedupeWindowMs;
    this.clock = options.now ?? Date.now;
    this.warn = options.warn ?? (() => undefined);
  }

  /**
   * 当前去重窗口内是否已占位（`sent` 或未确认的 `pending`）。
   * `target` 缺省时只要任一目标命中即返回 true；给出时只查该目标。
   */
  async isSeen(scope: string, dedupeKey: string, target?: string): Promise<boolean> {
    const prefix = `${[scope, dedupeKey].join(KEY_SEPARATOR)}${KEY_SEPARATOR}`;
    const exact = target === undefined ? undefined : `${prefix}${target}`;
    return this.enqueue(async () => {
      const document = await this.load();
      const now = this.clock();
      for (const [key, record] of Object.entries(document.seen)) {
        if (exact !== undefined ? key !== exact : !key.startsWith(prefix)) continue;
        if (record.state === 'pending') return true;
        if (now - record.at <= (record.windowMs ?? this.maxWindowMs)) return true;
      }
      return false;
    });
  }

  /** scope 内是否存在任一记录（用于「首次运行播种」判定） */
  async hasScope(scope: string): Promise<boolean> {
    const prefix = `${scope}${KEY_SEPARATOR}`;
    return this.enqueue(async () => {
      const document = await this.load();
      return Object.keys(document.seen).some((key) => key.startsWith(prefix));
    });
  }

  /**
   * 先落盘占位再返回 true；已有占位或窗口内已成功投递则返回 false。
   * 调用方拿到 true 后必须发送，并在成功后 `commit`、失败后 `release`。
   */
  async claim(scope: string, dedupeKey: string, key: string, windowMs = this.dedupeWindowMs): Promise<boolean> {
    const composite = compositeKey(scope, dedupeKey, key);
    this.maxWindowMs = Math.max(this.maxWindowMs, windowMs);
    return this.enqueue(async () => {
      const document = await this.load();
      const now = this.clock();
      pruneSent(document, this.maxWindowMs, now);

      const record = document.seen[composite];
      if (record) {
        if (record.state === 'pending') return false;
        if (now - record.at <= windowMs) return false;
      }

      document.seen[composite] = { state: 'pending', at: now, attempts: 0, windowMs };
      await this.persist(document);
      return true;
    });
  }

  /** 发送成功后确认；返回前已落盘 */
  async commit(composite: string, attempts: number): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.load();
      const now = this.clock();
      pruneSent(document, this.maxWindowMs, now);
      const windowMs = document.seen[composite]?.windowMs ?? this.maxWindowMs;
      document.seen[composite] = { state: 'sent', at: now, attempts, windowMs };
      await this.persist(document);
    });
  }

  /** 发送失败后释放占位，允许下次重试 */
  async release(composite: string): Promise<void> {
    await this.enqueue(async () => {
      const document = await this.load();
      if (!(composite in document.seen)) return;
      delete document.seen[composite];
      await this.persist(document);
    });
  }

  /**
   * 预置「已投递」记录（首启播种 / 从旧游标迁移），不发送消息。
   * 单次落盘写完所有条目；重复条目以最后一次为准。
   */
  async mark(entries: readonly MarkEntry[]): Promise<void> {
    if (!entries.length) return;
    await this.enqueue(async () => {
      const document = await this.load();
      const now = this.clock();
      for (const entry of entries) {
        if (entry.windowMs !== undefined) this.maxWindowMs = Math.max(this.maxWindowMs, entry.windowMs);
      }
      pruneSent(document, this.maxWindowMs, now);
      for (const entry of entries) {
        document.seen[compositeKey(entry.scope, entry.dedupeKey, entry.key)] = {
          state: 'sent',
          at: now,
          attempts: 0,
          windowMs: entry.windowMs ?? this.maxWindowMs,
        };
      }
      await this.persist(document);
    });
  }

  /**
   * 日切水位：当天未跑过则先落盘再返回 true；已跑过返回 false。
   * 落盘失败会抛出，调用方须视为「今天没跑」。
   */
  async gateDailySlot(slot: string, dayKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const document = await this.load();
      if (document.slots[slot] === dayKey) return false;
      document.slots[slot] = dayKey;
      await this.persist(document);
      return true;
    });
  }

  /** 串行化所有操作：前序失败不阻塞后续任务 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async load(): Promise<StoreDocument> {
    if (this.document) return this.document;
    try {
      const text = await readFile(this.path, 'utf8');
      this.document = parseDocument(text);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') await this.quarantine(error);
      this.document = createEmptyDocument();
    }
    return this.document;
  }

  private async quarantine(error: unknown): Promise<void> {
    const target = `${this.path}.corrupt-${Date.now()}`;
    try {
      await rename(this.path, target);
      this.warn(`状态文件损坏（${describeError(error)}），已隔离为 ${target}，本次以空库启动`);
    } catch (renameError) {
      if (readErrorCode(renameError) === 'ENOENT') return;
      this.warn(`状态文件损坏且隔离失败（${describeError(renameError)}），本次以空库启动`);
    }
  }

  /** 原子写：临时文件 + rename，避免半截文件 */
  private async persist(document: StoreDocument): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

/** 清理过期 `sent` 记录；`pending` 保守保留；每条记录按自己的窗口判定 */
function pruneSent(document: StoreDocument, defaultWindowMs: number, now: number): void {
  for (const [key, record] of Object.entries(document.seen)) {
    if (record.state !== 'sent') continue;
    if (now - record.at > (record.windowMs ?? defaultWindowMs)) delete document.seen[key];
  }
}
