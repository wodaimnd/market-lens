// button 状态在 Host 侧的端到端回归：失败标记必须跟着行走，不能只活在页面上。
//
// 现场问题：client 的 actionBusy 只在当前页面活，目录一刷新就丢，
// 于是「刚刚装失败」的行刷新后又变回「装」—— 用户以为上次成功了。
// Host 现在把失败 key 存在内存集合里，publicRow 直接下发 button.state='retry'。
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')).href

function jsonResponse(body) {
  const payload = Buffer.from(JSON.stringify(body))
  const result = { status: 0, body: null }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    writeHead(code) { this.statusCode = code },
    end(chunk) {
      result.status = this.statusCode
      const text = chunk ? Buffer.from(chunk).toString('utf8') : ''
      result.body = text ? JSON.parse(text) : null
      return true
    },
    on() {},
  }
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  }
  return { req, res, result }
}

const ROWS = [
  { key: 'pkg:alpha-pkg', name: 'alpha-pkg', title: 'Alpha', pkg: 'alpha-pkg', sources: ['1024store'], version: '1.0.0', heat: 10 },
  { key: 'pkg:beta-pkg', name: 'beta-pkg', title: 'Beta', pkg: 'beta-pkg', sources: ['1024store'], version: '2.0.0', heat: 9 },
]

function makeHarness({ manager } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-btn-'))
  const profile = path.join(home, 'profiles', 'desktop')
  // alpha 已装且 registry 可比 → current；beta 未装 → install
  const alphaDir = path.join(profile, 'node_modules', 'alpha-pkg')
  fs.mkdirSync(alphaDir, { recursive: true })
  fs.writeFileSync(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha-pkg', version: '1.0.0' }))
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: { 'alpha-pkg': '1.0.0' },
    dsh: { profile: { bundles: [] } },
  }))
  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows: ROWS, meta: {} }))
  return { home, profile }
}

async function boot(harness, manager, tag) {
  process.env.DSH_HOME = harness.home
  process.env.DSH_PROFILE_DIR = harness.profile
  process.env.DSH_PROFILE = 'desktop'
  process.env.NODE_ENV = 'test'
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) { return name === 'pluginManager' ? manager : undefined },
    inject(names, run) {
      if (names.includes('pluginManager')) {
        run({ get: (name) => (name === 'pluginManager' ? manager : undefined), effect: (fn) => { fn() } })
      }
      if (names.includes('webServer')) {
        run({
          webServer: {
            exact: { has: () => false },
            register(entry) { handlers.set(entry.path, entry.handler); return () => handlers.delete(entry.path) },
          },
          effect(fn) { fn() },
        })
      }
    },
    effect(run) { run() },
  }
  const { apply } = await import(PLUGIN_URL + '?' + tag + '=' + Math.random())
  apply(ctx)
  return async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handlers.get('/api/market-lens')(req, res)
    return result
  }
}

describe('publicRow 下发 button', () => {
  it('每一行都带合法的 button 状态', async () => {
    const harness = makeHarness({ manager: { async listBundles() { return [] }, async installBundle() { return { name: 'beta-pkg' } } } })
    const call = await boot(harness, harness.manager || { async listBundles() { return [] }, async installBundle() { return { name: 'beta-pkg' } } }, 'btn-shape')
    const catalog = await call({ op: 'catalog' })
    for (const row of catalog.body.rows) {
      assert.ok(row.button, row.id + ' 缺 button')
      assert.ok(['install', 'manual', 'update', 'current', 'installed-local', 'retry'].includes(row.button.state), row.button.state)
      assert.ok(row.button.labelKey, row.id + ' 缺 labelKey')
    }
    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('已装且 registry 可比 → current；未装 → install', async () => {
    const harness = makeHarness()
    const manager = { async listBundles() { return [] }, async installBundle() { return {} } }
    const call = await boot(harness, manager, 'btn-states')
    const catalog = await call({ op: 'catalog' })
    const alpha = catalog.body.rows.find((row) => row.id === 'pkg:alpha-pkg')
    const beta = catalog.body.rows.find((row) => row.id === 'pkg:beta-pkg')
    assert.equal(alpha.button.state, 'current', '已装且无新版应是 current')
    assert.equal(alpha.button.mode, 'reinstall', '点 current 是幂等重装')
    assert.equal(beta.button.state, 'install')
    fs.rmSync(harness.home, { recursive: true, force: true })
  })
})

describe('失败标记跟着行走', () => {
  it('安装失败后重新拉目录，那一行仍是 retry', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        const error = new Error('ERR_PNPM_NO_MATCHING_VERSION No matching version found')
        throw error
      },
    }
    const call = await boot(harness, manager, 'btn-retry')

    const before = await call({ op: 'catalog' })
    assert.equal(before.body.rows.find((row) => row.id === 'pkg:beta-pkg').button.state, 'install')

    const failed = await call({ op: 'install', key: 'pkg:beta-pkg' })
    assert.equal(failed.status, 500)

    // 关键：重新拉目录（模拟页面刷新 / 轮询）—— 失败状态必须还在
    const after = await call({ op: 'catalog' })
    const beta = after.body.rows.find((row) => row.id === 'pkg:beta-pkg')
    assert.equal(beta.button.state, 'retry', '失败要在目录刷新后仍然可见')
    assert.equal(beta.button.labelKey, 'actRetry')

    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('重新安装成功后 retry 标记被清掉', async () => {
    const harness = makeHarness()
    let shouldFail = true
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        if (shouldFail) throw new Error('ERR_PNPM_NO_MATCHING_VERSION nope')
        return { name: 'beta-pkg', version: '2.0.0' }
      },
    }
    const call = await boot(harness, manager, 'btn-clear')

    await call({ op: 'install', key: 'pkg:beta-pkg' })
    let catalog = await call({ op: 'catalog' })
    assert.equal(catalog.body.rows.find((row) => row.id === 'pkg:beta-pkg').button.state, 'retry')

    shouldFail = false
    const ok = await call({ op: 'install', key: 'pkg:beta-pkg' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))

    catalog = await call({ op: 'catalog' })
    const beta = catalog.body.rows.find((row) => row.id === 'pkg:beta-pkg')
    assert.notEqual(beta.button.state, 'retry', '成功后必须清掉 retry')

    fs.rmSync(harness.home, { recursive: true, force: true })
  })
})
