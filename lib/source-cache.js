/**
 * source-cache.js —— 逐源的条件请求记录。
 *
 * 为什么需要它：目录缓存原来是 TTL 式覆盖 —— 每个同步周期整份重拉、整份重写
 * 46MB 的 catalog.json。源站哪怕一个字都没改，也要付这份流量与写盘代价。
 *
 * 改法：每个源记一份 `{ etag, lastModified, lastConfirmedAt }`：
 *   · 下次请求带上 If-None-Match / If-Modified-Since
 *   · 回 304 → **不重写快照**，只把 lastConfirmedAt 推进到 now
 *   · 回 200 → 正常落盘，同时更新 etag / lastModified / lastConfirmedAt
 *
 * 一条不能违反的约束（这是整个设计的核心）：
 *   **只有 304 才算「确认最新」。**
 *   网络失败、5xx、超时、JSON 坏了 —— 一律不能把 lastConfirmedAt 往前推，
 *   也不能静默沿用旧目录假装同步成功。过期目录对用户是错误答案，
 *   比报错更糟：他会以为"这个插件不存在"，而其实是"目录没拉到"。
 *
 * 所以本模块只做记录与判定，不做任何"回退"。回退由 UI 显式说明（stale 标记）。
 */

/** 单源状态字段允许的最大长度，避免把整段响应头塞进配置。 */
const MAX_MARKER = 400

export const STALE_REASONS = {
  never: 'never-synced',
  failed: 'last-sync-failed',
  old: 'last-confirmed-too-long-ago',
}

function nowIso(now) {
  return new Date(now).toISOString()
}

/**
 * 归一化一条记录。老配置里可能只有 lastSuccessAt，没有条件标记 —— 逐个补默认值，
 * 避免 undefined 冒到前端。
 *
 * @param {unknown} stored
 * @returns {{etag: string|null, lastModified: string|null, lastConfirmedAt: string|null, lastFailureAt: string|null, failureCount: number}}
 */
export function normalizeSourceCache(stored) {
  const source = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  const marker = (value) => (typeof value === 'string' && value && value.length <= MAX_MARKER ? value : null)
  return {
    etag: marker(source.etag),
    lastModified: marker(source.lastModified),
    lastConfirmedAt: typeof source.lastConfirmedAt === 'string' ? source.lastConfirmedAt : null,
    lastFailureAt: typeof source.lastFailureAt === 'string' ? source.lastFailureAt : null,
    failureCount: Number.isInteger(source.failureCount) && source.failureCount > 0 ? source.failureCount : 0,
  }
}

/** 把一条记录变成 fetchJson 的 `conditional` 参数；没有标记就返回 null（发普通请求）。 */
export function conditionalOf(record) {
  const normalized = normalizeSourceCache(record)
  if (!normalized.etag && !normalized.lastModified) return null
  return { etag: normalized.etag, lastModified: normalized.lastModified }
}

/**
 * 304：内容没变。**只有这一条会推进 lastConfirmedAt。**
 * @returns 新的记录
 */
export function confirmNotModified(record, response, now = Date.now()) {
  const normalized = normalizeSourceCache(record)
  return {
    ...normalized,
    // 304 可能刷新这两个值：服务端换了 ETag 说明它的表示形态变了，
    // 沿用旧的会让下次条件请求白问一遍。
    etag: (response && typeof response.etag === 'string' && response.etag) || normalized.etag,
    lastModified: (response && typeof response.lastModified === 'string' && response.lastModified) || normalized.lastModified,
    lastConfirmedAt: nowIso(now),
  }
}

/**
 * 200：内容真的变了。更新标记，并把 lastConfirmedAt 推到 now。
 * @returns 新的记录
 */
export function confirmFetched(record, response, now = Date.now()) {
  const normalized = normalizeSourceCache(record)
  return {
    etag: (response && typeof response.etag === 'string' && response.etag) || null,
    lastModified: (response && typeof response.lastModified === 'string' && response.lastModified) || null,
    lastConfirmedAt: nowIso(now),
    lastFailureAt: null,
    failureCount: 0,
  }
}

