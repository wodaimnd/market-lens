/**
 * 安装反馈的渲染期契约。
 *
 * 真实事故：行内「装」按钮点下去失败，错误被写进通用的 error，
 * 而下一次 status 轮询会 `setError(null)` 把它抹掉 —— 用户只看到「点了没反应」。
 * 这里用一个能真正跑 state 与 effect 的迷你 hook 运行时挂载面板，
 * 点一次行内安装按钮（Host 返回 500）后断言：
 *   1. 页面上出现「安装失败」和 pnpm 原文；
 *   2. 之后触发一次目录刷新（会 setError(null)）也抹不掉这条回执。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 允许用 MARKET_LENS_CLIENT 指向一份变异副本，用来确认这些断言真的有牙。
const CLIENT_URL = pathToFileURL(
  process.env.MARKET_LENS_CLIENT
    ? path.resolve(process.env.MARKET_LENS_CLIENT)
    : fileURLToPath(new URL('../client.js', import.meta.url)),
).href

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

  // 只展开一次：函数组件在渲染期就被调用掉，返回的树里只剩宿主节点，
  // 这样后续 findNode/textOf 遍历时不会二次调用组件（二次调用会打乱 hook 下标）。
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
    for (let index = 0; index < 16; index += 1) {
      // 让 fetch/await 链推进；setImmediate 与面板自己用的 setTimeout 互不干扰。
      await new Promise((resolve) => setImmediate(resolve))
    }
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

/** 在已展开的宿主节点树里按条件找第一个节点。 */
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

function makeFetch(log, options = {}) {
  const installMode = options.install || 'fail'
  const rows = options.rows || [ROW]
  return async (_url, init) => {
    const payload = JSON.parse(init.body)
    log.push(payload.op)
    const ok = (body) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) })
    const fail = (status, body) => ({ ok: false, status, json: async () => ({ ok: false, ...body }) })
    if (payload.op === 'status') {
      return ok({
        rows: { total: rows.length },
        counts: { total: rows.length, installed: 0 },
        cache: { exists: true, generatedAt: '2026-11-01T00:00:00.000Z', rows: rows.length },
        sync: { phase: 'idle', running: false },
        settings: { safeView: false, refreshIntervalMinutes: 0 },
        diff: { baselined: true },
        updates: { running: false, available: 0 },
        installed: { count: options.packages ? options.packages.length : 1, fingerprint: 'fp-1', packages: options.packages || [] },
        install: { available: true, busy: false },
        sourceConfig: { sources: [] },
        compat: { total: 0, pending: 0, running: false },
      })
    }
    if (payload.op === 'catalog') {
      return ok({ rows, meta: { diff: { baselined: true }, counts: { total: rows.length } }, sourceConfig: { sources: [] } })
    }
    if (payload.op === 'detail') {
      return ok({ row: { ...rows.find((row) => row.id === payload.id), compatFull: null } })
    }
    if (payload.op === 'install') {
      if (installMode === 'ok') {
        return ok({
          spec: '@acme/tool@1.2.3',
          installed: { count: 2, fingerprint: 'fp-2' },
          result: { name: '@acme/tool', version: '1.2.3' },
        })
      }
      // 失败响应现在带**分层结论**（layer / action / evidence / retryable），
      // 前端不认旧的自造码，只按这几个字段渲染。
      return fail(500, {
        error: 'ERR_PNPM_NO_MATCHING_VERSION No matching version found for @acme/tool@1.2.3',
        spec: '@acme/tool@1.2.3',
        code: 'ERR_PNPM_NO_MATCHING_VERSION',
        layer: 'version',
        action: 'fallback',
        retryable: true,
        evidence: 'ERR_PNPM_NO_MATCHING_VERSION No matching version found for @acme/tool@1.2.3',
      })
    }
    if (payload.op === 'upgrade') {
      if ((options.upgrade || installMode) === 'ok') {
        return ok({
          spec: payload.pkg + '@' + payload.version,
          installed: { count: 2, fingerprint: 'fp-3' },
          result: { name: payload.pkg, version: payload.version },
        })
      }
      return fail(500, { error: 'ERR_PNPM_NO_MATCHING_VERSION nope', spec: payload.pkg + '@' + payload.version })
    }
    if (payload.op === 'sync') return ok({ sync: { running: true } })
    return ok({})
  }
}

