import { resolve } from 'node:path';
import { Context, Service } from 'koishi';
import type { Logger } from 'koishi';
import { DeliveryFailure, classifyDeliveryError, listGroupAlbums, parseTarget, sendToTarget } from './deliver';
import type { DeliveryBot, SendOptions, Sleep } from './deliver';
import { describeError } from './guard';
import { DeliveryStore, compositeKey, targetKey } from './store';
import { isQuietHours } from './time';
import { nextCronAt, parseCron } from './cron';
import type {
  AlbumInfo,
  Delivery,
  DeliveryOutcome,
  DeliveryResult,
  DeliveryTarget,
  NotifierConfig,
  NotifierService,
  SeenEntry,
} from './types';

/** 状态文件默认位置（相对 `ctx.baseDir`） */
export const DEFAULT_STORE_PATH = 'data/miyako-delivery/store.json';
/** 去重默认窗口：7 天 */
export const DEFAULT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;

/** 可注入依赖：测试用假时钟/假休眠/假 Bot；宿主也可显式指定 Bot 集合 */
export interface DeliveryServiceDeps {
  sleep?: Sleep;
  now?: () => number;
  fetch?: typeof fetch;
  bots?: readonly DeliveryBot[];
}

/**
 * 投递治理服务（宿主侧服务名 `delivery`）。
 *
 * 单目标流程：静默时段判定 → 去重占位（Write-Ahead）→ 发送（含退避）→ 确认或释放。
 */
export class DeliveryService extends Service implements NotifierService {
  readonly config: NotifierConfig;
  private readonly store: DeliveryStore;
  private readonly deps: DeliveryServiceDeps;
  private readonly log: Logger;
  private readonly dedupeWindowMs: number;
  private readonly cronTimers = new Set<NodeJS.Timeout>();

  constructor(ctx: Context, config: NotifierConfig = {}, deps: DeliveryServiceDeps = {}) {
    super(ctx, 'miyako-delivery', true);

    this.config = config;
    this.deps = deps;
    this.log = ctx.logger('miyako-delivery');
    this.dedupeWindowMs = config.defaultDedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;

    this.store = new DeliveryStore({
      path: resolve(ctx.baseDir, config.storePath ?? DEFAULT_STORE_PATH),
      dedupeWindowMs: this.dedupeWindowMs,
      now: deps.now,
      warn: (message) => this.log.warn(message),
    });
    ctx.on('dispose', () => {
      for (const timer of this.cronTimers) clearTimeout(timer);
      this.cronTimers.clear();
    });
  }

