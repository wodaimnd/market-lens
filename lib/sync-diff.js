/**
 * 「本次同步差异」：把两次目录快照对齐成带 change 标记的行集合。
 *
 * 三种标记各有语义：
 *   added   —— 上一份目录里没有这个 key（新上架）
 *   updated —— key 相同，但版本 / 更新日期 / 标题描述 / 来源集合变了
 *   removed —— 上一份目录里有，这一份没有（下架）。这类行**仍然留在结果里**，
 *              否则用户根本看不到"下架"这件事；但只留一代——下一次同步时，
 *              上一代已经 delisted 的行不再参与比较，也不再出现在结果里。
 *
 * 两个防误报的闸门：
 *   1. 首次同步（上一份为空）不做任何标记，summary.baselined = true。
 *   2. 部分失败的一轮（某来源挂了）不判下架：那一轮的条目会凭空消失，
 *      如果照样打"下架"，下一次成功同步又把它们标成"新增"，整张表在撒谎。
 *      所以只有「该行全部来源都在本轮成功列表里」才允许判下架。
 */

export const CHANGE_ADDED = 'added'
export const CHANGE_UPDATED = 'updated'
export const CHANGE_REMOVED = 'removed'

/** 参与"是否更新"判断的字段。版本是主信号，其余用来兜住没有版本的仓库型条目。 */
const TRACKED_FIELDS = ['version', 'updatedAt', 'title', 'description']

function sameValue(left, right) {
  if (left == null && right == null) return true
  if (left == null || right == null) return false
  return String(left) === String(right)
}

/**
 * 比较同一 key 的前后两行，返回变化的字段。
 * @returns {Record<string, {from: any, to: any}>}
 */
export function changesBetween(previous, next) {
  const detail = {}
  if (!previous || !next) return detail
  for (const field of TRACKED_FIELDS) {
    if (sameValue(previous[field], next[field])) continue
    detail[field] = { from: previous[field] ?? null, to: next[field] ?? null }
  }
  const before = new Set(Array.isArray(previous.sources) ? previous.sources : [])
  const addedSources = (Array.isArray(next.sources) ? next.sources : []).filter((source) => !before.has(source))
  if (addedSources.length) detail.sources = { from: Array.isArray(previous.sources) ? previous.sources : [], to: addedSources }
  return detail
}

function annotate(row, change, detail) {
  return { ...row, change, changeDetail: detail && Object.keys(detail).length ? detail : null }
}

/**
 * @param {object[]} previous 上一份目录（可能含上一代 delisted 行）
 * @param {object[]} next 本轮构建出的目录
 * @param {{syncedSources?: Iterable<string>|Set<string>, now?: string, previousGeneratedAt?: string|null}} [options]
 */
export function diffRows(previous, next, options = {}) {
  const now = typeof options.now === 'string' ? options.now : new Date().toISOString()
  const previousRows = Array.isArray(previous) ? previous.filter((row) => row && typeof row.key === 'string') : []
  const nextRows = Array.isArray(next) ? next.filter((row) => row && typeof row.key === 'string') : []
  // 上一代已下架的行不参与比较，也不再延续——"下架"标记只活一代。
  const liveRows = previousRows.filter((row) => row.delisted !== true)
  const baseline = liveRows.length === 0

  let synced = null
  if (options.syncedSources instanceof Set) synced = options.syncedSources
  else if (Array.isArray(options.syncedSources)) synced = new Set(options.syncedSources)

  const previousByKey = new Map(liveRows.map((row) => [row.key, row]))
  const nextKeys = new Set()

  const rows = nextRows.map((row) => {
    nextKeys.add(row.key)
    const previousRow = previousByKey.get(row.key)
    if (baseline) return annotate(row, null, null)
    if (!previousRow) return annotate(row, CHANGE_ADDED, null)
    const detail = changesBetween(previousRow, row)
    return Object.keys(detail).length ? annotate(row, CHANGE_UPDATED, detail) : annotate(row, null, null)
  })

  const removed = []
  if (!baseline) {
    for (const row of liveRows) {
      if (nextKeys.has(row.key)) continue
      const sources = Array.isArray(row.sources) ? row.sources : []
      // 来源为空的行没有可靠的"来源是否成功"证据，宁可不判下架。
      if (sources.length === 0) continue
      if (synced && !sources.every((source) => synced.has(source))) continue
      removed.push({
        ...row,
        change: CHANGE_REMOVED,
        changeDetail: null,
        delisted: true,
        delistedAt: now,
      })
    }
  }

  const summary = {
    baselined: baseline,
    added: rows.filter((row) => row.change === CHANGE_ADDED).length,
    updated: rows.filter((row) => row.change === CHANGE_UPDATED).length,
    removed: removed.length,
    total: rows.length + removed.length,
    generatedAt: now,
    previousGeneratedAt: options.previousGeneratedAt || null,
  }

  return { rows: [...rows, ...removed], summary }
}

/** 目录里带 change 标记的行（筛选/导出用）。 */
export function changedRows(rows) {
  return Array.isArray(rows) ? rows.filter((row) => row.change === CHANGE_ADDED || row.change === CHANGE_UPDATED || row.change === CHANGE_REMOVED) : []
}

/** change 标记的中文/英文文案 key（client 与测试共用）。 */
export const CHANGE_LABEL_KEYS = {
  [CHANGE_ADDED]: 'changeAdded',
  [CHANGE_UPDATED]: 'changeUpdated',
  [CHANGE_REMOVED]: 'changeRemoved',
}
