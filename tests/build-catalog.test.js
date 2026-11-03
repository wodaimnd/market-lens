/**
 * buildCatalog 的合并语义：只有安装目标相同才允许合并。
 * 这些用例防的是两类回归：同一安装目标被拆行、不同安装目标被错误合并。
 *
 * 跑法：node --test tests/
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildCatalog, normalize1024, normalizeFormat1, normalizeStandardItem } from '../lib/catalog.js'
import { format1Item, install, p1024Item, standardItem } from './fixtures.js'

const NOW = Date.parse('2026-11-02T00:00:00.000Z')

function build(sourceRows, options = {}) {
  return buildCatalog({ sourceRows, now: NOW, ...options })
}

describe('buildCatalog 合并：同一安装目标只有一行', () => {
  it('1024 根安装 + format1 无 pkg 同仓库 → 一行，sources 同时保留两个来源标签', () => {
    const row1024 = normalize1024(p1024Item({ id: 9001, installerCount: 55, stars: null }))
    const rowFormat1 = normalizeFormat1(
      format1Item({ description: '来自 dsh.so 的描述', metadata: { category: 'ui', sortKeys: { stars: 321 } } }),
      { sourceId: 'dshso', sourceName: 'dsh.so', sourceHomepage: 'https://www.dsh.so' },
    )
    assert.equal(row1024.key, 'gh:https://github.com/acme/tool')
    assert.equal(rowFormat1.key, 'gh:https://github.com/acme/tool')

    const rows = build([row1024, rowFormat1])
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.deepEqual([...row.sources].sort(), ['1024store', 'dshso'])
    assert.deepEqual(row.sourceIds, { '1024store': '9001', dshso: 'Acme Tool' })
    assert.equal(row.installers, 55)
    assert.equal(row.stars, 321)
    assert.equal(row.description, '来自 1024Store 的描述')
    assert.equal(row.descriptionSource, '1024store')
    assert.deepEqual(row.compat, { status: 'no-package', reason: 'github-only' })
  })

  it('两个 1024 条目只有 id/显示名不同 → 仍是一行（name 进 key 的回归）', () => {
    const rows = build([
      normalize1024(p1024Item({ id: 1, name: 'Acme Tool' })),
      normalize1024(p1024Item({ id: 2, name: 'Acme Tool 中文版' })),
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, 'gh:https://github.com/acme/tool')
    assert.deepEqual(rows[0].sources, ['1024store'])
  })

  it('同一仓库不同 #path: 子目录 → 两行；仓库根安装另成一行，三者不得互相合并', () => {
    const root = normalize1024(p1024Item({ id: 10 }))
    const alpha = normalize1024(p1024Item({ id: 11, install: install('github:acme/tool#path:packages/alpha') }))
    const beta = normalizeStandardItem(
      standardItem({
        package: undefined,
        repository: { url: 'https://github.com/acme/tool', subdirectory: 'packages/beta' },
      }),
      { sourceId: 'standard', sourceName: '标准源' },
    )
    assert.equal(alpha.key, 'gh:https://github.com/acme/tool#packages/alpha')
    assert.equal(beta.key, 'gh:https://github.com/acme/tool#packages/beta')

    const rows = build([root, alpha, beta])
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((row) => row.key).sort(), [
      'gh:https://github.com/acme/tool',
      'gh:https://github.com/acme/tool#packages/alpha',
      'gh:https://github.com/acme/tool#packages/beta',
    ])
    for (const row of rows) assert.equal(row.sources.length, 1)
  })

  it('同一 npm 包来自 1024 与 dshfind → 一行，pkg 身份保留且仓库信息补全', () => {
    const row1024 = normalize1024(p1024Item({
      id: 20,
      name: 'Acme Tool',
      url: 'https://deepseek1024.com/plugins/acme-tool',
      install: install('acme-tool'),
      installerCount: 9,
      stars: null,
    }))
    const rowFind = normalizeFormat1(
      format1Item({
        name: 'acme-tool',
        repository: { url: 'https://github.com/acme/tool' },
        metadata: { sortKeys: { stars: 10, score: 77 } },
      }),
      { sourceId: 'dshfind', sourceName: 'dshfind' },
    )
    assert.equal(row1024.key, 'pkg:acme-tool')
    assert.equal(rowFind.key, 'pkg:acme-tool')

    const rows = build([row1024, rowFind])
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.key, 'pkg:acme-tool')
    assert.deepEqual([...row.sources].sort(), ['1024store', 'dshfind'])
    assert.equal(row.pkg, 'acme-tool')
    assert.equal(row.repo, 'https://github.com/acme/tool')
    assert.equal(row.installers, 9)
    assert.equal(row.stars, 10)
    assert.equal(row.score, 77)
  })

  it('同一仓库、不同 npm 包 → 两行（monorepo 的不同安装目标不能合并）', () => {
    const rows = build([
      normalize1024(p1024Item({ id: 30, url: 'https://deepseek1024.com/plugins/acme-tool', install: install('acme-tool') })),
      normalize1024(p1024Item({ id: 31, url: 'https://deepseek1024.com/plugins/acme-ui', install: install('@acme/ui') })),
    ])
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.key).sort(), ['pkg:@acme/ui', 'pkg:acme-tool'])
  })
})

describe('buildCatalog 合并：字段取非空值，不被 null 覆盖', () => {
  function crossSourcePair() {
    const row1024 = normalize1024(p1024Item({
      id: 40,
      installerCount: 120,
      installCount: 300,
      npmDownloads7d: null,
      stars: null,
      pushedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }))
    const rowFormat1 = normalizeFormat1(
      format1Item({
        name: 'Acme Tool', // 非 npm 名，保持仓库身份
        versions: [{ version: '1.2.3', publishTimestamp: '2026-11-01T12:00:00.000Z' }],
        metadata: { category: 'tools', sortKeys: { stars: 42, downloads: 7 } },
        description: '来自 dsh.so 的描述',
      }),
      { sourceId: 'dshso', sourceName: 'dsh.so' },
    )
    return { row1024, rowFormat1 }
  }

  it('updatedAt 取较新值，installers 不被 null 覆盖，stars/downloads 由另一来源补齐', () => {
    const { row1024, rowFormat1 } = crossSourcePair()
    assert.equal(row1024.key, 'gh:https://github.com/acme/tool')
    assert.equal(rowFormat1.key, 'gh:https://github.com/acme/tool')

    const rows = build([row1024, rowFormat1])
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.updatedAt, '2026-11-01T12:00:00.000Z')
    assert.equal(row.updatedFrom, 'npm-publish')
    assert.equal(row.installers, 120)
    assert.equal(row.installs, 300)
    assert.equal(row.stars, 42)
    assert.equal(row.downloads, 7)
    assert.equal(row.version, '1.2.3')
    assert.equal(row.description, '来自 1024Store 的描述')
    assert.notEqual(row.installers, null)
    assert.notEqual(row.stars, null)
  })

  it('先 format1 后 1024 的合并方向同样不会把字段清空', () => {
    const { row1024, rowFormat1 } = crossSourcePair()
    const rows = build([rowFormat1, row1024])
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.equal(row.installers, 120)
    assert.equal(row.stars, 42)
    assert.equal(row.updatedAt, '2026-11-01T12:00:00.000Z')
    assert.equal(row.updatedFrom, 'npm-publish')
  })
})
