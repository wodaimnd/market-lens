/**
 * 「更新只在一周内提示」的判据回归。
 *
 * 需求原话：这个插件的更新提示只在最近一星期内有更新时才提示。
 *
 * 为什么不能直接用 checkedAt：那是**本地轮询时间**，每次刷新都变成"现在"，
 * 用它当新鲜度会让每个可更新包永远亮着 —— 正是要修的问题。
 * 真正的判据是 `update.publishedAt`（目标版本在 registry 上的发布时间）。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/** 与 client.js 里 isFreshUpdate 同一套逻辑（client 用工厂函数，不便直接 import）。 */
const FRESH_UPDATE_MS = 7 * 24 * 60 * 60 * 1000
function isFreshUpdate(update, now = Date.now()) {
  if (!update) return false
  const stamp = update.publishedAt || update.releasedAt || null
  if (!stamp) return false
  const at = Date.parse(stamp)
  if (!Number.isFinite(at)) return false
  return now - at <= FRESH_UPDATE_MS
}

const NOW = Date.parse('2026-11-08T12:00:00.000Z')
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

describe('一周内才新鲜', () => {
  it('昨天发布 → 新鲜（冒绿点）', () => {
    assert.equal(isFreshUpdate({ available: true, to: '1.1.0', publishedAt: daysAgo(1) }, NOW), true)
  })

  it('第 6 天 → 仍新鲜', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0', publishedAt: daysAgo(6) }, NOW), true)
  })

  it('第 7 天整 → 仍算在内（闭区间）', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0', publishedAt: daysAgo(7) }, NOW), true)
  })

  it('第 8 天 → 不新鲜（不冒绿点）', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0', publishedAt: daysAgo(8) }, NOW), false)
  })

  it('三个月前 → 不新鲜', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0', publishedAt: daysAgo(90) }, NOW), false)
  })
})

describe('拿不到证据就不冒', () => {
  it('没有 publishedAt → 不新鲜', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0' }, NOW), false)
  })

  it('publishedAt 是坏时间戳 → 不新鲜', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0', publishedAt: 'not-a-date' }, NOW), false)
  })

  it('null / undefined 更新对象 → 不新鲜', () => {
    assert.equal(isFreshUpdate(null, NOW), false)
    assert.equal(isFreshUpdate(undefined, NOW), false)
  })

  it('绝不退回 checkedAt（那是本地轮询时间，会让所有包永远亮）', () => {
    // 这是这轮最关键的一条：checkedAt 是"我们什么时候查的"，
    // 每个刷新周期都会变成"现在"。用它当新鲜度等于没有判据。
    const update = { to: '1.1.0', checkedAt: new Date(NOW).toISOString() }
    assert.equal(isFreshUpdate(update, NOW), false)
  })
})

describe('releasedAt 可作后备', () => {
  it('没有 publishedAt 但有 releasedAt 时用它', () => {
    assert.equal(isFreshUpdate({ to: '1.1.0', releasedAt: daysAgo(2) }, NOW), true)
  })

  it('publishedAt 优先于 releasedAt', () => {
    // publishedAt 更旧 → 以它为准，不新鲜
    assert.equal(
      isFreshUpdate({ publishedAt: daysAgo(30), releasedAt: daysAgo(1) }, NOW),
      false,
    )
  })
})

test('真机样本：humanizer-ru 3.32.0 发布于 2026-10-19，在 11-08 不该冒绿点', () => {
  // 真实数据：npm packument 的 time['3.32.0'] = 2026-10-19
  const published = '2026-10-19T09:20:37.000Z'
  assert.equal(isFreshUpdate({ to: '3.32.0', publishedAt: published }, NOW), false, '20 天前，不该冒')
})
