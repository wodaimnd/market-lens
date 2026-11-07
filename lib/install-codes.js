/**
 * install-codes.js —— 把安装失败翻译成「哪一层 + 能不能重试 + 该点哪里」。
 *
 * 为什么要这一层：宿主 `pluginManager` 抛的失败**已经是精确的**——
 * `ManagementFailure` 带 `code` 与可选 `incompatible`（见 dsh-plugin-manager
 * 的 failure.js）。但 market-lens 原来只认 file-busy / subdir-missing /
 * build-approval-required 三类，其余八个码全部落进 `else → detail` 裸奔，
 * 用户看到的是一坨 pnpm 原文，不知道自己是版本问题还是权限问题。
 *
 * 这里的映射表有两个来源，都实测过：
 *   1. 宿主 `ManagementFailure` / `refused()` 的 code ——
 *      already-installed / ambiguous-install / bundle-in-use / incompatible-version /
 *      invalid-spec / management-required / not-bundle / not-removable /
 *      stale-approval / stop-profile / unknown-plugin
 *      （外加 refused 的 not-a-bundle / not-a-package）
 *   2. pnpm / OS 的原始码 ——
 *      ERR_PNPM_ADDING_TO_ROOT / ERR_PNPM_PEER_DEP_ISSUES / ERR_PNPM_IGNORED_BUILDS /
 *      ERR_PNPM_EPERM / EPERM / EBUSY / ERR_PNPM_NO_MATCHING_VERSION /
 *      ERR_PNPM_INVALID_PATH
 *
 * 关键取舍：**already-installed 不在这张表里当失败处理**。
 * 它的语义是「目标状态已达成」——宿主有两处抛它（HMR 下重装、预检拒绝），
 * 两处都意味着已经装好。把它报成失败，用户就会反复点安装。
 * 所以它由 classifyInstallFailure 单独判成 `outcome: 'already-present'`，
 * 调用方回 200 而不是 500。
 */

/** 失败的层次：决定界面上「哪一段坏了」，也决定文案语气。 */
export const FAILURE_LAYERS = {
  state: 'state', // 目标状态已经达成，不是失败
  resolve: 'resolve', // 目标解析不出来（spec 非法 / 命中多个包）
  version: 'version', // 版本在 registry 上不存在
  subdir: 'subdir', // GitHub 子目录不存在
  compat: 'compat', // 与当前 DSH 运行时不兼容
  declare: 'declare', // 包里没有 dsh.bundle 声明
  build: 'build', // 构建脚本被拦 / 批准过期
  workspace: 'workspace', // pnpm 把 profile 当 workspace root
  lock: 'lock', // Windows 文件占用
  permission: 'permission', // 宿主保护 / 不可移除
  activation: 'activation', // fiber 仍在跑，需要先禁用或重启
  inventory: 'inventory', // 清单里找不到这个条目
  unknown: 'unknown',
}

/**
 * 每个码对应的处理方式。
 *
 * action 是**界面要给的按钮**，不是代码要自动做的事：
 *   none        —— 没有可做的，把原因说清楚就够
 *   retry       —— 同一目标再试一次（瞬时错误）
 *   approve     —— 带 approvedBuilds 重试
 *   reapprove   —— 重新取 pendingBuilds 再确认
 *   choose      —— 让用户从候选里选一个
 *   edit        —— 回到输入框改 spec
 *   force       —— 明确同意后仍然安装（兼容性豁免）
 *   disable     —— 先禁用插件再操作
 *   restart     —— 关掉 DSH 再操作
 *   refresh     —— 刷新清单后重试
 *   copy-cmd    —— 复制命令行命令，让用户在终端里做
 *   fallback    —— 换一个目标（如 pkg@x.y.z → pkg）
 */
