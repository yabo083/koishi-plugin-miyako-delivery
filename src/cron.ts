/**
 * 极简本地 cron：支持标准五段表达式（分 时 日 月 周），
 * 数字、`*`、列表、区间、步长；不依赖 koishi-plugin-cron。
 *
 * 只服务基础设施内部定时（例如知识周报），不做秒级调度。
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const MINUTE = 60_000;
const MAX_SCAN_MINUTES = 366 * 24 * 60;

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

/** 按 IANA 时区展开一个瞬时时刻的本地日历字段（`Asia/Shanghai` 固定 +08:00，无夏令时） */
function zonedClock(instant: number, timeZone: string): ZonedClock {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    zonedFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: WEEKDAY_MAP[pick('weekday')] ?? 0,
  };
}

/** 该时区在 `instant` 时刻相对 UTC 的偏移（毫秒，本地时间减 UTC） */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const clock = zonedClock(instant, timeZone);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - instant;
}

/** 把「该时区的本地日历时间」换算成瞬时时刻；夏令时跳变处取最近的可用时刻 */
function zoneEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = zoneOffsetMs(naive, timeZone);
  const first = naive - firstOffset;
  const secondOffset = zoneOffsetMs(first, timeZone);
  if (secondOffset === firstOffset) return first;
  const second = naive - secondOffset;
  return zoneOffsetMs(second, timeZone) === secondOffset ? second : first;
}

function dayMatches(fields: CronFields, day: number, weekday: number): boolean {
  return fields.dayOfMonthRestricted && fields.dayOfWeekRestricted
    ? fields.dayOfMonth.has(day) || fields.dayOfWeek.has(weekday)
    : fields.dayOfMonth.has(day) && fields.dayOfWeek.has(weekday);
}

function parseField(raw: string, min: number, max: number, label: string): { values: Set<number>; restricted: boolean } {
  const text = raw.trim();
  if (text === '') throw new Error(`cron: ${label} 字段为空`);
  const values = new Set<number>();
  let restricted = false;
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (piece === '') throw new Error(`cron: ${label} 字段有空项`);
    const stepMatch = /^(.+?)\/(\d+)$/u.exec(piece);
    const base = stepMatch ? stepMatch[1] : piece;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: ${label} 步长非法`);
    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/u.exec(base);
      if (rangeMatch) {
        start = Number(rangeMatch[1]);
        end = Number(rangeMatch[2]);
      } else if (/^\d+$/u.test(base)) {
        start = Number(base);
        end = stepMatch ? max : start;
      } else {
        throw new Error(`cron: ${label} 字段非法: ${piece}`);
      }
      restricted = true;
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron: ${label} 范围非法: ${piece}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`cron: ${label} 没有可用值`);
  return { values, restricted };
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) throw new Error('cron: 需要五段表达式「分 时 日 月 周」');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const minutes = parseField(minute, 0, 59, '分钟');
  const hours = parseField(hour, 0, 23, '小时');
  const days = parseField(dayOfMonth, 1, 31, '日');
  const months = parseField(month, 1, 12, '月');
  const weeks = parseField(dayOfWeek, 0, 7, '周');
  const normalizedWeeks = new Set<number>();
  for (const value of weeks.values) normalizedWeeks.add(value === 7 ? 0 : value);
  return {
    minute: minutes.values,
    hour: hours.values,
    dayOfMonth: days.values,
    month: months.values,
    dayOfWeek: normalizedWeeks,
    dayOfMonthRestricted: days.restricted,
    dayOfWeekRestricted: weeks.restricted,
  };
}

/** 下一个匹配的本地时刻（严格晚于 `from`，按分钟对齐）。 */
/**
 * 下一个匹配时刻（严格晚于 `from`，按分钟对齐）。
 *
 * 不传 `timeZone` 时按宿主本地时区计算；传 IANA 时区时按该时区的日历计算，
 * 用于业务插件固定东八区、而宿主可能运行在别处的场景。
 */
export function nextCronAt(expression: string | CronFields, from: number, timeZone?: string): number {
  const fields = typeof expression === 'string' ? parseCron(expression) : expression;
  if (timeZone) return nextCronAtInZone(fields, from, timeZone);

  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let index = 0; index < MAX_SCAN_MINUTES; index += 1) {
    if (
      fields.month.has(cursor.getMonth() + 1) &&
      dayMatches(fields, cursor.getDate(), cursor.getDay()) &&
      fields.hour.has(cursor.getHours()) &&
      fields.minute.has(cursor.getMinutes())
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`cron: 一年内没有匹配时刻: ${String(expression)}`);
}

/** 指定时区的查找：按月/日/时整段跳过，避免逐分钟扫一年 */
function nextCronAtInZone(fields: CronFields, from: number, timeZone: string): number {
  let cursor = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  for (let index = 0; index < MAX_SCAN_MINUTES; index += 1) {
    const clock = zonedClock(cursor, timeZone);
    let next: number;
    if (!fields.month.has(clock.month)) {
      next = zoneEpoch(clock.year, clock.month + 1, 1, 0, 0, timeZone);
    } else if (!dayMatches(fields, clock.day, clock.weekday)) {
      next = zoneEpoch(clock.year, clock.month, clock.day + 1, 0, 0, timeZone);
    } else if (!fields.hour.has(clock.hour)) {
      next = zoneEpoch(clock.year, clock.month, clock.day, clock.hour + 1, 0, timeZone);
    } else if (!fields.minute.has(clock.minute)) {
      next = cursor + MINUTE;
    } else {
      return cursor;
    }
    // 夏令时跳变或极端边界下换算可能原地踏步，强制前进一分钟防死循环
    cursor = next > cursor ? next : cursor + MINUTE;
  }
  throw new Error(`cron: 一年内没有匹配时刻（${timeZone}）: ${JSON.stringify([...fields.hour])} 等`);
}

export const CRON_MINUTE_MS = MINUTE;
