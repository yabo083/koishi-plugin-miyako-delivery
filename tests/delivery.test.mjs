import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config } from '../lib/index.js'
import { DeliveryStore } from '../lib/store.js'
import { DeliveryService } from '../lib/service.js'
import { isQuietHours } from '../lib/time.js'

const TMP_ROOT = join(process.cwd(), 'tmp')
const DAY_MS = 24 * 60 * 60 * 1000

// koishi 的 ESM 入口在 pnpm 布局下与 cordis 双包互操作有缺陷，统一走 CJS 入口
const require = createRequire(import.meta.url)
const { Context, h } = require('koishi')

/** 状态文件放在项目 tmp/ 下，测试结束即清理 */
async function createStorePath(t) {
  await mkdir(TMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(TMP_ROOT, 'notifier-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'store.json') }
}

/** 记录调用并提供可编排行为的假 Bot */
function createBot(options = {}) {
  const calls = []
  return {
    platform: options.platform ?? 'onebot',
    status: 'online',
    internal: options.internal,
    calls,
    async sendMessage(channelId, content) {
      calls.push({ kind: 'channel', channelId, content })
      if (options.sendMessage) return options.sendMessage(channelId, content, calls)
      return [`message-${calls.length}`]
    },
    async sendPrivateMessage(userId, content) {
      calls.push({ kind: 'private', userId, content })
      if (options.sendPrivateMessage) return options.sendPrivateMessage(userId, content, calls)
      return [`message-${calls.length}`]
    },
  }
}

/** 假 ctx：只提供 Service 构造与 `bots` 所需的最小面 */
function createContext(bots) {
  const ctx = new Context()
  Object.defineProperty(ctx, 'bots', { value: bots, writable: true, configurable: true })
  return ctx
}

function createService({ path, bots = [], config = {}, deps = {}, quiet = false }) {
  const ctx = createContext(bots)
  if (quiet) {
    // 预期内的 warn（损坏隔离等）不打印到测试输出
    const silent = new Proxy({}, { get: () => () => {} })
    Object.defineProperty(ctx, 'logger', { value: () => silent, configurable: true })
  }
  return new DeliveryService(ctx, { storePath: path, ...config }, {
    sleep: async () => {},
    ...deps,
  })
}

function text(content) {
  return h('text', { content })
}

test('去重跨实例（进程重启）依然生效', async (t) => {
  const { path } = await createStorePath(t)

  const firstBot = createBot()
  const first = createService({ path, bots: [firstBot] })
  const delivery = {
    target: { channelId: 'onebot:12345' },
    elements: [text('hello')],
    scope: 'feed:news',
    dedupeKey: 'https://example.com/a',
  }

  const outcome = await first.deliver(delivery)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.attempts, 1)
  assert.equal(firstBot.calls.length, 1)

  const secondBot = createBot()
  const second = createService({ path, bots: [secondBot] })
  const replay = await second.deliver(delivery)

  assert.equal(replay.skipped, 'duplicate')
  assert.equal(replay.ok, true)
  assert.equal(replay.attempts, 0)
  assert.equal(secondBot.calls.length, 0)
  assert.equal(secondBot.calls.length + firstBot.calls.length, 1)
  assert.equal(await second.isSeen('feed:news', 'https://example.com/a'), true)
})

test('崩溃残留的 pending 视为已投递，不重发', async (t) => {
  const { path } = await createStorePath(t)

  const store = new DeliveryStore({ path, dedupeWindowMs: 7 * DAY_MS })
  assert.equal(await store.claim('feed:news', 'k1', 'channel:onebot:12345'), true)

  const persisted = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(Object.values(persisted.seen)[0].state, 'pending')

  const bot = createBot()
  const service = createService({ path, bots: [bot] })
  const outcome = await service.deliver({
    target: { channelId: 'onebot:12345' },
    elements: [text('hello')],
    scope: 'feed:news',
    dedupeKey: 'k1',
  })

  assert.equal(outcome.skipped, 'duplicate')
  assert.equal(bot.calls.length, 0)
})

test('部分失败隔离：A 成功、B 重试到上限，互不影响', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot({
    sendMessage: async (channelId) => {
      if (channelId === '999') {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      }
      return ['ok-1']
    },
  })
  const service = createService({ path, bots: [bot], config: { maxRetries: 3, initialBackoffMs: 5 } })

  const result = await service.broadcast([
    { target: { channelId: 'onebot:123' }, elements: [text('a')], scope: 's', dedupeKey: 'k' },
    { target: { channelId: 'onebot:999' }, elements: [text('b')], scope: 's', dedupeKey: 'k' },
  ])

  assert.equal(result.totalCount, 2)
  assert.equal(result.deliveredCount, 1)
  assert.equal(result.ok, false)

  const [succeeded, failed] = result.outcomes
  assert.equal(succeeded.ok, true)
  assert.equal(succeeded.attempts, 1)
  assert.equal(failed.ok, false)
  assert.equal(failed.attempts, 3)
  assert.equal(failed.error.code, 'NETWORK_TIMEOUT')
  assert.equal(failed.error.retryable, true)

  assert.equal(bot.calls.filter((call) => call.channelId === '123').length, 1)
  assert.equal(bot.calls.filter((call) => call.channelId === '999').length, 3)

  // 失败目标已释放占位，成功后重试能补发；成功目标不重复
  const retried = await service.deliver({
    target: { channelId: 'onebot:999' },
    elements: [text('b')],
    scope: 's',
    dedupeKey: 'k',
  })
  assert.equal(retried.ok, false)

  const duplicateA = await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('a')],
    scope: 's',
    dedupeKey: 'k',
  })
  assert.equal(duplicateA.skipped, 'duplicate')
})

