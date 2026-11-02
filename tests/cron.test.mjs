import test from 'node:test'
import assert from 'node:assert/strict'
import { nextCronAt, parseCron } from '../lib/cron.js'

const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).getTime()

test('CRON-01: 周一 04:30 在当天前后分别落到本周/下周', () => {
  assert.equal(nextCronAt('30 4 * * 1', at(2026, 11, 2, 4, 0)), at(2026, 11, 2, 4, 30))
  assert.equal(nextCronAt('30 4 * * 1', at(2026, 11, 2, 5, 0)), at(2026, 11, 9, 4, 30))
})

test('CRON-02: 步长与工作日区间', () => {
  assert.equal(nextCronAt('*/15 * * * *', at(2026, 11, 2, 4, 1)), at(2026, 11, 2, 4, 15))
  assert.equal(nextCronAt('0 9 * * 1-5', at(2026, 11, 6, 10, 0)), at(2026, 11, 9, 9, 0))
})

test('CRON-03: 非法表达式被拒绝', () => {
  assert.throws(() => parseCron('60 * * * *'), /分钟/)
  assert.throws(() => parseCron('* *'), /五段/)
})

const utc = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h, min, 0, 0)

test('CRON-04: 指定时区按该时区日历计算（Asia/Shanghai 固定 +08:00）', () => {
  assert.equal(nextCronAt('0 9 * * *', utc(2026, 11, 2, 0, 0), 'Asia/Shanghai'), utc(2026, 11, 2, 1, 0))
  // 周日 20:00 CST 起，下一个周一 04:30 CST
  assert.equal(nextCronAt('30 4 * * 1', utc(2026, 11, 1, 12, 0), 'Asia/Shanghai'), utc(2026, 11, 1, 20, 30))
  assert.equal(nextCronAt('*/15 * * * *', utc(2026, 11, 2, 0, 1), 'Asia/Shanghai'), utc(2026, 11, 2, 0, 15))
})

test('CRON-05: 跨时区与宿主本地时区可不同', () => {
  // 2026-11-02 是美东夏令时结束后的 EST（UTC-5），09:00 = 14:00Z
  assert.equal(nextCronAt('0 9 * * *', utc(2026, 11, 2, 0, 0), 'America/New_York'), utc(2026, 11, 2, 14, 0))
  // 同样的表达式在 Asia/Shanghai 是 01:00Z
  assert.equal(nextCronAt('0 9 * * *', utc(2026, 11, 2, 0, 0), 'Asia/Shanghai'), utc(2026, 11, 2, 1, 0))
})
