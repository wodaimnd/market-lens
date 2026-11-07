/**
 * exempt.js —— 「明知不兼容，仍然安装」这条路。
 *
 * 背景：宿主 dsh-plugin-manager 在 pnpm 装完之后会做一次兼容性复核。
 * 检出 `incompatible-version` 就**整批回滚**，并在输出里说：
 *
 *   dsh: installation rejected: Plugin dsh-tidy-display@0.4.7 is incompatible
 *        with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.1.0-rc.2 || ..."}
 *   dsh: To accept this risk explicitly, grant the exact-version exemption
 *        for dsh-tidy-display@0.4.7 on dsh 0.2.2-rc.1 with `dsh plugin allow-version`
 *        or the plugin manager, then retry the installation or restart dsh.
 *
 * 也就是说：这条路**本来就有**，只是 market-lens 没有把它接到界面上，
 * 于是「仍然安装」这个按钮成了一个摆设 —— 点了还是同一个错误。
 *
 * 豁免落在 profile 的 `compatibility.json`，形状是精确版本 → DSH 版本列表：
 *
 *   { "dsh-tidy-display@0.4.7": ["0.2.2-rc.1"] }
 *
 * 三条硬约束（照抄宿主 setProfileVersionExemption 的校验）：
 *   1. key 必须是**精确**的 `package@version`（不接受范围 / 标签）
 *   2. 值必须是**当前**这个 DSH 的版本（批准别的版本号无效）
 *   3. 文件坏掉（不是合法 JSON / 结构不对）时**不许改写** ——
 *      改写了会把用户原有的内容冲掉。这种情况只能让人工修。
 *
 * 所以我们只做两件事：读、校验、原子写回；**不猜**。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 与宿主 PROFILE_COMPATIBILITY_FILENAME 一致。 */
export const COMPATIBILITY_FILE = 'compatibility.json'

/** 精确版本：主/次/补丁 + 可选预发布。范围、标签、workspace: 一律不接受。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const EXEMPT_RESULT = {
  ok: 'ok',
  invalidKey: 'invalid-key',
  staleRuntime: 'stale-runtime',
  unreadable: 'unreadable',
  alreadyGranted: 'already-granted',
  writeFailed: 'write-failed',
}

/**
 * 把 pkg + version 拼成宿主要的 key。
 * @returns {string|null} 合法则返回 `pkg@ver`，否则 null
 */
export function exemptionKey(pkg, version) {
  const name = typeof pkg === 'string' ? pkg.trim() : ''
  const ver = typeof version === 'string' ? version.trim() : ''
  if (!name || !ver) return null
  // npm 包名（含 scope）
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return null
  // 精确版本，不接受范围/标签
  if (!EXACT_VERSION.test(ver)) return null
  return name + '@' + ver
}

/**
 * 读 compatibility.json。
 *
 * 与宿主 readProfileCompatibility 同口径：文件不存在 = 空表且可写；
 * 读不了 / 不是 JSON / 结构不对 = **不可写**（rewritable: false），
 * 因为改写会丢掉用户原有内容。
 *
 * @param {string} profileDir
 * @returns {{exemptions: Record<string,string[]>, rewritable: boolean, warnings: string[]}}
 */
export function readCompatibility(profileDir) {
  const filename = path.join(profileDir, COMPATIBILITY_FILE)
  const empty = { exemptions: {}, rewritable: true, warnings: [] }
  let text
  try {
    text = fs.readFileSync(filename, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return empty
    return { exemptions: {}, rewritable: false, warnings: ['无法读取 ' + filename + '：' + String(error && error.message ? error.message : error)] }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { exemptions: {}, rewritable: false, warnings: [filename + ' 不是合法 JSON：' + String(error && error.message ? error.message : error)] }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { exemptions: {}, rewritable: false, warnings: [filename + ' 必须是「package@version → DSH 版本列表」的对象'] }
  }
  const exemptions = {}
  const warnings = []
  for (const [key, versions] of Object.entries(value)) {
    const separator = key.lastIndexOf('@')
    const nameOk = separator > 0 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(key.slice(0, separator))
    const versionOk = separator > 0 && EXACT_VERSION.test(key.slice(separator + 1))
    if (!nameOk || !versionOk) {
      warnings.push('忽略非法 key：' + JSON.stringify(key) + '（必须是精确的 package@version）')
      continue
    }
    if (!Array.isArray(versions)) {
      warnings.push('忽略 ' + key + '：值必须是 DSH 版本列表')
      continue
    }
    exemptions[key] = versions.filter((item) => typeof item === 'string' && EXACT_VERSION.test(item))
  }
  return { exemptions, rewritable: true, warnings }
}

/** 原子写：先写同目录临时文件再 rename，避免写到一半被读到。 */
function writeAtomic(filename, content) {
  const temporary = filename + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, filename)
}

