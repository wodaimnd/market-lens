/** npm metadata -> DSH runtime compatibility, following app-boot's peer/engines rules. */

import semver from 'semver'
import { asRecord, fetchJson, sleep } from './util.js'

const NPM_LATEST_ENDPOINT = 'https://registry.npmjs.org'
const CACHE_TTL_MS = 7 * 86_400_000
const CONCURRENCY = 16

function workspaceRange(range, runtimeVersion) {
  if (range === 'workspace:*' || range === 'workspace:^' || range === 'workspace:~') return runtimeVersion
  if (range.startsWith('workspace:')) return range.slice('workspace:'.length)
  return range
}

/** Evaluate one npm manifest against the running DSH runtime. */
export function evaluateManifest(manifest, runtimeVersion) {
  if (!manifest || typeof manifest !== 'object') {
    return { status: 'unknown', reason: 'no-manifest' }
  }
  if (typeof runtimeVersion !== 'string' || !semver.valid(runtimeVersion)) {
    return { status: 'unknown', reason: 'runtime-version-unavailable' }
  }
  const engines = asRecord(manifest.engines)
  if (engines && Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string' || !range.trim()) {
      return { status: 'bad', reason: 'invalid-engines-dsh', requirements: { 'engines.dsh': String(range) }, unmet: ['engines.dsh'] }
    }
    if (range.trim().startsWith('workspace:')) {
      return { status: 'bad', reason: 'invalid-engines-dsh', requirements: { 'engines.dsh': range }, unmet: ['engines.dsh'] }
    }
    const ok = semver.satisfies(runtimeVersion, range.trim(), { includePrerelease: true })
    return {
      status: ok ? 'ok' : 'bad',
      reason: ok ? 'engines-dsh' : 'engines-dsh-mismatch',
      requirements: { 'engines.dsh': range.trim() },
      unmet: ok ? [] : ['engines.dsh'],
    }
  }

  const peers = asRecord(manifest.peerDependencies) ?? {}
  const dshPeers = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  if (dshPeers.length === 0) {
    return { status: 'none', reason: 'no-dsh-requirement', requirements: {} }
  }

  const requirements = {}
  const unmet = []
  for (const [name, rawRange] of dshPeers) {
    if (typeof rawRange !== 'string' || !rawRange.trim()) {
      requirements[name] = String(rawRange)
      unmet.push(name)
      continue
    }
    const range = workspaceRange(rawRange.trim(), runtimeVersion)
    requirements[name] = range
    if (!semver.satisfies(runtimeVersion, range, { includePrerelease: true })) unmet.push(name)
  }
  return {
    status: unmet.length ? 'bad' : 'ok',
    reason: unmet.length ? 'peer-mismatch' : 'peer-ok',
    requirements,
    unmet,
  }
}

async function fetchLatestManifest(pkg, signal) {
  const url = `${NPM_LATEST_ENDPOINT}/${pkg}/latest`
  const response = await fetchJson(url, { signal, timeoutMs: 20_000, retries: 1 })
  const manifest = response.value
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    throw new Error('npm latest manifest is invalid')
  }
  return manifest
}

export class CompatService {
  constructor({ runtimeVersion, cache, onPersist, onUpdate, logger } = {}) {
    this.runtimeVersion = runtimeVersion
    this.onPersist = onPersist ?? (() => {})
    this.onUpdate = onUpdate ?? (() => {})
    this.logger = logger ?? console
    this.entries = new Map()
    this.seq = 0
    this.queue = []
    this.total = 0
    this.done = 0
    this.running = false
    this.controller = null
    this.persistCounter = 0
    this.lastPersist = 0
    if (cache && Array.isArray(cache.entries)) {
      for (const item of cache.entries) {
        if (Array.isArray(item) && typeof item[0] === 'string' && item[1] && typeof item[1] === 'object') {
          this.entries.set(item[0], item[1])
          if (Number.isFinite(item[1].seq)) this.seq = Math.max(this.seq, item[1].seq)
        }
      }
    }
    if (Number.isFinite(cache?.seq)) this.seq = Math.max(this.seq, cache.seq)
  }

