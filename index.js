/**
 * Host half of the DSH plugin market radar.
 *
 * Aggregates every enabled marketplace/index source, deduplicates plugins across
 * them, checks DSH runtime compatibility from npm metadata, and persists source
 * choices plus a refresh schedule. Nothing from a catalog is executed.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CompatService } from './lib/compat.js'
import {
  CATALOG_DSHFIND_ENDPOINT,
  CATALOG_DSHSO_ENDPOINT,
  buildCatalog,
  fetch1024Catalog,
  fetchDshmarketplaceCatalog,
  fetchFormat1Index,
  fetchStandardCatalog,
  normalize1024,
  normalizeDshmarketplace,
  normalizeFormat1,
  normalizeStandardItem,
} from './lib/catalog.js'
import {
  REFRESH_OPTIONS,
  DSHBASE_REASON,
  createCustomSource,
  enabledSources,
  exportSourceConfig,
  importSourceConfig,
  loadSourceConfig,
  publicSourceConfig,
  saveSourceConfig,
} from './lib/source-config.js'
import { compareVersions, isRegistryCandidate, UpdateService } from './lib/updates.js'
import { diffRows } from './lib/sync-diff.js'
import { trustOf } from './lib/security.js'
import {
  cacheDirectory,
  getInstalledPackages,
  getRuntimeInfo,
  invalidateInstalledCache,
  profileDirectory,
  readJson,
  writeJsonAtomic,
} from './lib/runtime.js'
import { fetchJson, pickText } from './lib/util.js'
import { OpLog } from './lib/op-log.js'
import {
  BUILT_IN_PRESETS,
  BUILT_IN_RULES,
  MarketRulesError,
  RULES_FILE,
  normalizeRules,
  rulesDocument,
  rulesTemplate,
  prepareMetrics,
  scoreGroup,
  scoreLabelFromRules,
  validateRules,
} from './lib/rules.js'

const ROUTE = '/api/market-lens'
const MAX_BODY = 1024 * 1024
const CACHE_VERSION = 1
const CACHE_FILE = 'catalog.json'
const COMPAT_FILE = 'compat.json'
const UPDATES_FILE = 'updates.json'
const SOURCES_FILE = 'sources.json'
const MIN_SCHEDULE_DELAY_MS = 20_000
// 标准来源 manifest 只认这一版：只判 typeof 会把字段语义已变的版本放进来
const STANDARD_MANIFEST_VERSION = '1.0.0'
// 单次同步的总时长上限（10 分钟）：某个来源永不返回时不能把整次同步挂死
const SYNC_TIMEOUT_MS = 10 * 60 * 1000
const SYNC_TIMEOUT_CODE = 'SYNC_TIMEOUT'
const SYNC_TIMEOUT_MESSAGE = '同步超过 ' + Math.round(SYNC_TIMEOUT_MS / 60_000) + ' 分钟总时长上限'

// 导出配置时带上插件版本号：团队共享的 JSON 至少要能看出是哪一代面板导出的
const PLUGIN_VERSION = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
})()

/**
 * 插件自身的 GitHub 身份：从 package.json 的 repository / bugs / license 取值。
 * 客户端设置页据此渲染仓库链接、报告问题入口与许可证，不硬编码在 UI 里
 * （改名或换仓库时只改 package.json 一处）。
 */
const REPO_INFO = (() => {
  const fallback = { owner: null, name: null, url: null, issues: null, version: PLUGIN_VERSION, license: null }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  } catch {
    return fallback
  }
  const rawUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const match = typeof rawUrl === 'string'
    ? /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[/#?])/.exec(rawUrl)
    : null
  const issues = typeof manifest.bugs === 'string'
    ? manifest.bugs
    : (manifest.bugs?.url ?? null)
  return {
    owner: match ? match[1] : null,
    name: match ? match[2] : null,
    url: match ? 'https://github.com/' + match[1] + '/' + match[2] : null,
    issues: typeof issues === 'string' ? issues : null,
    version: PLUGIN_VERSION,
    license: typeof manifest.license === 'string' ? manifest.license : null,
  }
})()

const message = (error) => {
  const code = error && error.code ? String(error.code) + ': ' : ''
  const text = error && error.message ? error.message : String(error)
  return code + text
}

// 实际收到的 manifestVersion 可能是数字、缺失或对象：统一转成可读文本再拼进错误信息
const versionText = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))

// 同时只允许一个安装任务：pnpm 会改同一个 profile 的 manifest 与 lockfile，
// 并发安装互相覆盖，这里用 spec 记录谁在装，也用于给前端回显。
let installingKey = null

/**
 * 从 `dsh plugin ... add <spec>` 安装命令里提取可安装目标。
 * 接受 npm 包名、github:owner/repo、github:owner/repo#path:sub/dir
 * 和 GitHub 根仓库 URL；带 shell 元字符或绝对路径的目标拒绝。
 */
