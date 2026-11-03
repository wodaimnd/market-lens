/**
 * 不变量：身份 = 安装目标，不是显示名。
 *
 * 这是刚修完的真实回归：1024Store 的 item.name 与 format1 的 item.id 曾进入 key，
 * 把同一个安装目标拆成多行。这里每个 key 都断言完整字符串全等，不使用 includes，
 * 所以“把 name 拼回 key”的改动会立刻挂掉。
 *
 * 跑法：node --test tests/
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalize1024, normalizeFormat1, normalizeStandardItem } from '../lib/catalog.js'
import { format1Item, install, p1024Item, standardItem } from './fixtures.js'

describe('normalize1024：GitHub 身份只来自安装目标', () => {
  it('GitHub 根安装的 key 是 gh:<repo>，不得出现 item.name（修复点 1）', () => {
    const row = normalize1024(p1024Item({ name: 'Acme Tool 中文显示名' }))
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.equal(row.installable, true)
  })

  it('同一仓库、不同 id 与显示名必须得到同一个 key（否则 6,316 条重复行回归）', () => {
    const first = normalize1024(p1024Item({ id: 1, name: 'Acme Tool' }))
    const second = normalize1024(p1024Item({ id: 2, name: 'ACME 工具（重命名）' }))
    assert.equal(first.key, 'gh:https://github.com/acme/tool')
    assert.equal(second.key, 'gh:https://github.com/acme/tool')
  })

  it('install 串是 npm 包时 key 是 pkg:<小写包名>，显示名与 url 都不参与', () => {
    const row = normalize1024(p1024Item({
      name: 'Acme Tool',
      url: 'https://deepseek1024.com/plugins/acme-tool',
      install: install('@Acme/Tool'),
    }))
    assert.equal(row.key, 'pkg:@acme/tool')
    assert.equal(row.pkg, '@Acme/Tool')
  })

  it('install 串带 #path: 时子路径进入 key 并小写化，根安装不带后缀', () => {
    const root = normalize1024(p1024Item({ id: 3 }))
    const subpath = normalize1024(p1024Item({
      id: 4,
      install: install('github:acme/tool#path:Packages/Widget'),
    }))
    assert.equal(root.key, 'gh:https://github.com/acme/tool')
    assert.equal(subpath.key, 'gh:https://github.com/acme/tool#packages/widget')
  })

  it('url 不是 GitHub 时回落到 install 串里的 repo 作身份（不能退化成 <id> 身份）', () => {
    const row = normalize1024(p1024Item({ url: 'https://deepseek1024.com/plugins/acme-tool' }))
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.equal(row.repo, 'https://github.com/acme/tool')
  })

  it('profileName 只影响安装命令，不影响身份 key', () => {
    const row = normalize1024(p1024Item(), 'work')
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.equal(row.installCommand, 'dsh plugin --profile work add github:acme/tool')
  })
})

describe('normalizeFormat1：GitHub 身份不拼 item.id', () => {
  it('无 pkg 的条目 key 是 gh:<repo>，不得拼 item.id 或 name（修复点 2）', () => {
    const row = normalizeFormat1(
      format1Item({ id: 'row-42', name: 'Acme Tool' }),
      { sourceId: 'dshso', sourceName: 'dsh.so', sourceHomepage: 'https://www.dsh.so' },
    )
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.equal(row.pkg, null)
  })

  it('同一仓库、不同 id 的两个条目必须得到同一个 key（修复前 id 会拆行）', () => {
    const first = normalizeFormat1(format1Item({ id: 'a', name: 'Acme Tool' }), { sourceId: 'dshso' })
    const second = normalizeFormat1(format1Item({ id: 'b', name: 'Acme Tool 副本' }), { sourceId: 'dshso' })
    assert.equal(first.key, 'gh:https://github.com/acme/tool')
    assert.equal(second.key, 'gh:https://github.com/acme/tool')
  })

  it('dshfind 条目优先 npm 身份：pkg:<小写包名>，即使同时带仓库链接', () => {
    const row = normalizeFormat1(
      format1Item({ name: '@Acme/Tool' }),
      { sourceId: 'dshfind', sourceName: 'dshfind', sourceHomepage: 'https://dshfind.com' },
    )
    assert.equal(row.key, 'pkg:@acme/tool')
    assert.equal(row.repo, 'https://github.com/acme/tool')
  })

  it('非 dshfind 源且仓库存在时，像 npm 包的 name 也不得抢走仓库身份', () => {
    const row = normalizeFormat1(format1Item({ name: 'acme-tool' }), { sourceId: 'dshso' })
    assert.equal(row.key, 'gh:https://github.com/acme/tool')
    assert.equal(row.pkg, null)
  })
})

describe('normalizeStandardItem：package 优先，仓库靠 subdirectory 区分安装目标', () => {
  it('有 package.name 时 key 是 pkg:<小写包名>，repository 与 subdirectory 不参与', () => {
    const row = normalizeStandardItem(
      standardItem({
        package: { name: '@Acme/Tool' },
        repository: { url: 'https://github.com/acme/tool', subdirectory: 'packages/widget' },
      }),
      { sourceId: 'standard', sourceName: '标准源' },
    )
    assert.equal(row.key, 'pkg:@acme/tool')
    assert.equal(row.pkg, '@Acme/Tool')
  })

  it('无 package.name 时用 repository.url + repository.subdirectory 拼 key（子目录小写化）', () => {
    const root = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool' } }),
      { sourceId: 'standard' },
    )
    const subpath = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool', subdirectory: 'Packages/Widget' } }),
      { sourceId: 'standard' },
    )
    assert.equal(root.key, 'gh:https://github.com/acme/tool')
    assert.equal(subpath.key, 'gh:https://github.com/acme/tool#packages/widget')
  })

  it('既无 package 又无仓库时返回 null，不能只凭 name 造出可安装行', () => {
    const row = normalizeStandardItem(standardItem({ package: undefined, repository: undefined }), { sourceId: 'standard' })
    assert.equal(row, null)
  })
})

describe('三个归一化函数对同一安装目标给出同一个 key', () => {
  it('1024 根安装 / format1(dshso) / standard 根仓库 → 全部 gh:<repo>', () => {
    const from1024 = normalize1024(p1024Item())
    const fromFormat1 = normalizeFormat1(format1Item(), { sourceId: 'dshso' })
    const fromStandard = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool' } }),
      { sourceId: 'standard' },
    )
    assert.equal(from1024.key, 'gh:https://github.com/acme/tool')
    assert.equal(fromFormat1.key, 'gh:https://github.com/acme/tool')
    assert.equal(fromStandard.key, 'gh:https://github.com/acme/tool')
  })
})

describe('身份边界：斜杠归一与安装目标优先', () => {
  it('repository.subdirectory 带首尾斜杠时与不带斜杠得到同一个 key', () => {
    const bare = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool', subdirectory: 'packages/widget' } }),
      { sourceId: 'standard' },
    )
    const leading = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool', subdirectory: '/packages/widget' } }),
      { sourceId: 'standard' },
    )
    const trailing = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool', subdirectory: 'packages/widget/' } }),
      { sourceId: 'standard' },
    )
    assert.equal(bare.key, 'gh:https://github.com/acme/tool#packages/widget')
    assert.equal(leading.key, bare.key)
    assert.equal(trailing.key, bare.key)
  })

  it('标准源的 subdirectory 与 1024 的 #path: 指向同一子目录时必须同 key', () => {
    const standard = normalizeStandardItem(
      standardItem({ repository: { url: 'https://github.com/acme/tool', subdirectory: '/packages/widget' } }),
      { sourceId: 'standard' },
    )
    const from1024 = normalize1024(p1024Item({ install: install('github:acme/tool#path:packages/widget') }))
    assert.equal(from1024.key, 'gh:https://github.com/acme/tool#packages/widget')
    assert.equal(standard.key, from1024.key)
  })

  it('url 指向 A 而 install 指向 B 时，key / repo / 安装命令三者都跟随 B', () => {
    const row = normalize1024(
      p1024Item({ url: 'https://github.com/acme/one', install: install('github:acme/two') }),
    )
    assert.equal(row.key, 'gh:https://github.com/acme/two')
    assert.equal(row.repo, 'https://github.com/acme/two')
    assert.equal(row.installCommand, 'dsh plugin --profile desktop add github:acme/two')
  })
})
