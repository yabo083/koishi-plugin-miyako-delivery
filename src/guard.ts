/**
 * 全局唯一的宽松对象守卫。
 *
 * 仅用于「未知来源必须是对象」这一层判断（`JSON.parse` 结果、被抛出的未知错误、
 * Adapter 的 `internal` 等）；字段级校验一律在使用处用 `typeof` / `in` 判定，
 * 避免在每个调用点重复实现守卫。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从未知错误对象上读取字符串形态的 `code`（Node 系统错误、OneBot 错误均用此字段） */
export function readErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** 把未知错误压成一行可读文案 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
