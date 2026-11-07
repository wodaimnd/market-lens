/** Normalize every configured marketplace/index into one deduplicated, scored row model. */

import {
  fetchJson,
  freshnessScore,
  maxIso,
  npmNameOf,
  normalizeRepo,
  parseInstallTarget,
  pickText,
  pool,
  safeCount,
  scoreLabel,
  toIso,
} from './util.js'
import { BUILT_IN_RULES, prepareMetrics, scoreGroup, scoreLabelFromRules } from './rules.js'

export const CATALOG_1024_ENDPOINT = 'https://deepseek1024.com/api/v2/plugins'
export const CATALOG_DSHFIND_ENDPOINT = 'https://api.dshfind.com/market/dsh-index.json'
export const CATALOG_DSHSO_ENDPOINT = 'https://cdn.dsh.so/market/index.json'
export const CATALOG_DSHMARKETPLACE_ENDPOINT = 'https://dshmarketplace.dev/api/v1/plugins'
export const MAX_1024_PAGES = 120
export const PAGE_SIZE_1024 = 200
export const MAX_STANDARD_PAGES = 200
export const MAX_STANDARD_ITEMS = 30_000

const CATEGORY_LABELS = {
  tools: { zh: '工具与能力', en: 'Tools' },
  ui: { zh: '界面增强', en: 'UI' },
  dev: { zh: '开发与运行时', en: 'Dev' },
  skill: { zh: '技能包', en: 'Skills' },
  session: { zh: '会话与消息', en: 'Sessions' },
  model: { zh: '模型与账号', en: 'Models' },
  workflow: { zh: '工作流', en: 'Workflow' },
  fun: { zh: '娱乐', en: 'Fun' },
  notify: { zh: '通知与集成', en: 'Notify' },
  theme: { zh: '主题外观', en: 'Themes' },
  memory: { zh: '记忆', en: 'Memory' },
  client: { zh: '客户端', en: 'Clients' },
  agent: { zh: 'Agent 增强', en: 'Agent' },
  channel: { zh: '通道通知', en: 'Channels' },
  resource: { zh: '资源导航', en: 'Resources' },
  skin: { zh: '主题外观', en: 'Skins' },
  docs: { zh: '文档与内容', en: 'Docs' },
  remote: { zh: '远程运维', en: 'Remote' },
  browser: { zh: '浏览器', en: 'Browser' },
  vision: { zh: '视觉理解', en: 'Vision' },
  market: { zh: '市场与插件管理', en: 'Market' },
  data: { zh: '数据与存储', en: 'Data' },
  security: { zh: '安全', en: 'Security' },
  productivity: { zh: '效率', en: 'Productivity' },
  content: { zh: '内容创作', en: 'Content' },
  office: { zh: '办公文档', en: 'Office' },
  search: { zh: '联网搜索', en: 'Search' },
  agents: { zh: '智能体编排', en: 'Agents' },
  creator: { zh: '内容与社交', en: 'Creator' },
  other: { zh: '其他', en: 'Other' },
}

export function categoryLabel(key, language = 'zh') {
  const entry = CATEGORY_LABELS[key]
  if (entry) return entry[language] || entry.zh
  return key || (language === 'en' ? 'Other' : '其他')
}

const CATEGORY_ALIASES = {
  skin: 'theme',
  skins: 'theme',
  agents: 'agent',
  creator: 'content',
  docs: 'docs',
  remote: 'remote',
  browser: 'browser',
  vision: 'vision',
  market: 'market',
  data: 'data',
  security: 'security',
  productivity: 'productivity',
  content: 'content',
  office: 'office',
  search: 'search',
}

function categoryKey(value, source) {
  if (typeof value !== 'string' || !value) return 'other'
  const key = value.toLowerCase()
  const mapped = CATEGORY_ALIASES[key] || key
  if (CATEGORY_LABELS[mapped]) return mapped
  if (source === 'dshfind' && key === 'skin') return 'theme'
  return 'other'
}

