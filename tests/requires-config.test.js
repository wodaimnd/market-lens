/**
 * requires-config 回归：「装好了、也跑起来了，但用不了」。
 *
 * 真实案例（2026-11-07，@wxg-prc-cpg/dsh-weknora@0.1.0）：
 *   pnpm 装成功、进了 bundles、四层静态体检 verdict=ok、
 *   运行时还明说 `registered weknora_search against http://localhost:8080/api/v1`
 *   但 localhost:8080 上没有服务 —— 四个工具全注册，一调用就 ECONNREFUSED。
 *
 *   用户看到的是「显示已安装但没安装成功」，其实是装对了、缺配置。
 *   fiberPhase 帮不上：工具注册确实成功了，state 就是 active。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifyConfigEntry,
  extractEnvRefs,
  extractFallback,
  inspectConfigNeeds,
  parsePatchConfig,
} from '../lib/requires-config.js'

/** 真机样本：weknora 的 cordis.patch.yml（逐字照抄）。 */
const WEKNORA_PATCH = `# The configuration layer this bundle contributes when a profile lists it.
# Override the row from the profile's own cordis.patch.yml to point the plugin
# at your deployment; every field is documented in README.md.
- insert:
    - id: weknora
      # Must be the published package name — the loader imports this specifier.
      # Quoted because YAML reserves a leading '@' in plain scalars.
      name: "@wxg-prc-cpg/dsh-weknora"
      config:
        baseUrl: !!js process.env.WEKNORA_BASE_URL ?? 'http://localhost:8080/api/v1'
        apiKey: !!js process.env.WEKNORA_API_KEY
        knowledgeBaseIds: !!js (process.env.WEKNORA_KNOWLEDGE_BASE_IDS ?? '').split(',').filter(Boolean)
        agentId: !!js process.env.WEKNORA_AGENT_ID
`

describe('extractEnvRefs：抽出 process.env 引用', () => {
  it('单引用', () => {
    assert.deepEqual(extractEnvRefs('process.env.WEKNORA_API_KEY'), ['WEKNORA_API_KEY'])
  })

  it('同一变量出现两次只记一次', () => {
    assert.deepEqual(extractEnvRefs("(process.env.X ?? '').split(',').filter(Boolean)"), ['X'])
  })

  it('多个变量按出现顺序', () => {
    assert.deepEqual(extractEnvRefs('process.env.A || process.env.B'), ['A', 'B'])
  })

  it('认下标写法', () => {
    assert.deepEqual(extractEnvRefs("process.env['MY_VAR']"), ['MY_VAR'])
  })

  it('没有引用返回空数组', () => {
    assert.deepEqual(extractEnvRefs("'http://example.com'"), [])
    assert.deepEqual(extractEnvRefs(''), [])
  })
})

describe('extractFallback：抽 ?? 默认值', () => {
  it('单引号默认值', () => {
    assert.equal(extractFallback("process.env.X ?? 'http://localhost:8080'"), 'http://localhost:8080')
  })

  it('双引号默认值', () => {
    assert.equal(extractFallback('process.env.X ?? "https://api.example.com"'), 'https://api.example.com')
  })

  it('空串默认值也算（意味着"什么都不配"）', () => {
    assert.equal(extractFallback("(process.env.X ?? '').split(',')"), '')
  })

  it('没有 ?? 返回 null', () => {
    assert.equal(extractFallback('process.env.X'), null)
  })
})

