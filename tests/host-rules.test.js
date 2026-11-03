// 宿主端回归：评分规则可以被用户本地改，改完必须立刻在行上生效、且落盘。
//
// 现场症状：市场里的「评分」是写死的，用户觉得某个维度权重不对也没办法调。
// 这条测试钉住三件事：
//   1) 上传一份自定义规则，行上的 marketScore 立刻按新规则重算；
//   2) 规则文件写进 market-lens/scoring-rules.json，重启后读得到；
//   3) 不合法（未知指标 / 权重全 0 / 阈值不递减）的文件必须被拒，且给出可读原因，
//      而不是静默退回默认规则让用户以为改成功了。
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

test('自定义评分规则：校验 → 立即生效 → 落盘 → 可回退', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-rules-'))
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  const rows = [
    { key: 'pkg:alpha-pkg', name: 'alpha-pkg', title: 'Alpha', pkg: 'alpha-pkg', sources: ['1024store'], version: '1.0.0', score: 90, installers: 100, stars: 500, downloads: 900, updatedAt: new Date().toISOString(), heat: 10 },
    { key: 'pkg:beta-pkg', name: 'beta-pkg', title: 'Beta', pkg: 'beta-pkg', sources: ['1024store'], version: '2.0.0', installers: 100, updatedAt: new Date(Date.now() - 40 * 86400000).toISOString(), heat: 5 },
  ]
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({ version: 1, generatedAt: '2026-11-01T00:00:00.000Z', rows, meta: {} }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'

  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() { return undefined },
    inject(names, run) {
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
  assert.ok(handler, 'host 必须注册 /api/market-lens 路由')
  const call = async (payload) => {
    const { req, res, result } = jsonResponse(payload)
    await handler(req, res)
    return result
  }
  const rulesPath = path.join(cacheDir, 'scoring-rules.json')

  try {
    // 模版：新用户照着改的那份骨架，必须自带指标/归一化清单且能被自己吃下。
    const template = await call({ op: 'rules.template' })
    assert.equal(template.status, 200)
    assert.equal(template.body.template.format, 'market-lens/scoring-rules')
    assert.ok(template.body.template.metrics.length >= 10, '模版要列出全部可用指标')
    assert.match(JSON.stringify(template.body.template.norms), /quantile/)
    assert.match(template.body.template.readme, /指标/)

    // 起点：默认规则，且没有规则文件
    const initial = await call({ op: 'rules.get' })
    assert.equal(initial.status, 200)
    assert.equal(initial.body.summary.isDefault, true)
    assert.equal(initial.body.summary.source, 'default')

    // 自定义：只留「新鲜度」一个因子，权重 1 → 所有行的 marketScore 都应等于新鲜度分。
    const custom = {
      name: '只看新鲜度',
      labels: { excellent: 90, good: 70, fair: 30 },
      market: {
        factors: [{ key: 'fresh', metric: 'freshness', norm: 'freshness', weight: 1 }],
        fallback: [],
      },
    }
    const applied = await call({ op: 'rules.set', rules: custom })
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    assert.equal(applied.body.summary.isDefault, false)
    assert.equal(applied.body.summary.name, '只看新鲜度')
    assert.equal(applied.body.summary.source, 'file')
    assert.ok(fs.existsSync(rulesPath), '必须把规则写进 scoring-rules.json')

    // 落盘内容应是可再次导入的文档，而不是内存对象的原样转储
    const savedDoc = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
    assert.equal(savedDoc.format, 'market-lens/scoring-rules')
    assert.equal(savedDoc.rules.name, '只看新鲜度')
    assert.ok(savedDoc.updatedAt, '文档要带 updatedAt')

    // 立即生效：刚建的行（今天）新鲜度 100，40 天前的行按分档 70。
    // 判据取目录里真实的行，避免把「重算了但算错」也判成通过。
    const catalog = await call({ op: 'catalog' })
    assert.equal(catalog.status, 200)
    const alpha = catalog.body.rows.find((row) => row.pkg === 'alpha-pkg')
    const beta = catalog.body.rows.find((row) => row.pkg === 'beta-pkg')
    assert.equal(alpha.marketScore, 100, '今天的包按「只看新鲜度」应为满分')
    assert.equal(alpha.marketLabel, 'excellent')
    assert.equal(beta.marketScore, 70, '40 天前的包按分档应为 70')
    assert.equal(beta.marketLabel, 'good')
    assert.deepEqual(alpha.marketParts, [{ key: 'fresh', weight: 1, value: 100 }])

    // 不合法一律拒绝，且要说清哪里不对
    const badMetric = await call({ op: 'rules.set', rules: { market: { factors: [{ metric: 'nope', norm: 'raw', weight: 1 }] } } })
    assert.equal(badMetric.status, 400)
    assert.equal(badMetric.body.ok, false)
    assert.ok(badMetric.body.issues.length > 0)
    assert.match(badMetric.body.error, /规则文件不合法/)

    const badLabels = await call({ op: 'rules.set', rules: { labels: { excellent: 40, good: 60, fair: 80 }, market: { factors: [{ metric: 'users', norm: 'log', weight: 1 }] } } })
    assert.equal(badLabels.status, 400)

    const zeroWeight = await call({ op: 'rules.set', rules: { market: { factors: [{ metric: 'users', norm: 'log', weight: 0 }] } } })
    assert.equal(zeroWeight.status, 400)

    // 被拒绝之后规则不能被动过
    const stillCustom = await call({ op: 'rules.get' })
    assert.equal(stillCustom.body.summary.name, '只看新鲜度')

    // 导出 → 再导入，必须往返一致（用户改完发群里分享的那条路径）
    const exported = await call({ op: 'rules.export' })
    assert.equal(exported.status, 200)
    assert.equal(exported.body.document.rules.name, '只看新鲜度')
    assert.match(exported.body.filename, /^market-lens-scoring-rules-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)

    const roundTrip = await call({ op: 'rules.import', document: exported.body.document })
    assert.equal(roundTrip.status, 200)
    assert.equal(roundTrip.body.summary.name, '只看新鲜度')

    // 预设：内置的三种口径都能直接套上
    const presetList = (await call({ op: 'rules.get' })).body.summary.presets
    assert.ok(presetList.some((item) => item.id === 'newcomer'))
    const applied2 = await call({ op: 'rules.preset', id: 'newcomer' })
    assert.equal(applied2.status, 200, JSON.stringify(applied2.body))
    assert.equal(applied2.body.summary.source, 'preset')
    const missing = await call({ op: 'rules.preset', id: 'nope' })
    assert.equal(missing.status, 404)

    // 回退：删文件 + 回默认口径，文件不该留下来
    const reset = await call({ op: 'rules.reset' })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.summary.isDefault, true)
    assert.equal(fs.existsSync(rulesPath), false, '回默认要删掉自定义文件，避免两份口径长期并存')

    // 回退后分数回到内置口径：有 rating 的行 marketScore = 0.55*90 + 0.25*100 + 0.1*100 + 0.1*60
    const back = await call({ op: 'catalog' })
    const alpha2 = back.body.rows.find((row) => row.pkg === 'alpha-pkg')
    assert.equal(alpha2.marketScore, 91)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('规则文件坏掉时退回内置口径，并把原因带进 status', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-rules-broken-'))
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({
    version: 1,
    generatedAt: '2026-11-01T00:00:00.000Z',
    rows: [{ key: 'pkg:alpha-pkg', name: 'alpha-pkg', pkg: 'alpha-pkg', sources: ['1024store'], installers: 10, updatedAt: new Date().toISOString(), heat: 1 }],
    meta: {},
  }))
  // 用户手动编辑过、写坏了的规则文件
  fs.writeFileSync(path.join(cacheDir, 'scoring-rules.json'), '{ this is not json')

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'

  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() { return undefined },
    inject(names, run) {
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
    const status = await call({ op: 'status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.rules.isDefault, true, '坏文件必须退回内置口径，不能让整个面板打不开')
    assert.ok(status.body.rules.issue, '必须把「为什么退回」告诉用户')
    assert.equal(status.body.rules.source, 'default')

    // 退回之后仍然能正常算分
    const catalog = await call({ op: 'catalog' })
    assert.equal(catalog.status, 200)
    assert.equal(typeof catalog.body.rows[0].marketScore, 'number')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
