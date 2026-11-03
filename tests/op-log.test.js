/**
 * 操作日志环形缓冲测试。
 *
 * 关注三件事：环形容量与 seq 单调性（客户端按 seq 拉增量靠它）、
 * sanitize 不把错误对象 / 大数组整个塞进缓冲、以及订阅者抛异常不能
 * 让写入方崩掉（日志本身绝不能成为故障源）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OpLog } from '../lib/op-log.js'

describe('OpLog：环形缓冲语义', () => {
  it('seq 单调递增且越过 limit 后丢最旧的', () => {
    const log = new OpLog({ limit: 20 })
    for (let index = 1; index <= 22; index++) log.info('e' + index)
    const items = log.list()
    assert.equal(items.length, 20)
    assert.deepEqual(items.map((item) => item.tag).slice(0, 2), ['e3', 'e4'])
    assert.deepEqual(items.map((item) => item.seq).slice(-1), [22])
    assert.equal(log.status().dropped, 2)
    assert.equal(log.status().seq, 22)
  })

  it('limit 下限被钳到 20，避免误配置把日志关成空', () => {
    const log = new OpLog({ limit: 1 })
    assert.equal(log.limit, 20)
  })

  it('limit 上限被钳到 5000，避免无界增长', () => {
    const log = new OpLog({ limit: 999999 })
    assert.equal(log.limit, 5000)
  })

  it('since 只返回增量，客户端轮询不会重发整表', () => {
    const log = new OpLog()
    log.info('a')
    log.info('b')
    log.info('c')
    assert.deepEqual(log.list({ since: 1 }).map((item) => item.seq), [2, 3])
    assert.deepEqual(log.list({ since: 3 }), [])
  })

  it('按 level / tag / 全文过滤', () => {
    const log = new OpLog()
    log.info('install.start', { spec: 'alpha-pkg' })
    log.error('install.failed', { spec: 'beta-pkg', detail: 'ERR_PNPM_FETCH_404' })
    log.warn('install.fallback', { spec: 'beta-pkg' })

    assert.deepEqual(log.list({ level: 'error' }).map((item) => item.tag), ['install.failed'])
    assert.deepEqual(log.list({ tag: 'fallback' }).map((item) => item.tag), ['install.fallback'])
    assert.deepEqual(log.list({ query: 'err_pnpm' }).map((item) => item.tag), ['install.failed'])
    assert.equal(log.list({ query: '不存在的东西' }).length, 0)
  })

  it('limit 参数取尾部 N 条', () => {
    const log = new OpLog()
    for (let index = 1; index <= 10; index++) log.info('e' + index)
    assert.deepEqual(log.list({ limit: 3 }).map((item) => item.tag), ['e8', 'e9', 'e10'])
  })
})

describe('OpLog：字段收敛', () => {
  it('保留标量与浅层对象，丢掉 undefined 与深层结构', () => {
    const log = new OpLog()
    const entry = log.write('info', 'install.start', {
      spec: 'pkg@1.0.0',
      ms: 1200,
      ok: true,
      missing: undefined,
      nested: { level: 'error', code: 'X', deeper: { a: 1 } },
      list: ['a', 'b', 'c'],
    })
    assert.equal(entry.spec, 'pkg@1.0.0')
    assert.equal(entry.ms, 1200)
    assert.equal(entry.ok, true)
    assert.equal('missing' in entry, false)
    assert.deepEqual(entry.nested, { level: 'error', code: 'X' })
    assert.deepEqual(entry.list, ['a', 'b', 'c'])
  })

  it('Error 对象只取 message', () => {
    const log = new OpLog()
    const entry = log.info('x', { cause: new Error('boom') })
    assert.equal(entry.cause, 'boom')
  })

  it('数组被截断到 40 项，非标量项被丢弃', () => {
    const log = new OpLog()
    const big = Array.from({ length: 80 }, (_, index) => index)
    const entry = log.info('x', { list: [...big, { skip: true }] })
    assert.equal(entry.list.length, 40)
  })

  it('超长 detail 被截断并标注', () => {
    const log = new OpLog()
    const entry = log.error('x', { detail: 'z'.repeat(9000) })
    assert.ok(entry.detail.length < 8300)
    assert.match(entry.detail, /已截断/)
  })

  it('非法 level 回落为 info，tag 被截断', () => {
    const log = new OpLog()
    const entry = log.write('panic', 't'.repeat(200))
    assert.equal(entry.level, 'info')
    assert.equal(entry.tag.length, 61)
  })
})

describe('OpLog：订阅与导出', () => {
  it('订阅者拿到每条新日志，退订后不再收到', () => {
    const log = new OpLog()
    const seen = []
    const off = log.subscribe((entry) => seen.push(entry.tag))
    log.info('a')
    log.info('b')
    off()
    log.info('c')
    assert.deepEqual(seen, ['a', 'b'])
  })

  it('订阅者抛异常不影响写入', () => {
    const log = new OpLog()
    log.subscribe(() => {
      throw new Error('订阅者炸了')
    })
    const entry = log.info('依然写入')
    assert.equal(entry.tag, '依然写入')
    assert.equal(log.status().total, 1)
  })

  it('toText 每行一条，含时间、级别、tag 与字段', () => {
    const log = new OpLog()
    log.error('install.failed', { spec: 'pkg@1.0.0', detail: 'boom' })
    const text = log.toText()
    assert.match(text, /\[ERROR\] install\.failed/)
    assert.match(text, /spec=pkg@1\.0\.0/)
    assert.match(text, /detail=boom/)
  })

  it('status 给出计数与首尾时间', () => {
    const log = new OpLog()
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    const status = log.status()
    assert.deepEqual(status.counts, { debug: 1, info: 1, warn: 1, error: 1 })
    assert.equal(status.total, 4)
    assert.ok(status.firstAt && status.lastAt)
  })

  it('clear 清空条目并重置 dropped，seq 继续递增', () => {
    const log = new OpLog({ limit: 20 })
    for (let index = 1; index <= 22; index++) log.info('e' + index)
    assert.equal(log.clear(), 20)
    assert.equal(log.status().dropped, 0)
    assert.equal(log.status().total, 0)
    assert.equal(log.info('d').seq, 23)
  })
})
