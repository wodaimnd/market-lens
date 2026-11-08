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
import { spawnSync } from 'node:child_process'
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
import { fetchJson, pickText, sleep } from './lib/util.js'
import { inspectInstalledHealth, parsePatchRows, classifyRowName } from './lib/health.js'
import { FAILURE_LAYERS, classifyInstallFailure, isAlreadyPresent } from './lib/install-codes.js'
import { buttonInfoFor, buttonStateOf, BUTTON_STATES } from './lib/button-state.js'
import {
  catalogStaleness,
  conditionalOf,
  confirmFetched,
  confirmNotModified,
  normalizeSourceCache,
  recordFailure,
  stalenessOf,
} from './lib/source-cache.js'
import { activationOf, collectActivation, mergeActivation } from './lib/activation.js'
import { POSTINSTALL_VERDICTS, inspectPostinstall } from './lib/postinstall.js'
import { STORE_VERDICTS, inspectStore, isStoreMismatchError } from './lib/store-guard.js'
import { COMPATIBILITY_FILE, EXEMPT_RESULT, grantExemption, hasExemption, readCompatibility } from './lib/exempt.js'
import { OpLog } from './lib/op-log.js'
import {
  BUILT_IN_PRESETS,
  BUILT_IN_RULES,
  METRIC_REGISTRY,
  NORM_REGISTRY,
  MarketRulesError,
  RULES_FILE,
  RULES_LIBRARY_FILE,
  RULES_LIBRARY_VERSION,
  activeEntry,
  countFactors,
  describeEntry,
  findEntry,
  libraryChoices,
  mergeLibrary,
  newRuleEntryId,
  normalizeRules,
  rulesDocument,
  rulesTemplate,
  prepareMetrics,
  scoreGroup,
  scoreLabelFromRules,
  serializeLibrary,
  validateRules,
} from './lib/rules.js'

/** 模版页上「三组分数是干什么的」的说明：界面直接渲染，不再只给一段长文本。 */
const GROUP_GUIDE = [
  { key: 'market', label: { zh: '市场风评', en: 'Market score' }, desc: { zh: '主排序分。表格「市场风评」列用的就是它。', en: 'Primary score; drives the Market column.' } },
  { key: 'community', label: { zh: '民间风评', en: 'Community score' }, desc: { zh: '社区活跃分。没有 Star 数的条目不显示这一列。', en: 'Community activity; hidden when a row has no stars.' } },
  { key: 'heat', label: { zh: '热度', en: 'Heat' }, desc: { zh: '默认排序键。安装量 / Star / 下载量加权，缺项自动重新分配权重。', en: 'Default sort key; missing metrics re-distribute weight.' } },
]

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
// 自定义规则份数上限：下拉框再长就没法用了，且每条都要参与全表重算。
const MAX_USER_ENTRIES = 20

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

/**
 * 这个失败是不是「文件被占用」。
 *
 * Windows 上 pnpm 替换 node_modules 里的包时要先 rename 到 _tmp_*，
 * 而 DSH 正在加载那个包（宿主进程持有它的文件句柄），rename 就会被拒：
 *
 *   [ERR_PNPM_EPERM] [importPackage ...\node_modules\@tt-a1i\archify-dsh]
 *   EPERM: operation not permitted, rename '..._tmp_16340_11' -> '...archify-dsh'
 *
 * 这类失败有三个特征，和「版本不存在」完全不同：
 *   1. 不是目标的问题，换个 spec 一样失败 —— 所以绝不能走降级；
 *   2. 锁是瞬时的，宿主放弃句柄后重试就能过；
 *   3. 用户能做的是关掉 DSH 再装，或者等一会儿重试。
 *
 * Linux/macOS 上对应的错误是 EBUSY / ETXTBSY，一并认。
 * 导出是为了让测试直接钉住这套判定 —— 判错一次就会拿错误的目标去重装。
 */
export function isFileBusy(error) {
  const text = message(error)
  if (/ERR_PNPM_EPERM|EPERM|EBUSY|ETXTBSY|resource busy|being used by another process/i.test(text)) return true
  // pnpm 的 importPackage 阶段报 rename 失败，一定是占用（不是权限问题：
  // 真没权限时连 _tmp_ 都写不出来，错误会出现在更早的步骤）
  return /rename.*_tmp_.*->/i.test(text)
}

/** 从 pnpm 报错里挖出被占用的包名，用来给用户一句能行动的提示。 */
export function busyPackageFrom(error) {
  const text = message(error)
  const imported = /\[importPackage ([^\]]+)\]/i.exec(text)
  if (imported) return imported[1].trim()
  const renamed = /rename ['"]?([^'"]*_tmp_[^'"]*)['"]?\s*->\s*['"]?([^'"]+)['"]?/i.exec(text)
  if (renamed) {
    // _tmp_ 那段形如 ...\archify-dsh_tmp_16340_11，取目标路径更准
    return renamed[2].trim()
  }
  return null
}
// 实际收到的 manifestVersion 可能是数字、缺失或对象：统一转成可读文本再拼进错误信息
const versionText = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))

// 同时只允许一个安装任务：pnpm 会改同一个 profile 的 manifest 与 lockfile，
// 并发安装互相覆盖，这里用 spec 记录谁在装，也用于给前端回显。
let installingKey = null

/**
 * 上一次安装失败的 key 集合（内存，不落盘）。
 * 存在的理由：client 的 actionBusy 只在当前页面活，目录一刷新就丢了；
 * 而「这一行刚刚装失败过」应当跟着行本身 —— 否则刷新后按钮又变回「装」，
 * 用户以为上次成功了。重启后清空是对的（重启意味着重新开始）。
 */
const installFailures = new Set()

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

/**
 * 从 spec 里猜出这条安装最终装进去的包名。
 *
 * installBundle 的返回值里通常带 name（或 bundle / target），但那些字段
 * 在不同版本的宿主上不一定都有；而「批准构建」之类的分支又不返回结果。
 * 所以先从返回值取，取不到再从 spec 里解析（pkg@1.2.3 / @scope/pkg@1.2.3 /
 * github:owner/repo#path:… 都要能折出来）。
 */
