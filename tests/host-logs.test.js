// 宿主端回归：安装失败必须留下可排查的日志，「点安装没反应」不能只有一句 toast。
//
// 现场症状：用户点安装，界面弹一条 8 秒就消失的提示，内容还是被截短的
// pnpm 报错；想再看一眼到底试了哪个 spec、有没有降级，全都没了。
// 这条测试钉住日志链路：失败 → 有条目 → 能按条件筛 → 能导出成文本 → 能清空。
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

test('安装失败写进日志，日志可筛、可导出、可清空', async () => {
  const savedEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-logs-'))
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

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_PROFILE = 'desktop'

  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // 故意不给 pluginManager：这正是「点安装不成功」最常见的一种现场
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
    const before = await call({ op: 'logs' })
    assert.equal(before.status, 200)
    assert.ok(Array.isArray(before.body.entries))
    assert.equal(typeof before.body.status.total, 'number')

    // 1) 装一个目录里没有的行，且不带 spec → 解析失败，必须留痕
    const noTarget = await call({ op: 'install', key: 'pkg:not-in-catalog' })
    assert.equal(noTarget.status, 404)

    // 2) 装一个正常的包，但没有官方插件管理器 → 503 + 错误日志
    const attempt = await call({ op: 'install', key: 'pkg:alpha-pkg' })
    assert.equal(attempt.status, 503)
    assert.match(attempt.body.error, /插件管理器/)

    const logs = await call({ op: 'logs', limit: 50 })
    assert.equal(logs.status, 200)
    const tags = logs.body.entries.map((entry) => entry.tag)
    assert.ok(tags.includes('install.request'), '每次安装请求都要有一条入口记录')
    assert.ok(tags.includes('install.unresolved'), '解析不到目标要留痕')
    assert.ok(tags.includes('install.no-manager'), '缺少插件管理器要留痕')

    const failed = logs.body.entries.find((entry) => entry.tag === 'install.no-manager')
    assert.equal(failed.level, 'error')
    assert.equal(failed.spec, 'alpha-pkg', '日志要带上这次到底想装什么')
    assert.ok(failed.at, '日志要有时间戳')
    assert.ok(Number.isFinite(failed.seq), '日志要有单调序号，客户端增量拉取靠它')

    // 3) 按 level 与 tag 过滤：日志页的筛选项就靠这两个
    const onlyError = await call({ op: 'logs', level: 'error' })
    assert.ok(onlyError.body.entries.length >= 1)
    assert.ok(onlyError.body.entries.every((entry) => entry.level === 'error'))

    const byTag = await call({ op: 'logs', tag: 'install.unresolved' })
    assert.equal(byTag.body.entries.length, 1)
    assert.equal(byTag.body.entries[0].tag, 'install.unresolved')

    // 4) 增量拉取：since 之后只回新条目
    const newest = logs.body.entries[logs.body.entries.length - 1].seq
    await call({ op: 'install', key: 'pkg:alpha-pkg' })
    const delta = await call({ op: 'logs', since: newest })
    assert.ok(delta.body.entries.length >= 1)
    assert.ok(delta.body.entries.every((entry) => entry.seq > newest))

    // 5) 导出成可粘贴的文本
    const exported = await call({ op: 'logs.export' })
    assert.equal(exported.status, 200)
    assert.match(exported.body.filename, /^market-lens-logs-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/)
    assert.match(exported.body.text, /\[ERROR\] install\.no-manager/)
    assert.ok(exported.body.text.includes('alpha-pkg'))

    // 6) 清空：计数归零，但序号继续涨（否则客户端的 since 会永远拉不到新日志）
    const cleared = await call({ op: 'logs.clear' })
    assert.equal(cleared.status, 200)
    assert.ok(cleared.body.removed >= 1)
    assert.equal(cleared.body.status.total, 1, '清空后只应留下「清空动作」本身这一条')
    assert.ok(cleared.body.status.seq > newest)
    const after = await call({ op: 'logs' })
    assert.equal(after.body.entries.length, 1)
    assert.equal(after.body.entries[0].tag, 'logs.cleared')

    // 7) status 里带日志概况，客户端不用为了显示角标额外请求一次
    const status = await call({ op: 'status' })
    assert.equal(status.status, 200)
    assert.equal(typeof status.body.logs.total, 'number')
    assert.equal(typeof status.body.logs.counts.error, 'number')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
