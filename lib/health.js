/**
 * health.js —— 「装完之后它到底能不能被宿主加载」。
 *
 * market-lens 的 install 走的是官方 pluginManager，管理器只回报
 * `{ name, version, bundle, changed }`，安静失败时前端什么也看不到。真实踩过的三个坑：
 *
 *   1. 依赖写进了 dependencies，但没进 `dsh.profile.bundles`
 *      → 重启后插件不存在（install.not-mounted）
 *   2. 包自带的 `cordis.patch.yml` 里某条装载行的 name 解析不到
 *      → 宿主半身与浏览器半身一起不挂，dsh 不报错、没有设置页、没有面板
 *   3. peer 要求的 dsh 版本高于当前运行时
 *      → 启动预检直接拒绝加载这个 bundle
 *
 * 三层都查，结论合成一个 verdict。这里不重新实现 loader，而是照抄它的判据：
 *   · `dsh-app-boot` 的 `packageDirFromAnchor`   —— 只看目录里有没有 package.json
 *   · `unmetRequirements`                        —— engines.dsh 优先，否则只看 @deepseek-ai/dsh-* peer
 *   · `cordis-plugin-loader` 的 entry import      —— 相对路径按 patch 所在目录，裸名按 profile
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { evaluateManifest } from './compat.js'
import { inspectConfigNeeds } from './requires-config.js'
import { POSTINSTALL_VERDICTS, inspectInstalledPackageHooks } from './postinstall.js'

/** patch 里只关心这两类行：`- insert:` 下面成对出现的 id / name。 */
export function parsePatchRows(text) {
  const rows = []
  let current = null
  let inInsert = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (/^-?\s*insert\s*:\s*$/.test(trimmed) || /^-?\s*insert\s*:\s*\S/.test(trimmed)) {
      inInsert = true
      continue
    }
    // 顶层出现其他 key（remove / patch / 缩进回到 0 的 `- `）时结束 insert 段
    if (inInsert && /^\S/.test(line) && !/^\s*-\s/.test(line)) inInsert = false
    if (!inInsert) continue
    const idMatch = /^-\s*id\s*:\s*(.+)$/.exec(trimmed)
    if (idMatch) {
      current = { id: unquote(idMatch[1]), name: null }
      rows.push(current)
      continue
    }
    const nameMatch = /^name\s*:\s*(.+)$/.exec(trimmed)
    if (nameMatch && current && current.name === null) {
      current.name = unquote(nameMatch[1])
    }
  }
  return rows.filter((row) => row.name)
}

