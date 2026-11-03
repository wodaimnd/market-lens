/**
 * 窗口外观的渲染期契约（0.4.0）。
 *
 * 用户的抱怨是「窗口还是框在 DSH 界面里」。这一轮把弹层做成了真窗口手感：
 * 标题栏有 收起 / 最大化 / 复位 / 独立窗口 / 关闭，八条边都能拉大小，
 * 双击标题栏最大化。这里用一个能真正跑 state 的迷你 hook 运行时挂载面板，
 * 打开「列」设置窗，断言这些控件真的渲染出来、点了最大化之后铺满整屏。
 *
 * 另外断言：窗口关掉后 DOM 里不再有 dialog —— 否则每开一次就漏一层遮罩。
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
  const values = []
  const effectSlots = []
  let cursor = 0
  let dirty = false
  let pendingEffects = []

  const react = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const computed = typeof next === 'function' ? next(values[index]) : next
        if (Object.is(computed, values[index])) return
        values[index] = computed
        dirty = true
      }
      return [values[index], set]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = { current: initial }
      return values[index]
    },
    useMemo(fn, deps) {
      const index = cursor++
      const slot = values[index]
      if (!slot || !sameDeps(slot.deps, deps)) {
        values[index] = { deps, value: fn() }
        return values[index].value
      }
      return slot.value
    },
    useCallback(fn, deps) {
      const index = cursor++
      const slot = values[index]
      if (!slot || !sameDeps(slot.deps, deps)) {
        values[index] = { deps, value: fn }
        return fn
      }
      return slot.value
    },
    useEffect(fn, deps) { pendingEffects.push({ index: cursor++, fn, deps }) },
    useLayoutEffect(fn, deps) { pendingEffects.push({ index: cursor++, fn, deps }) },
    useDeferredValue(value) { return value },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useId() { return 'id' },
    useTransition() { return [false, (fn) => fn()] },
  }

  function expand(node) {
    if (node === null || node === undefined || node === false) return null
    if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null)
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node !== 'object') return null
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
    return {
      type: node.type,
      props: node.props,
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
      const slot = effectSlots[item.index]
      if (slot && sameDeps(slot.deps, item.deps)) continue
      if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = item.fn()
      effectSlots[item.index] = { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    }
  }

  async function render(getElement) {
    let tree = null
    for (let pass = 0; pass < 60; pass += 1) {
      cursor = 0
      dirty = false
      tree = expand(getElement())
      await flushEffects()
      await drain()
      if (!dirty) return tree
    }
    throw new Error('面板在 60 轮内没有稳定下来（可能是渲染循环）')
  }

  return { react, render }
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

function findAll(node, predicate, sink = []) {
  if (node === null || node === undefined || node === false) return sink
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, sink)
    return sink
  }
  if (typeof node !== 'object') return sink
  if (predicate(node)) sink.push(node)
  for (const child of node.children || []) findAll(child, predicate, sink)
  return sink
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
  id: 'pkg:@acme/tool',
  name: '@acme/tool',
  title: 'Acme Tool',
  pkg: '@acme/tool',
  version: '1.2.3',
  category: 'other',
  sources: ['dshso'],
  sourceIds: { dshso: '1' },
  installable: true,
  installCommand: 'dsh plugin add @acme/tool@1.2.3',
  installed: false,
  compat: { status: 'ok' },
  security: null,
  verification: null,
  riskFlags: [],
  trust: { tier: 'unknown', safe: false },
  updatedAt: '2026-10-01T00:00:00.000Z',
  heat: 1,
}

function makeFetch() {
  return async (_url, init) => {
    const payload = JSON.parse(init.body)
    const ok = (body) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) })
    if (payload.op === 'status') {
      return ok({
        pluginVersion: '0.4.0',
        rows: 1,
        counts: { total: 1, installed: 0 },
        cache: { exists: true, generatedAt: '2026-11-01T00:00:00.000Z', rows: 1 },
        sync: { phase: 'idle', running: false },
        settings: { safeView: false, refreshIntervalMinutes: 0 },
        diff: { baselined: true },
        updates: { running: false, available: 0 },
        installed: { count: 1, fingerprint: 'fp-1' },
        install: { available: true, busy: false },
        sourceConfig: { sources: [] },
        compat: { total: 0, pending: 0, running: false },
      })
    }
    if (payload.op === 'catalog') {
      return ok({ rows: [ROW], meta: { diff: { baselined: true }, counts: { total: 1 } }, sourceConfig: { sources: [] } })
    }
    if (payload.op === 'selfcheck') {
      return ok({ pluginVersion: '0.4.0', route: '/api/market-lens', runtime: { runtimeVersion: '0.2.1-rc.4' } })
    }
    return ok({})
  }
}

async function mountPanel() {
  const { react, render } = createRuntime()
  const registered = []
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  const previousSetInterval = globalThis.setInterval
  globalThis.window = {
    __ModuleLoader__: { load(definition) { registered.push(definition) } },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 860,
  }
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  globalThis.fetch = makeFetch()
  await import(CLIENT_URL + '?window=' + Math.random())
  const definition = registered[0]
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
    render: () => render(() => main.component({})),
    restore() {
      globalThis.fetch = previousFetch
      globalThis.setTimeout = previousSetTimeout
      globalThis.setInterval = previousSetInterval
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    },
  }
}

const byTitle = (needle) => (node) => node.type === 'button' && typeof node.props?.title === 'string' && node.props.title.includes(needle)

// 「列」按钮的 onClick 要读 event.currentTarget 算锚点，stub 里给一个假元素。
const fakeAnchor = () => ({ getBoundingClientRect: () => ({ top: 40, bottom: 64, left: 20, right: 100, width: 80, height: 24 }) })
async function openColumns(tree) {
  const button = findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '列')
  assert.ok(button, '工具栏应有「列」按钮')
  await button.props.onClick({ currentTarget: fakeAnchor(), stopPropagation() {} })
}

test('窗口有真窗口的标题栏控件与八向缩放把手', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    // 工具栏里的「列」按钮打开列表设置窗
    await openColumns(tree)
    tree = await panel.render()

    const dialog = findNode(tree, (node) => node.props && node.props.role === 'dialog')
    assert.ok(dialog, '应该渲染出一扇窗')
    assert.ok(findNode(tree, byTitle('最大化到整屏')), '缺最大化按钮')
    assert.ok(findNode(tree, byTitle('收起到标题栏')), '缺最小化按钮')
    assert.ok(findNode(tree, byTitle('独立窗口')), '缺独立窗口按钮')
    assert.ok(findNode(tree, byTitle('复位窗口大小与位置')), '缺复位按钮')
    assert.ok(findNode(tree, byTitle('关闭')), '缺关闭按钮')

    // 八条边：n/s/w/e + 四个角，靠 cursor 认
    const cursors = findAll(tree, (node) => node.props && typeof node.props.style === 'object' && node.props.style && node.props.style.cursor && /resize$/.test(String(node.props.style.cursor)))
      .map((node) => node.props.style.cursor)
    for (const cursor of ['ns-resize', 'ew-resize', 'nwse-resize', 'nesw-resize']) {
      assert.ok(cursors.includes(cursor), '缺少 ' + cursor + ' 方向的缩放把手')
    }
  } finally {
    panel.restore()
  }
})

test('点最大化之后窗口铺满整屏，再点还原回原尺寸', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    await openColumns(tree)
    tree = await panel.render()

    const dialog = () => findNode(tree, (node) => node.props && node.props.role === 'dialog')
    const before = dialog().props.style
    assert.ok(before.width < 1280 - 16, '初始不该是整屏宽')

    await findNode(tree, byTitle('最大化到整屏')).props.onClick()
    tree = await panel.render()
    const zoomed = dialog().props.style
    assert.equal(zoomed.left, 8)
    assert.equal(zoomed.top, 8)
    assert.equal(zoomed.width, 1280 - 16)
    assert.equal(zoomed.height, 860 - 16)

    await findNode(tree, byTitle('还原窗口')).props.onClick()
    tree = await panel.render()
    const restored = dialog().props.style
    assert.equal(restored.width, before.width)
    assert.equal(restored.height, before.height)
  } finally {
    panel.restore()
  }
})

test('收起之后只剩标题栏高度，再点一次恢复', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    await openColumns(tree)
    tree = await panel.render()

    const dialog = () => findNode(tree, (node) => node.props && node.props.role === 'dialog')
    const full = dialog().props.style.height
    await findNode(tree, byTitle('收起到标题栏')).props.onClick()
    tree = await panel.render()
    assert.equal(dialog().props.style.height, 34)

    await findNode(tree, byTitle('还原窗口')).props.onClick()
    tree = await panel.render()
    assert.equal(dialog().props.style.height, full)
  } finally {
    panel.restore()
  }
})

test('⧉ 被壳子拦下时铺满整屏并说明原因，而不是静默无反应', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    await openColumns(tree)
    tree = await panel.render()

    const dialog = () => findNode(tree, (node) => node.props && node.props.role === 'dialog')
    assert.ok(dialog().props.style.width < 1280 - 16, '点之前不是整屏')

    // 测试环境里 window.open 不存在，正好等于桌面壳子 deny 的结局。
    await findNode(tree, byTitle('独立窗口')).props.onClick()
    tree = await panel.render()

    assert.equal(dialog().props.style.width, 1280 - 16, '被拦下时应整屏铺开')
    assert.match(textOf(tree), /桌面壳子不允许开新窗口|desktop shell blocks new windows/)
  } finally {
    panel.restore()
  }
})

test('关窗之后 DOM 里不再有 dialog（不留遮罩）', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    await openColumns(tree)
    tree = await panel.render()
    assert.ok(findNode(tree, (node) => node.props && node.props.role === 'dialog'), '应先有一扇窗')

    await findNode(tree, byTitle('关闭')).props.onClick()
    tree = await panel.render()
    assert.equal(findNode(tree, (node) => node.props && node.props.role === 'dialog'), null)
  } finally {
    panel.restore()
  }
})
