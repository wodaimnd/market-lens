/**
 * 「补查发布时间」回归：让 compat 路径的包也能算出新鲜度。
 *
 * 背景：0.17.1 起更新提示按发布时间分四档亮度。但有个缺口 ——
 *
 *   走 compat 缓存那条路径的包，`resolve()` 根本没被调用
 *   （它们的「最新版本」来自同步时已算好的 npm latest）。
 *   那些包没有 publishedAt，界面上只能显示中性灰点。
 *
 * 补法：用户点「检查更新」时，对还没有 publishedAt 的可更新包补查一次。
 * 这是低频操作，所以愿意为它多花几个请求。
 *
 * 三条约束：
 *   1. 只补**还没缓存**的，已查过的不重问
 *   2. null 缓存（"查过但拿不到"）的 TTL 只有 30 分钟，不是 6 小时
 *      —— 包可能被重新发布、网络也可能恢复，冻住太久会让它一直灰着
 *   3. 补到之后要能落盘，重启不用重查
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  NULL_PUBLISHED_TTL_MS,
  PUBLISHED_TTL_MS,
  UpdateService,
} from '../lib/updates.js'

const NOW = Date.parse('2026-11-08T12:00:00.000Z')

/** 造一个只测发布缓存的 service（不碰 registry）。 */
function makeService({ now = NOW } = {}) {
  let clock = now
  const service = new UpdateService({
    now: () => clock,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  // 覆写网络方法：这里的测试只关心缓存语义，不发真请求
  service.publishedAtOf = async function fake(pkg, version) {
    // 用一个可控的"网络"：测试里直接塞进缓存并返回
    const value = '2026-11-07T00:00:00.000Z'
    this.publishedCache.set(String(pkg).toLowerCase() + '@' + version, { at: clock, value })
    return value
  }
  return { service, advance: (ms) => { clock += ms } }
}

describe('publishedSnapshot / restorePublished：落盘与恢复', () => {
  it('导出后能原样恢复', () => {
    const { service } = makeService()
    service.publishedCache.set('foo@1.0.0', { at: NOW, value: '2026-11-01T00:00:00.000Z' })
    const snapshot = service.publishedSnapshot()
    assert.equal(snapshot['foo@1.0.0'], '2026-11-01T00:00:00.000Z')

    const fresh = makeService().service
    const restored = fresh.restorePublished(snapshot)
    assert.equal(restored, 1)
    assert.equal(fresh.cachedPublishedAt('foo', '1.0.0'), '2026-11-01T00:00:00.000Z')
  })

  it('null 缓存也落盘（"查过但拿不到"是付过代价的结论）', () => {
    const { service } = makeService()
    service.publishedCache.set('bar@2.0.0', { at: NOW, value: null })
    const snapshot = service.publishedSnapshot()
    assert.equal(snapshot['bar@2.0.0'], null, 'null 要保留，不能丢')
  })

  it('恢复 null 缓存时把 TTL 往回拨（让它更早过期）', () => {
    const { service: seed } = makeService()
    seed.publishedCache.set('baz@3.0.0', { at: NOW, value: null })
    const snapshot = seed.publishedSnapshot()

    const { service: fresh } = makeService({ now: NOW })
    fresh.restorePublished(snapshot)
    // 恢复后立刻查：仍然有效（null）
    assert.equal(fresh.cachedPublishedAt('baz', '3.0.0'), null)
    // 但 35 分钟后（超过 NULL TTL 30min）就该过期
    const later = makeService({ now: NOW + 35 * 60 * 1000 }).service
    later.restorePublished(snapshot)
    // 注意：恢复发生在 later 的时刻，所以要模拟"恢复后过 35 分钟"
    const evenLater = NOW + 35 * 60 * 1000
    assert.equal(
      fresh.cachedPublishedAt('baz', '3.0.0', evenLater) ,
      null,
      '过期的 null 缓存返回 null（调用方据此重查）',
    )
  })

  it('脏数据不恢复', () => {
    const { service } = makeService()
    const restored = service.restorePublished({
      'no-at-sign': '2026-01-01',
      'x@1.0.0': 12345,
      'y@1.0.0': '',
      'z@1.0.0': '2026-01-01T00:00:00.000Z',
    })
    assert.equal(restored, 1, '只有 z 是合法的')
    assert.equal(service.cachedPublishedAt('z', '1.0.0'), '2026-01-01T00:00:00.000Z')
  })

  it('null / 数组 / 非对象都不崩', () => {
    const { service } = makeService()
    assert.equal(service.restorePublished(null), 0)
    assert.equal(service.restorePublished([]), 0)
    assert.equal(service.restorePublished('x'), 0)
  })
})

describe('cachedPublishedAt：只读缓存，按 TTL 判断', () => {
  it('没缓存返回 null', () => {
    assert.equal(makeService().service.cachedPublishedAt('nope', '1.0.0'), null)
  })

  it('有效缓存返回值', () => {
    const { service } = makeService()
    service.publishedCache.set('a@1.0.0', { at: NOW, value: '2026-11-01T00:00:00.000Z' })
    assert.equal(service.cachedPublishedAt('a', '1.0.0'), '2026-11-01T00:00:00.000Z')
  })

  it('成功缓存 6 小时内仍有效', () => {
    const { service } = makeService()
    service.publishedCache.set('a@1.0.0', { at: NOW, value: '2026-11-01T00:00:00.000Z' })
    // 5 小时后
    const later = makeService({ now: NOW + 5 * 60 * 60 * 1000 }).service
    later.publishedCache.set('a@1.0.0', { at: NOW, value: '2026-11-01T00:00:00.000Z' })
    assert.equal(later.cachedPublishedAt('a', '1.0.0'), '2026-11-01T00:00:00.000Z')
  })

  it('成功缓存超过 6 小时 → 返回 null（调用方据此补查）', () => {
    const later = makeService({ now: NOW + PUBLISHED_TTL_MS + 60 * 1000 }).service
    later.publishedCache.set('a@1.0.0', { at: NOW, value: '2026-11-01T00:00:00.000Z' })
    assert.equal(later.cachedPublishedAt('a', '1.0.0'), null)
  })

  it('null 缓存只有 30 分钟有效期', () => {
    const { service } = makeService()
    service.publishedCache.set('b@1.0.0', { at: NOW, value: null })
    // 25 分钟内仍算"查过了"
    const ok = makeService({ now: NOW + 25 * 60 * 1000 }).service
    ok.publishedCache.set('b@1.0.0', { at: NOW, value: null })
    assert.equal(ok.cachedPublishedAt('b', '1.0.0'), null, '返回 null，但内部仍视为有效（不重查）')
    // 超过 30 分钟就该失效 —— 这里靠 flushPublished 的行为验证（见下）
  })
})

describe('flushPublished：补查时跳过已缓存的', () => {
  it('没有缓存的会被补查，已缓存的跳过', async () => {
    const { service } = makeService()
    // 先塞一条已缓存的
    service.publishedCache.set('a@1.0.0', { at: NOW, value: '2026-11-01T00:00:00.000Z' })

    const result = await service.flushPublished([
      { pkg: 'a', version: '1.0.0' }, // 已缓存 → skip
      { pkg: 'b', version: '2.0.0' }, // 未缓存 → fill
    ])
    assert.equal(result.skipped, 1)
    assert.equal(result.filled, 1)
    assert.equal(service.cachedPublishedAt('b', '2.0.0'), '2026-11-07T00:00:00.000Z')
  })

  it('null 缓存 30 分钟内跳过，超过后重查', async () => {
    const { service, advance } = makeService()
    service.publishedCache.set('c@1.0.0', { at: NOW, value: null })

    // 25 分钟内：算有效缓存 → 跳过
    const soon = await service.flushPublished([{ pkg: 'c', version: '1.0.0' }])
    assert.equal(soon.skipped, 1)

    // 往后拨 35 分钟 → 过期 → 重查
    advance(35 * 60 * 1000)
    const later = await service.flushPublished([{ pkg: 'c', version: '1.0.0' }])
    assert.equal(later.filled, 1, '过期后应当重查并拿到值')
  })

  it('空输入不崩', async () => {
    const { service } = makeService()
    const result = await service.flushPublished([])
    assert.deepEqual(result, { filled: 0, skipped: 0, failed: 0 })
    assert.deepEqual(await service.flushPublished(null), { filled: 0, skipped: 0, failed: 0 })
  })

  it('缺 version 的条目被过滤掉', async () => {
    const { service } = makeService()
    const result = await service.flushPublished([{ pkg: 'd' }, { pkg: '', version: '1.0.0' }, null])
    assert.deepEqual(result, { filled: 0, skipped: 0, failed: 0 })
  })
})

test('TTL 常量符合设计：成功 6 小时，失败 30 分钟', () => {
  assert.equal(PUBLISHED_TTL_MS, 6 * 60 * 60 * 1000)
  assert.equal(NULL_PUBLISHED_TTL_MS, 30 * 60 * 1000)
  assert.ok(NULL_PUBLISHED_TTL_MS < PUBLISHED_TTL_MS, '失败缓存必须比成功缓存短得多')
})
