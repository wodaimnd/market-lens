/**
 * 已安装插件的「可更新」检测。
 *
 * 版本来源有两层，顺序固定：
 *   1. 官方 pluginManager（权威）：listBundles() 给出**已装版本**（含 availability、
 *      installTarget），inspect(pkg) 走 pnpm view、尊重当前 profile 的 .npmrc /
 *      proxy / 私有 registry，给出**可安装的最新版本**。这是唯一带 registry 语义
 *      的通道，所以它优先。
 *   2. npm registry（快速兜底）：compat.js 已经把 npm latest 缓存了 7 天，直接读；
 *      没有缓存时再打一次 /latest。官方管理器缺席（软注入没命中）时也能给出结论，
 *      界面上会标出来源是 npm 而不是官方。
 *
 * 之所以分两层：官方 inspect 是逐包一次 pnpm 调用（秒级），几十个已装插件串行
 * 会卡住界面；而 npm latest 是随同步一起拿的，零成本。所以表格先按 npm 结论标
 * 「可更新到 x.y.z」，官方精查在后台跑，跑完覆盖并标 source='pluginManager'。
 *
 * 版本比较不引第三方依赖：插件本身零依赖发布，为一次比较拖 semver 不值。
 */

import { fetchJson } from './util.js'

const OFFICIAL_CONCURRENCY = 3
const INSPECT_TIMEOUT_MS = 25_000
const CHAIN_TIMEOUT_MS = 15_000
const CHAIN_LIMIT = 30
/** 官方检查结果的新鲜期；过期后在下一轮 check 里重新验。 */
export const UPDATE_TTL_MS = 30 * 60 * 1000
/** 版本链（packument）也有新鲜期，抽屉反复开关不该反复打 registry。 */
export const CHAIN_TTL_MS = 30 * 60 * 1000

/**
 * 发布时间缓存的有效期。
 *
 * 一个版本发布之后它的发布时间就固定了，理论上可以永久缓存。
 * 取 6 小时是因为这里缓存的是「这个包有哪些版本在什么时候发」——
 * 新版本发布会让缓存变旧，但 6 小时内的延迟对"是否一周内"这个判据毫无影响。
 */
export const PUBLISHED_TTL_MS = 6 * 60 * 60 * 1000

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 只有「装在一个 registry 上的包」才值得问 pnpm/corepack「最新版本是多少」。
 *
 * 这条闸是 0.4.0 补的：0.3.x 的检查会把 @local/* 与 link: 装的插件也丢给
 * pluginManager.inspect，pnpm 对它们只会回 invalid-spec / already-installed，
 * 结果是每次刷新都在 .plugin-manager/logs 里留下一条失败记录 —— 官方插件页
 * 看到这些失败记录就会把那些 bundle 标成异常。本地插件本来也不可能「有新版本」。
 */
export function isRegistryCandidate(pkg, spec) {
  const name = typeof pkg === 'string' ? pkg.trim() : ''
  if (!name || name.startsWith('@local/')) return false
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (!text) return true
  return !/^(link|file|portal|workspace):/i.test(text)
    && !/^(git\+|git:|github:|https?:|\.{0,2}\/|[A-Za-z]:[\\/])/i.test(text)
    && !/\.(tgz|tar\.gz|zip)$/i.test(text)
}

/**
 * 解析 semver（够用即可：主/次/补丁 + 预发布标识，不接受 range）。
 * @returns {{major:number, minor:number, patch:number, prerelease:string[]}|null}
 */