// Identity is the install target, never a display name. A 1024Store item without
// a `#path:` installs the repository root, which is the same key the format1
// sources already emit for that repository; stamping the item name into the key
// made 6,316 of the 7,787 suffixed rows look like separate plugins from their
// own unsuffixed duplicates (measured on the 23,033-row cache before the fix).
// Only a real subpath still earns a suffix, because it is a different install.
function rowKeyFor1024(item, target) {
  if (target?.npm) return 'pkg:' + target.npm.toLowerCase()
  // The install target wins over the display URL: when a 1024Store entry lists
  // repo A but installs `github:owner/B`, keying on A would file the row under
  // one repository while the install command points at another.
  const repo = target?.repo || normalizeRepo(item.url)
  if (!repo) return '1024:' + String(item.id || item.name)
  const subpath = target?.subpath ? '#' + target.subpath.toLowerCase() : ''
  return 'gh:' + repo.toLowerCase() + subpath
}

export function normalize1024(item, profileName = 'desktop') {
  if (!item || typeof item !== 'object') return null
  const target = parseInstallTarget(item.install)
  // Install target first, display URL second: key, repo link and install command
  // must all name the same repository, otherwise a row claims identity B while
  // its install command still points at A.
  const repo = target?.repo || normalizeRepo(item.url) || null
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name && !target?.npm) return null
  const category = categoryKey(item.category, '1024store')
  const description = pickText(item.description)
  const pushedAt = toIso(item.pushedAt)
  const updatedAt = toIso(item.updatedAt) || toIso(item.added) || pushedAt

  return {
    key: rowKeyFor1024(item, target),
    name: target?.npm || name,
    title: name || target?.npm || '',
    description,
    descriptionSource: description ? '1024store' : null,
    pkg: target?.npm || null,
    repo,
    homepage: typeof item.url === 'string' ? item.url : null,
    author: typeof item.owner === 'string' ? item.owner : null,
    category,
    sources: ['1024store'],
    sourceIds: { '1024store': String(item.id || name) },
    version: null,
    publishedAt: null,
    pushedAt,
    catalogUpdatedAt: updatedAt,
    updatedAt: maxIso(pushedAt, updatedAt),
    updatedFrom: pushedAt ? 'github-push' : updatedAt ? 'catalog' : null,
    installers: safeCount(item.installerCount),
    installs: safeCount(item.installCount),
    failures: safeCount(item.failureCount),
    downloads: safeCount(item.npmDownloads7d),
    stars: safeCount(item.stars),
    forks: safeCount(item.forks),
    score: null,
    featured: false,
    latestReleaseAt: toIso(item.latestReleaseAt),
    installCommand: target ? `dsh plugin --profile ${profileName} add ${target.raw}` : null,
    installSource: '1024store',
    sourceHomepage: 'https://deepseek1024.com',
    sourceUrls: { '1024store': typeof item.url === 'string' ? item.url : 'https://deepseek1024.com' },
    security: null,
    verification: null,
    riskFlags: [],
    license: null,
    installable: Boolean(target),
    rawGrowth: {
      d7: safeCount(item.growth7d),
      d30: safeCount(item.growth30d),
    },
  }
}

function latestVersionOf(item) {
  const versions = Array.isArray(item.versions) ? item.versions : []
  let latest = null
  for (const candidate of versions) {
    if (!candidate || typeof candidate.version !== 'string') continue
    const at = toIso(candidate.publishTimestamp)
    if (!latest || (at && (!latest.at || at > latest.at))) {
      latest = { version: candidate.version, at, engines: candidate.engines ?? null, sourceType: candidate.source?.type ?? null }
    }
  }
  return latest
}

function sourceSecurityFromLabels(labels) {
  const set = new Set(Array.isArray(labels) ? labels : [])
  const risk = set.has('risk-low') ? 'low' : set.has('risk-medium') ? 'medium' : set.has('risk-high') ? 'high' : null
  if (!risk) return null
  return { status: 'audited', riskLevel: risk, label: 'risk-' + risk }
}

/**
 * Generic format 1 index adapter. Used by dshfind, dsh.so's curated market and
 * any user-added format 1 source. Version engines are kept as evidence; npm
 * latest remains the compatibility authority.
 */
