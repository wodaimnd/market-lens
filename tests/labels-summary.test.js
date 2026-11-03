/**
 * 分类标签与来源摘要：纯函数，不联网。
 * categoryKey 没有导出，只能通过三个公开归一化函数的 category 字段验证其别名/未知值行为。
 *
 * 跑法：node --test tests/
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCatalog,
  categoryLabel,
  normalize1024,
  normalizeFormat1,
  normalizeStandardItem,
  sourceSummary,
} from '../lib/catalog.js'
import { format1Item, install, p1024Item, standardItem } from './fixtures.js'

const NOW = Date.parse('2026-11-02T00:00:00.000Z')

const categoryOf1024 = (category) => normalize1024(p1024Item({ category })).category
const categoryOfFormat1 = (category, sourceId = 'dshso') =>
  normalizeFormat1(format1Item({ metadata: { category } }), { sourceId }).category
const categoryOfStandard = (categories) =>
  normalizeStandardItem(standardItem({ categories }), { sourceId: 'standard' }).category

describe('categoryLabel / categoryKey：别名映射与未知值', () => {
  it('categoryLabel 为 tools/ui/memory/theme 提供中英文标签（筛选器文案回归）', () => {
    assert.equal(categoryLabel('tools', 'zh'), '工具与能力')
    assert.equal(categoryLabel('tools', 'en'), 'Tools')
    assert.equal(categoryLabel('ui', 'zh'), '界面增强')
    assert.equal(categoryLabel('ui', 'en'), 'UI')
    assert.equal(categoryLabel('memory', 'zh'), '记忆')
    assert.equal(categoryLabel('memory', 'en'), 'Memory')
    assert.equal(categoryLabel('theme', 'zh'), '主题外观')
    assert.equal(categoryLabel('theme', 'en'), 'Themes')
  })

  it('categoryLabel 空键回落到 other 的本地化文案，未知键原样透传（不静默改写用户值）', () => {
    assert.equal(categoryLabel(''), '其他')
    assert.equal(categoryLabel('', 'en'), 'Other')
    assert.equal(categoryLabel('other', 'zh'), '其他')
    assert.equal(categoryLabel('other', 'en'), 'Other')
    assert.equal(categoryLabel('quantum-widgets'), 'quantum-widgets')
  })

  it('categoryKey 把 skin/skins 别名归一到 theme，且大小写不敏感', () => {
    assert.equal(categoryOf1024('skins'), 'theme')
    assert.equal(categoryOf1024('SKINS'), 'theme')
    assert.equal(categoryOf1024('skin'), 'theme')
    assert.equal(categoryOfFormat1('skin'), 'theme')
  })

  it('categoryKey 保留 tools/ui/memory 等原生键，并支持 agents→agent', () => {
    assert.equal(categoryOf1024('Tools'), 'tools')
    assert.equal(categoryOf1024('UI'), 'ui')
    assert.equal(categoryOf1024('memory'), 'memory')
    assert.equal(categoryOf1024('agents'), 'agent')
    assert.equal(categoryOfFormat1('Memory'), 'memory')
  })

  it('未知/空分类一律落到 other，不把原始值泄漏到分类字段', () => {
    assert.equal(categoryOf1024('quantum-widgets'), 'other')
    assert.equal(categoryOf1024(undefined), 'other')
    assert.equal(categoryOf1024(''), 'other')
    assert.equal(categoryOfFormat1('quantum-widgets'), 'other')
    assert.equal(categoryOfStandard(['quantum-widgets']), 'other')
    assert.equal(categoryOfStandard([]), 'other')
  })

  it('标准源只取 categories[0] 作为分类（多分类不拼接）', () => {
    assert.equal(categoryOfStandard(['memory', 'tools']), 'memory')
    assert.equal(categoryOfStandard(['memory']), 'memory')
  })
})

describe('sourceSummary：来源摘要的形状与计数', () => {
  it('rows 为空时返回固定形状与 0 计数，且不因缺少统计值抛错', () => {
    const p1024Meta = { total: 13924, source: 'stale' }
    const dshfindMeta = { total: 6222, format: 1 }
    const summary = sourceSummary({
      p1024Meta,
      dshfindMeta,
      rows: [],
      compat: { checked: 0, total: 0, done: 0 },
    })
    assert.deepEqual(summary, {
      '1024store': { meta: p1024Meta, rows: 0, users: 0 },
      dshfind: { meta: dshfindMeta, rows: 0, ratings: 0 },
      compat: { checked: 0, total: 0, done: 0 },
      counts: { rows: 0, withUsers: 0, withRating: 0, withStars: 0, withCompatibility: 0, withNpm: 0 },
    })
  })

  it('rows 非空时按来源分别统计，并区分 ok/bad 与 pending/no-package 的兼容性', () => {
    const p1024Meta = { total: 2 }
    const dshfindMeta = { total: 1 }
    const rows = buildCatalog({
      sourceRows: [
        normalize1024(p1024Item({
          id: 100,
          name: 'Acme Tool',
          url: 'https://deepseek1024.com/plugins/acme-tool',
          install: install('acme-tool'),
          installerCount: 10,
          npmDownloads7d: 5,
          stars: null,
          updatedAt: '2026-10-20T00:00:00.000Z',
        })),
        normalize1024(p1024Item({
          id: 101,
          name: 'Mono UI',
          url: 'https://github.com/acme/mono-ui',
          install: install('github:acme/mono-ui'),
          installerCount: 4,
          stars: 7,
        })),
        normalizeFormat1(
          format1Item({
            name: 'Mono UI',
            repository: { url: 'https://github.com/acme/mono-ui' },
            metadata: { sortKeys: { stars: 70 } },
          }),
          { sourceId: 'dshso', sourceName: 'dsh.so' },
        ),
        normalizeFormat1(
          format1Item({
            name: 'find-pkg',
            repository: { url: 'https://github.com/acme/find' },
            metadata: { sortKeys: { score: 88, stars: 300 } },
          }),
          { sourceId: 'dshfind', sourceName: 'dshfind' },
        ),
      ],
      compat: new Map([
        ['acme-tool', { status: 'ok', version: '2.0.0' }],
        ['find-pkg', { status: 'bad', version: '3.0.0' }],
      ]),
      now: NOW,
    })
    assert.equal(rows.length, 3)

    const summary = sourceSummary({
      p1024Meta,
      dshfindMeta,
      rows,
      compat: { checked: 2, total: 2, done: 2 },
    })
    assert.deepEqual(summary, {
      '1024store': { meta: p1024Meta, rows: 2, users: 2 },
      dshfind: { meta: dshfindMeta, rows: 1, ratings: 1 },
      compat: { checked: 2, total: 2, done: 2 },
      counts: { rows: 3, withUsers: 2, withRating: 1, withStars: 2, withCompatibility: 2, withNpm: 2 },
    })
  })
})
