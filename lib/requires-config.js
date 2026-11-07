/**
 * requires-config.js —— 「装好了、也跑起来了，但用不了」。
 *
 * 真实案例（2026-11-07，@wxg-prc-cpg/dsh-weknora@0.1.0）：
 *
 *   pnpm 装成功、包进了 bundles、四层静态体检 verdict=ok、
 *   运行时日志还明说 `registered weknora_search against http://localhost:8080/api/v1`
 *
 *   但它连的是 patch 里的**默认值** localhost:8080，而那里根本没有服务。
 *   四个工具全都注册了，一调用就 ECONNREFUSED。
 *
 *   用户看到的现象是「显示已安装，但没有安装成功」——其实装对了，
 *   缺的是配置。而现有体检看不到这一层：fiberPhase 是 active，
 *   因为"注册工具"这一步确实成功了。
 *
 * 所以补第五层：**读 patch 里的 config，判断它依赖的外部条件是否满足。**
 *
 * patch 里这类写法很常见：
 *
 *   config:
 *     baseUrl: !!js process.env.WEKNORA_BASE_URL ?? 'http://localhost:8080/api/v1'
 *     apiKey:  !!js process.env.WEKNORA_API_KEY
 *
 * 判据（三条，各有各的含义）：
 *   1. 引用了环境变量、但**没设**、且有 localhost / 占位默认值
 *      → 它一定会去连一个不存在的地方，功能必然不通
 *   2. 引用了环境变量、但**没设**、也没有默认值
 *      → 传进去是 undefined，插件行为不可预期（可能整个功能静默关闭）
 *   3. 引用了环境变量、已经设了
 *      → 满足条件，不报
 *
 * 一条安全约束：**绝不回显敏感值**。key 名里带
 * token / secret / password / key 的，只报「已设置 / 未设置」，
 * 不把值写进日志、不写进响应 —— 这些会进运行日志，而日志会被导出分享。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 看起来像密钥的配置名：只报是否已设置，绝不回显值。 */
const SECRET_LIKE = /(api[-_]?key|token|secret|passw(or)?d|credential|auth)/i
/**
 * 指向"本机/占位"的默认值：连上去一定是不通的。
 *
 * 注意 `example.org` 不能算占位 —— 测试里用一个**看起来正规**的默认值
 * 来表达"官方默认地址，能跑但不是你要的"。真正的占位是
 * localhost / 回环 / 通配 / 明确的占位符（your-x、<...>）。
 */
const LOCAL_OR_PLACEHOLDER = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|your[-_.]|<[^>]+>|changeme|placeholder/i

/**
 * 从一行 `!!js` 表达式里抽出 `process.env.X` 的引用名。
 * 去重并保持出现顺序 —— 同一个变量在表达式里出现两次很常见
 * （`(process.env.X ?? '').split(',')`）。
 *
 * @param {string} expr
 * @returns {string[]}
 */
export function extractEnvRefs(expr) {
  const text = String(expr || '')
  const refs = []
  const pattern = /process\.env\.([A-Z_][A-Z0-9_]*)/gi
  let match
  while ((match = pattern.exec(text))) {
    if (!refs.includes(match[1])) refs.push(match[1])
  }
  // 也认 process.env['X'] 这种下标写法（少见但合法）
  const bracket = /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g
  while ((match = bracket.exec(text))) {
    if (!refs.includes(match[1])) refs.push(match[1])
  }
  return refs
}

/**
 * 抽出 `?? '默认值'` 里的默认值。
 *
 * 只认字符串字面量：`?? 'http://localhost:8080/api/v1'` → 那个 URL。
 * 数字/布尔/表达式都不当默认值 —— 我们只关心"它会不会去连一个具体地址"。
 *
 * @param {string} expr
 * @returns {string|null}
 */
export function extractFallback(expr) {
  const text = String(expr || '')
  // 双引号 / 单引号 / 反引号（无反引号内插值的情况）
  const pattern = /\?\?\s*(['"])((?:(?!\1).)*)\1/
  const match = pattern.exec(text)
  if (!match) return null
  return match[2]
}

/**
 * 解析 patch 文本里每条 insert 行的 `config:` 段。
 *
 * 我们只关心 `!!js` 值：字面量配置（`port: 8080`）不需要外部条件，
 * 报它只会制造噪声。
 *
 * @param {string} text patch 文件内容
 * @returns {Array<{id: string|null, name: string|null, entries: Array<{key: string, raw: string, env: string[], fallback: string|null}>}>}
 */
export function parsePatchConfig(text) {
  const lines = String(text || '').split(/\r?\n/)
  const blocks = []
  let current = null
  let configIndent = -1
  let entryIndent = -1

  const indentOf = (line) => {
    const match = /^(\s*)/.exec(line)
    return match ? match[1].length : 0
  }

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = indentOf(raw)
    const trimmed = raw.trim()

    // 新的 insert 行：`- id: xxx`
    const idMatch = /^-\s*id\s*:\s*(.+)$/.exec(trimmed)
    if (idMatch) {
      current = { id: unquote(idMatch[1]), name: null, entries: [] }
      blocks.push(current)
      configIndent = -1
      entryIndent = -1
      continue
    }
    if (!current) continue

    // 该行的 name
    const nameMatch = /^name\s*:\s*(.+)$/.exec(trimmed)
    if (nameMatch && current.name === null) {
      current.name = unquote(nameMatch[1])
      continue
    }

    // config 段起点
    if (/^config\s*:\s*$/.test(trimmed)) {
      configIndent = indent
      entryIndent = -1
      continue
    }

    if (configIndent < 0) continue
    // 缩进回到 config 之外，说明 config 段结束了
    if (indent <= configIndent) {
      configIndent = -1
      entryIndent = -1
      continue
    }

    // config 下的一个 key
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed)
    if (!kv) continue
    const [, key, valueText] = kv
    const valueIndent = indent
    // 新条目的缩进就是 entryIndent；比它更深的行属于上一条的续行
    if (entryIndent < 0) entryIndent = valueIndent
    if (valueIndent > entryIndent) {
      // 续行：把内容接到上一条的 raw 上（!!js 表达式常跨行）
      const previous = current.entries[current.entries.length - 1]
      if (previous) previous.raw = (previous.raw + ' ' + trimmed).trim()
      continue
    }
    current.entries.push({
      key,
      raw: valueText.trim(),
      env: [],
      fallback: null,
    })
  }

  // 后处理：只保留 !!js 条目，并抽出 env / fallback
  const result = []
  for (const block of blocks) {
    const entries = []
    for (const entry of block.entries) {
      if (!entry.raw.startsWith('!!js')) continue
      const env = extractEnvRefs(entry.raw)
      if (!env.length) continue // 不依赖环境变量的 !!js 不需要外部条件
      entries.push({
        key: entry.key,
        raw: entry.raw,
        env,
        fallback: extractFallback(entry.raw),
      })
    }
    if (entries.length) result.push({ id: block.id, name: block.name, entries })
  }
  return result
}

