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
  const libraryPath = path.join(cacheDir, 'scoring-rules-library.json')

  try {
    // 模版：新用户照着改的那份骨架，必须自带指标/归一化清单且能被自己吃下。
    const template = await call({ op: 'rules.template' })
    assert.equal(template.status, 200)
    assert.equal(template.body.template.format, 'market-lens/scoring-rules')
    assert.ok(template.body.template.metrics.length >= 10, '模版要列出全部可用指标')
    assert.match(JSON.stringify(template.body.template.norms), /quantile/)
    assert.match(template.body.template.readme, /指标/)
    // 界面要用的结构化说明：三组分数各是干什么的
    assert.equal(template.body.groups.length, 3)
    assert.ok(template.body.groups.every((group) => group.label.zh && group.desc.zh))

    // 起点：默认启用内置规则，库里只有内置 + 预设条目
    const initial = await call({ op: 'rules.get' })
    assert.equal(initial.status, 200)
    assert.equal(initial.body.summary.isDefault, true)
    assert.equal(initial.body.activeId, 'builtin:default')
    assert.equal(initial.body.entry.origin, 'builtin')
    // 下拉框的候选：内置 + 3 个预设
    const initialLibrary = initial.body.library
    assert.ok(initialLibrary.length >= 4, '库里应有内置默认 + 内置预设')
    assert.deepEqual(
      initialLibrary.map((item) => item.origin).sort(),
      ['builtin', 'preset', 'preset', 'preset'].sort(),
      '初装时不应有用户条目',
    )
    // describeEntry 把因子翻成人话，界面直接渲染这张表
    assert.equal(initial.body.description.groups.market.factors[0].metricLabel, '市场评分')
    assert.ok(initial.body.description.groups.market.factors[0].share > 0, '归一化后的权重占比要算出来')

    // 上传自定义规则：只留「新鲜度」一个因子，权重 1
    const custom = {
      name: '只看新鲜度',
      labels: { excellent: 90, good: 70, fair: 30 },
      market: {
        factors: [{ key: 'fresh', metric: 'freshness', norm: 'freshness', weight: 1 }],
        fallback: [],
      },
    }
    const applied = await call({ op: 'library.add', rules: custom })
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    assert.equal(applied.body.summary.isDefault, false)
    assert.equal(applied.body.summary.name, '只看新鲜度')
    // 新语义：上传 = 往库里存一条并启用，不再覆盖单文件
    const newId = applied.body.activeId
    assert.notEqual(newId, 'builtin:default', '上传后应切到这条新规则')
    assert.ok(applied.body.library.some((item) => item.id === newId && item.origin === 'user'), '新条目要在库里且标为 user')
    assert.ok(fs.existsSync(libraryPath), '规则库要写进 scoring-rules-library.json')
    assert.equal(fs.existsSync(rulesPath), false, '新语义下不再有单文件 scoring-rules.json')

    // 落盘内容是库结构，只保存用户条目（内置/预设随包发布，不重复存）
    const savedLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
    assert.equal(savedLibrary.activeId, newId)
    assert.equal(savedLibrary.entries.length, 1, '磁盘上只该存用户自己的那一份')
    assert.equal(savedLibrary.entries[0].name, '只看新鲜度')
    assert.ok(savedLibrary.entries[0].rules.market.factors.length === 1)

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
    const badMetric = await call({ op: 'library.add', rules: { market: { factors: [{ metric: 'nope', norm: 'raw', weight: 1 }] } } })
    assert.equal(badMetric.status, 400)
    assert.equal(badMetric.body.ok, false)
    assert.ok(badMetric.body.issues.length > 0)
    assert.match(badMetric.body.error, /规则文件不合法/)

    const badLabels = await call({ op: 'library.add', rules: { labels: { excellent: 40, good: 60, fair: 80 }, market: { factors: [{ metric: 'users', norm: 'log', weight: 1 }] } } })
    assert.equal(badLabels.status, 400)

    const zeroWeight = await call({ op: 'library.add', rules: { market: { factors: [{ metric: 'users', norm: 'log', weight: 0 }] } } })
    assert.equal(zeroWeight.status, 400)

    // 被拒绝之后规则库不能被动过（既没有多条目，也没有换当前）
    const stillCustom = await call({ op: 'rules.get' })
    assert.equal(stillCustom.body.summary.name, '只看新鲜度')
    assert.equal(stillCustom.body.activeId, newId)
    assert.equal(stillCustom.body.library.filter((item) => item.origin === 'user').length, 1)

    // 同名上传：自动加序号，下拉框里不会出现两条一模一样的名字
    const dup = await call({ op: 'library.add', rules: custom })
    assert.equal(dup.status, 200)
    assert.equal(dup.body.renamed, true)
    assert.equal(dup.body.entry.name, '只看新鲜度 (2)')
    const names = dup.body.library.filter((item) => item.origin === 'user').map((item) => item.name)
    assert.deepEqual(names.sort(), ['只看新鲜度', '只看新鲜度 (2)'])

    // 下拉框切换：选回内置默认，用户自己那条还在库里
    const switched = await call({ op: 'library.activate', id: 'builtin:default' })
    assert.equal(switched.status, 200, JSON.stringify(switched.body))
    assert.equal(switched.body.summary.isDefault, true)
    assert.ok(switched.body.library.filter((item) => item.origin === 'user').length >= 2, '切回内置不该丢掉用户条目')

    // 切回内置后分数回到默认口径：0.55*90 + 0.25*100 + 0.1*100 + 0.1*60 = 91
    const backToDefault = await call({ op: 'catalog' })
    const alphaDefault = backToDefault.body.rows.find((row) => row.pkg === 'alpha-pkg')
    assert.equal(alphaDefault.marketScore, 91)

    // 再把用户那条切回来，分数又变成新鲜度口径
    const reactivated = await call({ op: 'library.activate', id: newId })
    assert.equal(reactivated.status, 200)
    const backToCustom = await call({ op: 'catalog' })
    assert.equal(backToCustom.body.rows.find((row) => row.pkg === 'alpha-pkg').marketScore, 100)

    // 切到不存在的 id：404，且当前规则不变
    const ghost = await call({ op: 'library.activate', id: 'no-such-rule' })
    assert.equal(ghost.status, 404)
    assert.notEqual(ghost.body.activeId, 'no-such-rule')
    assert.ok(ghost.body.library.length >= 4)

    // 导出 → 再导入，必须往返一致（用户改完发群里分享的那条路径）
    const exported = await call({ op: 'rules.export' })
    assert.equal(exported.status, 200)
    assert.equal(exported.body.document.rules.name, '只看新鲜度')
    assert.match(exported.body.filename, /^market-lens-scoring-rules-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)

    const roundTrip = await call({ op: 'rules.import', document: exported.body.document })
    assert.equal(roundTrip.status, 200)
    // 再导入会变成第三条（同名会自动加序号）
    assert.ok(roundTrip.body.summary.name.startsWith('只看新鲜度'))
    assert.ok(roundTrip.body.library.filter((item) => item.origin === 'user').length >= 3)

    // 预设也走同一条路径：它本来就是库里的条目
    const presetApplied = await call({ op: 'rules.preset', id: 'newcomer' })
    assert.equal(presetApplied.status, 200, JSON.stringify(presetApplied.body))
    assert.equal(presetApplied.body.activeId, 'preset:newcomer')
    assert.equal(presetApplied.body.summary.origin, 'preset')
    const missingPreset = await call({ op: 'rules.preset', id: 'nope' })
    assert.equal(missingPreset.status, 404)

    // 内置不能删（只能切走）
    const deleteBuiltin = await call({ op: 'library.remove', id: 'builtin:default' })
    assert.equal(deleteBuiltin.status, 400)
    assert.match(deleteBuiltin.body.error, /内置规则不能删除/)

    // 删掉正在用的那份：回退到内置默认，不留悬空 activeId
    const activeNow = (await call({ op: 'rules.get' })).body.activeId
    if (activeNow.startsWith('preset:') || activeNow.startsWith('builtin:')) {
      await call({ op: 'library.activate', id: newId })
    }
    const growth = await call({ op: 'library.remove', id: (await call({ op: 'rules.get' })).body.activeId })
    assert.equal(growth.status, 200, JSON.stringify(growth.body))
    assert.equal(growth.body.wasActive, true)
    assert.equal(growth.body.activeId, 'builtin:default', '删掉当前规则要回退到内置')
    const afterRemove = await call({ op: 'catalog' })
    assert.equal(afterRemove.body.rows.find((row) => row.pkg === 'alpha-pkg').marketScore, 91, '删除当前规则后应回到内置口径')

    // 删完之后磁盘上也不该再有那一条
    const finalLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
    assert.ok(!finalLibrary.entries.some((item) => item.id === growth.body.removed.id), '删掉的条目不能留在磁盘上')

    // 「恢复内置」= 把 activeId 指回内置，用户条目仍然保留可随时选回
    const reset = await call({ op: 'rules.reset' })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.summary.isDefault, true)
    assert.ok(reset.body.library.filter((item) => item.origin === 'user').length >= 1, '恢复内置不等于删掉用户的规则')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('规则库坏掉/半坏时只丢坏条目，仍在内置口径上正常算分', async () => {
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
  // 用户手动编辑过、写坏了的规则库：一条合法 + 一条指标写错 + 当前指向不存在的那条
  fs.writeFileSync(path.join(cacheDir, 'scoring-rules-library.json'), JSON.stringify({
    version: 1,
    activeId: 'missing-entry',
    entries: [
      { id: 'good-one', name: '合法的一条', savedAt: '2026-11-02T00:00:00.000Z', rules: { market: { factors: [{ key: 'u', metric: 'users', norm: 'log', weight: 1 }], fallback: [] } } },
      { id: 'bad-one', name: '写坏的一条', rules: { market: { factors: [{ metric: 'magic', norm: 'log', weight: 1 }] } } },
    ],
  }))

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
    // activeId 指向不存在的那条 → 回退内置，且必须说清楚
    assert.equal(status.body.rules.isDefault, true, '悬空的 activeId 必须退回内置口径，不能让面板打不开')
    assert.ok(status.body.rules.issue, '必须把「为什么退回」告诉用户')
    assert.match(status.body.rules.issue, /不存在/)
    // 合法的那条要保住，坏的被隔离——这是「半坏」与「全坏」的关键区别：
    // 全丢会让用户以为自己传的规则全没了。
    const library = await call({ op: 'rules.get' })
    const userIds = library.body.library.filter((item) => item.origin === 'user').map((item) => item.id)
    assert.deepEqual(userIds, ['good-one'], '合法条目要保留，坏条目要被隔离')
    assert.equal(library.body.library.filter((item) => item.origin === 'user').length, 1)

    // 合法那条还能被选中并生效
    const activated = await call({ op: 'library.activate', id: 'good-one' })
    assert.equal(activated.status, 200, JSON.stringify(activated.body))

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

test('旧版单文件规则在升级后自动迁进规则库，并设为当前', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-rules-migrate-'))
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'catalog.json'), JSON.stringify({
    version: 1,
    generatedAt: '2026-11-01T00:00:00.000Z',
    rows: [{ key: 'pkg:alpha-pkg', name: 'alpha-pkg', pkg: 'alpha-pkg', sources: ['1024store'], score: 90, installers: 100, updatedAt: new Date().toISOString(), heat: 1 }],
    meta: {},
  }))
  // 0.6.0 的单文件口径：升级前留下的
  fs.writeFileSync(path.join(cacheDir, 'scoring-rules.json'), JSON.stringify({
    format: 'market-lens/scoring-rules',
    version: 1,
    updatedAt: '2026-11-02T00:00:00.000Z',
    rules: {
      name: '我的老口径',
      labels: { excellent: 90, good: 70, fair: 40 },
      market: { factors: [{ key: 'fresh', metric: 'freshness', norm: 'freshness', weight: 1 }], fallback: [] },
    },
  }))

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
    // 迁移后当前规则就是老那份，名字保住、来源变成用户条目
    assert.equal(status.body.rules.name, '我的老口径', '迁移要保住用户原来的规则名')
    assert.equal(status.body.rules.origin, 'user')
    assert.equal(status.body.rules.isDefault, false)
    assert.equal(status.body.rules.migratedFrom, 'scoring-rules.json')

    // 老文件迁完即删：留着只会让「到底哪份在生效」变成一个谜
    assert.equal(fs.existsSync(path.join(cacheDir, 'scoring-rules.json')), false, '迁移成功后要删掉旧单文件')
    assert.ok(fs.existsSync(path.join(cacheDir, 'scoring-rules-library.json')), '迁移结果要落到规则库文件')

    // 分数按迁移过来的口径算：今天更新的行新鲜度 100
    const catalog = await call({ op: 'catalog' })
    assert.equal(catalog.body.rows[0].marketScore, 100)

    // 再启动一次不该重复迁移（幂等）
    handlers.clear()
    const fresh = await import('../index.js?migrate-repeat=' + Math.random())
    fresh.apply(ctx)
    const again = async (payload) => {
      const { req, res, result } = jsonResponse(payload)
      await handlers.get('/api/market-lens')(req, res)
      return result
    }
    const second = await again({ op: 'status' })
    assert.equal(second.body.rules.name, '我的老口径')
    assert.equal(second.body.rules.origin, 'user')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
