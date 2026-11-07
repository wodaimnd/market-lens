/**
 * store-guard.js —— 「pnpm store 位置不一致」这个坑。
 *
 * 现场事故（2026-11-07 23:52，next profile）：
 *
 *   [ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
 *   The dependencies at "...\profiles\next\node_modules" are currently linked
 *   from the store at "G:\AI PGRM\POJ\.diag\pnpm-store\v11".
 *   pnpm now wants to use the store at "C:\Users\Shinelon\AppData\Local\pnpm\store\v11".
 *
 * 于是**任何安装都失败**，而市场上的回执只能说"安装失败"——用户完全看不出
 * 这是 pnpm 的 store 记账对不上，跟插件本身无关。
 *
 * 为什么会发生：pnpm 的 store 位置**取决于调用时的工作目录**（不是 --dir）。
 * 从 G: 盘调用 pnpm 时，它无法把 G:\.pnpm-store 硬链接进 C: 盘的 profile，
 * 就退回 `G:\<某目录>\.pnpm-store`，并把这个绝对路径写进
 * `node_modules/.modules.yaml`。此后从 profile 目录调用 pnpm，探测到的是
 * AppData 那个 store，两者不符 → 每次写操作都报 ERR_PNPM_UNEXPECTED_STORE。
 *
 * 这个症状**延迟出现**：装的时候没事，下一次宿主调用 pnpm 才报。
 *
 * 判定只需要两个数：
 *   · .modules.yaml 里记录的 storeDir
 *   · 从 profile 目录探测到的 storeDir
 *
 * 不一致就是病，而且是可以精确说清的病 —— 所以这里只做判定与"该怎么修"，
 * 不改任何文件。改 storeDir 要重跑 pnpm install，那是用户的决定。
 */

import fs from 'node:fs'
import path from 'node:path'

export const STORE_VERDICTS = {
  ok: 'ok',
  mismatch: 'mismatch',
  unknown: 'unknown', // 读不到记录或探测不到：不猜
  notInstalled: 'not-installed', // 还没有 node_modules
}

/** 从 .modules.yaml 文本里抽 storeDir（YAML 里以 JSON 字符串形态落盘）。 */
export function recordedStoreOf(modulesText) {
  const text = String(modulesText || '')
  const match = /"storeDir":\s*"([^"]+)"/.exec(text)
  if (!match) return null
  // YAML 里 Windows 路径是双反斜杠转义
  return match[1].replace(/\\\\/g, '\\')
}

/** 路径比较必须先 resolve 并统一分隔符，否则 `C:/x` 与 `C:\x` 会假报不一致。 */
function samePath(left, right) {
  if (!left || !right) return false
  try {
    return path.resolve(left) === path.resolve(right)
  } catch {
    return false
  }
}

/**
 * 判定 store 是否对齐。
 *
 * @param {object} input
 * @param {string} input.profileDir
 * @param {string|null} input.detectedStore 从 profile 目录探测到的 store
 *   （调用方负责跑 `pnpm store path`；这里不 spawn 子进程，便于纯函数测试）
 * @returns {{
 *   verdict: 'ok'|'mismatch'|'unknown'|'not-installed',
 *   recorded: string|null,
 *   detected: string|null,
 *   modulesPath: string,
 *   detail: string|null,
 *   fix: string|null,
 * }}
 */
export function inspectStore({ profileDir, detectedStore } = {}) {
  const base = {
    verdict: STORE_VERDICTS.unknown,
    recorded: null,
    detected: typeof detectedStore === 'string' && detectedStore.trim() ? detectedStore.trim() : null,
    modulesPath: '',
    detail: null,
    fix: null,
  }
  if (!profileDir) {
    return { ...base, detail: '拿不到 profile 目录' }
  }

  const modulesPath = path.join(profileDir, 'node_modules', '.modules.yaml')
  base.modulesPath = modulesPath

  if (!fs.existsSync(modulesPath)) {
    // 还没装过任何东西：node_modules 都不在，谈不上 store 错位。
    // 这不是故障，只是"还没初始化"。
    return {
      ...base,
      verdict: STORE_VERDICTS.notInstalled,
      detail: 'node_modules/.modules.yaml 还不存在（这个 profile 还没用 pnpm 装过东西）',
    }
  }

  let text
  try {
    text = fs.readFileSync(modulesPath, 'utf8')
  } catch (error) {
    return {
      ...base,
      detail: '读不出 .modules.yaml：' + String(error && error.message ? error.message : error),
    }
  }

  const recorded = recordedStoreOf(text)
  base.recorded = recorded

  if (!recorded) {
    return { ...base, detail: '.modules.yaml 里没有 storeDir 记录，无法判断' }
  }
  if (!base.detected) {
    return { ...base, detail: '探测不到当前 pnpm 的 store 位置（pnpm store path 没输出）' }
  }

  if (samePath(recorded, base.detected)) {
    return { ...base, verdict: STORE_VERDICTS.ok, detail: null }
  }

  // 不一致：这正是 ERR_PNPM_UNEXPECTED_STORE 的来源
  return {
    ...base,
    verdict: STORE_VERDICTS.mismatch,
    detail: 'node_modules 是按 ' + recorded + ' 装的，但当前 pnpm 要用 ' + base.detected +
      ' —— 任何安装/卸载都会报 ERR_PNPM_UNEXPECTED_STORE。这不是插件的问题。',
    // 修法必须是"用同一个 store 重建 node_modules"，而不是改记录：
    // 改 .modules.yaml 只会让它骗过检查，实际硬链接仍然指向另一个 store。
    fix: '在 profile 目录里跑 pnpm install 重建 node_modules（cwd 必须是 ' + profileDir +
      '），或把 storeDir 固定进 pnpm-workspace.yaml 后再 install。不要手改 .modules.yaml —— ' +
      '它只是记账，硬链接实际指向的还是旧 store。',
  }
}

/**
 * 把一个 store 判定翻成"这次安装失败是不是它的锅"。
 *
 * 用途：install 失败在拿到 ERR_PNPM_UNEXPECTED_STORE 时，除了原样报错，
 * 还要把这条**必然性**说清楚 —— 用户重试一万次也一样。
 *
 * @param {string} detail pnpm 的报错文本
 * @returns {boolean}
 */
export function isStoreMismatchError(detail) {
  return /ERR_PNPM_UNEXPECTED_STORE|Unexpected store location/i.test(String(detail || ''))
}
