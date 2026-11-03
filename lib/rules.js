/**
 * 评分规则引擎。
 *
 * 原先 marketScore / communityScore / heat 的权重与归一化方式全部硬编码在
 * lib/catalog.js 的 attachScores 里（rating 0.55 / users 0.25 / freshness 0.1 /
 * pick 0.1 之类）。用户想调口径只能改源码，而不同来源的市场（1024store /
 * GitHub / 自建索引）数量级差好几个量级，固定权重对谁都合适不了。
 *
 * 这里把「怎么算分」抽成一份纯声明式的 JSON：
 *   - 指标（factor.metric）只描述取哪个字段；
 *   - 归一化（factor.norm）只描述怎么把原始值映射到 0..100；
 *   - 权重（factor.weight）在内部分别归一化，所以用户写 55/25/10/10 和 0.55/0.25/0.1/0.1 等价；
 *   - 一组因子算不出来时（例如 GitHub 行没有安装量）可以退回 fallback 因子组。
 *
 * 两条硬约束：
 *   1. rules 参数必须可选。不传时的结果与旧版 attachScores 完全一致（含
 *      marketScore 在缺 rating 时切到 users/freshness/coverage 那一组，
 *      以及 communityScore 在 stars 为 null 时保持 null）。
 *   2. 规则文件是外部输入，一律先经 normalizeRules 收敛（白名单指标、
 *      白名单归一化、权重钳到 0..1、阈值排序），非法输入抛
 *      MarketRulesError 并带可读的字段路径，不能把半个坏规则带进计算。
 */

import { clampScore, freshnessScore, logScore } from './util.js'

export const RULES_VERSION = 1
export const RULES_FILE = 'scoring-rules.json'
export const RULES_LIBRARY_FILE = 'scoring-rules-library.json'
export const RULES_EXPORT_FORMAT = 'market-lens/scoring-rules'
export const RULES_EXPORT_VERSION = 1

/** 单条规则里最多多少个因子：够用，且防止上传一个几千项的文件把计算拖爆。 */
const MAX_FACTORS = 12
const MAX_NAME = 80
const MAX_DESCRIPTION = 400

export class MarketRulesError extends Error {
  constructor(message, issues = []) {
    super(message)
    this.name = 'MarketRulesError'
    this.issues = issues
  }
}

/**
 * 指标白名单：key → { label, kind, pick(row) | raw(row) }。
 * kind 只用于文档展示与模版注释；pick 返回数字或 null（null = 该行没有这个指标）。
 */
export const METRIC_REGISTRY = {
  rating: { label: { zh: '市场评分', en: 'Market rating' }, kind: 'score', pick: (row) => (Number.isFinite(row.score) ? row.score : null) },
  users: { label: { zh: '安装量', en: 'Installers' }, kind: 'count', pick: (row) => (Number.isFinite(row.installers) ? row.installers : null) },
  stars: { label: { zh: 'Star 数', en: 'Stars' }, kind: 'count', pick: (row) => (Number.isFinite(row.stars) ? row.stars : null) },
  downloads: { label: { zh: '下载量', en: 'Downloads' }, kind: 'count', pick: (row) => (Number.isFinite(row.downloads) ? row.downloads : null) },
  forks: { label: { zh: 'Fork 数', en: 'Forks' }, kind: 'count', pick: (row) => (Number.isFinite(row.forks) ? row.forks : null) },
  installs: { label: { zh: '安装次数', en: 'Installs' }, kind: 'count', pick: (row) => (Number.isFinite(row.installs) ? row.installs : null) },
  failures: { label: { zh: '失败次数', en: 'Failures' }, kind: 'count', pick: (row) => (Number.isFinite(row.failures) ? row.failures : null) },
  freshness: { label: { zh: '新鲜度', en: 'Freshness' }, kind: 'derived', pick: (row) => row.updatedAt },
  pick: { label: { zh: '编辑精选', en: 'Editorial pick' }, kind: 'derived', pick: (row) => Boolean(row.featured) },
  coverage: { label: { zh: '来源覆盖', en: 'Source coverage' }, kind: 'derived', pick: (row) => (Array.isArray(row.sources) ? row.sources.length : 0) },
  sources: { label: { zh: '来源数量', en: 'Source count' }, kind: 'derived', raw: (row) => (Array.isArray(row.sources) ? row.sources.length : 0) },
  enginesDsh: { label: { zh: '要求的 DSH 版本', en: 'Required DSH version' }, kind: 'number', pick: (row) => (Number.isFinite(row.enginesDsh) ? row.enginesDsh : null) },
}

