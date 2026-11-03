/**
 * 操作日志环形缓冲区。
 *
 * 存在的理由：安装 / 升级是长请求（pnpm 下载 → 应用 → 重启生效），失败时
 * 界面只剩一句被截断的报错。用户要排查「点了安装但没装上」，需要看到的是
 * 那一次请求完整的上下文：请求 op、目标 spec、降级链、pnpm 原文、pendingBuilds、
 * 耗时、以及宿主侧自己抛的异常。这些信息原先只散落在 logger.info 里，
 * 重启就没了，也没有任何入口能看。
 *
 * 设计取舍：
 *   - 进程内环形缓冲（默认 500 条），不落盘：日志是排查当前会话问题的，
 *     不是审计账本；写盘会在每次 install 时多一次 IO，且需要考虑磁盘满、
 *     并发写等一堆边角。
 *   - 订阅式推送：请求处理器 / 客户端可以实时拿到新条目（用于日志页跟随），
 *     但订阅回调抛异常绝不允许影响写入方。
 *   - 每条都带 seq（单调递增），客户端按 seq 拉增量，避免整表重发。
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error']

const DEFAULT_LIMIT = 500
// 单条 detail 的长度上限：pnpm 的报错有时会把整棵依赖树打出来，截断保住环形缓冲的容量
const MAX_DETAIL = 8000
const MAX_TAG = 60

/** @typedef {'debug'|'info'|'warn'|'error'} LogLevel */

export class OpLog {
  /**
   * @param {{limit?: number, now?: () => number}} [options]
   */
  constructor({ limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
    const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
    this.limit = Math.max(20, Math.min(size, 5000))
    this.now = now
    /** @type {Array<object>} */
    this.entries = []
    this.seq = 0
    this.dropped = 0
    this.listeners = new Set()
  }

  /**
   * 写一条日志。
   *
   * @param {LogLevel} level
   * @param {string} tag 事件标签，例如 install.start / install.failed
   * @param {object} [data] 结构化字段，值会被浅拷贝并按类型收敛
   * @returns {object|null} 写入的条目（level 非法时返回 null）
   */
  write(level, tag, data = {}) {
    const normalizedLevel = LOG_LEVELS.includes(level) ? level : 'info'
    const entry = {
      seq: ++this.seq,
      at: new Date(this.now()).toISOString(),
      level: normalizedLevel,
      tag: truncate(String(tag ?? 'event'), MAX_TAG),
      ...sanitize(data),
    }
    if (typeof entry.detail === 'string' && entry.detail.length > MAX_DETAIL) {
      entry.detail = entry.detail.slice(0, MAX_DETAIL) + ' …(' + (entry.detail.length - MAX_DETAIL) + ' 字符已截断)'
    }
    this.entries.push(entry)
    if (this.entries.length > this.limit) {
      // 一次只丢一条：批量丢会把突发故障的开头（往往是最有用的那几条）一起冲掉
      this.entries.splice(0, this.entries.length - this.limit)
      this.dropped++
    }
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        // 订阅者（界面推送 / 测试探针）出错不能连累日志本身
      }
    }
    return entry
  }

  debug(tag, data) {
    return this.write('debug', tag, data)
  }

  info(tag, data) {
    return this.write('info', tag, data)
  }

  warn(tag, data) {
    return this.write('warn', tag, data)
  }

  error(tag, data) {
    return this.write('error', tag, data)
  }

  /** 按 seq 拉增量：since 之后写入的条目。 */
  list({ since = 0, limit = 0, level = null, tag = null, query = '' } = {}) {
    const from = Number(since) || 0
    const needle = String(query || '').trim().toLowerCase()
    let items = this.entries.filter((entry) => entry.seq > from)
    if (LOG_LEVELS.includes(level)) items = items.filter((entry) => entry.level === level)
    if (typeof tag === 'string' && tag.trim()) {
      const wanted = tag.trim().toLowerCase()
      items = items.filter((entry) => entry.tag.toLowerCase().includes(wanted))
    }
    if (needle) {
      items = items.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle))
    }
    const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : 0
    if (cap > 0 && items.length > cap) items = items.slice(items.length - cap)
    return items
  }

  status() {
    const first = this.entries[0]
    const last = this.entries[this.entries.length - 1]
    const counts = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const entry of this.entries) counts[entry.level] = (counts[entry.level] || 0) + 1
    return {
      total: this.entries.length,
      limit: this.limit,
      seq: this.seq,
      dropped: this.dropped,
      counts,
      firstAt: first ? first.at : null,
      lastAt: last ? last.at : null,
    }
  }

  /** 导出为文本：用户直接粘进 issue 里就能用。 */
  toText({ since = 0 } = {}) {
    const lines = this.list({ since }).map((entry) => {
      const fields = Object.entries(entry)
        .filter(([key]) => !['seq', 'at', 'level', 'tag'].includes(key))
        .map(([key, value]) => key + '=' + (typeof value === 'string' ? value : JSON.stringify(value)))
      return entry.at + ' [' + entry.level.toUpperCase() + '] ' + entry.tag + (fields.length ? '  ' + fields.join(' ') : '')
    })
    return lines.join('\n')
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear() {
    const removed = this.entries.length
    this.entries = []
    this.dropped = 0
    return removed
  }
}

/** 只保留 JSON 安全的标量与小数组，避免把整个 row / 错误对象塞进缓冲区。 */
function sanitize(data) {
  const out = {}
  if (!data || typeof data !== 'object') return out
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
      continue
    }
    if (typeof value === 'string') {
      out[key] = value
      continue
    }
    if (Array.isArray(value)) {
      const list = value
        .filter((item) => item === null || typeof item === 'string' || typeof item === 'number')
        .slice(0, 40)
      out[key] = list
      continue
    }
    if (value instanceof Error) {
      out[key] = value.message
      continue
    }
    // 对象只取一层标量，深度嵌套的结构没有排查价值，反而会把缓冲区撑爆
    const flat = {}
    for (const [innerKey, innerValue] of Object.entries(value)) {
      if (innerValue === null || typeof innerValue === 'string' || typeof innerValue === 'number' || typeof innerValue === 'boolean') {
        flat[innerKey] = innerValue
      }
    }
    if (Object.keys(flat).length) out[key] = flat
  }
  return out
}

function truncate(value, limit) {
  return value.length > limit ? value.slice(0, limit) + '…' : value
}
