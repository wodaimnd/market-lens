/**
 * 静默拒绝回归：宿主返回失败结果，而不是抛出异常。
 *
 * 真机事故（2026-11-07）：
 *   日志里写着两次 `install ok spec=dsh-tidy-display@0.4.7`，
 *   但宿主实际输出是：
 *     dsh: installation rejected: Plugin dsh-tidy-display@0.4.7 is incompatible ...
 *     dsh: nothing was installed.
 *   profile 里那个包一直是 `link:` 装的老副本 —— 什么都没变。
 *   用户看到「已安装」，就以为装成了。
 *
 * 根因：宿主的 `change()` 把操作异常**吞进结果对象**，不向外抛：
 *
 *   catch (error) {
 *     result.application = 'failed'        // ← 不是 throw
 *     result.error = managementError(error)
 *   }
 *
 * 所以 installBundle/upgrade 会**正常 resolve** 成
 *   { application: 'failed', error: { code, incompatible? }, changed }
 * 而 market-lens 只 catch 抛出的异常 → 记录 ok。
 *
 * 这条测试钉住：application === 'failed' 必须变成 500 + 可操作的分层结论。
 */
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
  {
    key: 'pkg:dsh-tidy-display',
    name: 'dsh-tidy-display',
    title: 'Tidy Display',
    pkg: 'dsh-tidy-display',
    sources: ['1024store'],
    version: '0.4.7',
    heat: 10,
  },
]

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-silent-'))
  const profile = path.join(home, 'profiles', 'next')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))
  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({
    version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows: ROWS, meta: {},
  }))
  return { home, profile }
}

async function boot(harness, manager, tag) {
  process.env.DSH_HOME = harness.home
  process.env.DSH_PROFILE_DIR = harness.profile
  process.env.DSH_PROFILE = 'next'
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

describe('application=failed 必须变成 500', () => {
  it('兼容性拒绝（真实形态）不再被记成 install ok', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        // 宿主 change() 吞掉异常后返回的对象 —— 这是真机上的确切形状
        return {
          application: 'failed',
          changed: false,
          error: {
            code: 'incompatible-version',
            incompatible: [{
              name: 'dsh-tidy-display',
              version: '0.4.7',
              runtime: '0.2.2-rc.1',
              unmet: { 'engines.dsh': '0.1.0-rc.2 || 0.2.1-rc.5' },
            }],
          },
          output: 'dsh: installation rejected: Plugin dsh-tidy-display@0.4.7 is incompatible\ndsh: nothing was installed.',
        }
      },
    }
    const call = await boot(harness, manager, 'silent-compat')

    const response = await call({ op: 'install', key: 'pkg:dsh-tidy-display' })
    assert.equal(response.status, 500, '静默拒绝必须变成 500：' + JSON.stringify(response.body))
    assert.equal(response.body.ok, false)
    assert.equal(response.body.code, 'incompatible-version')
    assert.equal(response.body.layer, 'compat')
    assert.equal(response.body.action, 'force')
    assert.ok(Array.isArray(response.body.incompatible), 'incompatible 明细要透传')

    // 日志必须是 rejected-by-host，绝不能是 install.ok
    const logs = await call({ op: 'logs', limit: 60 })
    const tags = (logs.body.entries || []).map((entry) => entry.tag)
    assert.ok(tags.includes('install.rejected-by-host'), '要留一条明确记录：' + tags.join(','))
    assert.ok(!tags.includes('install.ok'), '绝不能记成 ok：' + tags.join(','))

    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('operation-error（非 ManagementFailure）也能读出来', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        // 宿主对普通错误给 { code: 'operation-error', diagnostic }（字段是 diagnostic）
        return {
          application: 'failed',
          changed: false,
          error: { code: 'operation-error', diagnostic: 'pnpm add failed with exit code 1' },
        }
      },
    }
    const call = await boot(harness, manager, 'silent-op-error')
    const response = await call({ op: 'install', key: 'pkg:dsh-tidy-display' })
    assert.equal(response.status, 500)
    assert.match(String(response.body.detail), /operation-error|pnpm add failed/)
    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('没有 error 对象时退回 output 文本', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        return { application: 'failed', changed: false, output: 'dsh: installation rejected: something\n' }
      },
    }
    const call = await boot(harness, manager, 'silent-no-error')
    const response = await call({ op: 'install', key: 'pkg:dsh-tidy-display' })
    assert.equal(response.status, 500)
    assert.match(String(response.body.detail), /installation rejected|something/)
    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('失败后按钮状态变成 retry（失败标记要落盘在 Host 侧）', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        return { application: 'failed', changed: false, error: { code: 'incompatible-version' } }
      },
    }
    const call = await boot(harness, manager, 'silent-retry')
    await call({ op: 'install', key: 'pkg:dsh-tidy-display' })
    const catalog = await call({ op: 'catalog' })
    const row = catalog.body.rows.find((candidate) => candidate.id === 'pkg:dsh-tidy-display')
    assert.equal(row.button.state, 'retry', '静默拒绝也要让按钮变重试')
    fs.rmSync(harness.home, { recursive: true, force: true })
  })
})