export function normalizeFormat1(item, { sourceId, sourceName, sourceHomepage, profileName = 'desktop' } = {}) {
  if (!item || typeof item !== 'object') return null
  const repo = normalizeRepo(item.repository?.url)
  const sourceLabel = sourceId || 'format1'
  const latest = latestVersionOf(item)
  const preferNpm = sourceId === 'dshfind' || latest?.sourceType === 'npm' || !repo
  const pkg = preferNpm ? npmNameOf(item.name) || npmNameOf(item.alias) : null
  if (!pkg && !repo) return null
  const description = pickText(item.description)
  const labels = Array.isArray(item.metadata?.labels) ? item.metadata.labels : []
  const sortKeys = item.metadata?.sortKeys && typeof item.metadata.sortKeys === 'object' ? item.metadata.sortKeys : {}
  const score = safeCount(sortKeys.score)
  const stars = safeCount(sortKeys.stars)
  const downloads = safeCount(sortKeys.downloads ?? sortKeys.npmDownloads ?? sortKeys.download)
  const category = categoryKey(item.metadata?.category, sourceLabel)
  const title = pickText(item.title) || item.name || pkg || ''
  const installCommand = pkg
    ? `dsh plugin --profile ${profileName} add ${pkg}`
    : repo
      ? `dsh plugin --profile ${profileName} add github:${repo.replace('https://github.com/', '')}`
      : null
  const security = sourceSecurityFromLabels(labels)
  const verification = labels.includes('install-verified')
    ? { installCheck: 'passed', label: 'install-verified' }
    : null

  return {
    // Identity is the install target: a format1 entry without a package installs
    // the repository root, so `item.id` must not leak into its identity.
    key: pkg ? 'pkg:' + pkg.toLowerCase() : 'gh:' + repo.toLowerCase(),
    name: pkg || title || repo,
    title: title || pkg || repo,
    description,
    descriptionSource: description ? sourceLabel : null,
    pkg,
    repo,
    homepage: typeof item.homepage === 'string' ? item.homepage : null,
    author: typeof item.author === 'string' ? item.author : null,
    category,
    sources: [sourceLabel],
    sourceIds: { [sourceLabel]: item.name || item.id || pkg || repo },
    version: latest?.version ?? null,
    publishedAt: latest?.at ?? null,
    pushedAt: null,
    catalogUpdatedAt: latest?.at ?? null,
    updatedAt: latest?.at ?? null,
    updatedFrom: latest?.at ? 'npm-publish' : null,
    installers: null,
    installs: null,
    failures: null,
    downloads,
    stars,
    forks: null,
    score,
    featured: labels.includes('featured'),
    latestReleaseAt: null,
    installCommand,
    installSource: sourceLabel,
    sourceHomepage: sourceHomepage || 'https://dshfind.com',
    sourceUrls: { [sourceLabel]: typeof item.homepage === 'string' ? item.homepage : sourceHomepage || '' },
    security,
    verification,
    riskFlags: [],
    license: null,
    installable: Boolean(installCommand),
    enginesDsh: latest?.engines?.dsh ?? null,
    rawGrowth: null,
  }
}

export function normalizeDshfind(item, profileName = 'desktop') {
  return normalizeFormat1(item, {
    sourceId: 'dshfind',
    sourceName: 'dshfind',
    sourceHomepage: 'https://dshfind.com',
    profileName,
  })
}

