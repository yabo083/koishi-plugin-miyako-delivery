const CLOCK_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * 判断本地时间是否落在静默区间内。
 *
 * - 按宿主本机时区取 `HH:mm`；
 * - `start > end` 视为跨午夜（如 `23:00`–`07:00`）；
 * - `start === end` 视为零长度区间，恒不静默；
 * - 任一时刻非法时按「不静默」处理，避免配置笔误导致全量停发。
 */
export function isQuietHours(date: Date, start: string, end: string): boolean {
  const fromMatch = CLOCK_PATTERN.exec(start.trim());
  const toMatch = CLOCK_PATTERN.exec(end.trim());
  if (!fromMatch || !toMatch) return false;
  const from = Number(fromMatch[1]) * 60 + Number(fromMatch[2]);
  const to = Number(toMatch[1]) * 60 + Number(toMatch[2]);
  if (from === to) return false;

  const minutes = date.getHours() * 60 + date.getMinutes();
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
