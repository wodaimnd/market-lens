// client.js 的加载契约：模块必须在没有 document / react-dom 的环境里也能装起来。
// 这条保护的是一次真实事故——弹层改用 portal 后，若 createPortal 不可用而没兜底，
// 整个面板会在 apply 阶段就抛错，用户看到的是空白页而没有任何报错入口。
import test from 'node:test'
import assert from 'node:assert/strict'

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
}

test('client 模块在没有 document / react-dom 时仍可加载并注册两个 slot', async () => {
  const registered = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        registered.push(definition)
      },
    },
  }
  try {
    await import('../client.js')
  } finally {
    delete globalThis.window
  }

  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.id, '@local/market-lens')
  assert.equal(typeof definition.factory, 'function')

  // 'react-dom' 故意不提供：factory 里的 try/catch 必须兜住，portal 退化成行内渲染。
  const requireStub = (name) => {
    if (name === 'react') return reactStub
    throw new Error('unexpected module: ' + name)
  }
  const module = definition.factory(requireStub)

  const slots = []
  const ctx = {
    effect(run) { run() },
    get() { return null },
    slots: {
      inject(name, run) { run() },
      register(spec, component) {
        slots.push({ spec, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)

  assert.deepEqual(slots.map((entry) => entry.spec.name).sort(), ['main', 'sidebar.panellist'])
  for (const entry of slots) assert.equal(typeof entry.component, 'function')
})
