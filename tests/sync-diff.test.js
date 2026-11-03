/**
 * 「本次同步差异」的不变式。
 *
 * 最容易出错的两处，也是这里断言的重点：
 *   1. 首次同步不能把整个目录标成"新增"；
 *   2. 某个来源本轮失败时，它提供的条目不能被打成"下架"——
 *      否则下一轮成功同步又会把它们标成"新增"，整张表在骗人。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { CHANGE_ADDED, CHANGE_REMOVED, CHANGE_UPDATED, changedRows, changesBetween, diffRows } from '../lib/sync-diff.js'

const row = (key, overrides = {}) => ({
  key,
  name: key,
  version: '1.0.0',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sources: ['1024store'],
  ...overrides,
})

const NOW = '2026-02-01T00:00:00.000Z'

describe('diffRows：首次同步打基线，不标任何变化', () => {
  it('上一份为空时 baselined=true，所有行都没有 change', () => {
    const result = diffRows([], [row('a'), row('b')], { now: NOW })
    assert.equal(result.summary.baselined, true)
    assert.equal(result.summary.added, 0)
    assert.equal(result.rows.every((item) => item.change === null), true)
  })

  it('空目录对空目录也不炸', () => {
    const result = diffRows(null, undefined, { now: NOW })
    assert.deepEqual(result.rows, [])
    assert.equal(result.summary.total, 0)
  })
})

describe('diffRows：新增 / 更新', () => {
  it('上一份没有的 key 标 added', () => {
    const result = diffRows([row('a')], [row('a'), row('b')], { now: NOW })
    assert.equal(result.summary.baselined, false)
    assert.deepEqual(result.rows.map((item) => [item.key, item.change]), [['a', null], ['b', CHANGE_ADDED]])
    assert.equal(result.summary.added, 1)
  })

  it('版本变了标 updated，并给出 from/to', () => {
    const result = diffRows([row('a')], [row('a', { version: '1.1.0' })], { now: NOW })
    const item = result.rows[0]
    assert.equal(item.change, CHANGE_UPDATED)
    assert.deepEqual(item.changeDetail.version, { from: '1.0.0', to: '1.1.0' })
    assert.equal(result.summary.updated, 1)
  })

  it('版本没变、更新日期没变时不打标', () => {
    const result = diffRows([row('a')], [row('a')], { now: NOW })
    assert.equal(result.rows[0].change, null)
    assert.equal(result.summary.updated, 0)
  })

  it('来源新增算一次更新', () => {
    const detail = changesBetween(row('a', { sources: ['1024store'] }), row('a', { sources: ['1024store', 'dshfind'] }))
    assert.deepEqual(detail.sources.to, ['dshfind'])
    assert.equal(detail.version, undefined)
  })
})

describe('diffRows：下架判定', () => {
  it('本轮成功来源覆盖的行才会被判下架', () => {
    const previous = [row('a'), row('b')]
    const result = diffRows(previous, [row('a')], { now: NOW, syncedSources: ['1024store'] })
    assert.equal(result.rows.length, 2)
    const removed = result.rows.find((item) => item.key === 'b')
    assert.equal(removed.change, CHANGE_REMOVED)
    assert.equal(removed.delisted, true)
    assert.equal(removed.delistedAt, NOW)
    assert.equal(result.summary.removed, 1)
  })

  it('行来源于本轮没成功的源时，判"未返回"而不是"下架"', () => {
    const previous = [row('a', { sources: ['dshfind'] }), row('b')]
    const result = diffRows(previous, [row('b')], { now: NOW, syncedSources: ['1024store'] })
    assert.deepEqual(result.rows.map((item) => item.key), ['b'])
    assert.equal(result.summary.removed, 0)
  })

  it('来源为空的旧行没有证据，不判下架', () => {
    const previous = [row('a', { sources: [] })]
    const result = diffRows(previous, [], { now: NOW, syncedSources: ['1024store'] })
    assert.deepEqual(result.rows, [])
    assert.equal(result.summary.removed, 0)
  })

  it('下架标记只活一代：上一代已 delisted 的行不再参与比较', () => {
    const previous = [row('a'), row('gone', { delisted: true, change: CHANGE_REMOVED })]
    const result = diffRows(previous, [row('a')], { now: NOW, syncedSources: ['1024store'] })
    assert.deepEqual(result.rows.map((item) => item.key), ['a'])
    assert.equal(result.summary.removed, 0)
  })
})

describe('changedRows：筛选用的便捷函数', () => {
  it('只挑出带 change 的行，顺序不变', () => {
    const result = diffRows([row('a')], [row('a', { version: '1.1.0' }), row('b')], { now: NOW })
    assert.deepEqual(changedRows(result.rows).map((item) => item.key), ['a', 'b'])
  })
})