/** dshmarketplace.dev public API item. */
export function normalizeDshmarketplace(item, profileName = 'desktop') {
  if (!item || typeof item !== 'object') return null
  const target = parseInstallTarget(item.install)
  const pkg = npmNameOf(item.npmPackage) || target?.npm || null
  const repo = normalizeRepo(item.repoUrl)
  const subpath = typeof item.subpath === 'string' ? item.subpath.replace(/^\/+|\/+$/g, '') : ''
  if (!pkg && !repo) return null
  const key = pkg
    ? 'pkg:' + pkg.toLowerCase()
    : 'gh:' + repo.toLowerCase() + (subpath ? '#' + subpath.toLowerCase() : '')
  const description = typeof item.summaryZh === 'string' && item.summaryZh.trim()
    ? item.summaryZh.trim()
    : typeof item.summary === 'string'
      ? item.summary.trim()
      : ''
  const category = categoryKey(item.category, 'dshmarketplace')
  const pushedAt = toIso(item.pushedAt)
  const installCommand = target
    ? `dsh plugin --profile ${profileName} add ${target.raw}`
    : pkg
      ? `dsh plugin --profile ${profileName} add ${pkg}`
      : repo
        ? `dsh plugin --profile ${profileName} add github:${repo.replace('https://github.com/', '')}${subpath ? '#path:' + subpath : ''}`
        : null
  const installCheck = typeof item.installCheck === 'string' ? item.installCheck : null
  const riskFlags = Array.isArray(item.riskFlags) ? item.riskFlags.filter((flag) => typeof flag === 'string') : []

  return {
    key,
    name: pkg || item.name || item.fullName || repo,
    title: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.fullName || pkg || repo,
    description,
    descriptionSource: description ? 'dshmarketplace' : null,
    pkg,
    repo,
    homepage: typeof item.url === 'string' ? item.url : null,
    author: typeof item.owner === 'string' ? item.owner : null,
    category,
    sources: ['dshmarketplace'],
    sourceIds: { dshmarketplace: item.fullName || pkg || repo },
    version: null,
    publishedAt: null,
    pushedAt,
    catalogUpdatedAt: pushedAt,
    updatedAt: pushedAt,
    updatedFrom: pushedAt ? 'github-push' : null,
    installers: null,
    installs: null,
    failures: null,
    downloads: null,
    stars: safeCount(item.stars),
    forks: null,
    score: null,
    featured: false,
    latestReleaseAt: null,
    installCommand,
    installSource: 'dshmarketplace',
    sourceHomepage: 'https://dshmarketplace.dev',
    sourceUrls: { dshmarketplace: typeof item.url === 'string' ? item.url : 'https://dshmarketplace.dev' },
    security: null,
    verification: installCheck
      ? { installCheck, label: installCheck, installCheckDsh: item.installCheckDsh ?? null }
      : null,
    riskFlags,
    license: typeof item.license === 'string' ? item.license : null,
    installable: Boolean(item.installable) || Boolean(installCommand),
    enginesDsh: null,
    rawGrowth: null,
  }
}

/** One item from a public catalog-source /v1/plugins page. */
export function normalizeStandardItem(item, { sourceId, sourceName, profileName = 'desktop' } = {}) {
  if (!item || typeof item !== 'object') return null
  const pkg = npmNameOf(item.package?.name)
  const repo = normalizeRepo(item.repository?.url)
  // Must match parseInstallTarget, which strips leading/trailing slashes from
  // `#path:`: `/packages/x` and `packages/x` are the same directory, and leaving
  // the slash in would key one install target under two different rows.
  const subdirectory = typeof item.repository?.subdirectory === 'string'
    ? item.repository.subdirectory.trim().replace(/^\/+|\/+$/g, '')
    : ''
  const sourceLabel = sourceId || 'standard'
  if (!pkg && !repo) return null
  const title = typeof item.displayName === 'string' && item.displayName.trim()
    ? item.displayName.trim()
    : typeof item.name === 'string'
      ? item.name
      : pkg || repo
  const description = typeof item.summary === 'string' && item.summary.trim()
    ? item.summary.trim()
    : typeof item.description === 'string'
      ? item.description
      : ''
  const category = categoryKey(Array.isArray(item.categories) ? item.categories[0] : null, sourceLabel)
  const updatedAt = toIso(item.updatedAt)
  const installCommand = pkg
    ? `dsh plugin --profile ${profileName} add ${pkg}`
    : repo
      ? `dsh plugin --profile ${profileName} add github:${repo.replace('https://github.com/', '')}`
      : null

  return {
    // The provider page carries the only legitimate sub-identity: repository.subdirectory.
    key: pkg
      ? 'pkg:' + pkg.toLowerCase()
      : 'gh:' + repo.toLowerCase() + (subdirectory ? '#' + subdirectory.toLowerCase() : ''),
    name: pkg || item.name || title,
    title,
    description,
    descriptionSource: description ? sourceLabel : null,
    pkg,
    repo,
    homepage: typeof item.homepage === 'string' ? item.homepage : null,
    author: typeof item.publisher?.name === 'string' ? item.publisher.name : null,
    category,
    sources: [sourceLabel],
    sourceIds: { [sourceLabel]: item.id || pkg || repo },
    version: typeof item.latestVersion === 'string' ? item.latestVersion : null,
    publishedAt: null,
    pushedAt: null,
    catalogUpdatedAt: updatedAt,
    updatedAt,
    updatedFrom: updatedAt ? 'catalog' : null,
    installers: null,
    installs: null,
    failures: null,
    downloads: null,
    stars: null,
    forks: null,
    score: null,
    featured: false,
    latestReleaseAt: null,
    installCommand,
    installSource: sourceLabel,
    sourceHomepage: sourceName || 'standard',
    sourceUrls: { [sourceLabel]: typeof item.homepage === 'string' ? item.homepage : '' },
    security: null,
    verification: null,
    riskFlags: [],
    license: null,
    installable: Boolean(installCommand),
    enginesDsh: null,
    rawGrowth: null,
  }
}

