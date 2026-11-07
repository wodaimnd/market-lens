/** Shared helpers for the market-lens Host half. No Electron APIs, no shell. */

export const SOURCE_1024 = '1024store'
export const SOURCE_DSHFIND = 'dshfind'
export const SOURCE_NPM = 'npm'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MAX_JSON_BYTES = 24 * 1024 * 1024

/**
 * Fetch JSON with a bounded timeout, retries and an optional external abort signal.
 * Never follows a redirect outside the URL's original origin, so a provider cannot
 * turn a catalog request into a request to another host.
 *
 * 条件请求（ETag / Last-Modified）：
 *   · 传 `conditional: { etag, lastModified }` 时带上 If-None-Match / If-Modified-Since
 *   · 服务端回 304 → 返回 `{ notModified: true, etag, lastModified }`，**不解析 body**
 *   · 不要指望 304 是常态：源站多半不支持，所以"没拿到 304"绝不能当成失败
 *
 * 一条硬约束：**只有 304 才能复用旧目录**。网络失败 / 5xx / 超时一律抛错，
 * 由调用方标 `stale: true` 上屏 —— 过期目录对用户是错误答案，
 * 静默回退比报错更糟。
 */
export async function fetchJson(url, options = {}) {
  const { signal, timeoutMs = 45_000, retries = 2, headers = {}, conditional = null } = options
  const origin = new URL(url).origin
  let lastError

  // 条件请求头：只在调用方真的给了缓存标记时才加。
  // 注意 If-None-Match 优先于 If-Modified-Since（两者同时给时服务端通常只看 ETag）。
  const conditionalHeaders = {}
  if (conditional && typeof conditional.etag === 'string' && conditional.etag) {
    conditionalHeaders['if-none-match'] = conditional.etag
  }
  if (conditional && typeof conditional.lastModified === 'string' && conditional.lastModified) {
    conditionalHeaders['if-modified-since'] = conditional.lastModified
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs)
    const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const response = await fetch(url, {
        signal: composite,
        redirect: 'follow',
        headers: {
          accept: 'application/json',
          'user-agent': 'dsh-market-lens/0.1 (+https://github.com/anywhere-labs/dsh-desktop)',
          ...conditionalHeaders,
          ...headers,
        },
      })
      if (response.url !== '' && new URL(response.url).origin !== origin) {
        throw new Error('response redirected outside ' + origin)
      }
      // 304 必须在 ok 判定之前处理：response.ok 是 false（304 不在 2xx 内）。
      if (response.status === 304) {
        return {
          notModified: true,
          status: 304,
          finalUrl: response.url,
          // 304 可能刷新这两个值，取响应里的；没有就沿用请求里那份
          etag: response.headers.get('etag') || conditional?.etag || null,
          lastModified: response.headers.get('last-modified') || conditional?.lastModified || null,
        }
      }
      if (response.status === 429 || response.status >= 500) {
        throw new Error('HTTP ' + response.status)
      }
      if (!response.ok) {
        const error = new Error('HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      const text = await response.text()
      if (text.length > MAX_JSON_BYTES) throw new Error('response is larger than the JSON limit')
      let value
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error('response is not valid JSON')
      }
      return {
        value,
        status: response.status,
        finalUrl: response.url,
        bytes: text.length,
        etag: response.headers.get('etag') || null,
        lastModified: response.headers.get('last-modified') || null,
      }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason ?? error
      if (error && error.status === 404) throw error
      if (attempt < retries) await sleep(500 * (attempt + 1) + Math.random() * 350)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('request failed')
}

/** Run async work with bounded concurrency while preserving input order. */
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const GITHUB_AUTHOR = /^[a-z0-9][a-z0-9-]{0,99}$/iu
const GITHUB_REPO = /^[a-z0-9._-]{1,100}$/iu
const PROFILE = /^[A-Za-z0-9_-]+$/u

/** Strip a version suffix from an npm target, leaving the package name. */
export function npmNameOf(target) {
  if (typeof target !== 'string') return null
  const value = target.trim()
  if (!value) return null
  const separator = value.startsWith('@')
    ? value.indexOf('@', value.indexOf('/') + 1)
    : value.indexOf('@')
  const name = separator < 0 ? value : value.slice(0, separator)
  return NPM_NAME.test(name) ? name : null
}

/** Normalize a GitHub repository URL to https://github.com/owner/repo (no .git). */
export function normalizeRepo(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/iu, '')
    if (!GITHUB_AUTHOR.test(owner) || !GITHUB_REPO.test(repo)) return null
    return `https://github.com/${owner}/${repo}`
  } catch {
    return null
  }
}

/**
 * Parse exactly the reviewed install-command shape. The command is never executed;
 * it is only a source of package / repository identity for display.
 */
export function parseInstallTarget(command) {
  if (typeof command !== 'string' || command.length > 1024) return null
  const tokens = command.trim().split(/\s+/u)
  if (
    tokens.length !== 6 ||
    tokens[0] !== 'dsh' ||
    tokens[1] !== 'plugin' ||
    tokens[2] !== '--profile' ||
    !PROFILE.test(tokens[3]) ||
    tokens[4] !== 'add'
  ) {
    return null
  }
  const target = tokens[5]
  if (target.startsWith('github:')) {
    const body = target.slice('github:'.length)
    const hash = body.indexOf('#')
    const repoPart = hash < 0 ? body : body.slice(0, hash)
    const rest = hash < 0 ? '' : body.slice(hash + 1)
    const [owner, repoRaw] = repoPart.split('/')
    const repo = (repoRaw ?? '').replace(/\.git$/iu, '')
    if (!owner || !repo || !GITHUB_AUTHOR.test(owner) || !GITHUB_REPO.test(repo)) return null
    const pathMatch = /^path:(.+)$/u.exec(rest)
    return {
      raw: target,
      npm: null,
      repo: `https://github.com/${owner}/${repo}`,
      subpath: pathMatch ? pathMatch[1].replace(/^\/+|\/+$/g, '') : null,
    }
  }
  if (target.startsWith('https://github.com/')) {
    const repo = normalizeRepo(target)
    return repo ? { raw: target, npm: null, repo, subpath: null } : null
  }
  const npm = npmNameOf(target)
  return npm ? { raw: target, npm, repo: null, subpath: null } : null
}

/** Pick a display string from a plain string or a {zh,en} object. */
export function pickText(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') {
    for (const key of ['zh', 'zh-CN', 'en']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
    for (const candidate of Object.values(value)) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  return ''
}

export function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function maxIso(...values) {
  let best = null
  for (const value of values) {
    const iso = toIso(value)
    if (iso && (!best || iso > best)) best = iso
  }
  return best
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return null
  return Math.max(0, (now - time) / 86_400_000)
}

export function freshnessScore(iso, now = Date.now()) {
  const days = daysSince(iso, now)
  if (days == null) return 0
  if (days <= 7) return 100
  if (days <= 30) return 88
  if (days <= 90) return 70
  if (days <= 180) return 48
  if (days <= 365) return 28
  return 12
}

export function logScore(value, maximum) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(maximum) || maximum <= 0) return 0
  return Math.round((100 * Math.log1p(value)) / Math.log1p(maximum))
}

export function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function scoreLabel(score) {
  if (!Number.isFinite(score)) return null
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  if (score >= 40) return 'fair'
  return 'weak'
}

export function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

export function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}
