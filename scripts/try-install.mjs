/**
 * 用真实 profile 跑一遍 market-lens 的 install op 全链路。
 *
 * 目的：验证「点安装」这条路本身是通的，而不是绕过它调 pnpm。
 * 脚本复用 index.js 的假 ctx，直接调 op:'install'，把结果和日志一起打出来。
 *
 *   node scripts/try-install.mjs humanizer-ru            # 走 install op
 *   node scripts/try-install.mjs humanizer-ru --keys     # 只读状态，不装
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import childProcess from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)
const spec = process.argv[2] || 'humanizer-ru'
const keysOnly = process.argv.includes('--keys')

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

/**
 * 真实的 pluginManager 是从 DSH 运行时注入的；这里给一个等价的最小实现，
 * 走的是同一条路径：pnpm add + 落进 profile 的 dependencies。
 * 真正的宿主里 installBundle 还会顺手 reload bundle 列表，这里只做前两步。
 *
 * cwd 必须是 profile 目录：pnpm 的 store 位置取决于**调用时的工作目录**，
 * 而不是 --dir。/--dir 只改目标项目，不改 store 探测。
 * 从别的盘（比如 G:）调用会让 pnpm 退回 <盘>\.pnpm-store，并把那个绝对路径
 * 写进 node_modules/.modules.yaml；之后宿主从 profile 目录跑 pnpm 就会因为
 * 探测到的 store 与记录不符而报 ERR_PNPM_UNEXPECTED_STORE。
 */
function makeManager(profileDir) {
  const pnpm = process.env.PNPM_BIN || 'C:\\Users\\Shinelon\\AppData\\Roaming\\npm\\pnpm.cmd'
  return {
    async installBundle(target, options = {}) {
      const args = ['add', target]
      if (options.saveExact !== false) args.push('--save-exact')
      const started = Date.now()
      const run = childProcess.spawnSync(pnpm, args, { encoding: 'utf8', shell: true, timeout: 600000, cwd: profileDir })
      const output = (run.stdout || '') + (run.stderr || '')
      if (run.status !== 0) {
        const error = new Error('pnpm add 失败（exit ' + run.status + '）：\n' + output.slice(-3000))
        error.code = 'ERR_PNPM_ADD_FAILED'
        throw error
      }
      return {
        name: target,
        ms: Date.now() - started,
        output: output.slice(-2000),
        pendingBuilds: [],
      }
    },
    async listBundles() { return [] },
  }
}

/**
 * 核对 node_modules/.modules.yaml 里记录的 store 与 pnpm 现在会用的 store。
 *
 * 两者不一致时，任何写操作都会把错误值固化下来。所以读-写分离：
 * 这个函数只在安装前做一次干净的前置判断。
 */
function checkStoreAlignment(profileDir) {
  const modulesFile = path.join(profileDir, 'node_modules', '.modules.yaml')
  let recorded = null
  if (fs.existsSync(modulesFile)) {
    const text = fs.readFileSync(modulesFile, 'utf8')
    const match = text.match(/"storeDir": "([^"]+)"/)
    recorded = match ? match[1].replace(/\\\\/g, '\\') : null
  }
  const { spawnSync } = childProcess
  const pnpmBin = process.env.PNPM_BIN || 'C:\\Users\\Shinelon\\AppData\\Roaming\\npm\\pnpm.cmd'
  const run = spawnSync(pnpmBin, ['store', 'path'], { encoding: 'utf8', shell: true, cwd: profileDir, timeout: 120000 })
  const detected = ((run.stdout || '') + (run.stderr || '')).trim().split('\n').filter(Boolean).pop() || null
  const ok = Boolean(recorded && detected && path.resolve(recorded) === path.resolve(detected))
  return { ok, recorded, detected }
}

async function main() {
  const profileDir = process.env.DSH_PROFILE_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')

  // 装之前先核对 store：不一致就停手。
  // 一旦在 store 不一致的状态下写入，pnpm 会把错误的 storeDir 固化进
  // node_modules/.modules.yaml，之后宿主每次跑 pnpm 都会报
  // ERR_PNPM_UNEXPECTED_STORE —— 这个症状延迟出现，很难往「装插件」上想。
  // 修法见 scripts/fix-profile-store.mjs。
  const storeCheck = checkStoreAlignment(profileDir)
  if (!storeCheck.ok) {
    console.error('[ABORT] store 不一致，先修再装：')
    console.error('  记录: ' + (storeCheck.recorded || '(无)'))
    console.error('  探测: ' + (storeCheck.detected || '(无)'))
    console.error('  运行: node scripts/fix-profile-store.mjs --fix')
    process.exitCode = 1
    return
  }

  const handlers = new Map()
  const manager = makeManager(profileDir)
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
            register(entry) { handlers.set(entry.path, entry.handler); return () => handlers.delete(entry.path) },
          },
          effect(fn) { fn() },
        })
      }
    },
    effect(run) { run() },
  }
  process.env.DSH_PROFILE_DIR = profileDir
  process.env.DSH_PROFILE = process.env.DSH_PROFILE || 'desktop'

  const { apply } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
  apply(ctx)
  const call = async (payload) => {
    const { req, res, result } = fakeRequest(payload)
    await handlers.get('/api/market-lens')(req, res)
    return result
  }

  const out = []
  const line = (k, v) => out.push('  ' + k.padEnd(18) + v)

  const status = await call({ op: 'status' })
  line('manager 可用', String(Boolean(status.body?.install?.available)))
  line('当前 busy', String(status.body?.install?.busy))

  const before = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  line('装前依赖数', String(Object.keys(before.dependencies || {}).length))
  line('已含该包', String(Boolean((before.dependencies || {})[spec])))

  if (keysOnly) {
    console.log(out.join('\n'))
    return
  }

  // 走 op:'install'：目录里没有这一行，但自定义 spec 允许直接装
  const started = Date.now()
  const installed = await call({ op: 'install', spec })
  line('install 返回', String(installed.status) + ' in ' + (Date.now() - started) + 'ms')
  if (installed.body?.error) line('错误', String(installed.body.error).slice(0, 400))
  if (installed.body?.ok) {
    line('实际 spec', installed.body.spec || '—')
    line('降级自', installed.body.fellBackFrom || '（无降级）')
    line('安装结果', JSON.stringify(installed.body.result || {}))
  }

  const after = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  line('装后依赖数', String(Object.keys(after.dependencies || {}).length))
  line('写入的版本', after.dependencies?.[spec] || '（未写入）')

  let pkgJson = null
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', spec, 'package.json'), 'utf8'))
    line('落盘版本', pkgJson.version || '—')
    line('dsh.bundle.patch', String(pkgJson.dsh?.bundle?.patch || '（无）'))
  } catch {
    line('落盘检查', 'node_modules 里读不到 package.json')
  }

  const logs = await call({ op: 'logs', limit: 20 })
  line('日志条数', String((logs.body?.entries || []).length))
  line('日志标签', (logs.body?.entries || []).map((e) => e.tag).join(' · '))

  console.log(out.join('\n'))
}

main().catch((error) => {
  console.error('[FAIL]', error && error.message ? error.message : error)
  process.exitCode = 1
})
