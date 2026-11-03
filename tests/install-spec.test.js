/**
 * 不变式：一键安装的目标必须正好是这一行代表的插件。
 *
 * 装错包的代价远大于装不上——用户点的是 A，装上的是 B，比按钮不亮恶劣得多。
 * 所以这里每条都断言完整 spec 字符串，而不是「非空」或「包含」。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { installSpecFor, installSpecFromCommand, installTargetSnapshot, subdirForRow } from '../index.js'

const row = (overrides = {}) => ({
  key: 'pkg:@acme/tool',
  pkg: '@acme/tool',
  version: '1.2.3',
  repo: 'https://github.com/acme/tool',
  ...overrides,
})

describe('installSpecFor：npm 包优先，稳定版本才固定', () => {
  it('有精确稳定版本时固定到该版本', () => {
    assert.equal(installSpecFor(row()), '@acme/tool@1.2.3')
  })

  it('版本是范围或预发布时不固定，交给 registry 解析 latest', () => {
    assert.equal(installSpecFor(row({ version: '^1.2.3' })), '@acme/tool')
    assert.equal(installSpecFor(row({ version: '1.2.3-beta.1' })), '@acme/tool')
    assert.equal(installSpecFor(row({ version: null })), '@acme/tool')
  })

  it('npm 包存在时不会被仓库形态抢走身份', () => {
    assert.equal(installSpecFor(row({ key: 'pkg:@acme/tool', repo: 'https://github.com/acme/tool' })), '@acme/tool@1.2.3')
  })
})

describe('installSpecFor：GitHub 根安装与 #path: 子目录', () => {
  it('无子目录的仓库行折算成 github:owner/repo', () => {
    assert.equal(
      installSpecFor(row({ pkg: null, key: 'gh:https://github.com/acme/tool' })),
      'github:acme/tool',
    )
  })

  it('.git 后缀与大小写域名都能收敛成同一目标', () => {
    assert.equal(
      installSpecFor(row({ pkg: null, key: 'gh:https://github.com/acme/tool', repo: 'https://github.com/acme/tool.git' })),
      'github:acme/tool',
    )
  })

  it('子目录条目折算成 pnpm 的 #path: 写法，由 pnpm 校验目录是否存在', () => {
    assert.equal(
      installSpecFor(row({ pkg: null, key: 'gh:https://github.com/acme/tool#packages/x' })),
      'github:acme/tool#path:packages/x',
    )
  })

  it('子目录可以来自 installCommand，且拒绝 ../ 越界路径', () => {
    assert.equal(
      installSpecFor(row({ pkg: null, key: 'gh:https://github.com/acme/tool#x', installCommand: 'dsh plugin --profile desktop add github:acme/tool#path:packages/x' })),
      'github:acme/tool#path:packages/x',
    )
    assert.equal(subdirForRow({ key: 'gh:https://github.com/acme/tool#../etc' }), null)
    assert.equal(installSpecFor(row({ pkg: null, key: 'gh:https://github.com/acme/tool#../etc' })), null)
  })

  it('既无 npm 包也无 GitHub 仓库时返回 null，不能凭名字造目标', () => {
    assert.equal(installSpecFor(row({ pkg: null, repo: null, key: 'k' })), null)
    assert.equal(installSpecFor(null), null)
  })

  it('非 GitHub 仓库（GitLab 等）不折算，避免把 github: 前缀硬套上去', () => {
    assert.equal(
      installSpecFor(row({ pkg: null, repo: 'https://gitlab.com/acme/tool', key: 'gh:https://gitlab.com/acme/tool' })),
      null,
    )
  })
})

describe('installSpecFromCommand：只从 add 后提取白名单目标', () => {
  it('从 npm 安装命令提取包名', () => {
    assert.equal(installSpecFromCommand('dsh plugin --profile web add @tt-a1i/archify-dsh'), '@tt-a1i/archify-dsh')
    assert.equal(installSpecFromCommand('dsh plugin add sharp@0.33.0'), 'sharp@0.33.0')
  })

  it('从 GitHub 安装命令归一为 github:owner/repo', () => {
    assert.equal(installSpecFromCommand('dsh plugin add github:acme/tool'), 'github:acme/tool')
    assert.equal(installSpecFromCommand('dsh plugin add https://github.com/acme/tool.git'), 'github:acme/tool')
  })

  it('带 shell 元字符、裸子目录、绝对路径或多参数的命令拒绝；#path: 放行', () => {
    assert.equal(installSpecFromCommand('dsh plugin add foo; rm -rf /'), null)
    assert.equal(installSpecFromCommand('dsh plugin add github:acme/tool#packages/x'), null)
    assert.equal(installSpecFromCommand('dsh plugin add github:acme/tool#path:packages/x'), 'github:acme/tool#path:packages/x')
    assert.equal(installSpecFromCommand('dsh plugin add github:acme/tool#path:../etc'), null)
    assert.equal(installSpecFromCommand('dsh plugin add ./local-path'), null)
    assert.equal(installSpecFromCommand('dsh plugin add foo bar'), null)
    assert.equal(installSpecFromCommand('echo dsh plugin add foo'), null)
    assert.equal(installSpecFromCommand(''), null)
  })
})

describe('installTargetSnapshot：刷新后仍能凭快照安装同一行', () => {
  it('保留 pkg/repo/version 并过滤非法包名', () => {
    const snapshot = installTargetSnapshot({
      key: 'pkg:@acme/tool',
      pkg: '@acme/tool',
      repo: 'https://github.com/acme/tool',
      version: '1.2.3',
      title: 'Tool',
      installCommand: 'dsh plugin --profile desktop add @acme/tool',
    })
    assert.equal(snapshot.pkg, '@acme/tool')
    assert.equal(snapshot.repo, 'https://github.com/acme/tool')
    assert.equal(snapshot.version, '1.2.3')
    assert.equal(snapshot.title, 'Tool')
  })

  it('非法包名/版本不会进入安装 spec', () => {
    const snapshot = installTargetSnapshot({ key: 'evil', pkg: '../../evil', version: '1.2.3; rm -rf /' })
    assert.equal(snapshot.pkg, null)
    assert.equal(snapshot.version, null)
  })

  it('空对象返回 null', () => {
    assert.equal(installTargetSnapshot(null), null)
    assert.equal(installTargetSnapshot({}), null)
  })
})
