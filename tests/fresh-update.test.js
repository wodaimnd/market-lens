/**
 * 更新提示的「新鲜度分级」回归。
 *
 * 需求（用户原话）：
 *   所有可更新都亮，只是颜色深浅不同，时间越近越亮，
 *   1 天 / 2-6 天 / 7 天，超过一星期提示消失。
 *
 * 四档 + 不提示：
 *   tracked  ≤ 1 天   最亮（实心 + 双层光晕）
 *   recent   ≤ 6 天   亮（实心 + 单层光晕）
 *   fading   ≤ 7 天   暗（半透明 + 细边）
 *   stale    > 7 天   不画点（按钮上仍写 ↑ x.y.z）
 *   unknown  拿不到发布时间   仍画（中性灰）—— "所有可更新都要看见"
 *
 * 与 0.17.0 的差别：那一版是"一周内才亮"，用户要求改成"全亮但分深浅"。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/** 与 client.js 里 updateFreshness 同一套逻辑（client 用工厂函数，不便直接 import）。 */
const DAY_MS = 24 * 60 * 60 * 1000
const FRESH_TIERS = {
  tracked: { maxAgeMs: 1 * DAY_MS },
  recent: { maxAgeMs: 6 * DAY_MS },
  fading: { maxAgeMs: 7 * DAY_MS },
}

function updateFreshness(update, now = Date.now()) {
  const unknown = { tier: 'unknown', ageMs: null, publishedAt: null }
  if (!update) return { tier: 'stale', ageMs: null, publishedAt: null }
  const stamp = update.publishedAt || update.releasedAt || null
  if (!stamp) return unknown
  const at = Date.parse(stamp)
  if (!Number.isFinite(at)) return unknown
  const ageMs = Math.max(0, now - at)
  const publishedAt = stamp
  if (ageMs <= FRESH_TIERS.tracked.maxAgeMs) return { tier: 'tracked', ageMs, publishedAt }
  if (ageMs <= FRESH_TIERS.recent.maxAgeMs) return { tier: 'recent', ageMs, publishedAt }
  if (ageMs <= FRESH_TIERS.fading.maxAgeMs) return { tier: 'fading', ageMs, publishedAt }
  return { tier: 'stale', ageMs, publishedAt }
}

const shouldShowUpdateDot = (update, now = Date.now()) =>
  updateFreshness(update, now).tier !== 'stale'

const NOW = Date.parse('2026-11-08T12:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const daysAgo = (n) => ago(n * DAY_MS)

describe('四档分级：越近越亮', () => {
  it('刚刚发布 → tracked（最亮）', () => {
    const result = updateFreshness({ to: '1.1.0', publishedAt: ago(60000) }, NOW)
    assert.equal(result.tier, 'tracked')
  })

  it('1 天整 → 仍是 tracked（闭区间）', () => {
    assert.equal(updateFreshness({ publishedAt: daysAgo(1) }, NOW).tier, 'tracked')
  })

  it('2 天 → recent（次亮）', () => {
    const result = updateFreshness({ publishedAt: daysAgo(2) }, NOW)
    assert.equal(result.tier, 'recent')
    assert.equal(Math.floor(result.ageMs / DAY_MS), 2, 'ageMs 要能让界面算出"2 天前"')
  })

  it('6 天 → 仍是 recent', () => {
    assert.equal(updateFreshness({ publishedAt: daysAgo(6) }, NOW).tier, 'recent')
  })

  it('7 天 → fading（最暗但仍提示）', () => {
    assert.equal(updateFreshness({ publishedAt: daysAgo(7) }, NOW).tier, 'fading')
  })

  it('8 天 → stale（不提示）', () => {
    assert.equal(updateFreshness({ publishedAt: daysAgo(8) }, NOW).tier, 'stale')
  })

  it('三个月 → stale', () => {
    assert.equal(updateFreshness({ publishedAt: daysAgo(90) }, NOW).tier, 'stale')
  })
})

describe('是否画点', () => {
  it('tracked / recent / fading 都画', () => {
    for (const n of [0, 2, 6, 7]) {
      assert.equal(shouldShowUpdateDot({ publishedAt: daysAgo(n) }, NOW), true, n + ' 天前应当画点')
    }
  })

  it('超过一周不画', () => {
    for (const n of [8, 30, 90]) {
      assert.equal(shouldShowUpdateDot({ publishedAt: daysAgo(n) }, NOW), false, n + ' 天前不该画点')
    }
  })

  it('没有更新对象不画', () => {
    assert.equal(shouldShowUpdateDot(null, NOW), false)
  })
})

describe('拿不到发布时间：仍然画，但用中性色', () => {
  it('没有 publishedAt → unknown，且**仍然画点**', () => {
    // 用户要求"所有可更新都亮"。没有发布时间不等于没有更新，
    // 所以不能藏掉 —— 用中性灰表示"有更新，但不知道多新"。
    const result = updateFreshness({ to: '1.1.0' }, NOW)
    assert.equal(result.tier, 'unknown')
    assert.equal(shouldShowUpdateDot({ to: '1.1.0' }, NOW), true)
  })

  it('坏时间戳也归 unknown，不崩', () => {
    const result = updateFreshness({ publishedAt: 'not-a-date' }, NOW)
    assert.equal(result.tier, 'unknown')
    assert.equal(shouldShowUpdateDot({ publishedAt: 'not-a-date' }, NOW), true)
  })

  it('绝不退回 checkedAt（本地轮询时间会让所有包永远最亮）', () => {
    const update = { to: '1.1.0', checkedAt: new Date(NOW).toISOString() }
    const result = updateFreshness(update, NOW)
    assert.equal(result.tier, 'unknown', 'checkedAt 不能当新鲜度')
  })
})

describe('releasedAt 可作后备', () => {
  it('没有 publishedAt 但有 releasedAt 时按它算', () => {
    assert.equal(updateFreshness({ releasedAt: daysAgo(2) }, NOW).tier, 'recent')
  })

  it('publishedAt 优先', () => {
    // publishedAt 更新 → 以它为准
    assert.equal(
      updateFreshness({ publishedAt: daysAgo(1), releasedAt: daysAgo(30) }, NOW).tier,
      'tracked',
    )
  })
})

test('真机样本：humanizer-ru 3.32.0 发布于 2026-10-19，11-08 时应当 stale', () => {
  // 真实数据：npm packument 的 time['3.32.0'] = 2026-10-19T09:20:37Z
  const published = '2026-10-19T09:20:37.000Z'
  const result = updateFreshness({ to: '3.32.0', publishedAt: published }, NOW)
  assert.equal(result.tier, 'stale', '20 天前，不该画点')
  assert.equal(shouldShowUpdateDot({ publishedAt: published }, NOW), false)
})