export function parseVersion(value) {
  if (value == null) return null
  const text = String(value).trim().replace(/^v/i, '')
  const match = VERSION_PATTERN.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(left, right) {
  // 无预发布标识 = 正式版，比任何同号预发布都大。
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a == null) return -1
    if (b == null) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (aNumeric) return -1
    if (bNumeric) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** 比较两个解析后的版本：-1 = a<b，0 = 相等，1 = a>b。 */
export function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * 已装版本 → 可用版本的可更新性结论。
 * kind 说明差了几个层级：major / minor / patch / prerelease；
 * same = 已是最新，ahead = 本地比源上还新（link 或源回退），unknown = 版本号不可解析。
 */
export function compareVersions(installed, latest) {
  const from = installed == null ? '' : String(installed)
  const to = latest == null ? '' : String(latest)
  const a = parseVersion(from)
  const b = parseVersion(to)
  if (!a || !b) {
    return { available: false, kind: 'unknown', from: from || null, to: to || null, reason: !to ? 'no-latest' : 'invalid-version' }
  }
  const order = compareParsed(a, b)
  if (order === 0) return { available: false, kind: 'same', from, to, reason: 'up-to-date' }
  if (order > 0) return { available: false, kind: 'ahead', from, to, reason: 'installed-ahead' }
  const kind = a.major !== b.major ? 'major'
    : a.minor !== b.minor ? 'minor'
      : a.patch !== b.patch ? 'patch'
        : 'prerelease'
  return { available: true, kind, from, to, reason: 'update-available' }
}

function encodePackageName(pkg) {
  const name = String(pkg)
  // 作用域包在 registry 上的规范写法就是 @scope%2fname；两者都收，这里统一编码。
  return name.startsWith('@') ? name.replace('/', '%2f') : name
}

function withTimeout(promise, timeoutMs) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

async function mapLimit(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 从 npm packument 里切出 (from, to] 之间的版本链。纯函数，测试直接喂 packument。
 * @returns {{pkg:string, from:string|null, to:string|null, latest:string|null, distTags:Record<string,string>, total:number, versions:Array<{version:string, publishedAt:string|null, enginesDsh:string|null, prerelease:boolean, breaking:boolean}>}}
 */
export function buildVersionChain(pkg, packument, options = {}) {
  const source = packument && typeof packument === 'object' ? packument : {}
  const versions = source.versions && typeof source.versions === 'object' ? source.versions : {}
  const times = source.time && typeof source.time === 'object' ? source.time : {}
  const distTags = source['dist-tags'] && typeof source['dist-tags'] === 'object' ? source['dist-tags'] : {}
  const from = options.from ? parseVersion(options.from) : null
  const to = options.to ? parseVersion(options.to) : null
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : CHAIN_LIMIT

  const matches = []
  for (const [version, manifest] of Object.entries(versions)) {
    const parsed = parseVersion(version)
    if (!parsed) continue
    if (from && compareParsed(parsed, from) <= 0) continue
    if (to && compareParsed(parsed, to) > 0) continue
    const engines = manifest && typeof manifest === 'object' && manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : {}
    matches.push({
      parsed,
      version,
      publishedAt: typeof times[version] === 'string' ? times[version] : null,
      enginesDsh: typeof engines.dsh === 'string' ? engines.dsh : null,
      prerelease: parsed.prerelease.length > 0,
      breaking: Boolean(from && parsed.major > from.major),
    })
  }
  matches.sort((left, right) => compareParsed(left.parsed, right.parsed))

  return {
    pkg: String(pkg || ''),
    from: options.from || null,
    to: options.to || null,
    latest: typeof distTags.latest === 'string' ? distTags.latest : null,
    distTags,
    total: matches.length,
    versions: matches.slice(-limit).map(({ parsed, ...rest }) => rest),
  }
}

/** 拉一个包的完整 packument 并切出版本链（不带内存缓存，缓存由 UpdateService 管）。 */
export async function fetchVersionChain(pkg, options = {}) {
  const name = String(pkg || '').trim()
  if (!name) throw new Error('package name is required')
  const fetchJsonImpl = typeof options.fetchJson === 'function' ? options.fetchJson : fetchJson
  const response = await fetchJsonImpl('https://registry.npmjs.org/' + encodePackageName(name), {
    signal: options.signal,
    timeoutMs: options.timeoutMs || CHAIN_TIMEOUT_MS,
    retries: 1,
    headers: { accept: 'application/json' },
  })
  return buildVersionChain(name, response.value, options)
}

/**
 * 已装插件的更新检查服务。
 *
 * 与 compat 服务一样是「后台跑、按包缓存、界面轮询」的形态：check() 不等全网
 * 返回，而是逐包落进 entries，status() 给进度，snapshot() 给明细。
 */
export class UpdateService {
  constructor({ getManager = () => null, compat = null, logger = null, now = () => Date.now() } = {}) {
    this.getManager = getManager
    this.compat = compat
    this.logger = logger
    this.now = now
    /** @type {Map<string, object>} */
    this.entries = new Map()
    /** @type {Map<string, {at: number, value: object}>} */
    this.chains = new Map()
    // 发布时间缓存：package@version → { at, value }。
    // 与 chains 分开，因为 chains 带的是整条版本链（还含 engines 等），
    // 而这里只需要「这个版本什么时候发的」一条字符串。
    this.publishedCache = new Map()
    // queued：请求已经被接受、但 check() 还没真正开始（要先等 listBundles 列出已装包）。
    // 没有这个字段时，`updates.check` 立刻返回 `running:false`，前端不会启动进度轮询，
    // 用户点「检查更新」之后几十秒内界面没有任何变化 —— 看起来就是点了没反应。
    this.state = { running: false, queued: false, source: 'idle', startedAt: null, finishedAt: null, error: null, total: 0, done: 0 }
    this.controller = null
  }

  get(pkg) {
    if (typeof pkg !== 'string' || !pkg) return null
    return this.entries.get(pkg.toLowerCase()) || null
  }

  /**
   * 标记「已接受检查请求」。前端把它当成 running 来轮询，直到 check() 真正接管。
   * 重复调用不会覆盖正在跑的那一轮：running 时不改 total/done，免得进度跳回 0。
   */
  markQueued() {
    if (this.state.running) return this.status()
    this.state = {
      ...this.state,
      queued: true,
      source: 'checking',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      error: null,
      total: 0,
      done: 0,
    }
    return this.status()
  }

  status() {
    const entries = [...this.entries.values()]
    return {
      running: this.state.running,
      // queued 与 running 是两个阶段：已接受请求但还没开始逐包检查。
      // 界面用 `running || queued` 判断「检查中」，Host 自己只认 running。
      queued: Boolean(this.state.queued),
      source: this.state.source,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
      error: this.state.error,
      total: this.state.total,
      done: this.state.done,
      checked: entries.length,
      available: entries.filter((entry) => entry.available).length,
    }
  }

  snapshot() {
    return [...this.entries.values()].sort((left, right) => String(left.pkg).localeCompare(String(right.pkg)))
  }

  /** 结果是否过期（用于决定下一轮 check 要不要重验）。 */
  stale(entry) {
    if (!entry || !entry.checkedAt) return true
    const at = Date.parse(entry.checkedAt)
    if (!Number.isFinite(at)) return true
    return this.now() - at > UPDATE_TTL_MS
  }

  /** 直接把外部算好的结论塞进来（例如从缓存文件恢复）。 */
  set(entry) {
    if (!entry || typeof entry.pkg !== 'string' || !entry.pkg) return null
    const normalized = { ...entry, pkg: entry.pkg }
    this.entries.set(entry.pkg.toLowerCase(), normalized)
    return normalized
  }

  /**
   * 逐包解析最新版本。
   * @param {Array<{pkg:string, installed?:string|null}>} items
   * @param {{force?: boolean}} [options]
   */
  async check(items, options = {}) {
    // queued 是上一段（`updates.check` 立刻返回时打的）标记，进入真正检查要清掉，
    // 否则状态永远看起来「有检查在跑」，前端会一直轮询。
    this.state.queued = false
    if (this.state.running) return this.status()
    const list = (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item.pkg === 'string' && item.pkg)
      .map((item) => ({
        pkg: item.pkg,
        installed: item.installed ? String(item.installed) : null,
        spec: typeof item.spec === 'string' ? item.spec : null,
      }))
    const pending = options.force ? list : list.filter((item) => this.stale(this.get(item.pkg)))

    if (pending.length === 0) {
      // 没有要检查的包：把口径落回真实来源，而不是留在 'checking'。
      // （旧代码读 this.state.checked，但 state 上从来没有这个字段，于是永远回不到 idle。）
      this.state = { ...this.state, running: false, queued: false, source: this.sourceSummary(), total: 0, done: 0 }
      return this.status()
    }

    const startedAt = new Date(this.now()).toISOString()
    this.state = { running: true, queued: false, source: 'checking', startedAt, finishedAt: null, error: null, total: pending.length, done: 0 }
    const controller = new AbortController()
    this.controller = controller

    try {
      await mapLimit(pending, OFFICIAL_CONCURRENCY, async (item) => {
        if (controller.signal.aborted) return null
        const entry = await this.resolve(item, controller.signal)
        this.entries.set(item.pkg.toLowerCase(), entry)
        this.state.done += 1
        if (entry.error) this.logger?.warn?.('market-lens: update check failed for ' + item.pkg + ': ' + entry.error)
        return entry
      })
      this.state.source = this.sourceSummary()
      return this.status()
    } catch (error) {
      this.state.error = error?.message || String(error)
      return this.status()
    } finally {
      this.state.running = false
      this.state.queued = false
      this.state.finishedAt = new Date(this.now()).toISOString()
      this.controller = null
      if (this.state.source === 'checking') this.state.source = this.sourceSummary()
    }
  }

  cancel() {
    // 排队阶段也要能取消：否则点了检查更新之后要等 listBundles 才停得下来。
    this.state.queued = false
    if (!this.controller) return false
    this.controller.abort(new Error('cancelled'))
    return true
  }

  sourceSummary() {
    // 被跳过的本地包不参与「来源」结论，否则一个 link: 插件就能把口径拽成 mixed。
    const entries = [...this.entries.values()].filter((entry) => entry.source !== 'skipped')
    if (entries.length === 0) return 'idle'
    const official = entries.filter((entry) => entry.source === 'pluginManager').length
    if (official === 0) return 'npm'
    return official === entries.length ? 'pluginManager' : 'mixed'
  }

  /**
   * 某个版本在 registry 上的发布时间。
   *
   * `/latest` 与 abbreviated packument 都不带 time，只有完整 packument 的
   * `time` 表有（形如 `{ "1.0.0": "2026-01-01T…" }`）。所以这里拉完整 packument。
   *
   * 三条约束：
   *   1. **只在有新版本可更新时调用** —— 否则每个已装包都要拉一份全文
   *   2. 结果缓存 6 小时（发布时间不会变，同一个包重复问没有意义）
   *   3. 任何失败一律返回 null，绝不抛 —— 拿不到发布时间只能说"不新鲜"，
   *      不能让一次辅助查询把整个更新检查搞挂
   *
   * @param {string} pkg
   * @param {string} version
   * @param {AbortSignal} [signal]
   * @returns {Promise<string|null>}
   */
  async publishedAtOf(pkg, version, signal) {
    const key = String(pkg || '').toLowerCase() + '@' + String(version || '')
    if (!key || key === '@') return null
    const cached = this.publishedCache.get(key)
    if (cached && this.now() - cached.at <= PUBLISHED_TTL_MS) return cached.value

    try {
      const response = await fetchJson('https://registry.npmjs.org/' + encodePackageName(pkg), {
        signal,
        timeoutMs: CHAIN_TIMEOUT_MS,
        retries: 1,
      })
      const time = response.value && typeof response.value === 'object' ? response.value.time : null
      const published = time && typeof time === 'object' && typeof time[version] === 'string' ? time[version] : null
      // 成功也缓存（包括 null）：拿不到就是拿不到，同一包同一版本 6 小时内别重问
      this.publishedCache.set(key, { at: this.now(), value: published })
      return published
    } catch {
      // 失败**不**缓存：网络抖一下不该让这个包在 6 小时内都"不新鲜"
      return null
    }
  }

  /** 单包解析：官方优先，npm 兜底。 */
  async resolve(item, signal) {
    const pkg = String(item.pkg)
    const installed = item.installed || null
    const manager = this.getManager()
    let latest = null
    let source = null
    let registry = null
    let error = null

    // 本地目录 / link: / github: 装的包根本不存在「registry 上的新版本」，
    // 问 pnpm 只会得到 invalid-spec 或 already-installed，还会在
    // .plugin-manager/logs 里留下失败记录 —— 直接跳过，连 warn 都不打。
    if (!isRegistryCandidate(pkg, item.spec)) {
      return {
        pkg,
        installed,
        latest: null,
        available: false,
        kind: 'local',
        from: installed,
        to: null,
        reason: 'local-package',
        source: 'skipped',
        registry: null,
        checkedAt: new Date(this.now()).toISOString(),
        error: null,
      }
    }

    if (manager && typeof manager.inspect === 'function') {
      try {
        const result = await withTimeout(Promise.resolve(manager.inspect(pkg, {}, signal)), INSPECT_TIMEOUT_MS)
        if (result && result.status === 'accepted' && result.version) {
          latest = String(result.version)
          source = 'pluginManager'
          registry = typeof result.registry === 'string' ? result.registry : null
        } else if (result && result.status === 'refused') {
          // already-installed 不是错误：官方认为它已经装好了，等于「没有新版本」，
          // 也不必再去 npm 问一次（私有 registry 上的包问了也没有意义）。
          if (result.problem === 'already-installed') {
            return {
              pkg,
              installed,
              latest: installed,
              available: false,
              kind: 'same',
              from: installed,
              to: installed,
              reason: 'already-installed',
              source: 'pluginManager',
              registry: null,
              checkedAt: new Date(this.now()).toISOString(),
              error: null,
            }
          }
          error = typeof result.problem === 'string' ? result.problem : 'refused'
        }
      } catch (cause) {
        error = cause?.message || String(cause)
      }
    }

    if (!latest) {
      const cached = this.compat && typeof this.compat.get === 'function' ? this.compat.get(pkg) : null
      if (cached && cached.version) {
        latest = String(cached.version)
        source = 'npm'
      } else {
        try {
          const response = await fetchJson('https://registry.npmjs.org/' + encodePackageName(pkg) + '/latest', {
            signal,
            timeoutMs: CHAIN_TIMEOUT_MS,
            retries: 1,
          })
          if (response.value && response.value.version) {
            latest = String(response.value.version)
            source = 'npm'
          }
        } catch (cause) {
          error = error || cause?.message || String(cause)
        }
      }
    }

    // ---- 目标版本的发布时间：只在一周内才值得在名字旁冒头 ----
    //
    // `/latest` 与 abbreviated packument 都**不带 time**，只有完整 packument 有。
    // 完整 packument 体积可达几十 KB~几 MB，不能每个包都拉。
    //
    // 所以只在**确实有新版本可更新**时才去取，并且走 packument 的 time 表
    // （它同时给出所有版本的发布时间，一次请求够用）。取不到就是 null ——
    // 前端对 null 的处理是"不亮圆点"，这正是保守的正确方向。
    let publishedAt = null
    if (latest && !error) {
      publishedAt = await this.publishedAtOf(pkg, latest, signal).catch(() => null)
    }

    const comparison = compareVersions(installed, latest)
    return {
      pkg,
      installed,
      latest,
      available: comparison.available,
      kind: comparison.kind,
      from: comparison.from,
      to: comparison.to,
      reason: comparison.reason,
      source: source || 'none',
      registry,
      // 目标版本的发布时间：前端据此决定"名字旁边要不要冒绿点"。
      // null 表示"拿不到"，此时不冒 —— 没有证据就不抢注意力。
      publishedAt,
      checkedAt: new Date(this.now()).toISOString(),
      error: latest ? null : (error || 'no-latest'),
    }
  }

  /**
   * 版本链（详情抽屉用），带 30 分钟内存缓存。
   * @param {string} pkg
   * @param {{from?: string, to?: string, force?: boolean, signal?: AbortSignal}} [options]
   */
  async chain(pkg, options = {}) {
    const key = String(pkg || '')
    if (!key) throw new Error('package name is required')
    const cached = this.chains.get(key)
    if (!options.force && cached && this.now() - cached.at <= CHAIN_TTL_MS) return cached.value
    const value = await fetchVersionChain(key, {
      from: options.from,
      to: options.to,
      signal: options.signal,
      timeoutMs: CHAIN_TIMEOUT_MS,
    })
    this.chains.set(key, { at: this.now(), value })
    return value
  }

  clear() {
    this.entries.clear()
    this.chains.clear()
    this.state = { running: false, source: 'idle', startedAt: null, finishedAt: null, error: null, total: 0, done: 0 }
  }
}