export const INSTALL_CODE_MAP = {
  // ---- 宿主 pluginManager: ManagementFailure ----
  'already-installed': { layer: FAILURE_LAYERS.state, retryable: false, action: 'none', outcome: 'already-present' },
  'ambiguous-install': { layer: FAILURE_LAYERS.resolve, retryable: false, action: 'choose' },
  'bundle-in-use': { layer: FAILURE_LAYERS.activation, retryable: true, action: 'disable' },
  'incompatible-version': { layer: FAILURE_LAYERS.compat, retryable: false, action: 'force' },
  'invalid-spec': { layer: FAILURE_LAYERS.resolve, retryable: false, action: 'edit' },
  'management-required': { layer: FAILURE_LAYERS.permission, retryable: false, action: 'none' },
  'not-bundle': { layer: FAILURE_LAYERS.declare, retryable: false, action: 'none' },
  'not-removable': { layer: FAILURE_LAYERS.permission, retryable: false, action: 'none' },
  'stale-approval': { layer: FAILURE_LAYERS.build, retryable: true, action: 'reapprove' },
  'stop-profile': { layer: FAILURE_LAYERS.activation, retryable: true, action: 'restart' },
  'unknown-plugin': { layer: FAILURE_LAYERS.inventory, retryable: true, action: 'refresh' },

  // ---- 宿主 pluginManager: refused()（装前预检）----
  'not-a-bundle': { layer: FAILURE_LAYERS.declare, retryable: false, action: 'none' },
  'not-a-package': { layer: FAILURE_LAYERS.resolve, retryable: false, action: 'none' },

  // ---- pnpm / OS 原始码 ----
  ERR_PNPM_ADDING_TO_ROOT: { layer: FAILURE_LAYERS.workspace, retryable: true, action: 'copy-cmd' },
  ERR_PNPM_PEER_DEP_ISSUES: { layer: FAILURE_LAYERS.resolve, retryable: false, action: 'force' },
  ERR_PNPM_IGNORED_BUILDS: { layer: FAILURE_LAYERS.build, retryable: true, action: 'approve' },
  ERR_PNPM_EPERM: { layer: FAILURE_LAYERS.lock, retryable: true, action: 'retry' },
  ERR_PNPM_EBUSY: { layer: FAILURE_LAYERS.lock, retryable: true, action: 'retry' },
  EPERM: { layer: FAILURE_LAYERS.lock, retryable: true, action: 'retry' },
  EBUSY: { layer: FAILURE_LAYERS.lock, retryable: true, action: 'retry' },
  ETXTBSY: { layer: FAILURE_LAYERS.lock, retryable: true, action: 'retry' },
  ERR_PNPM_NO_MATCHING_VERSION: { layer: FAILURE_LAYERS.version, retryable: true, action: 'fallback' },
  ERR_PNPM_INVALID_PATH: { layer: FAILURE_LAYERS.subdir, retryable: false, action: 'copy-cmd' },
  ERR_PNPM_FETCH_404: { layer: FAILURE_LAYERS.version, retryable: true, action: 'fallback' },
  ERR_PNPM_UNEXPECTED_STORE: { layer: FAILURE_LAYERS.lock, retryable: false, action: 'copy-cmd' },
  ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY: { layer: FAILURE_LAYERS.lock, retryable: false, action: 'copy-cmd' },
}

/**
 * 文本里没有干净 code 时用正则嗅探。
 * 顺序有意义：**先判状态类，再判具体层**。already-installed 必须排在最前，
 * 否则 "is already installed" 里若同时出现别的词（例如包名里带 root）会判错。
 */
