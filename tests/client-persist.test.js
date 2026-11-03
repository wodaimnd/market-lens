// 页面缓存契约：
//   1. 「翻到第十页 → 切走 → 再进来」必须还在第十页；
//   2. 这条恢复不能被打回第 1 页——以前的 setPage(1) effect 在首次挂载时也跑，正是那次事故；
//   3. 用户真的改了搜索/排序时，还是得回第 1 页（否则会停在一个空页上）；
//   4. 滚动位置要跟着一起记；
//   5. 快照坏掉（老版本的排序列、越界视图名）只该退回默认值，绝不能把面板带崩。
//
// 这里用的是带真实记忆的 stub hooks：useState 的 setter 会触发重渲染，
// useEffect 会按依赖数组比较后执行。client-mount.test.js 那种一次性 stub
// 只能证明「渲染不抛错」，上面这些行为它一个都测不到。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'

const CLIENT_URL = pathToFileURL(fileURLToPath(new URL('../client.js', import.meta.url))).href
const PAGE_STORE = 'market-lens:page:v1'
// 页大小只认 [50, 100, 200]（client.js:146 PAGE_SIZES），所以 120 行 = 3 页。
const ROW_COUNT = 120

// runner 自己必须用真定时器（要回避让），但面板挂载后开的 20s 轮询 / 1.5s tick
// 会让 node --test 永远等不到事件循环清空 —— 那些一律换成空实现。
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
function installTimerStubs() {
  let nextId = 1
  const noop = () => { nextId += 1; return nextId }
  globalThis.setInterval = noop
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = noop
  globalThis.clearTimeout = () => {}
}

function createLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    get length() { return map.size },
    key(index) { return [...map.keys()][index] ?? null },
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(String(key), String(value)) },
    removeItem(key) { map.delete(key) },
    clear() { map.clear() },
    dump() { return Object.fromEntries(map) },
  }
}

function makeRow(index) {
  return {
    key: 'pkg:pkg-' + index,
    name: 'pkg-' + String(index).padStart(3, '0'),
    packageName: 'pkg-' + String(index).padStart(3, '0'),
    description: 'fixture ' + index,
    kind: 'npm',
    installers: 500 + index,
    stars: 300 + index,
    downloads: 900 + index,
    forks: 20,
    score: 80,
    // safeView 默认开：installCheck 不是 'passed' 的行会被整片滤掉，行数就对上了。
    // 安全视图默认开着，没有安全结论的行会被判成 unknown 而整行隐藏。
    security: { riskLevel: 'low', installCheck: 'passed' },
    updatedAt: new Date(Date.now() - (index % 30) * 86400000).toISOString(),
    sources: ['standard'],
    installCommand: 'dsh plugin --profile desktop add pkg-' + index,
  }
}

/** 会话级 fetch 桩：把 status / catalog 两个 op 应答成真数据，其它 op 抛错暴露出来。 */
function createFetchStub() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    let payload = {}
    try { payload = JSON.parse(String(options.body || '{}')) } catch { payload = {} }
    calls.push(payload.op || String(url))
    if (payload.op === 'status') {
      return { ok: true, status: 200, json: async () => ({ ok: true, cache: { exists: true, generatedAt: '2026-11-03T08:00:00.000Z' }, settings: { safeView: true } }) }
    }
    if (payload.op === 'catalog') {
      const rows = Array.from({ length: ROW_COUNT }, (_, index) => makeRow(index))
      return { ok: true, status: 200, json: async () => ({ ok: true, rows, meta: {}, compatSeq: 0 }) }
    }
    throw new Error('unexpected op in test: ' + payload.op)
  }
  return { fetchImpl, calls }
}

