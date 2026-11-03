/**
 * 来源配置的导入/导出。
 *
 * 导出必须是"换了机器还能用"的那部分：自定义源、启停状态、定时、安全视图；
 * 健康状态和缓存不带走（上一台的 lastError 对新环境没有意义）。
 *
 * 导入是外部输入，必须逐条校验：协议、kind、重复 URL，任何一个不合规都只 skip
 * 并记进 report，不能让整份配置导入失败——团队共享的 JSON 里混进旧条目是常态。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILT_IN_SOURCES,
  CONFIG_EXPORT_FORMAT,
  CONFIG_EXPORT_VERSION,
  exportSourceConfig,
  importSourceConfig,
} from '../lib/source-config.js'

const config = (overrides = {}) => ({
  version: 1,
  refreshIntervalMinutes: 60,
  lastAutoRefreshAt: null,
  safeView: true,
  sourceHealth: { dshfind: { lastSuccessAt: null, failureCount: 2, lastError: 'boom' } },
  sources: BUILT_IN_SOURCES.map((source) => ({ ...source })),
  ...overrides,
})

const custom = (overrides = {}) => ({
  id: 'custom-1',
  kind: 'standard',
  name: '内部源',
  short: '内部',
  color: '#8a94a6',
  enabled: true,
  builtin: false,
  url: 'https://plugins.example.com/manifest.json',
  ...overrides,
})

describe('exportSourceConfig：只导配置，不导健康状态', () => {
  it('带格式标识、版本、设置与全部来源', () => {
    const document = exportSourceConfig(config({ sources: [...config().sources, custom()] }), {
      pluginVersion: '0.3.0',
      exportedAt: '2026-02-01T00:00:00.000Z',
    })
    assert.equal(document.format, CONFIG_EXPORT_FORMAT)
    assert.equal(document.formatVersion, CONFIG_EXPORT_VERSION)
    assert.equal(document.exportedAt, '2026-02-01T00:00:00.000Z')
    assert.equal(document.plugin.version, '0.3.0')
    assert.deepEqual(document.settings, { refreshIntervalMinutes: 60, safeView: true })
    assert.equal(document.sources.length, BUILT_IN_SOURCES.length + 1)
    assert.equal(document.sourceHealth, undefined)
  })

  it('非法刷新间隔导出成 0，安全视图缺省按开启', () => {
    const document = exportSourceConfig({ ...config(), refreshIntervalMinutes: 7, safeView: undefined })
    assert.equal(document.settings.refreshIntervalMinutes, 0)
    assert.equal(document.settings.safeView, true)
  })
})

describe('importSourceConfig：合并模式', () => {
  it('新增自定义源，并按 id 应用内置源的启停', () => {
    const result = importSourceConfig(config(), {
      format: CONFIG_EXPORT_FORMAT,
      formatVersion: 1,
      settings: { refreshIntervalMinutes: 180, safeView: false },
      sources: [
        { id: 'dshfind', kind: 'dshfind', name: '被改过的名字', enabled: false, builtin: true },
        { id: 'custom-a', kind: 'standard', name: '团队源', url: 'https://team.example.com/index.json', enabled: true },
      ],
    })
    assert.equal(result.ok, true)
    const dshfind = result.config.sources.find((source) => source.id === 'dshfind')
    // 内置源的元数据是代码契约，外部 JSON 只能改启停
    assert.equal(dshfind.name, 'dshfind')
    assert.equal(dshfind.enabled, false)
    assert.equal(result.config.sources.some((source) => source.id === 'custom-a'), true)
    assert.equal(result.config.refreshIntervalMinutes, 180)
    assert.equal(result.config.safeView, false)
    assert.deepEqual(result.report.added, ['custom-a'])
    assert.deepEqual(result.report.updated, ['dshfind'])
  })

  it('同一 URL 视为同一个源：改配置而不是加重复条目', () => {
    const base = config({ sources: [...config().sources, custom()] })
    const result = importSourceConfig(base, {
      sources: [{ id: 'other-id', kind: 'standard', name: '改名了', url: 'https://plugins.example.com/manifest.json', enabled: false }],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.report.added, [])
    assert.deepEqual(result.report.updated, ['custom-1'])
    const updated = result.config.sources.find((source) => source.id === 'custom-1')
    assert.equal(updated.name, '改名了')
    assert.equal(updated.enabled, false)
  })

  it('merge 不动文档里没有的源', () => {
    const base = config({ sources: [...config().sources, custom()] })
    const result = importSourceConfig(base, { sources: [] })
    assert.equal(result.ok, true)
    assert.equal(result.config.sources.some((source) => source.id === 'custom-1'), true)
  })
})

describe('importSourceConfig：覆盖模式', () => {
  it('删掉文档里没有的自定义源，但内置源永远保留', () => {
    const base = config({ sources: [...config().sources, custom(), custom({ id: 'custom-2', url: 'https://b.example.com/x.json' })] })
    const result = importSourceConfig(base, { sources: [custom()] }, { mode: 'replace' })
    assert.equal(result.ok, true)
    assert.equal(result.config.sources.some((source) => source.id === 'custom-2'), false)
    assert.equal(result.config.sources.some((source) => source.id === 'custom-1'), true)
    assert.equal(result.config.sources.filter((source) => source.builtin).length, BUILT_IN_SOURCES.length)
    assert.deepEqual(result.report.removed, ['custom-2'])
  })
})

describe('importSourceConfig：逐条校验', () => {
  it('dshbase 直接跳过，并说明在等 JSON API', () => {
    const result = importSourceConfig(config(), {
      sources: [{ id: 'x', kind: 'dshbase', name: 'dshbase', url: 'https://dshbase.dev/list' }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.report.skipped.length, 1)
    assert.match(result.report.skipped[0].reason, /JSON API/)
  })

  it('非 HTTPS / 带凭据 / 非 443 的地址被跳过', () => {
    const result = importSourceConfig(config(), {
      sources: [
        { id: 'a', kind: 'standard', name: 'a', url: 'http://a.example.com/x.json' },
        { id: 'b', kind: 'standard', name: 'b', url: 'https://user:pass@b.example.com/x.json' },
        { id: 'c', kind: 'standard', name: 'c', url: 'https://c.example.com:8443/x.json' },
      ],
    })
    assert.equal(result.report.skipped.length, 3)
    assert.equal(result.config.sources.length, BUILT_IN_SOURCES.length)
  })

  it('不支持的 kind 与缺 url 的条目都被跳过，其余照常导入', () => {
    const result = importSourceConfig(config(), {
      sources: [
        { id: 'a', kind: 'python-package', name: 'a', url: 'https://a.example.com/x.json' },
        { id: 'b', kind: 'standard', name: 'b' },
        { id: 'c', kind: 'format1', name: 'c', url: 'https://c.example.com/x.json' },
      ],
    })
    assert.equal(result.report.skipped.length, 2)
    assert.deepEqual(result.report.added, ['c'])
  })

  it('文档整体不合规时返回 ok:false，并保留 report', () => {
    assert.equal(importSourceConfig(config(), { format: 'other/format', sources: [] }).ok, false)
    assert.equal(importSourceConfig(config(), { sources: 'nope' }).ok, false)
    assert.equal(importSourceConfig(config(), null).ok, false)
    assert.equal(importSourceConfig(config(), { formatVersion: 99, sources: [] }).ok, false)
  })

  it('非法刷新间隔只记 warning，设置保持原值', () => {
    const result = importSourceConfig(config(), { settings: { refreshIntervalMinutes: 7 }, sources: [] })
    assert.equal(result.ok, true)
    assert.equal(result.config.refreshIntervalMinutes, 60)
    assert.equal(result.report.warnings.length, 1)
  })
})
