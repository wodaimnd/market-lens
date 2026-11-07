/**
 * 端点级回归：目录里没有这一行时，安装请求仍应凭快照完成。
 *
 * 这正对应真实故障：面板打开后目录刷新/切源，rows 里已经没有该 key，
 * 旧代码直接 404「条目不在当前目录里」。这里用空缓存 + 假 pluginManager
 * 模拟最坏情况，断言安装 spec 仍来自用户点的那一行。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

let apply
let home
let handler

const fakeManager = {
  calls: [],
  ignoredBuilds: null,
  errorBuilds: null,
  throwText: null,
  // 只让第一次调用失败：用来验证「降级目标重试」这条路真的会重试并成功。
  throwFirstText: null,
  async installBundle(spec, options) {
    this.calls.push({ spec, options })
    if (this.throwFirstText) {
      const text = this.throwFirstText
      this.throwFirstText = null
      throw new Error(text)
    }
    if (this.throwText) throw new Error(this.throwText)
    if (this.ignoredBuilds && (!options.approvedBuilds || !options.approvedBuilds.length)) {
      throw new Error('Ignored build scripts: ' + this.ignoredBuilds.join(', ') + '. Run "pnpm approve-builds" to pick.')
    }
    if (this.errorBuilds && (!options.approvedBuilds || !options.approvedBuilds.length)) {
      throw Object.assign(new Error('install blocked by build scripts'), { pendingBuilds: this.errorBuilds })
    }
    return { name: '@acme/tool', version: '1.2.3', restartRequired: true }
  },
}

function makeContext() {
  const server = {
    exact: new Map(),
    register(definition) {
      server.exact.set(definition.path, definition.handler)
      return () => server.exact.delete(definition.path)
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: server,
    inject(_dependencies, callback) {
      callback({
        get(name) {
          if (name === 'pluginManager') return fakeManager
          if (name === 'webServer') return server
          return null
        },
        webServer: server,
        effect(run) {
          const cleanup = run()
          return typeof cleanup === 'function' ? cleanup : () => {}
        },
      })
    },
  }
  return { ctx, server }
}

async function call(payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
  let status = null
  let text = ''
  const res = {
    req,
    writeHead(code) { status = code },
    end(chunk) { text += chunk ? String(chunk) : '' },
  }
  await handler(req, res)
  return { status, body: JSON.parse(text) }
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'market-lens-install-'))
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'test'
  mkdirSync(path.join(home, 'market-lens'), { recursive: true })
  writeFileSync(path.join(home, 'market-lens', 'catalog.json'), JSON.stringify({
    version: 1,
    generatedAt: '2026-11-01T00:00:00.000Z',
    rows: [{
      key: 'pkg:@acme/tool',
      pkg: '@acme/tool',
      version: '1.2.3',
      name: 'Tool',
      title: 'Tool',
      sources: ['test'],
      sourceIds: { test: '1' },
    }, {
      key: 'gh:https://github.com/acme/mono#packages/plugin',
      repo: 'https://github.com/acme/mono',
      installCommand: 'dsh plugin --profile test add github:acme/mono#path:packages/plugin',
      name: 'plugin',
      title: 'plugin',
      sources: ['test'],
      sourceIds: { test: 'mono#packages/plugin' },
    }],
    meta: { sourceCounts: { test: 1 }, compatTotal: 1 },
  }))
  const module = await import('../index.js')
  apply = module.apply
  const { ctx, server } = makeContext()
  apply(ctx)
  handler = server.exact.get('/api/market-lens')
  assert.equal(typeof handler, 'function')
})

after(() => {
  if (home) rmSync(home, { recursive: true, force: true })
})

describe('install endpoint：目录缺失时用快照补目标', () => {
  it('目录里有这一行时按 key 命中，不依赖 pkg 索引', async () => {
    fakeManager.calls.length = 0
    const result = await call({ op: 'install', key: 'pkg:@acme/tool' })
    assert.equal(result.status, 200)
    assert.equal(result.body.spec, '@acme/tool@1.2.3')
    assert.equal(result.body.origin, 'catalog')
  })

  it('目录里的 GitHub 子目录行折算成 #path: 而不是根仓库', async () => {
    fakeManager.calls.length = 0
    const result = await call({ op: 'install', key: 'gh:https://github.com/acme/mono#packages/plugin' })
    assert.equal(result.status, 200)
    assert.equal(result.body.origin, 'catalog')
    assert.equal(result.body.spec, 'github:acme/mono#path:packages/plugin')
    assert.equal(fakeManager.calls.at(-1).spec, 'github:acme/mono#path:packages/plugin')
  })

  it('rows 为空仍能安装快照里的 npm 包', async () => {
    const cleared = await call({ op: 'clear' })
    assert.equal(cleared.status, 200)
    fakeManager.calls.length = 0
    const result = await call({
      op: 'install',
      key: 'pkg:@acme/tool',
      target: { key: 'pkg:@acme/tool', pkg: '@acme/tool', version: '1.2.3', title: 'Tool' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.spec, '@acme/tool@1.2.3')
    assert.equal(result.body.origin, 'snapshot')
    assert.equal(fakeManager.calls.length, 1)
    assert.equal(fakeManager.calls[0].spec, '@acme/tool@1.2.3')
  })

  it('快照里的 GitHub 根仓库可直接安装', async () => {
    fakeManager.calls.length = 0
    const result = await call({
      op: 'install',
      key: 'gh:acme/tool',
      target: { key: 'gh:acme/tool', repo: 'https://github.com/acme/tool' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.spec, 'github:acme/tool')
    assert.equal(result.body.origin, 'snapshot')
  })

  it('快照里的 GitHub 子目录保留 #path:，不会退化成根仓库', async () => {
    fakeManager.calls.length = 0
    const result = await call({
      op: 'install',
      key: 'gh:https://github.com/acme/tool#packages/plugin',
      target: {
        key: 'gh:https://github.com/acme/tool#packages/plugin',
        repo: 'https://github.com/acme/tool',
        installCommand: 'dsh plugin --profile test add github:acme/tool#path:packages/plugin',
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.spec, 'github:acme/tool#path:packages/plugin')
    assert.equal(fakeManager.calls.at(-1).spec, 'github:acme/tool#path:packages/plugin')
  })

  it('子目录不存在时返回可操作的 subdir-missing 错误', async () => {
    fakeManager.throwText = 'ERR_PNPM_INVALID_PATH: Path "packages/gone" is not a valid sub-directory of the git checkout'
    const result = await call({
      op: 'install',
      key: 'gh:https://github.com/acme/mono#packages/gone',
      target: { key: 'gh:https://github.com/acme/mono#packages/gone', repo: 'https://github.com/acme/mono' },
    })
    fakeManager.throwText = null
    assert.equal(result.status, 500)
    // code 现在是**原始码**（ERR_PNPM_INVALID_PATH），不再是自造的 subdir-missing：
    // 前端按 layer + action 渲染，不再硬编码认几个特定字符串。
    assert.equal(result.body.code, 'ERR_PNPM_INVALID_PATH')
    assert.equal(result.body.layer, 'subdir')
    assert.equal(result.body.action, 'copy-cmd')
    assert.match(result.body.error, /子目录在当前仓库中不存在/)
  })

  it('快照里的 installCommand 可作为最后兜底', async () => {
    fakeManager.calls.length = 0
    const result = await call({
      op: 'install',
      key: 'gh:acme/tool',
      target: { key: 'gh:acme/tool', installCommand: 'dsh plugin --profile test add github:acme/tool' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.spec, 'github:acme/tool')
  })

  it('既没有目录行也没有快照时给出可操作错误，而不是静默失败', async () => {
    const result = await call({ op: 'install', key: 'pkg:missing' })
    assert.equal(result.status, 404)
    assert.equal(result.body.ok, false)
    assert.match(result.body.error, /刷新目录/)
  })

  it('错误对象自带 pendingBuilds 时也能让前端二次确认', async () => {
    fakeManager.errorBuilds = ['sharp']
    fakeManager.calls.length = 0
    const blocked = await call({
      op: 'install',
      key: 'pkg:@acme/tool',
      target: { key: 'pkg:@acme/tool', pkg: '@acme/tool', version: '1.2.3' },
    })
    assert.equal(blocked.status, 409)
    assert.deepEqual(blocked.body.pendingBuilds, ['sharp'])
    fakeManager.errorBuilds = null
  })

  it('构建脚本被忽略时返回 pendingBuilds，重试可带 approvedBuilds', async () => {
    fakeManager.calls.length = 0
    fakeManager.ignoredBuilds = ['sharp']
    const first = await call({
      op: 'install',
      key: 'pkg:sharp',
      target: { key: 'pkg:sharp', pkg: 'sharp', version: '0.33.0' },
    })
    assert.equal(first.status, 409)
    assert.equal(first.body.code, 'build-approval-required')
    assert.deepEqual(first.body.pendingBuilds, ['sharp'])

    const second = await call({
      op: 'install',
      key: 'pkg:sharp',
      target: { key: 'pkg:sharp', pkg: 'sharp', version: '0.33.0' },
      approvedBuilds: first.body.pendingBuilds,
    })
    assert.equal(second.status, 200)
    assert.deepEqual(fakeManager.calls.at(-1).options.approvedBuilds, ['sharp'])
    fakeManager.ignoredBuilds = null
  })
})

describe('安装降级重试：目录版本过期时不把用户堵在报错里', () => {
  it('npm 上没有目录写的版本时，自动退回最新版本并如实回报', async () => {
    fakeManager.calls.length = 0
    fakeManager.throwFirstText = 'ERR_PNPM_NO_MATCHING_VERSION No matching version found for @acme/tool@9.9.9'
    const result = await call({
      op: 'install',
      key: 'pkg:@acme/tool',
      target: { key: 'pkg:@acme/tool', pkg: '@acme/tool', version: '9.9.9' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.fellBackFrom, '@acme/tool@9.9.9')
    assert.equal(result.body.spec, '@acme/tool')
    assert.deepEqual(fakeManager.calls.map((item) => item.spec), ['@acme/tool@9.9.9', '@acme/tool'])
  })

  it('子目录改名后退回仓库根目录，并说明降级过', async () => {
    fakeManager.calls.length = 0
    fakeManager.throwFirstText = 'ERR_PNPM_INVALID_PATH: Path "packages/gone" is not a valid sub-directory of the git checkout'
    const result = await call({
      op: 'install',
      key: 'gh:https://github.com/acme/mono#packages/gone',
      target: { key: 'gh:https://github.com/acme/mono#packages/gone', repo: 'https://github.com/acme/mono' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.fellBackFrom, 'github:acme/mono#path:packages/gone')
    assert.equal(result.body.spec, 'github:acme/mono')
  })

  it('降级两次都失败时，错误里保留第一次的目标供前端解释', async () => {
    fakeManager.calls.length = 0
    fakeManager.throwText = 'ERR_PNPM_NO_MATCHING_VERSION No matching version found for @acme/tool@9.9.9'
    const result = await call({
      op: 'install',
      key: 'pkg:@acme/tool',
      target: { key: 'pkg:@acme/tool', pkg: '@acme/tool', version: '9.9.9' },
    })
    fakeManager.throwText = null
    assert.equal(result.status, 500)
    assert.equal(result.body.fellBackFrom, '@acme/tool@9.9.9')
    assert.equal(fakeManager.calls.length, 2)
  })
})

describe('install endpoint：自定义安装只发 spec', () => {
  it('只带 spec、没有 key 和 target 时按 spec 安装，而不是 404', async () => {
    fakeManager.calls.length = 0
    const result = await call({ op: 'install', spec: '@acme/tool@1.2.3' })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.spec, '@acme/tool@1.2.3')
    assert.equal(result.body.origin, 'manual')
    assert.deepEqual(fakeManager.calls.map((item) => item.spec), ['@acme/tool@1.2.3'])
  })

  it('只带 GitHub 地址时折成 github: 安装目标', async () => {
    fakeManager.calls.length = 0
    const result = await call({ op: 'install', spec: 'https://github.com/acme/plain' })
    assert.equal(result.status, 200)
    assert.equal(result.body.spec, 'github:acme/plain')
  })

  it('spec 不合法时 404 说清支持哪些写法，且不调用安装器', async () => {
    fakeManager.calls.length = 0
    const result = await call({ op: 'install', spec: 'rm -rf /' })
    assert.equal(result.status, 404)
    assert.match(result.body.error, /github:owner\/repo/)
    assert.equal(fakeManager.calls.length, 0)
  })

  it('既没有 key 也没有 spec 时给原来的 404 提示', async () => {
    const result = await call({ op: 'install' })
    assert.equal(result.status, 404)
    assert.match(result.body.error, /找不到该条目/)
  })
})