const DESCRIPTION_PRIORITY = { '1024store': 5, dshmarketplace: 4, dshso: 3, dshfind: 2 }
const INSTALL_PRIORITY = { '1024store': 5, dshmarketplace: 4, dshso: 3, dshfind: 2 }

const securityRank = (security) => {
  if (!security) return 0
  const status = security.status === 'audited' ? 3 : security.status === 'pending' ? 1 : 0
  const risk = security.riskLevel === 'low' ? 3 : security.riskLevel === 'medium' ? 2 : security.riskLevel === 'high' ? 1 : 0
  return status * 10 + risk
}

const verificationRank = (verification) => {
  if (!verification) return 0
  const check = verification.installCheck === 'passed' ? 3 : verification.installCheck === 'failed' ? 1 : 0
  return check * 100 + (Number.isFinite(verification.level) ? verification.level : 0)
}

function priorityOf(sourceId, table) {
  return table[sourceId] ?? 1
}

function mergeRow(target, incoming) {
  const sources = new Set([...target.sources, ...incoming.sources])
  target.sources = [...sources]
  target.sourceIds = { ...target.sourceIds, ...incoming.sourceIds }
  target.sourceUrls = { ...(target.sourceUrls || {}), ...(incoming.sourceUrls || {}) }

  const incomingPriority = priorityOf(incoming.descriptionSource, DESCRIPTION_PRIORITY)
  const targetPriority = priorityOf(target.descriptionSource, DESCRIPTION_PRIORITY)
  if (incoming.description && (!target.description || incomingPriority > targetPriority)) {
    target.description = incoming.description
    target.descriptionSource = incoming.descriptionSource
  }
  if (!target.repo && incoming.repo) target.repo = incoming.repo
  if (!target.author && incoming.author) target.author = incoming.author
  if (!target.homepage && incoming.homepage) target.homepage = incoming.homepage
  if (!target.version && incoming.version) target.version = incoming.version
  if (!target.category || target.category === 'other') target.category = incoming.category
  if (incoming.installCommand
    && (!target.installCommand
      || priorityOf(incoming.installSource, INSTALL_PRIORITY) > priorityOf(target.installSource, INSTALL_PRIORITY))) {
    target.installCommand = incoming.installCommand
    target.installSource = incoming.installSource
  }
  if (!target.license && incoming.license) target.license = incoming.license
  target.installable = Boolean(target.installable || incoming.installable)
  if (Number.isFinite(incoming.enginesDsh) && !target.enginesDsh) target.enginesDsh = incoming.enginesDsh
  if (securityRank(incoming.security) > securityRank(target.security)) target.security = incoming.security
  if (verificationRank(incoming.verification) > verificationRank(target.verification)) target.verification = incoming.verification
  if (Array.isArray(incoming.riskFlags) && incoming.riskFlags.length) {
    target.riskFlags = [...new Set([...(target.riskFlags || []), ...incoming.riskFlags])]
  }

  target.installers = Math.max(target.installers ?? 0, incoming.installers ?? 0) || null
  target.installs = Math.max(target.installs ?? 0, incoming.installs ?? 0) || null
  target.failures = Math.max(target.failures ?? 0, incoming.failures ?? 0) || null
  target.downloads = Math.max(target.downloads ?? 0, incoming.downloads ?? 0) || null
  target.stars = Math.max(target.stars ?? 0, incoming.stars ?? 0) || null
  target.forks = Math.max(target.forks ?? 0, incoming.forks ?? 0) || null
  if (incoming.score !== null) target.score = Math.max(target.score ?? 0, incoming.score)
  target.featured = target.featured || incoming.featured

  const nextUpdated = maxIso(target.updatedAt, incoming.updatedAt)
  if (nextUpdated && nextUpdated !== target.updatedAt) {
    target.updatedAt = nextUpdated
    if (incoming.updatedAt === nextUpdated) target.updatedFrom = incoming.updatedFrom
  }
  target.pushedAt = maxIso(target.pushedAt, incoming.pushedAt)
  target.publishedAt = maxIso(target.publishedAt, incoming.publishedAt)
  target.catalogUpdatedAt = maxIso(target.catalogUpdatedAt, incoming.catalogUpdatedAt)
  target.latestReleaseAt = maxIso(target.latestReleaseAt, incoming.latestReleaseAt)
  if (incoming.rawGrowth && !target.rawGrowth) target.rawGrowth = incoming.rawGrowth
}