const SNIFF_RULES = [
  { pattern: /already-installed|is already installed/i, code: 'already-installed' },
  { pattern: /ERR_PNPM_ADDING_TO_ROOT|ADDING_TO_ROOT/i, code: 'ERR_PNPM_ADDING_TO_ROOT' },
  { pattern: /ERR_PNPM_PEER_DEP_ISSUES|peer dependency issues|Issues with peer dependencies/i, code: 'ERR_PNPM_PEER_DEP_ISSUES' },
  { pattern: /Ignored build scripts?|ERR_PNPM_IGNORED_BUILDS/i, code: 'ERR_PNPM_IGNORED_BUILDS' },
  { pattern: /ERR_PNPM_NO_MATCHING_VERSION|No matching version found/i, code: 'ERR_PNPM_NO_MATCHING_VERSION' },
  { pattern: /ERR_PNPM_INVALID_PATH|not a valid sub-directory/i, code: 'ERR_PNPM_INVALID_PATH' },
  { pattern: /ERR_PNPM_UNEXPECTED_STORE/i, code: 'ERR_PNPM_UNEXPECTED_STORE' },
  { pattern: /ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY|Broken lockfile/i, code: 'ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY' },
  { pattern: /E404|404 Not Found/i, code: 'ERR_PNPM_FETCH_404' },
  { pattern: /ERR_PNPM_EPERM|EPERM|EBUSY|ETXTBSY|resource busy|being used by another process|rename .*_tmp_/i, code: 'EPERM' },
]

/**
 * 判定一次安装失败。
 *
 * @param {unknown} error 宿主抛出或包装后的错误
 * @param {string} [detail] 已格式化好的文本（省略则从 error 推）
 * @returns {{
 *   code: string|null,
 *   layer: string,
 *   retryable: boolean,
 *   action: string,
 *   outcome: 'failed'|'already-present',
 *   evidence: string|null,
 *   incompatible: object[]|null,
 * }}
 */
export function classifyInstallFailure(error, detail) {
  const text = typeof detail === 'string' && detail
    ? detail
    : (error && error.message ? String(error.code ? error.code + ': ' : '') + String(error.message) : String(error ?? ''))

  // 1) 宿主给的精确 code 优先：它比文本正则可靠得多。
  //    ManagementFailure 的 code 落在 error.code 上（message 与 code 同值）。
  const explicit = typeof error?.code === 'string' ? error.code.trim() : ''
  let code = null
  if (explicit && Object.hasOwn(INSTALL_CODE_MAP, explicit)) code = explicit

  // 2) 没有精确 code 才嗅探文本。
  if (!code) {
    for (const rule of SNIFF_RULES) {
      if (rule.pattern.test(text)) {
        code = rule.code
        break
      }
    }
  }

  if (!code) {
    return {
      code: null,
      layer: FAILURE_LAYERS.unknown,
      retryable: false,
      action: 'copy-cmd',
      outcome: 'failed',
      evidence: firstLine(text),
      incompatible: null,
    }
  }

  const mapped = INSTALL_CODE_MAP[code] ?? {}
  const incompatible = Array.isArray(error?.incompatible) && error.incompatible.length
    ? error.incompatible.slice(0, 8)
    : null

  return {
    code,
    layer: mapped.layer ?? FAILURE_LAYERS.unknown,
    retryable: Boolean(mapped.retryable),
    action: mapped.action ?? 'copy-cmd',
    // already-present 不是失败：调用方要回 200，并把 note 给出去。
    outcome: mapped.outcome === 'already-present' ? 'already-present' : 'failed',
    evidence: firstLine(text),
    incompatible,
  }
}

/** 取第一行有信息量的文本当作「原始证据」：完整 pnpm 输出太长，界面只留一行 + 复制入口。 */
export function firstLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  // 优先挑带错误码的那一行，其次挑第一行
  const withCode = lines.find((line) => /ERR_PNPM_|EPERM|EBUSY|ETXTBSY|E404|already-installed|not a valid sub-directory/i.test(line))
  const picked = withCode || lines[0] || ''
  return picked.length > 300 ? picked.slice(0, 300) + '…' : picked
}

/** 这个码是不是「目标已经就位」，调用方据此决定 200 还是 500。 */
export function isAlreadyPresent(error, detail) {
  return classifyInstallFailure(error, detail).outcome === 'already-present'
}
