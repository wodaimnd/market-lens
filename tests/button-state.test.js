/**
 * button-state 回归：行内按钮的六种状态只有这一处实现。
 *
 * 背景：状态以前散在 client 的 actionStateOf（只看 installed + update）、
 * 按钮的 done/update 两个布尔分支、以及一个定义了却 0 次引用的
 * installedUpToDate i18n key。三者口径不同，于是同一行可能同时表现为
 * 「✓ 已装」和「已是最新」，或者「更新」按钮点了只重装同一个版本。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUTTON_STATES,
  LABEL_KEYS,
  TITLE_KEYS,
  actionOf,
  buttonInfoFor,
  buttonStateOf,
} from '../lib/button-state.js'

describe('未安装的行', () => {
  it('有 npm 包名 → install', () => {
    const info = buttonInfoFor({ installed: false, pkg: 'foo' })
    assert.equal(info.state, 'install')
    assert.equal(info.mode, 'install')
    assert.equal(info.op, 'install')
    assert.equal(info.labelKey, 'actInstall')
  })

  it('只有 GitHub 仓库 → install（与 installSpecFor 同口径）', () => {
    const info = buttonInfoFor({ installed: false, repo: 'https://github.com/acme/tool' })
    assert.equal(info.state, 'install')
  })

  it('既无包名也无 GitHub 地址 → manual，不给假按钮', () => {
    const info = buttonInfoFor({ installed: false, pkg: null, repo: null })
    assert.equal(info.state, 'manual')
    assert.equal(info.op, null)
    assert.equal(info.labelKey, 'actManual')
  })

  it('非 github.com 的仓库地址也算 manual（装了也会失败）', () => {
    assert.equal(buttonStateOf({ installed: false, repo: 'https://gitlab.com/a/b' }), 'manual')
  })

  it('空行返回 manual，不崩', () => {
    assert.equal(buttonStateOf(null), 'manual')
    assert.equal(buttonStateOf(undefined), 'manual')
  })
})

describe('已安装的行：区分「查过没有新版」与「根本没法比」', () => {
  it('已装 + 有新版 → update，并带精确目标版本', () => {
    const info = buttonInfoFor({
      installed: true,
      pkg: 'foo',
      installedSpec: '1.0.0',
      update: { available: true, to: '2.0.0' },
    })
    assert.equal(info.state, 'update')
    assert.equal(info.mode, 'upgrade')
    assert.equal(info.op, 'upgrade')
    assert.equal(info.version, '2.0.0', '按钮要装的版本必须与状态机算出的同一份')
    assert.equal(info.labelKey, 'actUpdate')
  })

  it('已装 + registry 包 + 无新版 → current（「已是最新」）', () => {
    const info = buttonInfoFor({ installed: true, pkg: 'foo', installedSpec: '1.0.0', update: null })
    assert.equal(info.state, 'current')
    // 点「已是最新」等于重装同一目标 —— 这就是原先被折叠丢失的 reinstall 语义
    assert.equal(info.mode, 'reinstall')
    assert.equal(info.op, 'install')
    assert.equal(info.labelKey, 'installedUpToDate', 'installedUpToDate 这个 key 终于被用上了')
  })

  it('已装 + link 安装 → installed-local，不能说「已是最新」', () => {
    const info = buttonInfoFor({ installed: true, pkg: '@local/market-lens', installedSpec: 'link:G:/x' })
    assert.equal(info.state, 'installed-local')
    assert.equal(info.mode, 'reinstall')
    assert.equal(info.labelKey, 'actInstalled')
    assert.notEqual(info.state, 'current', '从没查过版本的包不能标成最新')
  })

  it('已装 + GitHub 安装 → installed-local', () => {
    assert.equal(buttonStateOf({ installed: true, pkg: 'dsh-x', installedSpec: 'github:o/r' }), 'installed-local')
  })

  it('已装 + 无 spec 但包名不合法（@local/）→ installed-local', () => {
    assert.equal(buttonStateOf({ installed: true, pkg: '@local/thing' }), 'installed-local')
  })

  it('update.available=false 不算有新版', () => {
    const info = buttonInfoFor({ installed: true, pkg: 'foo', installedSpec: '1.0.0', update: { available: false, to: '1.0.0' } })
    assert.equal(info.state, 'current')
  })

  it('update 缺 to 字段时不算有新版（装不到目标版本就不该显示升级）', () => {
    const info = buttonInfoFor({ installed: true, pkg: 'foo', installedSpec: '1.0.0', update: { available: true } })
    assert.equal(info.state, 'current')
  })
})

describe('失败优先', () => {
  it('上次失败 → retry，即使同时可更新', () => {
    // 用户刚点过、刚失败，那颗按钮的心理预期就是"再点一次"，
    // 而不是"顺便告诉你有新版"。
    const info = buttonInfoFor(
      { installed: true, pkg: 'foo', installedSpec: '1.0.0', update: { available: true, to: '2.0.0' } },
      { failed: true },
    )
    assert.equal(info.state, 'retry')
    assert.equal(info.labelKey, 'actRetry')
  })

  it('未装且失败 → 也是 retry，不是 install', () => {
    assert.equal(buttonStateOf({ installed: false, pkg: 'foo' }, { failed: true }), 'retry')
  })

  it('失败状态不影响成功路径', () => {
    assert.equal(buttonStateOf({ installed: false, pkg: 'foo' }, { failed: false }), 'install')
  })
})

describe('actionOf：状态 → 点一下会发生什么', () => {
  it('current / installed-local 都是幂等重装，不是升级', () => {
    assert.deepEqual(actionOf('current', {}), { mode: 'reinstall', op: 'install' })
    assert.deepEqual(actionOf('installed-local', {}), { mode: 'reinstall', op: 'install' })
  })

  it('update 带到精确版本', () => {
    const action = actionOf('update', { update: { to: '3.1.4' } })
    assert.equal(action.mode, 'upgrade')
    assert.equal(action.version, '3.1.4')
  })

  it('manual 不产生任何 op', () => {
    assert.equal(actionOf('manual', {}).op, null)
  })
})

test('六种状态与文案 key 齐全，缺一个就是界面少一档', () => {
  assert.deepEqual([...BUTTON_STATES].sort(), ['current', 'install', 'installed-local', 'manual', 'retry', 'update'])
  for (const state of BUTTON_STATES) {
    assert.ok(LABEL_KEYS[state], state + ' 缺 labelKey')
    assert.ok(TITLE_KEYS[state], state + ' 缺 titleKey')
  }
  // current 必须指向 installedUpToDate：这个 key 以前是死的
  assert.equal(LABEL_KEYS.current, 'installedUpToDate')
})

test('自定义 isRegistry 可覆盖默判（便于宿主接 updates.js 的权威口径）', () => {
  const calls = []
  const state = buttonStateOf(
    { installed: true, pkg: 'foo', installedSpec: 'x' },
    { isRegistry: (pkg, spec) => { calls.push([pkg, spec]); return false } },
  )
  assert.equal(state, 'installed-local')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['foo', 'x'])
})