function defaultCompat(row) {
  if (row.pkg) return { status: 'pending', reason: 'not-checked' }
  return { status: 'no-package', reason: 'github-only' }
}

function attachScores(rows, now = Date.now(), rules = null) {
  // 不传 rules 时必须与 0.5.0 的硬编码口径逐字一致：BUILT_IN_RULES 就是那份口径的声明式翻版
  const active = rules || BUILT_IN_RULES
  const context = prepareMetrics(rows, active)

  for (const row of rows) {
    const market = scoreGroup(active.market, row, context, now)
    const marketParts = market.parts.map((part) => ({ key: part.key, weight: part.weight, value: part.value }))

    const community = scoreGroup(active.community, row, context, now)
    const communityParts = community.parts.map((part) => ({ key: part.key, weight: part.weight, value: part.value }))
    // 旧口径：没有 stars 的行 communityScore 保持 null（界面显示为「—」而不是 0 分）
    const communityScore = communityParts.length ? community.score : null

    const heat = scoreGroup(active.heat, row, context, now)

    row.marketScore = market.score
    row.marketLabel = scoreLabelFromRules(market.score, active.labels)
    row.marketParts = marketParts
    row.communityScore = communityScore
    row.communityLabel = communityScore === null ? scoreLabel(communityScore) : scoreLabelFromRules(communityScore, active.labels)
    row.communityParts = communityParts
    row.heat = heat.score
    row.freshness = freshnessScore(row.updatedAt, now)
  }
  return rows
}

export function buildCatalog({ sourceRows = [], compat = new Map(), installed = new Map(), profileName = 'desktop', now = Date.now(), rules = null }) {
  const rows = new Map()

  for (const row of sourceRows) {
    if (!row || !row.key) continue
    const existing = rows.get(row.key)
    if (existing) mergeRow(existing, row)
    else rows.set(row.key, row)
  }

  const list = []
  for (const row of rows.values()) {
    if (row.pkg) {
      const entry = compat.get(row.pkg.toLowerCase())
      row.compat = entry ?? defaultCompat(row)
      if (!row.version && entry && typeof entry.version === 'string') row.version = entry.version
    } else {
      row.compat = defaultCompat(row)
    }
    const install = row.pkg ? installed.get(row.pkg.toLowerCase()) : null
    row.installed = Boolean(install)
    row.installedVersion = install?.version ?? null
    list.push(row)
  }

  attachScores(list, now, rules)
  list.sort((left, right) => right.heat - left.heat || left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }))
  return list
}

