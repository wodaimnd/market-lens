/** Persistent source registry and refresh schedule for the market radar. */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cacheDirectory, readJson, writeJsonAtomic } from './runtime.js'

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'source-config.json'
export const REFRESH_OPTIONS = [0, 30, 60, 180, 360, 720, 1440]

/** 导入/导出的文档形状标识：换机或团队共享时用来认领文件，版本不符要能拒绝。 */
export const CONFIG_EXPORT_FORMAT = 'market-lens/sources'
export const CONFIG_EXPORT_VERSION = 1
/** 自定义源允许的 kind；dshbase 只有 HTML 页面、没有 JSON API，暂不接入（决定见 README「关于 dshbase.com」）。 */
export const CUSTOM_SOURCE_KINDS = ['standard', 'format1']
/** 这句同时给导入回执和“添加来源”的报错用，别在两处各写一份措辞。 */
export const DSHBASE_REASON = 'dshbase 目前只有 HTML 页面，未接入抓取；等它的 JSON API 上线再加'
const REJECTED_SOURCE_KINDS = new Map([['dshbase', DSHBASE_REASON]])

export const BUILT_IN_SOURCES = [
  {
    id: '1024store',
    kind: '1024store',
    name: 'DSH 1024Store',
    short: '1024',
    color: '#5b9dff',
    enabled: true,
    builtin: true,
  },
  {
    id: 'dshfind',
    kind: 'dshfind',
    name: 'dshfind',
    short: 'find',
    color: '#b48cff',
    enabled: true,
    builtin: true,
  },
  {
    id: 'dshso',
    kind: 'dshso',
    name: 'dsh.so 市场',
    short: 'dsh.so',
    color: '#4cc9b0',
    enabled: true,
    builtin: true,
    url: 'https://cdn.dsh.so/market/index.json',
  },
  {
    id: 'dshmarketplace',
    kind: 'dshmarketplace',
    name: 'dshmarketplace.dev',
    short: 'dshm',
    color: '#f08c5a',
    enabled: false,
    builtin: true,
    url: 'https://dshmarketplace.dev/api/v1/plugins',
  },
]

const ALLOWED_REFRESH = new Set(REFRESH_OPTIONS)

const describeError = (error) => {
  const code = error && error.code ? String(error.code) + ': ' : ''
  const text = error && error.message ? error.message : String(error)
  return code + text
}

/** 只接受 HTTPS、无凭据、默认端口的 URL —— 与 Host 的 validateHttpsUrl 同一口径。 */
function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.port && parsed.port !== '443') return false
  return true
}

// 旧配置文件没有 sourceHealth 字段：统一补默认值，升级后读取历史配置不能因此抛错
function normalizeHealth(entry) {
  const record = entry && typeof entry === 'object' ? entry : {}
  return {
    lastSuccessAt: typeof record.lastSuccessAt === 'string' ? record.lastSuccessAt : null,
    failureCount: Number.isInteger(record.failureCount) && record.failureCount > 0 ? record.failureCount : 0,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
  }
}

function configPath() {
  return path.join(cacheDirectory(), CONFIG_FILE)
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return null
  const kind = typeof value.kind === 'string' ? value.kind : 'standard'
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : value.id
  return {
    id: value.id,
    kind,
    name,
    short: typeof value.short === 'string' && value.short ? value.short : name.slice(0, 12),
    color: typeof value.color === 'string' ? value.color : '#8a94a6',
    enabled: value.enabled !== false,
    builtin: value.builtin === true,
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(typeof value.manifestUrl === 'string' ? { manifestUrl: value.manifestUrl } : {}),
    ...(typeof value.addedAt === 'string' ? { addedAt: value.addedAt } : {}),
  }
}

function defaults() {
  return {
    version: CONFIG_VERSION,
    refreshIntervalMinutes: 0,
    lastAutoRefreshAt: null,
    // 安全优先视图默认开启：默认只显示 dsh.so 低风险或安装验证通过的条目。
    safeView: true,
    sourceHealth: {},
    sources: BUILT_IN_SOURCES.map((source) => ({ ...source })),
  }
}

