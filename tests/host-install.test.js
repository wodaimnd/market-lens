// 宿主端回归：一键安装必须只标记目标行，并把「已安装集合指纹」回传给前端。
//
// 现场 bug：publicRow 只给 id（= 内部 key）不给 key，前端拿 undefined 比对，
// 装一个插件就把整表刷成已安装。这条测试钉住两端契约：
//   1) 安装请求用 id 定位 → 只改这一行；
//   2) 响应里带 installed.fingerprint，前端据此判断"要不要重拉目录"。
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packageNameFromSpec, isFileBusy, busyPackageFrom } from '../index.js'

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
  void body
  return { req, res, result }
}

test('install 只影响目标行，并在响应里给出已安装指纹', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-home-'))
  const profile = path.join(home, 'profiles', 'desktop')
  const installedDir = path.join(profile, 'node_modules', 'alpha-pkg')
  fs.mkdirSync(installedDir, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'alpha-pkg': '1.0.0' } }))
  fs.writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({ name: 'alpha-pkg', version: '1.0.0' }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  const rows = [
    { key: 'pkg:alpha-pkg', name: 'alpha-pkg', title: 'Alpha', pkg: 'alpha-pkg', sources: ['1024store'], version: '1.0.0', heat: 10 },
    { key: 'pkg:beta-pkg', name: 'beta-pkg', title: 'Beta', pkg: 'beta-pkg', sources: ['1024store'], version: '2.0.0', heat: 9 },
  ]
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows, meta: {} }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'

  const installedSpecs = []
  const manager = {
    async listBundles() {
      return [
        { name: 'alpha-pkg', version: '1.0.0', installed: true, availability: 'profile' },
      ]
    },
    async installBundle(spec) {
      installedSpecs.push(spec)
      // 真的把依赖写进 profile：装完之后 refreshInstalledOnRows 必须看到它。
      const betaDir = path.join(profile, 'node_modules', 'beta-pkg')
      fs.mkdirSync(betaDir, { recursive: true })
      fs.writeFileSync(path.join(betaDir, 'package.json'), JSON.stringify({ name: 'beta-pkg', version: '2.0.0' }))
      const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
      manifest.dependencies['beta-pkg'] = '2.0.0'
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifest))
      return { name: 'beta-pkg', version: '2.0.0' }
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
  assert.equal(typeof handler, 'function', '应注册 /api/market-lens 路由')

  const call = async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handler(req, res)
    return result
  }

  const before = await call({ op: 'catalog' })
  assert.equal(before.status, 200)
  const installedBefore = before.body.rows.filter((row) => row.installed).map((row) => row.id)
  assert.deepEqual(installedBefore, ['pkg:alpha-pkg'], '初始只有 alpha 已安装')

  const installResponse = await call({ op: 'install', key: 'pkg:beta-pkg' })
  assert.equal(installResponse.status, 200, JSON.stringify(installResponse.body))
  assert.deepEqual(installedSpecs, ['beta-pkg@2.0.0'], '安装 spec 应精确到版本')
  assert.equal(installResponse.body.key, 'pkg:beta-pkg')
  assert.equal(typeof installResponse.body.installed?.fingerprint, 'string')

  const after = await call({ op: 'catalog' })
  const installedAfter = after.body.rows.filter((row) => row.installed).map((row) => row.id).sort()
  assert.deepEqual(installedAfter, ['pkg:alpha-pkg', 'pkg:beta-pkg'], '只多出 beta 这一行')

  const status = await call({ op: 'status' })
  assert.equal(status.body.install.available, true)
  assert.equal(typeof status.body.installed?.fingerprint, 'string')
  assert.equal(status.body.installed.count, 2)

  fs.rmSync(home, { recursive: true, force: true })
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

