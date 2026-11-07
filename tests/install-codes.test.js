/**
 * install-codes 回归：把「失败」翻译成「哪一层 + 能不能重试 + 该点哪里」。
 *
 * 这些码不是编的，全部来自宿主源码（dsh-plugin-manager/lib/index.js）：
 *   · ManagementFailure 的 11 个 code —— failure.js 里 `this.code = code`
 *   · refused() 的 4 个预检 code
 *   · pnpm / OS 的原始码
 * 每一条都断言 layer 与 action，因为界面就是按这两项渲染的。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FAILURE_LAYERS,
  INSTALL_CODE_MAP,
  classifyInstallFailure,
  firstLine,
  isAlreadyPresent,
} from '../lib/install-codes.js'

describe('already-installed：目标已达成，不是失败', () => {
  it('精确 code 直接判成 already-present', () => {
    const result = classifyInstallFailure({ code: 'already-installed', message: 'already-installed' })
    assert.equal(result.outcome, 'already-present')
    assert.equal(result.layer, FAILURE_LAYERS.state)
    assert.equal(result.retryable, false)
    assert.equal(result.action, 'none')
    assert.equal(isAlreadyPresent({ code: 'already-installed', message: 'x' }), true)
  })

  it('只有文本也能认出来（预检 refused 的措辞）', () => {
    const result = classifyInstallFailure(new Error('some-pkg is already installed'))
    assert.equal(result.outcome, 'already-present')
    assert.equal(result.code, 'already-installed')
  })

  it('already-installed 必须优先于其它嗅探：文本里同时出现 root 也不能误判', () => {
    const result = classifyInstallFailure(new Error('foo-root is already installed'))
    assert.equal(result.code, 'already-installed', '不能因为出现 root 就判成 workspace 问题')
    assert.equal(result.outcome, 'already-present')
  })

  it('其它错误不会被误判成 already-present', () => {
    for (const detail of ['EPERM: operation not permitted', 'ERR_PNPM_NO_MATCHING_VERSION']) {
      assert.equal(isAlreadyPresent(null, detail), false, detail)
    }
  })
})

describe('宿主的 ManagementFailure 码逐个映射', () => {
  const cases = [
    ['ambiguous-install', FAILURE_LAYERS.resolve, 'choose', false],
    ['bundle-in-use', FAILURE_LAYERS.activation, 'disable', true],
    ['incompatible-version', FAILURE_LAYERS.compat, 'force', false],
    ['invalid-spec', FAILURE_LAYERS.resolve, 'edit', false],
    ['management-required', FAILURE_LAYERS.permission, 'none', false],
    ['not-bundle', FAILURE_LAYERS.declare, 'none', false],
    ['not-removable', FAILURE_LAYERS.permission, 'none', false],
    ['stale-approval', FAILURE_LAYERS.build, 'reapprove', true],
    ['stop-profile', FAILURE_LAYERS.activation, 'restart', true],
    ['unknown-plugin', FAILURE_LAYERS.inventory, 'refresh', true],
    ['not-a-bundle', FAILURE_LAYERS.declare, 'none', false],
    ['not-a-package', FAILURE_LAYERS.resolve, 'none', false],
  ]

  for (const [code, layer, action, retryable] of cases) {
    it(`${code} → ${layer} / ${action}`, () => {
      const result = classifyInstallFailure({ code, message: code })
      assert.equal(result.code, code)
      assert.equal(result.layer, layer)
      assert.equal(result.action, action)
      assert.equal(result.retryable, retryable)
      assert.equal(result.outcome, 'failed')
    })
  }
})

describe('pnpm / OS 原始码', () => {
  it('ADDING_TO_ROOT 判成 workspace 层，给「复制命令」而不是自动重试', () => {
    // profile 目录里确实有 pnpm-workspace.yaml，所以这个错误在真机上真会发生。
    // market-lens 不拼 pnpm 命令行，加不了 -w —— 所以只能让用户拿去终端执行。
    const result = classifyInstallFailure(new Error('ERR_PNPM_ADDING_TO_ROOT  This modules directory was created using...'))
    assert.equal(result.code, 'ERR_PNPM_ADDING_TO_ROOT')
    assert.equal(result.layer, FAILURE_LAYERS.workspace)
    assert.equal(result.action, 'copy-cmd')
  })

  it('peer 冲突不重试（重试一万次也一样）', () => {
    const result = classifyInstallFailure(new Error('ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependencies'))
    assert.equal(result.layer, FAILURE_LAYERS.resolve)
    assert.equal(result.retryable, false)
    assert.equal(result.action, 'force')
  })

  it('构建脚本被拦 → 走 approve 重试', () => {
    const result = classifyInstallFailure(new Error('Ignored build scripts: esbuild, sharp. Run "pnpm approve-builds".'))
    assert.equal(result.code, 'ERR_PNPM_IGNORED_BUILDS')
    assert.equal(result.layer, FAILURE_LAYERS.build)
    assert.equal(result.action, 'approve')
  })

  it('EPERM / EBUSY 走 lock 层可重试', () => {
    for (const text of [
      '[ERR_PNPM_EPERM] [importPackage C:/x/node_modules/p] EPERM: operation not permitted',
      'EBUSY: resource busy or locked',
      'ETXTBSY: text file is busy',
    ]) {
      const result = classifyInstallFailure(null, text)
      assert.equal(result.layer, FAILURE_LAYERS.lock, text)
      assert.equal(result.retryable, true, text)
      assert.equal(result.action, 'retry', text)
    }
  })

  it('版本不存在 → version 层，可降级重试', () => {
    const result = classifyInstallFailure(new Error('ERR_PNPM_NO_MATCHING_VERSION No matching version found for foo@9.9.9'))
    assert.equal(result.layer, FAILURE_LAYERS.version)
    assert.equal(result.action, 'fallback')
    assert.equal(result.retryable, true)
  })

  it('GitHub 子目录不存在 → subdir 层', () => {
    const result = classifyInstallFailure(new Error('ERR_PNPM_INVALID_PATH not a valid sub-directory'))
    assert.equal(result.layer, FAILURE_LAYERS.subdir)
    assert.equal(result.action, 'copy-cmd')
  })

  it('store 不一致与 lockfile 破损都指向 lock 层，但要手动处理', () => {
    const store = classifyInstallFailure(new Error('ERR_PNPM_UNEXPECTED_STORE Unexpected store location'))
    assert.equal(store.layer, FAILURE_LAYERS.lock)
    assert.equal(store.retryable, false)
    const lock = classifyInstallFailure(new Error('ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY Broken lockfile'))
    assert.equal(lock.layer, FAILURE_LAYERS.lock)
    assert.equal(lock.retryable, false)
  })
})

describe('未知失败不假装知道', () => {
  it('认不出的错误落进 unknown，给「复制命令」而不是瞎猜', () => {
    const result = classifyInstallFailure(new Error('something unexpected happened'))
    assert.equal(result.code, null)
    assert.equal(result.layer, FAILURE_LAYERS.unknown)
    assert.equal(result.action, 'copy-cmd')
    assert.equal(result.retryable, false)
    assert.equal(result.outcome, 'failed')
  })

  it('完全没有错误对象也不崩', () => {
    const result = classifyInstallFailure(null, null)
    assert.equal(result.layer, FAILURE_LAYERS.unknown)
    assert.equal(result.code, null)
  })
})

describe('incompatible 明细要透传', () => {
  it('incompatible-version 带上宿主给的包名', () => {
    const result = classifyInstallFailure({
      code: 'incompatible-version',
      message: 'incompatible-version',
      incompatible: [{ name: 'x-pkg', runtime: '0.2.1', unmet: { '@deepseek-ai/dsh': '>=99.0.0' } }],
    })
    assert.equal(result.code, 'incompatible-version')
    assert.equal(result.incompatible.length, 1)
    assert.equal(result.incompatible[0].name, 'x-pkg')
  })

  it('没有 incompatible 时给 null 而不是空数组', () => {
    const result = classifyInstallFailure({ code: 'not-bundle', message: 'not-bundle' })
    assert.equal(result.incompatible, null)
  })
})

describe('firstLine：界面只留一行证据', () => {
  it('优先挑带错误码的那一行', () => {
    const text = 'Progress: resolved 1, resolved 2\n[ERR_PNPM_EPERM] rename failed\nDone'
    assert.match(firstLine(text), /ERR_PNPM_EPERM/)
  })

  it('没有错误码时取第一行非空', () => {
    assert.equal(firstLine('\n\n  first real line  \nsecond'), 'first real line')
  })

  it('超长行被截断，避免把整棵依赖树塞进界面', () => {
    const long = 'x'.repeat(500)
    assert.ok(firstLine(long).length <= 301)
    assert.match(firstLine(long), /…/)
  })

  it('空输入返回空串', () => {
    assert.equal(firstLine(''), '')
    assert.equal(firstLine(null), '')
  })
})

test('映射表覆盖宿主全部 13 个码（11 个 ManagementFailure + 2 个 refused 独有）', () => {
  const hostCodes = [
    'already-installed', 'ambiguous-install', 'bundle-in-use', 'incompatible-version',
    'invalid-spec', 'management-required', 'not-bundle', 'not-removable',
    'stale-approval', 'stop-profile', 'unknown-plugin',
    'not-a-bundle', 'not-a-package',
  ]
  for (const code of hostCodes) {
    assert.ok(INSTALL_CODE_MAP[code], code + ' 必须在映射表里，否则会裸奔成 pnpm 原文')
  }
  // 每个条目都必须有 layer 与 action，否则界面渲染会缺字段
  for (const [code, entry] of Object.entries(INSTALL_CODE_MAP)) {
    assert.ok(entry.layer, code + ' 缺 layer')
    assert.ok(entry.action, code + ' 缺 action')
    assert.equal(typeof entry.retryable, 'boolean', code + ' 的 retryable 必须是布尔')
  }
})