/** 归一化方式白名单。 */
export const NORM_REGISTRY = {
  fixed: { label: { zh: '固定分值', en: 'Fixed' }, desc: { zh: '命中条件给 high，否则给 low', en: 'high when matched, else low' } },
  coverage: { label: { zh: '来源覆盖分档', en: 'Coverage steps' }, desc: { zh: '来源数 >= min 给 high，否则 low', en: 'sources >= min → high, else low' } },
  pick: { label: { zh: '精选分档', en: 'Pick steps' }, desc: { zh: '精选给 high，否则 low', en: 'featured → high, else low' } },
  freshness: { label: { zh: '时间新鲜度分档', en: 'Freshness steps' }, desc: { zh: '按 updatedAt 距今时长分档', en: 'buckets by updatedAt age' } },
  log: { label: { zh: '对数压缩', en: 'Log scale' }, desc: { zh: 'log1p(v)/log1p(全表最大)，抑制头部极值', en: 'log1p(v)/log1p(max)' } },
  quantile: { label: { zh: '分位排序', en: 'Quantile rank' }, desc: { zh: '按该指标在本次目录里的排名给分', en: 'rank within current catalog' } },
  linear: { label: { zh: '线性区间', en: 'Linear' }, desc: { zh: '(v-from)/(to-from)*100 后截断', en: '(v-from)/(to-from)*100 clamped' } },
  percent: { label: { zh: '百分比', en: 'Percentage' }, desc: { zh: 'v*100（v 已是 0..1 时）', en: 'v*100 when v is 0..1' } },
  power: { label: { zh: '幂函数', en: 'Power' }, desc: { zh: '(v/max)^exponent*100', en: '(v/max)^exponent*100' } },
  raw: { label: { zh: '原值截断', en: 'Raw clamped' }, desc: { zh: 'v 直接截断到 0..100', en: 'v clamped to 0..100' } },
}

export const AGGREGATIONS = ['weighted', 'mean']

/**
 * 规则库：所有可选口径（内置 + 预设 + 用户上传）都以条目形式存在，
 * 用户在界面里用下拉框选一个 active。
 *
 * 为什么不是「只有一个当前规则文件」：用户上传过三份口径之后，
 * 想临时切回内置看看差距、再切回来对比，单文件模型下要么丢掉刚上传的，
 * 要么每次都要重新上传一遍。规则库让「保存」和「启用」这两件事分开。
 *
 * 条目形状（内部）：
 *   { id, name, description, origin: 'builtin'|'preset'|'user', rules, savedAt, builtin }
 * origin 决定能否删除：内置与预置是随包发布的，只能启用不能删。
 */
export const RULES_LIBRARY_VERSION = 1
export const MAX_LIBRARY_ENTRIES = 50

export const BUILT_IN_RULES = {
  version: RULES_VERSION,
  name: '内置默认规则',
  description: '与 market-lens 0.5.0 的硬编码口径完全一致：有市场评分时按 评分/安装量/新鲜度/精选 加权，缺失时退到 安装量/新鲜度/来源覆盖。',
  updatedAt: null,
  labels: { excellent: 80, good: 60, fair: 40 },
  market: {
    aggregation: 'weighted',
    when: { metric: 'rating' },
    factors: [
      { key: 'rating', metric: 'rating', norm: 'raw', weight: 0.55 },
      { key: 'users', metric: 'users', norm: 'log', weight: 0.25 },
      { key: 'freshness', metric: 'freshness', norm: 'freshness', weight: 0.1 },
      { key: 'pick', metric: 'pick', norm: 'pick', weight: 0.1, params: { high: 100, low: 60 } },
    ],
    fallback: [
      { key: 'users', metric: 'users', norm: 'log', weight: 0.6 },
      { key: 'freshness', metric: 'freshness', norm: 'freshness', weight: 0.25 },
      { key: 'coverage', metric: 'coverage', norm: 'coverage', weight: 0.15, params: { min: 2, high: 100, low: 50 } },
    ],
  },
  community: {
    aggregation: 'weighted',
    when: { metric: 'stars' },
    factors: [
      { key: 'stars', metric: 'stars', norm: 'log', weight: 0.55 },
      { key: 'downloads', metric: 'downloads', norm: 'log', weight: 0.2 },
      { key: 'freshness', metric: 'freshness', norm: 'freshness', weight: 0.15 },
      { key: 'forks', metric: 'forks', norm: 'log', weight: 0.1 },
    ],
    fallback: [],
  },
  heat: {
    aggregation: 'weighted',
    factors: [
      { key: 'users', metric: 'users', norm: 'log', weight: 0.45 },
      { key: 'stars', metric: 'stars', norm: 'log', weight: 0.35 },
      { key: 'downloads', metric: 'downloads', norm: 'log', weight: 0.2 },
    ],
    fallback: [],
  },
}

