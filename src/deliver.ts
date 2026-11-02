import { setTimeout as delay } from 'node:timers/promises';
import { h } from 'koishi';
import { describeError, isRecord, readErrorCode } from './guard';
import type { AlbumInfo, DeliveryError, DeliveryErrorCode, DeliveryTarget } from './types';

/** 可注入的休眠，便于测试退避策略 */
export type Sleep = (milliseconds: number) => Promise<void>;

export const defaultSleep: Sleep = (milliseconds) => delay(milliseconds);

/** 目标解析后的地址（已拆出 platform / cid / 私聊用户 ID） */
export interface ChannelAddress {
  kind: 'channel';
  platform: string;
  /** `private:<uid>` 时为原始 `private:<uid>` 片段，否则为频道 ID */
  channelId: string;
  /** 私聊用户 ID，仅 `private:` 目标存在 */
  userId?: string;
}

export interface AlbumAddress {
  kind: 'album';
  platform: string;
  /** 群号（`channelId` 去掉 platform 前缀后的部分） */
  channelId: string;
  albumId: string;
  albumName?: string;
}

export type TargetAddress = ChannelAddress | AlbumAddress;

/** 携带已分类错误的异常：控制流只认分类结果，不认原始异常形态 */
export class DeliveryFailure extends Error {
  readonly error: DeliveryError;
  readonly attempts: number;

  constructor(error: DeliveryError, attempts = 0) {
    super(error.message);
    this.name = 'DeliveryFailure';
    this.error = error;
    this.attempts = attempts;
  }
}

function failure(code: DeliveryErrorCode, message: string, retryable: boolean, raw?: unknown): DeliveryFailure {
  return new DeliveryFailure({ code, message, retryable, raw });
}

const RATE_LIMIT_PATTERN = /429|rate limit|too many requests/i;
const NETWORK_CODE_PATTERN = /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE)$/;
const NETWORK_TEXT_PATTERN = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|timed? ?out|timeout/i;

/**
 * 错误严格二分（纯函数，供单测直接断言）。
 *
 * 可重试：连接重置/超时/拒绝/断管、socket hang up、超时文案、平台 429 限频、OneBot `retcode` 1200；
 * 其余一律不可重试，避免死循环消耗调用额度。
 */
export function classifyDeliveryError(error: unknown): DeliveryError {
  if (error instanceof DeliveryFailure) return error.error;

  const record = isRecord(error) ? error : undefined;
  const retcodeValue: unknown = record?.retcode;
  const retcode = typeof retcodeValue === 'number' ? retcodeValue : undefined;
  const code = readErrorCode(error);
  const message = describeError(error);

  if (RATE_LIMIT_PATTERN.test(message) || retcode === 1200 || retcode === 429) {
    return { code: 'RATE_LIMITED', message, retryable: true, raw: error };
  }
  if ((code !== undefined && NETWORK_CODE_PATTERN.test(code)) || NETWORK_TEXT_PATTERN.test(message)) {
    return { code: 'NETWORK_TIMEOUT', message, retryable: true, raw: error };
  }
  return { code: 'ADAPTER_ERROR', message, retryable: false, raw: error };
}

function splitChannelId(channelId: string): { platform: string; rest: string } {
  const index = channelId.indexOf(':');
  if (index <= 0 || index === channelId.length - 1) {
    throw failure('INVALID_PAYLOAD', `非法的目标通道 ID：${channelId}（应为 platform:cid）`, false);
  }
  const platform = channelId.slice(0, index);
  const rest = channelId.slice(index + 1);
  if (/\s/.test(platform) || /\s/.test(rest)) {
    throw failure('INVALID_PAYLOAD', `目标通道 ID 含空白字符：${channelId}`, false);
  }
  return { platform, rest };
}

/** 解析投递目标；非法形态抛 `INVALID_PAYLOAD`（不可重试） */
export function parseTarget(target: DeliveryTarget): TargetAddress {
  const { platform, rest } = splitChannelId(target.channelId);

  if (target.kind === 'album') {
    if (!target.albumId) throw failure('INVALID_PAYLOAD', '相册目标缺少 albumId', false);
    if (rest.startsWith('private:')) throw failure('INVALID_PAYLOAD', '相册目标不能指向私聊频道', false);
    return { kind: 'album', platform, channelId: rest, albumId: target.albumId, albumName: target.albumName };
  }

  if (rest.startsWith('private:')) {
    const userId = rest.slice('private:'.length);
    if (!userId) throw failure('INVALID_PAYLOAD', `私聊目标缺少用户 ID：${target.channelId}`, false);
    return { kind: 'channel', platform, channelId: rest, userId };
  }

  return { kind: 'channel', platform, channelId: rest };
}

/** 调用发送所必需的最小 Bot 面（避免把实现绑死在具体 Adapter 类上） */
export interface DeliveryBot {
  platform?: string;
  status?: string | number;
  sendMessage(channelId: string, content: h[], referrer?: unknown): Promise<string[]>;
  sendPrivateMessage?(userId: string, content: h[], guildId?: string, options?: unknown): Promise<string[]>;
  /** 可选：构造发送会话（官方 QQ Bot 的私聊需要 DIRECT 会话才能主动发） */
  session?(options: unknown): unknown;
  internal?: unknown;
}

