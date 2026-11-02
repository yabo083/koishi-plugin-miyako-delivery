# AGENTS.md — koishi-plugin-miyako-delivery 执行契约

> 定位：Koishi 矩阵化插件的共通消息投递与可靠性治理服务。
> 包名、插件名（`export const name`）与服务名：均为 `miyako-delivery`。
> 核心职责：目标寻址、Write-Ahead 幂等、错误二分退避、多频道部分失败治理、群相册上传与平台静默控制。
> 继承自全局 `E:\Codes\AI\AGENTS.md`，局部约束只能加严，不得放松。

---

## 0. 命名红线（最高优先级）

- 服务名**必须**是 `miyako-delivery`：`super(ctx, 'miyako-delivery', true)` 且 `declare module 'koishi'` 里只登记 `Context['miyako-delivery']`。
- **严禁**注册 `ctx.notifier`：Koishi 生态的 `@koishijs/plugin-notifier` 已占用该名字，同时安装会互相覆盖服务实例。
- 包名、插件名与服务名统一为 `miyako-delivery`。

## 1. 核心架构约束与设计红线

1. **坚持极简 Seam，杜绝过度设计**：
   - 坚决不做查询抽象框架（QueryService）：各插件读取面形态异构，由约定文档约束即可；
   - 周期投递只内置极简五段 cron（本地 `setTimeout` + 自有解析器，不依赖 `koishi-plugin-cron`）；业务触发逻辑仍归业务插件。
   - 坚决不做消息渲染 DSL：消息内容一律接收 Koishi `h[]` 元素，渲染权留在调用方。
2. **状态与进程解耦（持久性契约）**：
   - 严禁依赖脆弱的内存 `Map` 充当去重或日切标记（杜绝重载后重复推送）；
   - 幂等判定必须先落盘/入库，再执行发送（Write-Ahead 语义，崩溃时宁可少发，绝不重复发）；
   - 进程崩溃遗留的 `pending` 记录**必须**按「已投递」对待，不得提供强制重发开关。
3. **TypeScript 严格无 `any`**：
   - 代码内严禁出现 `: any` 与 `as any`，未知错误对象必须通过 `src/guard.ts` 的类型守卫断言；
   - 构造已通过 `tsc --strict` 且开启 `noUnusedLocals` / `noUnusedParameters`，不得为消除告警而降低严格度。
4. **服务透明降级**：
   - 保证作为可选服务注入时，调用方有最轻量、零侵入的接入方式。

## 2. 投递面不变量

1. **多目标独立**：`broadcast` 并发执行，逐目标返回 `DeliveryOutcome`；某目标失败绝不影响其他目标，也绝不整体吞掉失败（`DeliveryResult.ok` 汇总，`deliveredCount` 只计成功）。
2. **错误严格二分**：可重试 = 连接类系统错误 / 超时文案 / 429 限频 / OneBot `retcode` 1200，其余立即放弃；退避为 `base * 2^(n-1)`，默认 3 次尝试。
3. **静默不等于丢弃**：`silent` 与 `forceSilent` 递归剥离 `at` 元素后照常发送，不得篡改其他元素。
4. **静默时段不占键**：`quietHours` 命中时返回 `skipped: 'quiet-hours'` 且不写去重记录，时段外可正常补发。
5. **相册目标只收图片**：`kind: 'album'` 仅接受 `image` 元素；`albumName` 缺省时才反查 `get_qun_album_list`；`bot.internal` 缺失即 `ADAPTER_ERROR`。

## 3. 核心契约概览 (`src/types.ts`)

```ts
export type DeliveryTarget =
  | { kind?: 'channel'; channelId: string; silent?: boolean }
  | { kind: 'album'; channelId: string; albumId: string; albumName?: string; silent?: boolean };

export interface Delivery {
  target: DeliveryTarget;
  elements: readonly h[];
  scope?: string;
  dedupeKey?: string;
  dedupeWindowMs?: number;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
}

export interface DeliveryOutcome {
  target: DeliveryTarget;
  ok: boolean;
  skipped?: 'duplicate' | 'quiet-hours' | 'no-available-bot';
  messageId?: string;
  error?: DeliveryError;
  attempts: number;
}

export interface NotifierService extends Service {
  deliver(delivery: Delivery): Promise<DeliveryOutcome>;
  broadcast(deliveries: readonly Delivery[]): Promise<DeliveryResult>;
  isSeen(scope: string, dedupeKey: string, target?: DeliveryTarget): Promise<boolean>;
  markSeen(entries: readonly SeenEntry[]): Promise<void>; // 播种/迁移，只落盘不发送
  hasHistory(scope: string): Promise<boolean>;            // 首启判定
  listAlbums(groupId: string): Promise<AlbumInfo[]>;
  scheduleCron(expression: string, run: () => void | Promise<void>, options?: { timeZone?: string }): () => void;
  gateDailySlot(slot: string, dayKey: string): Promise<boolean>;
}
```

## 4. 代码地图

| 文件 | 职责 |
|:---|:---|
| `src/index.ts` | 插件入口：`name = 'miyako-delivery'`、`Config`、`apply`（`ctx.plugin(DeliveryService, config)`）、统一导出面 |
| `src/service.ts` | `DeliveryService`（服务名 `delivery`）：`deliver` / `broadcast` / `isSeen` / `gateDailySlot` |
| `src/store.ts` | JSON Write-Ahead 状态库：复合键、原子写、串行化、损坏隔离、日切水位 |
| `src/deliver.ts` | 目标解析、Bot 匹配、静默剥离、错误分类、退避、群相册上传 |
| `src/time.ts` | `HH:mm` 静默时段（跨午夜）判定 |
| `src/guard.ts` | 唯一的未知对象守卫（`isRecord` / `readErrorCode` / `describeError`） |
| `src/types.ts` | 对外契约与 `Context.delivery` 类型增强 |
| `tests/delivery.test.mjs` | mock ctx/bot 的行为测试，不连真实平台 |

## 5. 消费者接入（已全部完成）

### 5.1 `miyako-feed`（硬依赖）
- `inject = ['miyako-delivery']`；每栏目 `scheduleCron(column.cron)` 直接调度，删除 `src/state.ts` / `src/cron.ts` / 每分钟轮询。
- 每条新条目 × 目标一项 `broadcast`（`scope=feed:<栏目>`、`dedupeKey=<链接>`、365 天窗口）；首启 `hasHistory` + `markSeen` 播种，无目标不播种（防倒灌）。
- 逐目标 `isSeen` 过滤，部分失败只重推未送达目标。

### 5.2 `miyako-intel`（硬依赖，>= 0.3.0）
- 调度：五个周期任务全部 `scheduleCron(expr, run, { timeZone: 'Asia/Shanghai' })`；插件不再持有 cron 解析与轮询。
- 日切水位：`gateDailySlot(slot, dayKey)` claim-first，失败当天不重跑。
- 日报群发：`broadcast`（`scope=miyako-intel:daily`、`dedupeKey=dayKey`）。
- 周报相册：`kind:'album'` 目标。

### 5.3 `patchouli-knowledge`（可选依赖）
- 频道/相册走 `deliver`；缺失时频道降级 `bot.sendMessage`、相册结构化失败；知识周报 `scheduleCron('30 4 * * 1')`。