export function installSpecFromCommand(command) {
  const text = String(command || '').trim()
  if (!text || text.length > 500) return null
  const match = /^\s*dsh\s+plugin\b[^\r\n]*?\badd\s+(.+?)\s*$/i.exec(text)
  if (!match) return null
  const raw = match[1].trim().replace(/^['"]|['"]$/g, '')
  if (!raw || /\s|[;&|`$<>]/.test(raw)) return null
  // pnpm 的 GitHub 子目录写法：github:owner/repo#path:packages/foo
  const pathSpec = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#path:([a-z0-9._@+\/-]+)$/i.exec(raw)
  if (pathSpec) {
    const subdir = pathSpec[3].replace(/^\/+|\/+$/g, '')
    if (!subdir || subdir.includes('..')) return null
    return 'github:' + pathSpec[1] + '/' + pathSpec[2] + '#path:' + subdir
  }
  if (/^github:[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw)) return raw
  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(raw)
  if (github) return 'github:' + github[1] + '/' + github[2]
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*^~<>=|-]+)?$/i.test(raw)) return raw
  return null
}

/**
 * 用户在「自定义安装」里手写的一行目标。与 installSpecFromCommand 同一套白名单，
 * 但直接吃裸目标而不是整条命令：npm 包名（可带精确版本）、github:owner/repo[#path:…]、
 * https://github.com/owner/repo。
 *
 * 以前自定义安装把输入塞进 `target.repo`，于是 `github:acme/thing` 这种写法在
 * installSpecFor 里过不了 `^https?://github.com/` 检查、installCommand 又是空的，
 * 宿主只能回 400「没有可一键安装的目标」—— 前端提示却写着「支持 GitHub 地址」。
 * 这里把三种写法都折成同一种 spec，前后端口径一致。
 */
export function parseManualSpec(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 500) return null
  if (/\s|[;&|`$<>]/.test(text)) return null
  const pathSpec = /^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)#path:([a-z0-9._@+\/-]+)$/i.exec(text)
  if (pathSpec) {
    const subdir = pathSpec[3].replace(/^\/+|\/+$/g, '')
    if (!subdir || subdir.includes('..')) return null
    return 'github:' + pathSpec[1] + '/' + pathSpec[2] + '#path:' + subdir
  }
  if (/^github:[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(text)) return text
  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#path:([a-z0-9._@+\/-]+))?$/i.exec(text)
  if (github) {
    // 注意是 [3] 不是 [2]：[2] 是仓库名，恒为真，拿它当子目录会让
    // https://github.com/acme/tool 折成 github:acme/tool#path:tool，pnpm 必然报 ERR_PNPM_INVALID_PATH。
    const subdir = github[3] ? github[3].replace(/^\/+|\/+$/g, '') : ''
    if (subdir && subdir.includes('..')) return null
    if (subdir) return 'github:' + github[1] + '/' + github[2] + '#path:' + subdir
    return 'github:' + github[1] + '/' + github[2]
  }
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*^~<>=|-]+)?$/i.test(text)) return text
  return null
}

/** 升级只接受精确版本号：范围/标签交给 registry 自己解析会有歧义。 */
export function exactVersion(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text) ? text : null
}

/**
 * 安装失败后的降级目标。目录里的版本号是各市场自己写的，经常落后于 npm：
 * 按 `pkg@1.2.3` 装会得到 ERR_PNPM_NO_MATCHING_VERSION，而 `pkg` 其实好好的。
 * 同理，仓库里改过名的子目录会让 `github:o/r#path:x` 报 ERR_PNPM_INVALID_PATH。
 * 这两种情况都退回一个仍然正确的目标，而不是把 pnpm 原文丢给用户就结束。
 */
export function fallbackInstallSpec(spec, detail) {
  const text = String(spec || '')
  const reason = String(detail || '')
  if (!text) return null
  const versionMissing = /ERR_PNPM_NO_MATCHING_VERSION|No matching version found|E404|404 Not Found/i.test(reason)
  if (versionMissing) {
    const pinned = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@[^\s]+$/i.exec(text)
    if (pinned) return pinned[1]
  }
  const subdirMissing = /ERR_PNPM_INVALID_PATH|not a valid sub-directory|No such file or directory/i.test(reason)
  if (subdirMissing) {
    const withPath = /^(github:[a-z0-9_.-]+\/[a-z0-9_.-]+)#path:/i.exec(text)
    if (withPath) return withPath[1]
  }
  return null
}

/**
 * 前端随安装请求带来的条目快照。目录刷新后条目可能已经消失，
 * 但用户点的仍是同一行，快照让安装不依赖当前 rows 是否还包含它。
 */
export function installTargetSnapshot(value) {
  if (!value || typeof value !== 'object') return null
  const text = (input, max) => {
    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    return trimmed && trimmed.length <= max ? trimmed : null
  }
  const pkg = text(value.pkg, 300)
  const version = text(value.version, 80)
  const snapshot = {
    key: text(value.key, 300),
    // 快照来自浏览器，不能让它把任意字符串当成本地路径/命令目标。
    pkg: pkg && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg) ? pkg : null,
    repo: text(value.repo, 500),
    version: version && /^[a-z0-9.*^~<>=|-]+$/i.test(version) ? version : null,
    name: text(value.name, 300),
    title: text(value.title, 300),
    installCommand: text(value.installCommand, 500),
  }
  return Object.values(snapshot).some(Boolean) ? snapshot : null
}

/**
 * 解析目录行里的 GitHub 子目录。来源通常只把子目录写进 key 或 installCommand：
 *   gh:https://github.com/o/r#packages/foo
 *   dsh plugin --profile desktop add github:o/r#path:packages/foo
 * 只接受相对、无 ..、无查询/锚点的路径；解析不出来返回 null。
 */
export function subdirForRow(row) {
  if (!row) return null
  let value = ''
  const command = typeof row.installCommand === 'string' ? row.installCommand : ''
  const fromCommand = /#path:([a-z0-9._@+\/-]+)/i.exec(command)
  if (fromCommand) value = fromCommand[1]
  if (!value) {
    const key = String(row.key || '')
    const hash = key.indexOf('#')
    if (hash >= 0) value = key.slice(hash + 1)
  }
  if (!value) value = String(row.subpath || '')
  try {
    value = decodeURIComponent(value)
  } catch {
    return null
  }
  value = value.trim().replace(/^\/+|\/+$/g, '')
  if (!value || value.includes('..') || !/^[a-z0-9._@+\/-]+$/i.test(value)) return null
  return value
}

/**
 * 把目录行折算成 pluginManager.installBundle 能吃的 spec，折不出来就返回 null。
 * 规则只有一条：**装的东西必须就是这个条目**，宁可拒绝也不要装错。
 * 导出是为了让测试直接覆盖这层判断——装错包的代价比装不上大得多。
 */
export function installSpecFor(row) {
  if (!row) return null
  if (typeof row.pkg === 'string' && row.pkg) {
    const version = typeof row.version === 'string' ? row.version.trim() : ''
    // 只有稳定的精确版本才固定；范围/预发布交给 registry 的 latest 解析。
    return /^\d+\.\d+\.\d+$/.test(version) ? row.pkg + '@' + version : row.pkg
  }
  if (typeof row.repo !== 'string' || !row.repo) return null
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(row.repo.trim())
  if (!match) return null
  const subdir = subdirForRow(row)
  // pnpm 原生支持 github:owner/repo#path:packages/foo；它会先校验子目录是否真实存在。
  // 不要把子目录行退化成根仓库安装，否则会装错包。
  if (subdir) return 'github:' + match[1] + '/' + match[2] + '#path:' + subdir
  if (String(row.key || '').includes('#')) return null
  return 'github:' + match[1] + '/' + match[2]
}

/** 管理器返回值形状不稳定，只挑可读字段回给前端。 */
const summarizeInstallResult = (result) => {
  if (!result || typeof result !== 'object') return result == null ? null : String(result)
  const out = {}
  for (const key of ['name', 'version', 'bundle', 'action', 'changed', 'restartRequired']) {
    if (result[key] !== undefined) out[key] = result[key]
  }
  return out
}

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body)
  let payload = Buffer.from(text, 'utf8')
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    vary: 'accept-encoding',
  }
  const acceptsGzip = /\bgzip\b/u.test(String(res.req?.headers?.['accept-encoding'] || ''))
  if (acceptsGzip && payload.length > 64 * 1024) {
    payload = zlib.gzipSync(payload, { level: 6 })
    headers['content-encoding'] = 'gzip'
  }
  headers['content-length'] = String(payload.length)
  res.writeHead(status, headers)
  res.end(payload)
}

const loopback = (req) => {
  const address = String((req && req.socket && req.socket.remoteAddress) || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body exceeds ' + MAX_BODY + ' bytes'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

function readSourcesDossier() {
  try {
    const filename = fileURLToPath(new URL('./' + SOURCES_FILE, import.meta.url))
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return parsed && Array.isArray(parsed.sources) ? parsed : null
  } catch {
    return null
  }
}

function truncate(value, limit) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…' : value
}

function compactCompat(entry) {
  if (!entry) return { status: 'pending', reason: 'not-checked' }
  return {
    status: entry.status || 'unknown',
    reason: entry.reason || null,
    version: entry.version || null,
    checkedAt: entry.checkedAt || null,
  }
}

function publicRow(row) {
  return {
    id: row.key,
    name: row.name,
    title: truncate(row.title || row.name, 100),
    desc: truncate(row.description, 240),
    pkg: row.pkg,
    repo: row.repo,
    author: row.author,
    category: row.category,
    sources: row.sources,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedFrom: row.updatedFrom,
    installers: row.installers,
    installs: row.installs,
    downloads: row.downloads,
    stars: row.stars,
    forks: row.forks,
    score: Number.isFinite(row.score) ? row.score : null,
    featured: Boolean(row.featured),
    marketScore: row.marketScore,
    communityScore: row.communityScore,
    marketLabel: row.marketLabel,
    communityLabel: row.communityLabel,
    // 评分构成：规则可自定义之后，「为什么是 91 分」必须能解释得清，
    // 悬停详情直接展示每个因子拿了多少分。
    marketParts: Array.isArray(row.marketParts) ? row.marketParts : [],
    communityParts: Array.isArray(row.communityParts) ? row.communityParts : [],
    heat: row.heat,
    freshness: row.freshness,
    compat: row.pkg ? compactCompat(row.compat) : { status: 'no-package', reason: 'github-only' },
    installed: Boolean(row.installed),
    installedVersion: row.installedVersion ?? null,
    security: row.security ?? null,
    verification: row.verification ?? null,
    riskFlags: row.riskFlags ?? [],
    license: row.license ?? null,
    installable: Boolean(row.installable),
    // 本次同步差异：added / updated / removed（下架），null 表示没有变化
    change: row.change || null,
    changeDetail: row.changeDetail || null,
    delisted: Boolean(row.delisted),
    // 已安装插件可更新检测：{available, kind, from, to, source, checkedAt}
    update: row.update || null,
    // 安全优先视图的判定口径（dsh.so 低风险 / dshmarketplace installCheck=passed）
    trust: trustOf(row),
  }
}

function detailRow(row, compatEntry, versionDiff) {
  return {
    ...publicRow(row),
    desc: row.description || '',
    installCommand: row.installCommand || null,
    homepage: row.homepage || null,
    sourceHomepage: row.sourceHomepage || null,
    sourceIds: row.sourceIds || {},
    sourceUrls: row.sourceUrls || {},
    pushedAt: row.pushedAt || null,
    publishedAt: row.publishedAt || null,
    catalogUpdatedAt: row.catalogUpdatedAt || null,
    latestReleaseAt: row.latestReleaseAt || null,
    failures: row.failures ?? null,
    rawGrowth: row.rawGrowth || null,
    enginesDsh: row.enginesDsh || null,
    marketParts: row.marketParts || [],
    communityParts: row.communityParts || [],
    compatFull: compatEntry || null,
    // 版本差异：(已装, 可用] 之间的版本链，来自 npm packument；拿不到就是 null
    versionDiff: versionDiff || null,
  }
}

function countRows(rows) {
  return {
    total: rows.length,
    withUsers: rows.filter((row) => row.installers !== null).length,
    withRating: rows.filter((row) => Number.isFinite(row.score)).length,
    withStars: rows.filter((row) => row.stars !== null).length,
    withCompatibility: rows.filter((row) => row.compat?.status === 'ok' || row.compat?.status === 'bad').length,
    installed: rows.filter((row) => row.installed).length,
    npm: rows.filter((row) => row.pkg).length,
    withSecurity: rows.filter((row) => row.security || (row.riskFlags && row.riskFlags.length)).length,
    withVerification: rows.filter((row) => row.verification?.installCheck === 'passed').length,
  }
}

function validateHttpsUrl(value) {
  let url
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error('请输入合法的 HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) {
    throw new Error('来源必须是 HTTPS、443 端口且不含凭据')
  }
  return url
}

// 来源去重前先规范化：去首尾空白、取 origin + pathname，忽略 host 大小写与尾斜杠差异
function sourceUrlKey(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    return url.origin.toLowerCase() + url.pathname.replace(/\/+$/u, '')
  } catch {
    // 解析不了的 URL 退化成大小写无关的整串比较，至少还能挡住明显重复
    return text.toLowerCase()
  }
}

export function apply(ctx) {
  // 官方插件管理器是可选 peer：桌面 profile 有，其他 profile 可能没有。
  // 软注入持有引用，拿不到时前端直接显示「不可安装」，而不是点下去才失败。
  let pluginManager = null
  ctx.inject(['pluginManager'], (managed) => {
    const manager = managed.get('pluginManager')
    if (manager === undefined) return
    managed.effect(() => {
      pluginManager = manager
      return () => {
        if (pluginManager === manager) pluginManager = null
      }
    }, 'market-lens: official plugin manager')
  })

  const runtime = getRuntimeInfo()
  const profileDir = profileDirectory()
  const profileName = process.env.DSH_PROFILE || path.basename(profileDir) || 'desktop'
  const dossier = readSourcesDossier()
  const cachePath = path.join(cacheDirectory(), CACHE_FILE)
  const compatPath = path.join(cacheDirectory(), COMPAT_FILE)
  const logger = ctx.logger ?? console

  let sourceConfig = loadSourceConfig()
  let rows = []
  let rowIndex = new Map()
  let meta = {}
  let sourceCounts = {}
  let cacheGeneratedAt = null
  let cacheExists = false
  let nextAutoRefreshAt = null
  let refreshTimer = null
  let abortController = null
  let persistTail = Promise.resolve()
  let healthDirty = false
  // 本次同步差异摘要：随 catalog 缓存一起落盘，重启后「本次变化」的徽标仍然可读
  let syncDiff = { baselined: true, added: 0, updated: 0, removed: 0, total: 0, generatedAt: null, previousGeneratedAt: null }

  /**
   * 操作日志：安装 / 升级 / 规则 / 来源这些「改了宿主状态」的动作都往这里写一条。
   * 进程内环形缓冲，不落盘——它服务的是「这次为什么没装上」这类当场要回答的问题。
   */
  const opLog = new OpLog({ limit: 500 })

  /**
   * 安装 / 升级专用埋点。每次调用都带上当前规范与目标，让日志页能按行过滤出
   * 「这一次安装」的完整链路，而不只是最后那句被截断的报错。
   */
  function logInstall(level, tag, data = {}) {
    return opLog.write(level, tag, { op: 'install', spec: null, key: null, origin: null, ms: null, ...data })
  }

  /** 文件名用时间戳：2026-11-03-1635（本地时区，取到分钟即可，保证可排序）。 */
  function stamp() {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes())
  }

  const rulesPath = path.join(cacheDirectory(), RULES_FILE)
  const initialRules = loadRulesFile()
  let scoringRules = initialRules.rules
  let rulesSource = initialRules.source
  let rulesSavedAt = initialRules.savedAt
  let rulesIssue = initialRules.issue
  let appliedRulesFingerprint = null
  const rulesListeners = new Set()

  function loadRulesFile() {
    // readJson 把「文件不存在」和「JSON 坏了」都归成 null，但这两件事对用户
    // 完全不是一回事：前者是没自定义，后者是改坏了——必须说清楚，否则规则
    // 悄悄退回内置口径，用户只会觉得「我改的没用」。
    if (!fs.existsSync(rulesPath)) return { rules: BUILT_IN_RULES, source: 'default', savedAt: null, issue: null }
    let raw
    try {
      raw = readJson(rulesPath)
    } catch (error) {
      opLog.error('rules.load.failed', { detail: message(error) })
      return { rules: BUILT_IN_RULES, source: 'default', savedAt: null, issue: '规则文件读取失败，已回退内置规则：' + message(error) }
    }
    if (!raw) {
      opLog.error('rules.load.failed', { detail: 'JSON 解析失败', path: rulesPath })
      return { rules: BUILT_IN_RULES, source: 'default', savedAt: null, issue: '规则文件不是合法 JSON，已回退内置规则；请重新上传或点「恢复内置规则」。' }
    }
    const result = validateRules(raw)
    if (!result.ok) {
      opLog.error('rules.load.invalid', { detail: result.issues.join('；') })
      return { rules: BUILT_IN_RULES, source: 'default', savedAt: null, issue: '规则文件不合法，已回退内置规则：' + result.issues[0] }
    }
    return { rules: result.rules, source: 'file', savedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null, issue: null }
  }

  function rulesFingerprint() {
    return createHash('sha1').update(JSON.stringify(scoringRules)).digest('hex').slice(0, 12)
  }

  function factorCountOf(rules) {
    let count = 0
    for (const name of ['market', 'community', 'heat']) {
      count += (rules[name]?.factors?.length || 0) + (rules[name]?.fallback?.length || 0)
    }
    return count
  }

  /** 状态里只放指纹和摘要：规则全文有几十 KB，不能每 20 秒随 status 重发一遍。 */
  function rulesSummary() {
    return {
      fingerprint: rulesFingerprint(),
      name: scoringRules.name,
      description: scoringRules.description || '',
      source: rulesSource,
      savedAt: rulesSavedAt,
      issue: rulesIssue,
      isDefault: rulesSource === 'default',
      labels: { ...scoringRules.labels },
      factorCount: factorCountOf(scoringRules),
      presets: BUILT_IN_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, description: preset.description })),
    }
  }

  function rulesBody() {
    return { summary: rulesSummary(), rules: scoringRules }
  }

  function onRulesChanged(listener) {
    if (typeof listener !== 'function') return () => {}
    rulesListeners.add(listener)
    return () => rulesListeners.delete(listener)
  }

  /**
   * 用当前规则重算内存里所有行的分数。切换规则后不重新抓源也能立刻看到效果，
   * 因为分数只依赖行上的数值字段。
   */
  function applyRulesToRows(list, now = Date.now()) {
    const context = prepareMetrics(list, scoringRules)
    for (const row of list) {
      const market = scoreGroup(scoringRules.market, row, context, now)
      const community = scoreGroup(scoringRules.community, row, context, now)
      const heat = scoreGroup(scoringRules.heat, row, context, now)
      row.marketScore = market.score
      row.marketLabel = scoreLabelFromRules(market.score, scoringRules.labels)
      row.marketParts = market.parts.map((part) => ({ key: part.key, weight: part.weight, value: part.value }))
      row.communityScore = community.parts.length ? community.score : null
      row.communityLabel = community.parts.length ? scoreLabelFromRules(community.score, scoringRules.labels) : 'weak'
      row.communityParts = community.parts.map((part) => ({ key: part.key, weight: part.weight, value: part.value }))
      row.heat = heat.score
    }
    return list
  }

  /** 规则没变就跳过，避免每次 status 都白跑一遍全表评分。 */
  function ensureRulesApplied({ force = false } = {}) {
    const fingerprint = rulesFingerprint()
    if (!force && appliedRulesFingerprint === fingerprint) return false
    applyRulesToRows(rows)
    appliedRulesFingerprint = fingerprint
    // 分数变了，磁盘上的缓存也得跟着变：否则重启后 loadInitialCache 读到的还是
    // 旧规则算出来的分，用户以为规则没生效。
    if (cacheExists) {
      try {
        saveCatalogCache()
      } catch (error) {
        opLog.warn('rules.cache.save.failed', { detail: message(error) })
      }
    }
    return true
  }

  /**
   * 换规则：校验 → 写盘 → 立即重算。
   * 写盘失败不落地内存状态，沿用 settings.set 那套「失败即回滚」的口径。
   */
  function commitRules(input, { source = 'file', presetId = null } = {}) {
    const result = validateRules(input)
    if (!result.ok) {
      opLog.warn('rules.rejected', { detail: result.issues.join('；') })
      return { ok: false, error: '规则文件不合法：' + result.issues[0], issues: result.issues }
    }
    const next = result.rules
    const document = { ...rulesDocument(next), updatedAt: new Date().toISOString() }
    try {
      writeJsonAtomic(rulesPath, document)
    } catch (error) {
      opLog.error('rules.save.failed', { detail: message(error) })
      return { ok: false, error: '规则写盘失败：' + message(error), issues: [] }
    }
    scoringRules = next
    rulesSource = source
    rulesSavedAt = document.updatedAt
    rulesIssue = null
    const changed = ensureRulesApplied({ force: true })
    opLog.info('rules.applied', {
      name: next.name,
      source,
      presetId,
      factors: factorCountOf(next),
      labels: [next.labels.excellent, next.labels.good, next.labels.fair].join('/'),
      rows: rows.length,
      fingerprint: rulesFingerprint(),
    })
    for (const listener of rulesListeners) {
      try {
        listener({ summary: rulesSummary(), rows: rows.length, changed })
      } catch {
        // 监听者出错不影响换规则本身
      }
    }
    return { ok: true, rules: next, summary: rulesSummary(), recomputed: changed, rows: rows.length }
  }

  /** 回到内置规则：删掉文件而不是写一份副本，避免「自定义文件」和「默认」长期并存。 */
  function resetRules() {
    try {
      if (fs.existsSync(rulesPath)) fs.rmSync(rulesPath, { force: true })
    } catch (error) {
      return { ok: false, error: '删除规则文件失败：' + message(error) }
    }
    scoringRules = BUILT_IN_RULES
    rulesSource = 'default'
    rulesSavedAt = null
    rulesIssue = null
    const changed = ensureRulesApplied({ force: true })
    opLog.info('rules.reset', { rows: rows.length, changed })
    for (const listener of rulesListeners) {
      try {
        listener({ summary: rulesSummary(), rows: rows.length, changed })
      } catch {
        // 同上
      }
    }
    return { ok: true, summary: rulesSummary(), recomputed: changed }
  }

  const idleProgress = () => {
    const progress = {}
    for (const source of sourceConfig.sources) {
      progress[source.id] = { status: source.enabled ? 'idle' : 'disabled', done: 0, total: 0, error: null }
    }
    progress.compat = { status: 'idle', done: 0, total: 0, error: null }
    return progress
  }

  let syncState = {
    running: false,
    phase: 'idle',
    trigger: 'manual',
    startedAt: null,
    finishedAt: null,
    message: '',
    errors: [],
    progress: idleProgress(),
  }

  function currentSourceMap() {
    return new Map(sourceConfig.sources.map((source) => [source.id, source]))
  }

  // 写盘结果必须往上传：调用方据此回 ok:false，不能让用户以为设置已保存
  function saveConfig() {
    const result = saveSourceConfig(sourceConfig)
    if (result.ok) {
      healthDirty = false
      return result
    }
    logger.warn?.('[market-lens] failed to save source config: ' + result.error)
    return result
  }

  // 逐源健康状态在内存里维护，落盘复用 settings（source-config.json），与 lastAutoRefreshAt 同一套机制
  function sourceHealthEntry(sourceId) {
    if (!sourceConfig.sourceHealth || typeof sourceConfig.sourceHealth !== 'object') sourceConfig.sourceHealth = {}
    const stored = sourceConfig.sourceHealth[sourceId]
    const entry = {
      // 老配置可能只有 id 没有这三个字段：逐个补默认值，避免 undefined 冒到前端
      lastSuccessAt: typeof stored?.lastSuccessAt === 'string' ? stored.lastSuccessAt : null,
      failureCount: Number.isInteger(stored?.failureCount) && stored.failureCount > 0 ? stored.failureCount : 0,
      lastError: typeof stored?.lastError === 'string' ? stored.lastError : null,
    }
    sourceConfig.sourceHealth[sourceId] = entry
    return entry
  }

  function markSourceSuccess(sourceId) {
    const entry = sourceHealthEntry(sourceId)
    entry.lastSuccessAt = new Date().toISOString()
    entry.failureCount = 0
    entry.lastError = null
    healthDirty = true
  }

  function markSourceFailure(sourceId, text) {
    const entry = sourceHealthEntry(sourceId)
    entry.failureCount += 1
    entry.lastError = truncate(text, 200)
    healthDirty = true
  }

  function flushSourceHealth() {
    if (!healthDirty) return
    saveConfig()
  }

  function loadCatalogCache() {
    if (!fs.existsSync(cachePath)) return null
    const cached = readJson(cachePath)
    if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.rows)) return null
    return cached
  }

  function loadCompatCache(catalog) {
    if (fs.existsSync(compatPath)) {
      const cached = readJson(compatPath)
      if (cached && cached.version === CACHE_VERSION && Array.isArray(cached.entries)) return cached
    }
    return catalog?.compat && Array.isArray(catalog.compat.entries) ? catalog.compat : null
  }

  const initialCatalog = loadCatalogCache()
  const initialCompat = loadCompatCache(initialCatalog)

  const compat = new CompatService({
    runtimeVersion: runtime.runtimeVersion || '0.0.0',
    cache: initialCompat,
    logger,
    onPersist: (snapshot, status) => {
      syncState.progress.compat = {
        status: status.running ? 'checking' : 'done',
        done: status.done,
        total: status.total || syncState.progress.compat?.total || 0,
        error: null,
      }
      persistTail = persistTail
        .then(() => saveCompatCache())
        .catch((error) => logger.warn?.('[market-lens] compatibility cache persist failed: ' + message(error)))
      return persistTail
    },
    onUpdate: (pkg, entry) => {
      const row = rowIndex.get(pkg)
      if (row) {
        row.compat = entry
        if (!row.version && typeof entry.version === 'string') row.version = entry.version
        if (syncState.phase === 'compat') {
          syncState.progress.compat = {
            status: 'checking',
            done: compat.done,
            total: compat.total,
            error: null,
          }
        }
      }
    },
  })

  // ---- 已安装插件的可更新检测 ----
  const updatesPath = path.join(cacheDirectory(), UPDATES_FILE)
  const updates = new UpdateService({ compat, getManager: () => pluginManager, logger })

  function loadUpdatesCache() {
    if (!fs.existsSync(updatesPath)) return
    const cached = readJson(updatesPath)
    if (!cached || cached.version !== CACHE_VERSION || !Array.isArray(cached.entries)) return
    for (const entry of cached.entries) updates.set(entry)
  }

  function saveUpdatesCache() {
    try {
      writeJsonAtomic(updatesPath, { version: CACHE_VERSION, ...updates.status(), entries: updates.snapshot() })
    } catch (error) {
      // 更新检测结果只是提示：落盘失败不该让面板挂掉，但要在日志里留痕
      logger.warn?.('[market-lens] update cache persist failed: ' + message(error))
    }
  }

  loadUpdatesCache()

  /**
   * 已装插件清单。官方 listBundles() 才是权威版本列表（已装版本 + availability），
   * 但 availability='installation' 的包由安装目录提供、profile 无法升级，要排掉；
   * 没有官方管理器时退回 profile 的 node_modules 清单，界面会标来源为 npm。
   */
  async function installedBundleItems() {
    // spec 用来判断这个包是不是 registry 上的：link: / file: / @local/* 的包
    // 让 pnpm 去问「最新版本」只会失败，并在官方插件页留下失败记录。
    const specByName = new Map()
    try {
      for (const entry of getInstalledPackages(profileDir).values()) {
        if (entry && entry.name) specByName.set(entry.name.toLowerCase(), entry.spec || null)
      }
    } catch {
      // 读不到 profile 时退化成「没有 spec」，检查逻辑自己会保守处理
    }
    const manager = pluginManager
    if (manager && typeof manager.listBundles === 'function') {
      try {
        const bundles = await manager.listBundles()
        const items = (Array.isArray(bundles) ? bundles : [])
          .filter((bundle) => bundle && typeof bundle.name === 'string' && bundle.version && bundle.installed !== false)
          .filter((bundle) => bundle.availability !== 'installation')
          .map((bundle) => ({
            pkg: bundle.name,
            installed: String(bundle.version),
            spec: specByName.get(String(bundle.name).toLowerCase()) || null,
          }))
        if (items.length) return items
      } catch (error) {
        logger.warn?.('[market-lens] listBundles failed: ' + message(error))
      }
    }
    const items = []
    try {
      for (const entry of getInstalledPackages(profileDir).values()) {
        if (entry && entry.name) items.push({ pkg: entry.name, installed: entry.version || null, spec: entry.spec || null })
      }
    } catch {
      // 读不到 profile 就没有可检查的对象
    }
    return items
  }

  /** 后台跑一次更新检查：官方 inspect 优先，npm latest 兜底。不阻塞请求。 */
  async function startUpdateCheck({ force = false } = {}) {
    try {
      const items = await installedBundleItems()
      await updates.check(items, { force })
      saveUpdatesCache()
      refreshUpdateOnRows()
    } catch (error) {
      logger.warn?.('[market-lens] update check failed: ' + message(error))
    }
  }

  /**
   * 接受一次检查请求：先打 queued，再去列已装包。
   *
   * 以前 `updates.check` 是 `void startUpdateCheck()` 后立刻返回状态，而状态里
   * `running` 还是 false（真正的 check 要等 listBundles 回来看得到包名才置位）。
   * 前端只有看到 running 才启动轮询，于是「检查更新」点下去几十秒没有反馈；
   * 重复点还会并发列出两轮。
   */
  function queueUpdateCheck({ force = false } = {}) {
    if (updates.state.running || updates.state.queued) return updates.status()
    updates.markQueued()
    void startUpdateCheck({ force })
    return updates.status()
  }

  function saveCatalogCache() {
    if (!cacheExists && rows.length === 0) return
    writeJsonAtomic(cachePath, {
      version: CACHE_VERSION,
      generatedAt: cacheGeneratedAt || new Date().toISOString(),
      runtime,
      profileName,
      meta,
      rows: rows.map((row) => ({ ...row, compat: null })),
      sources: meta.sources || null,
    })
  }

  function saveCompatCache() {
    writeJsonAtomic(compatPath, { version: CACHE_VERSION, ...compat.snapshot() })
  }

  function rebuildRowIndex() {
    rowIndex = new Map()
    for (const row of rows) {
      if (row.pkg) rowIndex.set(row.pkg.toLowerCase(), row)
      // key 是 pkg:/gh: 形式，之前只索引 pkg，安装时按 row.key 查找会先 miss，
      // 再靠 rows.find 兜底；目录一刷新就 404。把 key 也放进索引，至少不会
      // 在条目还在内存里时误报。
      if (row.key) rowIndex.set(String(row.key), row)
    }
  }

  /**
   * 目录行优先，快照兜底。刷新目录/切换来源后客户端手里的行可能已经不存在，
   * 但它的 pkg / repo / installCommand 仍足以完成同一次安装。
   */
  function resolveInstallRow(key, target) {
    const wanted = String(key || '').trim()
    if (wanted) {
      const exact = rowIndex.get(wanted)
      if (exact) return { row: exact, origin: 'catalog' }
      const byKey = rows.find((candidate) => candidate.key === wanted)
      if (byKey) return { row: byKey, origin: 'catalog' }
      const bare = rowIndex.get(wanted.toLowerCase())
      if (bare) return { row: bare, origin: 'catalog' }
    }
    if (target?.pkg) {
      const byPkg = rowIndex.get(target.pkg.toLowerCase())
      if (byPkg) return { row: byPkg, origin: 'catalog' }
    }
    if (target?.repo) {
      const repo = target.repo.toLowerCase()
      const byRepo = rows.find((candidate) => String(candidate.repo || '').toLowerCase() === repo)
      if (byRepo) return { row: byRepo, origin: 'catalog' }
    }
    if (!target) return { row: null, origin: null }
    return {
      row: {
        key: target.key || (target.pkg ? 'pkg:' + target.pkg.toLowerCase() : target.repo ? 'gh:' + target.repo.toLowerCase() : null),
        pkg: target.pkg || null,
        repo: target.repo || null,
        version: target.version || null,
        name: target.name || target.title || target.pkg || target.repo || 'plugin',
        installCommand: target.installCommand || null,
        sources: [],
      },
      origin: 'snapshot',
    }
  }

  /** pnpm 把被忽略的构建脚本写进错误文本；提取出来让前端可以带 approvedBuilds 重试。 */
  function pendingBuildNames(error) {
    const text = message(error)
    // 截到第一个「. + 空格」为止，去掉 pnpm 追加的 "Run pnpm approve-builds..."；
    // 包名里的点后面没有空格（如 lodash.merge），不会被误切。
    const line = (/Ignored build scripts?:\s*([^\n\r]+)/i.exec(text)?.[1] || '').split(/\.\s/)[0]
    if (!line) return []
    return [...new Set(line.split(',').map((name) => name.trim().replace(/[.\s]+$/g, '')).filter((name) => name && !/[*?]/.test(name)))]
  }

  function refreshCompatOnRows() {
    for (const row of rows) {
      if (!row.pkg) {
        row.compat = { status: 'no-package', reason: 'github-only' }
        continue
      }
      const entry = compat.get(row.pkg)
      if (entry) {
        row.compat = entry
        if (!row.version && typeof entry.version === 'string') row.version = entry.version
      }
    }
  }

  function refreshInstalledOnRows() {
    let installed
    try {
      installed = getInstalledPackages(profileDir)
    } catch {
      return
    }
    for (const row of rows) {
      const entry = row.pkg ? installed.get(row.pkg.toLowerCase()) : null
      row.installed = Boolean(entry)
      row.installedVersion = entry?.version ?? null
    }
  }

  /**
   * 已安装集合的指纹。客户端每轮 status 比一次，变了就重新拉目录：
   * 从官方插件市场装的、从命令行装的都不经过本插件，没有这条就只能手动刷新。
   */
  function installedState() {
    let packages
    try {
      packages = getInstalledPackages(profileDir)
    } catch {
      return { count: null, fingerprint: null }
    }
    const entries = [...packages.values()]
      .map((entry) => entry.name + '@' + (entry.version || '?'))
      .sort()
    return {
      count: entries.length,
      fingerprint: createHash('sha1').update(entries.join('|')).digest('hex').slice(0, 16),
    }
  }

  /**
   * 单行的「可更新」结论。官方检查过就用官方版本（带 registry 语义、尊重私有源），
   * 没有就用 compat 里缓存的 npm latest —— 后者已经在同步时付过费，所以表格能立刻
   * 标出「可更新到 x.y.z」；官方 inspect 后台回来后覆盖，并把 source 标成 pluginManager。
   */
  function updateForPackage(pkg, installedVersion, spec = null) {
    const name = typeof pkg === 'string' ? pkg.trim() : ''
    if (!name) return null
    // 本地 / link 包永远没有「registry 上的新版本」：显式标出来，
    // 界面才不会给它一个点了必然失败的升级按钮。
    if (!isRegistryCandidate(name, spec)) {
      // 说清「为什么没有可比的版本」：link:/本地路径和 github: 是两回事，
      // 界面上都写「本地安装」会让 GitHub 装的那几个看起来像自己写的包。
      const specText = String(spec || '')
      const local = !specText || /^(?:link|file|portal|workspace):|^[a-z]:[\\/]|^\.{0,2}[\\/]/i.test(specText)
      return {
        available: false,
        kind: local ? 'local' : 'external',
        from: installedVersion ? String(installedVersion) : null,
        to: null,
        source: 'skipped',
        registry: null,
        checkedAt: null,
        reason: local ? 'local-package' : 'non-registry-spec',
      }
    }
    const official = updates.get(name)
    const installed = (official && official.installed) || installedVersion || null
    if (!installed) return null
    if (official && official.latest) {
      const comparison = compareVersions(installed, official.latest)
      return {
        available: comparison.available,
        kind: comparison.kind,
        from: installed,
        to: official.latest,
        source: official.source,
        registry: official.registry || null,
        checkedAt: official.checkedAt || null,
      }
    }
    const cached = compat.get(name)
    if (!cached || !cached.version) return null
    const comparison = compareVersions(installed, cached.version)
    return {
      available: comparison.available,
      kind: comparison.kind,
      from: installed,
      to: cached.version,
      source: 'npm',
      registry: null,
      checkedAt: cached.checkedAt || null,
    }
  }

  function updateEntryFor(row) {
    if (!row || !row.installed || !row.pkg) return null
    return updateForPackage(row.pkg, row.installedVersion)
  }

  /** 安装来源：老界面上写死的 'npm' 会把 link:/github: 装的包也说成 npm，这里按 spec 判。 */
  function specKind(spec) {
    const text = typeof spec === 'string' ? spec.trim() : ''
    if (!text) return 'unknown'
    if (/^(link|file|portal|workspace):/i.test(text)) return 'local'
    if (/^(git\+|git:|github:)/i.test(text)) return 'github'
    if (/^https?:/i.test(text)) return 'url'
    if (/\.(tgz|tar\.gz|zip)$/i.test(text)) return 'archive'
    return 'npm'
  }

  /**
   * profile 里真实装着的插件清单。
   *
   * 为什么不让前端直接读目录：目录行来自市场，装了但市场里没有的包（本地插件、
   * 私有包、已下架的包）在表格里根本不存在，于是「已安装」页会显示成空的，
   * 而页头却写着「已安装 · 12」—— 两个数字当面打架。
   * 这里以 profile 的依赖表为准，再尽力补上目录里的展示名与更新结论。
   */
  function installedPackages() {
    let packages
    try {
      packages = getInstalledPackages(profileDir)
    } catch {
      return { count: null, fingerprint: null, packages: [], updatesAvailable: 0, error: '无法读取 profile 依赖表' }
    }
    const list = []
    let updatesAvailable = 0
    for (const entry of packages.values()) {
      if (!entry || !entry.name) continue
      const update = updateForPackage(entry.name, entry.version, entry.spec)
      if (update && update.available) updatesAvailable += 1
      const row = rowIndex.get(entry.name.toLowerCase()) || null
      list.push({
        pkg: entry.name,
        version: entry.version || null,
        spec: entry.spec || null,
        kind: specKind(entry.spec),
        registry: isRegistryCandidate(entry.name, entry.spec),
        update,
        // 目录里命中时带上展示名，界面上就不是一串光秃秃的包名
        title: row ? (row.title || row.name || null) : null,
        repo: row ? (row.repo || null) : null,
        sources: row ? (row.sources || []) : [],
      })
    }
    list.sort((left, right) => {
      const leftUpdate = left.update && left.update.available ? 0 : 1
      const rightUpdate = right.update && right.update.available ? 0 : 1
      if (leftUpdate !== rightUpdate) return leftUpdate - rightUpdate
      return String(left.pkg).localeCompare(String(right.pkg))
    })
    const entries = [...packages.values()]
      .map((entry) => entry.name + '@' + (entry.version || '?'))
      .sort()
    return {
      count: entries.length,
      fingerprint: createHash('sha1').update(entries.join('|')).digest('hex').slice(0, 16),
      packages: list,
      updatesAvailable,
    }
  }

  /**
   * 已安装集合的指纹。客户端每轮 status 比一次，变了就重新拉目录：
   * 从官方插件市场装的、从命令行装的都不经过本插件，没有这条就只能手动刷新。
   */
  function installedState() {
    const state = installedPackages()
    return {
      count: state.count,
      fingerprint: state.fingerprint,
      packages: state.packages,
      updatesAvailable: state.updatesAvailable,
    }
  }

  function refreshUpdateOnRows() {
    for (const row of rows) row.update = updateEntryFor(row)
  }

  function computeSourceCounts() {
    const counts = {}
    for (const source of sourceConfig.sources) counts[source.id] = 0
    for (const row of rows) {
      for (const sourceId of row.sources || []) counts[sourceId] = (counts[sourceId] || 0) + 1
    }
    return counts
  }

  function loadInitialCache(cached) {
    if (!cached) return
    rows = cached.rows
    rebuildRowIndex()
    meta = cached.meta && typeof cached.meta === 'object' ? cached.meta : {}
    // 差异摘要跟着缓存走：重启后「新增/更新/下架」徽标仍然对应最近一次同步
    if (meta.diff && typeof meta.diff === 'object') syncDiff = meta.diff
    sourceCounts = meta.sourceCounts && typeof meta.sourceCounts === 'object'
      ? meta.sourceCounts
      : computeSourceCounts()
    cacheGeneratedAt = cached.generatedAt || null
    cacheExists = true
    compat.total = Number(cached.meta?.compatTotal) || rows.filter((row) => row.pkg).length
    compat.done = compat.entries.size
    refreshCompatOnRows()
    refreshUpdateOnRows()
    syncState.phase = 'cache'
    syncState.finishedAt = cacheGeneratedAt
    syncState.progress.compat = {
      status: compat.running ? 'checking' : 'done',
      done: compat.done,
      total: compat.total,
      error: null,
    }
  }

  loadInitialCache(initialCatalog)
  // 缓存里的分数是「写入那一刻的规则」算的；换了规则要先按当前规则重算一遍，
  // 否则界面显示的分数与规则页面的口径对不上。
  ensureRulesApplied()

  function sourceHealth() {
    return sourceConfig.sources.map((source) => {
      const progress = syncState.progress[source.id]
      const health = sourceHealthEntry(source.id)
      return {
        ...source,
        rows: sourceCounts[source.id] ?? 0,
        progress: progress ?? { status: source.enabled ? 'idle' : 'disabled', done: 0, total: 0, error: null },
        meta: meta.sources?.[source.id] ?? null,
        // progress 只反映本次运行，持久化的健康字段才能在重启后显示“上次成功多久前/连续失败几次”
        lastSuccessAt: health.lastSuccessAt,
        failureCount: health.failureCount,
        lastError: health.lastError,
      }
    })
  }

  function settingsBody() {
    return {
      refreshIntervalMinutes: sourceConfig.refreshIntervalMinutes,
      lastAutoRefreshAt: sourceConfig.lastAutoRefreshAt ?? null,
      nextAutoRefreshAt,
      // 安全优先视图：默认 true，只显示低风险 / 安装验证通过的条目
      safeView: sourceConfig.safeView !== false,
      options: REFRESH_OPTIONS,
      // 与 lastAutoRefreshAt 同源：设置面板读这里即可拿到逐源的上次成功/连续失败
      sourceHealth: Object.fromEntries(
        sourceConfig.sources.map((source) => [source.id, sourceHealthEntry(source.id)]),
      ),
    }
  }

  function statusBody() {
    // 规则换了但还没重算时（例如别处直接改了文件）在这里兜一次，保证 status 自洽
    ensureRulesApplied()
    refreshCompatOnRows()
    refreshInstalledOnRows()
    refreshUpdateOnRows()
    return {
      ok: true,
      pluginVersion: PLUGIN_VERSION,
      repo: REPO_INFO,
      runtime,
      profile: { name: profileName, dir: profileDir },
      rows: rows.length,
      cache: { exists: cacheExists, generatedAt: cacheGeneratedAt, path: cachePath },
      sync: syncState,
      compat: compat.status(),
      counts: countRows(rows),
      sources: dossier,
      sourceConfig: publicSourceConfig(sourceConfig),
      sourceHealth: sourceHealth(),
      sourceMeta: meta.sources || null,
      settings: settingsBody(),
      rules: rulesSummary(),
      logs: opLog.status(),
      compatSeq: compat.seq,
      diff: syncDiff,
      updates: updates.status(),
      // 已安装集合的指纹 + 安装按钮可用性：客户端据此做「装完立刻同步」和轮询。
      installed: installedState(),
      install: { available: Boolean(pluginManager), busy: installingKey },
    }
  }

  function parseManifest(value) {
    if (!value || typeof value !== 'object' || !value.transport || typeof value.transport.endpoint !== 'string') {
      throw new Error('不是有效的 catalog-source manifest')
    }
    // 严格等于 1.0.0：版本不同说明字段语义可能已变，错误里带上实际值便于用户排查
    if (value.manifestVersion !== STANDARD_MANIFEST_VERSION) {
      throw new Error('manifestVersion 必须是 ' + STANDARD_MANIFEST_VERSION + '，实际收到: ' + versionText(value.manifestVersion))
    }
    const endpoint = validateHttpsUrl(value.transport.endpoint)
    return { manifest: value, endpoint: endpoint.href }
  }

  async function detectSourceKind(urlValue) {
    const url = validateHttpsUrl(urlValue)
    // 先按域名拦一道：HTML 页面抓回来也只会得到“既不是 format 1 也不是 manifest”，
    // 那句话对 dshbase 是误导——它不是写法错，是这个站还没有 JSON API。
    if (url.hostname === 'dshbase.com' || url.hostname.endsWith('.dshbase.com')) {
      throw new Error(DSHBASE_REASON)
    }
    const response = await fetchJson(url.href, { timeoutMs: 30_000, retries: 2 })
    const value = response.value
    if (value && value.format === 1 && Array.isArray(value.plugins)) {
      return {
        kind: 'format1',
        url: url.href,
        name: pickText(value.title) || url.hostname,
        count: value.plugins.length,
      }
    }
    if (value && typeof value === 'object' && value.transport && typeof value.transport.endpoint === 'string') {
      // 放宽进入条件，让版本不对的 manifest 也能由 parseManifest 报出实际版本，而不是一句"不是 manifest"
      const parsed = parseManifest(value)
      return {
        kind: 'standard',
        manifestUrl: url.href,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : url.hostname,
        count: null,
        endpoint: parsed.endpoint,
      }
    }
    throw new Error('该 URL 既不是 format 1 索引，也不是 catalog-source manifest')
  }

  function scheduleNextRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    nextAutoRefreshAt = null
    const interval = Number(sourceConfig.refreshIntervalMinutes) || 0
    const targets = enabledSources(sourceConfig)
    if (!interval || targets.length === 0) return
    const base = cacheGeneratedAt ? Date.parse(cacheGeneratedAt) : Date.now()
    const next = Math.max(Date.now() + MIN_SCHEDULE_DELAY_MS, base + interval * 60_000)
    nextAutoRefreshAt = new Date(next).toISOString()
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (syncState.running) {
        scheduleNextRefresh()
        return
      }
      void startSync({ trigger: 'schedule' })
    }, Math.max(MIN_SCHEDULE_DELAY_MS, next - Date.now()))
    refreshTimer.unref?.()
  }

  async function runSource(source, signal) {
    const progress = (value) => {
      const previous = syncState.progress[source.id] || {}
      syncState.progress[source.id] = {
        status: value.status || 'fetching',
        done: value.done ?? previous.done ?? 0,
        total: value.total ?? previous.total ?? 0,
        error: null,
      }
      if (value.message) syncState.message = value.message
    }

    let result
    let items
    if (source.kind === '1024store') {
      result = await fetch1024Catalog({
        signal,
        onProgress: (value) => {
          progress({ ...value, message: `1024Store ${value.done || 0}/${value.total || 0} 页` })
        },
      })
      items = result.items.map((item) => normalize1024(item, profileName)).filter(Boolean)
    } else if (source.kind === 'dshfind') {
      result = await fetchFormat1Index(CATALOG_DSHFIND_ENDPOINT, { signal, onProgress: (value) => progress({ ...value, message: '正在拉取 dshfind 索引' }) })
      items = result.items
        .map((item) => normalizeFormat1(item, { sourceId: source.id, sourceName: source.name, sourceHomepage: 'https://dshfind.com', profileName }))
        .filter(Boolean)
    } else if (source.kind === 'dshso') {
      result = await fetchFormat1Index(source.url || CATALOG_DSHSO_ENDPOINT, { signal, onProgress: (value) => progress({ ...value, message: '正在拉取 dsh.so 精选市场' }) })
      items = result.items
        .map((item) => normalizeFormat1(item, { sourceId: source.id, sourceName: source.name, sourceHomepage: 'https://www.dsh.so', profileName }))
        .filter(Boolean)
    } else if (source.kind === 'dshmarketplace') {
      result = await fetchDshmarketplaceCatalog({
        signal,
        onProgress: (value) => progress({ ...value, message: `dshmarketplace ${value.done || 0}/${value.total || 0} 页` }),
      })
      items = result.items.map((item) => normalizeDshmarketplace(item, profileName)).filter(Boolean)
    } else if (source.kind === 'standard') {
      result = await fetchStandardCatalog(source, { signal, onProgress: (value) => progress({ ...value, message: '正在拉取自定义标准目录' }) })
      // catalog.js 只判 typeof，这里按 1.0.0 再卡一道，刷新期同样不能放行异版本 manifest
      const manifestVersion = result?.meta?.manifest?.manifestVersion
      if (manifestVersion !== STANDARD_MANIFEST_VERSION) {
        throw new Error(source.name + ' 的 manifestVersion 必须是 ' + STANDARD_MANIFEST_VERSION + '，实际收到: ' + versionText(manifestVersion))
      }
      items = result.items
        .map((item) => normalizeStandardItem(item, { sourceId: source.id, sourceName: source.name, profileName }))
        .filter(Boolean)
    } else if (source.kind === 'format1') {
      result = await fetchFormat1Index(source.url, { signal, onProgress: (value) => progress({ ...value, message: `正在拉取 ${source.name}` }) })
      items = result.items
        .map((item) => normalizeFormat1(item, { sourceId: source.id, sourceName: source.name, sourceHomepage: source.name, profileName }))
        .filter(Boolean)
    } else {
      throw new Error('未知来源类型: ' + source.kind)
    }

    // 已中止的源不能再回写成功状态：否则超时后界面会把 error 翻回 done，健康状态也会被误记成功
    if (signal.aborted) throw signal.reason ?? new Error('sync cancelled')
    syncState.progress[source.id] = {
      status: 'done',
      done: items.length,
      total: items.length,
      error: null,
    }
    // 拉取完整跑通才算一次成功：清零连续失败并记下时间，供重启后展示
    markSourceSuccess(source.id)
    return {
      source,
      items,
      meta: { ...result.meta, rows: items.length, kind: source.kind, name: source.name },
    }
  }

  function startSync({ force = false, sourceIds, trigger = 'manual' } = {}) {
    if (syncState.running) return statusBody()
    const selected = sourceConfig.sources.filter((source) =>
      source.enabled && (Array.isArray(sourceIds) && sourceIds.length ? sourceIds.includes(source.id) : true),
    )
    if (selected.length === 0) {
      return { ...statusBody(), ok: false, error: '没有启用任何插件源' }
    }

    abortController = new AbortController()
    const signal = abortController.signal
    // 总时长上限用 Date.now() 差值判断：某个来源永不返回时，整次同步必须能在 deadline 前收尾
    const syncDeadline = Date.now() + SYNC_TIMEOUT_MS
    let syncTimedOut = false
    const timedController = abortController
    // 超时信号：即使某个来源实现完全不理 signal，Promise.race 也能让 job 在 deadline 收尾
    let resolveSyncTimeout
    const syncTimeoutSignal = new Promise((resolve) => {
      resolveSyncTimeout = resolve
    }).then(() => {
      throw Object.assign(new Error(SYNC_TIMEOUT_MESSAGE), { code: SYNC_TIMEOUT_CODE })
    })
    const timeoutTimer = setTimeout(() => {
      syncTimedOut = true
      resolveSyncTimeout?.()
      // 只中止本次运行捕获到的 controller，避免误伤之后开始的同步
      timedController.abort(Object.assign(new Error(SYNC_TIMEOUT_MESSAGE), { code: SYNC_TIMEOUT_CODE }))
    }, SYNC_TIMEOUT_MS)
    timeoutTimer.unref?.()
    const clearSyncTimeout = () => clearTimeout(timeoutTimer)
    syncState = {
      running: true,
      phase: 'catalog',
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: '正在拉取市场目录',
      errors: [],
      progress: {
        ...Object.fromEntries(sourceConfig.sources.map((source) => [source.id, {
          status: selected.some((candidate) => candidate.id === source.id) ? 'pending' : 'skipped',
          done: 0,
          total: 0,
          error: null,
        }])),
        compat: { status: 'pending', done: 0, total: 0, error: null },
      },
    }

    const job = async () => {
      const results = await Promise.all(selected.map(async (source) => {
        try {
          // 竞速超时信号：任何一个源永不返回（甚至不理 signal）都不会挂住整次同步
          return await Promise.race([runSource(source, signal), syncTimeoutSignal])
        } catch (error) {
          // 超时时不再整体抛出：已拿到的源照样落盘，超时的源在 errors 里点名
          if (signal.aborted && !syncTimedOut) throw error
          const text = syncTimedOut ? SYNC_TIMEOUT_MESSAGE : message(error)
          syncState.progress[source.id] = { status: 'error', done: 0, total: 0, error: text }
          syncState.errors.push(source.name + ': ' + text)
          markSourceFailure(source.id, text)
          return null
        }
      }))
      // 先落盘逐源健康状态：后面构建阶段即使抛错，失败计数也不会跟着丢
      flushSourceHealth()

      if (signal.aborted && !syncTimedOut) throw signal.reason ?? new Error('sync cancelled')
      const successful = results.filter(Boolean)
      const sourceRows = successful.flatMap((result) => result.items)
      if (sourceRows.length === 0) throw new Error('所有启用的市场源都没有返回数据')

      syncState.phase = 'build'
      syncState.message = '正在去重、合并与计算风评'
      const installed = getInstalledPackages(profileDir)
      const built = buildCatalog({
        sourceRows,
        compat: compat.entries,
        installed,
        profileName,
        now: Date.now(),
        rules: scoringRules,
      })
      // 差异必须拿「上一份目录」对「这一份目录」算，且下架判定只信本轮成功的来源：
      // 某个源超时/报错时它的条目会凭空消失，那不能算别人下架。
      const previousRows = rows
      const previousGeneratedAt = cacheGeneratedAt
      const diffed = diffRows(previousRows, built, {
        syncedSources: successful.map((result) => result.source.id),
        previousGeneratedAt,
        now: new Date().toISOString(),
      })
      rows = diffed.rows
      syncDiff = diffed.summary
      rebuildRowIndex()
      cacheGeneratedAt = new Date().toISOString()
      cacheExists = true
      const nextSourceCounts = {}
      for (const result of successful) nextSourceCounts[result.source.id] = result.items.length
      sourceCounts = nextSourceCounts
      meta = {
        generatedAt: cacheGeneratedAt,
        runtime,
        profileName,
        sources: Object.fromEntries(successful.map((result) => [result.source.id, result.meta])),
        sourceCounts: nextSourceCounts,
        counts: countRows(rows),
        compatTotal: rows.filter((row) => row.pkg).length,
        diff: syncDiff,
      }
      refreshCompatOnRows()
      refreshUpdateOnRows()
      saveCatalogCache()
      saveCompatCache()

      syncState.phase = 'compat'
      syncState.message = '正在用 npm 元数据判断 DSH 兼容性'
      const packages = rows
        .filter((row) => row.pkg)
        .map((row) => ({
          pkg: row.pkg,
          priority:
            (Number.isFinite(row.score) ? 1000 : 0) +
            (row.featured ? 500 : 0) +
            Math.min(400, row.installers || 0) +
            (row.installed ? 300 : 0) +
            (row.verification?.installCheck === 'passed' ? 200 : 0) +
            Math.min(100, row.heat || 0),
        }))
      const plan = compat.plan(packages, { force })
      syncState.progress.compat = { status: 'checking', done: compat.done, total: compat.total, error: null }
      if (plan.queued > 0) {
        while (compat.running) {
          if (signal.aborted && !syncTimedOut) {
            compat.cancel()
            throw signal.reason ?? new Error('sync cancelled')
          }
          // 双保险：除了 signal，再用 Date.now() 差值兜底，兼容性检测同样受总时长约束
          if (syncTimedOut || Date.now() >= syncDeadline) {
            syncTimedOut = true
            compat.cancel()
            syncState.errors.push(SYNC_TIMEOUT_MESSAGE + '，兼容性检测未完成')
            break
          }
          syncState.progress.compat = {
            status: 'checking',
            done: compat.done,
            total: compat.total,
            error: null,
          }
          syncState.message = `兼容性检测 ${compat.done.toLocaleString('en-US')}/${compat.total.toLocaleString('en-US')}`
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
      // 超时也要保留部分成功的结果：已落盘的 rows 不动，只把状态标为完成并说明有源超时
      syncState.progress.compat = syncTimedOut
        ? { status: 'done', done: compat.done, total: compat.total, error: SYNC_TIMEOUT_MESSAGE }
        : { status: 'done', done: compat.done, total: compat.total, error: null }
      clearSyncTimeout()
      syncState.running = false
      syncState.phase = 'done'
      // partial 只表示“部分来源超时但目录已保留”，不影响 running/phase 的既有语义
      syncState.partial = syncTimedOut
      syncState.finishedAt = new Date().toISOString()
      syncState.message = syncTimedOut ? '同步完成（部分来源超时，已保留拿到的数据）' : '同步完成'
      if (trigger === 'schedule') {
        sourceConfig.lastAutoRefreshAt = syncState.finishedAt
        saveConfig()
      }
      saveCompatCache()
      // compat 跑完后 npm latest 是新鲜的：先按它刷一遍更新徽标，再后台请官方确认。
      refreshUpdateOnRows()
      void startUpdateCheck({ force: false })
      scheduleNextRefresh()
      logger.info?.(`[market-lens] sync complete: ${rows.length} plugins from ${successful.length} source(s)`)
    }

    void job().catch((error) => {
      clearSyncTimeout()
      flushSourceHealth()
      // 超时也是 abort，但不能当成用户取消：否则会误报“同步已取消”，掩盖真正的失败原因
      if (signal.aborted && !syncTimedOut) {
        syncState.running = false
        syncState.phase = 'cancelled'
        syncState.message = '同步已取消'
        syncState.finishedAt = new Date().toISOString()
        scheduleNextRefresh()
        return
      }
      syncState.running = false
      syncState.phase = 'error'
      syncState.finishedAt = new Date().toISOString()
      // 走到这里说明没有任何源可用；把总时长超限写进消息，而不是笼统的“没有数据”
      syncState.message = syncTimedOut ? message(error) + '（' + SYNC_TIMEOUT_MESSAGE + '）' : message(error)
      if (!syncState.errors.includes(syncState.message)) syncState.errors.push(syncState.message)
      scheduleNextRefresh()
      logger.error?.('[market-lens] sync failed: ' + syncState.message)
    })

    return statusBody()
  }

  function addSourceFromConfig(source) {
    sourceConfig.sources.push(source)
    const saved = saveConfig()
    if (!saved.ok) {
      // 写盘失败就不能把来源留在内存里，否则刷新后界面会多出一个磁盘上并不存在的源
      sourceConfig.sources = sourceConfig.sources.filter((candidate) => candidate.id !== source.id)
      return saved
    }
    scheduleNextRefresh()
    return saved
  }

  async function handle(req, res) {
    if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: 'invalid request body: ' + message(error) })
    }
    const op = String((body && body.op) || '')
    try {
      if (op === 'status') return sendJson(res, 200, statusBody())

      if (op === 'sync') {
        return sendJson(res, 200, startSync({
          force: Boolean(body.force),
          sourceIds: Array.isArray(body.sources) ? body.sources : undefined,
          trigger: typeof body.trigger === 'string' ? body.trigger : 'manual',
        }))
      }

      if (op === 'cancel') {
        if (abortController) abortController.abort(new Error('cancelled by user'))
        compat.cancel()
        return sendJson(res, 200, { ok: true })
      }

      if (op === 'settings.set') {
        const hasInterval = body.refreshIntervalMinutes !== undefined && body.refreshIntervalMinutes !== null
        const hasSafeView = typeof body.safeView === 'boolean'
        if (!hasInterval && !hasSafeView) return sendJson(res, 400, { ok: false, error: '没有可保存的设置项' })
        const interval = hasInterval ? Number(body.refreshIntervalMinutes) : sourceConfig.refreshIntervalMinutes
        if (hasInterval && !REFRESH_OPTIONS.includes(interval)) {
          return sendJson(res, 400, { ok: false, error: '不支持的刷新间隔' })
        }
        const previousInterval = sourceConfig.refreshIntervalMinutes
        const previousSafeView = sourceConfig.safeView !== false
        if (hasInterval) sourceConfig.refreshIntervalMinutes = interval
        if (hasSafeView) sourceConfig.safeView = body.safeView
        const saved = saveConfig()
        if (!saved.ok) {
          // 写盘失败就回滚内存值，避免下一次 status 显示一个磁盘上并不存在的设置
          sourceConfig.refreshIntervalMinutes = previousInterval
          sourceConfig.safeView = previousSafeView
          return sendJson(res, 500, {
            ok: false,
            error: '设置未保存：' + saved.error,
            settings: settingsBody(),
            sourceConfig: publicSourceConfig(sourceConfig),
          })
        }
        if (hasInterval) scheduleNextRefresh()
        return sendJson(res, 200, { ok: true, settings: settingsBody(), sourceConfig: publicSourceConfig(sourceConfig) })
      }

      if (op === 'sources.toggle') {
        const id = String(body.id || '')
        const source = sourceConfig.sources.find((candidate) => candidate.id === id)
        if (!source) return sendJson(res, 404, { ok: false, error: '来源不存在' })
        const previousEnabled = source.enabled
        source.enabled = body.enabled !== false
        const saved = saveConfig()
        if (!saved.ok) {
          // 回滚开关，否则用户会以为改成功了，重启后又变回去
          source.enabled = previousEnabled
          return sendJson(res, 500, {
            ok: false,
            error: '来源开关未保存：' + saved.error,
            sourceConfig: publicSourceConfig(sourceConfig),
            settings: settingsBody(),
          })
        }
        scheduleNextRefresh()
        return sendJson(res, 200, { ok: true, sourceConfig: publicSourceConfig(sourceConfig), settings: settingsBody() })
      }

      if (op === 'sources.add') {
        const detected = await detectSourceKind(String(body.url || ''))
        // 只比整串 URL 会放过 https://a.com/v1/plugins/ 与 https://A.com/v1/plugins 这类同源写法
        const detectedKeys = [sourceUrlKey(detected.url), sourceUrlKey(detected.manifestUrl)].filter(Boolean)
        const duplicate = sourceConfig.sources.find((source) =>
          [sourceUrlKey(source.url), sourceUrlKey(source.manifestUrl)].some((key) => key && detectedKeys.includes(key)),
        )
        if (duplicate) return sendJson(res, 409, { ok: false, error: '该来源已存在', sourceConfig: publicSourceConfig(sourceConfig) })
        const source = createCustomSource({
          kind: detected.kind,
          name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : detected.name,
          url: detected.url,
          manifestUrl: detected.manifestUrl,
        })
        const added = addSourceFromConfig(source)
        if (!added.ok) {
          return sendJson(res, 500, {
            ok: false,
            error: '来源未添加：' + added.error,
            sourceConfig: publicSourceConfig(sourceConfig),
          })
        }
        return sendJson(res, 200, { ok: true, source, sourceConfig: publicSourceConfig(sourceConfig), settings: settingsBody() })
      }

      if (op === 'sources.remove') {
        const id = String(body.id || '')
        const index = sourceConfig.sources.findIndex((source) => source.id === id)
        if (index < 0) return sendJson(res, 404, { ok: false, error: '来源不存在' })
        if (sourceConfig.sources[index].builtin) return sendJson(res, 400, { ok: false, error: '内置来源不能删除，只能停用' })
        const [removed] = sourceConfig.sources.splice(index, 1)
        const saved = saveConfig()
        if (!saved.ok) {
          // 删除没落盘就把来源放回原位，避免界面显示已删除而重启后又出现
          sourceConfig.sources.splice(index, 0, removed)
          return sendJson(res, 500, { ok: false, error: '来源未删除：' + saved.error, sourceConfig: publicSourceConfig(sourceConfig) })
        }
        scheduleNextRefresh()
        return sendJson(res, 200, { ok: true, sourceConfig: publicSourceConfig(sourceConfig) })
      }

      if (op === 'catalog') {
        refreshCompatOnRows()
        refreshInstalledOnRows()
        refreshUpdateOnRows()
        return sendJson(res, 200, {
          ok: true,
          rows: rows.map(publicRow),
          meta: {
            generatedAt: cacheGeneratedAt,
            counts: countRows(rows),
            runtime,
            profileName,
            compatSeq: compat.seq,
            compat: compat.status(),
            sources: meta.sources || null,
            sourceCounts: sourceCounts || {},
            diff: syncDiff,
            updates: updates.status(),
          },
          sourceConfig: publicSourceConfig(sourceConfig),
          sourceHealth: sourceHealth(),
          settings: settingsBody(),
          sync: syncState,
          // 前端据此决定「安装」按钮是否可用，以及当前是否有安装在进行。
          install: {
            available: Boolean(pluginManager),
            busy: installingKey,
          },
        })
      }

      if (op === 'detail') {
        const id = String(body.id || '')
        const row = rows.find((candidate) => candidate.key === id)
        if (!row) return sendJson(res, 404, { ok: false, error: 'plugin not found' })
        const compatEntry = row.pkg ? compat.get(row.pkg) : null
        // 版本差异要打一次 npm packument：抽屉打开时现取，失败只让这一块空着，
        // 不让整个详情 404 —— 版本链是锦上添花，不是详情的前置条件。
        let versionDiff = null
        const update = row.update || updateEntryFor(row)
        const installedVersion = row.installedVersion || (update && update.from) || null
        if (row.pkg && installedVersion && update && update.to) {
          try {
            versionDiff = await updates.chain(row.pkg, { from: installedVersion, to: update.to })
          } catch (error) {
            versionDiff = {
              pkg: row.pkg,
              from: installedVersion,
              to: update.to,
              latest: update.to,
              total: 0,
              versions: [],
              error: message(error),
            }
          }
        }
        return sendJson(res, 200, { ok: true, row: detailRow(row, compatEntry, versionDiff), runtime, updates: updates.status() })
      }

      if (op === 'selfcheck') {
        // 「插件包异常」时要能一眼看出是哪一层出问题：路由在不在、目录缓存有没有、
        // 官方管理器注入到没有、更新检查的最近一次失败是什么。全部只读。
        const updateEntries = updates.snapshot()
        return sendJson(res, 200, {
          ok: true,
          pluginVersion: PLUGIN_VERSION,
          route: ROUTE,
          runtime,
          profile: { name: profileName, dir: profileDir },
          paths: { cache: cachePath, compat: compatPath, updates: updatesPath },
          cache: { exists: cacheExists, generatedAt: cacheGeneratedAt, rows: rows.length },
          manager: { available: Boolean(pluginManager), installBusy: installingKey },
          sources: {
            enabled: enabledSources(sourceConfig).map((source) => source.id),
            total: sourceConfig.sources.length,
            health: sourceHealth(),
          },
          compat: compat.status(),
          updates: {
            status: updates.status(),
            skippedLocal: updateEntries.filter((entry) => entry.source === 'skipped').length,
            errors: updateEntries.filter((entry) => entry.error).slice(0, 20),
          },
          install: { available: Boolean(pluginManager), busy: installingKey },
          installed: installedState(),
          time: new Date().toISOString(),
        })
      }

      if (op === 'updates') {
        return sendJson(res, 200, {
          ok: true,
          status: updates.status(),
          entries: updates.snapshot(),
          available: rows.filter((row) => row.update && row.update.available).length,
        })
      }

      if (op === 'updates.check') {
        // 逐包 inspect 是秒级的 pnpm 调用：请求立刻返回（带 queued 状态），
        // 进度靠 status / updates 轮询；重复点击不会并发起第二轮。
        return sendJson(res, 200, { ok: true, status: queueUpdateCheck({ force: body.force !== false }) })
      }

      if (op === 'config.export') {
        return sendJson(res, 200, {
          ok: true,
          document: exportSourceConfig(sourceConfig, { pluginVersion: PLUGIN_VERSION }),
          sourceConfig: publicSourceConfig(sourceConfig),
        })
      }

      if (op === 'config.import') {
        let document = body.document
        if (typeof document === 'string') {
          try {
            document = JSON.parse(document)
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: '导入内容不是合法 JSON：' + message(error) })
          }
        }
        const result = importSourceConfig(sourceConfig, document, { mode: body.mode })
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error, report: result.report })
        const previousConfig = sourceConfig
        sourceConfig = result.config
        const saved = saveConfig()
        if (!saved.ok) {
          // 导入没落盘就把内存配置整体退回去，避免界面显示的新源在重启后消失
          sourceConfig = previousConfig
          return sendJson(res, 500, { ok: false, error: '配置未导入：' + saved.error, report: result.report })
        }
        scheduleNextRefresh()
        return sendJson(res, 200, {
          ok: true,
          report: result.report,
          sourceConfig: publicSourceConfig(sourceConfig),
          settings: settingsBody(),
          sourceHealth: sourceHealth(),
        })
      }

      if (op === 'compat') {
        return sendJson(res, 200, { ok: true, ...compat.delta(Number(body.since) || 0) })
      }

      if (op === 'install') {
        logInstall('info', 'install.request', { key: body.key || body.id || null, spec: body.spec || null, hasTarget: Boolean(body.target), approved: Array.isArray(body.approvedBuilds) ? body.approvedBuilds.length : 0 })
        const key = String(body.key || body.id || '')
        const target = installTargetSnapshot(body.target)
        const resolved = resolveInstallRow(key, target)
        const row = resolved.row
        // 自定义安装页只发 spec、不带目录行：以前这里先判 row 再解析 spec，
        // 于是「直接输入包名安装」必然 404「目录里找不到该条目」，而页面文案
        // 却明说支持。现在先把 spec 解析出来，两者有一个能装就继续。
        const manual = parseManualSpec(body.spec)
        if (!row && !manual) {
          logInstall('warn', 'install.unresolved', { key: key || '(empty)', spec: body.spec || null, origin: resolved.origin, rows: rows.length })
          return sendJson(res, 404, {
            ok: false,
            error: body.spec
              ? '这个安装目标不是合法的 npm 包名 / GitHub 地址（支持 pkg、pkg@1.2.3、@scope/pkg、github:owner/repo、https://github.com/owner/repo）。'
              : '目录里找不到该条目，安装请求也没有携带目标信息；请刷新目录后重试，或从详情里复制安装命令。',
          })
        }
        // 先按目录行算 spec；目录里没有这一行时，再依次试：请求里显式的 spec
        // （自定义安装页给的就是这个）、快照里的 pkg/repo、行内 installCommand。
        const spec = (row ? installSpecFor(row) : null)
          || manual
          || installSpecFromCommand(row?.installCommand || target?.installCommand)
        if (!spec) {
          logInstall('warn', 'install.no-spec', { key: key || '(empty)', origin: resolved.origin, installCommand: row?.installCommand || target?.installCommand || null })
          return sendJson(res, 400, {
            ok: false,
            error: '该条目没有可一键安装的目标：既没有 npm 包名，也没有可表达的 GitHub 安装地址；请刷新目录后重试，或从详情里复制安装命令。',
          })
        }
        // 官方插件管理器可能没加载（非 Desktop profile / 被停用），这时必须明确拒绝，
        // 不能让用户以为装上了。
        const manager = pluginManager
        if (!manager || typeof manager.installBundle !== 'function') {
          logInstall('error', 'install.no-manager', { spec, origin: resolved.origin, manager: manager ? typeof manager.installBundle : 'null' })
          return sendJson(res, 503, { ok: false, error: '当前未启用官方插件管理器，无法一键安装；请用复制命令手动安装' })
        }
        if (installingKey) {
          logInstall('warn', 'install.busy', { spec, origin: resolved.origin, busy: installingKey })
          return sendJson(res, 409, { ok: false, error: '已有安装任务在进行中：' + installingKey })
        }
        const approvedBuilds = Array.isArray(body.approvedBuilds)
          ? body.approvedBuilds.filter((name) => typeof name === 'string' && name.length > 0 && name.length <= 214).slice(0, 32)
          : []
        installingKey = spec
        const startedAt = Date.now()
        // 目录里的版本号来自第三方市场，可能已经过期（甚至根本不存在于 npm），
        // 所以第一次失败后按 pnpm 的具体报错尝试一次降级目标：pkg@x.y.z → pkg、
        // github:o/r#path:x → github:o/r。降级用过就写进响应，前端会明说装的是哪个目标。
        let effectiveSpec = spec
        let fellBackFrom = null
        try {
          const options = { enabled: true, saveExact: true }
          if (approvedBuilds.length) options.approvedBuilds = approvedBuilds
          let result
          try {
            result = await manager.installBundle(effectiveSpec, options)
          } catch (cause) {
            const firstDetail = message(cause)
            const fallback = fallbackInstallSpec(effectiveSpec, firstDetail)
            logInstall('warn', 'install.attempt-failed', { key: key || '(empty)', spec: effectiveSpec, origin: resolved.origin, approved: approvedBuilds.length, fallback: fallback || null, detail: firstDetail })
            if (!fallback) throw cause
            logger?.info?.('[market-lens] install fallback ' + effectiveSpec + ' -> ' + fallback + ' (' + firstDetail + ')')
            fellBackFrom = effectiveSpec
            effectiveSpec = fallback
            logInstall('warn', 'install.fallback', { key: key || '(empty)', spec: effectiveSpec, fellBackFrom, origin: resolved.origin, detail: firstDetail })
            result = await manager.installBundle(effectiveSpec, options)
          }
          const pendingBuilds = Array.isArray(result?.pendingBuilds)
            ? result.pendingBuilds.filter((name) => typeof name === 'string' && name)
            : []
          if (pendingBuilds.length) {
            logInstall('warn', 'install.pending-builds', { key: key || '(empty)', spec: effectiveSpec, fellBackFrom, origin: resolved.origin, ms: Date.now() - startedAt, pendingBuilds })
            return sendJson(res, 409, {
              ok: false,
              code: 'build-approval-required',
              spec: effectiveSpec,
              fellBackFrom,
              pendingBuilds,
              error: '安装需要允许构建脚本：' + pendingBuilds.join(', '),
            })
          }
          // 15 秒缓存里还是装之前的依赖表，不清掉这一轮 refresh 会把刚装好的行写回未安装。
          invalidateInstalledCache()
          refreshInstalledOnRows()
          logger?.info?.('[market-lens] install ok spec=' + effectiveSpec + ' origin=' + String(resolved.origin) + ' ' + (Date.now() - startedAt) + 'ms')
          logInstall('info', 'install.ok', { key: row?.key || key || null, spec: effectiveSpec, fellBackFrom, origin: resolved.origin || 'manual', ms: Date.now() - startedAt, summary: summarizeInstallResult(result) })
          return sendJson(res, 200, {
            ok: true,
            key: row?.key || key || null,
            origin: resolved.origin || 'manual',
            spec: effectiveSpec,
            fellBackFrom,
            installed: installedState(),
            result: summarizeInstallResult(result),
          })
        } catch (cause) {
          // 有的管理器把 pendingBuilds 直接挂在错误对象上，有的只写进错误文本；
          // 两条都读，避免用户在第一次失败后拿不到“允许构建并重试”。
          const pendingBuilds = Array.isArray(cause?.pendingBuilds) && cause.pendingBuilds.length
            ? cause.pendingBuilds.filter((name) => typeof name === 'string' && name).slice(0, 32)
            : pendingBuildNames(cause)
          if (pendingBuilds.length) {
            logInstall('warn', 'install.pending-builds', { key: key || '(empty)', spec, fellBackFrom, origin: resolved.origin, ms: Date.now() - startedAt, pendingBuilds, fromError: true })
            return sendJson(res, 409, {
              ok: false,
              code: 'build-approval-required',
              spec,
              pendingBuilds,
              error: '安装需要允许构建脚本：' + pendingBuilds.join(', '),
            })
          }
          const detail = message(cause)
          // 降级过的话 effectiveSpec 已经不带 #path: 了，所以用第一次尝试的目标判断。
          const attemptedSpec = fellBackFrom || effectiveSpec
          const subdirMissing = attemptedSpec.includes('#path:') && /ERR_PNPM_INVALID_PATH|not a valid sub-directory/i.test(detail)
          logger?.info?.('[market-lens] install failed key=' + (key || '(empty)') + ' origin=' + String(resolved.origin) + ' spec=' + effectiveSpec + ' error=' + detail)
          logInstall('error', 'install.failed', { key: key || '(empty)', spec: effectiveSpec, attemptedSpec, fellBackFrom, origin: resolved.origin, ms: Date.now() - startedAt, code: subdirMissing ? 'subdir-missing' : null, detail, stack: cause?.stack ? String(cause.stack).split('\n').slice(0, 4).join(' | ') : null })
          return sendJson(res, 500, {
            ok: false,
            spec: effectiveSpec,
            fellBackFrom,
            origin: resolved.origin,
            code: subdirMissing ? 'subdir-missing' : undefined,
            error: subdirMissing
              ? detail + '\n源数据里的子目录在当前仓库中不存在（可能已改名或删除）；请刷新目录，或打开仓库确认路径后复制命令安装。'
              : detail,
          })
        } finally {
          installingKey = null
        }
      }

      /**
       * 升级已安装插件到指定版本。
       *
       * 与 install 分开是有理由的：install 装的是目录说的版本（可能压根不在 npm 上，
       * 于是走降级），而升级必须**正好**装到目标版本 —— 升不到目标版本就等于升级失败，
       * 悄悄装个 latest 反而危险。所以这里不做 pkg@x.y.z → pkg 的降级，
       * 版本号必须由调用方显式给出，且必须是精确版本。
       */
      if (op === 'upgrade') {
        const pkg = typeof body.pkg === 'string' ? body.pkg.trim() : ''
        const upgradeLog = (level, tag, data = {}) => opLog.write(level, tag, { op: 'upgrade', pkg: pkg || null, spec: null, ms: null, ...data })
        upgradeLog('info', 'upgrade.request', { version: body.version || null, approved: Array.isArray(body.approvedBuilds) ? body.approvedBuilds.length : 0 })
        if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)) {
          upgradeLog('warn', 'upgrade.invalid-pkg', { raw: body.pkg ?? null })
          return sendJson(res, 400, { ok: false, error: '升级目标必须是合法的 npm 包名' })
        }
        const version = exactVersion(body.version)
        if (!version) {
          upgradeLog('warn', 'upgrade.invalid-version', { version: body.version ?? null })
          return sendJson(res, 400, { ok: false, error: '升级目标版本必须是精确版本号（如 1.2.3）' })
        }
        const manager = pluginManager
        if (!manager || typeof manager.installBundle !== 'function') {
          upgradeLog('error', 'upgrade.no-manager', { version, manager: manager ? typeof manager.installBundle : 'null' })
          return sendJson(res, 503, { ok: false, error: '当前未启用官方插件管理器，无法升级；请复制命令手动升级' })
        }
        if (installingKey) {
          upgradeLog('warn', 'upgrade.busy', { version, busy: installingKey })
          return sendJson(res, 409, { ok: false, error: '已有安装任务在进行中：' + installingKey })
        }
        if (!isRegistryCandidate(pkg, null)) {
          upgradeLog('warn', 'upgrade.not-registry', { version })
          return sendJson(res, 400, { ok: false, error: '本地 / link 安装的插件没有 registry 版本，不能按版本升级' })
        }
        const spec = pkg + '@' + version
        const approvedBuilds = Array.isArray(body.approvedBuilds)
          ? body.approvedBuilds.filter((name) => typeof name === 'string' && name.length > 0 && name.length <= 214).slice(0, 32)
          : []
        installingKey = spec
        const startedAt = Date.now()
        try {
          const options = { enabled: true, saveExact: true }
          if (approvedBuilds.length) options.approvedBuilds = approvedBuilds
          const result = await manager.installBundle(spec, options)
          const pendingBuilds = Array.isArray(result?.pendingBuilds)
            ? result.pendingBuilds.filter((name) => typeof name === 'string' && name)
            : []
          if (pendingBuilds.length) {
            upgradeLog('warn', 'upgrade.pending-builds', { version, spec, ms: Date.now() - startedAt, pendingBuilds })
            return sendJson(res, 409, {
              ok: false,
              code: 'build-approval-required',
              pkg,
              version,
              spec,
              pendingBuilds,
              error: '升级需要允许构建脚本：' + pendingBuilds.join(', '),
            })
          }
          invalidateInstalledCache()
          // 升级之后缓存的「最新版本」已经不对了：丢掉这一包的结论，下次检查会重问。
          const previousEntry = updates.get(pkg)
          updates.entries.delete(String(pkg).toLowerCase())
          void previousEntry
          refreshInstalledOnRows()
          refreshUpdateOnRows()
          saveUpdatesCache()
          logger?.info?.('[market-lens] upgrade ok spec=' + spec + ' ' + (Date.now() - startedAt) + 'ms')
          upgradeLog('info', 'upgrade.ok', { version, spec, ms: Date.now() - startedAt, summary: summarizeInstallResult(result) })
          return sendJson(res, 200, {
            ok: true,
            pkg,
            version,
            spec,
            installed: installedState(),
            result: summarizeInstallResult(result),
          })
        } catch (cause) {
          const pendingBuilds = Array.isArray(cause?.pendingBuilds) && cause.pendingBuilds.length
            ? cause.pendingBuilds.filter((name) => typeof name === 'string' && name).slice(0, 32)
            : pendingBuildNames(cause)
          if (pendingBuilds.length) {
            upgradeLog('warn', 'upgrade.pending-builds', { version, spec, ms: Date.now() - startedAt, pendingBuilds, fromError: true })
            return sendJson(res, 409, {
              ok: false,
              code: 'build-approval-required',
              pkg,
              version,
              spec,
              pendingBuilds,
              error: '升级需要允许构建脚本：' + pendingBuilds.join(', '),
            })
          }
          const detail = message(cause)
          logger?.info?.('[market-lens] upgrade failed spec=' + spec + ' error=' + detail)
          upgradeLog('error', 'upgrade.failed', { version, spec, ms: Date.now() - startedAt, detail, stack: cause?.stack ? String(cause.stack).split('\n').slice(0, 4).join(' | ') : null })
          return sendJson(res, 500, { ok: false, pkg, version, spec, error: detail })
        } finally {
          installingKey = null
        }
      }

      if (op === 'clear') {
        if (abortController) abortController.abort(new Error('cache cleared'))
        compat.cancel()
        rows = []
        rowIndex = new Map()
        meta = {}
        sourceCounts = {}
        cacheGeneratedAt = null
        cacheExists = false
        syncDiff = { baselined: true, added: 0, updated: 0, removed: 0, total: 0, generatedAt: null, previousGeneratedAt: null }
        updates.clear()
        compat.entries.clear()
        compat.seq = 0
        compat.total = 0
        compat.done = 0
        try {
          fs.rmSync(cachePath, { force: true })
          fs.rmSync(compatPath, { force: true })
          fs.rmSync(updatesPath, { force: true })
        } catch {
          // Best-effort cache deletion.
        }
        syncState = {
          running: false,
          phase: 'idle',
          trigger: 'manual',
          startedAt: null,
          finishedAt: null,
          message: '缓存已清除',
          errors: [],
          progress: idleProgress(),
        }
        scheduleNextRefresh()
        // 清缓存会把日志也清掉，所以保留这条作为「什么时候清过」的锚点。
        opLog.info('cache.cleared', { op: 'clear', rows: 0 })
        return sendJson(res, 200, { ok: true })
      }

      // ── 日志 ────────────────────────────────────────────────────────────────
      // 安装失败时用户只有 toast 上那句被截短的报错；这里把宿主侧的完整链路
      // （请求 → 解析 → 降级 → 结果/异常栈）交给客户端日志页按需翻。
      if (op === 'logs') {
        const entries = opLog.list({
          since: Number.isFinite(body.since) ? Number(body.since) : 0,
          limit: Number.isFinite(body.limit) ? Number(body.limit) : 200,
          level: body.level,
          tag: body.tag,
          query: body.query,
        })
        return sendJson(res, 200, { ok: true, entries, status: opLog.status() })
      }

      if (op === 'logs.clear') {
        const removed = opLog.clear()
        opLog.info('logs.cleared', { op: 'logs', removed })
        return sendJson(res, 200, { ok: true, removed, status: opLog.status() })
      }

      if (op === 'logs.export') {
        const text = opLog.toText({ since: Number.isFinite(body.since) ? Number(body.since) : 0 })
        return sendJson(res, 200, {
          ok: true,
          text,
          filename: 'market-lens-logs-' + stamp() + '.txt',
          status: opLog.status(),
        })
      }

      // ── 评分规则 ────────────────────────────────────────────────────────────
      if (op === 'rules.get') {
        return sendJson(res, 200, {
          ok: true,
          rules: scoringRules,
          document: rulesDocument(scoringRules, { includePresets: true }),
          summary: rulesSummary(),
          savedAt: rulesSavedAt,
          path: rulesPath,
        })
      }

      if (op === 'rules.template') {
        // 模版里自带 readme + 指标/归一化清单，用户照着改就能做出自己的规则。
        return sendJson(res, 200, { ok: true, template: rulesTemplate(), filename: 'market-lens-scoring-rules.template.json' })
      }

      if (op === 'rules.export') {
        return sendJson(res, 200, {
          ok: true,
          document: rulesDocument(scoringRules, { includePresets: true }),
          filename: 'market-lens-scoring-rules-' + stamp() + '.json',
        })
      }

      if (op === 'rules.set') {
        const outcome = commitRules(body.rules ?? body.document ?? body, { source: body.source === 'preset' ? 'preset' : 'file', presetId: body.presetId || null })
        if (!outcome.ok) return sendJson(res, 400, { ok: false, error: outcome.error, issues: outcome.issues })
        return sendJson(res, 200, { ok: true, summary: rulesSummary(), counts: countRows(rows), rules: outcome.rules })
      }

      if (op === 'rules.import') {
        const outcome = commitRules(body.rules ?? body.document ?? body, { source: 'file', presetId: null })
        if (!outcome.ok) return sendJson(res, 400, { ok: false, error: outcome.error, issues: outcome.issues })
        return sendJson(res, 200, { ok: true, summary: rulesSummary(), counts: countRows(rows), rules: outcome.rules })
      }

      if (op === 'rules.reset') {
        const outcome = resetRules()
        if (!outcome.ok) return sendJson(res, 500, { ok: false, error: outcome.error, summary: rulesSummary() })
        return sendJson(res, 200, { ok: true, summary: rulesSummary(), counts: countRows(rows), rules: scoringRules })
      }

      if (op === 'rules.preset') {
        const presetId = String(body.id || body.presetId || '')
        const preset = BUILT_IN_PRESETS.find((item) => item.id === presetId)
        if (!preset) return sendJson(res, 404, { ok: false, error: '没有这个内置预设：' + presetId, presets: BUILT_IN_PRESETS.map((item) => item.id) })
        const outcome = commitRules(preset.rules, { source: 'preset', presetId })
        if (!outcome.ok) return sendJson(res, 400, { ok: false, error: outcome.error, issues: outcome.issues })
        return sendJson(res, 200, { ok: true, summary: rulesSummary(), counts: countRows(rows), rules: outcome.rules })
      }

      return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op })
    } catch (error) {
      logger.warn?.('[market-lens] request failed: ' + message(error))
      return sendJson(res, 400, { ok: false, error: message(error) })
    }
  }

  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      try {
        const table = wctx.webServer.exact
        if (table && typeof table.has === 'function' && table.has(ROUTE)) return () => {}
        return wctx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: (req, res) => handle(req, res),
        })
      } catch (error) {
        logger.warn?.('[market-lens] route registration failed: ' + message(error))
        return () => {}
      }
    })
    wctx.effect(() => () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      if (abortController) abortController.abort(new Error('plugin disposed'))
      compat.cancel()
      updates.cancel()
    })
  })

  scheduleNextRefresh()
}
