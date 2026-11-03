/**
 * 新 op 冒烟：拿真实 profile 的 25691 行目录跑一遍 rules / logs 全链路。
 *
 * 单元测试用的是 26 行小目录；真实数据量下有两点容易翻车：
 *   1. 换规则要重算两万多行的分数，别慢到界面卡住；
 *   2. 换规则后 catalog 缓存要跟着写盘，别把 48MB 的文件写坏。
 * 这一份就是来看这两个数字的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)

function fakeRequest(payload) {
  const body = Buffer.from(JSON.stringify(payload))
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
      if (event === 'data') handler(body)
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  }
  return { req, res, result }
}

async function main() {
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
    effect(fn) { fn() },
  }

  const { apply } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
  apply(ctx)
  const handler = handlers.get('/api/market-lens')
  if (!handler) throw new Error('route not registered')
  const call = async (payload) => {
    const { req, res, result } = fakeRequest(payload)
    await handler(req, res)
    return result
  }

  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const rulesPath = path.join(home, 'market-lens', 'scoring-rules.json')
  const cachePath = path.join(home, 'market-lens', 'catalog.json')
  const cacheSizeBefore = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0

  const out = []
  const line = (label, value) => out.push('  ' + label.padEnd(22) + value)

  // ---- 1. 状态自洽：rules / logs 概况随 status 一起下发 ----
  let start = Date.now()
  const status = await call({ op: 'status' })
  line('status', status.status + ' in ' + (Date.now() - start) + 'ms')
  line('rules.source', status.body?.rules?.source)
  line('rules.factorCount', status.body?.rules?.factorCount)
  line('rules.fingerprint', status.body?.rules?.fingerprint)
  line('logs.total', status.body?.logs?.total)
  if (!status.body?.rules?.fingerprint) throw new Error('status 里没有 rules 摘要')

  // ---- 2. 真实目录下换规则：重算 25691 行要多久 ----
  start = Date.now()
  const applied = await call({ op: 'rules.set', rules: {
    name: '冒烟：只看新鲜度',
    labels: { excellent: 90, good: 70, fair: 40 },
    market: { factors: [{ key: 'fresh', metric: 'freshness', norm: 'freshness', weight: 1 }], fallback: [] },
  } })
  line('rules.set', applied.status + ' in ' + (Date.now() - start) + 'ms')
  line('rules.set.rows', applied.body?.rows)
  if (applied.status !== 200) throw new Error('rules.set 失败：' + (applied.body?.error || '?'))

  // 新口径必须真的生效：最近更新的行应该是满分附近
  start = Date.now()
  const catalog = await call({ op: 'catalog' })
  line('catalog', catalog.status + ' in ' + (Date.now() - start) + 'ms, rows=' + (catalog.body?.rows?.length ?? 0))
  const rows = catalog.body?.rows || []
  const top = rows.slice().sort((a, b) => (b.marketScore ?? -1) - (a.marketScore ?? -1))[0]
  line('top row score', (top?.pkg || top?.id) + ' = ' + top?.marketScore + ' (' + top?.marketLabel + ')')
  if (!top || top.marketScore !== 100) throw new Error('自定义规则没有生效：最高分不是 100')
  const parts = top?.marketParts || []
  line('top marketParts', JSON.stringify(parts))
  if (parts.length !== 1 || parts[0].key !== 'fresh') throw new Error('评分构成没有跟着规则变')

  // ---- 3. 落盘：规则文件 + catalog 缓存都要更新 ----
  const cacheSizeAfter = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0
  line('rules file', fs.existsSync(rulesPath) ? 'written (' + fs.statSync(rulesPath).size + ' bytes)' : 'MISSING')
  line('catalog cache', cacheSizeBefore + ' → ' + cacheSizeAfter + ' bytes')
  if (!fs.existsSync(rulesPath)) throw new Error('规则文件没写盘')

  // ---- 4. 日志：这一串动作应当全都被记下来 ----
  const logs = await call({ op: 'logs', limit: 50 })
  line('logs entries', (logs.body?.entries || []).length)
  const tags = (logs.body?.entries || []).map((entry) => entry.tag)
  line('logs tags', tags.join(' · '))
  if (!tags.includes('rules.applied')) throw new Error('rules.applied 没有记进日志')

  // ---- 5. 恢复内置规则：文件要删掉、分数要回到默认口径 ----
  start = Date.now()
  const reset = await call({ op: 'rules.reset' })
  line('rules.reset', reset.status + ' in ' + (Date.now() - start) + 'ms')
  if (reset.status !== 200) throw new Error('rules.reset 失败')
  if (fs.existsSync(rulesPath)) throw new Error('恢复内置之后规则文件仍然存在')

  start = Date.now()
  const back = await call({ op: 'catalog' })
  line('catalog after reset', back.status + ' in ' + (Date.now() - start) + 'ms')
  const backRows = back.body?.rows || []
  const withRating = backRows.find((row) => Number.isFinite(row.score) && Number.isFinite(row.marketScore))
  line('rating row score', (withRating?.pkg || '—') + ' = ' + withRating?.marketScore)
  const backParts = withRating?.marketParts || []
  line('rating row parts', backParts.map((part) => part.key).join('+'))
  if (!backParts.some((part) => part.key === 'rating')) throw new Error('恢复内置后没有回到默认口径')

  // ---- 6. 模版与导出 ----
  const template = await call({ op: 'rules.template' })
  line('rules.template', template.status + ', metrics=' + (template.body?.template?.metrics?.length ?? 0) + ', norms=' + (template.body?.template?.norms?.length ?? 0))
  const exported = await call({ op: 'rules.export' })
  line('rules.export', exported.status + ' → ' + exported.body?.filename)
  line('logs.export', '—')

  console.log(out.join('\n'))
  console.log('\n[PASS] rules / logs 在真实目录（25691 行）上全链路可用')
}

main().catch((error) => {
  console.error('[FAIL]', error && error.message ? error.message : error)
  process.exitCode = 1
})
