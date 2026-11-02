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
export function nextCronAt(expression: string | CronFields, from: number): number {
  const fields = typeof expression === 'string' ? parseCron(expression) : expression;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let index = 0; index < MAX_SCAN_MINUTES; index += 1) {
    const month = cursor.getMonth() + 1;
    const day = cursor.getDate();
    const weekday = cursor.getDay();
    const dayMatch =
      fields.dayOfMonthRestricted && fields.dayOfWeekRestricted
        ? fields.dayOfMonth.has(day) || fields.dayOfWeek.has(weekday)
        : fields.dayOfMonth.has(day) && fields.dayOfWeek.has(weekday);
    if (
      fields.month.has(month) &&
      dayMatch &&
      fields.hour.has(cursor.getHours()) &&
      fields.minute.has(cursor.getMinutes())
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`cron: 一年内没有匹配时刻: ${String(expression)}`);
}

export const CRON_MINUTE_MS = MINUTE;
