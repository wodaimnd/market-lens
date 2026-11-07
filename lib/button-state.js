/**
 * button-state.js —— 行内「安装 / 更新」按钮的唯一状态来源。
 *
 * 为什么要有这一层：状态以前散在三个地方 --
 *   · client 的 `actionStateOf()`（只看 installed + update）
 *   · client 按钮分支里的 `done && update` / `done` / failed
 *   · client 的 `installedUpToDate` i18n key（**定义了但 0 次引用**）
 * 三者口径各不相同，于是同一行可能同时表现为「✓ 已装」和「已是最新」，
 * 或者「更新」按钮点了却只是重装同一个版本。
 *
 * 现在改成 Host 算一份 `buttonState` 下发，client 只负责渲染。
 * 这样「装 / 更新 / 已是最新 / 已装（本地）/ 重试 / 复制命令」这六种语义
 * 只有一处实现，测试也只钉一处。
 *
 * 六个状态：
 *   install         —— 未装，且折得出安装目标
 *   manual          —— 折不出安装目标（只能复制命令去官方页装）
 *   update          —— 已装且有新版（装到**正好**那个版本）
 *   current         —— 已装且已是最新（registry 包，无新版）
 *   installed-local —— 已装且是本地 / link / github 包（没有可比版本）
 *   retry           —— 上一次安装失败
 *
 * 注意 `current` 与 `installed-local` 的区别：
 * 前者「查过、确认没有新版」，后者「根本没法比」。混成一个会让
 * GitHub 装的包看起来像"已经是最新"，而其实从没查过。
 */

/** 前端可用的状态集合。改变它等于改契约，client 与测试都要跟。 */
export const BUTTON_STATES = ['install', 'manual', 'update', 'current', 'installed-local', 'retry']

/**
 * 算一行的按钮状态。
 *
 * @param {object} row 目录行（含 installed / installedVersion / pkg / repo / update / compat）
 * @param {object} [options]
 * @param {boolean} [options.failed] 这一行上一次安装是否失败
 * @param {(pkg: string, spec: string|null) => boolean} [options.isRegistry] 是否能在 registry 上比版本
 * @returns {'install'|'manual'|'update'|'current'|'installed-local'|'retry'}
 */
export function buttonStateOf(row, options = {}) {
  const { failed = false, isRegistry = defaultIsRegistry } = options
  if (!row) return 'manual'

  // 失败优先：按钮要立刻变「重试」，哪怕它同时也可更新。
  // 用户刚点过、刚失败，那颗按钮的心理预期就是"再点一次"。
  if (failed) return 'retry'

  const installed = Boolean(row.installed)
  const update = row.update && row.update.available && typeof row.update.to === 'string' ? row.update : null

  if (installed && update) return 'update'

  if (installed) {
    // 已装但没新版：区分「查过没有新版」与「没法比」。
    // registry 包（有 pkg 且 spec 不是 link:/github:/本地）才可能得出「已是最新」。
    if (typeof row.pkg === 'string' && row.pkg && isRegistry(row.pkg, row.installedSpec ?? null)) return 'current'
    return 'installed-local'
  }

  // 未装：能折出安装目标才给「装」。
  if (typeof row.pkg === 'string' && row.pkg) return 'install'
  if (typeof row.repo === 'string' && /^https?:\/\/github\.com\//i.test(row.repo)) return 'install'
  return 'manual'
}

/** 默认的 registry 判定，与 lib/updates.js 的 isRegistryCandidate 同口径（此处避免循环依赖而内联）。 */
function defaultIsRegistry(pkg, spec) {
  const name = typeof pkg === 'string' ? pkg.trim() : ''
  if (!name || name.startsWith('@local/')) return false
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (!text) return true
  return !/^(link|file|portal|workspace):/i.test(text)
    && !/^(git\+|git:|github:|https?:|\.{0,2}\/|[A-Za-z]:[\\/])/i.test(text)
    && !/\.(tgz|tar\.gz|zip)$/i.test(text)
}

/**
 * 把按钮状态翻译成「点一下会发生什么」。前端不需要自己推这个。
 *
 * mode 是 installRow 要用的动作：
 *   install  —— op:install，按目录版本（可能降级到 latest）
 *   upgrade  —— op:upgrade，装到**正好**那个版本（不降级）
 *   reinstall—— op:install，已装情况下重装同一目标（幂等）
 *   manual   —— 不装，打开手动指引
 *   retry    —— 重放上一次的动作（由前端记住上次 mode，这里只给 intent）
 */
export function actionOf(state, row) {
  switch (state) {
    case 'install':
      return { mode: 'install', op: 'install' }
    case 'update':
      return { mode: 'upgrade', op: 'upgrade', version: row?.update?.to ?? null }
    case 'current':
    case 'installed-local':
      // 已装且没有更新：点一下等于重装（幂等），不是升级。
      // 这就是原先被折叠丢失的 reinstall 语义。
      return { mode: 'reinstall', op: 'install' }
    case 'retry':
      return { mode: 'retry', op: row?.installed ? 'install' : 'install' }
    case 'manual':
    default:
      return { mode: 'manual', op: null }
  }
}

/**
 * 一次性算出整行的按钮信息（状态 + 动作 + 文案 key），供 publicRow 直接下发。
 * 文案 key 由 Host 给，client 只查表 —— 这样加状态不必改前端逻辑，
 * 只需补 i18n。
 */
export function buttonInfoFor(row, options = {}) {
  const state = buttonStateOf(row, options)
  const action = actionOf(state, row)
  return {
    state,
    mode: action.mode,
    op: action.op,
    version: action.version ?? null,
    labelKey: LABEL_KEYS[state] || LABEL_KEYS.manual,
    // 「点一下会发生什么」：悬停提示直接用这句
    titleKey: TITLE_KEYS[state] || TITLE_KEYS.manual,
  }
}

export const LABEL_KEYS = {
  install: 'actInstall',
  manual: 'actManual',
  update: 'actUpdate',
  current: 'installedUpToDate',
  'installed-local': 'actInstalled',
  retry: 'actRetry',
}

export const TITLE_KEYS = {
  install: 'actInstallHint',
  manual: 'actManualHint',
  update: 'actUpdateHint',
  current: 'actUpToDateHint',
  'installed-local': 'actInstalledLocalHint',
  retry: 'actRetryHint',
}