export const BUILT_IN_PRESETS = [
  { id: 'default', name: { zh: '默认（平衡）', en: 'Default (balanced)' }, description: { zh: '与内置规则一致', en: 'Same as built-in' }, rules: BUILT_IN_RULES },
  {
    id: 'newcomer',
    name: { zh: '扶持新插件', en: 'Favour newcomers' },
    description: { zh: '降低安装量权重、提高新鲜度权重，让小体量但活跃的插件排得上来', en: 'Lower install weight, raise freshness' },
    rules: patchRules({
      name: '扶持新插件',
      market: {
        factors: [
          { key: 'rating', metric: 'rating', norm: 'raw', weight: 0.35 },
          { key: 'users', metric: 'users', norm: 'log', weight: 0.15 },
          { key: 'freshness', metric: 'freshness', norm: 'freshness', weight: 0.4 },
          { key: 'pick', metric: 'pick', norm: 'pick', weight: 0.1, params: { high: 100, low: 60 } },
        ],
        fallback: [
          { key: 'users', metric: 'users', norm: 'log', weight: 0.35 },
          { key: 'freshness', metric: 'freshness', norm: 'freshness', weight: 0.5 },
          { key: 'coverage', metric: 'coverage', norm: 'coverage', weight: 0.15, params: { min: 2, high: 100, low: 50 } },
        ],
      },
    }),
  },
  {
    id: 'popularity',
    name: { zh: '人气优先', en: 'Popularity first' },
    description: { zh: '按仓库热度排序，适合只想装最主流插件的场景', en: 'Rank by repository traction' },
    rules: patchRules({
      name: '人气优先',
      market: {
        factors: [
          { key: 'users', metric: 'users', norm: 'quantile', weight: 0.5 },
          { key: 'stars', metric: 'stars', norm: 'quantile', weight: 0.3 },
          { key: 'downloads', metric: 'downloads', norm: 'quantile', weight: 0.2 },
        ],
        fallback: [{ key: 'users', metric: 'users', norm: 'quantile', weight: 1 }],
        when: null,
      },
      community: {
        factors: [
          { key: 'stars', metric: 'stars', norm: 'quantile', weight: 0.6 },
          { key: 'forks', metric: 'forks', norm: 'quantile', weight: 0.25 },
          { key: 'downloads', metric: 'downloads', norm: 'quantile', weight: 0.15 },
        ],
      },
      heat: {
        factors: [
          { key: 'users', metric: 'users', norm: 'log', weight: 0.4 },
          { key: 'stars', metric: 'stars', norm: 'log', weight: 0.4 },
          { key: 'downloads', metric: 'downloads', norm: 'log', weight: 0.2 },
        ],
      },
      labels: { excellent: 85, good: 65, fair: 45 },
    }),
  },
]

function patchRules(overrides) {
  return {
    ...BUILT_IN_RULES,
    ...overrides,
    market: { ...BUILT_IN_RULES.market, ...(overrides.market || {}) },
    community: { ...BUILT_IN_RULES.community, ...(overrides.community || {}) },
    heat: { ...BUILT_IN_RULES.heat, ...(overrides.heat || {}) },
    labels: { ...BUILT_IN_RULES.labels, ...(overrides.labels || {}) },
  }
}

/* ------------------------------------------------------------------ 校验与收敛 */

/**
 * 把任意输入收敛成可计算的安全规则。
 * 不合法时抛 MarketRulesError（issues 里带字段路径），绝不返回半成品。
 *
 * @param {unknown} input
 * @param {{strict?: boolean}} [options] strict=true 时未知字段视为错误
 */
export function normalizeRules(input, { strict = false } = {}) {
  const issues = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MarketRulesError('规则文件必须是一个 JSON 对象', ['根节点应为对象，当前为 ' + describeType(input)])
  }

  const source = unwrapRulesDocument(input)
  const known = new Set(['version', 'name', 'description', 'updatedAt', 'labels', 'market', 'community', 'heat'])
  if (strict) {
    for (const key of Object.keys(source)) {
      if (!known.has(key)) issues.push('未知字段 ' + key + '（strict 模式下不接受）')
    }
  }

  const name = normalizeText(source.name, MAX_NAME) || BUILT_IN_RULES.name
  const description = normalizeText(source.description, MAX_DESCRIPTION) || ''
  const labels = normalizeLabels(source.labels, issues)

  const market = normalizeGroup('market', source.market, issues, { required: true })
  const community = normalizeGroup('community', source.community, issues, { required: false })
  const heat = normalizeGroup('heat', source.heat, issues, { required: false })

  if (issues.length) throw new MarketRulesError('规则文件不合法：' + issues[0], issues)

  return {
    version: RULES_VERSION,
    name,
    description,
    updatedAt: normalizeText(source.updatedAt, 40) || null,
    labels,
    market,
    community,
    heat,
  }
}

export function validateRules(input) {
  try {
    const rules = normalizeRules(input)
    return { ok: true, rules, issues: [] }
  } catch (error) {
    if (error instanceof MarketRulesError) return { ok: false, rules: null, issues: error.issues.length ? error.issues : [error.message] }
    return { ok: false, rules: null, issues: [error instanceof Error ? error.message : String(error)] }
  }
}

/**
 * 导出文件可能被包成 {format, version, rules}，也可能只是 {rules:{…}}，
 * 甚至直接就是规则体。
 *
 * 之所以不能只认 format 字段：用户手写/手改的规则文件里，`format` 是最常被
 * 漏掉的那一行；而 `{rules:{…}}` 的形态是肉眼看着最自然的一种。只认 format
 * 会让「自己按模版裁出来的文件」被判成「缺少 market 规则组」——错误信息还
 * 完全指不到真正的原因（那层包装没拆）。
 */
