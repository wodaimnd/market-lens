/**
 * source-cache 回归：条件请求的判定口径。
 *
 * 一条不能违反的约束（这是整个设计的核心）：
 *   **只有 304 才算「确认最新」。**
 *   网络失败 / 5xx / 超时 —— 一律不能把 lastConfirmedAt 往前推，
 *   更不能静默沿用旧目录假装同步成功。过期目录对用户是错误答案，
 *   比报错更糟：他会以为"这个插件不存在"，而其实是"目录没拉到"。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_REASONS,
  catalogStaleness,
  conditionalOf,
  confirmFetched,
  confirmNotModified,
  normalizeSourceCache,
  recordFailure,
  stalenessOf,
} from '../lib/source-cache.js'

const T0 = Date.parse('2026-11-06T00:00:00.000Z')
const HOUR = 60 * 60 * 1000

describe('normalizeSourceCache：老配置与脏数据都不崩', () => {
  it('空值给出全 null 记录', () => {
    const record = normalizeSourceCache(undefined)
    assert.equal(record.etag, null)
    assert.equal(record.lastConfirmedAt, null)
    assert.equal(record.failureCount, 0)
  })

  it('超长的标记被丢掉（避免把整段响应头塞进配置）', () => {
    const record = normalizeSourceCache({ etag: 'x'.repeat(500) })
    assert.equal(record.etag, null)
  })

  it('非整数的 failureCount 归零', () => {
    assert.equal(normalizeSourceCache({ failureCount: 1.5 }).failureCount, 0)
    assert.equal(normalizeSourceCache({ failureCount: -3 }).failureCount, 0)
  })
})

describe('conditionalOf：没有标记就发普通请求', () => {
  it('有 etag 时带出去', () => {
    assert.deepEqual(conditionalOf({ etag: '"abc"' }), { etag: '"abc"', lastModified: null })
  })

  it('只有 lastModified 时也带（有些源站不发 ETag）', () => {
    const value = conditionalOf({ lastModified: 'Wed, 05 Nov 2026 00:00:00 GMT' })
    assert.ok(value)
    assert.equal(value.lastModified, 'Wed, 05 Nov 2026 00:00:00 GMT')
  })

  it('两者都没有 → null，不发条件请求', () => {
    assert.equal(conditionalOf({}), null)
    assert.equal(conditionalOf(null), null)
  })
})

describe('304 才推进 lastConfirmedAt', () => {
  it('confirmNotModified 推进并保留标记', () => {
    const next = confirmNotModified({ etag: '"v1"' }, { etag: '"v1"' }, T0)
    assert.equal(next.lastConfirmedAt, new Date(T0).toISOString())
    assert.equal(next.etag, '"v1"')
  })

  it('304 带了新 ETag 时要更新（否则下次白问一遍）', () => {
    const next = confirmNotModified({ etag: '"v1"' }, { etag: '"v2"' }, T0)
    assert.equal(next.etag, '"v2"')
  })

  it('confirmFetched 更新标记并清掉失败计数', () => {
    const before = { etag: '"old"', failureCount: 3, lastFailureAt: new Date(T0 - HOUR).toISOString() }
    const next = confirmFetched(before, { etag: '"new"' }, T0)
    assert.equal(next.etag, '"new"')
    assert.equal(next.lastConfirmedAt, new Date(T0).toISOString())
    assert.equal(next.failureCount, 0, '成功一次就清零连续失败')
    assert.equal(next.lastFailureAt, null)
  })

  it('200 但响应没带 ETag 时要清掉旧标记（旧标记对新内容无效）', () => {
    const next = confirmFetched({ etag: '"old"' }, { etag: null }, T0)
    assert.equal(next.etag, null)
  })
})

describe('失败绝不推进 lastConfirmedAt', () => {
  it('recordFailure 只加失败计数，时间不动', () => {
    const confirmed = new Date(T0).toISOString()
    const next = recordFailure({ etag: '"v1"', lastConfirmedAt: confirmed }, T0 + HOUR)
    assert.equal(next.lastConfirmedAt, confirmed, '失败不能让目录看起来更新')
    assert.equal(next.failureCount, 1)
    assert.equal(next.lastFailureAt, new Date(T0 + HOUR).toISOString())
    assert.equal(next.etag, '"v1"', '标记要留着：下次还能做条件请求')
  })

  it('连续失败会累加', () => {
    let record = { failureCount: 2 }
    record = recordFailure(record, T0)
    assert.equal(record.failureCount, 3)
  })
})

describe('stalenessOf：三种 stale 原因要分开说', () => {
  it('从没确认过 → never', () => {
    const verdict = stalenessOf({}, { now: T0 })
    assert.equal(verdict.stale, true)
    assert.equal(verdict.reason, STALE_REASONS.never)
    assert.equal(verdict.ageMs, null)
  })

  it('坏时间戳按「从没确认过」处理：宁可说旧，也不要说新', () => {
    const verdict = stalenessOf({ lastConfirmedAt: 'not-a-date' }, { now: T0 })
    assert.equal(verdict.stale, true)
    assert.equal(verdict.reason, STALE_REASONS.never)
  })

  it('刚确认过 → 不 stale', () => {
    const verdict = stalenessOf({ lastConfirmedAt: new Date(T0 - HOUR).toISOString() }, { now: T0 })
    assert.equal(verdict.stale, false)
    assert.equal(verdict.reason, null)
  })

  it('超过 maxAge → old', () => {
    const verdict = stalenessOf(
      { lastConfirmedAt: new Date(T0 - 30 * HOUR).toISOString() },
      { now: T0, maxAgeMs: 24 * HOUR },
    )
    assert.equal(verdict.reason, STALE_REASONS.old)
  })

  it('失败比「旧」更优先：failed 更可行动（知道该重试）', () => {
    const verdict = stalenessOf(
      { lastConfirmedAt: new Date(T0 - HOUR).toISOString(), lastFailureAt: new Date(T0 - 10 * 60 * 1000).toISOString(), failureCount: 2 },
      { now: T0 },
    )
    assert.equal(verdict.stale, true)
    assert.equal(verdict.reason, STALE_REASONS.failed, '刚失败过要说 failed，不是 old')
  })

  it('失败时间早于确认时间 → 不是 failed（最后一次是成功的）', () => {
    const verdict = stalenessOf(
      { lastConfirmedAt: new Date(T0 - 10 * 60 * 1000).toISOString(), lastFailureAt: new Date(T0 - HOUR).toISOString(), failureCount: 1 },
      { now: T0 },
    )
    assert.equal(verdict.stale, false)
  })
})

describe('catalogStaleness：整份目录的聚合结论', () => {
  it('全部健康 → 不 stale，并给出最早确认时间', () => {
    const result = catalogStaleness(
      {
        a: { lastConfirmedAt: new Date(T0 - HOUR).toISOString() },
        b: { lastConfirmedAt: new Date(T0 - 2 * HOUR).toISOString() },
      },
      { now: T0 },
    )
    assert.equal(result.stale, false)
    assert.equal(result.earliestConfirmedAt, new Date(T0 - 2 * HOUR).toISOString())
  })

  it('有源降级 → stale，并列出它和原因', () => {
    const result = catalogStaleness(
      {
        a: { lastConfirmedAt: new Date(T0 - HOUR).toISOString() },
        b: { lastFailureAt: new Date(T0 - 60 * 1000).toISOString(), failureCount: 1, lastConfirmedAt: new Date(T0 - 3 * HOUR).toISOString() },
      },
      { now: T0 },
    )
    assert.equal(result.stale, true)
    assert.equal(result.degraded.length, 1)
    assert.equal(result.degraded[0].id, 'b')
    assert.equal(result.degraded[0].reason, STALE_REASONS.failed)
  })

  it('被禁用的源不参与判定（永远"旧"关掉的源没有意义）', () => {
    const result = catalogStaleness(
      { a: { lastConfirmedAt: new Date(T0 - HOUR).toISOString() }, b: {} },
      { now: T0, enabled: ['a'] },
    )
    assert.equal(result.stale, false, '禁用的 b 不该拉低整份目录')
  })

  it('空输入不崩', () => {
    const result = catalogStaleness(null, { now: T0 })
    assert.equal(result.stale, false)
    assert.equal(result.earliestConfirmedAt, null)
  })
})