/** 迷你 React：函数组件 + 真 hooks。返回 { tree, findElement, texts, click, change, settle }。 */
async function mountPanel(seed) {
  // 存一份原始全局：同一个进程里如果跑了别的测试文件（tests/index.js 那条
  // 目录入口），这里替换过的 setTimeout/fetch 不还回去会把它们一起带偏。
  const savedGlobals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    document: globalThis.document,
  }
  installTimerStubs()
  globalThis.document = globalThis.document || { body: { style: {} }, addEventListener() {}, removeEventListener() {} }
  const storage = createLocalStorage(seed)
  globalThis.localStorage = storage
  globalThis.sessionStorage = createLocalStorage()
  const { fetchImpl, calls } = createFetchStub()
  globalThis.fetch = fetchImpl

  const reactStub = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) {
      // 真 React 会把 children 放进 props；client.js 有些地方直接读 props.children。
      return { type, props: { ...(props || {}), children }, children }
    },
    useState: function (initial) {
      const slot = takeSlot('state')
      if (!slot.init) {
        slot.init = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setter = (next) => {
        // 不在渲染中就地改：真 React 会把更新攒到本轮结束再统一提交。
        slot.pending.push(next)
        schedule()
      }
      return [slot.value, setter]
    },
    useRef: function (initial) {
      const slot = takeSlot('ref')
      if (!slot.init) { slot.init = true; slot.value = { current: initial } }
      return slot.value
    },
    useMemo: function (fn, deps) {
      const slot = takeSlot('memo')
      if (!slot.init || !sameDeps(deps, slot.deps)) {
        slot.init = true
        slot.deps = deps ? [...deps] : null
        slot.value = fn()
      }
      return slot.value
    },
    // useCallback 必须真的按依赖缓存：loadCatalog 被 boot effect 当依赖用，
    // 每次渲染都返回新函数的话 effect 会无限重跑（真实 React 一样）。
    useCallback: function (fn, deps) {
      const slot = takeSlot('callback')
      if (!slot.init || !sameDeps(deps, slot.deps)) {
        slot.init = true
        slot.deps = deps ? [...deps] : null
        slot.value = fn
      }
      return slot.value
    },
    useDeferredValue: (value) => value,
    useSyncExternalStore: function (subscribe, getSnapshot) {
      const slot = takeSlot('external')
      if (!slot.init) { slot.init = true; slot.value = getSnapshot() }
      return slot.value
    },
    useId: () => 'id',
    useTransition: () => [false, (fn) => fn()],
    useEffect: function (fn, deps) {
      const slot = takeSlot('effect')
      if (!slot.init || !sameDeps(deps, slot.deps)) {
        slot.init = true
        slot.deps = deps ? [...deps] : null
        pending.push(fn)
      }
    },
    useLayoutEffect: function (fn, deps) {
      reactStub.useEffect(fn, deps)
    },
  }

  // 真 hooks 的最小可信实现。槽位必须**跨渲染帧**保留（按组件模板隔离），
  // 否则 useCallback / useEffect / useState 全都退化成「每次渲染都是新的」，
  // 那测出来的就不是面板的行为、而是 runner 自己的 bug。
  let hookStore = new Map()
  let currentHooks = null
  let pending = []
  let rendering = false
  let dirty = false
  const cleanups = []
  let guard = 0
  const hostNodes = new Map()

  const takeSlot = (kind) => {
    if (!currentHooks) throw new Error('hook called outside of a component render')
    if (currentHooks.idx === undefined) currentHooks.idx = 0
    const index = currentHooks.idx++
    if (!currentHooks.slots[index]) currentHooks.slots[index] = { kind, init: false, value: undefined, pending: [] }
    if (currentHooks.slots[index].kind !== kind) currentHooks.slots[index] = { kind, init: false, value: undefined, pending: [] }
    return currentHooks.slots[index]
  }

  const sameDeps = (a, b) => Boolean(a && b) && a.length === b.length && a.every((dep, index) => Object.is(dep, b[index]))

  // 展开一个函数组件：先切到它自己的 hook 存储，再执行、再还原。
  const renderComponent = (template, props = {}) => {
    const previous = currentHooks
    let state = hookStore.get(template)
    if (!state) { state = { slots: [], idx: 0 }; hookStore.set(template, state) }
    currentHooks = state
    try {
      return template(props)
    } finally {
      currentHooks = previous
    }
  }

  function flushPendingStates() {
    for (const state of hookStore.values()) {
      for (const slot of state.slots) {
        if (!slot || slot.kind !== 'state' || slot.pending.length === 0) continue
        for (const next of slot.pending) {
          const value = typeof next === 'function' ? next(slot.value) : next
          // React 对同一个引用不做重渲染；不照做的话 runner 会把真代码里的
          // 「每轮都 setState 一个新对象」放大成死循环。
          if (Object.is(value, slot.value)) continue
          slot.value = value
          trace.push(stackSite())
          if (trace.length > 400) trace.shift()
        }
        slot.pending.length = 0
      }
    }
  }

  // React 会把 effect / 事件里的 setState 合并到下一轮，不会在渲染中同步递归。
  const schedule = () => {
    if (rendering) { dirty = true; return }
    render()
  }

  const registered = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(definition) { registered.push(definition) } } }
  try {
    await import(CLIENT_URL + '?persist=' + Math.random())
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  const definition = registered[0]
  const module = definition.factory((name) => {
    if (name === 'react') return reactStub
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error('unexpected module: ' + name)
  })
  const slots = []
  module.apply({
    effect(run) { run() },
    get() { return null },
    slots: {
      inject(name, run) { run() },
      register(spec, component) { slots.push({ spec, component }); return () => {} },
    },
  })
  const main = slots.find((entry) => entry.spec.name === 'main')
  assert.ok(main, 'main slot should be registered')

  let tree = null
  const trace = []

  // setState 调用点采样。只在撞到安全阀时打印一次——正常路径上这是纯开销，
  // 但真出循环时没有它就完全不知道是谁在反复触发（这一轮调试就吃过这个亏）。
  function stackSite() {
    const lines = String(new Error('setState').stack || '').split('\n').slice(2, 6)
    return lines.map((line) => line.trim().replace(/^at\s+/, '').replace(/^.*client\.js/, 'client.js')).join(' <- ')
  }

  function traceTop(limit = 6) {
    const counts = new Map()
    for (const site of trace) counts.set(site, (counts.get(site) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([site, count]) => count + '× ' + site).join('\n  ')
  }

  function render() {
    if (rendering) { dirty = true; return }
    rendering = true
    guard += 1
    // 只是防死循环的安全阀：正常路径上每轮 settle 只会有个位数次渲染。
    if (guard > 20000) {
      rendering = false
      throw new Error('render loop: 面板在挂载后被反复重渲染\n  setState 调用点：\n  ' + traceTop())
    }
    try {
      // 上一轮攒下的 state 更新在这里统一提交（真 React 也是这个时机）。
      flushPendingStates()
      let queued = []
      let round = 0
      do {
        round += 1
        dirty = false
        pending = []
        // 每个组件模板的 hook 下标在新一帧从头开始；槽位本身跨帧保留。
        for (const state of hookStore.values()) state.idx = 0
        tree = renderComponent(main.component)
        // 真 React 在提交阶段就把 ref 挂到 DOM 节点上，effect 之后才跑。
        // 这里补一次同样的绑定，否则「进面板就滚回去」这类 effect 看到的 ref 永远是 null。
        collect(tree, { texts: [], elements: [] })
        queued = pending
        pending = []
        for (const fn of queued) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
        if (round > 30) {
          throw new Error('render loop: 同一轮里 effect 反复触发 setState（第 ' + round + ' 轮）')
        }
      } while (dirty)
    } finally {
      rendering = false
    }
  }

  function collect(node, sink) {
    if (node === null || node === undefined || node === false || node === true) return sink
    if (Array.isArray(node)) {
      for (const child of node) collect(child, sink)
      return sink
    }
    if (typeof node === 'string' || typeof node === 'number') {
      sink.texts.push(String(node))
      return sink
    }
    if (typeof node !== 'object') return sink
    if (typeof node.type === 'function') {
      // 这里其实是在「执行另一个组件」。每个组件模板有自己的 hook 存储，
      // 而且它自己的 setState 只标自己那一帧的脏——不隔离的话子组件会按
      // 当前下标写进 PanelPage 的槽位，hook 顺序当场错位、effect 疯狂重跑。
      const outer = { hooks: currentHooks, pending, dirty }
      currentHooks = null
      pending = []
      dirty = false
      let output
      try {
        output = renderComponent(node.type, { ...node.props, children: node.children })
      } finally {
        currentHooks = outer.hooks
        pending = outer.pending
        // 子组件自己的 setState 不该把「父组件这一轮需要重渲染」标记上：
        // 本 runner 是按需展开的，子组件的状态更新由它自己下一次展开负责。
        dirty = outer.dirty
      }
      collect(output, sink)
      return sink
    }
    sink.elements.push(node)
    // 真 DOM 节点跨帧复用、scrollTop 这类可变属性会留着；runner 每次展开都会造
    // 新对象，所以按 class 复用一份，否则「重进后滚回原位」永远只能看到 undefined。
    const domKey = typeof node.type === 'string' ? node.type + '|' + (node.props && node.props.className || '') : null
    let host = domKey ? hostNodes.get(domKey) : null
    if (domKey && !host) { host = node; hostNodes.set(domKey, host) }
    if (host && host !== node) {
      if (node.props) node.props.ref = host.props.ref
      if (typeof host.scrollTop === 'number') node.scrollTop = host.scrollTop
    }
    if (node.props && node.props.ref && typeof node.props.ref === 'object') node.props.ref.current = host || node
    const children = (node.props && node.props.children) || node.children
    if (Array.isArray(children)) {
      for (const child of children) collect(child, sink)
    } else if (children !== undefined) {
      collect(children, sink)
    }
    return sink
  }

  const walk = () => {
    const sink = { texts: [], elements: [] }
    collect(tree, sink)
    return sink
  }

  async function settle(times = 40) {
    guard = 0
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      render()
    }
    return walk()
  }

  render()

  return {
    storage,
    calls,
    render,
    walk,
    settle,
    texts: () => walk().texts.join(' '),
    findElement: (predicate) => walk().elements.find(predicate) || null,
    click: (predicate) => {
      const element = walk().elements.find(predicate)
      assert.ok(element, 'click target not found')
      assert.ok(typeof element.props.onClick === 'function', 'element has no onClick')
      element.props.onClick({ preventDefault() {}, stopPropagation() {}, currentTarget: element })
      render()
    },
    change: (predicate, value) => {
      const element = walk().elements.find(predicate)
      assert.ok(element, 'change target not found')
      assert.ok(typeof element.props.onChange === 'function', 'element has no onChange')
      element.props.onChange({ target: { value } })
      render()
    },
    pageState: () => JSON.parse(storage.getItem(PAGE_STORE) || 'null'),
    cleanup: () => {
      for (const fn of cleanups) fn()
      for (const [key, value] of Object.entries(savedGlobals)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

const buttonWithLabel = (label) => (element) => element.type === 'button' && String((element.props.children || []).join('')) === label
const SEED_THIRD_PAGE = { version: 1, view: 'table', page: 3, pageSize: 50, search: '', sort: { key: 'heat', dir: 'desc' }, scrollTop: 0 }

test('回到面板时停在原来那一页（翻到最后一页再回来不该被打回第 1 页）', async () => {
  const app = await mountPanel({ [PAGE_STORE]: JSON.stringify(SEED_THIRD_PAGE) })
  const snapshot = await app.settle()
  const text = snapshot.texts.join(' ')
  // 120 行、每页 50 行 = 3 页；上一次退出前停在第 3 页。
  assert.match(text, /第 3 \/ 3/, '应停在原来那一页，实际文案: ' + (text.match(/第 \d+ \/ \d+/)?.[0] || '(没有分页文案)'))
  // 首次挂载绝不该把页码写回 1——那是「翻到第十页、切走再回来又从头翻」的根因。
  assert.equal(app.pageState().page, 3)
  app.cleanup()
})

test('翻页 / 改每页条数都会持久化', async () => {
  const app = await mountPanel({ [PAGE_STORE]: JSON.stringify({ ...SEED_THIRD_PAGE, page: 1 }) })
  await app.settle()
  app.click(buttonWithLabel('›'))
  assert.equal(app.pageState().page, 2, '点下一页要把新页码记下来')
  app.cleanup()
})

test('改搜索词仍然回第 1 页，并把搜索词一起记住', async () => {
  const app = await mountPanel({ [PAGE_STORE]: JSON.stringify(SEED_THIRD_PAGE) })
  await app.settle()
  assert.equal(app.pageState().page, 3, '挂载本身不该改页码')
  app.change((element) => element.type === 'input' && element.props.value === '' && typeof element.props.onChange === 'function', 'pkg-12')
  assert.equal(app.pageState().page, 1, '搜索条件变了必须回第 1 页')
  assert.equal(app.pageState().search, 'pkg-12')
  app.cleanup()
})

test('滚动位置会被记住，重进时恢复', async () => {
  const app = await mountPanel({ [PAGE_STORE]: JSON.stringify(SEED_THIRD_PAGE) })
  await app.settle()
  const scroller = app.findElement((element) => element.props && element.props.className === 'ml-table-scroll')
  assert.ok(scroller, '表格滚动容器应存在')
  assert.equal(typeof scroller.props.onScroll, 'function', '滚动容器要挂 onScroll')
  scroller.props.ref.current = scroller
  scroller.scrollTop = 640
  scroller.props.onScroll()
  assert.equal(app.pageState().scrollTop, 640)

  // 重新进面板：新实例应该把 scrollTop 恢复到 640
  const again = await mountPanel({ [PAGE_STORE]: JSON.stringify(app.pageState()) })
  const snapshotAgain = await again.settle()
  assert.match(snapshotAgain.texts.join(' '), /第 3 \/ 3/, '重进后应还在原来那一页')
  const scrollerAgain = again.findElement((element) => element.props && element.props.className === 'ml-table-scroll')
  // 真 DOM 里 ref.current 就是这个容器本身；runner 每次展开都会生成新的节点对象，
  // 所以按面板自己看到的那份来断言。
  assert.equal(scrollerAgain.props.ref.current.scrollTop, 640, '重进面板应恢复到原来的滚动位置')
  again.cleanup()
  app.cleanup()
})

test('快照坏掉时退回默认值，面板照样能开', async () => {
  for (const broken of ['not json at all', JSON.stringify({ version: 1, view: 'nope', page: -3, pageSize: 999, sort: { key: 'gone-key', dir: 'sideways' }, scrollTop: -5 })]) {
    const app = await mountPanel({ [PAGE_STORE]: broken })
    const text = (await app.settle()).texts.join(' ')
    assert.match(text, /第 1 \/ \d+/, '坏快照应回到第 1 页')
    assert.equal(app.pageState().pageSize, 100, '非法的每页条数应退回默认 100')
    app.cleanup()
  }
})
