/**
 * 规则引擎测试。
 *
 * 最重要的一条：不传 rules 时（也就是 lib/catalog.js 里 attachScores 的默认
 * 路径）必须与 market-lens 0.5.0 的硬编码口径完全一致。这里用手算的期望值
 * 把它钉住——一旦 BUILT_IN_RULES 被改动，这些数字会立刻炸掉。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCatalog } from '../lib/catalog.js'
import {
  BUILT_IN_PRESETS,
  BUILT_IN_RULES,
  MarketRulesError,
  METRIC_REGISTRY,
  NORM_REGISTRY,
  normalizeRules,
  prepareMetrics,
  rulesDocument,
  rulesTemplate,
  scoreGroup,
  scoreLabelFromRules,
  validateRules,
} from '../lib/rules.js'

const NOW = Date.parse('2026-01-01T00:00:00.000Z')

function daysAgo(days) {
  return new Date(NOW - days * 86_400_000).toISOString()
}

function row(overrides = {}) {
  return {
    key: 'pkg:' + (overrides.name || 'x'),
    name: overrides.name || 'x',
    title: overrides.title || overrides.name || 'x',
    pkg: overrides.pkg ?? null,
    sources: overrides.sources || ['1024store'],
    sourceIds: {},
    installable: true,
    ...overrides,
  }
}

/** 取一行里参与评分的字段，方便逐项比对。 */
describe('默认规则 = 0.5.0 硬编码口径', () => {
  it('有 rating 的行按 rating/users/freshness/pick 加权', () => {
    const rows = buildCatalog({
      sourceRows: [
        row({ key: 'pkg:a', name: 'a', pkg: 'a', score: 90, installers: 100, updatedAt: daysAgo(3) }),
        row({ key: 'pkg:b', name: 'b', pkg: 'b', installers: 10, updatedAt: daysAgo(400) }),
      ],
      now: NOW,
    })
    const a = rows.find((item) => item.name === 'a')

    // rating 90*0.55=49.5；users log1p(100)/log1p(100)=100*0.25=25；
    // freshness 3 天 → 100*0.1=10；pick 非精选 → 60*0.1=6 → 90.5 → 91
    assert.equal(a.marketScore, 91)
    assert.equal(a.marketLabel, 'excellent')
    assert.deepEqual(a.marketParts, [
      { key: 'rating', weight: 0.55, value: 90 },
      { key: 'users', weight: 0.25, value: 100 },
      { key: 'freshness', weight: 0.1, value: 100 },
      { key: 'pick', weight: 0.1, value: 60 },
    ])
    assert.equal(a.freshness, 100)
  })

  it('无 rating 的行退到 users/freshness/coverage', () => {
    const rows = buildCatalog({
      sourceRows: [
        row({ key: 'pkg:a', name: 'a', pkg: 'a', score: 90, installers: 100, updatedAt: daysAgo(3) }),
        row({ key: 'pkg:b', name: 'b', pkg: 'b', installers: 100, updatedAt: daysAgo(40), sources: ['1024store', 'dshfind'] }),
      ],
      now: NOW,
    })
    const b = rows.find((item) => item.name === 'b')

    // users 100*0.6=60；freshness 40 天 → 70*0.25=17.5；coverage 双源 → 100*0.15=15 → 92.5 → 93
    assert.equal(b.marketScore, 93)
    assert.deepEqual(b.marketParts.map((part) => part.key), ['users', 'freshness', 'coverage'])
    assert.equal(b.marketParts[2].value, 100)
  })

  it('只有单一来源时 coverage 给 50', () => {
    const rows = buildCatalog({
      sourceRows: [row({ key: 'pkg:a', name: 'a', pkg: 'a', installers: 0, updatedAt: daysAgo(400) })],
      now: NOW,
    })
    // users 0；freshness 400 天 → 12*0.25=3；coverage 单源 → 50*0.15=7.5 → 10.5 → 11
    assert.equal(rows[0].marketScore, 11)
    assert.equal(rows[0].marketParts[2].value, 50)
  })

  it('community 只在 stars 非空时计算，否则保持 null', () => {
    const rows = buildCatalog({
      sourceRows: [
        row({ key: 'pkg:a', name: 'a', pkg: 'a', stars: 500, downloads: 900, installers: 1, updatedAt: daysAgo(1) }),
        row({ key: 'pkg:b', name: 'b', pkg: 'b', installers: 1, updatedAt: daysAgo(1) }),
      ],
      now: NOW,
    })
    const a = rows.find((item) => item.name === 'a')
    const b = rows.find((item) => item.name === 'b')

    // stars log1p(500)/log1p(500)=100*0.55=55；downloads 也是全表最大 → 100*0.2=20；
    // freshness 1 天 → 100*0.15=15；forks 缺项跳过 → 90/0.9 = 100
    assert.equal(a.communityScore, 100)
    assert.equal(a.communityLabel, 'excellent')
    assert.equal(b.communityScore, null)
    assert.deepEqual(b.communityParts, [])
  })

  it('heat 按「存在的指标」重新分配权重', () => {
    const rows = buildCatalog({
      sourceRows: [
        row({ key: 'pkg:a', name: 'a', pkg: 'a', installers: 50, stars: 5, downloads: 100, updatedAt: daysAgo(1) }),
        row({ key: 'pkg:b', name: 'b', pkg: 'b', stars: 5, downloads: 100, updatedAt: daysAgo(1) }),
        row({ key: 'pkg:c', name: 'c', pkg: 'c', updatedAt: daysAgo(1) }),
      ],
      now: NOW,
    })
    const get = (name) => rows.find((item) => item.name === name)

    // a: installers 50 是最大 → 100，stars 与 downloads 同为最大 → 100 → 全 100
    assert.equal(get('a').heat, 100)
    // b: 无 installers → 权重 0.35/0.2 重新归一化，但两项都是最大值 → 仍然 100
    assert.equal(get('b').heat, 100)
    // c: 三个指标全缺 → 无 factor 可算 → 0
    assert.equal(get('c').heat, 0)
  })

  it('分档阈值与旧 scoreLabel 一致', () => {
    assert.equal(scoreLabelFromRules(80), 'excellent')
    assert.equal(scoreLabelFromRules(79), 'good')
    assert.equal(scoreLabelFromRules(60), 'good')
    assert.equal(scoreLabelFromRules(59), 'fair')
    assert.equal(scoreLabelFromRules(40), 'fair')
    assert.equal(scoreLabelFromRules(39), 'weak')
    assert.equal(scoreLabelFromRules(null), 'weak')
  })
})

