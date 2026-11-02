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