function unwrapRulesDocument(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const candidate = input.rules
    // 包装类文档的特征：有一个对象形的 rules，且外层自己不带 groups。
    // 用「外层是不是缺 market」来判断，比查 format 宽容得多，也不会误拆
    // 一份恰好有个叫 rules 的顶层键的真规则（那种规则本来就非法）。
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && !('market' in input)) {
      return candidate
    }
  }
  return input
}

function normalizeText(value, limit) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

function normalizeLabels(value, issues) {
  const out = { ...BUILT_IN_RULES.labels }
  if (value === undefined || value === null) return out
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push('labels 应为对象 { excellent, good, fair }')
    return out
  }
  for (const key of Object.keys(out)) {
    if (value[key] === undefined) continue
    const num = Number(value[key])
    if (!Number.isFinite(num)) {
      issues.push('labels.' + key + ' 应为数字')
      continue
    }
    out[key] = clampScore(num)
  }
  // 阈值必须严格递减，否则标签判断会出现永远命中不到的分支
  if (!(out.excellent > out.good && out.good > out.fair)) {
    issues.push('labels 阈值需满足 excellent > good > fair，当前为 ' + out.excellent + '/' + out.good + '/' + out.fair)
  }
  return out
}

function normalizeGroup(groupName, value, issues, { required }) {
  if (value === undefined || value === null) {
    if (required) issues.push('缺少 ' + groupName + ' 规则组')
    return required ? { aggregation: 'weighted', when: null, factors: [], fallback: [] } : { aggregation: 'weighted', when: null, factors: [], fallback: [] }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push(groupName + ' 应为对象')
    return { aggregation: 'weighted', when: null, factors: [], fallback: [] }
  }

  const aggregation = value.aggregation === undefined ? 'weighted' : value.aggregation
  if (!AGGREGATIONS.includes(aggregation)) {
    issues.push(groupName + '.aggregation 只能是 ' + AGGREGATIONS.join(' / '))
  }

  const factors = normalizeFactors(groupName + '.factors', value.factors, issues, { allowEmpty: !required })
  const fallback = normalizeFactors(groupName + '.fallback', value.fallback, issues, { allowEmpty: true })
  const when = normalizeWhen(groupName + '.when', value.when, issues)

  return { aggregation: AGGREGATIONS.includes(aggregation) ? aggregation : 'weighted', when, factors, fallback }
}

function normalizeWhen(path, value, issues) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    issues.push(path + ' 应为 { metric } 或 null')
    return null
  }
  const metric = value.metric
  if (typeof metric !== 'string' || !METRIC_REGISTRY[metric]) {
    issues.push(path + '.metric 必须是内置指标之一：' + Object.keys(METRIC_REGISTRY).join(' / '))
    return null
  }
  return { metric }
}

function normalizeFactors(path, value, issues, { allowEmpty }) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    issues.push(path + ' 应为数组')
    return []
  }
  if (value.length > MAX_FACTORS) {
    issues.push(path + ' 最多 ' + MAX_FACTORS + ' 个因子，当前 ' + value.length)
    return []
  }
  const out = []
  const seen = new Set()
  value.forEach((item, index) => {
    const at = path + '[' + index + ']'
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(at + ' 应为对象')
      return
    }
    const metric = item.metric
    if (typeof metric !== 'string' || !METRIC_REGISTRY[metric]) {
      issues.push(at + '.metric 必须是内置指标之一：' + Object.keys(METRIC_REGISTRY).join(' / '))
      return
    }
    const norm = item.norm === undefined ? 'raw' : item.norm
    if (typeof norm !== 'string' || !NORM_REGISTRY[norm]) {
      issues.push(at + '.norm 必须是内置归一化之一：' + Object.keys(NORM_REGISTRY).join(' / '))
      return
    }
    const weight = item.weight === undefined ? 1 : Number(item.weight)
    if (!Number.isFinite(weight) || weight < 0 || weight > 1000) {
      issues.push(at + '.weight 应为 0..1000 的数字')
      return
    }
    let params = null
    if (item.params !== undefined && item.params !== null) {
      if (typeof item.params !== 'object' || Array.isArray(item.params)) {
        issues.push(at + '.params 应为对象')
        return
      }
      params = normalizeParams(at, norm, item.params, issues)
    }
    const key = typeof item.key === 'string' && item.key.trim() ? item.key.trim().slice(0, 40) : metric + ':' + out.length
    if (seen.has(key)) {
      issues.push(at + '.key 重复：' + key)
      return
    }
    seen.add(key)
    out.push({ key, metric, norm, weight, params })
  })

  // 权重全为 0 等于这一组永远算 0 分，直接判为配置错误（除非这组本来就是空的）
  if (out.length && !out.some((factor) => factor.weight > 0)) {
    issues.push(path + ' 的权重全为 0，这一组将永远得 0 分')
  }
  if (!out.length && !allowEmpty) {
    issues.push(path + ' 不能为空')
  }
  return out
}