/** 按 platform 取 Bot；缺失即 `BOT_OFFLINE`（不可重试） */
export function resolveBot(bots: readonly DeliveryBot[], platform: string): DeliveryBot {
  const bot = bots.find((candidate) => candidate.platform === platform);
  if (!bot) throw failure('BOT_OFFLINE', `没有可用的 ${platform} Bot`, false);
  return bot;
}

/** 递归剥离 `at` 元素（保留其余内容），用于静默投递 */
export function stripMentions(elements: readonly h[]): h[] {
  const result: h[] = [];
  for (const element of elements) {
    if (element.type === 'at') continue;
    if (!element.children.length) {
      result.push(element);
      continue;
    }
    const children = stripMentions(element.children);
    result.push(children.length === element.children.length ? element : h(element.type, element.attrs, ...children));
  }
  return result;
}

export interface SendOptions {
  bots: readonly DeliveryBot[];
  /** 含首次发送在内的最大尝试次数 */
  maxAttempts: number;
  initialBackoffMs: number;
  forceSilent?: boolean;
  sleep?: Sleep;
  fetch?: typeof fetch;
}

export interface SendResult {
  messageId?: string;
  attempts: number;
}

/**
 * 单目标发送：解析 → Bot 匹配 → 静默处理 → 有界指数退避。
 * 失败抛 `DeliveryFailure`（携带分类、尝试次数），成功返回消息 ID。
 */
export async function sendToTarget(
  target: DeliveryTarget,
  elements: readonly h[],
  options: SendOptions,
): Promise<SendResult> {
  const address = parseTarget(target);
  const bot = resolveBot(options.bots, address.platform);
  const payload = target.silent || options.forceSilent ? stripMentions(elements) : [...elements];
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const initialBackoffMs = Math.max(0, options.initialBackoffMs);

  let lastError: DeliveryError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const messageId = await sendOnce(bot, address, payload, options);
      return { messageId, attempts: attempt };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      lastError = classified;
      if (!classified.retryable) throw new DeliveryFailure(classified, attempt);
      if (attempt === maxAttempts) break;
      await sleep(initialBackoffMs * 2 ** (attempt - 1));
    }
  }

  const exhausted = lastError ?? { code: 'ADAPTER_ERROR', message: '投递失败', retryable: false };
  throw new DeliveryFailure(exhausted, maxAttempts);
}

async function sendOnce(
  bot: DeliveryBot,
  address: TargetAddress,
  elements: h[],
  options: SendOptions,
): Promise<string | undefined> {
  if (address.kind === 'album') return sendToAlbum(bot, address, elements, options.fetch);

  if (address.userId) {
    if (typeof bot.sendPrivateMessage !== 'function') {
      throw failure('ADAPTER_ERROR', `${address.platform} Bot 不支持私聊发送`, false);
    }
    // 官方 QQ Bot（平台 qq）的主动私聊要求 MessageEncoder 走 isDirect 分支，
    // 必须显式构造 DIRECT 发送会话；OneBot 私聊不需要也不接受这个参数。
    const directSession = address.platform === 'qq' && typeof bot.session === 'function'
      ? bot.session({ type: 'send', channel: { id: address.userId, type: 1 } })
      : undefined;
    const ids = directSession === undefined
      ? await bot.sendPrivateMessage(address.userId, elements)
      : await bot.sendPrivateMessage(address.userId, elements, undefined, { session: directSession });
    return ids[0];
  }

  const ids = await bot.sendMessage(address.channelId, elements);
  return ids[0];
}

/** OneBot 系 `internal._get`：与 Adapter 的私有 API 保持最小耦合 */
type InternalApi = (action: string, params: Record<string, unknown>) => Promise<unknown>;

const MAX_ALBUM_PAGES = 5;

function internalApi(bot: DeliveryBot): InternalApi {
  const internal = bot.internal;
  if (!isRecord(internal) || typeof internal._get !== 'function') {
    throw failure('ADAPTER_ERROR', 'Bot 未提供 internal._get，无法访问群相册接口', false);
  }
  const get = internal._get;
  return (action, params) => Promise.resolve(get.call(internal, action, params));
}

/** 探测群相册：逐个 OneBot bot 尝试，返回第一个能查到列表的 bot 的结果。 */
export async function listGroupAlbums(
  bots: readonly DeliveryBot[],
  platform: string,
  groupId: string,
): Promise<AlbumInfo[]> {
  const candidates = bots.filter((bot) => bot.platform === platform);
  for (const bot of candidates) {
    const internal = bot.internal;
    if (!isRecord(internal) || typeof internal._get !== 'function') continue;
    const get = internal._get.bind(internal) as InternalApi;
    try {
      let groupName = '';
      try {
        const info = await get('get_group_info', { group_id: groupId });
        groupName = readStringField(info, ['group_name']) ?? '';
      } catch {
        groupName = '';
      }
      const albums: AlbumInfo[] = [];
      let attachInfo: string | undefined;
      for (let page = 0; page < MAX_ALBUM_PAGES; page += 1) {
        const response = await get('get_qun_album_list', {
          group_id: groupId,
          ...(attachInfo ? { attach_info: attachInfo } : {}),
        });
        for (const album of readAlbumList(response)) {
          const albumId = readStringField(album, ['album_id', 'id']);
          if (albumId === undefined) continue;
          albums.push({
            groupId,
            groupName,
            albumId,
            albumName: readStringField(album, ['name', 'album_name']) ?? '',
          });
        }
        attachInfo = readStringField(response, ['attach_info']);
        if (attachInfo === undefined) break;
      }
      return albums;
    } catch {
      // 这个 bot 不在该群或无权限，试下一个
    }
  }
  return [];
}

