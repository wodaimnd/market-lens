/**
 * activation.js —— installed ≠ activated。
 *
 * 这是「装上了但不出现」的最后一块拼图。
 *
 * market-lens 原来只能证明三件事：
 *   1. 依赖写进了 profile 的 dependencies
 *   2. 包进了 dsh.profile.bundles（挂载）
 *   3. 包自带 cordis.patch.yml 的装载行能解析
 *
 * 但这三件事全对，插件仍然可能**根本没跑起来**：Cordis 给每个入口建一个
 * Fiber，`pending / loading / active / failed` 是它的真实状态。只有 `active`
 * 才算"真的挂上了"。`failed` 时 dsh 自己的日志里也不一定有一行能看懂的报错。
 *
 * 判定口径照抄宿主 `dsh-host-plugin-inventory/lib/index.js` 的 FIBER_PHASE：
 *   FiberState: PENDING 0 / LOADING 1 / ACTIVE 2 / FAILED 3 / DISPOSED 4 / UNLOADING 5
 *   phase:      pending / loading / active / failed / null(DISPOSED) / unloading
 *
 * 为什么不在 market-lens 里重复实现 Fiber：我们读的是**已经建好的**入口状态，
 * 不参与它的生命周期。拿 `ctx.loader.entries()` 逐个读 `entry.fiber.state` 即可，
 * 不需要注入 `pluginInventory`（那个 remote service 的注入时机不可靠）。
 */

/** 与宿主 FIBER_STATE 对齐的数字枚举。收到未知值时按 unknown 处理，绝不瞎猜。 */
export const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
}

export const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
}

/**
 * 把 state 归一成 phase。
 * @param {unknown} state 数字或字符串形态都接受（不同运行时给的不一样）
 * @returns {string|null} phase；无法识别时返回 'unknown'
 */
export function phaseOfState(state) {
  if (typeof state === 'string') {
    const lowered = state.toLowerCase()
    if (['pending', 'loading', 'active', 'failed', 'unloading'].includes(lowered)) return lowered
    if (lowered === 'disposed') return null
    return 'unknown'
  }
  if (typeof state === 'number' && Number.isInteger(state)) {
    return Object.hasOwn(FIBER_PHASE, state) ? FIBER_PHASE[state] : 'unknown'
  }
  return 'unknown'
}

/**
 * 从 loader entries 里收集每个模块的激活状态。
 *
 * 输入形状（宿主就是这么读的）：
 *   for (const entry of ctx.loader.entries()) {
 *     const name = entry.options.name
 *     const fiber = entry.fiber
 *     const phase = FIBER_PHASE[fiber.state]
 *   }
 *
 * @param {Iterable<object>} entries ctx.loader.entries() 的结果
 * @returns {Map<string, {phase: string|null, entryId: string|null, disabled: boolean}>}
 */
export function collectActivation(entries) {
  const map = new Map()
  if (!entries) return map
  let list
  try {
    list = Array.from(entries)
  } catch {
    return map
  }
  for (const entry of list) {
    const options = entry && typeof entry === 'object' ? entry.options : null
    const name = options && typeof options.name === 'string' ? options.name : null
    if (!name) continue
    // group 行不是真正的插件入口，宿主自己也跳过它们
    if (options.group) continue
    const fiber = entry.fiber && typeof entry.fiber === 'object' ? entry.fiber : null
    const phase = fiber ? phaseOfState(fiber.state) : null
    const record = {
      phase,
      entryId: typeof entry.id === 'string' ? entry.id : null,
      disabled: Boolean(entry.disabled),
    }
    // 同名入口可能出现多次（不同 fiber）：只保留"最值得关注"的那一条 ——
    // failed > loading > pending > active > null。这样用户看到的是最严重的那一态。
    const previous = map.get(name)
    if (!previous || severityOf(record.phase) > severityOf(previous.phase)) map.set(name, record)
  }
  return map
}