test('不可重试错误只尝试一次', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot({
    sendMessage: async () => {
      throw new Error('对方拒绝接收消息')
    },
  })
  const service = createService({ path, bots: [bot], config: { maxRetries: 5, initialBackoffMs: 1 } })

  const outcome = await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('a')],
    scope: 's',
    dedupeKey: 'forbidden',
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.error.code, 'ADAPTER_ERROR')
  assert.equal(outcome.error.retryable, false)
  assert.equal(bot.calls.length, 1)
})

test('错误分类：429 与 OneBot retcode 1200 可重试', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot({
    sendMessage: async (channelId) => {
      if (channelId === '429') throw new Error('HTTP 429 Too Many Requests')
      throw Object.assign(new Error('消息发送失败'), { retcode: 1200 })
    },
  })
  const service = createService({ path, bots: [bot], config: { maxRetries: 2, initialBackoffMs: 1 } })

  const rateLimited = await service.deliver({ target: { channelId: 'onebot:429' }, elements: [text('a')] })
  assert.equal(rateLimited.error.code, 'RATE_LIMITED')
  assert.equal(rateLimited.attempts, 2)

  const retcode = await service.deliver({ target: { channelId: 'onebot:1200' }, elements: [text('b')] })
  assert.equal(retcode.error.retryable, true)
  assert.equal(retcode.attempts, 2)
})

test('silent 递归剥离 at 元素并保留其余内容', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot()
  const service = createService({ path, bots: [bot] })

  const outcome = await service.deliver({
    target: { channelId: 'onebot:123', silent: true },
    elements: [
      h('at', { id: '42' }),
      text('hi'),
      h('figure', {}, h('at', { id: '7' }), text('inner')),
    ],
  })

  assert.equal(outcome.ok, true)
  const sent = bot.calls[0].content
  assert.equal(sent.some((element) => element.type === 'at'), false)

  const figure = sent.find((element) => element.type === 'figure')
  assert.ok(figure)
  assert.equal(figure.children.some((element) => element.type === 'at'), false)
  assert.equal(figure.children.length, 1)
  assert.equal(figure.children[0].attrs.content, 'inner')
  assert.equal(sent.filter((element) => element.type === 'text').length, 1)
})

test('全局 forceSilent 同样剥离 at', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot()
  const service = createService({ path, bots: [bot], config: { forceSilent: true } })

  await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [h('at', { id: '42' }), text('hi')],
  })

  assert.deepEqual(bot.calls[0].content.map((element) => element.type), ['text'])
})

test('私聊目标走 sendPrivateMessage', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot()
  const service = createService({ path, bots: [bot] })

  const outcome = await service.deliver({
    target: { channelId: 'onebot:private:10000' },
    elements: [text('私聊')],
  })

  assert.equal(outcome.ok, true)
  assert.equal(bot.calls.length, 1)
  assert.equal(bot.calls[0].kind, 'private')
  assert.equal(bot.calls[0].userId, '10000')
})