/**
 * 群相册投递（对齐 miyako-intel 已证实做法）：
 * 仅接受 image / img 元素（Koishi `h.image()` 产出 `img`）→ （可选）反查相册名 → 逐张 `upload_image_to_qun_album`。
 */
async function sendToAlbum(
  bot: DeliveryBot,
  address: AlbumAddress,
  elements: readonly h[],
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  const images = elements.filter((element) => element.type === 'image' || element.type === 'img');
  if (images.length === 0) throw failure('INVALID_PAYLOAD', '相册目标只接受 image / img 元素', false);

  const internal = internalApi(bot);
  const albumName = address.albumName ?? (await resolveAlbumName(internal, address.channelId, address.albumId));
  const download = fetchImpl ?? fetch;

  for (const image of images) {
    const base64 = await toBase64(readImageSource(image), download);
    const response = await internal('upload_image_to_qun_album', {
      group_id: address.channelId,
      album_id: address.albumId,
      album_name: albumName,
      file: `base64://${base64}`,
    });
    const retcode = readRetcode(response);
    if (retcode !== undefined && retcode !== 0) {
      throw new DeliveryFailure({
        code: 'ALBUM_UPLOAD_FAILED',
        message: `相册上传失败（retcode ${retcode}，相册 ${albumName}）`,
        retryable: retcode === 1200 || retcode === 429,
        raw: response,
      });
    }
  }

  // 相册没有单条消息 ID
  return undefined;
}

async function resolveAlbumName(internal: InternalApi, groupId: string, albumId: string): Promise<string> {
  let attachInfo: string | undefined;

  for (let page = 0; page < MAX_ALBUM_PAGES; page += 1) {
    const params: Record<string, unknown> = { group_id: groupId };
    if (attachInfo !== undefined) params.attach_info = attachInfo;

    const response = await internal('get_qun_album_list', params);
    const albums = readAlbumList(response);

    for (const album of albums) {
      const id = readStringField(album, ['album_id', 'id']);
      if (id !== albumId) continue;
      const name = readStringField(album, ['name', 'album_name']);
      if (name) return name;
    }

    attachInfo = readStringField(response, ['attach_info']);
    if (attachInfo === undefined || albums.length === 0) break;
  }

  throw failure('TARGET_NOT_FOUND', `群 ${groupId} 中找不到相册 ${albumId}`, false);
}

function readAlbumList(response: unknown): readonly unknown[] {
  if (Array.isArray(response)) return response;
  if (!isRecord(response)) return [];

  const data = response.data;
  const candidates: unknown[] = [
    response.album_list,
    response.albums,
    response.list,
    isRecord(data) ? data.album_list : undefined,
    isRecord(data) ? data.albums : undefined,
    isRecord(data) ? data.list : undefined,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function readStringField(source: unknown, fields: readonly string[]): string | undefined {
  if (!isRecord(source)) return undefined;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readRetcode(response: unknown): number | undefined {
  if (!isRecord(response)) return undefined;
  const value = response.retcode;
  return typeof value === 'number' ? value : undefined;
}

function readImageSource(element: h): unknown {
  const attrs: Record<string, unknown> = element.attrs;
  return attrs.src ?? attrs.url ?? attrs.file;
}

async function toBase64(source: unknown, fetchImpl: typeof fetch): Promise<string> {
  if (Buffer.isBuffer(source)) return source.toString('base64');
  if (typeof source !== 'string' || source.length === 0) {
    throw failure('INVALID_PAYLOAD', 'image 元素缺少 src/url', false);
  }
  if (source.startsWith('base64://')) return source.slice('base64://'.length);

  if (source.startsWith('data:')) {
    const comma = source.indexOf(',');
    if (comma < 0) throw failure('INVALID_PAYLOAD', 'data URI 缺少逗号分隔符', false);
    return source.slice(comma + 1);
  }

  if (/^https?:\/\//i.test(source)) {
    const response = await fetchImpl(source);
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const code: DeliveryErrorCode = response.status === 429
        ? 'RATE_LIMITED'
        : response.status >= 500 ? 'NETWORK_TIMEOUT' : 'TARGET_NOT_FOUND';
      throw failure(code, `图片下载失败：HTTP ${response.status}`, retryable);
    }
    return Buffer.from(await response.arrayBuffer()).toString('base64');
  }

  throw failure('INVALID_PAYLOAD', `不支持的 image 来源：${source.slice(0, 32)}`, false);
}