function normalizeParams(at, norm, params, issues) {
  const out = {}
  const takeNum = (key, { fallback, min, max }) => {
    if (params[key] === undefined) {
      out[key] = fallback
      return
    }
    const num = Number(params[key])
    if (!Number.isFinite(num)) {
      issues.push(at + '.params.' + key + ' 应为数字')
      out[key] = fallback
      return
    }
    out[key] = Math.min(max, Math.max(min, num))
  }

  if (norm === 'fixed' || norm === 'coverage' || norm === 'pick') {
    takeNum('high', { fallback: 100, min: 0, max: 100 })
    takeNum('low', { fallback: 0, min: 0, max: 100 })
    if (norm === 'coverage') takeNum('min', { fallback: 2, min: 0, max: 100 })
    if (norm === 'pick') {
      out.match = params.match !== undefined && params.match !== null ? Boolean(params.match) : true
    }
    return out
  }
  if (norm === 'linear') {
    takeNum('from', { fallback: 0, min: -1e12, max: 1e12 })
    takeNum('to', { fallback: 100, min: -1e12, max: 1e12 })
    if (out.to === out.from) {
      issues.push(at + '.params.to 不能等于 from')
      out.to = out.from + 1
    }
    return out
  }
  if (norm === 'power') {
    takeNum('exponent', { fallback: 1, min: 0.05, max: 10 })
    return out
  }
  if (norm === 'log' || norm === 'quantile') {
    if (params.maxKey !== undefined && params.maxKey !== null) {
      if (typeof params.maxKey !== 'string' || !METRIC_REGISTRY[params.maxKey]) {
        issues.push(at + '.params.maxKey 必须是内置指标之一')
      } else {
        out.maxKey = params.maxKey
      }
    }
    return out
  }
  if (norm === 'percent') {
    takeNum('scale', { fallback: 1, min: 1e-9, max: 1e12 })
    return out
  }
  if (norm === 'raw' || norm === 'freshness') {
    // 无参数
    for (const key of Object.keys(params)) issues.push(at + '.params.' + key + ' 对归一化 ' + norm + ' 无效')
    return {}
  }
  return out
}

/* ------------------------------------------------------------------ 计算 */

/**
 * 预扫描：为 log / quantile 归一化准备基准（全表最大值与排序后的取值序列）。
 * 必须在逐行计算前跑一次，否则每行都要重扫全表。
 */
export function prepareMetrics(rows, rules) {
  const active = activeMetrics(rules)
  const context = { max: {}, sorted: {} }
  for (const metric of active) {
    const raw = METRIC_REGISTRY[metric].raw || ((row) => {
      const picked = METRIC_REGISTRY[metric].pick(row)
      return typeof picked === 'number' ? picked : null
    })
    const values = []
    let max = 0
    for (const row of rows) {
      const value = raw(row)
      if (!Number.isFinite(value)) continue
      values.push(value)
      if (value > max) max = value
    }
    context.max[metric] = max
    values.sort((left, right) => left - right)
    context.sorted[metric] = values
  }
  return context
}

function activeMetrics(rules) {
  const set = new Set()
  for (const groupName of ['market', 'community', 'heat']) {
    const group = rules[groupName]
    if (!group) continue
    for (const factor of [...(group.factors || []), ...(group.fallback || [])]) {
      set.add(factor.params?.maxKey || factor.metric)
    }
  }
  return set
}

/**
 * 计算一个规则组的分数。
 *
 * @returns {{score: number, parts: Array<{key,metric,weight,value,raw}>}}
 */
export function scoreGroup(group, row, context, now) {
  const empty = { score: 0, parts: [] }
  if (!group || !Array.isArray(group.factors) || !group.factors.length) return empty

  const gateMetric = group.when?.metric
  const chosen = gateMetric ? (gateOpenFor(row, gateMetric) ? group.factors : group.fallback) : group.factors
  if (!Array.isArray(chosen) || !chosen.length) return empty

  const parts = []
  let weightedSum = 0
  let totalWeight = 0
  for (const factor of chosen) {
    const metric = METRIC_REGISTRY[factor.metric]
    if (!metric) continue
    const rawValue = metric.pick(row)
    if (rawValue === null || rawValue === undefined) continue
    const value = applyNorm(factor, rawValue, row, context, now)
    if (!Number.isFinite(value)) continue
    parts.push({ key: factor.key, metric: factor.metric, weight: factor.weight, value: clampScore(value), raw: typeof rawValue === 'number' ? rawValue : null })
    weightedSum += factor.weight * clampScore(value)
    totalWeight += factor.weight
  }
  if (!parts.length) return { score: 0, parts: [] }

  // weighted = Σ(w·v)/Σw（缺项按剩余权重重新分配）；mean = 简单算术平均，权重只用来标记观察项
  const score = group.aggregation === 'mean'
    ? parts.reduce((sum, part) => sum + part.value, 0) / parts.length
    : weightedSum / (totalWeight || 1)
  return { score: clampScore(score), parts }
}

/** 开关判定：指定的 metric 取到非空值即开门。未设置 when 的组永远走 factors。 */
function gateOpenFor(row, gateMetric) {
  const metric = METRIC_REGISTRY[gateMetric]
  if (!metric) return false
  const value = metric.pick(row)
  return value !== null && value !== undefined
}

