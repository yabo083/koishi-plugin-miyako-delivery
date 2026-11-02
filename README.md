# koishi-plugin-miyako-delivery (Miyako 共通消息投递与可靠性治理服务)

> **定位**：Koishi 私有插件矩阵（Miyako 系列 + Patchouli Knowledge）的共通消息投递与可靠性治理层。
> **包名**：`koishi-plugin-miyako-delivery`；**插件名 / 配置键**：`miyako-delivery`；**服务名**：`miyako-delivery`（业务方用 `ctx['miyako-delivery']`）。
> **核心使命**：解决多插件重复造轮子的问题，统一承担**目标寻址、Write-Ahead 幂等去重、错误二分退避、部分失败治理、群相册上传与持久化日切水位**。

## 关于名称：插件 `miyako-delivery`，服务 `delivery`

Koishi 生态中的 `@koishijs/plugin-notifier` 已经占用了 `ctx.notifier`（聊天平台通知转发）。本插件注册 `ctx['miyako-delivery']`。

因此本插件刻意区分两件事：

| 概念                                             | 值                  | 用途                                                    |
| :----------------------------------------------- | :------------------ | :------------------------------------------------------ |
| 插件名 (`export const name`)                   | `miyako-delivery` | 配置项、日志、Loader 侧标识（`miyako-delivery:<id>`） |
| 服务名 (`super(ctx, 'miyako-delivery', true)`) | `miyako-delivery` | 业务方调用面：`ctx['miyako-delivery']`                |

`ctx.notifier` 保持为空。业务插件声明 `inject: { optional: ['miyako-delivery'] }`，未装载本插件时透明降级为原生 `ctx.broadcast`。

---

## 一、设计思想与认知演变 (Thought Lineage)

### 1.1 灵感来源：DeepSeek Super-Agent 双层分离

在分析 DeepSeek super-agent 架构时，其核心哲学在于**分离关注点，而非堆叠功能**：

- **Router 层**：负责全局交互、状态维护与何时派发任务；
- **Worker 层**：上下文隔离，专注高并发且幂等地执行具体动作。

映射到 Koishi 插件开发中，过去各插件将**触发判定（何时推）**与**投递治理（怎么发、发没发过、失败怎么退避）**混在同一个模块中，导致业务逻辑与投递重试胶水代码重度缠绕。
本插件确立明确的**双层分离**：

- **触发面（各业务插件自理）**：Cron 到点、自适应群聊平息、管理员手动指令、Webhook 回调；
- **投递面（本服务唯一承载）**：幂等性把关、目标平台路由、429 指数退避、单频道失败隔离、静默控制、相册上传。

### 1.2 极简 Seam：反过度设计 (Anti-Overengineering)

遵循《我目前认可的原则》（2026-08-23）：

> “许多人在做通用层时，容易过度设计成复杂的 Plugin Framework。而一个设计良好的 Seam 告诉我们：只需要定义好极简的 Trait / 接口边界，就能以极低成本随时换掉底层实现，绝不多写一行花哨的胶水代码。”

我们在立项讨论中明确砍掉三项**过度设计**：

1. **不做查询抽象框架（QueryService）**：各插件的查询模型差异极大（Patchouli 是本地磁盘 Store 直读；Miyako-Intel 是多源 WikiSearch 拓扑折叠与长图切片；Feed 则只有单条校验）。三者不存在共通业务超集，强行抽象只会造出冗余胶水代码。查询面统一以《约定规范文档》（命令族 `<ns>` + Web 前缀 `/<ns>` + 1800 字符截断）治理即可。
2. **只内置极简投递 cron**：提供 `scheduleCron(expr, run)` 供周期投递使用。官方 `koishi-plugin-cron` 的可选服务在部分实例上未注册，且存在已知行为争议；本插件的解析器只支持标准五段（分/时/日/月/周）、列表/区间/步长，不做秒级或复杂日历。
3. **不做模板 DSL 或富文本引擎**：载荷严格基于 Koishi 原生 `h[]` 元素树。文本拼装、图片渲染、卡片组装属于调用方职责。

### 1.3 市场生态反思：为什么不追求公网 npm 发布？

实测 npm 与 Koishi 插件市场数据可见：