export function loadSourceConfig() {
  const file = configPath()
  const parsed = fs.existsSync(file) ? readJson(file) : null
  if (!parsed || parsed.version !== CONFIG_VERSION || !Array.isArray(parsed.sources)) {
    const created = defaults()
    try {
      writeJsonAtomic(file, created)
    } catch {
      // A read-only home still lets the dashboard run with defaults.
    }
    return created
  }

  const byId = new Map()
  for (const source of parsed.sources) {
    const normalized = normalizeSource(source)
    if (normalized) byId.set(normalized.id, normalized)
  }

  // Built-ins are always offered. Existing enable choices and custom sources survive
  // upgrades; a newly added built-in starts with its default state.
  for (const builtIn of BUILT_IN_SOURCES) {
    const existing = byId.get(builtIn.id)
    if (existing) {
      byId.set(builtIn.id, {
        ...builtIn,
        ...existing,
        kind: builtIn.kind,
        builtin: true,
        name: existing.name || builtIn.name,
        short: existing.short || builtIn.short,
        color: existing.color || builtIn.color,
        url: existing.url || builtIn.url,
      })
    } else {
      byId.set(builtIn.id, { ...builtIn })
    }
  }

  const sources = [...byId.values()]
  // 逐源健康状态是后加字段：老配置缺这一项就按空表处理，读取路径绝不因字段缺失而失败
  const storedHealth = parsed.sourceHealth && typeof parsed.sourceHealth === 'object' ? parsed.sourceHealth : {}
  const sourceHealth = Object.fromEntries(sources.map((source) => [source.id, normalizeHealth(storedHealth[source.id])]))
  // 条件请求标记同样是后加字段：缺了就是「从没做过条件请求」，
  // 下轮同步发普通 GET —— 这是正确的退化，不是错误。
  const storedCaches = parsed.sourceCaches && typeof parsed.sourceCaches === 'object' ? parsed.sourceCaches : {}
  const sourceCaches = Object.fromEntries(
    sources
      .map((source) => [source.id, storedCaches[source.id]])
      .filter(([, cache]) => cache && typeof cache === 'object'),
  )
  return {
    version: CONFIG_VERSION,
    refreshIntervalMinutes: ALLOWED_REFRESH.has(parsed.refreshIntervalMinutes) ? parsed.refreshIntervalMinutes : 0,
    lastAutoRefreshAt: typeof parsed.lastAutoRefreshAt === 'string' ? parsed.lastAutoRefreshAt : null,
    // 老配置没有 safeView：按默认开启处理（缺省即最保守的显示策略）
    safeView: parsed.safeView !== false,
    sourceHealth,
    sourceCaches,
    sources,
  }
}

export function saveSourceConfig(config) {
  const payload = {
    version: CONFIG_VERSION,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    lastAutoRefreshAt: config.lastAutoRefreshAt ?? null,
    safeView: config.safeView !== false,
    // 逐源健康状态和 lastAutoRefreshAt 存进同一份 settings，重启后仍能显示“上次成功/连续失败”
    sourceHealth: Object.fromEntries(
      config.sources.map((source) => [source.id, normalizeHealth(config.sourceHealth?.[source.id])]),
    ),
    // 条件请求标记（ETag / Last-Modified / lastConfirmedAt）。
    // 它描述的是「源的状态」而不是「目录的内容」，所以跟配置一起存：
    // clearCatalog 清缓存时不该把它顺手清掉，否则下次同步立刻退化成全量重拉。
    sourceCaches: Object.fromEntries(
      config.sources
        .map((source) => [source.id, config.sourceCaches?.[source.id]])
        .filter(([, cache]) => cache && typeof cache === 'object'),
    ),
    sources: config.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      short: source.short,
      color: source.color,
      enabled: source.enabled !== false,
      builtin: source.builtin === true,
      ...(source.url ? { url: source.url } : {}),
      ...(source.manifestUrl ? { manifestUrl: source.manifestUrl } : {}),
      ...(source.addedAt ? { addedAt: source.addedAt } : {}),
    })),
  }
  try {
    writeJsonAtomic(configPath(), payload)
  } catch (error) {
    // 写盘失败必须往上报：原先吞掉异常会让上层继续回 ok:true，用户以为设置已保存而磁盘没变
    return { ok: false, error: describeError(error) }
  }
  return { ok: true, config }
}

