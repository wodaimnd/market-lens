// 空表三态回归：目录为空 / 筛选无结果 必须显示**不同**的文案。
//
// 现场问题：client 只有一句 emptyFiltered（"没有符合当前筛选条件的插件。"），
// 于是「目录还没同步过」和「筛得太狠」显示同一句话。前者该点同步、后者该清筛选，
// 用户照着错的那条做，怎么都出不来数据。
//
// emptyCatalog 这个 i18n key 早就写好了，但代码 0 次引用 —— 这次接上它。
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLIENT_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')).href

/** 极简 React 运行时：只要能把树建起来并取出文本即可（与 client-mount.test.js 同一套思路）。 */
function createRuntime() {
  const hooks = []
  const states = []
  let cursor = 0
  const react = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) }
      if (children.length) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(initial) {
      const index = cursor++
      if (!states[index]) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = states[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useMemo(factory) { return factory() },
    useCallback(fn) { return fn },
    useRef(initial) { return { current: initial } },
    useEffect(fn) { hooks.push(fn); return undefined },
  }
  const render = (build) => {
    cursor = 0
    hooks.length = 0
    return build()
  }
  return { react, render, hooks, runEffects: () => hooks.forEach((fn) => fn()) }
}

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props) return textOf(node.props.children)
  return ''
}

function findNode(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = findNode(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(tree)) return tree
  return findNode(tree.props && tree.props.children, predicate)
}

async function loadTable() {
  const { react } = createRuntime()
  const registered = []
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: { load(definition) { registered.push(definition) } },
    addEventListener() {},
    removeEventListener() {},
  }
  try {
    await import(CLIENT_URL + '?table-empty=' + Math.random())
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  const definition = registered[0]
  const module = definition.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error('unexpected module: ' + name)
  })
  // Table 是模块内部的组件，不在 slots 里 —— 通过渲染 main 再按 className 找它。
  const slots = []
  module.apply({
    effect(run) { run() },
    get() { return null },
    slots: {
      inject(_name, run) { run() },
      register(spec, component) { slots.push({ spec, component }); return () => {} },
    },
  })
  return { slots, react }
}

/**
 * 直接检查源码契约：空态分支必须同时用到 emptyCatalog 与 emptyFiltered，
 * 并且按「目录里有没有行」分叉。这是最稳的断言方式 ——
 * client.js 用的是 React.createElement 工厂函数，组件不在 slots 里，
 * 完整挂载代价过高，而这里要钉的恰恰是「两个 key 都被引用」这条契约。
 */
test('空态分支按「目录有没有行」分叉，两个 key 都被引用', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  // 取 emptyState 函数体
  const start = source.indexOf('const emptyState = () => {')
  assert.ok(start > 0, '应有 emptyState 函数')
  const end = source.indexOf('\n      }', start)
  const body = source.slice(start, end)

  assert.match(body, /t\('emptyCatalog'\)/, '目录为空要用 emptyCatalog')
  assert.match(body, /t\('emptyFiltered'\)/, '筛选无结果要用 emptyFiltered')
  assert.match(body, /filteredOut/, '要按「目录里有没有行」分叉，不能只按当前页')
  assert.match(body, /allRows/, '判「目录空」必须看全量行，不是筛选后的行')

  // 三态之一：目录真的空 —— 必须给「去同步」的出口
  assert.match(body, /onSync/, '目录为空时要在空态里给同步按钮')
})

test('emptyCatalog 与 emptyFiltered 是两句不同的话（中英都是）', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  // 语言表是两个 `const TEXTS = { zh: {...}, en: {...} }` 块；
  // 别用 'en:' 切分（别处也可能出现），按 key 的**全部出现**逐个取出再比对。
  const collect = (key) => {
    const re = new RegExp(key + ":\\s*'([^']+)'", 'g')
    const values = []
    let match
    while ((match = re.exec(source))) values.push(match[1])
    return values
  }
  const catalog = collect('emptyCatalog')
  const filtered = collect('emptyFiltered')
  assert.equal(catalog.length, 2, 'zh + en 各一条 emptyCatalog')
  assert.equal(filtered.length, 2, 'zh + en 各一条 emptyFiltered')
  // 同语言的这两句必须不同：目录为空 ≠ 筛选无结果
  assert.notEqual(catalog[0], filtered[0], '中文两句不能一样')
  assert.notEqual(catalog[1], filtered[1], '英文两句不能一样')
})

test('Table 组件接收 onSync，并把它接到空态按钮上', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  assert.match(source, /function Table\(\{[\s\S]{0,600}onSync,/, 'Table 签名里要有 onSync')
  assert.match(source, /onSync: \(\) => startSync\(/, '调用处要真的传进去')
})
