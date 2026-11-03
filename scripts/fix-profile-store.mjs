/**
 * 收尾：把 store 对齐 + 清掉我这次安装带来的两个多余依赖。
 *
 * 背景：
 *   1) 我用脚本从 G: 盘调用 pnpm 装插件，pnpm 把 store 落到了 C:\.pnpm-store，
 *      并把绝对路径写进了 profile 的 node_modules/.modules.yaml。此后宿主的
 *      pnpm（从 profile 目录跑）探测到 AppData\Local\pnpm\store，两者不符，
 *      用户就看到了 ERR_PNPM_UNEXPECTED_STORE。
 *   2) 同一次 pnpm install 还把 @cloudbase/dsh-plugin、@deepseek-ai/dsh-mcp-client
 *      写进了 dependencies（humanizer-ru 本身零依赖，这两个不是它带来的）。
 *
 * 这个脚本只做三件事，每一步都先备份、可回滚：
 *   --check   只报告当前状态
 *   --fix     对齐 storeDir 并移除多余依赖（默认会先备份）
 *   --restore 从备份恢复 package.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PNPM = process.env.PNPM_BIN || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'pnpm.cmd')
const PKG = path.join(PROFILE, 'package.json')
const LOCK = path.join(PROFILE, 'pnpm-lock.yaml')
const MODULES = path.join(PROFILE, 'node_modules', '.modules.yaml')

const mode = process.argv.includes('--fix') ? 'fix' : process.argv.includes('--restore') ? 'restore' : 'check'
// 这两项是那次 install 顺手写进来的，不是任何插件需要的
const STRAYS = ['@cloudbase/dsh-plugin', '@deepseek-ai/dsh-mcp-client']

function pnpm(args, opts = {}) {
  const run = spawnSync(PNPM, args, { encoding: 'utf8', cwd: PROFILE, shell: true, timeout: 600000, ...opts })
  return { code: run.status, text: (run.stdout || '') + (run.stderr || '') }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function detectedStore() {
  const run = pnpm(['store', 'path'])
  return run.text.trim().split('\n').filter(Boolean).pop() || ''
}

function recordedStore() {
  if (!fs.existsSync(MODULES)) return ''
  const text = fs.readFileSync(MODULES, 'utf8')
  const match = text.match(/"storeDir": "([^"]+)"/)
  return match ? match[1].replace(/\\\\/g, '\\') : ''
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function report() {
  const manifest = readJson(PKG)
  const recorded = recordedStore()
  const detected = detectedStore()
  const deps = Object.keys(manifest.dependencies || {})
  const strays = STRAYS.filter((name) => Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, name))
  const bundles = manifest.dsh?.profile?.bundles || []

  console.log('profile   :', PROFILE)
  console.log('记录 store:', recorded || '(无)')
  console.log('探测 store:', detected || '(无)')
  console.log('是否一致  :', recorded && detected && path.resolve(recorded) === path.resolve(detected) ? '是' : '否 ← 正是 UNEXPECTED_STORE 的来源')
  console.log('dependencies:', deps.length)
  console.log('bundles     :', bundles.length)
  console.log('多余依赖    :', strays.length ? strays.join(', ') : '（无）')
  return { manifest, recorded, detected, strays }
}

function backup(file) {
  const target = file + '.bak-mlfix-' + stamp()
  fs.copyFileSync(file, target)
  console.log('备份        :', path.basename(target))
  return target
}

function fix() {
  const state = report()

  // 1) store 对齐：让 pnpm 用 profile 自己探测到的那个 store。
  //    不写全局配置 —— 全局改会影响用户其它项目；只改 profile 的 pnpm-workspace.yaml。
  if (state.recorded && state.detected && path.resolve(state.recorded) !== path.resolve(state.detected)) {
    const workspace = path.join(PROFILE, 'pnpm-workspace.yaml')
    if (fs.existsSync(workspace)) {
      const before = fs.readFileSync(workspace, 'utf8')
      if (!/^storeDir\s*:/m.test(before)) {
        fs.copyFileSync(workspace, workspace + '.bak-mlfix-' + stamp())
        fs.appendFileSync(workspace, '\n# 固定 store 位置：避免从不同工作目录调用 pnpm 时探测到别的 store，\n# 与 node_modules/.modules.yaml 里记录的路径不符就会报 UNEXPECTED_STORE。\nstoreDir: ' + state.detected.replace(/\\/g, '/') + '\n', 'utf8')
        console.log('已固定 storeDir:', state.detected)
      } else {
        console.log('pnpm-workspace.yaml 里已经有 storeDir，跳过')
      }
    }
  }

  // 2) 移除多余依赖
  if (state.strays.length) {
    backup(PKG)
    if (fs.existsSync(LOCK)) backup(LOCK)
    const run = pnpm(['remove', ...state.strays])
    console.log('pnpm remove:', run.code === 0 ? '成功' : '失败')
    if (run.code !== 0) console.log(run.text.slice(-800))
  } else {
    console.log('没有多余依赖，跳过')
  }

  // 3) 重新同步（此时 store 已对齐，不会再报 UNEXPECTED_STORE）
  const sync = pnpm(['install'])
  console.log('pnpm install:', sync.code === 0 ? '成功' : '失败（exit ' + sync.code + '）')
  if (sync.code !== 0) console.log(sync.text.slice(-1200))
}

function restore() {
  const candidates = fs.readdirSync(PROFILE)
    .filter((name) => /^package\.json\.bak-mlfix-/.test(name))
    .sort()
    .reverse()
  if (!candidates.length) {
    console.log('没有找到 mlfix 备份，无法恢复')
    return
  }
  const latest = path.join(PROFILE, candidates[0])
  fs.copyFileSync(latest, PKG)
  console.log('已从备份恢复:', candidates[0])
  const sync = pnpm(['install'])
  console.log('pnpm install:', sync.code === 0 ? '成功' : '失败（exit ' + sync.code + '）')
}

if (mode === 'fix') fix()
else if (mode === 'restore') restore()
else report()