describe('正常成功不能被误判', () => {
  it('application=restart-required 是成功（不是失败）', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        return {
          name: 'dsh-tidy-display',
          version: '0.4.7',
          application: 'restart-required',
          restartReason: 'no-hmr',
          changed: true,
        }
      },
    }
    const call = await boot(harness, manager, 'silent-ok')
    const response = await call({ op: 'install', key: 'pkg:dsh-tidy-display' })
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300))
    assert.equal(response.body.ok, true)
    const logs = await call({ op: 'logs', limit: 60 })
    const tags = (logs.body.entries || []).map((entry) => entry.tag)
    assert.ok(tags.includes('install.ok'), '成功要留 install.ok')
    assert.ok(!tags.includes('install.rejected-by-host'))
    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('没有 application 字段的老宿主仍按成功处理', async () => {
    const harness = makeHarness()
    const manager = {
      async listBundles() { return [] },
      async installBundle() { return { name: 'dsh-tidy-display', version: '0.4.7' } },
    }
    const call = await boot(harness, manager, 'silent-legacy')
    const response = await call({ op: 'install', key: 'pkg:dsh-tidy-display' })
    assert.equal(response.status, 200, '不认识的返回形状不能被当成失败')
    fs.rmSync(harness.home, { recursive: true, force: true })
  })
})

describe('upgrade 也要检查 application', () => {
  it('升级被静默拒绝时不是「升级完成」', async () => {
    const harness = makeHarness()
    // 先让它"已装"，这样 upgrade 才有意义
    const pkgDir = path.join(harness.profile, 'node_modules', 'dsh-tidy-display')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-tidy-display', version: '0.4.6' }))
    const manifest = JSON.parse(fs.readFileSync(path.join(harness.profile, 'package.json'), 'utf8'))
    manifest.dependencies['dsh-tidy-display'] = '0.4.6'
    fs.writeFileSync(path.join(harness.profile, 'package.json'), JSON.stringify(manifest))

    const manager = {
      async listBundles() {
        return [{ name: 'dsh-tidy-display', version: '0.4.6', installed: true, availability: 'profile' }]
      },
      async installBundle() {
        return {
          application: 'failed',
          changed: false,
          error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-tidy-display', version: '0.4.7' }] },
        }
      },
    }
    const call = await boot(harness, manager, 'silent-upgrade')
    const response = await call({ op: 'upgrade', pkg: 'dsh-tidy-display', version: '0.4.7' })
    assert.equal(response.status, 500, '静默拒绝不能报成升级成功：' + JSON.stringify(response.body))
    assert.equal(response.body.code, 'incompatible-version')
    assert.equal(response.body.layer, 'compat')
    fs.rmSync(harness.home, { recursive: true, force: true })
  })
})
