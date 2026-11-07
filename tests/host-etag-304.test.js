// 304 的端到端回归：条件请求最容易写错的地方就是这里。
//
// 真实风险：`notModified` 的源 items 是 null（服务端没发 body）。
// 如果直接 flatMap(sourceRows)，那个源的条目会整体消失，
// 于是 diffRows 把它判成「下架」—— 用户看到「一大批插件被下架了」，
// 而其实只是"没变化"。这条测试专门钉住这个分支。
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
 * 共享的网络闸门栈。
 *
 * 三个测试串行跑，每个都要「只放行自己的本地服务器」。如果各自
 * `const realFetch = globalThis.fetch` 再在 finally 里写回，
 * 第一个测试恢复时会把第二个测试刚装上的拦截器一起掀掉 ——
 * 表现就是第二个测试的本地请求被当成外网打死。
 *
 * 所以闸门装在一个栈上：每个测试 push 自己那条，restore 时只摘自己那条。
 */
const fetchGates = []
let baseFetch = null

function applyFetchGate() {
  globalThis.fetch = (input, init) => {
    const target = typeof input === 'string' ? input : (input && input.url) || ''
    // 栈顶优先：后装的闸门先决定放行/拒绝
    for (let index = fetchGates.length - 1; index >= 0; index--) {
      const gate = fetchGates[index]
      if (gate(target)) return baseFetch(input, init)
    }
    return Promise.reject(new Error('offline in test: ' + target))
  }
}

function installFetchGate(gate) {
  if (baseFetch === null) baseFetch = globalThis.fetch
  fetchGates.push(gate)
  applyFetchGate()
  return () => {
    const index = fetchGates.indexOf(gate)
    if (index >= 0) fetchGates.splice(index, 1)
    if (fetchGates.length === 0) {
      // 全部摘完才把原始 fetch 装回去
      globalThis.fetch = baseFetch
      baseFetch = null
    } else {
      applyFetchGate()
    }
  }
}

/**
 * 只装一个 format1 源，让 fetchFormat1Index 走真实的 fetchJson。
 * 用本地 http 服务代替外部站点 —— 这样能精确控制 ETag 与 304。
 *
 * 关键：Sync 过程中 Host 会顺带做 npm 兼容性检查与更新检查，那些请求
 * 会打到外网（在 CI / 离线环境里会长时间挂住）。所以这里把 fetch 包一层：
 * 只放行指向本机测试服务器的请求，其余立即失败。
 * 这条约束不改变被测逻辑 —— 本测试关心的只是 304 分支。
 */