function unquote(value) {
  const text = String(value || '').trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * 单条装载行能不能被 loader import。
 * @returns {{name:string, id:string|null, kind:'path'|'bare'|'expression'|'empty', status:'ok'|'unresolved'|'unknown', detail:string, resolved?:string}}
 */
export function classifyRowName(name, { packageDir, profileDir, packageName } = {}) {
  const text = String(name || '').trim()
  if (!text) return { name: text, id: null, kind: 'empty', status: 'unknown', detail: 'name 缺失' }
  if (text.startsWith('!!js')) return { name: text, id: null, kind: 'expression', status: 'unknown', detail: 'name 是 !!js 表达式，静态判不了' }

  const isPath = text.startsWith('.') || text.startsWith('/') || text.startsWith('file:')
  if (isPath) {
    const target = path.isAbsolute(text) ? text : path.resolve(packageDir || profileDir, text)
    try {
      if (packageDir) {
        // 相对路径行：loader 从 patch 所在目录解析，只需要目标存在
        const exists = fs.existsSync(target)
        return { name: text, id: null, kind: 'path', status: exists ? 'ok' : 'unresolved', detail: exists ? '相对路径解析到 ' + target : '相对路径不存在：' + target, resolved: exists ? target : undefined }
      }
    } catch (error) {
      return { name: text, id: null, kind: 'path', status: 'unresolved', detail: String(error && error.message ? error.message : error) }
    }
  }

  // 裸名 / scoped 名：loader 用 Node 自己的查找链。这里用 patch 所属包作为锚点，
  // 因为自引用（`<自己包名>/subpath`）必须命中包自己的 exports，而不是上级 node_modules。
  const anchors = [packageDir, profileDir].filter(Boolean)
  let lastCode = null
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(path.join(anchor, 'package.json')).resolve(text)
      return { name: text, id: null, kind: 'bare', status: 'ok', detail: '解析到 ' + resolved, resolved }
    } catch (error) {
      lastCode = error && error.code ? String(error.code) : 'RESOLVE_FAILED'
    }
  }
  // 最后一道：目录里有没有 package.json（loader 的 packageDirFromAnchor 口径）。
  // exports 没导出 `.` 的包 require.resolve 会失败，但 loader 仍然挂得上 —— 这类不能算故障。
  // **但只对「裸包名」成立**：`pkg/sub` 这种子路径行是 patch 要挂的具体入口，
  // 子路径解析不到就是真的挂不上（`pkg@1.7` 删掉某个出口后最典型的失效形态）。
  const slash = text[0] === '@' ? text.indexOf('/', text.indexOf('/') + 1) : text.indexOf('/')
  const isSubpath = slash >= 0
  const bare = isSubpath ? text.slice(0, slash) : text
  if (!isSubpath) {
    for (const anchor of anchors) {
      try {
        const dir = createRequire(path.join(anchor, 'package.json')).resolve.paths(bare)
        for (const searchPath of dir || []) {
          const candidate = path.join(searchPath, bare, 'package.json')
          if (fs.existsSync(candidate)) {
            return { name: text, id: null, kind: 'bare', status: 'ok', detail: '包目录存在（exports 未导出根入口，但 loader 只看 package.json）：' + candidate, resolved: candidate }
          }
        }
      } catch {
        // 继续试下一个锚点
      }
    }
  } else {
    // 子路径：包目录在、但那个出口解析不到 → 明确报 unresolved，别用「包在」蒙混过去。
    for (const anchor of anchors) {
      try {
        const dir = createRequire(path.join(anchor, 'package.json')).resolve.paths(bare)
        for (const searchPath of dir || []) {
          const candidate = path.join(searchPath, bare, 'package.json')
          if (fs.existsSync(candidate)) {
            return { name: text, id: null, kind: 'bare', status: 'unresolved', detail: '包已安装但子路径出口解析不到：' + text + '（' + (lastCode || 'NOT_EXPORTED') + '）' }
          }
        }
      } catch {
        // 继续试下一个锚点
      }
    }
  }
  return { name: text, id: null, kind: 'bare', status: 'unresolved', detail: '解析不到（' + (packageName || bare) + '，' + (lastCode || 'NOT_FOUND') + '）' }
}

/** 读包的 patch 文件并逐行判定。patch 不存在时返回空集，不误报。 */
export function inspectPatchRows(packageDir, profileDir, packageName) {
  const patchPath = path.join(packageDir, 'cordis.patch.yml')
  if (!fs.existsSync(patchPath)) return { patchPath: null, exists: false, rows: [] }
  let text
  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch (error) {
    return { patchPath, exists: true, rows: [], error: String(error && error.message ? error.message : error) }
  }
  const rows = parsePatchRows(text).map((row) => ({ ...classifyRowName(row.name, { packageDir, profileDir, packageName }), id: row.id }))
  return { patchPath, exists: true, rows }
}

/**
 * 装完之后的整体体检。
 *
 * @param {object} input
 * @param {string} input.profileDir
 * @param {string|null} input.packageName
 * @param {string[]} [input.bundles] 已在 profile 里的 bundle 列表
 * @param {string|null} [input.runtimeVersion] 当前 dsh 运行时版本
 * @param {string|null} [input.spec]
 * @returns {{verdict:'ok'|'warn'|'bad'|'skipped', packageName:string|null, installed:boolean, unmounted:boolean, peers:object|null, rows:object[], client:object|null, patch:{exists:boolean, path:string|null}, detail:string|null}}
 */