  scheduleCron(expression: string, run: () => void | Promise<void>): () => void {
    const fields = parseCron(expression);
    let disposed = false;
    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (disposed) return;
      const now = this.deps.now?.() ?? Date.now();
      const delay = Math.max(1_000, nextCronAt(fields, now) - now);
      timer = setTimeout(() => {
        if (timer !== undefined) this.cronTimers.delete(timer);
        void (async () => {
          try {
            await run();
          } catch (error: unknown) {
            this.log.warn(`[miyako-delivery] cron 任务异常: ${describeError(error)}`);
          } finally {
            schedule();
          }
        })();
      }, delay);
      timer.unref();
      this.cronTimers.add(timer);
    };
    schedule();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        this.cronTimers.delete(timer);
      }
    };
  }

  async deliver(delivery: Delivery): Promise<DeliveryOutcome> {
    const { target } = delivery;

    // 先解析目标：非法载荷不值得占用去重键，也不该写盘
    try {
      parseTarget(target);
    } catch (error) {
      return {
        target,
        ok: false,
        error: error instanceof DeliveryFailure ? error.error : classifyDeliveryError(error),
        attempts: 0,
      };
    }

    if (this.inQuietHours()) return { target, ok: true, skipped: 'quiet-hours', attempts: 0 };

    const windowMs = delivery.dedupeWindowMs ?? this.dedupeWindowMs;
    let claimedKey: string | undefined;

    if (delivery.dedupeKey) {
      const key = compositeKey(delivery.scope ?? '', delivery.dedupeKey, targetKey(target));
      try {
        const claimed = await this.store.claim(delivery.scope ?? '', delivery.dedupeKey, targetKey(target), windowMs);
        if (!claimed) return { target, ok: true, skipped: 'duplicate', attempts: 0 };
        claimedKey = key;
      } catch (error) {
        // 占位写不进去就不发：宁可漏发，也不要在无去重保护下轰炸群聊
        return {
          target,
          ok: false,
          error: error instanceof DeliveryFailure ? error.error : classifyDeliveryError(error),
          attempts: 0,
        };
      }
    }

    try {
      const result = await sendToTarget(target, delivery.elements, this.sendOptions(delivery));
      if (claimedKey) await this.commit(claimedKey, result.attempts);
      return { target, ok: true, messageId: result.messageId, attempts: result.attempts };
    } catch (error) {
      const failure = error instanceof DeliveryFailure
        ? error
        : new DeliveryFailure(classifyDeliveryError(error));
      if (claimedKey) await this.release(claimedKey);
      return { target, ok: false, error: failure.error, attempts: failure.attempts };
    }
  }

  async broadcast(deliveries: readonly Delivery[]): Promise<DeliveryResult> {
    const outcomes = await Promise.all(deliveries.map((delivery) => this.deliver(delivery)));
    return {
      ok: outcomes.every((outcome) => outcome.ok),
      deliveredCount: outcomes.filter((outcome) => outcome.ok && outcome.skipped === undefined).length,
      totalCount: outcomes.length,
      outcomes,
    };
  }

  listAlbums(groupId: string): Promise<AlbumInfo[]> {
    return listGroupAlbums(this.deps.bots ?? this.ctx.bots, 'onebot', groupId);
  }

  isSeen(scope: string, dedupeKey: string, target?: DeliveryTarget): Promise<boolean> {
    return this.store.isSeen(scope, dedupeKey, target === undefined ? undefined : targetKey(target));
  }

  /** 预置「已投递」记录：目标照常校验，非法目标直接抛 INVALID_PAYLOAD */
  async markSeen(entries: readonly SeenEntry[]): Promise<void> {
    const mapped = entries.map((entry) => {
      parseTarget(entry.target);
      return {
        scope: entry.scope ?? '',
        dedupeKey: entry.dedupeKey,
        key: targetKey(entry.target),
        windowMs: entry.dedupeWindowMs,
      };
    });
    await this.store.mark(mapped);
  }

  hasHistory(scope: string): Promise<boolean> {
    return this.store.hasScope(scope);
  }

  gateDailySlot(slot: string, dayKey: string): Promise<boolean> {
    return this.store.gateDailySlot(slot, dayKey);
  }

  private sendOptions(delivery: Delivery): SendOptions {
    return {
      bots: this.deps.bots ?? this.ctx.bots,
      maxAttempts: delivery.retry?.maxAttempts ?? this.config.maxRetries ?? DEFAULT_MAX_ATTEMPTS,
      initialBackoffMs: delivery.retry?.baseDelayMs ?? this.config.initialBackoffMs ?? DEFAULT_BACKOFF_MS,
      forceSilent: this.config.forceSilent === true,
      sleep: this.deps.sleep,
      fetch: this.deps.fetch,
    };
  }

  private inQuietHours(): boolean {
    const quiet = this.config.quietHours;
    if (!quiet?.enabled) return false;
    const now = this.deps.now ?? Date.now;
    return isQuietHours(new Date(now()), quiet.start, quiet.end);
  }

  /** 确认已投递：落盘失败只告警，因为消息确实已发出 */
  private async commit(key: string, attempts: number): Promise<void> {
    try {
      await this.store.commit(key, attempts);
    } catch (error) {
      this.log.warn('投递确认落盘失败（该 key 可能重复触发）：%s', describeError(error));
    }
  }

  /** 失败后释放占位，允许下次重试 */
  private async release(key: string): Promise<void> {
    try {
      await this.store.release(key);
    } catch (error) {
      this.log.warn('投递占位释放失败（该 key 可能被误判为已投递）：%s', describeError(error));
    }
  }
}