export function enabledSources(config) {
  return config.sources.filter((source) => source.enabled)
}

export function newCustomSourceId() {
  return 'custom-' + randomUUID()
}

export function publicSourceConfig(config) {
  return {
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    lastAutoRefreshAt: config.lastAutoRefreshAt ?? null,
    safeView: config.safeView !== false,
    sources: config.sources.map((source) => ({ ...source })),
  }
}

export function createCustomSource({ kind, name, url, manifestUrl }) {
  return normalizeSource({
    id: newCustomSourceId(),
    kind,
    name,
    short: name.slice(0, 12),
    color: '#8a94a6',
    enabled: true,
    builtin: false,
    ...(url ? { url } : {}),
    ...(manifestUrl ? { manifestUrl } : {}),
    addedAt: new Date().toISOString(),
  })
}

/**
 * 导出：自定义源 + 每个源的启停状态 + 定时刷新设置 + 安全优先视图开关。
 *
 * 只导"配置"，不导缓存和健康状态：换机之后上一台的 lastError / failureCount
 * 对新环境没有意义，带过去反而会让新机器一上来就显示"连续失败"。
 */
export function exportSourceConfig(config, options = {}) {
  return {
    format: CONFIG_EXPORT_FORMAT,
    formatVersion: CONFIG_EXPORT_VERSION,
    exportedAt: typeof options.exportedAt === 'string' ? options.exportedAt : new Date().toISOString(),
    plugin: { name: '@local/market-lens', version: options.pluginVersion || null },
    settings: {
      refreshIntervalMinutes: ALLOWED_REFRESH.has(config.refreshIntervalMinutes) ? config.refreshIntervalMinutes : 0,
      safeView: config.safeView !== false,
    },
    sources: config.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      short: source.short,
      color: source.color,
      enabled: source.enabled !== false,
      builtin: source.builtin === true,
      ...(source.url ? { url: source.url } : {}),
      ...(source.manifestUrl ? { manifestUrl: source.manifestUrl } : {}),
    })),
  }
}

/**
 * 导入：把导出的 JSON 合回当前配置。
 *
 * mode='merge'（默认）只增改，不动文档里没有的源；mode='replace' 把文档里没有的
 * 自定义源删掉（内置源永远保留，只对齐启停）。内置源只接受 enabled 覆盖——名字、
 * 颜色、地址是插件的代码契约，被一份外部 JSON 改掉就会连不上。
 *
 * 任何一个来源不合规都只 skip 并记进 report，不让整份配置导入失败：团队共享的
 * 配置里混进一条旧格式条目，是常态而不是异常。
 */