export async function fetch1024Catalog({ signal, onProgress } = {}) {
  const first = await fetchJson(`${CATALOG_1024_ENDPOINT}?page=1&limit=${PAGE_SIZE_1024}`, {
    signal,
    timeoutMs: 60_000,
    retries: 3,
  })
  const firstValue = first.value
  if (!firstValue || !Array.isArray(firstValue.plugins)) throw new Error('1024Store returned an invalid catalog page')
  const totalPages = Math.max(1, Math.min(MAX_1024_PAGES, Number(firstValue.totalPages) || 1))
  const items = [...firstValue.plugins]
  const errors = []
  let done = 1
  onProgress?.({ done, total: totalPages, status: 'fetching' })

  const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2)
  await pool(pages, 4, async (page) => {
    try {
      const response = await fetchJson(`${CATALOG_1024_ENDPOINT}?page=${page}&limit=${PAGE_SIZE_1024}`, {
        signal,
        timeoutMs: 60_000,
        retries: 3,
      })
      if (Array.isArray(response.value?.plugins)) items.push(...response.value.plugins)
      else errors.push(`page ${page}: invalid response`)
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      done++
      onProgress?.({ done, total: totalPages, status: 'fetching' })
    }
  })

  return {
    items,
    meta: {
      total: Number(firstValue.total) || items.length,
      totalPages,
      catalogTotal: Number(firstValue.catalogTotal) || items.length,
      generatedAt: toIso(firstValue.generatedAt),
      source: typeof firstValue.source === 'string' ? firstValue.source : null,
      categories: Array.isArray(firstValue.categories) ? firstValue.categories : [],
      fetchedAt: new Date().toISOString(),
      pagesFetched: totalPages,
      errors,
    },
  }
}

/**
 * 单文档 format 1 索引（dshfind / dsh.so 都走这条）。
 *
 * 这里支持**条件请求**：它是整份单文档，正适合 If-None-Match。
 * 传 `conditional: { etag, lastModified }` 时：
 *   · 服务端回 304 → 返回 `{ notModified: true, etag, lastModified }`，
 *     **items 为 null** —— 调用方据此跳过重写 46MB 快照，只推进 lastConfirmedAt
 *   · 回 200 → 正常解析，并把新的 etag / lastModified 带回去
 *
 * 注意 304 不是常态（多数源站不发 ETag），所以"没拿到 304"绝不能算失败。
 */
export async function fetchFormat1Index(url, { signal, onProgress, timeoutMs = 180_000, conditional = null } = {}) {
  onProgress?.({ status: 'fetching' })
  const response = await fetchJson(url, {
    signal,
    timeoutMs,
    retries: 2,
    conditional,
  })

  // 304：内容没变。不解析 body（服务端也没发），只把标记原样带回去。
  if (response.notModified) {
    onProgress?.({ status: 'not-modified' })
    return {
      notModified: true,
      items: null,
      meta: {
        format: 1,
        fetchedAt: new Date().toISOString(),
        notModified: true,
        etag: response.etag ?? null,
        lastModified: response.lastModified ?? null,
      },
      etag: response.etag ?? null,
      lastModified: response.lastModified ?? null,
    }
  }

  const value = response.value
  if (!value || value.format !== 1 || !Array.isArray(value.plugins)) {
    throw new Error('index is not a format 1 plugin index')
  }
  onProgress?.({ status: 'done', total: value.plugins.length })
  return {
    notModified: false,
    items: value.plugins,
    meta: {
      format: value.format,
      title: value.title ?? null,
      description: value.description ?? null,
      categories: value.metadata?.categories ?? {},
      labels: value.metadata?.labels ?? {},
      fetchedAt: new Date().toISOString(),
      bytes: response.bytes,
      etag: response.etag ?? null,
      lastModified: response.lastModified ?? null,
    },
    etag: response.etag ?? null,
    lastModified: response.lastModified ?? null,
  }
}

export async function fetchDshfindIndex(options = {}) {
  return fetchFormat1Index(CATALOG_DSHFIND_ENDPOINT, { ...options, timeoutMs: 120_000 })
}