function applyNorm(factor, rawValue, row, context, now) {
  const params = factor.params || {}
  switch (factor.norm) {
    case 'fixed':
      return matchesFixed(factor, rawValue) ? params.high ?? 100 : params.low ?? 0
    case 'coverage': {
      const count = Array.isArray(row.sources) ? row.sources.length : 0
      return count >= (params.min ?? 2) ? params.high ?? 100 : params.low ?? 50
    }
    case 'pick': {
      const wanted = params.match === undefined ? true : params.match
      const isPick = Boolean(rawValue)
      if (wanted) return isPick ? params.high ?? 100 : params.low ?? 0
      return isPick ? params.low ?? 0 : params.high ?? 100
    }
    case 'freshness':
      return freshnessScore(typeof rawValue === 'string' ? rawValue : null, now)
    case 'log': {
      const max = context?.max?.[params.maxKey || factor.metric] ?? 0
      return logScore(Number(rawValue), max)
    }
    case 'quantile': {
      const sorted = context?.sorted?.[params.maxKey || factor.metric] || []
      return quantileScore(sorted, Number(rawValue))
    }
    case 'linear': {
      const from = params.from ?? 0
      const to = params.to ?? 100
      const ratio = (Number(rawValue) - from) / (to - from)
      return clampScore(ratio * 100)
    }
    case 'percent': {
      // scale = 视为「满分的原始值」：percent 默认按 0..1，rating 这类 0..100 的数要显式给 scale:100
      const scale = params.scale ?? 1
      const num = Number(rawValue)
      if (!(scale > 0)) return 0
      return clampScore((num / scale) * 100)
    }
    case 'power': {
      const max = context?.max?.[factor.metric] ?? 0
      if (!(max > 0)) return 0
      const ratio = Math.max(0, Number(rawValue)) / max
      return clampScore(Math.pow(ratio, params.exponent ?? 1) * 100)
    }
    case 'raw':
    default:
      return clampScore(Number(rawValue))
  }
}

function matchesFixed(factor, rawValue) {
  if (typeof rawValue === 'boolean') return rawValue
  if (typeof rawValue === 'number') return rawValue > 0
  if (typeof rawValue === 'string') return rawValue.length > 0
  return Boolean(rawValue)
}

/** 分位给分：排序后相同值共享同一档，避免同分被拆开。 */
function quantileScore(sorted, value) {
  const n = sorted.length
  if (n <= 0) return 0
  if (n === 1) return value >= sorted[0] ? 100 : 0
  let low = 0
  let high = n - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] < value) low = mid + 1
    else high = mid
  }
  const rank = low
  return clampScore((rank / (n - 1)) * 100)
}

export function scoreLabelFromRules(score, labels = BUILT_IN_RULES.labels) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'weak'
  if (score >= labels.excellent) return 'excellent'
  if (score >= labels.good) return 'good'
  if (score >= labels.fair) return 'fair'
  return 'weak'
}

/* ------------------------------------------------------------------ 导出 / 模版 */

export function rulesDocument(rules, { includePresets = false } = {}) {
  const document = {
    format: RULES_EXPORT_FORMAT,
    version: RULES_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    rules: {
      version: rules.version,
      name: rules.name,
      description: rules.description ?? '',
      updatedAt: rules.updatedAt ?? null,
      labels: { ...rules.labels },
      market: serializeGroup(rules.market),
      community: serializeGroup(rules.community),
      heat: serializeGroup(rules.heat),
    },
  }
  if (includePresets) {
    document.presets = BUILT_IN_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      rules: { labels: { ...preset.rules.labels }, market: serializeGroup(preset.rules.market), community: serializeGroup(preset.rules.community), heat: serializeGroup(preset.rules.heat) },
    }))
  }
  return document
}

function serializeGroup(group) {
  if (!group) return { aggregation: 'weighted', when: null, factors: [], fallback: [] }
  return {
    aggregation: group.aggregation,
    when: group.when ? { metric: group.when.metric } : null,
    factors: (group.factors || []).map((factor) => ({ key: factor.key, metric: factor.metric, norm: factor.norm, weight: factor.weight, ...(factor.params ? { params: { ...factor.params } } : {}) })),
    fallback: (group.fallback || []).map((factor) => ({ key: factor.key, metric: factor.metric, norm: factor.norm, weight: factor.weight, ...(factor.params ? { params: { ...factor.params } } : {}) })),
  }
}

/**
 * 模版：直接可上传的规则文件 + 字段说明。
 * 说明写在模版旁边而不是塞进 rules 里，避免用户可以上传的字段和「只读的解释」混在一起。
 */