/**
 * 失败：**绝不推进 lastConfirmedAt**，只记失败。
 * @returns 新的记录
 */
export function recordFailure(record, now = Date.now()) {
  const normalized = normalizeSourceCache(record)
  return {
    ...normalized,
    lastFailureAt: nowIso(now),
    failureCount: normalized.failureCount + 1,
  }
}

/**
 * 这个源的数据到底有多旧？
 *
 * 三种 stale 原因要分开说，因为它们对用户的含义完全不同：
 *   never  —— 从没成功过（可能是源地址写错了）
 *   failed —— 上次同步失败了（等会儿重试）
 *   old    —— 太久没确认（可能只是没触发同步）
 *
 * @param {unknown} record
 * @param {{now?: number, maxAgeMs?: number}} [options]
 * @returns {{stale: boolean, reason: string|null, ageMs: number|null, lastConfirmedAt: string|null}}
 */
export function stalenessOf(record, options = {}) {
  const normalized = normalizeSourceCache(record)
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : 24 * 60 * 60 * 1000

  if (!normalized.lastConfirmedAt) {
    return {
      stale: true,
      reason: STALE_REASONS.never,
      ageMs: null,
      lastConfirmedAt: null,
    }
  }
  const confirmed = Date.parse(normalized.lastConfirmedAt)
  if (!Number.isFinite(confirmed)) {
    // 坏时间戳按「从没确认过」处理：宁可说旧，也不要说新。
    return { stale: true, reason: STALE_REASONS.never, ageMs: null, lastConfirmedAt: normalized.lastConfirmedAt }
  }
  const ageMs = Math.max(0, now - confirmed)
  // 失败比「旧」更值得说：用户看到 failed 知道该重试，看到 old 只会以为要等。
  if (normalized.failureCount > 0 && normalized.lastFailureAt) {
    const failedAt = Date.parse(normalized.lastFailureAt)
    if (Number.isFinite(failedAt) && failedAt > confirmed) {
      return { stale: true, reason: STALE_REASONS.failed, ageMs, lastConfirmedAt: normalized.lastConfirmedAt }
    }
  }
  if (ageMs > maxAgeMs) {
    return { stale: true, reason: STALE_REASONS.old, ageMs, lastConfirmedAt: normalized.lastConfirmedAt }
  }
  return { stale: false, reason: null, ageMs, lastConfirmedAt: normalized.lastConfirmedAt }
}

/**
 * 整份目录聚合出来的 stale 结论，用于 status 上屏。
 *
 * @param {Record<string, unknown>} sources 源 id → 记录
 * @param {{now?: number, maxAgeMs?: number, enabled?: Iterable<string>}} [options]
 * @returns {{stale: boolean, earliestConfirmedAt: string|null, degraded: Array<{id: string, reason: string, ageMs: number|null}>}}
 */
export function catalogStaleness(sources, options = {}) {
  const entries = sources !== null && typeof sources === 'object' ? Object.entries(sources) : []
  const enabled = options.enabled ? new Set(options.enabled) : null
  const degraded = []
  let earliest = null

  for (const [id, record] of entries) {
    // 只看启用中的源：被用户关掉的源永远"旧"，报它没有意义。
    if (enabled && !enabled.has(id)) continue
    const verdict = stalenessOf(record, options)
    if (verdict.stale) degraded.push({ id, reason: verdict.reason, ageMs: verdict.ageMs })
    if (verdict.lastConfirmedAt) {
      const stamp = Date.parse(verdict.lastConfirmedAt)
      if (Number.isFinite(stamp) && (earliest === null || stamp < earliest)) earliest = stamp
    }
  }

  return {
    stale: degraded.length > 0,
    earliestConfirmedAt: earliest === null ? null : nowIso(earliest),
    degraded,
  }
}
