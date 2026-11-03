/**
 * 安全优先视图的判定口径。
 *
 * 「默认隐藏高风险/未审计」这条要求的关键在于：**未审计等于不安全**。
 * 目录里大部分条目既没有 dsh.so 的 riskLevel，也没跑过 installCheck，
 * 如果把它们当成安全，这个视图就只剩下"看起来更干净"的错觉。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { safeViewVisible, trustOf } from '../lib/security.js'

const row = (overrides = {}) => ({ key: 'k', security: null, verification: null, riskFlags: [], ...overrides })

describe('trustOf：正面结论', () => {
  it('dsh.so 低风险直接放行', () => {
    const trust = trustOf(row({ security: { riskLevel: 'low', label: '低风险' } }))
    assert.equal(trust.tier, 'low')
    assert.equal(trust.safe, true)
    assert.equal(trust.reason, '低风险')
  })

  it('dshmarketplace 安装验证通过也放行', () => {
    const trust = trustOf(row({ verification: { installCheck: 'passed' } }))
    assert.equal(trust.tier, 'verified')
    assert.equal(trust.safe, true)
  })
})

describe('trustOf：否决项压过正面结论', () => {
  it('高风险即使"验证通过"也不放行', () => {
    const trust = trustOf(row({ security: { riskLevel: 'high' }, verification: { installCheck: 'passed' } }))
    assert.equal(trust.tier, 'high')
    assert.equal(trust.safe, false)
  })

  it('安装验证失败即使标了低风险也不放行', () => {
    const trust = trustOf(row({ security: { riskLevel: 'low' }, verification: { installCheck: 'failed' } }))
    assert.equal(trust.tier, 'flagged')
    assert.equal(trust.safe, false)
    assert.equal(trust.reason, 'install-check-failed')
  })

  it('riskFlags 非空按 flagged 处理', () => {
    const trust = trustOf(row({ riskFlags: ['postinstall-script'] }))
    assert.equal(trust.tier, 'flagged')
    assert.equal(trust.safe, false)
    assert.match(trust.reason, /postinstall/)
  })
})

describe('trustOf：中风险与未审计', () => {
  it('中风险默认隐藏', () => {
    assert.equal(trustOf(row({ security: { riskLevel: 'medium' } })).safe, false)
  })

  it('什么都没有 = 未审计 = 隐藏', () => {
    const trust = trustOf(row())
    assert.equal(trust.tier, 'unknown')
    assert.equal(trust.reason, 'unaudited')
    assert.equal(trust.safe, false)
    assert.equal(safeViewVisible(row()), false)
  })

  it('形如对象但字段不是字符串时不崩，按未审计处理', () => {
    const trust = trustOf({ security: { riskLevel: 42 }, verification: { installCheck: null }, riskFlags: 'nope' })
    assert.equal(trust.tier, 'unknown')
    assert.equal(trust.safe, false)
  })

  it('null 行不会抛错', () => {
    assert.equal(trustOf(null).safe, false)
  })
})