test('无可用 Bot 时不重试', async (t) => {
  const { path } = await createStorePath(t)
  const service = createService({ path, bots: [], config: { maxRetries: 3 } })

  const outcome = await service.deliver({ target: { channelId: 'onebot:123' }, elements: [text('a')] })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.attempts, 0)
  assert.equal(outcome.error.code, 'BOT_OFFLINE')
  assert.equal(outcome.error.retryable, false)
})

test('非法目标形态返回 INVALID_PAYLOAD', async (t) => {
  const { path } = await createStorePath(t)
  const service = createService({ path, bots: [createBot()] })

  for (const channelId of ['onebot', 'onebot:', ':123', 'onebot:private:']) {
    const outcome = await service.deliver({ target: { channelId }, elements: [text('a')] })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.code, 'INVALID_PAYLOAD', channelId)
    assert.equal(outcome.error.retryable, false)
  }
})

test('群相册：反查 albumName 并以 base64:// 上传（兼容 h.image 的 img 元素）', async (t) => {
  const { path } = await createStorePath(t)
  const internalCalls = []
  const internal = {
    async _get(action, params) {
      internalCalls.push({ action, params })
      if (action === 'get_qun_album_list') {
        return { retcode: 0, data: { album_list: [{ album_id: 'a1', album_name: '相册一' }] } }
      }
      if (action === 'upload_image_to_qun_album') return { retcode: 0 }
      throw new Error(`未知接口 ${action}`)
    },
  }
  const bot = createBot({ internal })
  const service = createService({ path, bots: [bot] })

  const outcome = await service.deliver({
    target: { kind: 'album', channelId: 'onebot:854365377', albumId: 'a1' },
    elements: [h('image', { src: 'base64://QUJD' })],
  })

  assert.equal(outcome.ok, true)
  assert.equal(bot.calls.length, 0)

  const upload = internalCalls.find((call) => call.action === 'upload_image_to_qun_album')
  assert.ok(upload)
  assert.deepEqual(upload.params, {
    group_id: '854365377',
    album_id: 'a1',
    album_name: '相册一',
    file: 'base64://QUJD',
  })

  // 显式给出 albumName 时不再反查
  const withName = await service.deliver({
    target: { kind: 'album', channelId: 'onebot:854365377', albumId: 'a1', albumName: '相册一' },
    elements: [h('image', { src: 'base64://REVG' })],
  })
  assert.equal(withName.ok, true)
  assert.equal(internalCalls.filter((call) => call.action === 'get_qun_album_list').length, 1)
  assert.equal(internalCalls.filter((call) => call.action === 'upload_image_to_qun_album').length, 2)

  // Koishi `h.image()` 产出 `img` 元素，不是 `image`；必须同样接受。
  const viaHImage = await service.deliver({
    target: { kind: 'album', channelId: 'onebot:854365377', albumId: 'a1', albumName: '相册一' },
    elements: [h.image('data:image/png;base64,R0hJ')],
  })
  assert.equal(viaHImage.ok, true)
  assert.equal(internalCalls.filter((call) => call.action === 'upload_image_to_qun_album').length, 3)
})

test('群相册：上传 retcode 非 0 归为 ALBUM_UPLOAD_FAILED', async (t) => {
  const { path } = await createStorePath(t)
  const internal = {
    async _get(action) {
      if (action === 'upload_image_to_qun_album') return { retcode: 111, message: '权限不足' }
      return { retcode: 0, data: { album_list: [] } }
    },
  }
  const service = createService({ path, bots: [createBot({ internal })] })

  const outcome = await service.deliver({
    target: { kind: 'album', channelId: 'onebot:1', albumId: 'x', albumName: '甲' },
    elements: [h('image', { src: 'base64://QUJD' })],
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'ALBUM_UPLOAD_FAILED')
  assert.equal(outcome.error.retryable, false)
  assert.equal(outcome.attempts, 1)
})

test('gateDailySlot 跨实例持久化', async (t) => {
  const { path } = await createStorePath(t)

  const first = createService({ path })
  assert.equal(await first.gateDailySlot('prts-daily', '2026-11-02'), true)
  assert.equal(await first.gateDailySlot('prts-daily', '2026-11-02'), false)

  const second = createService({ path })
  assert.equal(await second.gateDailySlot('prts-daily', '2026-11-02'), false)
  assert.equal(await second.gateDailySlot('prts-daily', '2026-11-03'), true)

  const persisted = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(persisted.slots['prts-daily'], '2026-11-03')
})

test('quiet-hours 跳过且不占用去重键', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot()

  const now = new Date()
  const clock = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const quietHours = {
    enabled: true,
    start: clock(new Date(now.getTime() - 5 * 60 * 1000)),
    end: clock(new Date(now.getTime() + 5 * 60 * 1000)),
  }

  const service = createService({ path, bots: [bot], config: { quietHours } })
  const outcome = await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('静默')],
    scope: 's',
    dedupeKey: 'quiet',
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.skipped, 'quiet-hours')
  assert.equal(bot.calls.length, 0)
  assert.equal(await service.isSeen('s', 'quiet'), false)

  const disabled = createService({ path, bots: [bot], config: { quietHours: { ...quietHours, enabled: false } } })
  const delivered = await disabled.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('静默')],
    scope: 's',
    dedupeKey: 'quiet',
  })
  assert.equal(delivered.ok, true)
  assert.equal(delivered.skipped, undefined)
  assert.equal(bot.calls.length, 1)
})

