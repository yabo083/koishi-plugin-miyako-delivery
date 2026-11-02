import { Context, Schema } from 'koishi';
import { DeliveryService, DEFAULT_DEDUPE_WINDOW_MS, DEFAULT_STORE_PATH } from './service';
import type { NotifierConfig } from './types';

export * from './types';
export { DeliveryService, DEFAULT_DEDUPE_WINDOW_MS, DEFAULT_STORE_PATH } from './service';
export type { DeliveryBot, SendOptions, Sleep, TargetAddress } from './deliver';
export { DeliveryFailure, classifyDeliveryError, parseTarget, stripMentions } from './deliver';
export type { DeliveryStoreOptions, SeenRecord, StoreDocument } from './store';
export { DeliveryStore, compositeKey, targetKey } from './store';
export { isQuietHours } from './time';

/** 插件名 `miyako-delivery`；服务名仍为 `delivery`，避免业务方改动。 */
export const name = 'miyako-delivery';

/** 本服务只依赖平台 Bot，不强制 HTTP；`http` 仅供图片直链下载的可选复用 */
export const inject = { optional: ['http'] };

export const usage = [
  "共通消息投递与可靠性治理服务，宿主侧服务名 `ctx['miyako-delivery']`。",
  "业务方通过 `ctx['miyako-delivery']` 构造 `{ target, elements, scope, dedupeKey }`，幂等、退避与静默由本服务承担。",
  '包名、插件名与服务名统一为 `miyako-delivery`。',
].join('\n');

export const Config: Schema<NotifierConfig> = Schema.object({
  storePath: Schema.string()
    .default(DEFAULT_STORE_PATH)
    .description('状态文件路径（相对实例目录 `ctx.baseDir`）。进程重启后据此恢复去重记录与日切水位。'),
  defaultDedupeWindowMs: Schema.natural()
    .default(DEFAULT_DEDUPE_WINDOW_MS)
    .description('默认去重窗口（毫秒），默认 7 天；窗口外的 `sent` 记录会在写入时清理。'),
  maxRetries: Schema.natural()
    .min(1)
    .default(3)
    .description('可重试错误的最大尝试次数（含首次发送）。'),
  initialBackoffMs: Schema.natural()
    .default(1000)
    .description('首次重试前的等待时长（毫秒）；第 n 次重试等待 `base * 2^(n-1)`。'),
  forceSilent: Schema.boolean()
    .default(false)
    .description('全局强制静默：剥离所有 `at` 元素后发送，用于紧急止血。'),
  quietHours: Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('是否启用本地静默时段；开启后区间内投递直接返回 `skipped: \'quiet-hours\'`，且不占用去重键。'),
    start: Schema.string()
      .default('23:00')
      .description('静默开始时间（本地 `HH:mm`）。'),
    end: Schema.string()
      .default('07:00')
      .description('静默结束时间（本地 `HH:mm`；小于开始时间表示跨午夜）。'),
  }).description('本地静默时段。'),
});

export function apply(ctx: Context, config: NotifierConfig): void {
  ctx.plugin(DeliveryService, config);
}
