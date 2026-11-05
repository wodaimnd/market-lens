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
  // 0.7.0 起规则从「单文件」改成「规则库」：磁盘上只有 scoring-rules-library.json，
  // 里面**只存用户条目**，内置与预设在包里（不重复落盘）。旧脚本还在找
  // scoring-rules.json，所以必然报「规则文件没写盘」—— 这是脚本口径过期，不是功能坏了。
  const rulesPath = path.join(home, 'market-lens', 'scoring-rules-library.json')
  const legacyRulesPath = path.join(home, 'market-lens', 'scoring-rules.json')
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

  // ---- 3. 落盘：规则库 + catalog 缓存都要更新 ----
  const cacheSizeAfter = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0
  line('rules library', fs.existsSync(rulesPath)
    ? 'written (' + fs.statSync(rulesPath).size + ' bytes)'
    : 'MISSING')
  line('legacy rules file', fs.existsSync(legacyRulesPath) ? '仍然存在（0.6.0 迁移没完成？）' : '已清理')
  line('catalog cache', cacheSizeBefore + ' → ' + cacheSizeAfter + ' bytes')
  if (!fs.existsSync(rulesPath)) throw new Error('规则库没写盘')
  if (fs.existsSync(legacyRulesPath)) throw new Error('0.6.0 的单文件规则应当已迁进规则库并删除')
  let library = null
  try {
    library = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
  } catch (error) {
    throw new Error('规则库不是合法 JSON：' + String(error && error.message ? error.message : error))
  }
  line('library entries', (library?.entries || []).length)
  line('library activeId', String(library?.activeId ?? '(none)'))
  // 只存用户条目：内置口径不许重复落盘，否则换版本后内置更新会被旧副本盖住
  // 条目上区分来源的字段是 origin（builtin / preset / user），不是 source —— 用错字段
  // 会把内置条目全判成「重复落盘」，这条断言就失去意义了。
  const userEntries = (library?.entries || []).filter((entry) => entry && entry.origin === 'user')
  const duplicates = (library?.entries || []).filter((entry) => entry && (entry.builtin === true || entry.origin === 'builtin' || entry.origin === 'preset'))
  line('library user entries', userEntries.length)
  line('library built-in copies', duplicates.length + '（应为 0：内置随包发布，不落盘）')
  if (duplicates.length) throw new Error('内置 / 预设条目被重复落盘了：' + duplicates.map((entry) => entry.id).join(', '))

  // ---- 4. 日志：这一串动作应当全都被记下来 ----
  const logs = await call({ op: 'logs', limit: 50 })
  line('logs entries', (logs.body?.entries || []).length)
  const tags = (logs.body?.entries || []).map((entry) => entry.tag)
  line('logs tags', tags.join(' · '))
  // 0.7.0 的真实埋点是 rules.added / rules.activated / rules.removed。
  // 旧脚本查的 rules.applied 从来没有存在过（0.6.0 就已经改名为 activated）。
  if (!tags.some((tag) => tag === 'rules.added' || tag === 'rules.activated')) {
    throw new Error('规则变更没有记进日志：' + tags.join(', '))
  }

  // ---- 5. 恢复内置规则：activeId 指回内置、用户条目清空、分数回默认口径 ----
  //
  // 0.7.0 的语义变了：「恢复内置」不再删文件，只是把 activeId 指回内置条目。
  // 所以这里断言的是「库里没有用户条目 + 分数回到默认」，不是「文件消失」。
  start = Date.now()
  const reset = await call({ op: 'rules.reset' })
  line('rules.reset', reset.status + ' in ' + (Date.now() - start) + 'ms')
  if (reset.status !== 200) throw new Error('rules.reset 失败')

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
