// 宿主端回归：更新检查不许去问「本地包」的最新版本。
//
// 现场症状：官方插件页里堆着 `pnpm inspect @local/market-lens` 的失败记录，
// 用户看到的就是「插件包异常不可用」。根因是 UpdateService 把 profile 里
// 所有已装插件都丢给 pluginManager.inspect，包括 link: 装的本地插件——
// pnpm 对它们只会回 invalid-spec / already-installed，注定失败。
//
// 这条测试同时钉住新加的 selfcheck 接口：下次再遇到「异常」，先取这份快照。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('更新检查跳过 link:/@local 包，selfcheck 给出可复制的现场快照', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-selfcheck-'))
  const profile = path.join(home, 'profiles', 'desktop')
  const localDir = path.join(profile, 'node_modules', '@local', 'market-lens')
  const registryDir = path.join(profile, 'node_modules', 'alpha-pkg')
  fs.mkdirSync(localDir, { recursive: true })
  fs.mkdirSync(registryDir, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: {
      '@local/market-lens': 'link:G:/AI PGRM/DSH/plugins/market-lens',
      'alpha-pkg': '1.0.0',
    },
  }))
  fs.writeFileSync(path.join(localDir, 'package.json'), JSON.stringify({ name: '@local/market-lens', version: '0.4.0' }))
  fs.writeFileSync(path.join(registryDir, 'package.json'), JSON.stringify({ name: 'alpha-pkg', version: '1.0.0' }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  const rows = [
    { key: 'pkg:alpha-pkg', name: 'alpha-pkg', title: 'Alpha', pkg: 'alpha-pkg', sources: ['1024store'], version: '1.0.0', heat: 10 },
  ]
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows, meta: {} }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'

  const inspected = []
  const manager = {
    async listBundles() {
      return [
        { name: '@local/market-lens', version: '0.4.0', installed: true, availability: 'profile' },
        { name: 'alpha-pkg', version: '1.0.0', installed: true, availability: 'profile' },
      ]
    },
    async inspect(spec) {
      inspected.push(spec)
      if (spec === 'alpha-pkg') return { status: 'accepted', version: '1.1.0', registry: 'https://registry.npmjs.org/' }
      throw new Error('不该去查这个包：' + spec)
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
            register(entry) {
              handlers.set(entry.path, entry.handler)
              return () => handlers.delete(entry.path)
            },
          },
          effect: (fn) => { fn() },
        })
      }
    },
    effect(run) { run() },
  }
  process.env.NODE_ENV = 'test'

  const { apply } = await import('../index.js')
  apply(ctx)
  const handler = handlers.get('/api/market-lens')
  const call = async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handler(req, res)
    return result
  }

  try {
    await call({ op: 'updates.check', force: true })
    let entries = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await call({ op: 'updates' })
      entries = response.body.entries || []
      if (entries.length >= 2 && response.body.status && response.body.status.running === false) break
      await sleep(50)
    }

    assert.deepEqual(inspected, ['alpha-pkg'], '只有 registry 上的包才该去问 pnpm，本地 link 包一次都不行')

    const local = entries.find((entry) => entry.pkg === '@local/market-lens')
    assert.ok(local, '本地包也应该在 entries 里出现（标成跳过）')
    assert.equal(local.source, 'skipped')
    assert.equal(local.reason, 'local-package')
    assert.equal(local.error, null, '跳过不是错误，不能往 .plugin-manager/logs 里写 warn')

    const remote = entries.find((entry) => entry.pkg === 'alpha-pkg')
    assert.equal(remote.available, true)
    assert.equal(remote.to, '1.1.0')
    assert.equal(remote.source, 'pluginManager')

    const selfcheck = await call({ op: 'selfcheck' })
    assert.equal(selfcheck.status, 200)
    const body = selfcheck.body
    assert.equal(body.route, '/api/market-lens')
    assert.match(body.pluginVersion, /^\d+\.\d+\.\d+$/)
    assert.equal(body.manager.available, true)
    assert.equal(body.updates.skippedLocal, 1)
    assert.equal(body.updates.errors.length, 0)
    assert.equal(typeof body.paths.cache, 'string')
    assert.equal(body.cache.rows, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
