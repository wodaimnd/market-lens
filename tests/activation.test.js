/**
 * activation 回归：installed ≠ activated。
 *
 * 三层静态检查（依赖 / 挂载 / 装载行）全对，插件仍然可能根本没跑起来：
 * Cordis 给每个入口建一个 Fiber，只有 active 才算真的挂上了。
 * failed / pending 时 dsh 自己的日志里也不一定有一行能看懂的报错。
 *
 * 判定口径照抄宿主 dsh-host-plugin-inventory：
 *   FIBER_STATE: PENDING 0 / LOADING 1 / ACTIVE 2 / FAILED 3 / DISPOSED 4 / UNLOADING 5
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIBER_PHASE,
  FIBER_STATE,
  activationOf,
  collectActivation,
  mergeActivation,
  phaseOfState,
} from '../lib/activation.js'

describe('phaseOfState：数字与字符串两种形态都认', () => {
  it('数字枚举逐一对齐宿主', () => {
    assert.equal(phaseOfState(FIBER_STATE.PENDING), 'pending')
    assert.equal(phaseOfState(FIBER_STATE.LOADING), 'loading')
    assert.equal(phaseOfState(FIBER_STATE.ACTIVE), 'active')
    assert.equal(phaseOfState(FIBER_STATE.FAILED), 'failed')
    assert.equal(phaseOfState(FIBER_STATE.DISPOSED), null, 'DISPOSED 在宿主里是 null')
    assert.equal(phaseOfState(FIBER_STATE.UNLOADING), 'unloading')
  })

  it('字符串形态也认（不同运行时给的不一样）', () => {
    assert.equal(phaseOfState('active'), 'active')
    assert.equal(phaseOfState('FAILED'), 'failed')
    assert.equal(phaseOfState('disposed'), null)
  })

  it('未知值给 unknown，绝不瞎猜成 active', () => {
    assert.equal(phaseOfState(99), 'unknown')
    assert.equal(phaseOfState('weird'), 'unknown')
    assert.equal(phaseOfState(undefined), 'unknown')
  })
})

describe('collectActivation：从 loader entries 收状态', () => {
  const entry = (name, state, extra = {}) => ({
    id: 'entry-' + name,
    options: { name },
    fiber: { state },
    ...extra,
  })

  it('收集 active / failed 等状态', () => {
    const map = collectActivation([
      entry('a-pkg', FIBER_STATE.ACTIVE),
      entry('b-pkg', FIBER_STATE.FAILED),
    ])
    assert.equal(map.get('a-pkg').phase, 'active')
    assert.equal(map.get('b-pkg').phase, 'failed')
  })

  it('group 行不是插件入口，要跳过（宿主自己也跳）', () => {
    const map = collectActivation([{ id: 'g', options: { name: 'grp', group: true }, fiber: { state: 2 } }])
    assert.equal(map.size, 0)
  })

  it('没有 name 的行跳过，不编造键', () => {
    const map = collectActivation([{ id: 'x', options: {}, fiber: { state: 2 } }])
    assert.equal(map.size, 0)
  })

  it('没有 fiber 的入口 phase 为 null（还没建 fiber）', () => {
    const map = collectActivation([{ id: 'y', options: { name: 'y-pkg' } }])
    assert.equal(map.get('y-pkg').phase, null)
  })

  it('同名入口取「最值得关注」的那一条', () => {
    // failed > loading > pending > active；用户看到的最严重的状态才有意义
    const map = collectActivation([
      entry('dup', FIBER_STATE.ACTIVE),
      entry('dup', FIBER_STATE.FAILED),
    ])
    assert.equal(map.get('dup').phase, 'failed')
  })

  it('disabled 标记要带出来', () => {
    const map = collectActivation([entry('d', FIBER_STATE.ACTIVE, { disabled: true })])
    assert.equal(map.get('d').disabled, true)
  })

  it('空输入与坏输入都不崩', () => {
    assert.equal(collectActivation(null).size, 0)
    assert.equal(collectActivation([]).size, 0)
    assert.equal(collectActivation([null, undefined, 42]).size, 0)
  })
})

describe('activationOf：按包名找入口', () => {
  const map = new Map([['market-lens', { phase: 'active', entryId: 'e1', disabled: false }]])

  it('包名直接命中', () => {
    const result = activationOf('market-lens', map)
    assert.equal(result.available, true)
    assert.equal(result.phase, 'active')
    assert.equal(result.entryId, 'e1')
  })

  it('包名不命中时退回 fallback 入口名', () => {
    const result = activationOf('@scope/pkg', map, 'market-lens')
    assert.equal(result.available, true)
    assert.equal(result.moduleName, 'market-lens')
  })

  it('都没有 → available:false（不可知，不是"没激活"）', () => {
    const result = activationOf('nope', map)
    assert.equal(result.available, false)
    assert.equal(result.phase, null)
  })

  it('loader 还没起来（空表）→ 不可知', () => {
    assert.equal(activationOf('anything', new Map()).available, false)
    assert.equal(activationOf('anything', null).available, false)
  })
})

describe('mergeActivation：静态结论 × 运行时状态', () => {
  const activeMap = new Map([['pkg', { phase: 'active', entryId: 'e', disabled: false }]])
  const failedMap = new Map([['pkg', { phase: 'failed', entryId: 'e', disabled: false }]])
  const pendingMap = new Map([['pkg', { phase: 'pending', entryId: 'e', disabled: false }]])
  const disabledMap = new Map([['pkg', { phase: 'active', entryId: 'e', disabled: true }]])

  it('静态 ok + fiber active → activated（真的挂上了）', () => {
    const result = mergeActivation({
      staticVerdict: 'ok',
      activation: activationOf('pkg', activeMap),
      mounted: true,
    })
    assert.equal(result.verdict, 'activated')
    assert.equal(result.detail, null)
  })

  it('静态 ok + fiber failed → installed-not-active（装上但不出现）', () => {
    const result = mergeActivation({
      staticVerdict: 'ok',
      activation: activationOf('pkg', failedMap),
      mounted: true,
    })
    assert.equal(result.verdict, 'installed-not-active')
    assert.match(result.detail, /failed/)
  })

  it('静态 ok + fiber pending → installed-not-active，并说出具体 phase', () => {
    const result = mergeActivation({
      staticVerdict: 'ok',
      activation: activationOf('pkg', pendingMap),
      mounted: true,
    })
    assert.equal(result.verdict, 'installed-not-active')
    assert.match(result.detail, /pending/)
  })

  it('静态 ok + entry.disabled → installed-disabled', () => {
    const result = mergeActivation({
      staticVerdict: 'ok',
      activation: activationOf('pkg', disabledMap),
      mounted: true,
    })
    assert.equal(result.verdict, 'installed-disabled')
    assert.match(result.detail, /禁用/)
  })

  it('静态 bad 优先：不再叠加运行时结论', () => {
    const result = mergeActivation({
      staticVerdict: 'bad',
      activation: activationOf('pkg', failedMap),
      mounted: true,
    })
    assert.equal(result.verdict, 'bad', '静态层已判死，加运行时只会更乱')
    assert.equal(result.detail, null)
  })

  it('没挂载时保持原判定（warn），不会变成 activated', () => {
    const result = mergeActivation({
      staticVerdict: 'warn',
      activation: activationOf('pkg', activeMap),
      mounted: false,
    })
    assert.equal(result.verdict, 'warn')
  })

  it('运行时不可知 → 退回静态结论，不编造', () => {
    const result = mergeActivation({
      staticVerdict: 'ok',
      activation: activationOf('pkg', new Map()),
      mounted: true,
    })
    assert.equal(result.verdict, 'ok', 'loader 没起来时说 ok 比说"没激活"更诚实')
  })

  it('DISPOSED（phase null）不下结论', () => {
    const disposed = new Map([['pkg', { phase: null, entryId: 'e', disabled: false }]])
    const result = mergeActivation({
      staticVerdict: 'ok',
      activation: activationOf('pkg', disposed),
      mounted: true,
    })
    assert.equal(result.verdict, 'ok')
  })
})

test('FIBER_PHASE 与宿主的枚举逐项一致', () => {
  assert.equal(FIBER_PHASE[0], 'pending')
  assert.equal(FIBER_PHASE[1], 'loading')
  assert.equal(FIBER_PHASE[2], 'active')
  assert.equal(FIBER_PHASE[3], 'failed')
  assert.equal(FIBER_PHASE[4], null)
  assert.equal(FIBER_PHASE[5], 'unloading')
})