- 生态中存在大量单体推送插件（如 `bilibili-notify`、`live-monitor`、`ll-bns-news` 等），它们无一例外在内部各写了一套轮询与去重；
- 纯粹的 Service 插件（如 `koishi-plugin-subscription`）在市场上几乎没有独立安装量，因为**终端用户按业务场景装插件，没人会为了“基础投递能力”单独安装一个空壳插件**。

因此，本项目明确定位为**私有品牌矩阵内部的基础设施组件**。不为了追求“通用开源”增加配置负担，专注解决自身 4~6 个插件的硬缺陷。

---

## 二、现有代码的三大实证缺陷 (Defects to Eliminate)

| 现有插件               | 缺陷现场                                                                                      | 根因与后果                                                                                                                             | 本插件解决方案                                                                             |
| :--------------------- | :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **miyako-intel** | `core/scheduler.ts` 中 `DailyCronGate.lastRun` 为纯内存 `Map<string, string>`           | 注释宣称“插件重载后不重复推送”，但 Koishi HMR / 插件重启后内存清空，导致当天推送重复执行。                                           | **持久化日切水位**：`gateDailySlot(slot, dayKey)` 以 JSON 状态文件落盘。           |
| **miyako-feed**  | `pusher.ts` 中 `bot.sendMessage` 成功后才调用 `markSeen`，且依靠 1 秒 debounce 异步落盘 | 1. 进程在 1 秒窗口内崩溃会导致重复推送；2. 多目标发送时，若目标 A 成功、目标 B 失败，直接执行 `markSeen` 导致目标 B 永久丢失该条目。 | **Write-Ahead 幂等**：先写状态后发送；分目标独立记录 Outcome，支持部分失败隔离重推。 |
| **patchouli**    | `src/plugin/index.ts` 中直接硬编码 `ctx.broadcast([channelId], text)`                     | 广播缺乏退避机制，遇到群临时禁言或 429 直接抛异常中断链路；缺乏精细的平台级静默支持。                                                  | **标准化 Delivery**：透明接入指数退避与 `silent` 静默标志。                        |

---

## 三、四大核心职责与不变量 (Core Invariants)

```mermaid
graph TD
  A[业务触发源<br/>Cron / 讨论平息 / Webhook] -->|构造 Delivery 载荷| B[ctx['miyako-delivery'].deliver]
  B --> C{1. 静默时段判定}
  C -->|命中| C1[返回 skipped: quiet-hours<br/>不占用去重键]
  C --> D{2. Write-Ahead 幂等检查<br/>claim scope+dedupeKey+target}
  D -->|已占位/已投递| D1[返回 skipped: duplicate]
  D --> E[3. 落盘 pending 占位]
  E --> F[4. 目标寻址与 Bot 匹配<br/>platform:cid]
  F --> G{5. 发送与错误二分}
  G -->|429 / 超时| H[指数退避重试 <= 3次]
  H --> G
  G -->|目标不存在 / 封禁| I[不可重试 FATAL<br/>释放占位，不影响其他目标]
  G -->|成功| J[确认 sent 落盘<br/>返回 ok: true, messageId]
```

1. **Write-Ahead 幂等先验**：同一 `scope` + `dedupeKey` + 目标下，先把 `pending` 占位落盘，再调底层发送；
   进程异常崩溃时，系统**宁可少发一次，绝不重复轰炸群聊**。
2. **错误严格二分 (Fatal vs Retryable)**：可重试错误有界退避（默认 $1s \times 2^{n-1}$，最多 3 次尝试）；其余立即放弃。
3. **细粒度多目标状态 (No Swallowed Failures)**：多群广播时每个目标独立返回 `DeliveryOutcome`（含独立 `attempts` / `skipped` / `error`），部分失败既不影响其他目标，也不会被整体吞掉。
4. **与业务解耦的静默守则**：`silent`（或全局 `forceSilent`）递归剥离 `at` 元素后发送，保留其余内容；另有本地 `quietHours` 时段整段静默。

---

## 四、核心契约 (`src/types.ts`)