// 挂载校验：装完之后必须核对「有没有进 dsh.profile.bundles」。
//
// 现场问题：installBundle 除了写 dependencies 还会隐式调 selectBundle 把包
// 加进 bundle 层；这一步安静失败时前端只看到「安装成功」，重启后插件根本不
// 加载 —— 用户说的「装上了但不出现」就是它。所以这里既钉住解析口径，也钉住
// 「没挂上要明确报出来」这条契约。
describe('packageNameFromSpec：从安装目标折出包名', () => {
  const cases = [
    ['humanizer-ru', 'humanizer-ru'],
    ['humanizer-ru@3.32.0', 'humanizer-ru'],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-base'],
    ['@deepseek-ai/dsh-base@0.0.1-rc.1', '@deepseek-ai/dsh-base'],
    ['github:o/r', 'r'],
    ['github:o/r#path:packages/x', 'r'],
    ['https://github.com/o/r.git', 'r'],
    ['https://github.com/o/r/tree/main', 'r'],
  ]
  for (const [spec, expected] of cases) {
    it(spec + ' → ' + expected, () => {
      assert.equal(packageNameFromSpec(spec), expected)
    })
  }

  it('本地路径 / link 折不出包名时返回 null（不能误报未挂载）', () => {
    for (const spec of ['link:G:/some/pkg', 'C:/path/to/pkg', './local-dir', 'workspace:*']) {
      assert.equal(packageNameFromSpec(spec), null, spec + ' 应返回 null')
    }
  })

  it('空值与非法输入返回 null', () => {
    assert.equal(packageNameFromSpec(''), null)
    assert.equal(packageNameFromSpec(null), null)
    assert.equal(packageNameFromSpec(undefined), null)
  })
})

// 文件占用（EPERM）的识别：这是「点了安装还是失败」的真凶。
//
// 现场日志（.plugin-manager/logs/operation-HSeGGy/pnpm.log）：
//   [ERR_PNPM_EPERM] [importPackage ...\node_modules\@tt-a1i\archify-dsh]
//   EPERM: operation not permitted, rename '..._tmp_16340_11' -> '...archify-dsh'
//
// 关键判断：这类失败绝不能走「降级目标」——那不是版本问题，换个 spec 一样被锁。
// 之前所有失败一视同仁地试降级，等于拿一个错目标掩盖真实原因。
describe('isFileBusy：把「文件被占用」和「版本不存在」分开', () => {
  it('识别真实的 pnpm EPERM（importPackage + rename）', () => {
    const real = new Error('[ERR_PNPM_EPERM] [importPackage C:/x/node_modules/@tt-a1i/archify-dsh] EPERM: operation not permitted, rename C:/x/archify-dsh_tmp_16340_11 -> C:/x/archify-dsh')
    assert.equal(isFileBusy(real), true)
  })

  it('识别 Linux/macOS 的占用错误', () => {
    assert.equal(isFileBusy(new Error('EBUSY: resource busy or locked')), true)
    assert.equal(isFileBusy(new Error('ETXTBSY: text file is busy')), true)
  })

  it('只有 rename _tmp_ 形态也算占用（可能是没有 code 前缀的裸报错）', () => {
    assert.equal(isFileBusy(new Error("rename 'C:/x/pkg_tmp_1' -> 'C:/x/pkg'")), true)
  })

  it('版本不存在不算占用：这类才该走降级', () => {
    assert.equal(isFileBusy(new Error('ERR_PNPM_NO_MATCHING_VERSION No matching version found for foo@9.9.9')), false)
    assert.equal(isFileBusy(new Error('E404 404 Not Found - GET https://registry.npmjs.org/nope')), false)
  })

  it('网络错误、子目录不存在都不算占用', () => {
    assert.equal(isFileBusy(new Error('ETIMEDOUT fetch failed')), false)
    assert.equal(isFileBusy(new Error('ERR_PNPM_INVALID_PATH not a valid sub-directory')), false)
  })

  it('能从报错里挖出被占用的包名，给用户可行动的提示', () => {
    const real = new Error('[ERR_PNPM_EPERM] [importPackage C:/x/node_modules/@tt-a1i/archify-dsh] EPERM: nope')
    assert.match(busyPackageFrom(real), /archify-dsh$/)
  })

  it('挖不出包名时返回 null，而不是编一个出来', () => {
    assert.equal(busyPackageFrom(new Error('ERR_PNPM_EPERM something odd')), null)
    assert.equal(busyPackageFrom(null), null)
  })
})