function unquote(value) {
  const text = String(value || '').trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * 判断一个配置项要不要报。
 *
 * @param {{key: string, env: string[], fallback: string|null}} entry
 * @param {Record<string, string|undefined>} env 真实环境（调用方传 process.env）
 * @returns {{key: string, status: 'missing'|'placeholder'|'optional'|'satisfied', env: string[], fallback: string|null, secret: boolean, detail: string|null}}
 */
export function classifyConfigEntry(entry, env = {}) {
  const secret = SECRET_LIKE.test(entry.key)
  const missing = entry.env.filter((name) => {
    const value = env[name]
    return !(typeof value === 'string' && value.trim())
  })
  const base = {
    key: entry.key,
    env: entry.env,
    fallback: entry.fallback,
    secret,
    status: 'satisfied',
    detail: null,
  }

  if (!missing.length) return base

  // 有回退值且回退值指向本机/占位 → 它跑起来一定连不上
  if (entry.fallback && LOCAL_OR_PLACEHOLDER.test(entry.fallback)) {
    return {
      ...base,
      status: 'placeholder',
      // 敏感项不回显值；URL 这类可以显示 —— 它本来就是给用户看的
      detail: entry.env.join(' / ') + ' 没有设置，会退回默认值 ' +
        (secret ? '（敏感值，不显示）' : entry.fallback) + ' —— 这个地址上没有服务，功能会失败',
    }
  }

  // 没有回退值 → 传进去是 undefined，插件可能静默关掉整块能力
  if (!entry.fallback) {
    return {
      ...base,
      status: 'missing',
      detail: entry.env.join(' / ') + ' 没有设置，也没有默认值 —— 插件拿到的会是 undefined',
    }
  }

  // 有非占位的回退值：能跑，但用的不是用户想要的配置。这条只算提示。
  return {
    ...base,
    status: 'optional',
    detail: entry.env.join(' / ') + ' 没有设置，会用默认值' + (secret ? '（敏感值，不显示）' : ' ' + entry.fallback),
  }
}

/**
 * 一个包的「需要配置」结论。
 *
 * @param {object} input
 * @param {string} input.packageDir
 * @param {Record<string, string|undefined>} [input.env] 真实环境（默认 process.env）
 * @returns {{required: boolean, blocking: boolean, entries: object[], detail: string|null}}
 */
export function inspectConfigNeeds({ packageDir, env = process.env } = {}) {
  const empty = { required: false, blocking: false, entries: [], detail: null }
  if (!packageDir) return empty
  const patchPath = path_join(packageDir, 'cordis.patch.yml')
  let text
  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch {
    return empty
  }

  const blocks = parsePatchConfig(text)
  const entries = []
  for (const block of blocks) {
    for (const entry of block.entries) {
      entries.push({ ...classifyConfigEntry(entry, env), id: block.id })
    }
  }
  if (!entries.length) return empty

  // blocking 的判据：**只有 placeholder 才算**。
  //
  // 为什么 missing 不算：静态读 patch 时我们没法知道哪个配置项是必需的。
  // 真机样本里 baseUrl 缺了会退回 localhost（一定连不上，功能必挂），
  // 而 knowledgeBaseIds / agentId 缺了往往只是少几个能力，插件照常工作。
  // 把 missing 也判成 blocking，会让「只差一个可选项」的插件被报成"用不了"——
  // 那是新的误报，而误报会让用户不再相信这个提示。
  //
  // 所以：placeholder = 一定会失败（阻断）；missing = 拿到 undefined（提醒）。
  const blocking = entries.some((entry) => entry.status === 'placeholder')
  const needsAttention = entries.filter((entry) => entry.status !== 'satisfied')
  if (!needsAttention.length) return empty

  // 报最严重的那一条：placeholder 优先于 missing，missing 优先于 optional。
  const rank = { placeholder: 0, missing: 1, optional: 2 }
  const worst = needsAttention.slice().sort((left, right) => (rank[left.status] ?? 9) - (rank[right.status] ?? 9))[0]
  return {
    required: true,
    blocking,
    entries,
    detail: worst?.detail ?? null,
  }
}

// 用 node:path 拼路径，不自己判分隔符。
// 手写 `base.includes('\\') ? '\\' : '/'` 在混用分隔符的路径上会拼错
// （temp 目录常是 C:\Users\...\Temp\t-x 这种，而调用方可能传正斜杠）。
function path_join(base, name) {
  return path.join(base, name)
}