```ts
// 目标：频道 / 私聊 / 群相册的判别联合
type DeliveryTarget =
  | { kind?: 'channel'; channelId: string; silent?: boolean }        // 'onebot:854365377' | 'onebot:private:10000'
  | { kind: 'album'; channelId: string; albumId: string; albumName?: string; silent?: boolean };

interface Delivery {
  target: DeliveryTarget;
  elements: readonly h[];
  scope?: string;                 // 去重命名空间，如 'miyako-feed:column-news'
  dedupeKey?: string;             // 幂等去重键；缺省表示不要求幂等
  dedupeWindowMs?: number;        // 默认 7 天
  retry?: { maxAttempts?: number; baseDelayMs?: number };
}

interface DeliveryOutcome {
  target: DeliveryTarget;
  ok: boolean;                                  // 错误以外都为 true；skip 不算失败
  skipped?: 'duplicate' | 'quiet-hours' | 'no-available-bot';
  messageId?: string;
  error?: DeliveryError;
  attempts: number;
}

interface DeliveryResult {
  ok: boolean;              // 所有目标均无错误
  deliveredCount: number;   // 实际成功条数（不含 skip）
  totalCount: number;
  outcomes: readonly DeliveryOutcome[];
}

interface NotifierService extends Service {
  deliver(delivery: Delivery): Promise<DeliveryOutcome>;
  broadcast(deliveries: readonly Delivery[]): Promise<DeliveryResult>;
  /** target 缺省时任一目标命中即 true；给出时只查该目标 */
  isSeen(scope: string, dedupeKey: string, target?: DeliveryTarget): Promise<boolean>;
  /** 预置「已投递」记录（首启播种 / 迁移），只落盘不发送 */
  markSeen(entries: readonly SeenEntry[]): Promise<void>;
  /** scope 内是否已有任一记录（判断是否首次运行） */
  hasHistory(scope: string): Promise<boolean>;
  listAlbums(groupId: string): Promise<AlbumInfo[]>;
  scheduleCron(expression: string, run: () => void | Promise<void>): () => void;
  gateDailySlot(slot: string, dayKey: string): Promise<boolean>;
}

interface SeenEntry {
  target: DeliveryTarget;
  scope?: string;
  dedupeKey: string;
}
```

`DeliveryErrorCode`：`TARGET_NOT_FOUND` | `BOT_OFFLINE` | `INVALID_PAYLOAD` | `RATE_LIMITED` | `NETWORK_TIMEOUT` | `ADAPTER_ERROR` | `ALBUM_UPLOAD_FAILED`，每个错误都带 `retryable` 结论。

---

## 五、持久化与写入语义 (`storePath`)

状态文件默认 `data/miyako-delivery/store.json`（历史路径，保留以兼容既有去重状态；相对 `ctx.baseDir`，可用 `storePath` 覆盖）：

```json
{
  "version": 1,
  "seen": { "scope\u0000dedupeKey\u0000channel:onebot:123": { "state": "sent", "at": 1799999999999, "attempts": 1 } },
  "slots": { "prts-daily": "2026-11-02" }
}
```

- **复合键**：`scope \0 dedupeKey \0 targetKey`；`targetKey` 对频道为 `channel:<channelId>`，对相册为 `album:<channelId>/<albumId>`。同一 `dedupeKey` 发往多个目标时互不阻塞，单个目标失败不会吞掉其他目标。
- **写入语义（关键）**：`state: "pending"` 表示“已落盘占位、正在发送”。**进程崩溃后残留的 `pending` 一律视为已投递，不再重发**——宁可少发，绝不重复。正常路径下发送成功即改写为 `sent`，发送失败则删除该键，允许下一轮重试。
- **原子写**：同目录临时文件 + `rename` 原子替换；所有写操作经 Promise 队列串行化。
- **懒加载**：首次读写才读文件。
- **损坏隔离**：JSON 解析失败/结构非法时，文件被重命名为 `store.json.corrupt-<ts>` 并以空库启动（只告警，不阻断投递）。
- **清理**：写入时删除超过「已出现的最大去重窗口」的 `sent` 记录（`dedupeWindowMs` 可单条覆盖，如订阅源用 365 天；取最大值保证长窗口记录不被默认 7 天提前清掉）；`pending` 永不清理。
- **播种与探测**：`markSeen()` 直接写 `sent` 记录，用于首启播种或从旧游标迁移（不发送消息）；`hasHistory(scope)` 判断某命名空间是否已有任何记录，是业务方「首次运行」的唯一可靠信号；`isSeen(scope, key, target)` 可按目标粒度探测，配合 per-target 去重实现部分失败精准重推。
- **日切水位**：`gateDailySlot(slot, dayKey)` 当天未跑过则**先落盘再返回 true**；已跑过返回 false。重启/HMR 均生效。

---

## 六、群相册目标 (`kind: 'album'`)