  get(pkg) {
    return pkg ? this.entries.get(pkg.toLowerCase()) ?? null : null
  }

  delta(since = 0) {
    const items = []
    for (const [pkg, entry] of this.entries) {
      if ((entry.seq ?? 0) > since) items.push([pkg, entry])
    }
    return { seq: this.seq, items, total: this.total, done: this.done, running: this.running }
  }

  status() {
    return {
      total: this.total,
      done: this.done,
      checked: this.entries.size,
      running: this.running,
      seq: this.seq,
    }
  }

  snapshot() {
    return {
      seq: this.seq,
      entries: [...this.entries.entries()],
    }
  }

  cancel() {
    if (this.controller) this.controller.abort(new Error('compatibility check cancelled'))
  }

  /**
   * Queue every package that is missing or stale. Priority is high for scored,
   * featured and user-installed rows, so the visible table gets useful answers first.
   */
  plan(packages, { force = false } = {}) {
    const now = Date.now()
    const unique = new Map()
    for (const item of packages) {
      if (!item || typeof item.pkg !== 'string') continue
      const pkg = item.pkg.toLowerCase()
      const priority = Number(item.priority) || 0
      const existing = unique.get(pkg)
      if (!existing || existing.priority < priority) unique.set(pkg, { pkg, priority })
    }
    const list = [...unique.values()].sort((left, right) => right.priority - left.priority)
    const queue = []
    let cached = 0
    for (const item of list) {
      const entry = this.entries.get(item.pkg)
      const fresh = entry && Number.isFinite(entry.checkedAt) && now - entry.checkedAt < CACHE_TTL_MS
      if (!force && fresh) {
        cached++
        continue
      }
      queue.push(item.pkg)
    }
    this.queue = queue
    this.total = list.length
    this.done = cached
    this.persistCounter = 0
    this.lastPersist = Date.now()
    if (queue.length === 0) {
      this.running = false
      return { queued: 0, total: this.total, done: this.done }
    }
    this.running = true
    this.controller = new AbortController()
    void this.run(this.controller.signal)
    return { queued: queue.length, total: this.total, done: this.done }
  }

  async run(signal) {
    const queue = this.queue
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (true) {
        if (signal.aborted) return
        const index = cursor++
        if (index >= queue.length) return
        const pkg = queue[index]
        try {
          const manifest = await fetchLatestManifest(pkg, signal)
          const evaluation = evaluateManifest(manifest, this.runtimeVersion)
          this.set(pkg, {
            ...evaluation,
            version: manifest.version,
            checkedAt: Date.now(),
          })
        } catch (error) {
          if (signal.aborted) return
          const notFound = error && error.status === 404
          this.set(pkg, {
            status: 'unknown',
            reason: notFound ? 'npm-not-found' : 'fetch-failed',
            error: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now(),
          })
          if (!notFound) await sleep(80 + Math.random() * 160)
        } finally {
          this.done++
          await this.maybePersist()
        }
      }
    })
    await Promise.all(workers)
    if (signal.aborted) {
      this.running = false
      return
    }
    this.running = false
    await this.persist(true)
  }

  set(pkg, entry) {
    this.seq++
    const record = { ...entry, seq: this.seq }
    this.entries.set(pkg, record)
    try {
      this.onUpdate(pkg, record)
    } catch {
      // A listener must never break the queue.
    }
    this.persistCounter++
  }

  async maybePersist() {
    const now = Date.now()
    if (this.persistCounter >= 500 || now - this.lastPersist > 10_000) {
      await this.persist(false)
    }
  }

  async persist(force) {
    if (!force && this.persistCounter === 0) return
    const now = Date.now()
    if (!force && now - this.lastPersist < 2_000) return
    this.persistCounter = 0
    this.lastPersist = now
    try {
      await this.onPersist(this.snapshot(), this.status())
    } catch (error) {
      this.logger.warn?.('[market-lens] failed to persist compatibility cache: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}
