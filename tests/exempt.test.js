/**
 * exempt 回归：「明知不兼容，仍然安装」这条路。
 *
 * 现场故障（2026-11-07，dsh-tidy-display@0.4.7 / dsh 0.2.2-rc.1）：
 *
 *   dsh: installation rejected: Plugin dsh-tidy-display@0.4.7 is incompatible
 *        with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.1.0-rc.2 || ... || 0.2.1-rc.5"}
 *   dsh: To accept this risk explicitly, grant the exact-version exemption
 *        for dsh-tidy-display@0.4.7 on dsh 0.2.2-rc.1 with `dsh plugin allow-version`
 *
 * 宿主提供了出路，但 market-lens 没把它接到界面上 —— 「仍然安装」按钮点了
 * 还是同一个错误。这个模块就是把它接上：写 profile 的 compatibility.json。
 *
 * 三条硬约束（照抄宿主 setProfileVersionExemption 的校验）：
 *   1. key 必须是**精确**的 package@version（范围 / 标签都不行）
 *   2. 值必须是**当前** DSH 版本
 *   3. compatibility.json 坏掉时**不许改写**（会冲掉用户原有内容）
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  COMPATIBILITY_FILE,
  EXEMPT_RESULT,
  exemptionKey,
  grantExemption,
  hasExemption,
  readCompatibility,
  revokeExemption,
} from '../lib/exempt.js'

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-exempt-'))
}

describe('exemptionKey：只接受精确版本', () => {
  it('普通包与 scoped 包都能拼', () => {
    assert.equal(exemptionKey('dsh-tidy-display', '0.4.7'), 'dsh-tidy-display@0.4.7')
    assert.equal(exemptionKey('@scope/pkg', '1.2.3'), '@scope/pkg@1.2.3')
  })

  it('预发布版本也算精确（0.2.2-rc.1 这种是常态）', () => {
    assert.equal(exemptionKey('foo', '1.2.3-rc.1'), 'foo@1.2.3-rc.1')
  })

  it('范围 / 标签 / 前缀一律拒绝', () => {
    for (const version of ['^1.2.3', '~1.2.3', '>=1.0.0', 'latest', '1.x', 'workspace:*', '']) {
      assert.equal(exemptionKey('foo', version), null, version + ' 不该被接受')
    }
  })

  it('非法包名与空值拒绝', () => {
    assert.equal(exemptionKey('not a name', '1.0.0'), null)
    assert.equal(exemptionKey('', '1.0.0'), null)
    assert.equal(exemptionKey(null, null), null)
  })
})

describe('readCompatibility：坏文件 = 不可改写', () => {
  it('文件不存在 → 空表且可写', () => {
    const profileDir = tmpProfile()
    const result = readCompatibility(profileDir)
    assert.deepEqual(result.exemptions, {})
    assert.equal(result.rewritable, true)
  })

  it('合法文件按 key 读回', () => {
    const profileDir = tmpProfile()
    fs.writeFileSync(path.join(profileDir, COMPATIBILITY_FILE), JSON.stringify({ 'foo@1.0.0': ['0.2.2-rc.1'] }))
    const result = readCompatibility(profileDir)
    assert.deepEqual(result.exemptions['foo@1.0.0'], ['0.2.2-rc.1'])
    assert.equal(result.rewritable, true)
  })

  it('不是 JSON → 不可改写（改写会冲掉用户内容）', () => {
    const profileDir = tmpProfile()
    fs.writeFileSync(path.join(profileDir, COMPATIBILITY_FILE), '{ broken')
    const result = readCompatibility(profileDir)
    assert.equal(result.rewritable, false, '坏文件绝不能被我们覆盖')
    assert.ok(result.warnings.length > 0)
  })

  it('结构不对（数组 / 字符串）→ 不可改写', () => {
    const profileDir = tmpProfile()
    fs.writeFileSync(path.join(profileDir, COMPATIBILITY_FILE), '[]')
    assert.equal(readCompatibility(profileDir).rewritable, false)
    fs.writeFileSync(path.join(profileDir, COMPATIBILITY_FILE), '"hello"')
    assert.equal(readCompatibility(profileDir).rewritable, false)
  })

  it('非精确 key 被忽略并留警告', () => {
    const profileDir = tmpProfile()
    fs.writeFileSync(path.join(profileDir, COMPATIBILITY_FILE), JSON.stringify({
      'foo@^1.0.0': ['0.2.2-rc.1'],
      'foo@1.0.0': ['0.2.2-rc.1'],
    }))
    const result = readCompatibility(profileDir)
    assert.equal(result.exemptions['foo@^1.0.0'], undefined, '范围 key 要忽略')
    assert.deepEqual(result.exemptions['foo@1.0.0'], ['0.2.2-rc.1'])
    assert.ok(result.warnings.some((w) => w.includes('foo@^1.0.0')))
  })
})

describe('grantExemption：真实故障场景', () => {
  it('dsh-tidy-display@0.4.7 on 0.2.2-rc.1 能授予并落盘', () => {
    const profileDir = tmpProfile()
    const outcome = grantExemption({
      profileDir,
      pkg: 'dsh-tidy-display',
      version: '0.4.7',
      runtimeVersion: '0.2.2-rc.1',
      acceptRisk: true,
    })
    assert.equal(outcome.result, EXEMPT_RESULT.ok, JSON.stringify(outcome))
    // 文件真的写了，且形状正确
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
    assert.deepEqual(written['dsh-tidy-display@0.4.7'], ['0.2.2-rc.1'])
  })

  it('不给 acceptRisk 就拒绝 —— 不能替用户按下"我接受数据丢失风险"', () => {
    const profileDir = tmpProfile()
    const outcome = grantExemption({ profileDir, pkg: 'foo', version: '1.0.0', runtimeVersion: '0.2.2-rc.1' })
    assert.notEqual(outcome.result, EXEMPT_RESULT.ok)
    assert.match(outcome.detail, /确认风险|acceptRisk/)
    assert.equal(fs.existsSync(path.join(profileDir, COMPATIBILITY_FILE)), false, '被拒绝时不该创建文件')
  })

  it('范围版本被拒绝', () => {
    const outcome = grantExemption({
      profileDir: tmpProfile(), pkg: 'foo', version: '^1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true,
    })
    assert.equal(outcome.result, EXEMPT_RESULT.invalidKey)
  })

  it('拿不到运行时版本时拒绝（不能批准一个不知道是什么的版本）', () => {
    const outcome = grantExemption({
      profileDir: tmpProfile(), pkg: 'foo', version: '1.0.0', runtimeVersion: null, acceptRisk: true,
    })
    assert.equal(outcome.result, EXEMPT_RESULT.staleRuntime)
  })

  it('坏 compatibility.json 时拒绝改写，并说明要人工修', () => {
    const profileDir = tmpProfile()
    fs.writeFileSync(path.join(profileDir, COMPATIBILITY_FILE), '{ broken')
    const outcome = grantExemption({
      profileDir, pkg: 'foo', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true,
    })
    assert.equal(outcome.result, EXEMPT_RESULT.unreadable)
    assert.match(outcome.detail, /手工修复/)
    // 文件必须原样保留
    assert.equal(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'), '{ broken')
  })

  it('重复授予是幂等：返回 alreadyGranted，不清空已有条目', () => {
    const profileDir = tmpProfile()
    grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    const again = grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    assert.equal(again.result, EXEMPT_RESULT.alreadyGranted)
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
    assert.deepEqual(written['a@1.0.0'], ['0.2.2-rc.1'])
  })

  it('追加不会冲掉别的包的豁免', () => {
    const profileDir = tmpProfile()
    grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    grantExemption({ profileDir, pkg: 'b', version: '2.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
    assert.deepEqual(written['a@1.0.0'], ['0.2.2-rc.1'], '先授的那条要留着')
    assert.deepEqual(written['b@2.0.0'], ['0.2.2-rc.1'])
  })

  it('同包不同版本分开记', () => {
    const profileDir = tmpProfile()
    grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    grantExemption({ profileDir, pkg: 'a', version: '1.0.1', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
    assert.deepEqual(Object.keys(written).sort(), ['a@1.0.0', 'a@1.0.1'])
  })

  it('dryRun 不写盘', () => {
    const profileDir = tmpProfile()
    const outcome = grantExemption({
      profileDir, pkg: 'foo', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true, dryRun: true,
    })
    assert.equal(outcome.result, EXEMPT_RESULT.ok)
    assert.equal(fs.existsSync(path.join(profileDir, COMPATIBILITY_FILE)), false)
  })
})

describe('revokeExemption', () => {
  it('撤销后条目消失', () => {
    const profileDir = tmpProfile()
    grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    revokeExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1' })
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
    assert.equal(written['a@1.0.0'], undefined)
  })

  it('撤销不存在的条目不报错', () => {
    const outcome = revokeExemption({ profileDir: tmpProfile(), pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1' })
    assert.equal(outcome.result, EXEMPT_RESULT.ok)
  })

  it('撤销不影响别的包', () => {
    const profileDir = tmpProfile()
    grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    grantExemption({ profileDir, pkg: 'b', version: '2.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    revokeExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1' })
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
    assert.equal(written['a@1.0.0'], undefined)
    assert.deepEqual(written['b@2.0.0'], ['0.2.2-rc.1'])
  })
})

describe('hasExemption', () => {
  it('授予后为 true，别的运行时为 false', () => {
    const profileDir = tmpProfile()
    grantExemption({ profileDir, pkg: 'a', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', acceptRisk: true })
    assert.equal(hasExemption(profileDir, 'a', '1.0.0', '0.2.2-rc.1'), true)
    assert.equal(hasExemption(profileDir, 'a', '1.0.0', '0.2.1-rc.5'), false, '豁免是逐版本的')
  })

  it('没授予时 false，非法 key 也 false', () => {
    assert.equal(hasExemption(tmpProfile(), 'a', '1.0.0', '0.2.2-rc.1'), false)
    assert.equal(hasExemption(tmpProfile(), 'a', '^1.0.0', '0.2.2-rc.1'), false)
  })
})

test('真实故障的形状：engines.dsh 列出旧版本，但豁免能放行', () => {
  // dsh-tidy-display@0.4.7 的 engines.dsh 只列到 0.2.1-rc.5，当前跑 0.2.2-rc.1
  const profileDir = tmpProfile()
  const outcome = grantExemption({
    profileDir,
    pkg: 'dsh-tidy-display',
    version: '0.4.7',
    runtimeVersion: '0.2.2-rc.1',
    acceptRisk: true,
  })
  assert.equal(outcome.result, EXEMPT_RESULT.ok)
  assert.equal(hasExemption(profileDir, 'dsh-tidy-display', '0.4.7', '0.2.2-rc.1'), true)
  // 落盘内容必须是宿主 readProfileCompatibility 认的形状
  const written = JSON.parse(fs.readFileSync(path.join(profileDir, COMPATIBILITY_FILE), 'utf8'))
  assert.deepEqual(Object.keys(written), ['dsh-tidy-display@0.4.7'])
  assert.deepEqual(written['dsh-tidy-display@0.4.7'], ['0.2.2-rc.1'])
})