/** 越高越值得关注。用于同名入口去重。 */
function severityOf(phase) {
  switch (phase) {
    case 'failed': return 5
    case 'loading': return 4
    case 'pending': return 3
    case 'unloading': return 2
    case 'active': return 1
    case null: return 0
    default: return 3 // unknown 也值得看一眼
  }
}

/**
 * 一个包的激活结论。
 *
 * @param {string|null} packageName 包名
 * @param {Map<string, object>} activation collectActivation 的结果
 * @param {string|null} [fallbackModuleName] 目录里没有同名的入口时用它兜底
 * @returns {{available: boolean, phase: string|null, moduleName: string|null, entryId: string|null, disabled: boolean}}
 */
export function activationOf(packageName, activation, fallbackModuleName = null) {
  const name = typeof packageName === 'string' && packageName ? packageName : null
  if (!activation || !activation.size) {
    // loader 还没起来（比如自检时没有真实 ctx.loader）：不可知，不要下结论
    return { available: false, phase: null, moduleName: null, entryId: null, disabled: false }
  }
  // 1) 直接用包名找（bundles 里那一层通常就叫包名）
  if (name && activation.has(name)) {
    const record = activation.get(name)
    return { available: true, phase: record.phase, moduleName: name, entryId: record.entryId, disabled: record.disabled }
  }
  // 2) 退回 fallback（有些插件把 bundle 名和入口名写成两个不同的东西）
  if (fallbackModuleName && activation.has(fallbackModuleName)) {
    const record = activation.get(fallbackModuleName)
    return { available: true, phase: record.phase, moduleName: fallbackModuleName, entryId: record.entryId, disabled: record.disabled }
  }
  // 3) 没有匹配入口：插件可能只是没被 loader 建 entry（未启用 / 不在 bundles）
  return { available: false, phase: null, moduleName: null, entryId: null, disabled: false }
}

/**
 * 把一个包的「静态结论」和「运行时激活」合成一句话。
 *
 * @param {object} input
 * @param {string} input.staticVerdict inspectInstalledHealth 给的 ok/warn/bad/skipped
 * @param {object} input.activation activationOf 的结果
 * @param {boolean} input.mounted 是否在 bundles 里
 * @returns {{verdict: string, activation: object, detail: string|null}}
 */
export function mergeActivation({ staticVerdict, activation, mounted }) {
  const phase = activation && activation.available ? activation.phase : null

  // 静态层已经判死，不必再看运行时 —— 那只会让结论更乱。
  if (staticVerdict === 'bad') {
    return { verdict: 'bad', activation, detail: null }
  }

  // 没挂载：运行时当然也不会 active。保持原判定（warn）。
  if (!mounted) {
    return { verdict: staticVerdict, activation, detail: null }
  }

  if (!activation || !activation.available) {
    // loader 没起来 / 找不到入口：不能说"没激活"，只能说"不可知"
    return { verdict: staticVerdict, activation, detail: null }
  }

  if (activation.disabled) {
    return {
      verdict: 'installed-disabled',
      activation,
      detail: '插件已被禁用（entry.disabled）：文件在、也挂载了，但不会运行',
    }
  }

  if (phase === 'failed') {
    return {
      verdict: 'installed-not-active',
      activation,
      detail: '挂载正确，但 Cordis Fiber 进入了 failed —— 插件会「装上但不出现」',
    }
  }

  if (phase === 'pending' || phase === 'loading') {
    return {
      verdict: 'installed-not-active',
      activation,
      detail: '挂载正确，但 Fiber 仍是 ' + phase + '：还没进入运行态',
    }
  }

  if (phase === 'unloading') {
    return { verdict: 'installed-not-active', activation, detail: 'Fiber 正在卸载：下次启动会重新加载' }
  }

  if (phase === 'active') {
    // 三层全通 + 真的跑起来了
    return { verdict: staticVerdict === 'ok' ? 'activated' : staticVerdict, activation, detail: null }
  }

  // phase === null（DISPOSED）或 unknown：别下结论
  return { verdict: staticVerdict, activation, detail: null }
}