export function packageNameFromSpec(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (!text) return null
  // 本地路径 / link: / file: 这类没有「包名」可判，交给调用方跳过挂载校验
  if (/^(?:link|file|portal|workspace):/i.test(text) || /^[a-z]:[\\/]/i.test(text) || /^\.{0,2}[\\/]/.test(text)) return null
  if (/^github:/i.test(text) || /^git\+|^git@/i.test(text) || /^https?:\/\/github\.com\//i.test(text)) {
    const repo = /^(?:github:|git\+https:\/\/github\.com\/|https?:\/\/github\.com\/)([^/#]+)\/([^/#]+?)(?:\.git)?(?:[#/?].*)?$/i.exec(text)
    // GitHub 安装的包名默认取仓库名；真正的包名由仓库里的 package.json 决定，
    // 猜错就只是「校验不出来」，不会误判成未挂载
    return repo ? repo[2].replace(/\.git$/i, '').toLowerCase() : null
  }
  if (text.startsWith('@')) {
    const scoped = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:@[^\s]+)?$/i.exec(text)
    return scoped ? scoped[1].toLowerCase() : null
  }
  const plain = /^([a-z0-9][a-z0-9._-]*)(?:@[^\s]+)?$/i.exec(text)
  return plain ? plain[1].toLowerCase() : null
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
    // 按钮状态的唯一来源（见 lib/button-state.js）。client 只渲染，不再自己推：
    // 装 / 更新 / 已是最新 / 已装（本地）/ 重试 / 复制命令 六种语义只在这一处实现。
    button: row.button || null,
    // 已装时那个包在 profile 里的 spec —— 用来判「查过没有新版」还是「根本没法比」
    installedSpec: row.installedSpec ?? null,
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
  // 逐源条件请求记录（ETag / lastModified / lastConfirmedAt）。
  // 落在 source-config.json 里而不是 catalog.json：它描述的是"源的状态"，
  // 不是"目录的内容"，跟着配置走才不会被 clearCatalog 顺手清掉。
  let sourceCaches = typeof sourceConfig.sourceCaches === 'object' && sourceConfig.sourceCaches
    ? sourceConfig.sourceCaches
    : {}
  let cacheDirty = false
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

  // 规则库：所有可选口径都存成条目，用户在下拉框里选一个启用。
  // 老版本的「单文件」口径（scoring-rules.json）在首次启动时会被迁进来，
  // 迁完即删，避免两份真相长期并存。
  const rulesPath = path.join(cacheDirectory(), RULES_FILE)
  const libraryPath = path.join(cacheDirectory(), RULES_LIBRARY_FILE)
  let rulesLibrary = loadRulesLibrary()
  let scoringRules = activeEntry(rulesLibrary).rules
  let rulesIssue = rulesLibrary.issues.length ? rulesLibrary.issues[0] : null
  let appliedRulesFingerprint = null
  const rulesListeners = new Set()

  function loadRulesLibrary() {
    // readJson 把「文件不存在」和「JSON 坏了」都归成 null，但这两件事对用户
    // 完全不是一回事：前者是没自定义，后者是改坏了——必须说清楚，否则规则
    // 悄悄退回内置口径，用户只会觉得「我改的没用」。
    const stored = fs.existsSync(libraryPath) ? readJson(libraryPath) : null
    let migrated = null
    let base = stored

    if (!base && fs.existsSync(rulesPath)) {
      // 0.6.0 及以前的单文件口径：搬成库里的一个用户条目并设为当前。
      const old = (() => {
        try { return readJson(rulesPath) } catch { return null }
      })()
      if (old) {
        const result = validateRules(old)
        if (result.ok) {
          migrated = {
            id: 'migrated-' + newRuleEntryId(result.rules.name || 'legacy'),
            name: result.rules.name || '旧版自定义规则',
            description: result.rules.description || '从单文件规则迁移而来',
            savedAt: typeof old.updatedAt === 'string' ? old.updatedAt : new Date().toISOString(),
            rules: result.rules,
          }
          opLog.info('rules.migrated', { name: migrated.name, id: migrated.id })
        } else {
          opLog.warn('rules.migrate.skipped', { detail: result.issues.join('；') })
        }
      }
    }

    const library = mergeLibrary({
      activeId: migrated ? migrated.id : (base?.activeId || null),
      entries: [...(base?.entries || []), ...(migrated ? [migrated] : [])],
      migratedFrom: base?.migratedFrom || (migrated ? 'scoring-rules.json' : null),
    })

    if (!base || migrated) {
      try {
        writeJsonAtomic(libraryPath, { ...serializeLibrary(library), version: RULES_LIBRARY_VERSION })
        // 迁移成功后删掉旧文件：留着它只会让「到底哪份在生效」变成一个谜。
        if (migrated && fs.existsSync(rulesPath)) fs.rmSync(rulesPath, { force: true })
      } catch (error) {
        opLog.warn('rules.library.save.failed', { detail: message(error) })
      }
    }
    if (library.issues.length) opLog.warn('rules.library.issues', { detail: library.issues.join('；') })
    return library
  }

  function saveRulesLibrary() {
    try {
      writeJsonAtomic(libraryPath, { ...serializeLibrary(rulesLibrary), version: RULES_LIBRARY_VERSION })
      return { ok: true }
    } catch (error) {
      opLog.error('rules.library.save.failed', { detail: message(error) })
      return { ok: false, error: message(error) }
    }
  }

  function rulesFingerprint() {
    return createHash('sha1').update(JSON.stringify(scoringRules)).digest('hex').slice(0, 12)
  }

  /** 状态里只放摘要与下拉选项：规则全文有几十 KB，不能每 20 秒随 status 重发一遍。 */
  function rulesSummary() {
    const entry = activeEntry(rulesLibrary)
    return {
      fingerprint: rulesFingerprint(),
      activeId: rulesLibrary.activeId,
      name: entry ? entry.name : scoringRules.name,
      description: entry ? entry.description : (scoringRules.description || ''),
      origin: entry ? entry.origin : 'builtin',
      source: entry ? (entry.origin === 'user' ? 'file' : entry.origin) : 'default',
      savedAt: entry ? entry.savedAt : null,
      issue: rulesIssue,
      isDefault: rulesLibrary.activeId === 'builtin:default',
      labels: { ...scoringRules.labels },
      factorCount: countFactors(scoringRules),
      // 下拉框的全部候选：内置 + 预设 + 用户上传，都在这一个列表里
      choices: libraryChoices(rulesLibrary),
      entryCount: rulesLibrary.entries.length,
      userCount: rulesLibrary.entries.filter((item) => item.origin === 'user').length,
      migratedFrom: rulesLibrary.migratedFrom,
    }
  }

  function onRulesChanged(listener) {
    if (typeof listener !== 'function') return () => {}
    rulesListeners.add(listener)
    return () => rulesListeners.delete(listener)
  }

  function notifyRulesChanged(payload) {
    for (const listener of rulesListeners) {
      try {
        listener(payload)
      } catch {
        // 监听者出错不影响换规则本身
      }
    }
  }

  /**
   * 带重试的 installBundle。
   *
   * 只对「文件占用」重试：这是唯一一类「等一会儿自己会好」的失败。
   * 三次退避 1s / 3s / 6s —— 宿主放弃句柄通常在几百毫秒到几秒内；
   * 等太久用户以为卡死，等太短又白试。
   *
   * 其它失败一律立刻抛：版本不存在、包名非法这些重试一万次也一样。
   */
  async function runInstallWithRetry(manager, spec, options, meta = {}) {
    const delays = [1000, 3000, 6000]
    let attempt = 0
    while (true) {
      try {
        return await manager.installBundle(spec, options)
      } catch (cause) {
        const busy = isFileBusy(cause)
        if (!busy || attempt >= delays.length) throw cause
        const wait = delays[attempt]
        attempt += 1
        const busyPkg = busyPackageFrom(cause)
        opLog.write('warn', 'install.file-busy', {
          op: 'install',
          key: meta.key || null,
          spec,
          origin: meta.origin || null,
          attempt,
          waitMs: wait,
          busyPackage: busyPkg,
          detail: message(cause).slice(0, 400),
        })
        logger?.info?.('[market-lens] install retry ' + attempt + '/' + delays.length + ' in ' + wait + 'ms: file busy' + (busyPkg ? ' (' + busyPkg + ')' : ''))
        await sleep(wait)
      }
    }
  }

  /**
   * 装完之后核对「挂载」这一步。
   *
   * 为什么需要它：pluginManager.installBundle 内部会调 selectBundle 把包装进
   * `dsh.profile.bundles`；只有进了这个列表，下次启动 loader 才会加载它。
   * 这一步是隐式的，安静失败时前端完全看不出来 —— 用户看到「安装成功」，
   * 重启后却发现插件根本不存在，这正是最难查的那类问题。
   *
   * 判定口径：
   *   - 拿不到包名（本地路径 / link / 猜不出的 spec）→ 跳过，不误报；
   *   - 包名在 bundles 里 → mounted；
   *   - 不在 → 明确回报，并给出重启后仍不出现时的下一步。
   *
   * @returns {{packageName: string|null, mounted: boolean, checked: boolean, reason: string|null, isBundle: boolean, bundles: string[]}}
   */
  function inspectMount(spec, result) {
    // 管理器返回的 name 经常带版本（`dsh-mp-automator@0.3.0`），直接拿去和 bundles 比对
    // 永远不等 —— 于是「装好了也没挂载」这种假警报会盖住真正没挂载的那一次。
    // 所以每个候选都先折成纯包名，折不出（本地路径 / link）就跳过，继续试下一个。
    const candidates = result && typeof result === 'object'
      ? [result.bundle, result.name, result.target, result.packageName, spec]
      : [spec]
    let packageName = null
    for (const candidate of candidates) {
      const folded = packageNameFromSpec(typeof candidate === 'string' ? candidate : '')
      if (folded) {
        packageName = folded.toLowerCase()
        break
      }
    }
    if (!packageName) {
      return { packageName: null, mounted: false, checked: false, reason: 'unresolved-package-name', isBundle: false, bundles: [] }
    }
    let manifest
    try {
      manifest = readJson(path.join(profileDir, 'package.json')) || {}
    } catch (error) {
      return { packageName, mounted: false, checked: false, reason: 'profile-unreadable: ' + message(error), isBundle: false, bundles: [] }
    }
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const lowered = bundles.map((entry) => String(entry).toLowerCase())
    const mounted = lowered.includes(packageName)
    // 只有声明了 dsh.bundle 的包才会被加进 bundles。普通依赖（比如只是被拖进来的
    // 传递依赖）永远不会出现，那不是故障，报「没挂载」只会把人引到错误的页面。
    let isBundle = true
    try {
      const installedManifest = readJson(path.join(profileDir, 'node_modules', packageName, 'package.json'))
      if (installedManifest) isBundle = Boolean(installedManifest?.dsh?.bundle)
    } catch {
      // 读不到就按「是 bundle」处理：这是最常见的失败形态，宁可提示也不要沉默
    }
    if (mounted) {
      return { packageName, mounted: true, checked: true, reason: null, isBundle, bundles: lowered }
    }
    if (!isBundle) {
      return { packageName, mounted: false, checked: false, reason: 'not-a-bundle', isBundle: false, bundles: lowered }
    }
    return {
      packageName,
      mounted: false,
      checked: true,
      reason: 'not-in-bundles',
      isBundle,
      bundles: lowered,
    }
  }

  /**
   * 装完之后的落地体检（见 lib/health.js + lib/activation.js）。
   *
   * 前三层是静态的（依赖 / 挂载 / 装载行），第四层是**运行时**的：
   * Cordis 给每个入口建一个 Fiber，只有 active 才算真的挂上了。
   * 三层全对但 fiber failed，表现就是用户说的「装了但不出现」。
   */
  function installedHealth(packageName, spec) {
    let bundles = []
    try {
      const manifest = readJson(path.join(profileDir, 'package.json')) || {}
      bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    } catch {
      // profile 读不到时按空列表判定：不会误判成「已挂载」
    }
    const staticHealth = inspectInstalledHealth({
      profileDir,
      packageName,
      bundles,
      runtimeVersion: runtime?.runtimeVersion ?? runtime?.appVersion ?? null,
      spec: spec ?? null,
    })

    // ---- 第四层：运行时激活状态 ----
    //
    // ctx.loader 不是公开 API，但它就是宿主自己读的那个东西
    // （dsh-host-plugin-inventory 也是 `for (const entry of ctx.loader.entries())`）。
    // 拿不到就退回静态结论：不可知 ≠ 没激活。
    const activation = activationOf(packageName, liveActivation())
    const merged = mergeActivation({
      staticVerdict: staticHealth.verdict,
      activation,
      mounted: Boolean(staticHealth.mounted),
    })

    return {
      ...staticHealth,
      // verdict 现在是四层合成结论：
      //   activated / installed-disabled / installed-not-active / ok / warn / bad / skipped
      verdict: merged.verdict,
      staticVerdict: staticHealth.verdict,
      activation: activation.available ? activation : null,
      detail: merged.detail ?? staticHealth.detail,
    }
  }

  /**
   * 读当前 Loader 里每个入口的 Fiber 状态。
   *
   * 每次都重新读（不缓存）：Fiber 状态是活的，装完之后下一秒可能就从
   * pending 变 active。缓存只会给出过期结论。
   *
   * @returns {Map<string, {phase: string|null, entryId: string|null, disabled: boolean}>}
   */
  function liveActivation() {
    const loader = ctx.loader
    if (!loader || typeof loader.entries !== 'function') return new Map()
    try {
      return collectActivation(loader.entries())
    } catch (error) {
      // loader 正在重组时 entries() 可能抛：这不是插件的问题，当成不可知
      logger?.debug?.('[market-lens] loader.entries() failed: ' + message(error))
      return new Map()
    }
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
   * 启用库里的某一条。切换不动库本身（除了 activeId），所以用户可以在
   * 「自己的口径」和「内置」之间来回对比，上传的东西一直都在。
   */
  function activateEntry(id, { source = null } = {}) {
    const entry = findEntry(rulesLibrary, id)
    if (!entry) return { ok: false, error: '规则库里没有这一条：' + id }
    const previousActive = rulesLibrary.activeId
    rulesLibrary.activeId = entry.id
    scoringRules = entry.rules
    rulesIssue = null
    const saved = saveRulesLibrary()
    if (!saved.ok) {
      // 写盘失败就回滚，否则下次启动会读回一个界面上看不见的 activeId
      rulesLibrary.activeId = previousActive
      scoringRules = activeEntry(rulesLibrary).rules
      return { ok: false, error: '规则选择未保存：' + saved.error }
    }
    const changed = ensureRulesApplied({ force: true })
    opLog.info('rules.activated', {
      id: entry.id,
      name: entry.name,
      origin: entry.origin,
      factors: countFactors(entry.rules),
      rows: rows.length,
      changed,
      source: source || 'manual',
    })
    notifyRulesChanged({ summary: rulesSummary(), rows: rows.length, changed })
    return { ok: true, summary: rulesSummary(), rules: scoringRules, recomputed: changed, rows: rows.length, activeId: entry.id }
  }

  /**
   * 上传一份规则：校验 → 存进规则库 → 启用。
   *
   * 存进去而不是覆盖当前规则，是为了「上传多份，随时切回」。
   * 同名会自动加序号，避免下拉框里出现两条一模一样的名字。
   */
  function addUserEntry(input, { name = null, description = null, activate = true } = {}) {
    const result = validateRules(input)
    if (!result.ok) {
      opLog.warn('rules.rejected', { detail: result.issues.join('；') })
      return { ok: false, error: '规则文件不合法：' + result.issues[0], issues: result.issues }
    }
    const rules = result.rules
    if (rulesLibrary.entries.filter((entry) => entry.origin === 'user').length >= MAX_USER_ENTRIES) {
      return { ok: false, error: '自定义规则最多 ' + MAX_USER_ENTRIES + ' 份，请先删掉几份再上传', issues: [] }
    }
    const baseName = (typeof name === 'string' && name.trim() ? name.trim() : rules.name || '自定义规则').slice(0, 80)
    const finalName = uniqueEntryName(baseName)
    const entry = {
      id: newRuleEntryId(finalName),
      name: finalName,
      description: (typeof description === 'string' && description.trim() ? description.trim() : (rules.description || '')).slice(0, 400),
      origin: 'user',
      builtin: false,
      savedAt: new Date().toISOString(),
      rules: { ...rules, name: finalName },
    }
    const previousActive = rulesLibrary.activeId
    rulesLibrary.entries = [...rulesLibrary.entries, entry]
    if (activate) rulesLibrary.activeId = entry.id
    const saved = saveRulesLibrary()
    if (!saved.ok) {
      rulesLibrary.entries = rulesLibrary.entries.filter((item) => item.id !== entry.id)
      rulesLibrary.activeId = previousActive
      return { ok: false, error: '规则未保存：' + saved.error, issues: [] }
    }
    let changed = false
    if (activate) {
      scoringRules = entry.rules
      rulesIssue = null
      changed = ensureRulesApplied({ force: true })
    }
    opLog.info('rules.added', {
      id: entry.id,
      name: entry.name,
      factors: countFactors(entry.rules),
      activated: activate,
      userCount: rulesLibrary.entries.filter((item) => item.origin === 'user').length,
    })
    notifyRulesChanged({ summary: rulesSummary(), rows: rows.length, changed })
    return { ok: true, entry: { id: entry.id, name: entry.name }, summary: rulesSummary(), rules: entry.rules, activeId: rulesLibrary.activeId, recomputed: changed, rows: rows.length, renamed: finalName !== baseName }
  }

  /** 同名自动加 (2) (3)：下拉框里两条一模一样的名字没法选。 */
  function uniqueEntryName(baseName) {
    const taken = new Set(rulesLibrary.entries.map((entry) => entry.name))
    if (!taken.has(baseName)) return baseName
    for (let index = 2; index < 100; index += 1) {
      const candidate = baseName + ' (' + index + ')'
      if (!taken.has(candidate)) return candidate
    }
    return baseName + ' ' + new Date().toISOString().slice(11, 19)
  }

  /** 删掉库里的一条自定义规则。内置与预设不许删（只能不选它）。 */
  function removeEntry(id) {
    const entry = findEntry(rulesLibrary, id)
    if (!entry) return { ok: false, error: '规则库里没有这一条：' + id }
    if (entry.builtin) return { ok: false, error: '内置规则不能删除，只能切换到别的规则' }
    const index = rulesLibrary.entries.findIndex((item) => item.id === id)
    const removed = rulesLibrary.entries[index]
    const wasActive = rulesLibrary.activeId === id
    rulesLibrary.entries = rulesLibrary.entries.filter((item) => item.id !== id)
    if (wasActive) {
      // 删掉正在用的那份：回退到内置默认，别留一个指向已删除条目的 activeId
      rulesLibrary.activeId = 'builtin:default'
      scoringRules = activeEntry(rulesLibrary).rules
    }
    const saved = saveRulesLibrary()
    if (!saved.ok) {
      rulesLibrary.entries.splice(index, 0, removed)
      rulesLibrary.activeId = wasActive ? id : rulesLibrary.activeId
      scoringRules = activeEntry(rulesLibrary).rules
      return { ok: false, error: '规则未删除：' + saved.error }
    }
    const changed = wasActive ? ensureRulesApplied({ force: true }) : false
    opLog.info('rules.removed', { id: removed.id, name: removed.name, wasActive, changed, userCount: rulesLibrary.entries.filter((item) => item.origin === 'user').length })
    notifyRulesChanged({ summary: rulesSummary(), rows: rows.length, changed })
    return { ok: true, summary: rulesSummary(), removed: { id: removed.id, name: removed.name }, wasActive, activeId: rulesLibrary.activeId, recomputed: changed }
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
    // 条件请求记录跟着配置一起落盘：它描述的是「源的状态」而不是「目录的内容」，
    // 所以 clearCatalog 清缓存时不该顺手把它清掉。
    sourceConfig.sourceCaches = sourceCaches
    const result = saveSourceConfig(sourceConfig)
    if (result.ok) {
      healthDirty = false
      cacheDirty = false
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
    // 条件请求记录也要记失败 —— 但**绝不推进 lastConfirmedAt**。
    // 这是整个 ETag 设计的硬约束：失败不能让目录看起来更新。
    sourceCaches[sourceId] = recordFailure(sourceCaches[sourceId], Date.now())
    cacheDirty = true
  }

  function flushSourceHealth() {
    if (!healthDirty && !cacheDirty) return
    saveConfig()
    healthDirty = false
    cacheDirty = false
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
    // 发布时间缓存一并恢复：那些 entry 里的 publishedAt 就是这么来的。
    // 只恢复值非空的条目（见 restorePublished 的注释）。
    updates.restorePublished(cached.published)
  }

  function saveUpdatesCache() {
    try {
      writeJsonAtomic(updatesPath, {
        version: CACHE_VERSION,
        ...updates.status(),
        entries: updates.snapshot(),
        // 发布时间缓存一起落盘：不落的话每次重启都要为每个可更新包重拉 packument，
        // 那是最贵的一类请求。发布时间一旦发布就不会变，缓存久一点是安全的。
        published: updates.publishedSnapshot(),
      })
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

      // 补查发布时间：让「有更新」的每个包都能算出新鲜度档位。
      //
      // 为什么放在这里而不是 resolve 里：走 compat 缓存那条路径的包，
      // resolve 根本没被调用（它们的「最新版本」来自同步时已算好的 npm latest）。
      // 那些包因此没有 publishedAt，界面上只能显示中性灰点。
      //
      // 这是低频操作（用户主动点「检查更新」），所以愿意为它多花几个请求。
      // 只补**还没有缓存**的包；已经查过的 6 小时内不重复问。
      //
      // 失败不影响主流程：拿不到发布时间只是那几颗点变灰，不是错误。
      const needsPublished = []
      for (const entry of updates.snapshot()) {
        if (!entry || !entry.available || !entry.to) continue
        if (!updates.cachedPublishedAt(entry.pkg, entry.to)) {
          needsPublished.push({ pkg: entry.pkg, version: entry.to })
        }
      }
      if (needsPublished.length) {
        const flushed = await updates.flushPublished(needsPublished)
        logger?.info?.('[market-lens] published-at flush: filled=' + flushed.filled + ' skipped=' + flushed.skipped + ' failed=' + flushed.failed)
        // 补到发布时间之后要重算行上的 update，否则界面还是旧的那份（没有 publishedAt）
        saveUpdatesCache()
        refreshUpdateOnRows()
      }

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
      // spec 一起存下来：buttonStateOf 用它区分「registry 上查过没有新版」
      // 与「本地/link 根本没法比」。
      row.installedSpec = entry?.spec ?? null
    }
    refreshButtonStates()
  }

  /**
   * 兼容性拦截的「下一步」信息。
   *
   * 宿主在 pnpm 装完后会复核兼容性，检出 incompatible-version 就整批回滚。
   * 它的输出里其实给了出路（`dsh plugin allow-version` / 插件管理器），
   * 但 market-lens 没把它接上 —— 于是「仍然安装」按钮点了还是同一个错误。
   *
   * 这里只做**只读**判定：这条 spec 折得出 key 吗、当前运行时是什么、
   * 是否已经有豁免。真正授予豁免是单独的 op，需要用户显式确认。
   *
   * @param {string|null} spec `pkg@version`
   * @returns {{key: string|null, runtimeVersion: string|null, granted: boolean, canGrant: boolean, reason: string|null, compatibilityFile: string}}
   */
  function incompatibleVerdict(spec) {
    const name = packageNameFromSpec(spec)
    const version = typeof spec === 'string' && spec.includes('@', spec.startsWith('@') ? 2 : 0)
      ? spec.slice(spec.lastIndexOf('@') + 1).trim()
      : ''
    // 自己取一次运行时信息，不依赖外层闭包变量：
    // 这个函数在 install 的 catch 里被调用，而 catch 的执行时机跨了多个
    // 请求/测试上下文；直接读 getRuntimeInfo()（它自己有缓存）比读闭包更稳。
    const info = getRuntimeInfo()
    const runtimeVersion = info?.runtimeVersion ?? info?.appVersion ?? null
    const base = {
      key: null,
      runtimeVersion,
      granted: false,
      canGrant: false,
      reason: null,
      compatibilityFile: COMPATIBILITY_FILE,
    }
    if (!name || !version) {
      return { ...base, reason: '折不出精确的 package@version，无法授予豁免；请复制安装命令后手工执行' }
    }
    const key = name + '@' + version
    if (!runtimeVersion) {
      return { ...base, key, reason: '拿不到当前 DSH 的精确版本号，无法授予豁免' }
    }
    // 文件坏了就不能写：改写了会冲掉用户原有内容
    const current = readCompatibility(profileDir)
    if (!current.rewritable) {
      return { ...base, key, reason: COMPATIBILITY_FILE + ' 无法安全改写，请先手工修复：' + current.warnings.join('；') }
    }
    const granted = hasExemption(profileDir, name, version, runtimeVersion)
    return {
      ...base,
      key,
      granted,
      canGrant: !granted,
      reason: granted
        ? '这条精确版本豁免已经生效；如果仍然被拦，重启 DSH 让它重新读取 ' + COMPATIBILITY_FILE
        : null,
    }
  }

  /**
   * 探测当前 pnpm 会用哪个 store。
   *
   * 为什么要 spawn：store 位置取决于 pnpm 自己的配置解析（global config /
   * .npmrc / pnpm-workspace.yaml 里的 storeDir），没有纯 JS 的可靠读法。
   * 只在需要时调用（安装失败、或用户主动体检），不进每次 status。
   *
   * cwd 必须是 profile —— pnpm 的 store 探测看的就是调用目录。
   *
   * @returns {string|null}
   */
  function detectedStorePath() {
    try {
      const pnpm = process.env.PNPM_BIN || 'pnpm'
      const run = spawnSync(pnpm, ['store', 'path'], {
        encoding: 'utf8',
        cwd: profileDir,
        shell: true,
        timeout: 30_000,
      })
      const text = ((run.stdout || '') + (run.stderr || '')).trim().split(/\r?\n/).filter(Boolean).pop()
      return text || null
    } catch (error) {
      logger?.debug?.('[market-lens] pnpm store path failed: ' + message(error))
      return null
    }
  }

  /**
   * 读 profile 的 pnpm-workspace.yaml 里配的 storeDir（没配就返回 null）。
   *
   * 为什么要读它：`storeDir` 是**基础路径**，pnpm 会自己追加版本子目录。
   * 写成 `.../store/v11` 会让它追加成 `.../store/v11/v11` —— 这是
   * ERR_PNPM_UNEXPECTED_STORE 的另一个来源，而且**改记录/重装都治不了**，
   * 必须先改配置。所以体检必须能看见这一项。
   */
  function configuredStoreDir() {
    try {
      const file = path.join(profileDir, 'pnpm-workspace.yaml')
      if (!fs.existsSync(file)) return null
      const text = fs.readFileSync(file, 'utf8')
      // 只认顶层 `storeDir:`（缩进 0），避免误读别处的同名键
      const match = /^storeDir\s*:\s*([^\r\n#]+)/m.exec(text)
      return match ? match[1].trim() : null
    } catch (error) {
      logger?.debug?.('[market-lens] read pnpm-workspace.yaml failed: ' + message(error))
      return null
    }
  }

  /** store 体检（只在需要时算）。 */
  function storeHealth() {
    return inspectStore({
      profileDir,
      detectedStore: detectedStorePath(),
      configuredStoreDir: configuredStoreDir(),
    })
  }

  /**
   * 重算整表按钮状态。目录/已装集合/更新结论三者任意一个变了都要重跑，
   * 否则按钮会停在过期状态（真机上见过「升级完了按钮还是 ↑ x.y.z」）。
   */
  function refreshButtonStates() {
    for (const row of rows) {
      row.button = buttonInfoFor({
        installed: row.installed,
        installedVersion: row.installedVersion,
        installedSpec: row.installedSpec,
        pkg: row.pkg,
        repo: row.repo,
        update: row.update,
      }, { failed: Boolean(row.key && installFailures.has(row.key)) })
    }
  }

  /**
   * 这一行的上一次安装失败了。
   *
   * 存在内存里，不写缓存：失败是一次尝试的结果，不是目录的属性。
   * 重启后按钮回到正常状态是**对的** —— 用户重启本来就意味着"重新开始"。
   * 装在 Host 侧而不是只留 client 的 actionBusy，是为了让失败在目录刷新后仍然可见。
   */
  function markInstallFailure(key, failed) {
    if (typeof key !== 'string' || !key) return
    if (failed) installFailures.add(key)
    else installFailures.delete(key)
    refreshButtonStates()
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
        // 目标版本的发布时间：界面据此决定"名字旁要不要冒绿点"。
        // 只在一周内才算"新鲜"，超过就只保留按钮上的 ↑ x.y.z。
        publishedAt: official.publishedAt || null,
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
      // compat 缓存里没有发布时间，但 UpdateService 可能已经查过并缓存了
      // （用户点过「检查更新」之后就会补上）。只读缓存、不发请求 ——
      // 这个函数是同步的，每轮 catalog/status 都会跑。
      publishedAt: updates.cachedPublishedAt ? updates.cachedPublishedAt(name, cached.version) : null,
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
    // 更新结论变了，按钮就必须跟着变 —— 否则「升级到最新」之后
    // 按钮还停在「更新 ↑ x.y.z」，「已是最新」这个状态永远上不了屏。
    refreshButtonStates()
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
      const cache = normalizeSourceCache(sourceCaches[source.id])
      const stale = stalenessOf(sourceCaches[source.id])
      return {
        ...source,
        rows: sourceCounts[source.id] ?? 0,
        progress: progress ?? { status: source.enabled ? 'idle' : 'disabled', done: 0, total: 0, error: null },
        meta: meta.sources?.[source.id] ?? null,
        // progress 只反映本次运行，持久化的健康字段才能在重启后显示“上次成功多久前/连续失败几次”
        lastSuccessAt: health.lastSuccessAt,
        failureCount: health.failureCount,
        lastError: health.lastError,
        // 条件请求的结论：只有 304 才推进 lastConfirmedAt，
        // 所以这个字段能如实回答「这份数据到底确认于何时」。
        lastConfirmedAt: cache.lastConfirmedAt,
        hasConditionalMarker: Boolean(cache.etag || cache.lastModified),
        stale: stale.stale,
        staleReason: stale.reason,
        staleAgeMs: stale.ageMs,
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
      // 整份目录的「确认」结论：只有 304 才推进 lastConfirmedAt，
      // 所以这里能如实回答「这份目录到底是新拉的还是沿用的」。
      cacheStaleness: catalogStaleness(sourceCaches, {
        enabled: enabledSources(sourceConfig).map((source) => source.id),
      }),
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
    // 条件请求：只有单文档源能这么问（分页目录每页的 ETag 各不相同，
    // 用它判"整份目录没变"是错的）。拿不到标记就发普通请求 —— 不是错误。
    const conditional = conditionalOf(sourceCaches[source.id])
    if (source.kind === '1024store') {
      result = await fetch1024Catalog({
        signal,
        onProgress: (value) => {
          progress({ ...value, message: `1024Store ${value.done || 0}/${value.total || 0} 页` })
        },
      })
      items = result.items.map((item) => normalize1024(item, profileName)).filter(Boolean)
    } else if (source.kind === 'dshfind') {
      result = await fetchFormat1Index(CATALOG_DSHFIND_ENDPOINT, { signal, conditional, onProgress: (value) => progress({ ...value, message: '正在拉取 dshfind 索引' }) })
      items = result.notModified ? null : result.items
        .map((item) => normalizeFormat1(item, { sourceId: source.id, sourceName: source.name, sourceHomepage: 'https://dshfind.com', profileName }))
        .filter(Boolean)
    } else if (source.kind === 'dshso') {
      result = await fetchFormat1Index(source.url || CATALOG_DSHSO_ENDPOINT, { signal, conditional, onProgress: (value) => progress({ ...value, message: '正在拉取 dsh.so 精选市场' }) })
      items = result.notModified ? null : result.items
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
      result = await fetchFormat1Index(source.url, { signal, conditional, onProgress: (value) => progress({ ...value, message: `正在拉取 ${source.name}` }) })
      items = result.notModified ? null : result.items
        .map((item) => normalizeFormat1(item, { sourceId: source.id, sourceName: source.name, sourceHomepage: source.name, profileName }))
        .filter(Boolean)
    } else {
      throw new Error('未知来源类型: ' + source.kind)
    }

    // 已中止的源不能再回写成功状态：否则超时后界面会把 error 翻回 done，健康状态也会被误记成功
    if (signal.aborted) throw signal.reason ?? new Error('sync cancelled')

    // ---- 304 分支：内容没变，绝不能重写快照 ----
    //
    // 这里必须**早于** markSourceSuccess 的处理逻辑：
    // 304 是「确认最新」，要推进 lastConfirmedAt，但 items 为 null，
    // 上游必须知道这一源本轮没有新数据（否则会把它的条目当成"下架"）。
    if (result.notModified) {
      sourceCaches[source.id] = confirmNotModified(sourceCaches[source.id], result, Date.now())
      cacheDirty = true
      // 逐源健康时间也要推进（用户看到的是"上次成功多久前"）
      markSourceSuccess(source.id)
      syncState.progress[source.id] = { status: 'done', done: 0, total: 0, error: null, notModified: true }
      return {
        source,
        items: null,
        notModified: true,
        meta: { ...result.meta, rows: null, kind: source.kind, name: source.name, notModified: true },
      }
    }

    // ---- 200 分支：内容变了，更新标记 ----
    sourceCaches[source.id] = confirmFetched(sourceCaches[source.id], result, Date.now())
    cacheDirty = true

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
      notModified: false,
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
      // 上一份目录要在 build 之前就留住：304 的源需要从它里面捞回自己的行。
      const previousRowsSnapshot = rows
      const previousGeneratedAt = cacheGeneratedAt
      // ---- 304 的源要复用上一轮条目，绝不能当成"下架" ----
      //
      // 这是整个条件请求设计里最容易写错的一处：
      // `notModified` 的 result 里 items 是 null（服务端根本没发 body）。
      // 如果直接 flatMap，那个源的条目会整体消失 → diffRows 会把它判成「下架」，
      // 用户看到的是「一大批插件被下架了」，而其实只是"没变化"。
      //
      // 所以：notModified 的源，从**上一份目录**里捞回属于它的行，原样放进本轮。
      const notModifiedSources = successful.filter((result) => result.notModified).map((result) => result.source.id)
      const freshSources = new Set(successful.filter((result) => !result.notModified).map((result) => result.source.id))
      const carriedRows = notModifiedSources.length && Array.isArray(previousRowsSnapshot)
        ? previousRowsSnapshot.filter((row) => {
            const sources = Array.isArray(row.sources) ? row.sources : []
            if (!sources.length) return false
            // 一行可能来自多个源：只要它还有**本轮真拿到数据**的源支撑，
            // 就不该由 304 的源"续命"——它的内容应当由真拉到的那一份决定。
            if (sources.some((id) => freshSources.has(id))) return false
            return sources.some((id) => notModifiedSources.includes(id))
          })
        : []

      const sourceRows = [
        ...successful.filter((result) => !result.notModified).flatMap((result) => (Array.isArray(result.items) ? result.items : [])),
        ...carriedRows,
      ]
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
      const previousRows = previousRowsSnapshot
      const diffed = diffRows(previousRows, built, {
        // 304 的源也算"本轮成功"：它的内容没变，不是失败，
        // 所以它支撑的行同样不该被判成下架。
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
      for (const result of successful) {
        // 304 的源没有本轮条目数：沿用上一轮记下的数字，不要写成 0
        // （写 0 会让界面上那个源显示"0 条"，看起来它整批被清空了）。
        nextSourceCounts[result.source.id] = result.notModified
          ? (sourceCounts[result.source.id] ?? carriedRows.filter((row) => (row.sources || []).includes(result.source.id)).length)
          : (Array.isArray(result.items) ? result.items.length : 0)
      }
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

      /**
       * 授予 / 撤销一条精确版本豁免（宿主 compatibility.json）。
       *
       * 这是「仍然安装」那条路的**实际执行步骤**。宿主在 pnpm 装完后复核兼容性，
       * 检出 incompatible-version 就整批回滚；它的报错里写着
       * `dsh plugin allow-version`，但 market-lens 原来没把它接到界面上。
       *
       * 几条必须由调用方满足的条件（缺一个就拒绝，并说清缺哪个）：
       *   · pkg 与 version 都必须是精确的（范围 / 标签 / latest 都不行）
       *   · runtimeVersion 必须是**当前**这个 DSH 的版本（宿主拒绝批准别的版本）
       *   · acceptRisk 必须显式为 true（宿主同样要求明确承认风险）
       *   · compatibility.json 坏掉时不许改写（会冲掉用户原有内容）
       */
      if (op === 'exempt.grant' || op === 'exempt.revoke') {
        const pkg = typeof body.pkg === 'string' ? body.pkg.trim() : ''
        const version = exactVersion(body.version)
        const runtimeVersion = runtime?.runtimeVersion ?? runtime?.appVersion ?? null
        const grant = op === 'exempt.grant'
        if (!pkg || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)) {
          opLog.warn('exempt.invalid-pkg', { pkg: body.pkg ?? null })
          return sendJson(res, 400, { ok: false, error: '豁免目标必须是合法的 npm 包名' })
        }
        if (!version) {
          opLog.warn('exempt.invalid-version', { version: body.version ?? null })
          return sendJson(res, 400, { ok: false, error: '豁免版本必须是精确版本号（如 0.4.7）：范围与标签都不接受' })
        }
        if (grant && body.acceptRisk !== true) {
          // 不弹二次确认就授予豁免，等于替用户按下"我接受数据丢失风险"
          opLog.warn('exempt.needs-consent', { pkg, version })
          return sendJson(res, 400, {
            ok: false,
            error: '授予豁免需要显式确认风险：请求里带 acceptRisk: true',
            needsConsent: true,
          })
        }
        const outcome = grant
          ? grantExemption({ profileDir, pkg, version, runtimeVersion, acceptRisk: body.acceptRisk === true, dryRun: body.dryRun === true })
          : revokeExemption({ profileDir, pkg, version, runtimeVersion, dryRun: body.dryRun === true })
        const code = outcome.result
        opLog.write(code === EXEMPT_RESULT.ok || code === EXEMPT_RESULT.alreadyGranted ? 'info' : 'warn', 'exempt.' + (grant ? 'grant' : 'revoke'), {
          pkg,
          version,
          runtimeVersion: runtimeVersion ?? null,
          result: code,
          detail: outcome.detail,
        })
        if (code === EXEMPT_RESULT.ok || code === EXEMPT_RESULT.alreadyGranted) {
          return sendJson(res, 200, {
            ok: true,
            result: code,
            pkg,
            version,
            runtimeVersion,
            exemptions: outcome.exemptions,
            warnings: outcome.warnings || [],
            detail: outcome.detail,
            // 豁免写在 profile 目录里，宿主可能要到重启才重新读
            restartRequired: grant && code === EXEMPT_RESULT.ok,
            compatibilityFile: COMPATIBILITY_FILE,
          })
        }
        return sendJson(res, 500, {
          ok: false,
          result: code,
          pkg,
          version,
          runtimeVersion,
          exemptions: outcome.exemptions || {},
          warnings: outcome.warnings || [],
          error: outcome.detail || '豁免未生效',
          compatibilityFile: COMPATIBILITY_FILE,
        })
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
        // 开始尝试：先清掉上一轮失败标记，按钮立刻回到「安装中…」的语义基础。
        markInstallFailure(row?.key || key || '', false)
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
            result = await runInstallWithRetry(manager, effectiveSpec, options, { key: key || '(empty)', origin: resolved.origin })
          } catch (cause) {
            const firstDetail = message(cause)
            // 文件占用不是「目录版本过期」，降级目标等于换个东西装，毫无帮助。
            // 必须先把 EPERM 排除在降级判断之外，否则会拿一个坏目标掩盖真实原因。
            if (isFileBusy(cause)) throw cause
            const fallback = fallbackInstallSpec(effectiveSpec, firstDetail)
            logInstall('warn', 'install.attempt-failed', { key: key || '(empty)', spec: effectiveSpec, origin: resolved.origin, approved: approvedBuilds.length, fallback: fallback || null, detail: firstDetail })
            if (!fallback) throw cause
            logger?.info?.('[market-lens] install fallback ' + effectiveSpec + ' -> ' + fallback + ' (' + firstDetail + ')')
            fellBackFrom = effectiveSpec
            effectiveSpec = fallback
            logInstall('warn', 'install.fallback', { key: key || '(empty)', spec: effectiveSpec, fellBackFrom, origin: resolved.origin, detail: firstDetail })
            result = await runInstallWithRetry(manager, effectiveSpec, options, { key: key || '(empty)', origin: resolved.origin })
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

          // ---- 必须检查返回值的 application，不能只看有没有抛出 ----
          //
          // 宿主 pluginManager 的 `change()` 把操作异常**吞进结果对象**，不向外抛：
          //
          //   catch (error) {
          //     result.application = 'failed'        // ← 不是 throw
          //     result.error = managementError(error)
          //   }
          //
          // 于是兼容性拒绝这类失败会**正常返回**一个对象：
          //   { application: 'failed', error: {...}, changed: false }
          // 而它的输出里明明写着 "installation rejected ... nothing was installed"。
          //
          // 真机事故（2026-11-07）：dsh-tidy-display@0.4.7 被 incompatible-version
          // 拒绝两次，market-lens 两次都记成 `install ok` —— 因为只 catch 了抛出。
          // 用户看到「已安装」，实际什么都没装。
          const application = typeof result?.application === 'string' ? result.application : null
          const silentFailure = application === 'failed'
          if (silentFailure) {
            const managementError = result?.error && typeof result.error === 'object' ? result.error : null
            const code = managementError && typeof managementError.code === 'string' ? managementError.code : null
            // 宿主 managementError() 的字段是 **diagnostic**（不是 message）：
            //   ManagementFailure → { code, incompatible? }
            //   其它错误          → { code: 'operation-error', diagnostic }
            const hostText = managementError
              ? (typeof managementError.diagnostic === 'string' && managementError.diagnostic.trim()
                ? managementError.diagnostic
                : (typeof managementError.message === 'string' ? managementError.message : ''))
              : ''
            const detail = hostText
              ? (code ? code + ': ' : '') + hostText
              : (typeof result?.output === 'string' && result.output.trim() ? result.output.trim().slice(-2000) : '宿主拒绝了安装，但没给出原因')
            logger?.info?.('[market-lens] install silently rejected spec=' + effectiveSpec + ' code=' + String(code) + ' app=' + String(application))
            logInstall('error', 'install.rejected-by-host', {
              key: key || '(empty)',
              spec: effectiveSpec,
              fellBackFrom,
              origin: resolved.origin,
              ms: Date.now() - startedAt,
              application,
              code,
              incompatible: managementError?.incompatible
                ? managementError.incompatible.map((item) => String(item?.name ?? item)).join(', ')
                : null,
              detail: String(detail).slice(0, 800),
            })
            const failure = classifyInstallFailure({ code, message: String(detail) }, detail)
            markInstallFailure(row?.key || key || '', true)
            return sendJson(res, 500, {
              ok: false,
              spec: effectiveSpec,
              fellBackFrom,
              origin: resolved.origin,
              // 这一条是「宿主返回了失败结果，而不是抛出」——前端要能分辨
              code: code || failure.code || 'host-refused',
              layer: failure.layer,
              retryable: failure.retryable,
              action: failure.action,
              evidence: failure.evidence,
              incompatible: managementError?.incompatible || failure.incompatible,
              exemption: failure.layer === FAILURE_LAYERS.compat ? incompatibleVerdict(effectiveSpec) : null,
              detail,
              error: detail,
            })
          }

          // 15 秒缓存里还是装之前的依赖表，不清掉这一轮 refresh 会把刚装好的行写回未安装。
          invalidateInstalledCache()
          refreshInstalledOnRows()
          // 装完之后必须核对「挂载」这一步。
          //
          // pluginManager.installBundle 除了写 dependencies，还会调 selectBundle
          // 把包加进 dsh.profile.bundles —— 只写依赖不写 bundles 的插件，重启后
          // loader 根本不会加载它，表现就是用户说的「装上了但不出现」。
          // 这一步在官方实现里是隐式的，安静失败时前端完全看不出来，所以自己查一遍。
          const mount = inspectMount(effectiveSpec, result)
          logger?.info?.('[market-lens] install ok spec=' + effectiveSpec + ' origin=' + String(resolved.origin) + ' ' + (Date.now() - startedAt) + 'ms')
          logInstall('info', 'install.ok', { key: row?.key || key || null, spec: effectiveSpec, fellBackFrom, origin: resolved.origin || 'manual', ms: Date.now() - startedAt, summary: summarizeInstallResult(result), mounted: mount.mounted, packageName: mount.packageName })
          if (mount.checked && !mount.mounted) {
            // 依赖装上了但没进 bundle 层：这不是失败（文件确实装好了、也能在
            // 已安装清单里看到），但必须直说，否则用户会以为下次启动就能用。
            logInstall('warn', 'install.not-mounted', { key: key || '(empty)', spec: effectiveSpec, packageName: mount.packageName, reason: mount.reason })
          }
          // 装机链路体检：常见故障在这里一次说清，而不是让用户重启才发现。
          // 两条最贵的坑：
          //   · 依赖里有、bundles 里没有 → 重启后插件不出现（install.not-mounted 那条）；
          //   · 插件自带 patch 的行解析不到 → 宿主半身与浏览器半身一起不挂（dsh 不报错）；
          //   · peer 要求的 dsh 版本超过当前运行时 → 启动预检直接拒绝加载。
          const health = installedHealth(mount.packageName, effectiveSpec)
          if (health.rows.length || health.unmounted || (health.peers && health.peers.status === 'bad')) {
            // 注意：这里要传**扁平的字符串数组**。OpLog.sanitize 只保留标量与小数组，
            // 传对象数组会被过滤成空数组 —— 真实踩过：install.health 的 rows 落进日志
            // 全是 []，最关键的那几条行名反而丢了。
            logInstall('info', 'install.health', {
              spec: effectiveSpec,
              packageName: mount.packageName,
              verdict: health.verdict,
              detail: health.detail,
              rows: health.rows.map((row) => row.status + ':' + (row.id ? row.id + '=' : '') + row.name),
              unresolved: health.rows.filter((row) => row.status === 'unresolved').map((row) => row.name),
              unmounted: health.unmounted,
              peers: health.peers ? health.peers.status + ':' + String(health.peers.reason) : null,
              // 第四层：运行时 Fiber 状态。装完那一刻通常还是 pending
              // （loader 要下一个 tick 才挂），所以这里如实记，别当成失败。
              staticVerdict: health.staticVerdict ?? null,
              activation: health.activation ? String(health.activation.phase) : 'unknown',
              // 第五层：配置条件。装了、能加载、甚至跑起来了，但缺外部配置时
              // 结论是 needs-config —— 用户看到的现象正是「显示已安装但用不了」。
              // 只记 env 变量名与状态，**绝不记值**（日志会被导出分享）。
              configNeeded: health.config && health.config.required
                ? (health.config.entries || []).map((entry) => entry.key + '=' + entry.status + '(' + entry.env.join('|') + ')').join(', ')
                : null,
              // 安装钩子：会跑代码 / 会改 profile 的包，装完之后必须留一笔。
              // dsh-purge 就是这样改了 cordis.patch.yml，而四层体检全绿。
              hooks: health.hooks ? health.hooks.verdict + ':' + (health.hooks.hooks || []).map((entry) => entry.hook).join('|') : null,
            })
          }
          // 成功：清掉失败标记，并把这一行的按钮按新状态重算。
          markInstallFailure(row?.key || key || '', false)
          return sendJson(res, 200, {
            ok: true,
            key: row?.key || key || null,
            origin: resolved.origin || 'manual',
            spec: effectiveSpec,
            fellBackFrom,
            installed: installedState(),
            result: summarizeInstallResult(result),
            mount,
            health,
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
          const failure = classifyInstallFailure(cause, detail)

          // ---- store 位置不一致：这是「重试一万次也一样」的必然失败 ----
          //
          // pnpm 的 store 位置取决于调用时的工作目录。从别的盘（G:）调用时它退回
          // <盘>\.pnpm-store 并把绝对路径写进 node_modules/.modules.yaml；
          // 此后从 profile 目录调用就会报 ERR_PNPM_UNEXPECTED_STORE。
          //
          // 关键：这**不是插件的问题**，也不是网络/版本问题。回执必须说清楚，
          // 否则用户只会反复点安装。修法只有一条：用同一个 store 重建 node_modules。
          const storeMismatch = isStoreMismatchError(detail)
          if (storeMismatch) {
            const store = storeHealth()
            logger?.info?.('[market-lens] install blocked by store mismatch spec=' + effectiveSpec + ' recorded=' + String(store.recorded) + ' detected=' + String(store.detected))
            logInstall('error', 'install.store-mismatch', {
              spec: effectiveSpec,
              origin: resolved.origin,
              recordedStore: store.recorded,
              detectedStore: store.detected,
              verdict: store.verdict,
            })
            markInstallFailure(row?.key || key || '', true)
            return sendJson(res, 500, {
              ok: false,
              spec: effectiveSpec,
              fellBackFrom,
              origin: resolved.origin,
              code: 'ERR_PNPM_UNEXPECTED_STORE',
              layer: 'lock',
              retryable: false,
              action: 'copy-cmd',
              evidence: store.detail || detail.split(/\r?\n/).filter(Boolean)[0] || detail,
              // store 体检的完整结论一起带出去，前端可以照实说
              store,
              detail: store.detail || detail,
              error: (store.detail || detail) +
                '\n\n修法（在 profile 目录里执行，cwd 必须是它）：\n' +
                '  1. pnpm store path            # 确认当前 pnpm 用哪个 store\n' +
                '  2. pnpm install               # 用同一个 store 重建 node_modules\n' +
                '\n不要手改 node_modules/.modules.yaml —— 它只是记账，硬链接实际指向的还是旧 store。',
            })
          }

          // 「已经装好了」是幂等成功，不是失败。
          //
          // 宿主有两处会抛 already-installed（dsh-plugin-manager）：
          //   · HMR 下重装已知包（`Object.hasOwn(before, known)`）
          //   · 装前预检 refused（path / registry 两条）
          // 两者都意味着目标状态已经达成 —— 报成 500，用户只会反复点安装。
          // 所以这里回 200，并带 note 说明「为什么没有重新下载」。
          if (failure.outcome === 'already-present') {
            const packageName = packageNameFromSpec(effectiveSpec)
            const health = installedHealth(packageName, effectiveSpec)
            logger?.info?.('[market-lens] install already-present spec=' + effectiveSpec + ' pkg=' + String(packageName))
            logInstall('info', 'install.already-present', {
              key: key || '(empty)',
              spec: effectiveSpec,
              packageName,
              origin: resolved.origin,
              ms: Date.now() - startedAt,
              verdict: health.verdict,
              detail: failure.evidence,
            })
            return sendJson(res, 200, {
              ok: true,
              code: 'already-installed',
              spec: effectiveSpec,
              key: row?.key || key || null,
              origin: resolved.origin || 'manual',
              fellBackFrom,
              // 明确告诉前端：这次没真的下载，只是确认目标已就位
              alreadyPresent: true,
              note: '目标版本已经装好了（宿主判定已安装，未重新下载）',
              installed: installedState(),
              health,
            })
          }

          // 降级过的话 effectiveSpec 已经不带 #path: 了，所以用第一次尝试的目标判断。
          const attemptedSpec = fellBackFrom || effectiveSpec
          const subdirMissing = attemptedSpec.includes('#path:') && /ERR_PNPM_INVALID_PATH|not a valid sub-directory/i.test(detail)
          // 文件占用重试三次仍失败：这不是代码问题，是宿主进程还握着那个目录。
          // 必须把「关掉 DSH 再装」这句话给出去，否则用户只会反复点安装。
          const fileBusy = isFileBusy(cause)
          const busyPackage = fileBusy ? busyPackageFrom(cause) : null
          // code 以失败分类器为准：它认得宿主的 11 个 ManagementFailure 码，
          // 比原来只有 file-busy / subdir-missing 两种精确得多。
          const code = failure.code || (fileBusy ? 'file-busy' : (subdirMissing ? 'subdir-missing' : null))
          logger?.info?.('[market-lens] install failed key=' + (key || '(empty)') + ' origin=' + String(resolved.origin) + ' spec=' + effectiveSpec + ' code=' + String(code) + ' layer=' + failure.layer + ' error=' + detail)
          logInstall('error', 'install.failed', {
            key: key || '(empty)',
            spec: effectiveSpec,
            attemptedSpec,
            fellBackFrom,
            origin: resolved.origin,
            ms: Date.now() - startedAt,
            code,
            layer: failure.layer,
            retryable: failure.retryable,
            action: failure.action,
            evidence: failure.evidence,
            incompatible: failure.incompatible ? failure.incompatible.map((item) => String(item?.name ?? item)).join(', ') : null,
            busyPackage,
            retried: fileBusy ? 3 : 0,
            detail,
            stack: cause?.stack ? String(cause.stack).split('\n').slice(0, 4).join(' | ') : null,
          })
          // 这一行刚失败过：按钮要立刻变成「重试」，并且**目录刷新后仍然保持**
          // （client 的 actionBusy 活不过一次 catalog 拉取）。
          markInstallFailure(row?.key || key || '', true)
          return sendJson(res, 500, {
            ok: false,
            spec: effectiveSpec,
            fellBackFrom,
            origin: resolved.origin,
            // 前端按 code 决定给哪些按钮，按 layer 决定标题里说「哪一层」
            code: code || undefined,
            layer: failure.layer,
            retryable: failure.retryable,
            action: failure.action,
            evidence: failure.evidence,
            incompatible: failure.incompatible,
            // 兼容性拦截要给**真的能用的**下一步：宿主提供了 exact-version exemption，
            // 但 market-lens 原来没把它接上，「仍然安装」点了还是同一个错误。
            // 只在真的撞上兼容性时才去算（其它失败算出来也没人用，
            // 且会让「拿不到运行时版本」的噪声混进无关回执）。
            exemption: failure.layer === FAILURE_LAYERS.compat ? incompatibleVerdict(effectiveSpec) : null,
            busyPackage,
            detail,
            error: fileBusy
              ? '文件被占用，已自动重试 3 次仍失败。\n'
                + (busyPackage ? '被占用的包：' + busyPackage + '\n' : '')
                + '这是 Windows 上正在运行的 DSH 仍持有 node_modules 里的文件句柄导致的，不是网络或版本问题。\n'
                + '处理办法（任选其一）：\n'
                + '  1. 关掉 DSH Desktop 后在命令行执行：pnpm --dir "' + profileDir + '" add ' + effectiveSpec + '\n'
                + '  2. 或者卸载/禁用清单里那个插件后重试本插件\n'
                + '  3. 或者稍后重试（宿主放弃句柄后通常几秒内即可）\n'
                + '\n原始错误：' + detail
              : (subdirMissing
                ? detail + '\n源数据里的子目录在当前仓库中不存在（可能已改名或删除）；请刷新目录，或打开仓库确认路径后复制命令安装。'
                : detail),
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
          const result = await runInstallWithRetry(manager, spec, options, { key: pkg, origin: 'upgrade' })
          // 与 install 同理：宿主把失败吞进返回值的 application，不抛出。
          // 升级路径同样会撞 incompatible-version，不查就会记成「升级完成」。
          if (typeof result?.application === 'string' && result.application === 'failed') {
            const managementError = result?.error && typeof result.error === 'object' ? result.error : null
            const code = managementError && typeof managementError.code === 'string' ? managementError.code : null
            const hostText = managementError
              ? (typeof managementError.diagnostic === 'string' && managementError.diagnostic.trim()
                ? managementError.diagnostic
                : (typeof managementError.message === 'string' ? managementError.message : ''))
              : ''
            const detail = hostText
              ? (code ? code + ': ' : '') + hostText
              : (typeof result?.output === 'string' && result.output.trim() ? result.output.trim().slice(-2000) : '宿主拒绝了升级')
            const failure = classifyInstallFailure({ code, message: String(detail) }, String(detail))
            upgradeLog('error', 'upgrade.rejected-by-host', { version, spec, ms: Date.now() - startedAt, application: result.application, code, detail: String(detail).slice(0, 800) })
            return sendJson(res, 500, {
              ok: false,
              pkg,
              version,
              spec,
              code: code || failure.code || 'host-refused',
              layer: failure.layer,
              retryable: failure.retryable,
              action: failure.action,
              evidence: failure.evidence,
              incompatible: managementError?.incompatible || failure.incompatible,
              exemption: failure.layer === FAILURE_LAYERS.compat ? incompatibleVerdict(spec) : null,
              detail,
              error: detail,
            })
          }
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
          const failure = classifyInstallFailure(cause, detail)
          // 升级时报「已安装」有两种含义：目标版本已经就是它，或者宿主在 HMR 下
          // 认定这个包已知。两种都不该算失败 —— 升到同一个版本本来就是成功。
          if (failure.outcome === 'already-present') {
            upgradeLog('info', 'upgrade.already-present', { version, spec, ms: Date.now() - startedAt, detail: failure.evidence })
            return sendJson(res, 200, {
              ok: true,
              code: 'already-installed',
              pkg,
              version,
              spec,
              alreadyPresent: true,
              note: '目标版本已经是当前版本（宿主判定已安装，未重新下载）',
              installed: installedState(),
              health: installedHealth(pkg, spec),
            })
          }
          // 升级同样会因为宿主占着旧版本目录而 EPERM：这不是版本问题，必须说清楚。
          const fileBusy = isFileBusy(cause)
          const busyPackage = fileBusy ? busyPackageFrom(cause) : null
          const code = failure.code || (fileBusy ? 'file-busy' : null)
          logger?.info?.('[market-lens] upgrade failed spec=' + spec + ' code=' + String(code) + ' layer=' + failure.layer + ' error=' + detail)
          upgradeLog('error', 'upgrade.failed', { version, spec, ms: Date.now() - startedAt, code, layer: failure.layer, retryable: failure.retryable, action: failure.action, evidence: failure.evidence, busyPackage, retried: fileBusy ? 3 : 0, detail, stack: cause?.stack ? String(cause.stack).split('\n').slice(0, 4).join(' | ') : null })
          return sendJson(res, 500, {
            ok: false,
            pkg,
            version,
            spec,
            code: code || undefined,
            layer: failure.layer,
            retryable: failure.retryable,
            action: failure.action,
            evidence: failure.evidence,
            incompatible: failure.incompatible,
            exemption: failure.layer === FAILURE_LAYERS.compat ? incompatibleVerdict(pkg + '@' + version) : null,
            busyPackage,
            error: fileBusy
              ? '文件被占用，已自动重试 3 次仍失败。\n'
                + (busyPackage ? '被占用的包：' + busyPackage + '\n' : '')
                + 'Windows 上正在运行的 DSH 仍持有 node_modules 里的文件句柄，升级要替换旧目录所以会被拦住。\n'
                + '处理办法：关掉 DSH Desktop 后执行 pnpm --dir "' + profileDir + '" add ' + spec + '，或稍后重试。\n'
                + '\n原始错误：' + detail
              : detail,
          })
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

      // ── 评分规则（规则库）───────────────────────────────────────────────────
      // library.* 是规则库的增删选；rules.* 保留成兼容旧前端的别名，
      // 语义全部落到「往库里加一条并启用」，不再有「覆盖当前规则文件」这回事。
      if (op === 'library.get' || op === 'rules.get') {
        const entry = activeEntry(rulesLibrary)
        return sendJson(res, 200, {
          ok: true,
          rules: scoringRules,
          activeId: rulesLibrary.activeId,
          entry: entry ? { id: entry.id, name: entry.name, description: entry.description, origin: entry.origin, builtin: Boolean(entry.builtin), savedAt: entry.savedAt } : null,
          // describeEntry 把因子翻成人话：界面直接渲染这张表，不再让用户读 JSON
          description: describeEntry(entry),
          library: libraryChoices(rulesLibrary),
          document: rulesDocument(scoringRules, { includePresets: true }),
          summary: rulesSummary(),
          paths: { library: libraryPath, legacy: rulesPath },
          issue: rulesIssue,
        })
      }

      if (op === 'rules.template') {
        // 模版里自带 readme + 指标/归一化清单，用户照着改就能做出自己的规则。
        const template = rulesTemplate()
        return sendJson(res, 200, {
          ok: true,
          template,
          filename: 'market-lens-scoring-rules.template.json',
          // 界面上那几张说明表要用的结构化字段（readme 只是纯文本兜底）
          metrics: Object.entries(METRIC_REGISTRY).map(([key, item]) => ({ key, label: item.label, kind: item.kind })),
          norms: Object.entries(NORM_REGISTRY).map(([key, item]) => ({ key, label: item.label, description: item.desc })),
          groups: GROUP_GUIDE,
        })
      }

      if (op === 'rules.export') {
        return sendJson(res, 200, {
          ok: true,
          document: rulesDocument(scoringRules, { includePresets: true }),
          filename: 'market-lens-scoring-rules-' + stamp() + '.json',
          activeId: rulesLibrary.activeId,
        })
      }

      // 上传：存进库里并启用。body.rules / body.document / body 都接受，
      // name / description 可以由上传方显式指定（文件名通常就是最好的名字）。
      if (op === 'library.add' || op === 'rules.import' || op === 'rules.set') {
        const outcome = addUserEntry(body.rules ?? body.document ?? body, {
          name: typeof body.name === 'string' ? body.name : null,
          description: typeof body.description === 'string' ? body.description : null,
          activate: body.activate !== false,
        })
        if (!outcome.ok) return sendJson(res, 400, { ok: false, error: outcome.error, issues: outcome.issues })
        return sendJson(res, 200, {
          ok: true,
          summary: rulesSummary(),
          counts: countRows(rows),
          rules: outcome.rules,
          library: libraryChoices(rulesLibrary),
          activeId: outcome.activeId,
          entry: outcome.entry,
          renamed: outcome.renamed,
        })
      }

      // 启用库里已有的某一条（下拉框 onChange 走这个）。
      if (op === 'library.activate' || op === 'library.select') {
        const id = String(body.id || body.activeId || '')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少要启用的规则 id', library: libraryChoices(rulesLibrary) })
        const outcome = activateEntry(id, { source: typeof body.source === 'string' ? body.source : null })
        if (!outcome.ok) return sendJson(res, 404, { ok: false, error: outcome.error, library: libraryChoices(rulesLibrary) })
        return sendJson(res, 200, {
          ok: true,
          summary: rulesSummary(),
          counts: countRows(rows),
          rules: outcome.rules,
          library: libraryChoices(rulesLibrary),
          activeId: outcome.activeId,
          recomputed: outcome.recomputed,
        })
      }

      // 内置预设也走同一条路径：它就是库里本来就有的条目。
      if (op === 'rules.preset') {
        const presetId = String(body.id || body.presetId || '')
        const candidates = ['preset:' + presetId, presetId]
        const found = candidates.map((id) => findEntry(rulesLibrary, id)).find(Boolean)
        if (!found) {
          return sendJson(res, 404, {
            ok: false,
            error: '没有这个内置预设：' + presetId,
            presets: BUILT_IN_PRESETS.map((preset) => ({ id: preset.id })),
          })
        }
        const outcome = activateEntry(found.id, { source: 'preset' })
        if (!outcome.ok) return sendJson(res, 400, { ok: false, error: outcome.error })
        return sendJson(res, 200, {
          ok: true,
          summary: rulesSummary(),
          counts: countRows(rows),
          rules: outcome.rules,
          library: libraryChoices(rulesLibrary),
          activeId: outcome.activeId,
        })
      }

      // 删掉某份自定义规则。内置与预设不许删（切换走 activate 就行）。
      if (op === 'library.remove' || op === 'rules.remove') {
        const id = String(body.id || '')
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少要删除的规则 id', library: libraryChoices(rulesLibrary) })
        const outcome = removeEntry(id)
        if (!outcome.ok) {
          const status = outcome.error.startsWith('内置规则') ? 400 : 404
          return sendJson(res, status, { ok: false, error: outcome.error, library: libraryChoices(rulesLibrary) })
        }
        return sendJson(res, 200, {
          ok: true,
          summary: rulesSummary(),
          counts: countRows(rows),
          rules: scoringRules,
          library: libraryChoices(rulesLibrary),
          activeId: outcome.activeId,
          removed: outcome.removed,
          wasActive: outcome.wasActive,
          recomputed: outcome.recomputed,
        })
      }

      // 兼容旧语义的「恢复内置」：不删文件，只是把 activeId 指回内置默认。
      // 用户的规则还在库里，随时可以再选回来——这比「删掉」友好得多。
      if (op === 'rules.reset' || op === 'library.reset') {
        const outcome = activateEntry('builtin:default', { source: 'reset' })
        if (!outcome.ok) return sendJson(res, 500, { ok: false, error: outcome.error, summary: rulesSummary() })
        return sendJson(res, 200, {
          ok: true,
          summary: rulesSummary(),
          counts: countRows(rows),
          rules: scoringRules,
          library: libraryChoices(rulesLibrary),
          activeId: outcome.activeId,
        })
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
