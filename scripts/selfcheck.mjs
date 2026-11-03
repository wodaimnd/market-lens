#!/usr/bin/env node
/**
 * 面板打不开时的命令行自检。
 *
 * 面板里的「自检」按钮要在面板能渲染时才点得到；这一份不需要 DSH 启动，
 * 直接把 Host 半边挂到一个假 ctx 上跑 `op: 'selfcheck'`，把结果打到 stdout。
 *
 *   node scripts/selfcheck.mjs            # 读当前 profile（$DSH_PROFILE_DIR 或 $DSH_HOME）
 *   node scripts/selfcheck.mjs --json     # 只输出 JSON，方便贴给别人
 *
 * 退出码：0 = 结构正常；1 = 有能让面板失效的问题（路由没注册、profile 读不到）。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const wantJson = process.argv.includes('--json')

// --profile next  →  直接钉住 DSH_PROFILE_DIR（宿主环境预设了它，光设 DSH_PROFILE 会被盖掉）
const profileArg = (() => {
  const index = process.argv.indexOf('--profile')
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((item) => item.startsWith('--profile='))
  return inline ? inline.slice('--profile='.length) : null
})()
if (profileArg) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  process.env.DSH_PROFILE = profileArg
  process.env.DSH_PROFILE_DIR = path.join(home, 'profiles', profileArg)
}

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
  const problems = []
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
          effect(fn) { fn() },
        })
      }
      // pluginManager 故意不注入：自检要能报告「没有官方管理器」这一层
    },
    effect(fn) { fn() },
  }

  const { pathToFileURL } = await import('node:url')
  const { apply } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
  apply(ctx)

  const handler = handlers.get('/api/market-lens')
  if (!handler) {
    problems.push('没有注册 /api/market-lens 路由：Host 半边没起来，面板必然打不开')
    const report = { ok: false, problems }
    console.log(wantJson ? JSON.stringify(report, null, 2) : '自检失败：' + problems[0])
    process.exitCode = 1
    return
  }

  const { req, res, result } = fakeRequest({ op: 'selfcheck' })
  await handler(req, res)

  if (result.status !== 200 || !result.body || result.body.ok !== true) {
    problems.push('selfcheck 返回 ' + result.status + '：' + (result.body?.error || '没有内容'))
  }
  const report = result.body || {}
  if (report.profile && !report.profile.dir) problems.push('读不到 profile 目录（DSH_PROFILE_DIR / DSH_HOME 都没设？）')
  if (report.cache && report.cache.rows === 0) problems.push('目录缓存是空的：还没有同步过，面板会显示空表（不是崩溃）')

  if (wantJson) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems, selfcheck: report }, null, 2))
    process.exitCode = problems.length === 0 ? 0 : 1
    return
  }

  const line = (label, value) => console.log(label.padEnd(14, ' ') + value)
  line('插件版本', report.pluginVersion || '(未知)')
  line('路由', report.route || '(无)')
  line('运行时', report.runtime?.runtimeVersion || '(未知)')
  line('profile', (report.profile?.name || '?') + ' → ' + (report.profile?.dir || '?'))
  line('目录缓存', report.cache?.exists ? report.cache.rows + ' 行 @ ' + report.cache.generatedAt : '还没有缓存')
  line('安装能力', report.install?.available ? '有 pluginManager' : '没有 pluginManager（只能读目录）')
  line('已装插件', report.installed?.count ?? '?')
  line('更新检查', (report.updates?.status?.source || 'idle') + '，跳过本地包 ' + (report.updates?.skippedLocal ?? 0) + ' 个')
  line('启用来源', (report.sources?.enabled || []).join(', ') || '(无)')
  if (problems.length) {
    console.log('\n发现的问题：')
    for (const item of problems) console.log('  - ' + item)
    process.exitCode = 1
  } else {
    console.log('\n没有发现结构性问题。面板打不开时优先看渲染端错误：')
    console.log('  日志 C:\\Users\\<你>\\.dsh\\logs\\desktop-next.log 里搜 "slot entry crashed"')
  }
}

main().catch((error) => {
  console.error('自检脚本自己崩了：', error)
  process.exitCode = 1
})
