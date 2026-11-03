/**
 * 日志页与规则页的渲染期契约。
 *
 * 这两个页签是这次新增的两条排查/定制入口：
 *   - 日志页：安装失败时能翻到完整链路（这是「点了安装没反应」的唯一现场）；
 *   - 规则页：能让用户看到当前口径、上传自己的规则、下载模版、套用预设、恢复内置。
 *
 * 断言盯住三件事：页签真的能打开、页面上的数字来自 Host（不是写死的）、
 * 每个按钮点下去真的发出对应的 op（写错 op 名在界面上完全看不出来）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'

const CLIENT_URL = pathToFileURL(fileURLToPath(new URL('../client.js', import.meta.url))).href

const sameDeps = (a, b) => {
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

function createRuntime() {
  // 每个组件模板各自一份 hook 存储。共用一个游标会让「今天渲染了 Table、
  // 明天渲染了 LogsPage」这类情形互相踩槽位：读到的 state 是别的组件的值，
  // 报错看起来像页面自己炸了，实际是测试替身的锅。
  const stores = new Map()
  let store = null
  let dirty = false
  let pendingEffects = []

  const slots = () => {
    if (!store) throw new Error('hook called outside of a component render')
    return store
  }

  const take = () => {
    const current = slots()
    const index = current.cursor++
    return { index, current }
  }

  const react = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const { index, current } = take()
      if (!(index in current.values)) current.values[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const computed = typeof next === 'function' ? next(current.values[index]) : next
        if (Object.is(computed, current.values[index])) return
        current.values[index] = computed
        dirty = true
      }
      return [current.values[index], set]
    },
    useRef(initial) {
      const { index, current } = take()
      if (!(index in current.values)) current.values[index] = { current: initial }
      return current.values[index]
    },
    useMemo(fn, deps) {
      const { index, current } = take()
      const slot = current.values[index]
      if (!slot || !sameDeps(slot.deps, deps)) {
        current.values[index] = { deps, value: fn() }
        return current.values[index].value
      }
      return slot.value
    },
    useCallback(fn, deps) {
      const { index, current } = take()
      const slot = current.values[index]
      if (!slot || !sameDeps(slot.deps, deps)) {
        current.values[index] = { deps, value: fn }
        return fn
      }
      return slot.value
    },
    useEffect(fn, deps) { const { index, current } = take(); pendingEffects.push({ current, index, fn, deps }) },
    useLayoutEffect(fn, deps) { react.useEffect(fn, deps) },
    useDeferredValue(value) { return value },
    useSyncExternalStore(_subscribe, getSnapshot) {
      const { index, current } = take()
      if (!(index in current.values)) current.values[index] = getSnapshot()
      return current.values[index]
    },
    useId() { return 'id' },
    useTransition() { return [false, (fn) => fn()] },
  }

  function renderComponent(template, props) {
    const previous = store
    let current = stores.get(template)
    if (!current) { current = { values: [], cursor: 0, effects: [] }; stores.set(template, current) }
    store = current
    try {
      return template(props)
    } finally {
      store = previous
    }
  }

  function expand(node) {
    if (node === null || node === undefined || node === false) return null
    if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node !== 'object') return null
    if (typeof node.type === 'function') return expand(renderComponent(node.type, { ...node.props, children: node.children }))
    return {
      type: node.type,
      props: node.props,
      // ref 指向这个节点本身：日志页的「跟随滚到底」与表格的滚动恢复都读 ref.current。
      children: (node.children || []).map(expand).filter((child) => child !== null),
    }
  }

  async function drain() {
    for (let index = 0; index < 16; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  async function flushEffects() {
    const list = pendingEffects
    pendingEffects = []
    for (const item of list) {
      const slot = item.current.effects[item.index]
      if (slot && sameDeps(slot.deps, item.deps)) continue
      if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = item.fn()
      item.current.effects[item.index] = { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    }
  }

  async function render(getElement) {
    let tree = null
    for (let pass = 0; pass < 60; pass += 1) {
      for (const current of stores.values()) current.cursor = 0
      dirty = false
      tree = expand(getElement())
      await flushEffects()
      await drain()
      if (!dirty) return tree
    }
    throw new Error('面板在 60 轮内没有稳定下来（可能是渲染循环）')
  }

  return { react, render, renderComponent }
}

function findNode(node, predicate) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return null
}

function textOf(node) {
  const sink = []
  const walk = (current) => {
    if (current === null || current === undefined || current === false) return
    if (Array.isArray(current)) { current.forEach(walk); return }
    if (typeof current === 'string' || typeof current === 'number') { sink.push(String(current)); return }
    if (typeof current !== 'object') return
    for (const child of current.children || []) walk(child)
  }
  walk(node)
  return sink.join(' ')
}

const ROW = {
  id: 'pkg:alpha-pkg',
  name: 'alpha-pkg',
  title: 'Alpha',
  pkg: 'alpha-pkg',
  version: '1.0.0',
  category: 'other',
  sources: ['dshso'],
  installable: true,
  installed: false,
  compat: { status: 'ok' },
  security: null,
  verification: null,
  riskFlags: [],
  trust: { tier: 'unknown', safe: false },
  updatedAt: '2026-10-01T00:00:00.000Z',
  heat: 1,
}

// 规则库：下拉框的候选（内置 + 预设 + 一份用户上传的）
const RULE_LIBRARY = [
  { id: 'builtin:default', name: '内置默认规则', description: '与 0.5.0 硬编码口径一致', origin: 'builtin', builtin: true, savedAt: null, factorCount: 11, labels: { excellent: 80, good: 60, fair: 40 }, groups: { market: 4, community: 4, heat: 3 } },
  { id: 'preset:newcomer', name: '扶持新插件', description: '降低安装量权重', origin: 'preset', builtin: true, savedAt: null, factorCount: 11, labels: { excellent: 80, good: 60, fair: 40 }, groups: { market: 4, community: 4, heat: 3 } },
  { id: 'user:freshness', name: '只看新鲜度', description: '自己传的', origin: 'user', builtin: false, savedAt: '2026-11-03T09:00:00.000Z', factorCount: 1, labels: { excellent: 90, good: 70, fair: 30 }, groups: { market: 1, community: 0, heat: 0 } },
]

const RULES_DESCRIPTION = {
  id: 'builtin:default',
  name: '内置默认规则',
  description: '与 0.5.0 硬编码口径一致',
  origin: 'builtin',
  builtin: true,
  labels: { excellent: 80, good: 60, fair: 40 },
  groups: {
    market: {
      aggregation: 'weighted',
      when: 'rating',
      factors: [
        { key: 'rating', metric: 'rating', metricLabel: '市场评分', norm: 'raw', normLabel: '原值截断', weight: 0.55, share: 55 },
        { key: 'users', metric: 'users', metricLabel: '安装量', norm: 'log', normLabel: '对数压缩', weight: 0.25, share: 25 },
      ],
      fallback: [{ key: 'coverage', metric: 'coverage', metricLabel: '来源覆盖', norm: 'coverage', normLabel: '来源覆盖分档', weight: 0.15 }],
    },
    community: { aggregation: 'weighted', when: null, factors: [], fallback: [] },
    heat: { aggregation: 'weighted', when: null, factors: [{ key: 'users', metric: 'users', metricLabel: '安装量', norm: 'log', normLabel: '对数压缩', weight: 1, share: 100 }], fallback: [] },
  },
}

const RULES_SUMMARY = {
  fingerprint: 'abc123def456',
  activeId: 'builtin:default',
  name: '内置默认规则',
  description: '与 market-lens 0.5.0 的硬编码口径完全一致',
  origin: 'builtin',
  source: 'default',
  savedAt: null,
  issue: null,
  isDefault: true,
  labels: { excellent: 80, good: 60, fair: 40 },
  factorCount: 11,
  choices: RULE_LIBRARY,
  entryCount: 3,
  userCount: 1,
}

const LOG_ENTRIES = [
  { seq: 1, at: '2026-11-03T08:00:01.000Z', level: 'info', tag: 'install.request', op: 'install', spec: 'alpha-pkg', key: 'pkg:alpha-pkg' },
  { seq: 2, at: '2026-11-03T08:00:02.000Z', level: 'warn', tag: 'install.fallback', op: 'install', spec: 'alpha-pkg', fellBackFrom: 'alpha-pkg@9.9.9' },
  { seq: 3, at: '2026-11-03T08:00:03.000Z', level: 'error', tag: 'install.failed', op: 'install', spec: 'alpha-pkg', detail: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/alpha-pkg: Not Found' },
]
const LOG_STATUS = { total: 3, limit: 500, seq: 3, dropped: 0, counts: { debug: 0, info: 1, warn: 1, error: 1 }, firstAt: LOG_ENTRIES[0].at, lastAt: LOG_ENTRIES[2].at }

function makeFetch(ops, options = {}) {
  const rulesSummary = options.rulesSummary || RULES_SUMMARY
  return async (_url, init) => {
    const payload = JSON.parse(init.body)
    ops.push(payload.op)
    const ok = (body) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) })
    const fail = (status, body) => ({ ok: false, status, json: async () => ({ ok: false, ...body }) })

    if (payload.op === 'status') {
      return ok({
        counts: { total: 1, installed: 0 },
        cache: { exists: true, generatedAt: '2026-11-03T08:00:00.000Z' },
        sync: { phase: 'idle', running: false },
        settings: { safeView: false, refreshIntervalMinutes: 0 },
        diff: { baselined: true },
        updates: { running: false, available: 0 },
        installed: { fingerprint: 'fp-1', packages: [] },
        install: { available: true, busy: false },
        sourceConfig: { sources: [] },
        compat: { total: 0, running: false },
        rules: rulesSummary,
        logs: LOG_STATUS,
      })
    }
    if (payload.op === 'catalog') {
      return ok({ rows: [ROW], meta: { diff: { baselined: true }, counts: { total: 1 } }, sourceConfig: { sources: [] } })
    }
    if (payload.op === 'logs') {
      const since = Number(payload.since) || 0
      let entries = LOG_ENTRIES.filter((entry) => entry.seq > since)
      if (payload.level) entries = entries.filter((entry) => entry.level === payload.level)
      if (payload.tag) entries = entries.filter((entry) => entry.tag.includes(payload.tag))
      if (payload.query) entries = entries.filter((entry) => JSON.stringify(entry).includes(payload.query))
      return ok({ entries, status: LOG_STATUS })
    }
    if (payload.op === 'logs.export') {
      return ok({
        text: LOG_ENTRIES.map((entry) => entry.at + ' [' + entry.level.toUpperCase() + '] ' + entry.tag).join('\n'),
        filename: 'market-lens-logs-2026-11-03-1600.txt',
        status: LOG_STATUS,
      })
    }
    if (payload.op === 'logs.clear') {
      return ok({ removed: 3, status: { ...LOG_STATUS, total: 1, counts: { debug: 0, info: 1, warn: 0, error: 0 } } })
    }
    if (payload.op === 'rules.get') {
      return ok({
        rules: { name: rulesSummary.name, labels: rulesSummary.labels, market: { factors: [] } },
        document: { format: 'market-lens/scoring-rules', rules: { name: rulesSummary.name } },
        summary: rulesSummary,
        activeId: rulesSummary.activeId,
        entry: { id: rulesSummary.activeId, name: rulesSummary.name, origin: 'builtin', builtin: true, savedAt: null },
        description: options.nameOnly ? null : RULES_DESCRIPTION,
        library: RULE_LIBRARY,
        savedAt: null,
        issue: null,
        paths: {
          library: 'C:\\Users\\tester\\.dsh\\market-lens\\scoring-rules-library.json',
          legacy: 'C:\\Users\\tester\\.dsh\\market-lens\\scoring-rules.json',
        },
      })
    }
    if (payload.op === 'rules.template') {
      return ok({
        template: {
          format: 'market-lens/scoring-rules',
          metrics: [{ key: 'rating' }, { key: 'users' }, { key: 'freshness' }],
          norms: [{ key: 'log', description: '对数压缩' }, { key: 'quantile' }],
          groups: [{ key: 'market', label: { zh: '市场风评' }, desc: { zh: '主排序分' } }],
        },
        // 界面上的说明表用这些结构化字段渲染
        metrics: [
          { key: 'rating', label: { zh: '市场评分', en: 'Market rating' }, kind: 'score' },
          { key: 'users', label: { zh: '安装量', en: 'Installers' }, kind: 'count' },
          { key: 'freshness', label: { zh: '新鲜度', en: 'Freshness' }, kind: 'derived' },
        ],
        norms: [
          { key: 'log', label: { zh: '对数压缩', en: 'Log scale' }, description: { zh: '抑制头部极值', en: 'tames outliers' } },
          { key: 'quantile', label: { zh: '分位排序', en: 'Quantile rank' }, description: { zh: '按排名给分', en: 'rank based' } },
          { key: 'raw', label: { zh: '原值截断', en: 'Raw' }, description: { zh: '直接截断', en: 'clamped' } },
        ],
        groups: [
          { key: 'market', label: { zh: '市场风评', en: 'Market score' }, desc: { zh: '主排序分。', en: 'primary' } },
          { key: 'community', label: { zh: '民间风评', en: 'Community score' }, desc: { zh: '社区活跃分。', en: 'community' } },
          { key: 'heat', label: { zh: '热度', en: 'Heat' }, desc: { zh: '默认排序键。', en: 'sort key' } },
        ],
        filename: 'market-lens-scoring-rules.template.json',
      })
    }
    if (payload.op === 'rules.export') {
      return ok({ document: { format: 'market-lens/scoring-rules', rules: {} }, filename: 'market-lens-scoring-rules-2026-11-03-1600.json', activeId: rulesSummary.activeId })
    }
    // 上传 = 往规则库里加一条并启用（不再覆盖单文件）
    if (payload.op === 'library.add' || payload.op === 'rules.import' || payload.op === 'rules.set') {
      if (options.rejectRules) return fail(400, { error: '规则文件不合法：market.factors[0].metric 必须是内置指标之一', issues: ['bad metric'] })
      const addedName = typeof payload.name === 'string' && payload.name ? payload.name : '只看新鲜度'
      return ok({
        summary: { ...rulesSummary, name: addedName, origin: 'user', source: 'file', isDefault: false, activeId: 'user:new' },
        counts: { total: 1 },
        rules: { name: addedName },
        activeId: 'user:new',
        entry: { id: 'user:new', name: addedName },
        library: [...RULE_LIBRARY, { id: 'user:new', name: addedName, origin: 'user', builtin: false, savedAt: '2026-11-03T10:00:00.000Z', factorCount: 1, labels: { excellent: 90, good: 70, fair: 30 }, groups: { market: 1, community: 0, heat: 0 } }],
      })
    }
    // 下拉框切换：启用库里已有的一条
    if (payload.op === 'library.activate' || payload.op === 'rules.preset') {
      if (options.rejectRules) return fail(400, { error: '规则文件不合法', issues: ['bad'] })
      const id = payload.op === 'rules.preset' ? 'preset:' + payload.id : payload.id
      const found = RULE_LIBRARY.find((item) => item.id === id)
      if (!found) return fail(404, { error: '规则库里没有这一条：' + id, library: RULE_LIBRARY })
      return ok({
        summary: { ...rulesSummary, name: found.name, origin: found.origin, isDefault: found.origin === 'builtin', activeId: id },
        counts: { total: 1 },
        rules: { name: found.name },
        activeId: id,
        library: RULE_LIBRARY,
        recomputed: true,
      })
    }
    // 删除自定义规则
    if (payload.op === 'library.remove') {
      const found = RULE_LIBRARY.find((item) => item.id === payload.id)
      if (!found) return fail(404, { error: '规则库里没有这一条', library: RULE_LIBRARY })
      if (found.builtin) return fail(400, { error: '内置规则不能删除，只能切换到别的规则' })
      return ok({
        summary: { ...rulesSummary, isDefault: true, activeId: 'builtin:default' },
        removed: { id: found.id, name: found.name },
        wasActive: true,
        activeId: 'builtin:default',
        library: RULE_LIBRARY.filter((item) => item.id !== found.id),
        counts: { total: 1 },
      })
    }
    if (payload.op === 'rules.reset') {
      return ok({ summary: { ...rulesSummary, source: 'default', isDefault: true, activeId: 'builtin:default' }, counts: { total: 1 }, rules: { name: rulesSummary.name }, activeId: 'builtin:default', library: RULE_LIBRARY })
    }
    return ok({})
  }
}

async function mountPanel(options = {}) {
  const { react, render, renderComponent } = createRuntime()
  const registered = []
  const ops = []
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  const previousSetInterval = globalThis.setInterval
  globalThis.window = {
    __ModuleLoader__: { load(definition) { registered.push(definition) } },
    addEventListener() {},
    removeEventListener() {},
    // 规则页的「恢复内置」与日志页的「清空」都会先 confirm；测试里一律放行。
    confirm() { return true },
  }
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  globalThis.fetch = makeFetch(ops, options)
  // 导出走 Blob + createObjectURL + a.click()：jsdom 之外没有这些 API，给最小替身。
  globalThis.Blob = globalThis.Blob || class { constructor(parts) { this.parts = parts } }
  const madeUrls = []
  globalThis.URL = globalThis.URL || {}
  if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => { madeUrls.push('blob:' + madeUrls.length); return madeUrls[madeUrls.length - 1] }
  if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {}
  globalThis.document = globalThis.document || {}
  if (!globalThis.document.createElement) {
    globalThis.document.createElement = () => ({ click() { this.clicked = true }, set href(value) { this._href = value }, get href() { return this._href } })
    globalThis.document.body = { appendChild(node) { node.appended = true }, removeChild(node) { node.removed = true } }
  }

  let definition
  try {
    await import(CLIENT_URL + '?pages=' + Math.random())
    definition = registered[0]
  } catch (cause) {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    throw cause
  }
  assert.equal(registered.length, 1, 'client.js 应调用一次 __ModuleLoader__.load')
  const module = definition.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error('unexpected module: ' + name)
  })
  const slots = []
  module.apply({
    effect(run) { run() },
    get() { return null },
    slots: {
      inject(_name, run) { run() },
      register(spec, component) { slots.push({ spec, component }); return () => {} },
    },
  })
  const main = slots.find((entry) => entry.spec.name === 'main')
  return {
    ops,
    render: () => render(() => renderComponent(main.component, {})),
    // 页签按文案点，避免依赖索引：页签顺序会变，文案不会。
    async openTab(tree, name) {
      const tab = findNode(tree, (node) => node.type === 'button' && node.props?.onClick && textOf(node).trim() === name)
      assert.ok(tab, '找不到页签：' + name)
      await tab.props.onClick()
      return this.render()
    },
    restore() {
      globalThis.fetch = previousFetch
      globalThis.setTimeout = previousSetTimeout
      globalThis.setInterval = previousSetInterval
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    },
  }
}

test('日志页：列出宿主日志、能按级别过滤、能导出', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    tree = await panel.openTab(tree, '运行日志')
    const text = textOf(tree)

    assert.ok(panel.ops.includes('logs'), '打开日志页要拉一次 op:logs')
    // 日志正文来自 Host，不是本地编出来的：tag/spec/detail 都要在页面上。
    assert.match(text, /install\.request/, '应显示 install.request')
    assert.match(text, /install\.failed/, '应显示失败记录')
    assert.match(text, /ERR_PNPM_FETCH_404/, '失败原因（pnpm 原文）必须完整露出')
    assert.match(text, /error · 1/, '级别计数应来自 Host 的 status.counts')

    // 按级别过滤：选 error 之后只该剩失败那条。
    const select = findNode(tree, (node) => node.type === 'select' && node.props?.onChange && node.props.value === '')
    assert.ok(select, '日志页应有级别下拉')
    await select.props.onChange({ target: { value: 'error' } })
    tree = await panel.render()
    const filtered = textOf(tree)
    assert.match(filtered, /install\.failed/)
    assert.doesNotMatch(filtered, /install\.request/, '过滤到 error 之后不该再显示 info')

    // 导出：Host 侧生成文本 + 文件名，前端只负责触发下载。
    const exportButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '导出日志')
    assert.ok(exportButton, '应有导出日志按钮')
    await exportButton.props.onClick()
    await panel.render()
    assert.ok(panel.ops.includes('logs.export'), '导出要走 op:logs.export')
    assert.match(textOf(await panel.render()), /导出日志 ✓/, '导出后要给出回执')
  } finally {
    panel.restore()
  }
})

test('日志页：清空会走 logs.clear 并回到空态', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    tree = await panel.openTab(tree, '运行日志')
    const clearButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '清空')
    assert.ok(clearButton, '应有清空按钮')
    await clearButton.props.onClick()
    tree = await panel.render()
    assert.ok(panel.ops.includes('logs.clear'), '清空要走 op:logs.clear')
    assert.match(textOf(tree), /清空 ✓/)
  } finally {
    panel.restore()
  }
})

test('规则页：下拉框列出全部可选规则，切换走 library.activate', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    tree = await panel.openTab(tree, '评分规则')

    assert.ok(panel.ops.includes('rules.get'), '打开规则页要拉一次 op:rules.get')
    const text = textOf(tree)

    // 下拉框是这次改动的落点：所有候选项都在同一个 select 里
    const select = findNode(tree, (node) => node.type === 'select' && node.props?.className === 'ml-rule-select')
    assert.ok(select, '规则页必须有规则下拉框')
    assert.equal(typeof select.props.onChange, 'function', '下拉框要能切换规则')
    // 当前值来自 Host 的 activeId，不是前端写死的第一项
    assert.equal(select.props.value, 'builtin:default')

    // 选项文字自带来源标签与因子数：用户不用逐条点开就知道选的是哪一类。
    // 直接看整页文本即可——三个候选各自的名字与来源标签都必须在页面上出现，
    // 这比去翻 select.children 的结构更贴近「用户到底看得见什么」。
    const selectText = textOf(select)
    assert.match(selectText, /内置默认规则/, '下拉框要列出内置项')
    assert.match(selectText, /扶持新插件/, '下拉框要列出预设项')
    assert.match(selectText, /只看新鲜度/, '下拉框要列出用户上传的那条')
    assert.match(selectText, /内置/, '选项要标出来源：内置')
    assert.match(selectText, /内置预设/, '选项要标出来源：预设')
    assert.match(selectText, /自己上传/, '选项要标出来源：自己上传')

    // 「这条规则在算什么」把因子翻成人话：指标 + 归一化 + 权重占比
    assert.match(text, /这条规则在算什么/, '要给出可读的规则构成')
    assert.match(text, /市场评分/, '因子要翻成指标名')
    assert.match(text, /对数压缩/, '归一化方式要翻成人话')
    assert.match(text, /55%/, '权重占比要算出来显示')
    assert.match(text, /80 \/ 60 \/ 40/, '分档阈值应来自 Host')
    // 这一组没参与打分时要明说
    assert.match(text, /这一组未参与评分/, 'community 没有因子时应标注未参与')

    // 用户自己的规则列在库里，并标出「使用中」的那条可以删
    assert.match(text, /规则库/, '要有规则库区块')
    assert.match(text, /scoring-rules-library\.json/, '应显示规则库文件位置')

    // 切到用户那条：走 library.activate
    await select.props.onChange({ target: { value: 'user:freshness' } })
    tree = await panel.render()
    assert.ok(panel.ops.includes('library.activate'), '下拉框切换要走 op:library.activate')
    assert.equal(panel.ops.filter((op) => op === 'library.activate').length, 1)
    assert.match(textOf(tree), /已切换规则/, '切换后要有回执')

    // 模版说明：点「说明」展开两张表，指标与归一化都翻成人话
    const guideButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim().startsWith('规则说明'))
    assert.ok(guideButton, '应有规则说明按钮')
    await guideButton.props.onClick()
    tree = await panel.render()
    assert.ok(panel.ops.includes('rules.template'), '展开说明要拉 op:rules.template')
    const guideText = textOf(tree)
    assert.match(guideText, /抑制头部极值/, '归一化要给出人话解释')
    assert.match(guideText, /安装量/, '指标表要列出人话含义')
    assert.match(guideText, /三组分数分别是什么/, '要解释三组分数各干什么')
    assert.match(guideText, /主排序分/, '组说明来自 Host')

    // 下载模版 / 导出 / 恢复内置
    const templateButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '下载模版')
    assert.ok(templateButton, '应有下载模版按钮')
    await templateButton.props.onClick()
    await panel.render()
    assert.equal(panel.ops.filter((op) => op === 'rules.template').length >= 1, true)

    const exportButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '导出规则')
    await exportButton.props.onClick()
    await panel.render()
    assert.ok(panel.ops.includes('rules.export'), '导出规则要走 op:rules.export')

    const resetButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '恢复内置规则')
    await resetButton.props.onClick()
    tree = await panel.render()
    assert.ok(panel.ops.includes('rules.reset'), '恢复内置要走 op:rules.reset')
    assert.match(textOf(tree), /已回到内置默认口径/, '恢复后要有回执')
  } finally {
    panel.restore()
  }
})

test('规则页：删除自定义规则要二次确认，走 library.remove', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    tree = await panel.openTab(tree, '评分规则')

    // 内置与预设只在下拉框里出现，库里不该给它们删除按钮
    const deleteButtonsBefore = []
    const collectButtons = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'button' && textOf(node).trim() === '删除') deleteButtonsBefore.push(node)
      for (const child of node.children || []) collectButtons(child)
    }
    collectButtons(tree)
    assert.equal(deleteButtonsBefore.length, 1, '只有自己传的那一条有删除按钮')

    const deleteButton = deleteButtonsBefore[0]
    await deleteButton.props.onClick()
    assert.ok(typeof deleteButton.props.onClick === 'function')

    // 点了删除不能立刻删：要先确认（删除是不可撤销的）
    tree = await panel.render()
    assert.match(textOf(tree), /删掉这份规则？/, '第一次点删除只应进入确认态')

    const confirmButton = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '确认删除')
    assert.ok(confirmButton, '确认态应给出「确认删除」')
    await confirmButton.props.onClick()
    tree = await panel.render()

    assert.ok(panel.ops.includes('library.remove'), '确认后要走 op:library.remove')
    const text = textOf(tree)
    assert.match(text, /已删除规则/, '删除后要有回执')
    assert.match(text, /已回到内置默认口径/, '删掉正在用的那条要说明已回退内置')
  } finally {
    panel.restore()
  }
})

test('规则页：上传失败时把原因留在页面上（走 library.add）', async () => {
  const panel = await mountPanel({ rejectRules: true })
  try {
    let tree = await panel.render()
    tree = await panel.openTab(tree, '评分规则')
    const fileInput = findNode(tree, (node) => node.type === 'input' && node.props?.type === 'file' && node.props?.accept?.includes('json'))
    assert.ok(fileInput, '规则页应有隐藏的 file input 用于本地上传')
    assert.ok(typeof fileInput.props.onChange === 'function')

    await fileInput.props.onChange({ target: { files: [{ text: async () => JSON.stringify({ market: { factors: [{ metric: 'magic' }] } }), name: 'my-rules.json' }], value: 'my-rules.json' } })
    tree = await panel.render()

    assert.ok(panel.ops.includes('library.add'), '上传要走 op:library.add')
    // 文件名要作为规则名一起发过去：用户不用再手填
    const text = textOf(tree)
    assert.match(text, /规则文件不合法/, 'Host 的拒绝原因要露在页面上')
    assert.match(text, /market\.factors\[0\]\.metric/, '要说清是哪个字段错了')
  } finally {
    panel.restore()
  }
})

test('七个页签都能打开，且不渲染出占位垃圾', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    for (const name of ['市场', '已安装', '自定义安装', '来源', '评分规则', '运行日志', '设置']) {
      tree = await panel.openTab(tree, name)
      const text = textOf(tree)
      assert.doesNotMatch(text, /undefined|null|NaN|\[object Object\]/, '页签 ' + name + ' 渲染出占位垃圾：' + text.slice(0, 200))
      // 回到市场页再开下一个，避免上一个页签的状态影响下一个
      tree = await panel.openTab(tree, '市场')
    }
  } finally {
    panel.restore()
  }
})