async function mountPanel(options = {}) {
  const { react, render } = createRuntime()
  const registered = []
  const ops = []
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  const previousSetInterval = globalThis.setInterval
  // window 要活到测试结束：详情抽屉会在 effect 里挂 keydown 监听。
  globalThis.window = {
    __ModuleLoader__: { load(definition) { registered.push(definition) } },
    addEventListener() {},
    removeEventListener() {},
  }
  // 面板自带 20s/3s/1.5s 轮询，测试里只需要第一次拉取。
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  // 回执 8 秒自动收起、复制按钮 1.6 秒复位：测试里不排这些定时器，免得进程空转。
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  globalThis.fetch = makeFetch(ops, options)
  let definition
  try {
    await import(CLIENT_URL + '?install-notice=' + Math.random())
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

test('行内安装失败时把错误留在页面上，且轮询的 setError(null) 抹不掉', async () => {
  const panel = await mountPanel()
  try {
    let tree = await panel.render()
    // 第一次拉取应该发生过 status + catalog
    assert.ok(panel.ops.includes('catalog'), '面板应主动拉目录')

    const button = findNode(tree, (node) => node.type === 'button' && /^(装|Get)$/.test(textOf(node).trim()))
    assert.ok(button, '表格里应有行内安装按钮')
    await button.props.onClick({ stopPropagation() {} })

    tree = await panel.render()
    const text = textOf(tree)
    // 回执标题现在带层次：「安装失败 · 版本解析层」，不再是笼统的一句"安装失败"。
    // 用户第一眼要知道是哪一段坏了 —— 这是 txt 见解里最核心的一条。
    assert.match(text, /安装失败|Install failed/)
    assert.match(text, /版本解析层|version resolution/, '标题要说明是哪一层：' + text.slice(0, 300))
    assert.match(text, /ERR_PNPM_NO_MATCHING_VERSION/)
    assert.match(text, /@acme\/tool@1\.2\.3/)

    // 触发一次刷新：Host 侧 status 会成功，面板内部 setError(null) 会清掉通用 error。
    const resync = findNode(tree, (node) => node.type === 'button' && /重新同步|Resync/.test(textOf(node)))
    if (resync) await resync.props.onClick()
    const after = textOf(await panel.render())
    assert.match(after, /安装失败|Install failed/, '安装回执不应被轮询清空')
  } finally {
    panel.restore()
  }
})

test('安装成功后给出回执，并把该行标成已安装', async () => {
  const panel = await mountPanel({ install: 'ok' })
  try {
    let tree = await panel.render()
    const button = findNode(tree, (node) => node.type === 'button' && /^(装|Get)$/.test(textOf(node).trim()))
    assert.ok(button, '表格里应有行内安装按钮')
    await button.props.onClick({ stopPropagation() {} })

    tree = await panel.render()
    const text = textOf(tree)
    assert.match(text, /安装完成|Installed/)
    // 状态直接长在按钮上（用户要的就是「不用另开状态栏」）：
    // 装完这一格从「装」变成「✓ 已装」，所以按这个文案找按钮。
    const done = findNode(tree, (node) => node.type === 'button' && /^✓\s*(已装|Installed)$/.test(textOf(node).trim()))
    assert.ok(done, '装完之后行内按钮应变成 ✓ 已装')
  } finally {
    panel.restore()
  }
})

test('算不出安装目标的条目给「去官方插件页安装」，并打开两步指引', async () => {
  const manualRow = {
    ...ROW,
    id: 'gh:acme/thing',
    name: 'acme/thing',
    title: 'acme/thing',
    pkg: null,
    installable: false,
    installCommand: 'dsh plugin add github:acme/thing',
  }
  const panel = await mountPanel({ rows: [manualRow] })
  try {
    let tree = await panel.render()
    const rowNode = findNode(tree, (node) => node.props && node.props.className === 'ml-row')
    assert.ok(rowNode, '表格应渲染出这一行')
    await rowNode.props.onClick()
    tree = await panel.render()

    const manualButton = findNode(tree, (node) => node.type === 'button' && /去官方插件页安装|Install from the official page/.test(textOf(node)))
    assert.ok(manualButton, '详情里应给手动安装入口')
    await manualButton.props.onClick()
    tree = await panel.render()

    const text = textOf(tree)
    assert.match(text, /官方插件页|official page/)
    assert.match(text, /github:acme\/thing/)
  } finally {
    panel.restore()
  }
})

test('已装且有新版的行，按钮直接变成「更新 ↑ 版本」并走 upgrade', async () => {
  const row = { ...ROW, installed: true, installedVersion: '1.2.3', update: { available: true, from: '1.2.3', to: '2.0.0', kind: 'major' } }
  const panel = await mountPanel({ rows: [row], upgrade: 'ok' })
  try {
    let tree = await panel.render()
    const text = textOf(tree)
    // 安装状态只有一个出处：按钮本身。既不该再有独立的状态列文字，也不该还写着「装」。
    assert.match(text, /更新 ↑ 2\.0\.0/, '有新版时按钮应直接给出目标版本')
    const button = findNode(tree, (node) => node.type === 'button' && /更新 ↑ 2\.0\.0/.test(textOf(node)))
    assert.ok(button, '应能找到更新按钮')
    await button.props.onClick({ stopPropagation() {} })

    assert.ok(panel.ops.includes('upgrade'), '点更新要发 upgrade，而不是再装一次')
    tree = await panel.render()
    assert.match(textOf(tree), /升级完成|Update installed|安装完成|Installed/)
  } finally {
    panel.restore()
  }
})

test('已安装页每行给真更新按钮，本地包不给假入口', async () => {
  const packages = [
    { pkg: 'alpha-pkg', version: '1.0.0', kind: 'npm', registry: true, update: { available: true, from: '1.0.0', to: '2.0.0', kind: 'major' } },
    { pkg: 'beta-pkg', version: '3.0.0', kind: 'npm', registry: true, update: null },
    { pkg: '@local/mine', version: '0.0.1', kind: 'local', registry: false, update: null },
  ]
  const panel = await mountPanel({ packages, upgrade: 'ok' })
  try {
    let tree = await panel.render()
    const tab = findNode(tree, (node) => node.type === 'button' && /已安装|Installed/.test(textOf(node)) && node.props?.onClick)
    assert.ok(tab, '应能找到已安装页签')
    await tab.props.onClick()
    tree = await panel.render()
    const text = textOf(tree)

    assert.match(text, /alpha-pkg/, '已装清单要看得到包名')
    assert.ok(findNode(tree, (node) => node.type === 'button' && textOf(node).trim() === '更新'), '有新版的行要有「更新」按钮')
    assert.ok(findNode(tree, (node) => /本地安装，没有 registry 版本|Local install/.test(textOf(node))), '本地包要说清没有 registry 版本，而不是给个点了必失败的按钮')

    const upgradeButton = findNode(tree, (node) => node.type === 'button' && node.props?.onClick && textOf(node).trim() === '更新')
    await upgradeButton.props.onClick()
    assert.ok(panel.ops.includes('upgrade'), '已安装页的更新按钮要走 upgrade')
  } finally {
    panel.restore()
  }
})

test('五个页签都能打开，不缺 key 也不抛错', async () => {
  const packages = [{ pkg: 'alpha-pkg', version: '1.0.0', kind: 'npm', registry: true, update: null }]
  const panel = await mountPanel({ packages })
  try {
    let tree = await panel.render()
    const tabs = ['市场', '已安装', '自定义安装', '来源', '设置']
    for (const name of tabs) {
      const tab = findNode(tree, (node) => node.type === 'button' && node.props?.onClick && textOf(node).trim() === name)
      if (!tab) continue
      await tab.props.onClick()
      tree = await panel.render()
      const text = textOf(tree)
      // t() 缺 key 时会把 key 原样吐出来；出现这些字样说明 i18n 漏了。
      assert.doesNotMatch(text, /undefined|null|NaN|\[object Object\]/, '页签 ' + name + ' 渲染出占位垃圾：' + text.slice(0, 200))
    }
  } finally {
    panel.restore()
  }
})