async function makeHarness({ etag }) {
  const http = await import('node:http')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-etag-'))
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))

  const plugins = [
    { name: 'alpha-plugin', title: 'Alpha', description: 'a', repo: 'https://github.com/a/alpha' },
    { name: 'beta-plugin', title: 'Beta', description: 'b', repo: 'https://github.com/a/beta' },
  ]
  const body = JSON.stringify({ format: 1, plugins })

  let hits = 0
  let notModifiedHits = 0
  const server = http.createServer((req, res) => {
    hits++
    const incoming = req.headers['if-none-match']
    if (incoming === etag) {
      // 服务端支持条件请求：回 304，不发 body
      notModifiedHits++
      res.writeHead(304, { etag })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', etag })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = 'http://127.0.0.1:' + port + '/index.json'

  // 封掉外网：只放行本机测试服务器。同步过程中的 npm 兼容性 / 更新检查会立刻失败，
  // 那不影响被测的 304 分支，却能让测试跑完而不是挂住。
  //
  // 注意不能各自保存 realFetch 再各自恢复：三个测试串行跑时，
  // 前一个的 restore() 会把后一个的拦截器一起掀掉（存的是"上一层"，
  // 恢复时却写回"最初那一层"）。所以拦截器挂在**一个共享栈**上，
  // restore 只摘掉自己那一条。
  const gate = (target) => target.includes('127.0.0.1:' + port)
  const removeGate = installFetchGate(gate)

  const cacheDir = path.join(home, 'market-lens')
  fs.mkdirSync(cacheDir, { recursive: true })
  return {
    home,
    profile,
    server,
    url,
    cacheDir,
    stats: () => ({ hits, notModifiedHits }),
    restore: () => { removeGate() },
  }
}

async function boot(harness, tag) {
  process.env.DSH_HOME = harness.home
  process.env.DSH_PROFILE_DIR = harness.profile
  process.env.DSH_PROFILE = 'desktop'
  process.env.NODE_ENV = 'test'
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() { return undefined },
    inject(names, run) {
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

/** 最近一次添加得到的自定义源 id（sources.add 由服务端生成 id，测试不能预设）。 */
let customSourceId = null

/**
 * 触发一次同步并**等到它真的跑完**。
 *
 * op:'sync' 是「启动即返回」：它把 statusBody() 立刻回给前端，真正的抓取
 * 在后台 job() 里跑。所以点了 sync 之后必须轮询 status.sync.running，
 * 否则读到的还是上一轮结果 —— 这一点在测试里特别容易写错。
 *
 * @param {(payload: object) => Promise<object>} call
 * @returns {Promise<object>} 同步完成时的 status
 */
async function syncAndWait(call) {
  const started = await call({ op: 'sync', force: true })
  assert.equal(started.status, 200, 'sync 应受理：' + JSON.stringify(started.body).slice(0, 300))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = await call({ op: 'status' })
    const sync = status.body?.sync || {}
    // 同步完成的两个标志：running 落下，且 phase 到了终态。
    // 只看 running 会在 job 还没置位的那一瞬间误判成"已完成"。
    if (sync.running === false && (sync.phase === 'done' || sync.finishedAt)) return status
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('sync 没有在 30s 内完成')
}

async function seedSource(harness, url) {
  // 不能走 sources.add：它要求 HTTPS（validateHttpsUrl），而测试用本地 http 服务
  // 才能精确控制 ETag / 304。所以直接把源写进 source-config.json，
  // 让 Host 启动时按配置加载 —— 这条路径与用户在界面上加源落到同一个文件。
  //
  // 必须**在 boot 之前**调用：Host 是在 apply() 时读这份配置的。
  // 这里先钉住 DSH_HOME，保证 cacheDirectory() 与下面写的路径是同一个。
  process.env.DSH_HOME = harness.home
  process.env.DSH_PROFILE_DIR = harness.profile
  process.env.DSH_PROFILE = 'desktop'
  const configPath = path.join(harness.home, 'market-lens', 'source-config.json')
  let config = {}
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const sources = Array.isArray(config.sources) ? config.sources : []
  // 内建源必须**显式写出来并禁用**。
  // 只靠「不写」是不行的：loadSourceConfig 会拿 BUILT_IN_SOURCES 补齐缺失条目，
  // 而内建源的默认状态是 enabled: true —— 于是 sync 会去请求真实外部站点
  // （既慢又不可复现，还会让 catalogStaleness 判定里混进这些"从没确认过"的源）。
  const builtinSources = [
    { id: '1024store', kind: '1024store', name: '1024Store', enabled: false, builtin: true },
    { id: 'dshfind', kind: 'dshfind', name: 'dshfind', enabled: false, builtin: true },
    { id: 'dshso', kind: 'dshso', name: 'dsh.so', enabled: false, builtin: true },
    { id: 'dshmarketplace', kind: 'dshmarketplace', name: 'dshmarketplace', enabled: false, builtin: true },
  ]
  const builtinIds = new Set(builtinSources.map((source) => source.id))
  const kept = sources.filter((source) => !builtinIds.has(source.id))
  // 源站是 http 本地服务；getBuiltinSource 里没有它，所以这里必须自己声明完整字段。
  const custom = {
    id: 'etag-src',
    kind: 'format1',
    name: 'ETag 源',
    short: 'ETag',
    color: '#8a94a6',
    enabled: true,
    builtin: false,
    url,
    addedAt: new Date().toISOString(),
  }
  config.sources = [...builtinSources, ...kept.filter((source) => source.id !== 'etag-src'), custom]
  config.version = config.version ?? 1
  config.refreshIntervalMinutes = config.refreshIntervalMinutes ?? 0
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  customSourceId = 'etag-src'
  return config
}

test('304 不重写快照，也不把条目判成下架', async () => {
  const harness = await makeHarness({ etag: '"v1"' })
  try {
    await seedSource(harness, harness.url)
    const call = await boot(harness, 'etag-1')

    // 第一次同步：200，拿到两个条目
    const first = await syncAndWait(call)
    assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 400))
    let catalog = await call({ op: 'catalog' })
    const keysAfterFirst = catalog.body.rows.map((row) => row.id).sort()
    assert.equal(keysAfterFirst.length, 2, '第一次应有 2 条：' + keysAfterFirst.join(','))

    const statusFirst = await call({ op: 'status' })
    const health = statusFirst.body.sourceHealth.find((entry) => entry.id === customSourceId)
    assert.ok(health.hasConditionalMarker, '200 之后应记下 ETag 标记')

    // 第二次同步：带 If-None-Match → 304
    const second = await syncAndWait(call)
    assert.equal(second.status, 200)
    assert.equal(harness.stats().notModifiedHits, 1, '服务端应真的回过一次 304')

    catalog = await call({ op: 'catalog' })
    const keysAfterSecond = catalog.body.rows.map((row) => row.id).sort()
    assert.deepEqual(keysAfterSecond, keysAfterFirst, '304 之后条目必须原样保留')
    // 关键断言：一条都不能被判成下架
    const delisted = catalog.body.rows.filter((row) => row.delisted)
    assert.equal(delisted.length, 0, '304 不能产生下架行：' + delisted.map((row) => row.id).join(','))
    const diff = catalog.body.meta?.diff
    assert.equal(diff?.removed, 0, '304 之后 removed 必须是 0，实际 ' + JSON.stringify(diff))

    // lastConfirmedAt 必须被推进（304 就是「确认最新」）
    const statusSecond = await call({ op: 'status' })
    const healthSecond = statusSecond.body.sourceHealth.find((entry) => entry.id === customSourceId)
    assert.ok(healthSecond.lastConfirmedAt, '304 应推进 lastConfirmedAt')
    assert.equal(healthSecond.stale, false, '刚确认过的源不该 stale')
    assert.equal(healthSecond.rows, 2, '304 之后该源的条目数不能写成 0')
  } finally {
    // 取消后台更新检查：sync 完成后 Host 会 void startUpdateCheck()，
    // 不取消的话计时器会一直挂着，node --test 不退出。
    try { await call({ op: 'cancel' }) } catch {}
    await new Promise((resolve) => harness.server.close(resolve))
    fs.rmSync(harness.home, { recursive: true, force: true })
  }
})

test('源站失败时绝不推进 lastConfirmedAt，并标 stale', async () => {
  const harness = await makeHarness({ etag: '"v1"' })
  try {
    await seedSource(harness, harness.url)
    const call = await boot(harness, 'etag-2')
    await syncAndWait(call)

    const good = await call({ op: 'status' })
    const confirmed = good.body.sourceHealth.find((entry) => entry.id === customSourceId).lastConfirmedAt
    assert.ok(confirmed)

    // 现在把服务端打死，再同步一次
    // 取消后台更新检查：sync 完成后 Host 会 void startUpdateCheck()，
    // 不取消的话计时器会一直挂着，node --test 不退出。
    try { await call({ op: 'cancel' }) } catch {}
    await new Promise((resolve) => harness.server.close(resolve))
    const failed = await syncAndWait(call)
    // 同步本身可以失败（所有源都没数据），但源的记录不能变"新"
    assert.ok(failed.status >= 200)

    const after = await call({ op: 'status' })
    const entry = after.body.sourceHealth.find((candidate) => candidate.id === customSourceId)
    assert.equal(entry.lastConfirmedAt, confirmed, '失败不能让目录看起来更新')
    assert.ok(entry.failureCount > 0, '要记下失败次数')
    assert.equal(entry.stale, true, '失败后应标 stale')
    assert.equal(entry.staleReason, 'last-sync-failed', '原因要说是「上次同步失败」，不是「旧」')
  } finally {
    // 取消后台更新检查：sync 完成后 Host 会 void startUpdateCheck()，
    // 不取消的话计时器会一直挂着，node --test 不退出。
    try { await call({ op: 'cancel' }) } catch {}
    await new Promise((resolve) => harness.server.close(() => resolve()))
    fs.rmSync(harness.home, { recursive: true, force: true })
  }
})

test('status 带 cacheStaleness 聚合结论', async () => {
  const harness = await makeHarness({ etag: '"v1"' })
  try {
    await seedSource(harness, harness.url)
    const call = await boot(harness, 'etag-3')
    await syncAndWait(call)
    const status = await call({ op: 'status' })
    assert.ok(status.body.cacheStaleness, 'status 要带 cacheStaleness')
    assert.equal(status.body.cacheStaleness.stale, false, '刚同步完不该 stale')
    assert.ok(status.body.cacheStaleness.earliestConfirmedAt, '要给最早确认时间')
  } finally {
    // 取消后台更新检查：sync 完成后 Host 会 void startUpdateCheck()，
    // 不取消的话计时器会一直挂着，node --test 不退出。
    try { await call({ op: 'cancel' }) } catch {}
    await new Promise((resolve) => harness.server.close(resolve))
    fs.rmSync(harness.home, { recursive: true, force: true })
  }
})