对齐 miyako-intel 已证实的 OneBot 私有接口做法：

```ts
await ctx['miyako-delivery'].deliver({
  target: { kind: 'album', channelId: 'onebot:854365377', albumId: 'a1' }, // albumName 可省
  elements: [h('image', { src: imageBuffer })],
  scope: 'intel:album',
  dedupeKey: digest,
})
```

- **仅接受 `image` 元素**（文本等一律 `INVALID_PAYLOAD`）。
- `src` 支持 `Buffer`、`data:`、`http(s)://`（后者用全局 `fetch` 取 arraybuffer 后转 base64）；`base64://` 仍然接受，但 Koishi 的 `h.image('base64://…')` 会打印弃用警告，新建消息请用 `Buffer` 或 `data:`。
- `albumName` 缺省时调用 `get_qun_album_list`（携带上一页 `attach_info` 翻页，最多 5 页）匹配 `album_id`，取 `name` / `album_name`；找不到 → `TARGET_NOT_FOUND`。
- 逐张调用 `upload_image_to_qun_album({ group_id, album_id, album_name, file: 'base64://…' })`；`retcode !== 0` → `ALBUM_UPLOAD_FAILED`（`retcode` 为 1200/429 时可重试）。
- `bot.internal._get` 缺失 → `ADAPTER_ERROR`（不可重试）。
- 相册没有单条消息 ID，`messageId` 为空。

> 已知风险：重试是**目标级**的。若相册内第 2 张上传失败触发重试，第 1 张会被再传一次（相册里出现重复图）。需要严格去重时请让调用方一次只投递一张。

> 私聊目标：`channelId` 形如 `onebot:private:123456`（走 `bot.sendPrivateMessage`）。官方 QQ Bot（`platform === 'qq'`）的主动私聊会被自动包一层 `bot.session({ type: 'send', channel: { id, type: 1 } })` DIRECT 会话——adapter-qq 的 `sendPrivateMessage` 不会自己把 channel 标成 DIRECT，缺这层会被平台拒绝；OneBot 私聊不走该分支。

---

## 七、静默控制

| 手段              | 行为                                                                                                                                                                                                                                                  |
| :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target.silent` | 该次投递递归剥离 `at` 元素后发送（嵌套在 `figure`/`message` 等容器里的也会被剥离），其余内容原样保留。                                                                                                                                          |
| `forceSilent`   | 全局止血开关，等价于所有投递都 `silent`。                                                                                                                                                                                                           |
| `quietHours`    | `{ enabled, start, end }`，本地时间 `HH:mm`；`start > end` 表示跨午夜（`23:00`–`07:00`）。区间内投递返回 `skipped: 'quiet-hours'`，**不写去重键**，因此时段结束后同一 `dedupeKey` 仍可正常投递。配置格式非法时按“不静默”处理。 |

---

## 八、错误二分与退避 (`src/deliver.ts`)

纯函数 `classifyDeliveryError(error)` 给出结论，`sendToTarget` 按结论决定是否重试：

- **可重试**：`ECONNRESET` / `ETIMEDOUT` / `ECONNREFUSED` / `EPIPE`、`socket hang up`、超时文案、`429` / `rate limit` / `too many requests`、OneBot `retcode === 1200`。
- **不可重试**：其余一切（含 `BOT_OFFLINE`、`INVALID_PAYLOAD`、`TARGET_NOT_FOUND`、`ADAPTER_ERROR`）。
- **退避**：`maxAttempts`（默认 3，含首次发送）× `initialBackoffMs`（默认 1000），第 n 次重试等待 `base * 2^(n-1)`；`sleep` 可注入以便测试。
- 尝试次数耗尽后仍返回最后一次的分类结论（`retryable` 保持错误本身的属性），`attempts` 表示实际尝试次数。

---

## 九、接入形态

```ts
// 依赖声明：未装载本插件时透明降级
export const inject = { optional: ['miyako-delivery'] }

// miyako-feed：替换手工 splitTarget + sendMessage + 脆弱 seen
await ctx['miyako-delivery'].broadcast(targets.map((target) => ({
  target: { channelId: target },
  elements: renderElements(item),
  scope: `feed:${column.name}`,
  dedupeKey: item.link,
})))

// miyako-intel：替换内存态 DailyCronGate
const canRun = await ctx['miyako-delivery'].gateDailySlot('prts-daily', dayKey)
if (!canRun) return