describe('parsePatchConfig：解析真实 patch', () => {
  it('weknora 四条 !!js 配置全部抽出', () => {
    const blocks = parsePatchConfig(WEKNORA_PATCH)
    assert.equal(blocks.length, 1)
    const block = blocks[0]
    assert.equal(block.id, 'weknora')
    assert.equal(block.name, '@wxg-prc-cpg/dsh-weknora')
    const keys = block.entries.map((entry) => entry.key)
    assert.deepEqual(keys, ['baseUrl', 'apiKey', 'knowledgeBaseIds', 'agentId'])
  })

  it('baseUrl 抽到 env 与 localhost 默认值', () => {
    const entry = parsePatchConfig(WEKNORA_PATCH)[0].entries.find((e) => e.key === 'baseUrl')
    assert.deepEqual(entry.env, ['WEKNORA_BASE_URL'])
    assert.equal(entry.fallback, 'http://localhost:8080/api/v1')
  })

  it('apiKey 没有默认值', () => {
    const entry = parsePatchConfig(WEKNORA_PATCH)[0].entries.find((e) => e.key === 'apiKey')
    assert.deepEqual(entry.env, ['WEKNORA_API_KEY'])
    assert.equal(entry.fallback, null)
  })

  it('字面量配置不算（不需要外部条件）', () => {
    const blocks = parsePatchConfig([
      '- insert:',
      '    - id: plain',
      '      name: plain-pkg',
      '      config:',
      '        port: 8080',
      '        enabled: true',
    ].join('\n'))
    assert.deepEqual(blocks, [], '没有 !!js 就不该出现在结果里')
  })

  it('!!js 但不引用环境变量也不算', () => {
    const blocks = parsePatchConfig([
      '- insert:',
      '    - id: x',
      '      name: x-pkg',
      '      config:',
      "        stamp: !!js new Date().toISOString()",
    ].join('\n'))
    assert.deepEqual(blocks, [])
  })

  it('多行 !!js 表达式可续行', () => {
    const blocks = parsePatchConfig([
      '- insert:',
      '    - id: multi',
      '      name: multi-pkg',
      '      config:',
      '        ids: !!js (process.env.IDS ?? "")',
      '          .split(",")',
      '          .filter(Boolean)',
    ].join('\n'))
    assert.equal(blocks.length, 1)
    assert.deepEqual(blocks[0].entries[0].env, ['IDS'])
  })
})

describe('classifyConfigEntry：三种状态各有含义', () => {
  it('环境变量已设 → satisfied', () => {
    const result = classifyConfigEntry(
      { key: 'baseUrl', env: ['X'], fallback: 'http://localhost:8080' },
      { X: 'https://real.example.com' },
    )
    assert.equal(result.status, 'satisfied')
    assert.equal(result.detail, null)
  })

  it('没设 + localhost 默认值 → placeholder（一定连不上）', () => {
    const result = classifyConfigEntry(
      { key: 'baseUrl', env: ['X'], fallback: 'http://localhost:8080/api/v1' },
      {},
    )
    assert.equal(result.status, 'placeholder')
    assert.match(result.detail, /localhost|没有服务/)
  })

  it('没设 + 无默认值 → missing（拿到 undefined）', () => {
    const result = classifyConfigEntry({ key: 'apiKey', env: ['K'], fallback: null }, {})
    assert.equal(result.status, 'missing')
    assert.match(result.detail, /undefined/)
  })

  it('没设 + 非占位默认值 → optional（能跑但不是你要的）', () => {
    const result = classifyConfigEntry(
      { key: 'baseUrl', env: ['X'], fallback: 'https://official.example.org/api' },
      {},
    )
    assert.equal(result.status, 'optional')
  })

  it('空白字符串视为没设置', () => {
    const result = classifyConfigEntry({ key: 'k', env: ['X'], fallback: null }, { X: '   ' })
    assert.equal(result.status, 'missing')
  })
})

describe('敏感值绝不回显', () => {
  it('key 名带 api key / token / secret / password 的都标 secret', () => {
    for (const key of ['apiKey', 'api_key', 'token', 'authToken', 'secret', 'password', 'credential']) {
      const result = classifyConfigEntry({ key, env: ['X'], fallback: 'http://localhost:1' }, {})
      assert.equal(result.secret, true, key + ' 应被当成敏感项')
    }
  })

  it('敏感项的 detail 不出现默认值明文', () => {
    const result = classifyConfigEntry(
      { key: 'apiKey', env: ['WEKNORA_API_KEY'], fallback: 'http://localhost:8080/secret-path' },
      {},
    )
    assert.equal(result.status, 'placeholder')
    assert.ok(!result.detail.includes('secret-path'), 'detail 不能把敏感默认值写出来：' + result.detail)
    assert.match(result.detail, /不显示/)
  })

  it('非敏感项（URL）可以显示默认值 —— 它本来就是给人看的', () => {
    const result = classifyConfigEntry(
      { key: 'baseUrl', env: ['X'], fallback: 'http://localhost:8080/api/v1' },
      {},
    )
    assert.match(result.detail, /localhost:8080/)
  })
})

