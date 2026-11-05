// 挂载判定的宿主端回归。
//
// 真机故障（2026-11-04，dsh-wechat-remote 安装）：
//   管理器返回 { name: 'dsh-wechat-remote@1.7.15' }，而 inspectMount 直接拿 name
//   去和 bundles 比对，永远不等 → 明明挂上了却报「已装好，但没有挂载」。
//   更早的 dsh-mp-automator 日志同样有 packageName: 'dsh-mp-automator@0.3.0' + mounted: false。
//
// 这条测试走的是真实 install op：装完之后必须
//   ① 认得出挂载（包名先折成纯包名再比）
//   ② 附带 health（装载行 / peer / 客户端半身），供前端在「装上但不出现」时直接说清楚
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// pathToFileURL 会自己转义空格，不能用 URL.pathname 手拼（那会得到 %2520 双重转义）
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

/**
 * 造一个装了插件、挂了 bundle 的 profile，并让管理器的返回值带版本号。
 * 这里面有两件事必须同时成立才有意义：
 *   · 依赖写进 dependencies、包落在 node_modules；
 *   · dsh.profile.bundles 里有它的纯包名。
 */
function makeHarness({ withPatchRows = 'ok' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-mount-'))
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(path.join(profile, 'node_modules', 'mount-pkg', 'native'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'node_modules', 'mount-pkg', 'package.json'), JSON.stringify({
    name: 'mount-pkg',
    version: '1.7.15',
    exports: { './clawbot': './native/clawbot.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  fs.writeFileSync(path.join(profile, 'node_modules', 'mount-pkg', 'native', 'index.js'), 'export const name = "gate"')
  fs.writeFileSync(path.join(profile, 'node_modules', 'mount-pkg', 'native', 'clawbot.js'), 'export default 1')
  fs.writeFileSync(path.join(profile, 'node_modules', 'mount-pkg', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: gate',
    "      name: './native/index.js'",
    '    - id: clawbot',
    withPatchRows === 'ok' ? "      name: 'mount-pkg/clawbot'" : "      name: 'mount-pkg/missing-exit'",
  ].join('\n'))
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))

  return { home, profile }
}

test('install 成功后认得出已挂载：管理器返回的 name 带版本号', async () => {
  const { home, profile } = makeHarness()
  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows: [], meta: {} }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'
  process.env.NODE_ENV = 'test'

  const manifestPath = path.join(profile, 'package.json')
  const manager = {
    async listBundles() { return [] },
    async installBundle(spec) {
      // 真实行为：写 dependencies + 把包装进 bundles，返回的 name 带版本号
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.dependencies['mount-pkg'] = '1.7.15'
      manifest.dsh.profile.bundles = ['mount-pkg']
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      return { name: 'mount-pkg@1.7.15', version: '1.7.15', bundle: 'mount-pkg', changed: true }
    },
  }

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

  const { apply } = await import(PLUGIN_URL + '?mount-regression=' + Math.random())
  apply(ctx)
  const call = async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handlers.get('/api/market-lens')(req, res)
    return result
  }

  const response = await call({ op: 'install', spec: 'mount-pkg@1.7.15' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.mount.packageName, 'mount-pkg', '包名必须折掉版本号')
  assert.equal(response.body.mount.mounted, true, 'bundles 里有就必须认成已挂载')
  assert.equal(response.body.mount.checked, true)
  assert.equal(response.body.mount.reason, null)

  assert.equal(response.body.health.verdict, 'ok')
  assert.equal(response.body.health.mounted, true)
  assert.equal(response.body.health.unmounted, false)
  assert.equal(response.body.health.rows.length, 2)
  assert.ok(response.body.health.rows.every((row) => row.status === 'ok'))

  // 日志里不该出现 install.not-mounted
  const logs = await call({ op: 'logs', limit: 50 })
  const tags = (logs.body.entries || []).map((entry) => entry.tag)
  assert.ok(!tags.includes('install.not-mounted'), '挂载成功时不能留 not-mounted 记录：' + tags.join(','))

  fs.rmSync(home, { recursive: true, force: true })
})

test('装载行解析不到时，install 仍然成功，但 health 明确报 bad 并落进日志', async () => {
  const { home, profile } = makeHarness({ withPatchRows: 'broken' })
  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows: [], meta: {} }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'
  process.env.NODE_ENV = 'test'

  const manifestPath = path.join(profile, 'package.json')
  const manager = {
    async listBundles() { return [] },
    async installBundle() {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.dependencies['mount-pkg'] = '1.7.15'
      manifest.dsh.profile.bundles = ['mount-pkg']
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      return { name: 'mount-pkg@1.7.15', version: '1.7.15', bundle: 'mount-pkg' }
    },
  }

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

  const { apply } = await import(PLUGIN_URL + '?health-bad=' + Math.random())
  apply(ctx)
  const call = async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handlers.get('/api/market-lens')(req, res)
    return result
  }

  const response = await call({ op: 'install', spec: 'mount-pkg@1.7.15' })
  assert.equal(response.status, 200, '装本身是成功的：文件与挂载都对')
  assert.equal(response.body.mount.mounted, true)
  assert.equal(response.body.health.verdict, 'bad')
  assert.match(response.body.health.detail, /mount-pkg\/missing-exit/)

  const logs = await call({ op: 'logs', limit: 50 })
  const healthLog = (logs.body.entries || []).find((entry) => entry.tag === 'install.health')
  assert.ok(healthLog, '必须留下一条 install.health 记录')
  assert.equal(healthLog.verdict, 'bad')
  // OpLog.sanitize 会过滤对象数组：传 [{status, name}] 进去会被吃成 []，
  // 于是日志里最关键的行名全丢。这里钉住「必须是字符串数组」。
  assert.ok(Array.isArray(healthLog.rows), 'rows 必须是数组')
  assert.ok(healthLog.rows.length > 0, 'rows 不能是空数组：' + JSON.stringify(healthLog.rows))
  assert.equal(typeof healthLog.rows[0], 'string')
  assert.ok(healthLog.rows.some((row) => row.includes('mount-pkg/missing-exit')), JSON.stringify(healthLog.rows))
  assert.deepEqual(healthLog.unresolved, ['mount-pkg/missing-exit'])

  fs.rmSync(home, { recursive: true, force: true })
})

describe('inspectMount 的包名折算口径', () => {
  it('管理器没给 name 时退回 spec，仍能折出包名', async () => {
    const { home, profile } = makeHarness()
    process.env.DSH_HOME = home
    process.env.DSH_PROFILE_DIR = profile
    process.env.DSH_PROFILE = 'desktop'
    process.env.NODE_ENV = 'test'
    const cacheDir = path.join(home, 'market-lens')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows: [], meta: {} }))

    const manifestPath = path.join(profile, 'package.json')
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        manifest.dependencies['mount-pkg'] = '1.7.15'
        manifest.dsh.profile.bundles = ['mount-pkg']
        fs.writeFileSync(manifestPath, JSON.stringify(manifest))
        return {}
      },
    }
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
    const { apply } = await import(PLUGIN_URL + '?spec-fallback=' + Math.random())
    apply(ctx)
    const call = async (payload) => {
      const { req, res, result } = jsonResponse(payload)
      await handlers.get('/api/market-lens')(req, res)
      return result
    }
    const response = await call({ op: 'install', spec: 'mount-pkg@1.7.15' })
    assert.equal(response.body.mount.packageName, 'mount-pkg')
    assert.equal(response.body.mount.mounted, true)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
