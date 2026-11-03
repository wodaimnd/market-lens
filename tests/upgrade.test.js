// 升级链路回归。
//
// 三件互相矛盾、必须钉住的事：
//   1) 自定义安装接受 github:o/r 与 GitHub 地址，折成同一个 spec（以前折错成 #path:<repo>，必然 400/装错）；
//   2) upgrade 只接受精确版本，且本地 / link 包不给升级入口（没有 registry 版本可比）；
//   3) installedPackages() 列的是 profile manifest 里的全部已装包，不只是目录里出现过的行
//      —— 否则页头「已装 N」和表里的行数会一直对不上。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseManualSpec, exactVersion } from '../index.js'

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

test('parseManualSpec：三种写法折成同一份白名单 spec', () => {
  assert.equal(parseManualSpec('github:acme/tool'), 'github:acme/tool')
  assert.equal(parseManualSpec('https://github.com/acme/tool'), 'github:acme/tool')
  assert.equal(parseManualSpec('https://github.com/acme/tool.git'), 'github:acme/tool')
  assert.equal(parseManualSpec('https://github.com/acme/tool#path:packages/x'), 'github:acme/tool#path:packages/x')
  assert.equal(parseManualSpec('github:acme/tool#path:packages/x'), 'github:acme/tool#path:packages/x')
  assert.equal(parseManualSpec('@acme/tool'), '@acme/tool')
  assert.equal(parseManualSpec('@acme/tool@1.2.3'), '@acme/tool@1.2.3')

  // 普通 GitHub 地址不能凭空多出 #path:<repo>（这里以前就是这么错的）
  assert.doesNotMatch(String(parseManualSpec('https://github.com/acme/tool')), /#path:/)

  // 越界路径与 shell 元字符一律拒绝
  assert.equal(parseManualSpec('https://github.com/acme/tool#path:../etc'), null)
  assert.equal(parseManualSpec('github:acme/tool#path:../etc'), null)
  assert.equal(parseManualSpec('acme/tool; rm -rf /'), null)
  assert.equal(parseManualSpec(''), null)
  assert.equal(parseManualSpec(null), null)
})

test('exactVersion：只放行精确版本', () => {
  assert.equal(exactVersion('1.2.3'), '1.2.3')
  assert.equal(exactVersion('1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(exactVersion('^1.2.3'), null)
  assert.equal(exactVersion('1.2'), null)
  assert.equal(exactVersion('latest'), null)
  assert.equal(exactVersion(''), null)
})

test('upgrade：只装到目标精确版本，本地包与非法目标直接拒绝', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-upgrade-'))
  const profile = path.join(home, 'profiles', 'desktop')
  const pkgDir = path.join(profile, 'node_modules', 'alpha-pkg')
  const localDir = path.join(profile, 'node_modules', '@local', 'mine')
  const ghDir = path.join(profile, 'node_modules', 'gh-pkg')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.mkdirSync(localDir, { recursive: true })
  fs.mkdirSync(ghDir, { recursive: true })
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'profile', dependencies: { 'alpha-pkg': '1.0.0', '@local/mine': 'link:../../mine', 'gh-pkg': 'github:acme/gh-pkg' } }, null, 2),
  )
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'alpha-pkg', version: '1.0.0' }))
  fs.writeFileSync(path.join(localDir, 'package.json'), JSON.stringify({ name: '@local/mine', version: '0.0.1' }))
  fs.writeFileSync(path.join(ghDir, 'package.json'), JSON.stringify({ name: 'gh-pkg', version: '0.1.0' }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  const rows = [
    {
      key: 'pkg:alpha-pkg',
      name: 'alpha-pkg',
      title: 'Alpha',
      pkg: 'alpha-pkg',
      sources: ['1024store'],
      version: '2.0.0',
      heat: 10,
      update: { available: true, from: '1.0.0', to: '2.0.0' },
    },
  ]
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows, meta: {} }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'

  const specs = []
  const manager = {
    async listBundles() {
      return [{ name: 'alpha-pkg', version: '1.0.0', installed: true, availability: 'profile' }]
    },
    async installBundle(spec) {
      specs.push(spec)
      const target = spec.split('@').slice(0, -1).join('@') || spec
      const version = spec.slice(target.length + 1)
      const dir = path.join(profile, 'node_modules', 'alpha-pkg')
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'alpha-pkg', version }))
      const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
      manifest.dependencies['alpha-pkg'] = version
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifest, null, 2))
      return { name: 'alpha-pkg', version }
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

  try {
    const { apply } = await import('../index.js')
    apply(ctx)
    const handler = handlers.get('/api/market-lens')
    assert.equal(typeof handler, 'function', '应注册 /api/market-lens 路由')
    const call = async (payload) => {
      const { req, res, result } = jsonResponse(payload)
      await handler(req, res)
      return result
    }

    // 已装清单：manifest 里的两个包都应该在，不只是目录行里的那个
    const statusBefore = await call({ op: 'status' })
    const packages = statusBefore.body.installed.packages
    const names = packages.map((item) => item.pkg).sort()
    assert.deepEqual(names, ['@local/mine', 'alpha-pkg', 'gh-pkg'], '已装清单要覆盖本地包与 GitHub 包')
    assert.equal(statusBefore.body.installed.count, 3)
    assert.equal(packages.find((item) => item.pkg === '@local/mine').kind, 'local', 'link: 包应标成本地')
    assert.equal(packages.find((item) => item.pkg === '@local/mine').update.reason, 'local-package')
    // GitHub 装的包不等于「本地包」：同样是 registry === false，但说法要分开，
    // 否则界面上从仓库装的那几个看起来像自己写的包。
    const ghPkg = packages.find((item) => item.pkg === 'gh-pkg')
    assert.equal(ghPkg.kind, 'github')
    assert.equal(ghPkg.update.kind, 'external')
    assert.equal(ghPkg.update.reason, 'non-registry-spec')

    // 非法目标：范围版本、非包名、本地包
    assert.equal((await call({ op: 'upgrade', pkg: 'alpha-pkg', version: '^2.0.0' })).status, 400)
    assert.equal((await call({ op: 'upgrade', pkg: 'not a pkg', version: '2.0.0' })).status, 400)
    const localUpgrade = await call({ op: 'upgrade', pkg: '@local/mine', version: '0.0.2' })
    assert.equal(localUpgrade.status, 400, '本地包不该给升级入口')
    assert.deepEqual(specs, [], '被拒绝的目标不能落到 installBundle')

    // 正常升级：必须正好是 pkg@目标版本
    const ok = await call({ op: 'upgrade', pkg: 'alpha-pkg', version: '2.0.0' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.spec, 'alpha-pkg@2.0.0')
    assert.deepEqual(specs, ['alpha-pkg@2.0.0'], '升级不能降级成 pkg@latest')
    assert.equal(ok.body.installed.count, 3)

    const statusAfter = await call({ op: 'status' })
    const alpha = statusAfter.body.installed.packages.find((item) => item.pkg === 'alpha-pkg')
    assert.equal(alpha.version, '2.0.0', '升级后版本应立刻反映到已装清单')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