export function importSourceConfig(config, document, options = {}) {
  const mode = options.mode === 'replace' ? 'replace' : 'merge'
  const report = { mode, added: [], updated: [], unchanged: 0, removed: [], skipped: [], warnings: [] }
  const doc = document && typeof document === 'object' ? document : null
  if (!doc) return { ok: false, error: '导入内容不是 JSON 对象', report }
  if (doc.format && doc.format !== CONFIG_EXPORT_FORMAT) {
    return { ok: false, error: '不认识的配置格式：' + String(doc.format), report }
  }
  if (Number.isFinite(doc.formatVersion) && doc.formatVersion > CONFIG_EXPORT_VERSION) {
    return { ok: false, error: '配置格式版本 ' + doc.formatVersion + ' 高于插件支持的 ' + CONFIG_EXPORT_VERSION, report }
  }
  if (!Array.isArray(doc.sources)) return { ok: false, error: '配置里缺少 sources 数组', report }

  const sources = config.sources.map((source) => ({ ...source }))
  const next = { ...config, sources, sourceHealth: { ...config.sourceHealth } }

  const settings = doc.settings && typeof doc.settings === 'object' ? doc.settings : {}
  if ('refreshIntervalMinutes' in settings) {
    if (ALLOWED_REFRESH.has(settings.refreshIntervalMinutes)) next.refreshIntervalMinutes = settings.refreshIntervalMinutes
    else report.warnings.push('定时设置 ' + String(settings.refreshIntervalMinutes) + ' 不在允许范围内，已忽略')
  }
  if (typeof settings.safeView === 'boolean') next.safeView = settings.safeView

  const builtInIds = new Set(BUILT_IN_SOURCES.map((source) => source.id))
  const byId = new Map(sources.map((source) => [source.id, source]))
  const urlKeyOf = (source) => String(source.url || source.manifestUrl || '').toLowerCase()
  const byUrl = new Map(
    sources.filter((source) => !source.builtin && urlKeyOf(source)).map((source) => [urlKeyOf(source), source]),
  )
  const touched = new Set()

  for (const raw of doc.sources) {
    if (!raw || typeof raw !== 'object') {
      report.skipped.push({ id: null, reason: '条目不是对象' })
      continue
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const kind = typeof raw.kind === 'string' ? raw.kind : 'standard'
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id

    if (REJECTED_SOURCE_KINDS.has(kind)) {
      report.skipped.push({ id: id || name || null, reason: REJECTED_SOURCE_KINDS.get(kind) })
      continue
    }

    if (id && builtInIds.has(id)) {
      const target = byId.get(id)
      const enabled = raw.enabled !== false
      if (!target) {
        report.skipped.push({ id, reason: '内置源未注册' })
        continue
      }
      if (target.enabled !== enabled) {
        target.enabled = enabled
        report.updated.push(id)
      } else {
        report.unchanged += 1
      }
      touched.add(id)
      continue
    }

    if (!CUSTOM_SOURCE_KINDS.includes(kind)) {
      report.skipped.push({ id: id || name || null, reason: '不支持的来源类型：' + kind })
      continue
    }

    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    const manifestUrl = typeof raw.manifestUrl === 'string' ? raw.manifestUrl.trim() : ''
    const primary = url || manifestUrl
    if (!primary) {
      report.skipped.push({ id: id || name || null, reason: '缺少 url' })
      continue
    }
    if (!isHttpsUrl(primary)) {
      report.skipped.push({ id: id || name || null, reason: '地址必须是 HTTPS、无凭据、443 端口' })
      continue
    }

    const existing = (id && byId.get(id) && byId.get(id).builtin !== true ? byId.get(id) : null)
      || byUrl.get(primary.toLowerCase())
      || null
    if (existing && touched.has(existing.id)) {
      report.unchanged += 1
      continue
    }

    const normalized = normalizeSource({
      id: existing ? existing.id : (id || newCustomSourceId()),
      kind,
      name,
      short: typeof raw.short === 'string' && raw.short ? raw.short : name.slice(0, 12),
      color: typeof raw.color === 'string' ? raw.color : '#8a94a6',
      enabled: raw.enabled !== false,
      builtin: false,
      ...(url ? { url } : {}),
      ...(manifestUrl ? { manifestUrl } : {}),
      addedAt: existing?.addedAt || new Date().toISOString(),
    })

    if (existing) {
      Object.assign(existing, normalized, { id: existing.id })
      report.updated.push(existing.id)
      touched.add(existing.id)
      if (urlKeyOf(existing)) byUrl.set(urlKeyOf(existing), existing)
      continue
    }
    if (byId.has(normalized.id)) {
      report.skipped.push({ id: normalized.id, reason: 'id 已被占用' })
      continue
    }
    next.sources.push(normalized)
    byId.set(normalized.id, normalized)
    if (urlKeyOf(normalized)) byUrl.set(urlKeyOf(normalized), normalized)
    report.added.push(normalized.id)
    touched.add(normalized.id)
  }

  if (mode === 'replace') {
    next.sources = next.sources.filter((source) => {
      if (source.builtin) return true
      if (touched.has(source.id)) return true
      report.removed.push(source.id)
      return false
    })
  }

  // 健康状态只保留还存在的来源，避免删源后配置里留下孤儿键
  const alive = new Set(next.sources.map((source) => source.id))
  next.sourceHealth = Object.fromEntries(
    Object.entries(next.sourceHealth).filter(([sourceId]) => alive.has(sourceId)),
  )

  return { ok: true, config: next, report }
}