test('isQuietHours 正确处理跨午夜区间', () => {
  const at = (hour, minute) => new Date(2026, 10, 2, hour, minute)

  assert.equal(isQuietHours(at(23, 30), '23:00', '07:00'), true)
  assert.equal(isQuietHours(at(3, 0), '23:00', '07:00'), true)
  assert.equal(isQuietHours(at(6, 59), '23:00', '07:00'), true)
  assert.equal(isQuietHours(at(7, 0), '23:00', '07:00'), false)
  assert.equal(isQuietHours(at(12, 0), '23:00', '07:00'), false)
  assert.equal(isQuietHours(at(12, 0), '08:00', '18:00'), true)
  assert.equal(isQuietHours(at(18, 0), '08:00', '18:00'), false)
  assert.equal(isQuietHours(at(12, 0), 'bad', '18:00'), false)
  assert.equal(isQuietHours(at(12, 0), '12:00', '12:00'), false)
})

test('broadcast 汇总 deliveredCount / totalCount', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot()
  const service = createService({ path, bots: [bot] })

  const result = await service.broadcast([
    { target: { channelId: 'onebot:1' }, elements: [text('a')] },
    { target: { channelId: 'onebot:2' }, elements: [text('b')] },
    { target: { channelId: 'onebot:3' }, elements: [text('c')] },
  ])

  assert.equal(result.ok, true)
  assert.equal(result.deliveredCount, 3)
  assert.equal(result.totalCount, 3)
  assert.equal(result.outcomes.length, 3)
  assert.deepEqual(result.outcomes.map((outcome) => outcome.attempts), [1, 1, 1])
  assert.equal(bot.calls.length, 3)
})

test('损坏的状态文件被隔离并以空库启动', async (t) => {
  const { dir, path } = await createStorePath(t)
  await writeFile(path, '{ not json', 'utf8')

  const bot = createBot()
  const service = createService({ path, bots: [bot], quiet: true })
  const outcome = await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('a')],
    scope: 's',
    dedupeKey: 'corrupt',
  })

  assert.equal(outcome.ok, true)
  assert.equal(bot.calls.length, 1)

  const files = await readdir(dir)
  assert.ok(files.some((file) => file.startsWith('store.json.corrupt-')))
  const persisted = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(persisted.version, 1)
})

test('插件注册的服务名是 miyako-delivery，不占用 ctx.notifier', async (t) => {
  const { path } = await createStorePath(t)
  const ctx = createContext([createBot()])

  apply(ctx, Config({ storePath: path }))

  assert.ok(ctx['miyako-delivery'] instanceof DeliveryService)
  assert.equal(ctx.notifier, undefined)
  assert.equal(await ctx['miyako-delivery'].gateDailySlot('prts-daily', '2026-11-02'), true)
})

test('markSeen 播种后投递被判重，hasHistory 与按目标 isSeen 生效', async (t) => {
  const { path } = await createStorePath(t)
  const bot = createBot()
  const service = createService({ path, bots: [bot] })
  const targetA = { channelId: 'onebot:123' }
  const targetB = { channelId: 'onebot:456' }

  assert.equal(await service.hasHistory('feed:news'), false)
  await service.markSeen([
    { target: targetA, scope: 'feed:news', dedupeKey: 'link-1' },
    { target: targetB, scope: 'feed:news', dedupeKey: 'link-1' },
  ])

  assert.equal(await service.hasHistory('feed:news'), true)
  assert.equal(await service.isSeen('feed:news', 'link-1'), true)
  assert.equal(await service.isSeen('feed:news', 'link-1', targetA), true)
  assert.equal(await service.isSeen('feed:news', 'link-1', { channelId: 'onebot:789' }), false)

  const outcome = await service.deliver({
    target: targetA,
    elements: [text('seeded')],
    scope: 'feed:news',
    dedupeKey: 'link-1',
  })
  assert.equal(outcome.skipped, 'duplicate')
  assert.equal(bot.calls.length, 0)
})

