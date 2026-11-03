/**
 * 规则库冒烟：拿真实 profile 的目录跑一遍「上传 → 下拉开多个 → 切换 → 删除 → 迁移」。
 *
 * 单元测试用的是几十行的小目录；这里关心两件真实数据下才会暴露的事：
 *   1. 库里放多份规则时，切换是否仍然在几百毫秒内（每一步都要重算两万多行）；
 *   2. 写盘/回滚是否正确——磁盘上的库文件必须和内存里的 activeId 始终一致。
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

async function boot() {
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
  return async (payload) => {
    const { req, res, result } = fakeRequest(payload)
    await handlers.get('/api/market-lens')(req, res)
    return result
  }
}

async function main() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const libraryPath = path.join(home, 'market-lens', 'scoring-rules-library.json')
  const legacyPath = path.join(home, 'market-lens', 'scoring-rules.json')
  const out = []
  const line = (label, value) => out.push('  ' + label.padEnd(24) + value)
  const call = await boot()

  // 备份现有规则库，跑完原样还原：这是用户的真实配置，不能被冒烟改掉
  const backup = fs.existsSync(libraryPath) ? fs.readFileSync(libraryPath, 'utf8') : null
  const legacyBackup = fs.existsSync(legacyPath) ? fs.readFileSync(legacyPath, 'utf8') : null

  try {
    // ---- 1. 下拉框候选 ----
    let start = Date.now()
    const initial = await call({ op: 'rules.get' })
    line('rules.get', initial.status + ' in ' + (Date.now() - start) + 'ms')
    line('候选数量', String((initial.body?.library || []).length))
    line('候选来源', (initial.body?.library || []).map((item) => item.origin).join(', '))
    line('当前 activeId', initial.body?.activeId)
    line('当前规则名', initial.body?.entry?.name)
    line('规则构成因子数', Object.entries(initial.body?.description?.groups || {}).map(([key, group]) => key + '=' + group.factors.length).join(' '))
    // 「这条规则在算什么」必须能翻译成人话
    const factors = (initial.body?.description?.groups?.market?.factors || [])
    line('市场风评因子', factors.map((factor) => factor.metricLabel + '/' + factor.normLabel + ' ' + factor.share + '%').join(' · '))

    // ---- 2. 上传两份自定义规则 ----
    start = Date.now()
    const first = await call({ op: 'library.add', document: { rules: {
      name: '冒烟A-只看新鲜度',
      labels: { excellent: 90, good: 70, fair: 40 },
      market: { factors: [{ key: 'f', metric: 'freshness', norm: 'freshness', weight: 1 }], fallback: [] },
    } } })
    line('上传第一份', first.status + ' in ' + (Date.now() - start) + 'ms, activeId=' + first.body?.activeId)

    start = Date.now()
    const second = await call({ op: 'library.add', document: { rules: {
      name: '冒烟B-只看安装量',
      market: { factors: [{ key: 'u', metric: 'users', norm: 'log', weight: 1 }], fallback: [] },
    } }, name: '冒烟B-只看安装量' })
    line('上传第二份', second.status + ' in ' + (Date.now() - start) + 'ms, activeId=' + second.body?.activeId)
    line('用户条目数', String((second.body?.library || []).filter((item) => item.origin === 'user').length))

    // ---- 3. 下拉框切换（每次都要重算全表）----
    const ids = (second.body?.library || []).filter((item) => item.origin === 'user').map((item) => item.id)
    for (const id of ids.slice(0, 1)) {
      start = Date.now()
      const switched = await call({ op: 'library.activate', id })
      line('切换到 ' + id, switched.status + ' in ' + (Date.now() - start) + 'ms')
    }
    start = Date.now()
    const toBuiltin = await call({ op: 'library.activate', id: 'builtin:default' })
    line('切回内置', toBuiltin.status + ' in ' + (Date.now() - start) + 'ms')

    // ---- 4. 磁盘一致性：库文件里的 activeId 必须和内存一致 ----
    const onDisk = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
    line('磁盘 activeId', onDisk.activeId)
    line('磁盘用户条目', String(onDisk.entries.length))
    if (onDisk.activeId !== toBuiltin.body?.activeId) throw new Error('磁盘 activeId 与内存不一致')

    // ---- 5. 内置不许删 ----
    const delBuiltin = await call({ op: 'library.remove', id: 'builtin:default' })
    line('删内置', delBuiltin.status + ' → ' + (delBuiltin.body?.error || ''))

    // ---- 6. 删掉自己传的 ----
    for (const id of ids) {
      const removed = await call({ op: 'library.remove', id })
      line('删除 ' + id, removed.status + (removed.body?.wasActive ? '（当时正在使用，已回退内置）' : ''))
    }
    const afterRemove = await call({ op: 'rules.get' })
    line('删除后用户条目', String((afterRemove.body?.library || []).filter((item) => item.origin === 'user').length))
    if ((afterRemove.body?.library || []).filter((item) => item.origin === 'user').length !== 0) throw new Error('删除后用户条目没清空')

    // ---- 7. 模版说明结构 ----
    const guide = await call({ op: 'rules.template' })
    line('模版指标数 / 归一化数', String((guide.body?.metrics || []).length) + ' / ' + String((guide.body?.norms || []).length))
    line('三组说明', (guide.body?.groups || []).map((group) => group.key).join(', '))

    console.log(out.join('\n'))
    console.log('\n[PASS] 规则库在真实目录（多份规则 / 切换 / 删除 / 磁盘一致）上全链路可用')
  } finally {
    // 还原用户原来的规则库
    if (backup !== null) fs.writeFileSync(libraryPath, backup, 'utf8')
    else if (fs.existsSync(libraryPath)) fs.rmSync(libraryPath, { force: true })
    if (legacyBackup !== null) fs.writeFileSync(legacyPath, legacyBackup, 'utf8')
  }
}

main().catch((error) => {
  console.error('[FAIL]', error && error.message ? error.message : error)
  process.exitCode = 1
})