// patchouli：静默沉淀
await ctx['miyako-delivery'].deliver({
  target: { channelId, silent: true },
  elements: renderCard(entry),
  scope: 'patchouli:summary',
  dedupeKey: entry.id,
})
```

### 插件配置项

| 配置                                           | 默认                                | 说明                                         |
| :--------------------------------------------- | :---------------------------------- | :------------------------------------------- |
| `storePath`                                  | `data/miyako-delivery/store.json` | 状态文件路径（相对 `ctx.baseDir`）。       |
| `defaultDedupeWindowMs`                      | `604800000`（7 天）               | 去重窗口，也是过期 `sent` 记录的清理阈值。 |
| `maxRetries`                                 | `3`                               | 最大尝试次数（含首次）。                     |
| `initialBackoffMs`                           | `1000`                            | 首次重试等待；之后翻倍。                     |
| `forceSilent`                                | `false`                           | 全局强制剥离 `at`。                        |
| `quietHours.enabled` / `.start` / `.end` | `false` / `23:00` / `07:00`   | 本地静默时段，跨午夜自动识别。               |

---

## 十、开发与测试

```bash
mise exec -- pnpm install
mise exec -- pnpm build   # tsc，零错误零警告
mise exec -- pnpm test    # node --test "tests/**/*.test.mjs"（Node 自带 glob，不依赖 shell 展开）
```

> Node 22 的 `node --test <dir>` 仍然把目录当作模块路径（`Cannot find module ...\tests`），所以脚本用**带引号的 glob**，由 Node 自己展开，Windows / POSIX 一致。

测试全部使用 mock ctx / bot，不连接真实 QQ：`tests/delivery.test.mjs`（26 项）覆盖跨实例去重、崩溃残留 `pending`、部分失败隔离、不可重试只试一次、`silent` 剥离、相册参数、`gateDailySlot` 持久化、静默时段、`broadcast` 汇总、损坏文件隔离、服务名注册，以及本轮新增的 `markSeen`/`hasHistory`/按目标 `isSeen`、长去重窗口跨重启保留、官方 QQ 私聊 DIRECT 会话；`tests/cron.test.mjs` 覆盖五段 cron 解析。状态文件写入项目 `tmp/` 下并在用例结束时清除。

因为 koishi 的 ESM 入口在 pnpm 布局下与 cordis 的双包互操作有缺陷，`.mjs` 测试统一通过 `createRequire` 加载 koishi 的 CJS 入口。

---

## 十一、消费者接入 (Consumers)

三个业务插件已全部接入，不再各自维护轮询、游标与内存水位：

| 消费者 | 接入方式 | 迁掉的旧实现 |
| :--- | :--- | :--- |
| `miyako-feed` | **硬依赖** `inject = ['miyako-delivery']`；每栏目 `scheduleCron(column.cron)`；每条新条目 × 目标一项 `broadcast`（`scope=feed:<栏目>`、`dedupeKey=<链接>`、365 天窗口）；首启用 `hasHistory` + `markSeen` 播种，无目标不播种。 | `src/state.ts`（JSON 游标 + 1 秒 debounce）、`src/cron.ts`（自行 cron 匹配）、每分钟轮询与 `bot.sendMessage` |
| `miyako-intel` | **可选依赖** `inject.optional`；日切水位走 `gateDailySlot`（缺失时退回进程内 Map）；日报群发走 `broadcast`（`scope=miyako-intel:daily`、`dedupeKey=dayKey`）；周报相册走 `kind:'album'` 目标（缺失时退回 OneBot 直传）。 | 内存态 `DailyCronGate.lastRun`、`ctx.broadcast` 群发、`upload_image_to_qun_album` 直调 |
| `patchouli-knowledge` | **可选依赖**；频道/相册投递走 `deliver`，缺失时频道目标降级 `bot.sendMessage`、相册目标结构化失败；每周知识周报用 `scheduleCron('30 4 * * 1')`。 | 自带相册上传与频道广播、`WeeklyAlbumScheduler` |

接入不变量：
- 业务插件不自己发消息、不自己判重、不自己计时（`scheduleCron` / `gateDailySlot` 都在本服务）；
- 投递失败按目标独立返回，业务插件只负责把 `error.code/message` 写日志或回给命令；
- 日切类任务采用 claim-first（先占水位再执行）——崩溃或失败当天不重跑，宁可少发一次。