/**
 * 授予一条精确版本豁免。
 *
 * @param {object} input
 * @param {string} input.profileDir
 * @param {string} input.pkg
 * @param {string} input.version 插件版本（精确）
 * @param {string} input.runtimeVersion 当前 DSH 版本
 * @param {boolean} [input.acceptRisk] 必须显式为 true —— 宿主也是这么要求的
 * @param {boolean} [input.dryRun]
 * @returns {{result: string, key: string|null, exemptions: Record<string,string[]>, warnings: string[], detail: string|null}}
 */
export function grantExemption({ profileDir, pkg, version, runtimeVersion, acceptRisk = false, dryRun = false } = {}) {
  const key = exemptionKey(pkg, version)
  const base = { key, exemptions: {}, warnings: [], detail: null }

  if (!key) {
    return { ...base, result: EXEMPT_RESULT.invalidKey, detail: '豁免要求精确的 package@version：不接受范围、标签或非精确版本' }
  }
  if (typeof runtimeVersion !== 'string' || !EXACT_VERSION.test(runtimeVersion.trim())) {
    return { ...base, result: EXEMPT_RESULT.staleRuntime, detail: '拿不到当前 DSH 的精确版本号，无法授予豁免' }
  }
  // 宿主拒绝「批准别的 DSH 版本」：批准 0.2.1 却在 0.2.2 上运行是无意义的。
  const runtime = runtimeVersion.trim()

  if (!acceptRisk) {
    return { ...base, result: EXEMPT_RESULT.invalidKey, detail: '需要用户显式确认风险（acceptRisk: true）' }
  }

  const current = readCompatibility(profileDir)
  if (!current.rewritable) {
    // 文件坏了就不能改：改写了会丢掉用户原有的内容
    return {
      ...base,
      result: EXEMPT_RESULT.unreadable,
      warnings: current.warnings,
      detail: COMPATIBILITY_FILE + ' 无法安全改写，请先手工修复：' + current.warnings.join('；'),
    }
  }

  const existing = Array.isArray(current.exemptions[key]) ? current.exemptions[key] : []
  if (existing.includes(runtime)) {
    return {
      ...base,
      result: EXEMPT_RESULT.alreadyGranted,
      exemptions: current.exemptions,
      warnings: current.warnings,
      detail: key + ' 在 ' + runtime + ' 上已经有豁免了',
    }
  }

  const next = {
    ...current.exemptions,
    [key]: [...new Set([...existing, runtime])],
  }

  if (!dryRun) {
    try {
      writeAtomic(path.join(profileDir, COMPATIBILITY_FILE), JSON.stringify(next, null, 2) + '\n')
    } catch (error) {
      return {
        ...base,
        result: EXEMPT_RESULT.writeFailed,
        exemptions: current.exemptions,
        warnings: current.warnings,
        detail: '写入 ' + COMPATIBILITY_FILE + ' 失败：' + String(error && error.message ? error.message : error),
      }
    }
  }

  return { ...base, result: EXEMPT_RESULT.ok, exemptions: next, warnings: current.warnings, detail: null }
}

/**
 * 撤销一条豁免（用户反悔，或装完之后想恢复"一律拦截"）。
 * @returns {{result: string, exemptions: Record<string,string[]>}}
 */
export function revokeExemption({ profileDir, pkg, version, runtimeVersion, dryRun = false } = {}) {
  const key = exemptionKey(pkg, version)
  if (!key) return { result: EXEMPT_RESULT.invalidKey, exemptions: {}, detail: '需要精确的 package@version' }

  const current = readCompatibility(profileDir)
  if (!current.rewritable) {
    return { result: EXEMPT_RESULT.unreadable, exemptions: {}, warnings: current.warnings, detail: COMPATIBILITY_FILE + ' 无法安全改写' }
  }

  const versions = Array.isArray(current.exemptions[key]) ? current.exemptions[key] : []
  if (!versions.length) {
    return { result: EXEMPT_RESULT.ok, exemptions: current.exemptions, detail: '本来就没有这条豁免' }
  }

  const next = { ...current.exemptions }
  const retained = typeof runtimeVersion === 'string' && runtimeVersion.trim()
    ? versions.filter((item) => item !== runtimeVersion.trim())
    : []
  if (retained.length) next[key] = retained
  else delete next[key]

  if (!dryRun) {
    try {
      writeAtomic(path.join(profileDir, COMPATIBILITY_FILE), JSON.stringify(next, null, 2) + '\n')
    } catch (error) {
      return { result: EXEMPT_RESULT.writeFailed, exemptions: current.exemptions, detail: String(error && error.message ? error.message : error) }
    }
  }
  return { result: EXEMPT_RESULT.ok, exemptions: next, detail: null }
}

/** 这条 key 在当前运行时上是否已有豁免。 */
export function hasExemption(profileDir, pkg, version, runtimeVersion) {
  const key = exemptionKey(pkg, version)
  if (!key) return false
  const current = readCompatibility(profileDir)
  const versions = current.exemptions[key]
  if (!Array.isArray(versions)) return false
  return versions.includes(String(runtimeVersion || '').trim())
}
