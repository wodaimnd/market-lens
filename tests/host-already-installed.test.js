// already-installed 的宿主端回归：它必须是 200，不是 500。
//
// 真机背景：宿主 dsh-plugin-manager 有两处抛 already-installed
//   · HMR 下 Object.hasOwn(before, known)  → ManagementFailure('already-installed')
//   · 装前预检 refused（path / registry 两条）
// 两处都意味着「目标状态已达成」。原来 market-lens 的 catch 一视同仁回 500，
// 用户看到「安装失败」，于是反复点安装 —— 而它其实已经装好了。
//
// 这条测试走真实 install op，钉住：
//   ① 管理器抛 already-installed 时回 200，带 code/alreadyPresent/note/health
//   ② 日志里留 install.already-present，且**不能**有 install.failed
//   ③ 其它错误仍然是 500，且带 layer/action（前端据此渲染按钮）
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

/**
 * 造一个干净的 profile + 一个已经装好的 bundle。
 * 这是 already-installed 场景的真实前置：包确实在 node_modules 与 bundles 里。
 */
function makeHarness({ installed = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-already-'))
  const profile = path.join(home, 'profiles', 'desktop')
  const pkgDir = path.join(profile, 'node_modules', 'known-pkg')
  fs.mkdirSync(path.join(pkgDir, 'native'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'known-pkg',
    version: '2.0.0',
    exports: { './clawbot': './native/clawbot.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  fs.writeFileSync(path.join(pkgDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: gate',
    "      name: './native/index.js'",
  ].join('\n'))
  fs.writeFileSync(path.join(pkgDir, 'native', 'index.js'), 'export const name = "gate"')
  fs.writeFileSync(path.join(pkgDir, 'native', 'clawbot.js'), 'export default 1')

  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: installed ? { 'known-pkg': '2.0.0' } : {},
    dsh: { profile: { bundles: installed ? ['known-pkg'] : [] } },
  }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows: [], meta: {} }))

  return { home, profile }
}

function makeCtx(manager, handlers) {
  return {
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
}

async function boot(harness, manager, tag) {
  process.env.DSH_HOME = harness.home
  process.env.DSH_PROFILE_DIR = harness.profile
  process.env.DSH_PROFILE = 'desktop'
  process.env.NODE_ENV = 'test'
  const handlers = new Map()
  const { apply } = await import(PLUGIN_URL + '?' + tag + '=' + Math.random())
  apply(makeCtx(manager, handlers))
  return async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handlers.get('/api/market-lens')(req, res)
    return result
  }
}

test('already-installed 回 200，并带 note / alreadyPresent / health', async () => {
  const harness = makeHarness({ installed: true })
  const manager = {
    async listBundles() { return [] },
    async installBundle() {
      // 真实形状：ManagementFailure 的 message 与 code 同值
      const error = new Error('already-installed')
      error.code = 'already-installed'
      throw error
    },
  }
  const call = await boot(harness, manager, 'already')

  const response = await call({ op: 'install', spec: 'known-pkg@2.0.0' })
  assert.equal(response.status, 200, '已安装不是失败：' + JSON.stringify(response.body))
  assert.equal(response.body.ok, true)
  assert.equal(response.body.code, 'already-installed')
  assert.equal(response.body.alreadyPresent, true)
  assert.match(response.body.note, /已经装好/)
  assert.equal(response.body.health.verdict, 'ok', '已装好的包体检应当是 ok')
  assert.equal(response.body.health.mounted, true)

  const logs = await call({ op: 'logs', limit: 40 })
  const tags = (logs.body.entries || []).map((entry) => entry.tag)
  assert.ok(tags.includes('install.already-present'), '应留一条 already-present：' + tags.join(','))
  assert.ok(!tags.includes('install.failed'), '已安装不能落 failed：' + tags.join(','))

  fs.rmSync(harness.home, { recursive: true, force: true })
})

test('预检 refused 的措辞（文本里只有 is already installed）也回 200', async () => {
  const harness = makeHarness({ installed: true })
  const manager = {
    async listBundles() { return [] },
    async installBundle() {
      // 这种形态没有 code，只有文本 —— 嗅探规则必须兜住
      throw new Error('known-pkg is already installed')
    },
  }
  const call = await boot(harness, manager, 'already-text')
  const response = await call({ op: 'install', spec: 'known-pkg@2.0.0' })
  assert.equal(response.status, 200)
  assert.equal(response.body.code, 'already-installed')
  assert.equal(response.body.alreadyPresent, true)
  fs.rmSync(harness.home, { recursive: true, force: true })
})

test('真正的失败仍然 500，但带 layer / action / evidence', async () => {
  const harness = makeHarness({ installed: false })
  const manager = {
    async listBundles() { return [] },
    async installBundle() {
      const error = new Error('incompatible-version')
      error.code = 'incompatible-version'
      error.incompatible = [{ name: 'known-pkg', runtime: '0.2.1-rc.5', unmet: { '@deepseek-ai/dsh': '>=99.0.0' } }]
      throw error
    },
  }
  const call = await boot(harness, manager, 'incompatible')

  const response = await call({ op: 'install', spec: 'known-pkg@2.0.0' })
  assert.equal(response.status, 500, JSON.stringify(response.body))
  assert.equal(response.body.code, 'incompatible-version')
  assert.equal(response.body.layer, 'compat', '前端按 layer 说「哪一层」')
  assert.equal(response.body.action, 'force', '兼容性冲突要给「仍然安装」')
  assert.equal(response.body.retryable, false, '兼容性冲突重试没用')
  assert.ok(Array.isArray(response.body.incompatible), 'incompatible 明细要透传')
  assert.equal(response.body.incompatible[0].name, 'known-pkg')

  const logs = await call({ op: 'logs', limit: 40 })
  const failed = (logs.body.entries || []).find((entry) => entry.tag === 'install.failed')
  assert.ok(failed, '真失败要留 install.failed')
  assert.equal(failed.layer, 'compat')
  assert.equal(failed.action, 'force')

  fs.rmSync(harness.home, { recursive: true, force: true })
})

describe('upgrade 也认 already-installed', () => {
  it('升到当前版本 = 成功，不是失败', async () => {
    const harness = makeHarness({ installed: true })
    const manager = {
      async listBundles() {
        return [{ name: 'known-pkg', version: '2.0.0', installed: true, availability: 'profile' }]
      },
      async installBundle() {
        const error = new Error('already-installed')
        error.code = 'already-installed'
        throw error
      },
    }
    const call = await boot(harness, manager, 'upgrade-already')
    const response = await call({ op: 'upgrade', pkg: 'known-pkg', version: '2.0.0' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.code, 'already-installed')
    assert.equal(response.body.alreadyPresent, true)
    assert.match(response.body.note, /当前版本/)
    assert.equal(response.body.health.verdict, 'ok')
    fs.rmSync(harness.home, { recursive: true, force: true })
  })

  it('升级的其它失败带 layer/action', async () => {
    const harness = makeHarness({ installed: true })
    const manager = {
      async listBundles() { return [] },
      async installBundle() {
        const error = new Error('stop-profile')
        error.code = 'stop-profile'
        throw error
      },
    }
    const call = await boot(harness, manager, 'upgrade-stop')
    const response = await call({ op: 'upgrade', pkg: 'known-pkg', version: '3.0.0' })
    assert.equal(response.status, 500)
    assert.equal(response.body.code, 'stop-profile')
    assert.equal(response.body.layer, 'activation')
    assert.equal(response.body.action, 'restart', 'stop-profile 要告诉用户关掉 DSH')
    fs.rmSync(harness.home, { recursive: true, force: true })
  })
})