export function rulesTemplate() {
  return {
    format: RULES_EXPORT_FORMAT,
    version: RULES_EXPORT_VERSION,
    generatedAt: new Date().toISOString(),
    readme: [
      'market-lens 评分规则模版。',
      '用法：把本文件的 rules 段改成你的口径，然后在「设置 → 评分规则 → 上传规则」里选它（或直接编辑本文件后上传）。',
      'rules.market / rules.community / rules.heat 是三组分数：market 是主排序分，community 是社区活跃分（无 stars 的行不显示），heat 是热度（排序默认键）。',
      '每组 = 一个 factors 数组（可选 when 开关 + fallback 备用组）。每个因子：',
      '  key    : 本条因子的名字，出现在「评分构成」提示里；可省略。',
      '  metric : 取哪个字段。可用：' + Object.keys(METRIC_REGISTRY).join(' / ') + '。',
      '  norm   : 怎么把原始值映射到 0..100。可用：' + Object.keys(NORM_REGISTRY).join(' / ') + '。',
      '  weight : 权重，任意正数（55 与 0.55 等价，内部会归一化）；写 0 表示只看不参与。',
      '  params : 归一化参数。linear 用 {from,to}；power 用 {exponent}；fixed/coverage/pick 用 {high,low}（coverage 另加 min）；log/quantile 可用 {maxKey} 指定用别的指标做基准。',
      'when   : 主组只在指定 metric 非空时才用，否则走 fallback。例如 market.when = {metric:"rating"} 表示「有市场评分才用评分口径」。',
      'labels : 分数分档阈值，必须 excellent > good > fair。',
      '',
      '归一化速查：',
      ...Object.entries(NORM_REGISTRY).map(([key, item]) => '  ' + key.padEnd(10) + ' ' + item.desc.zh),
    ].join('\n'),
    metrics: Object.entries(METRIC_REGISTRY).map(([key, item]) => ({ key, label: item.label.zh, kind: item.kind })),
    norms: Object.entries(NORM_REGISTRY).map(([key, item]) => ({ key, label: item.label.zh, description: item.desc.zh })),
    presets: BUILT_IN_PRESETS.map((preset) => ({ id: preset.id, name: preset.name.zh, description: preset.description.zh, rules: normalizeRules(preset.rules) })),
    rules: normalizeRules(BUILT_IN_RULES),
  }
}

export function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/* ------------------------------------------------------------------ 规则库 */

/**
 * 库条目的稳定 id。用户上传两份同名规则时靠它区分：
 * 名字可以重复（人看得懂的标签），id 必须唯一（下拉框的 value）。
 */
export function newRuleEntryId(seed = '') {
  const base = String(seed || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  const random = Math.random().toString(36).slice(2, 8)
  return (base ? base + '-' : 'rule-') + random
}

/** 内置与预设条目：随包发布，不可删除。 */
export function builtInEntries() {
  const entries = []
  entries.push({
    id: 'builtin:default',
    name: BUILT_IN_RULES.name,
    description: BUILT_IN_RULES.description || '',
    origin: 'builtin',
    builtin: true,
    savedAt: null,
    rules: normalizeRules(BUILT_IN_RULES),
  })
  for (const preset of BUILT_IN_PRESETS) {
    entries.push({
      id: 'preset:' + preset.id,
      name: pickLocalized(preset.name),
      description: pickLocalized(preset.description),
      origin: 'preset',
      builtin: true,
      savedAt: null,
      rules: normalizeRules(preset.rules),
    })
  }
  return entries
}

function pickLocalized(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.zh || value.en || Object.values(value).find((item) => typeof item === 'string') || ''
  return ''
}

/**
 * 收敛一个库条目。内置/预设的 rules 一定合法；用户条目必须过 normalizeRules。
 *
 * @returns {{ok: true, entry: object} | {ok: false, issues: string[]}}
 */
export function normalizeEntry(input, { origin = 'user', id = null, savedAt = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: ['规则条目应为对象'] }
  }
  const resolvedOrigin = ['builtin', 'preset', 'user'].includes(input.origin) ? input.origin : origin
  const result = validateRules(input.rules ?? input)
  if (!result.ok) return { ok: false, issues: result.issues }
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, MAX_NAME)
    : result.rules.name || '未命名规则'
  return {
    ok: true,
    entry: {
      id: typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 80) : (id || newRuleEntryId(name)),
      name,
      description: typeof input.description === 'string' ? input.description.trim().slice(0, MAX_DESCRIPTION) : (result.rules.description || ''),
      origin: resolvedOrigin,
      builtin: resolvedOrigin !== 'user',
      savedAt: typeof input.savedAt === 'string' ? input.savedAt : savedAt,
      rules: result.rules,
    },
  }
}

/**
 * 把「磁盘上读到的库文件」+「内置条目」合并成一个完整库。
 *
 * 合并规则：
 *   - 内置与预设条目永远存在，位置固定在最前面（用户熟悉的位置不会因为上传而移动）；
 *   - 用户条目按 savedAt 倒序接在后面；
 *   - 用户条目的 id 若撞了内置（builtin: / preset: 前缀），直接丢弃并记一笔——
 *     否则用户上传一份 id 叫 preset:newcomer 的文件就能顶掉内置预设。
 *   - 同名不拦：名字只是标签，用户在界面上看到两个「我的口径」也知道自己传了两次。
 */