describe('inspectConfigNeeds：整包结论', () => {
  function makePackage(patchText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-config-'))
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchText, 'utf8')
    return dir
  }

  it('weknora 全空环境 → required + blocking（baseUrl 会退回 localhost）', () => {
    const packageDir = makePackage(WEKNORA_PATCH)
    try {
      const result = inspectConfigNeeds({ packageDir, env: {} })
      assert.equal(result.required, true)
      assert.equal(result.blocking, true, 'baseUrl 退回 localhost 属于必然失败，是阻断性的')
      assert.equal(result.entries.length, 4)
      // baseUrl 会退回 localhost，这是最值得说的那条
      const baseUrl = result.entries.find((entry) => entry.key === 'baseUrl')
      assert.equal(baseUrl.status, 'placeholder')
      // detail 报最严重的那条：placeholder 优先于 missing
      assert.match(result.detail, /WEKNORA_BASE_URL/)
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true })
    }
  })

  it('只缺可选字段（没有 placeholder）→ 报告但不阻断', () => {
    // 真机里 knowledgeBaseIds / agentId 缺了只是少几个能力，插件照常工作。
    // 把 missing 也判成 blocking，等于把"只差一个可选项"报成"用不了"。
    const packageDir = makePackage([
      '- insert:',
      '    - id: soft2',
      '      name: soft2-pkg',
      '      config:',
      "        baseUrl: !!js process.env.BASE ?? 'https://official.example.com/api'",
      '        agentId: !!js process.env.AGENT',
    ].join('\n'))
    try {
      const result = inspectConfigNeeds({ packageDir, env: {} })
      assert.equal(result.required, true, '还是要提醒')
      assert.equal(result.blocking, false, 'missing 不该阻断')
      const agent = result.entries.find((entry) => entry.key === 'agentId')
      assert.equal(agent.status, 'missing')
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true })
    }
  })

  it('配齐之后 → 不再报', () => {
    const packageDir = makePackage(WEKNORA_PATCH)
    try {
      const result = inspectConfigNeeds({
        packageDir,
        env: {
          WEKNORA_BASE_URL: 'https://real.example.com/api/v1',
          WEKNORA_API_KEY: 'k',
          WEKNORA_KNOWLEDGE_BASE_IDS: 'a,b',
          WEKNORA_AGENT_ID: 'agent',
        },
      })
      assert.equal(result.required, false)
      assert.equal(result.blocking, false)
      assert.deepEqual(result.entries, [])
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true })
    }
  })

  it('只缺可选项 → 仍报告但不阻断', () => {
    const packageDir = makePackage([
      '- insert:',
      '    - id: soft',
      '      name: soft-pkg',
      '      config:',
      "        baseUrl: !!js process.env.X ?? 'https://official.example.org/api'",
    ].join('\n'))
    try {
      const result = inspectConfigNeeds({ packageDir, env: {} })
      assert.equal(result.required, true, '还是要提醒')
      assert.equal(result.blocking, false, '官方默认值能跑，不该判死')
      assert.equal(result.entries[0].status, 'optional')
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true })
    }
  })

  it('没有 patch / 没有 !js 配置 → 不报', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-config-none-'))
    try {
      assert.deepEqual(inspectConfigNeeds({ packageDir: dir, env: {} }), {
        required: false, blocking: false, entries: [], detail: null,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('null 路径不崩', () => {
    const result = inspectConfigNeeds({ packageDir: null, env: {} })
    assert.equal(result.required, false)
  })
})

test('真机样本：weknora 的默认 baseUrl 会被识别为占位地址', () => {
  const blocks = parsePatchConfig(WEKNORA_PATCH)
  const baseUrl = blocks[0].entries.find((entry) => entry.key === 'baseUrl')
  const classified = classifyConfigEntry(baseUrl, {})
  assert.equal(classified.status, 'placeholder')
  assert.deepEqual(classified.env, ['WEKNORA_BASE_URL'])
  // 这正是 2026-11-07 那次「显示已安装但用不了」的直接原因
  assert.equal(classified.fallback, 'http://localhost:8080/api/v1')
})