describe('normalizeRules：外部输入一律先收敛', () => {
  it('接受内置规则原样', () => {
    const rules = normalizeRules(BUILT_IN_RULES)
    assert.equal(rules.version, 1)
    assert.equal(rules.market.factors.length, 4)
    assert.deepEqual(rules.labels, { excellent: 80, good: 60, fair: 40 })
  })

  it('接受导出文件格式 {format, rules}', () => {
    const document = rulesDocument(BUILT_IN_RULES)
    const rules = normalizeRules(document)
    assert.equal(rules.market.factors[0].metric, 'rating')
  })

  it('拒绝非对象', () => {
    assert.throws(() => normalizeRules('nope'), MarketRulesError)
    assert.throws(() => normalizeRules(null), MarketRulesError)
    assert.throws(() => normalizeRules([]), MarketRulesError)
  })

  it('拒绝未知指标与未知归一化', () => {
    const bad = {
      market: { factors: [{ metric: 'magic', norm: 'log', weight: 1 }] },
    }
    const result = validateRules(bad)
    assert.equal(result.ok, false)
    assert.match(result.issues[0], /metric/)

    const badNorm = {
      market: { factors: [{ metric: 'users', norm: 'magic', weight: 1 }] },
    }
    assert.equal(validateRules(badNorm).ok, false)
  })

  it('拒绝权重全为 0 的因子组', () => {
    const result = validateRules({ market: { factors: [{ metric: 'users', norm: 'log', weight: 0 }] } })
    assert.equal(result.ok, false)
    assert.match(result.issues.join(' '), /权重全为 0/)
  })

  it('拒绝非递减的分档阈值', () => {
    const result = validateRules({ market: BUILT_IN_RULES.market, labels: { excellent: 50, good: 60, fair: 40 } })
    assert.equal(result.ok, false)
    assert.match(result.issues.join(' '), /excellent > good > fair/)
  })

  it('重复 key 被拒绝', () => {
    const result = validateRules({
      market: {
        factors: [
          { key: 'same', metric: 'users', norm: 'log', weight: 1 },
          { key: 'same', metric: 'stars', norm: 'log', weight: 1 },
        ],
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.issues.join(' '), /重复/)
  })

  it('因子数量超限被拒绝', () => {
    const factors = Array.from({ length: 13 }, (_, index) => ({ key: 'f' + index, metric: 'users', norm: 'log', weight: 1 }))
    assert.equal(validateRules({ market: { factors } }).ok, false)
  })

  it('linear 的 to 等于 from 被拒绝', () => {
    const result = validateRules({ market: { factors: [{ metric: 'users', norm: 'linear', weight: 1, params: { from: 5, to: 5 } }] } })
    assert.equal(result.ok, false)
    assert.match(result.issues.join(' '), /to 不能等于 from/)
  })

  it('strict 模式下未知字段报错', () => {
    assert.equal(validateRules({ market: BUILT_IN_RULES.market, mystery: 1 }).ok, true)
    assert.throws(() => normalizeRules({ market: BUILT_IN_RULES.market, mystery: 1 }, { strict: true }), MarketRulesError)
  })
})

describe('scoreGroup：归一化行为', () => {
  const ctx = (rows, rules = BUILT_IN_RULES) => prepareMetrics(rows, normalizeRules(rules))

  it('log 归一化抑制头部极值', () => {
    const rows = [row({ name: 'a', installers: 1000 }), row({ name: 'b', installers: 10 })]
    const context = ctx(rows)
    const rules = normalizeRules({ market: { factors: [{ key: 'u', metric: 'users', norm: 'log', weight: 1 }] } })
    const big = scoreGroup(rules.market, rows[0], context, NOW)
    const small = scoreGroup(rules.market, rows[1], context, NOW)
    assert.equal(big.score, 100)
    assert.ok(small.score < 50 && small.score > 0)
  })

  it('quantile 按排名给分，相同值同分', () => {
    const rows = [row({ name: 'a', installers: 1 }), row({ name: 'b', installers: 5 }), row({ name: 'c', installers: 5 }), row({ name: 'd', installers: 9 })]
    const rules = normalizeRules({ market: { factors: [{ key: 'u', metric: 'users', norm: 'quantile', weight: 1 }] } })
    const context = ctx(rows, rules)
    const q = (item) => scoreGroup(rules.market, item, context, NOW).score
    assert.equal(q(rows[0]), 0)
    assert.equal(q(rows[3]), 100)
    assert.equal(q(rows[1]), q(rows[2]))
    // (1/3)*100 = 33.3 → 33
    assert.equal(q(rows[1]), 33)
  })

  it('linear 区间映射', () => {
    const rules = normalizeRules({ market: { factors: [{ key: 'u', metric: 'users', norm: 'linear', weight: 1, params: { from: 10, to: 110 } }] } })
    const context = ctx([], rules)
    const scoreOf = (installers) => scoreGroup(rules.market, row({ installers }), context, NOW).score
    assert.equal(scoreOf(10), 0)
    assert.equal(scoreOf(60), 50)
    assert.equal(scoreOf(110), 100)
    assert.equal(scoreOf(200), 100)
  })

  it('power 归一化可调指数', () => {
    const rules = normalizeRules({ market: { factors: [{ key: 'u', metric: 'users', norm: 'power', weight: 1, params: { exponent: 2 } }] } })
    const rows = [row({ name: 'a', installers: 100 })]
    const context = ctx(rows, rules)
    assert.equal(scoreGroup(rules.market, row({ installers: 50 }), context, NOW).score, 25)
  })

  it('percent 默认按 0..1，可用 scale 适配 0..100 的字段', () => {
    const unit = normalizeRules({ market: { factors: [{ key: 'r', metric: 'rating', norm: 'percent', weight: 1 }] } })
    const hundred = normalizeRules({ market: { factors: [{ key: 'r', metric: 'rating', norm: 'percent', weight: 1, params: { scale: 100 } }] } })
    const context = ctx([], unit)
    assert.equal(scoreGroup(unit.market, row({ score: 0.42 }), context, NOW).score, 42)
    assert.equal(scoreGroup(hundred.market, row({ score: 42 }), context, NOW).score, 42)
  })

  it('coverage 按 min 分档', () => {
    const rules = normalizeRules({ market: { factors: [{ key: 'c', metric: 'coverage', norm: 'coverage', weight: 1, params: { min: 3, high: 90, low: 20 } }] } })
    const context = ctx([], rules)
    const scoreOf = (sources) => scoreGroup(rules.market, row({ sources }), context, NOW).score
    assert.equal(scoreOf(['a', 'b', 'c']), 90)
    assert.equal(scoreOf(['a', 'b']), 20)
  })

  it('weight 0 的因子仍出现在 parts 里但不影响分数', () => {
    const rules = normalizeRules({
      market: {
        factors: [
          { key: 'u', metric: 'users', norm: 'log', weight: 1 },
          { key: 'obs', metric: 'stars', norm: 'log', weight: 0 },
        ],
      },
    })
    const rows = [row({ name: 'a', installers: 10, stars: 3 })]
    const context = ctx(rows, rules)
    const result = scoreGroup(rules.market, rows[0], context, NOW)
    assert.equal(result.parts.length, 2)
    assert.equal(result.score, 100)
  })

  it('mean 聚合取算术平均', () => {
    const rules = normalizeRules({
      market: {
        aggregation: 'mean',
        factors: [
          { key: 'a', metric: 'users', norm: 'fixed', weight: 5, params: { high: 100, low: 100 } },
          { key: 'b', metric: 'rating', norm: 'raw', weight: 1 },
        ],
      },
    })
    const context = ctx([], rules)
    assert.equal(scoreGroup(rules.market, row({ installers: 1, score: 0 }), context, NOW).score, 50)
  })

  it('主组关门时走 fallback，且 fallback 为空则整组为 0', () => {
    const rules = normalizeRules({
      market: {
        when: { metric: 'rating' },
        factors: [{ key: 'r', metric: 'rating', norm: 'raw', weight: 1 }],
        fallback: [{ key: 'u', metric: 'users', norm: 'fixed', weight: 1, params: { high: 100, low: 0 } }],
      },
      community: {
        when: { metric: 'rating' },
        factors: [{ key: 'r', metric: 'rating', norm: 'raw', weight: 1 }],
        fallback: [],
      },
    })
    const context = ctx([], rules)
    assert.equal(scoreGroup(rules.market, row({ score: 77 }), context, NOW).score, 77)
    assert.equal(scoreGroup(rules.market, row({ installers: 3 }), context, NOW).score, 100)
    assert.equal(scoreGroup(rules.community, row({ installers: 3 }), context, NOW).score, 0)
  })

  it('指标缺失的因子被跳过，剩余权重重新分配', () => {
    const rules = normalizeRules({
      market: {
        factors: [
          { key: 'u', metric: 'users', norm: 'fixed', weight: 0.5, params: { high: 100, low: 0 } },
          { key: 's', metric: 'stars', norm: 'fixed', weight: 0.5, params: { high: 100, low: 0 } },
        ],
      },
    })
    const context = ctx([], rules)
    // stars 为 null → 只剩 users 一项且权重归一化后就是 100
    assert.deepEqual(scoreGroup(rules.market, row({ installers: 4 }), context, NOW).parts.map((part) => part.key), ['u'])
    assert.equal(scoreGroup(rules.market, row({ installers: 4 }), context, NOW).score, 100)
    assert.deepEqual(scoreGroup(rules.market, row({}), context, NOW).parts, [])
  })
})

describe('规则随目录生效', () => {
  it('传入自定义规则后 marketScore 按新口径变化', () => {
    const custom = normalizeRules({
      name: '只看新鲜度',
      market: { factors: [{ key: 'f', metric: 'freshness', norm: 'freshness', weight: 1 }] },
      community: { factors: [], fallback: [] },
      heat: { factors: [{ key: 'f', metric: 'freshness', norm: 'freshness', weight: 1 }] },
    })
    const rows = buildCatalog({
      sourceRows: [row({ key: 'pkg:a', name: 'a', pkg: 'a', score: 99, installers: 9999, updatedAt: daysAgo(400) })],
      now: NOW,
      rules: custom,
    })
    assert.equal(rows[0].marketScore, 12)
    assert.equal(rows[0].marketLabel, 'weak')
    assert.equal(rows[0].communityScore, null)
  })

  it('自定义分档阈值生效', () => {
    const custom = normalizeRules({
      labels: { excellent: 30, good: 20, fair: 10 },
      market: { factors: [{ key: 'r', metric: 'rating', norm: 'raw', weight: 1 }] },
      community: { factors: [], fallback: [] },
      heat: { factors: [{ key: 'r', metric: 'rating', norm: 'raw', weight: 1 }] },
    })
    const rows = buildCatalog({ sourceRows: [row({ key: 'pkg:a', name: 'a', pkg: 'a', score: 35 })], now: NOW, rules: custom })
    assert.equal(rows[0].marketLabel, 'excellent')
  })

  it('纯 github 行在自定义规则下也能算分', () => {
    const custom = normalizeRules({
      market: {
        when: { metric: 'rating' },
        factors: [{ key: 'r', metric: 'rating', norm: 'raw', weight: 1 }],
        fallback: [{ key: 's', metric: 'stars', norm: 'log', weight: 1 }],
      },
      community: { factors: [], fallback: [] },
      heat: { factors: [{ key: 's', metric: 'stars', norm: 'log', weight: 1 }] },
    })
    const rows = buildCatalog({
      sourceRows: [row({ key: 'gh:o/r', name: 'r', repo: 'o/r', stars: 120, updatedAt: daysAgo(2) })],
      now: NOW,
      rules: custom,
    })
    assert.equal(rows[0].marketScore, 100)
    assert.equal(rows[0].heat, 100)
  })
})

describe('模版与预设', () => {
  it('模版自带字段说明与全部指标/归一化清单', () => {
    const template = rulesTemplate()
    assert.equal(template.format, 'market-lens/scoring-rules')
    assert.match(template.readme, /用法/)
    assert.deepEqual(template.metrics.map((item) => item.key).sort(), Object.keys(METRIC_REGISTRY).sort())
    assert.deepEqual(template.norms.map((item) => item.key).sort(), Object.keys(NORM_REGISTRY).sort())
  })

  it('模版里的 rules 段可以直接被 normalizeRules 吃下', () => {
    const rules = normalizeRules(rulesTemplate().rules)
    assert.equal(rules.market.factors.length, 4)
  })

  it('每个预设都能通过校验且与默认口径不同', () => {
    assert.ok(BUILT_IN_PRESETS.length >= 2)
    for (const preset of BUILT_IN_PRESETS) {
      const rules = normalizeRules(preset.rules)
      assert.ok(rules.market.factors.length > 0, preset.id)
    }
    const newcomer = normalizeRules(BUILT_IN_PRESETS[1].rules)
    assert.notDeepEqual(newcomer.market.factors, BUILT_IN_RULES.market.factors)
  })

  it('导出的文档可被重新导入（往返一致）', () => {
    const custom = normalizeRules({ name: '往返', market: BUILT_IN_RULES.market, community: BUILT_IN_RULES.community, heat: BUILT_IN_RULES.heat })
    const roundTrip = normalizeRules(rulesDocument(custom))
    assert.equal(roundTrip.name, '往返')
    assert.deepEqual(roundTrip.market, custom.market)
    assert.deepEqual(roundTrip.heat, custom.heat)
  })
})