export function mergeLibrary(stored, { now = null } = {}) {
  const issues = []
  const builtIns = builtInEntries()
  const builtInIds = new Set(builtIns.map((entry) => entry.id))
  const users = []

  const incoming = Array.isArray(stored?.entries) ? stored.entries : []
  for (const raw of incoming) {
    const normalized = normalizeEntry(raw, { origin: 'user' })
    if (!normalized.ok) {
      issues.push((typeof raw?.name === 'string' ? raw.name : '(未命名)') + '：' + normalized.issues[0])
      continue
    }
    const entry = normalized.entry
    if (builtInIds.has(entry.id)) {
      issues.push(entry.name + '：id 与内置条目冲突（' + entry.id + '），已忽略')
      continue
    }
    users.push({ ...entry, origin: 'user', builtin: false })
  }

  users.sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || '')))

  const activeId = resolveActiveId(stored?.activeId, [...builtIns, ...users], issues)
  return {
    version: RULES_LIBRARY_VERSION,
    activeId,
    entries: [...builtIns, ...users].slice(0, MAX_LIBRARY_ENTRIES),
    // 「当前选中的规则没了」比「某一条自定义规则坏了」更该先说：前者直接决定
    // 界面现在按什么口径算分，后者只是少一个候选项。所以把它排到最前面。
    issues: sortIssues(issues),
    migratedFrom: stored?.migratedFrom || null,
    now,
  }
}

/** 悬空的 activeId 优先级最高；其余按原顺序。 */
function sortIssues(issues) {
  const active = issues.filter((text) => text.includes('当前选中的规则'))
  const rest = issues.filter((text) => !text.includes('当前选中的规则'))
  return [...active, ...rest]
}

/** activeId 失效（被删了 / 手改坏了）时回落到内置默认，绝不让「没有当前规则」这种情况存在。 */
function resolveActiveId(value, entries, issues) {
  const wanted = typeof value === 'string' ? value.trim() : ''
  if (wanted && entries.some((entry) => entry.id === wanted)) return wanted
  if (wanted) issues.push('当前选中的规则（' + wanted + '）不存在，已回退到内置默认')
  return 'builtin:default'
}

export function findEntry(library, id) {
  if (!library || !Array.isArray(library.entries)) return null
  return library.entries.find((entry) => entry.id === id) || null
}

export function activeEntry(library) {
  if (!library) return null
  return findEntry(library, library.activeId) || findEntry(library, 'builtin:default') || null
}

export function serializeLibrary(library) {
  return {
    version: RULES_LIBRARY_VERSION,
    activeId: library.activeId,
    entries: (library.entries || []).filter((entry) => entry.origin === 'user').map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      savedAt: entry.savedAt,
      rules: entry.rules,
    })),
    migratedFrom: library.migratedFrom || null,
  }
}

/** 下拉框要用的轻量列表：不带 rules 全文，几十 KB 不能每次渲染都传。 */
export function libraryChoices(library) {
  return (library?.entries || []).map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description || '',
    origin: entry.origin,
    builtin: Boolean(entry.builtin),
    savedAt: entry.savedAt,
    factorCount: countFactors(entry.rules),
    labels: { ...entry.rules.labels },
    groups: {
      market: entry.rules.market.factors.length,
      community: entry.rules.community.factors.length,
      heat: entry.rules.heat.factors.length,
    },
  }))
}

export function countFactors(rules) {
  let count = 0
  for (const name of ['market', 'community', 'heat']) {
    count += (rules?.[name]?.factors?.length || 0) + (rules?.[name]?.fallback?.length || 0)
  }
  return count
}

/**
 * 给界面用的人话摘要：一个条目「实际上在算什么」。
 * 用户看到一列 factors 的 JSON 是没有意义的，这里把它翻成
 * 「安装量（对数）· 权重 25%」这种能读的短语。
 */
export function describeEntry(entry, lang = 'zh') {
  if (!entry) return null
  const factorsOf = (group) => (group?.factors || []).map((factor) => ({
    key: factor.key,
    metric: factor.metric,
    metricLabel: METRIC_REGISTRY[factor.metric]?.label?.[lang] || factor.metric,
    norm: factor.norm,
    normLabel: NORM_REGISTRY[factor.norm]?.label?.[lang] || factor.norm,
    weight: factor.weight,
    // 权重在组内归一化后占多少百分比，用户最关心这个
    share: null,
    params: factor.params || null,
  }))
  const groups = {}
  for (const name of ['market', 'community', 'heat']) {
    const group = entry.rules?.[name]
    const factors = factorsOf(group)
    const total = factors.reduce((sum, factor) => sum + factor.weight, 0)
    for (const factor of factors) factor.share = total > 0 ? Math.round((factor.weight / total) * 100) : 0
    groups[name] = {
      aggregation: group?.aggregation || 'weighted',
      when: group?.when?.metric || null,
      factors,
      fallback: (group?.fallback || []).map((factor) => ({
        key: factor.key,
        metric: factor.metric,
        metricLabel: METRIC_REGISTRY[factor.metric]?.label?.[lang] || factor.metric,
        norm: factor.norm,
        normLabel: NORM_REGISTRY[factor.norm]?.label?.[lang] || factor.norm,
        weight: factor.weight,
      })),
    }
  }
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description || '',
    origin: entry.origin,
    builtin: Boolean(entry.builtin),
    labels: { ...entry.rules.labels },
    groups,
  }
}