test('markSeen 拒绝非法目标', async (t) => {
  const { path } = await createStorePath(t)
  const service = createService({ path, bots: [createBot()] })

  await assert.rejects(
    () => service.markSeen([{ target: { channelId: 'onebot' }, scope: 's', dedupeKey: 'k' }]),
    /非法的目标通道 ID/,
  )
})

test('长去重窗口的记录不会被后续按默认窗口的提交提前清理', async (t) => {
  const { path } = await createStorePath(t)
  let now = 0
  const bot = createBot()
  const service = createService({
    path,
    bots: [bot],
    config: { storePath: path },
    deps: { now: () => now },
  })

  now = 0
  await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('old')],
    scope: 'feed:news',
    dedupeKey: 'link-old',
    dedupeWindowMs: 200 * DAY_MS,
  })

  now = 100 * DAY_MS
  await service.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('new')],
    scope: 'patchouli:weekly',
    dedupeKey: 'week-15',
  })

  const persisted = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(Object.keys(persisted.seen).some((key) => key.includes('link-old')), '长窗口记录被提前清理')

  assert.equal(await service.isSeen('feed:news', 'link-old'), true)
  now = 201 * DAY_MS
  assert.equal(await service.isSeen('feed:news', 'link-old'), false)
})

test('官方 QQ 平台私聊显式构造 DIRECT 发送会话', async (t) => {
  const { path } = await createStorePath(t)
  const calls = []
  const bot = {
    platform: 'qq',
    status: 'online',
    session(options) {
      calls.push({ kind: 'session', options })
      return { synthesized: true }
    },
    async sendMessage() {
      return ['channel']
    },
    async sendPrivateMessage(userId, content, guildId, options) {
      calls.push({ kind: 'dm', userId, options })
      return ['dm-1']
    },
  }
  const service = createService({ path, bots: [bot] })

  const outcome = await service.deliver({ target: { channelId: 'qq:private:openid-1' }, elements: [text('hi')] })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.messageId, 'dm-1')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.channel.type, 1)
  assert.equal(calls[0].options.channel.id, 'openid-1')
  assert.equal(calls[1].options.session.synthesized, true)
})

test('长窗口记录跨进程重启仍按自己的窗口保留（markSeen 同理）', async (t) => {
  const { path } = await createStorePath(t)
  let now = 0
  const bot = createBot()
  const create = () => createService({ path, bots: [bot], config: { storePath: path }, deps: { now: () => now } })

  const first = create()
  await first.markSeen([
    { target: { channelId: 'onebot:123' }, scope: 'feed:news', dedupeKey: 'link-old', dedupeWindowMs: 200 * DAY_MS },
  ])

  // 重启：默认窗口回到 7 天，但已落盘的记录带着自己的 200 天窗口
  now = 100 * DAY_MS
  const second = create()
  await second.deliver({
    target: { channelId: 'onebot:123' },
    elements: [text('other')],
    scope: 'patchouli:weekly',
    dedupeKey: 'week-1',
  })

  const persisted = JSON.parse(await readFile(path, 'utf8'))
  const record = Object.entries(persisted.seen).find(([key]) => key.includes('link-old'))?.[1]
  assert.equal(record.windowMs, 200 * DAY_MS)
  assert.equal(await second.isSeen('feed:news', 'link-old'), true)

  await second.markSeen([
    { target: { channelId: 'onebot:123' }, scope: 'feed:news', dedupeKey: 'link-seeded', dedupeWindowMs: 200 * DAY_MS },
  ])
  now = 250 * DAY_MS
  const third = create()
  assert.equal(await third.isSeen('feed:news', 'link-old'), false)
  assert.equal(await third.isSeen('feed:news', 'link-seeded'), true)

  now = 350 * DAY_MS
  const fourth = create()
  assert.equal(await fourth.isSeen('feed:news', 'link-seeded'), false)
})