/** dshmarketplace.dev paginated REST feed (limit is capped at 96 by the API). */
export async function fetchDshmarketplaceCatalog({ signal, onProgress } = {}) {
  const first = await fetchJson(`${CATALOG_DSHMARKETPLACE_ENDPOINT}?page=1&limit=100`, {
    signal,
    timeoutMs: 60_000,
    retries: 3,
  })
  const firstValue = first.value
  if (!firstValue || !Array.isArray(firstValue.results)) throw new Error('dshmarketplace returned an invalid feed')
  const total = Number(firstValue.total) || firstValue.results.length
  const maxPages = Math.min(260, Math.ceil(total / 90) + 3)
  const items = [...firstValue.results]
  const errors = []
  let done = 1
  onProgress?.({ status: 'fetching', done, total: maxPages })

  const pages = Array.from({ length: Math.max(0, maxPages - 1) }, (_, index) => index + 2)
  const pageResults = await pool(pages, 5, async (page) => {
    try {
      const response = await fetchJson(`${CATALOG_DSHMARKETPLACE_ENDPOINT}?page=${page}&limit=100`, {
        signal,
        timeoutMs: 60_000,
        retries: 2,
      })
      return Array.isArray(response.value?.results) ? response.value.results : []
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    } finally {
      done++
      onProgress?.({ status: 'fetching', done, total: maxPages })
    }
  })
  for (const results of pageResults) items.push(...results)
  onProgress?.({ status: 'done', done, total: maxPages })
  return {
    items,
    meta: {
      total,
      fetchedAt: new Date().toISOString(),
      pages: maxPages,
      errors,
      kind: 'dshmarketplace',
    },
  }
}

/**
 * Standard catalog-source contract: a manifest pointing at one HTTPS JSON
 * endpoint that returns normalized provider pages.
 */
export async function fetchStandardCatalog(source, { signal, onProgress } = {}) {
  if (!source?.manifestUrl) throw new Error('standard source has no manifest URL')
  const manifestResponse = await fetchJson(source.manifestUrl, {
    signal,
    timeoutMs: 30_000,
    retries: 2,
  })
  const manifest = manifestResponse.value
  if (!manifest || typeof manifest.manifestVersion !== 'string'
    || !manifest.transport || typeof manifest.transport.endpoint !== 'string') {
    throw new Error('standard source manifest is invalid')
  }
  const endpoint = new URL(manifest.transport.endpoint)
  if (endpoint.protocol !== 'https:') throw new Error('standard source endpoint must be HTTPS')
  const items = []
  let cursor
  let page = 0
  onProgress?.({ status: 'fetching', done: 0, total: 0 })
  while (page < MAX_STANDARD_PAGES && items.length < MAX_STANDARD_ITEMS) {
    page++
    const url = new URL(endpoint.href)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await fetchJson(url.href, { signal, timeoutMs: 60_000, retries: 2 })
    const value = response.value
    if (!value || !Array.isArray(value.items)) throw new Error('standard source page is invalid')
    items.push(...value.items)
    onProgress?.({ status: 'fetching', done: page, total: page })
    const next = value.page?.nextCursor
    if (typeof next !== 'string' || !next) break
    cursor = next
  }
  return {
    items,
    meta: {
      manifest,
      providerId: manifest.providerId ?? null,
      name: manifest.name ?? source.name,
      fetchedAt: new Date().toISOString(),
      pages: page,
      kind: 'standard',
    },
  }
}

/** Build the public source dossier sent to the client. */
export function sourceSummary({ p1024Meta, dshfindMeta, rows, compat }) {
  const counts = {
    rows: rows.length,
    withUsers: rows.filter((row) => row.installers !== null).length,
    withRating: rows.filter((row) => Number.isFinite(row.score)).length,
    withStars: rows.filter((row) => row.stars !== null).length,
    withCompatibility: rows.filter((row) => row.compat?.status === 'ok' || row.compat?.status === 'bad').length,
    withNpm: rows.filter((row) => row.pkg).length,
  }
  return {
    '1024store': {
      meta: p1024Meta,
      rows: rows.filter((row) => row.sources.includes('1024store')).length,
      users: rows.filter((row) => row.sources.includes('1024store') && row.installers !== null).length,
    },
    dshfind: {
      meta: dshfindMeta,
      rows: rows.filter((row) => row.sources.includes('dshfind')).length,
      ratings: rows.filter((row) => row.sources.includes('dshfind') && Number.isFinite(row.score)).length,
    },
    compat: {
      checked: compat.checked,
      total: compat.total,
      done: compat.done,
    },
    counts,
  }
}
