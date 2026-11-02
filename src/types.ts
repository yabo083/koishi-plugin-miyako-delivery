import type { h, Service } from 'koishi';

/** 频道目标：Koishi 标准通道 ID，统一形态为 `platform:cid`（如 `onebot:12345678` 或 `onebot:private:10000`） */
export interface ChannelTarget {
  kind?: 'channel';
  /** `platform:cid`；`private:` 前缀表示私聊（`onebot:private:10000`） */
  channelId: string;
  /** 平台级静默标记：剥离 `at` 元素后发送，不发出强提示（取决于具体 Adapter 支持度，非「放弃投递」） */
  silent?: boolean;
}

/** 群相册目标：向指定群相册上传图片 */
export interface AlbumTarget {
  kind: 'album';
  /** 群通道 ID，形态同为 `platform:group_id` */
  channelId: string;
  /** 相册 ID（OneBot `get_qun_album_list` 返回的 `album_id`） */
  albumId: string;
  /** 相册名称；缺省时由服务端按 `albumId` 反查 */
  albumName?: string;
  silent?: boolean;
}

/** 投递目标归一化契约（频道 / 群相册判别联合） */
export type DeliveryTarget = ChannelTarget | AlbumTarget;

/** 错误分类二分法：可重试与不可重试 */
export type DeliveryErrorCode =
  | 'TARGET_NOT_FOUND'      // 频道/目标不存在或未授权
  | 'BOT_OFFLINE'           // 对应平台 Bot 离线或缺失
  | 'INVALID_PAYLOAD'       // 消息格式错误或拒收
  | 'RATE_LIMITED'          // 平台 429 限频（可重试）
  | 'NETWORK_TIMEOUT'       // 网络超时或连接重置（可重试）
  | 'ADAPTER_ERROR'         // 适配器底层异常
  | 'ALBUM_UPLOAD_FAILED';  // 群相册上传被平台拒绝

export interface DeliveryError {
  code: DeliveryErrorCode;
  message: string;
  retryable: boolean;
  raw?: unknown;
}

/** 单次投递上下文与载荷 */
export interface Delivery {
  /** 目标频道、私聊或群相册 */
  target: DeliveryTarget;
  /** 消息元素树（不采用纯文本 string，兼容文本、图片 Buffer、语音、卡片与合并转发） */
  elements: readonly h[];
  /** 业务方作用域，用于隔离不同插件或任务的去重命名空间（如 `miyako-feed:column-a`） */
  scope?: string;
  /** 幂等去重键。在指定 scope 内同 key 成功投递后即封锁重发；缺省则视为不要求幂等 */
  dedupeKey?: string;
  /** 去重有效期窗口（毫秒），超时后 key 失效可再次触发，默认 7 天 (604,800,000ms) */
  dedupeWindowMs?: number;
  /** 重试策略覆盖 */
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
}

/** `scheduleCron` 的可选参数 */
export interface ScheduleCronOptions {
  /** IANA 时区（如 `Asia/Shanghai`）；缺省按宿主本地时区计算 */
  timeZone?: string;
}

/** 预置已投递记录（首启播种 / 从旧游标迁移）：只落盘，不发送 */
export interface SeenEntry {
  target: DeliveryTarget;
  /** 去重命名空间，缺省为空串 */
  scope?: string;
  dedupeKey: string;
  /** 该记录的去重窗口，缺省为服务默认窗口 */
  dedupeWindowMs?: number;
}

/** 群相册探测结果。 */
export interface AlbumInfo {
  groupId: string;
  groupName?: string;
  albumId: string;
  albumName: string;
}

/** 单目标投递结果 */
export interface DeliveryOutcome {
  target: DeliveryTarget;
  /** 错误以外的终局都为 true；`skipped` 属于「无需投递」，不算失败 */
  ok: boolean;
  skipped?: 'duplicate' | 'quiet-hours' | 'no-available-bot';
  messageId?: string;
  error?: DeliveryError;
  attempts: number;
}

/** 批量/单次投递终局结果 */
export interface DeliveryResult {
  /** 所有目标均无错误时为 true；`skipped` 不计为失败 */
  ok: boolean;
  /** 实际投递成功的条数（不含 skip） */
  deliveredCount: number;
  totalCount: number;
  outcomes: readonly DeliveryOutcome[];
}

/** 统一截断与平台规整辅助契约 */
export interface FitOptions {
  limit?: number;
  ellipsis?: string;
  suffixLink?: string;
}

/** 本地静默时段（`HH:mm`，按宿主本机时区，跨午夜自动识别） */
export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

/** Notifier 插件配置 Schema */
export interface NotifierConfig {
  /** 默认去重时间窗口（毫秒，默认 7 天） */
  defaultDedupeWindowMs?: number;
  /** 重试上限（默认 3 次，含首次发送） */
  maxRetries?: number;
  /** 初始退避延迟（毫秒，默认 1000ms；第 n 次重试等待 `base * 2^(n-1)`） */
  initialBackoffMs?: number;
  /** 全局强制静默开关（调试或紧急止血时开启） */
  forceSilent?: boolean;
  /** 状态文件路径，相对 `ctx.baseDir` 解析，默认 `data/miyako-delivery/store.json` */
  storePath?: string;
  /** 本地静默时段；开启后该区间内所有投递返回 `skipped: 'quiet-hours'` 且不占用去重键 */
  quietHours?: QuietHoursConfig;
}

/** Miyako Delivery 核心服务接口（宿主侧服务名 `miyako-delivery`） */
export interface NotifierService extends Service {
  /**
   * 执行一次可靠消息投递。
   * - 包含 Write-Ahead 幂等先验；
   * - 错误分类与自动指数退避；
   * - 细粒度返回各目标投递结果。
   */
  deliver(delivery: Delivery): Promise<DeliveryOutcome>;

  /**
   * 扇出多目标投递。
   * - 并发投递到多个目标；
   * - 汇总所有目标的细粒度 Outcome，杜绝部分失败被吞。
   */
  broadcast(deliveries: readonly Delivery[]): Promise<DeliveryResult>;

  /**
   * 检查指定 key 是否已在去重窗口内投递成功（或处于未确认的 pending 状态）。
   * `target` 缺省时任一目标命中即为 true；给出时只查该目标。
   */
  isSeen(scope: string, dedupeKey: string, target?: DeliveryTarget): Promise<boolean>;

  /** 预置「已投递」记录（首启播种 / 迁移），不发送消息 */
  markSeen(entries: readonly SeenEntry[]): Promise<void>;

  /** scope 内是否已有任一记录（判断是否首次运行） */
  hasHistory(scope: string): Promise<boolean>;

  /** 探测指定群已存在的相册，供控制台动态下拉使用。 */
  listAlbums(groupId: string): Promise<AlbumInfo[]>;

  /** 注册一个 cron 定时任务（五段表达式），可指定 IANA 时区；返回停止函数。 */
  scheduleCron(expression: string, run: () => void | Promise<void>, options?: ScheduleCronOptions): () => void;

  /**
   * 记录日切水位标记（持久化替代脆弱的内存 Map）。
   * 到点且当天未跑过返回 true 并标记完成；当天已跑过返回 false。
   */
  gateDailySlot(slot: string, dayKey: string): Promise<boolean>;
}

declare module 'koishi' {
  interface Context {
    /** 投递治理服务（插件名与服务名均为 `miyako-delivery`） */
    'miyako-delivery': NotifierService;
  }
}