export function inspectInstalledHealth({ profileDir, packageName, bundles, runtimeVersion, spec } = {}) {
  const empty = {
    verdict: 'skipped',
    packageName: packageName ?? null,
    installed: false,
    unmounted: false,
    peers: null,
    rows: [],
    client: null,
    patch: { exists: false, path: null },
    detail: packageName ? null : 'unresolved-package-name',
  }
  if (!packageName) return empty

  const list = Array.isArray(bundles) ? bundles.map((entry) => String(entry).toLowerCase()) : []
  const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  const manifestPath = path.join(packageDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    return { ...empty, installed: false, detail: 'node_modules 里没有这个包（' + manifestPath + '）' }
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ...empty, installed: true, verdict: 'bad', detail: 'package.json 读不出来：' + String(error && error.message ? error.message : error) }
  }

  const isBundle = Boolean(manifest?.dsh?.bundle)
  const unmounted = isBundle && !list.includes(packageName.toLowerCase())
  const patch = isBundle ? inspectPatchRows(packageDir, profileDir, packageName) : { patchPath: null, exists: false, rows: [] }
  const rows = patch.rows

  const peers = runtimeVersion ? evaluateManifest(manifest, runtimeVersion) : null
  const peersVeto = Boolean(peers && peers.status === 'bad')

  // 浏览器半身：dsh.client 声明的是「有客户端 bundle」，解析 `/client` 出口失败就说明
  // 面板没有半身可挂。这条不是致命，但必须说出来。
  let client = null
  if (manifest?.dsh?.client) {
    try {
      const resolved = createRequire(manifestPath).resolve(packageName + '/client')
      client = { declared: true, resolved, status: 'ok' }
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'RESOLVE_FAILED'
      // 客户端 bundle 常常是给浏览器构建用的 URL 出口，导出名各异；
      // 只在 exports 里连 client 段都没有时才算问题。
      const exportsMap = manifest && typeof manifest.exports === 'object' && manifest.exports ? manifest.exports : {}
      const hasClientKey = Object.keys(exportsMap).some((key) => key === './client' || key.startsWith('./client'))
      client = { declared: true, resolved: null, status: hasClientKey ? 'warn' : 'info', code, detail: hasClientKey ? '声明了 dsh.client 但 ./client 出口解析不到' : '没有 ./client 出口（客户端可能走别的入口）' }
    }
  }

  const unresolved = rows.filter((row) => row.status === 'unresolved')

  // ---- 第五层：配置条件 ----
  //
  // 前三层证明「装上了、能加载」，fiberPhase 证明「跑起来了」。
  // 但插件仍然可能**用不了**：它依赖一个外部服务，而那个地址来自 patch 里的
  // 默认值 —— 真机案例 @wxg-prc-cpg/dsh-weknora 就是这样：
  // 工具全注册成功（fiber active），但它连的 localhost:8080 上没有服务。
  //
  // 用户看到的是「显示已安装但没安装成功」。这不是安装问题，是配置缺失。
  const config = isBundle
    ? inspectConfigNeeds({ packageDir, env: process.env })
    : { required: false, blocking: false, entries: [], detail: null }

  // ---- 附加事实：安装钩子会不会改写 profile ----
  //
  // 这不是 verdict 的一部分：装了、能加载、能跑、配置齐，四层全绿也照样
  // 可能在安装时改写了 profile 配置（dsh-purge 就改了 cordis.patch.yml）。
  // 所以它作为独立字段带出去 —— 界面要能单独说这一句。
  //
  // 注意：这个判定读的是**已安装包**的 package.json。对"装之前先看一眼"
  // 的场景，调用方应当用 lib/postinstall.js 的 inspectPostinstall(manifest)。
  const hooks = inspectInstalledPackageHooks(packageDir)

  let verdict = 'ok'
  let detail = null
  if (unmounted) {
    verdict = 'warn'
    detail = '依赖已写入，但没有进 dsh.profile.bundles：重启后不会加载'
  }
  if (unresolved.length) {
    verdict = 'bad'
    detail = unresolved.length + ' 条装载行解析不到：' + unresolved.map((row) => row.name).join(', ') + '（宿主半身与浏览器半身会一起不挂）'
  }
  if (peersVeto) {
    verdict = 'bad'
    detail = (detail ? detail + '；' : '') + 'peer 与运行时 ' + runtimeVersion + ' 不兼容：' + String(peers.reason)
  }
  // 配置缺失单独一档：装了、能加载、甚至跑起来了，但缺外部条件。
  // 不能judged成 bad（那不是安装失败），但要明确说出"用不了"。
  if (config.blocking) {
    if (verdict === 'ok') verdict = 'needs-config'
    detail = (detail ? detail + '；' : '') + (config.detail || '需要配置才能使用')
  } else if (config.required && verdict === 'ok') {
    verdict = 'needs-config'
    detail = config.detail
  }

  return {
    verdict,
    packageName,
    installed: true,
    isBundle,
    mounted: isBundle ? !unmounted : null,
    unmounted,
    peers,
    rows,
    client,
    // 第五层的结论：required 表示"有配置项没满足"，blocking 表示"一定用不了"
    config,
    // 安装钩子：verdict 为 runs-build / writes-profile 时界面需单独提示。
    // 它不进 verdict —— 四层全绿的包也可能改了你的 profile。
    hooks: hooks.verdict === POSTINSTALL_VERDICTS.none ? null : hooks,
    patch: { exists: patch.exists, path: patch.patchPath },
    spec: spec ?? null,
    detail,
  }
}
