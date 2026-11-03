// 渲染期契约：面板组件必须能在 stub hooks 下挂载。
// 这条保护的是一次真实事故——installBusyKey 的 useState 被放在用它的 useEffect 之后，
// useEffect 的依赖数组在渲染时求值，于是直接踩 TDZ：
//   ReferenceError: Cannot access 'installBusyKey' before initialization
//   slot entry crashed in 'main'
// 面板因此完全打不开，而 node --check 与「模块可加载」测试都发现不了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const CLIENT_URL = pathToFileURL(fileURLToPath(new URL('../client.js', import.meta.url))).href

const reactStub = {
  Fragment: Symbol('fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useDeferredValue: (value) => value,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useId: () => 'id',
  useTransition: () => [false, (fn) => fn()],
  useLayoutEffect: () => {},
}

// 递归展开元素树；遇到函数组件就直接调用，渲染期抛错会传上来。
function render(node, sink = []) {
  if (node === null || node === undefined || node === false) return sink
  if (Array.isArray(node)) {
    for (const child of node) render(child, sink)
    return sink
  }
  if (typeof node === 'string' || typeof node === 'number') {
    sink.push(String(node))
    return sink
  }
  if (typeof node !== 'object') return sink
  if (typeof node.type === 'function') {
    render(node.type({ ...node.props, children: node.children }), sink)
    return sink
  }
  for (const child of node.children || []) render(child, sink)
  return sink
}

async function loadClient() {
  const registered = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(definition) { registered.push(definition) } } }
  try {
    await import(CLIENT_URL + '?mount-smoke=' + Math.random())
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.equal(registered.length, 1, 'client.js 应调用一次 __ModuleLoader__.load')
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
  return slots
}

test('面板组件可以在 stub hooks 下挂载（防 TDZ / 渲染期抛错）', async () => {
  const slots = await loadClient()
  assert.deepEqual(slots.map((entry) => entry.spec.name).sort(), ['main', 'sidebar.panellist'])
  for (const entry of slots) {
    // 侧栏条目只出图标/无障碍标签，可能没有文本节点；关键是别抛错。
    const sink = render(entry.component({}))
    if (entry.spec.name === 'main') assert.ok(sink.length > 0, 'main 应渲染出内容')
  }
})

test('挂载后能看到工具栏与空态文案', async () => {
  const slots = await loadClient()
  const main = slots.find((entry) => entry.spec.name === 'main')
  const text = render(main.component({})).join(' ')
  // 工具栏按钮（中文文案）与空表的提示都应出现；按钮漏了说明渲染被提前中断。
  assert.match(text, /插件源/)
  assert.match(text, /列/)
})
