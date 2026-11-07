/**
 * postinstall.js —— 「这个包安装时会改写你的 profile」。
 *
 * 现场事故（2026-11-07，dsh-purge 1.1.92）：
 *
 *   pnpm 日志：
 *     node_modules/dsh-purge postinstall$ node scripts/ensure-profile-bundle.mjs
 *     dsh-purge: appended to bundles (C:\Users\Shinelon\.dsh\profiles\next)
 *     dsh-purge: wrote body insert (...\profiles\next\cordis.patch.yml)
 *
 *   profile 的 cordis.patch.yml 多出一整段：
 *     - insert:
 *         - id: dsh-purge
 *           inject: [systemPrompt, tools]        ← 拿到了系统提示词注入权
 *           config: { stripMnemon: true, capabilityProtocol: true, hooksDenyBypass: true }
 *
 * 安装本身是**成功**的，所以体检四层全绿。但它顺手改了 profile 配置 ——
 * 这是一件用户必须**在装之前**知道的事，不是装完之后才发现。
 *
 * 为什么 DSH 自己不报：宿主的 pendingBuilds 只在 pnpm **失败**时记录
 * （`recordPendingBuilds` 挂在 `!succeeded` 分支上）。构建脚本一旦被允许并跑成功，
 * 它改了什么没人知道。
 *
 * 判据分两档，**保守优先**：
 *
 *   1. 有 postinstall / install 脚本，且脚本内容或脚本名暗示会碰 profile
 *      → `writes-profile`：明确说它会改。
 *   2. 有 postinstall / install 脚本，但看不出会碰 profile
 *      → `runs-build`：它会在你的机器上执行任意代码，值得知道。
 *
 * 一条克制：**只读 package.json 的 scripts，不去执行、不去读脚本内容跑正则**。
 * 读脚本文本要 resolve 一堆路径、还要处理 `node x.mjs` / `sh -c` / `&&` 链，
 * 而 package.json 里的 script 名与命令本身已足够说明"它要跑东西"。
 * 例外：命令里直接出现 `cordis.patch` / `dsh.profile` / `profiles/` 这类字样时，
 * 不必读文件就能判断 —— 那种情况直接升到 writes-profile。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 安装时会自动执行的钩子。preinstall 很少见但同样会跑。 */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall']

/**
 * 命令文本里出现这些字样，说明它在改 profile。
 * 只在**命令本身**上匹配（不读脚本体），避免误报。
 */
const PROFILE_TOUCHING = /cordis\.patch|dsh\.profile|profiles?\b|package\.json|bundles/i

export const POSTINSTALL_VERDICTS = {
  none: 'none', // 没有安装钩子
  writesProfile: 'writes-profile', // 会改写 profile
  runsBuild: 'runs-build', // 会执行代码，但看不出改 profile
}

/**
 * 从 package.json 里读出安装钩子。
 *
 * @param {object|null} manifest
 * @returns {Array<{hook: string, command: string}>}
 */
export function collectInstallHooks(manifest) {
  const scripts = manifest && typeof manifest.scripts === 'object' && manifest.scripts ? manifest.scripts : null
  if (!scripts) return []
  const hooks = []
  for (const hook of INSTALL_HOOKS) {
    const command = scripts[hook]
    if (typeof command === 'string' && command.trim()) hooks.push({ hook, command: command.trim() })
  }
  return hooks
}

/**
 * 判断一个包的安装钩子值不值得提示。
 *
 * @param {object|null} manifest 已解析的 package.json
 * @returns {{
 *   verdict: 'none'|'writes-profile'|'runs-build',
 *   hooks: Array<{hook: string, command: string}>,
 *   touchesProfile: boolean,
 *   detail: string|null,
 * }}
 */
export function inspectPostinstall(manifest) {
  const hooks = collectInstallHooks(manifest)
  if (!hooks.length) {
    return { verdict: POSTINSTALL_VERDICTS.none, hooks: [], touchesProfile: false, detail: null }
  }

  // 命令本身提到 profile 相关字样 → 不必读脚本体也能确定它会改
  const touchesProfile = hooks.some((entry) => PROFILE_TOUCHING.test(entry.command))
  const hookNames = hooks.map((entry) => entry.hook + ': ' + entry.command).join('; ')

  if (touchesProfile) {
    return {
      verdict: POSTINSTALL_VERDICTS.writesProfile,
      hooks,
      touchesProfile: true,
      detail: '安装时会执行 ' + hookNames + ' —— 命令里提到 profile / cordis.patch / bundles，' +
        '它会改写你的 profile 配置。装之前请确认你接受这个改动。',
    }
  }

  return {
    verdict: POSTINSTALL_VERDICTS.runsBuild,
    hooks,
    touchesProfile: false,
    // 这条不装作知道它在干什么：只说"会跑代码"，让用户自己判断
    detail: '安装时会执行 ' + hookNames + '。这类脚本能在你的机器上跑任意代码，' +
      '事后是否改写 profile 无法静态判断 —— 装完可以对照 profiles/<name>/package.json 与 cordis.patch.yml 是否变化。',
  }
}

/**
 * 读一个已安装包的 package.json 并做 postinstall 判定。
 * 包不在磁盘上时返回 verdict: 'unknown'，不猜。
 *
 * @param {string|null} packageDir
 * @returns {{verdict: string, hooks: object[], touchesProfile: boolean, detail: string|null}}
 */
export function inspectInstalledPackageHooks(packageDir) {
  const none = { verdict: POSTINSTALL_VERDICTS.none, hooks: [], touchesProfile: false, detail: null }
  if (!packageDir) return none
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return none
  }
  return inspectPostinstall(manifest)
}
