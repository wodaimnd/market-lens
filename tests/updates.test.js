/**
 * 版本比较与「可更新」判定的不变式。
 *
 * 这里断言的是语义：差几个层级（major/minor/patch/prerelease）、谁更新、
 * 以及官方通道与 npm 兜底的来源标注。界面上的「可更新到 x.y.z」直接读这些字段，
 * 比较一旦搞反，用户就会被引导去"升级"到一个更旧的版本。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { UpdateService, buildVersionChain, compareVersions, isRegistryCandidate, parseVersion } from '../lib/updates.js'

describe('parseVersion：只认完整 semver', () => {
  it('接受主/次/补丁与预发布', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
    assert.deepEqual(parseVersion('v2.0.0-beta.1'), { major: 2, minor: 0, patch: 0, prerelease: ['beta', '1'] })
  })

  it('range 与不完整版本返回 null', () => {
    assert.equal(parseVersion('^1.2.3'), null)
    assert.equal(parseVersion('1.2'), null)
    assert.equal(parseVersion(null), null)
  })
})

describe('compareVersions：方向与层级', () => {
  it('补丁/次/主版本各归各的层级', () => {
    assert.deepEqual(
      { ...compareVersions('1.2.3', '1.2.4') },
      { available: true, kind: 'patch', from: '1.2.3', to: '1.2.4', reason: 'update-available' },
    )
    assert.equal(compareVersions('1.2.3', '1.3.0').kind, 'minor')
    assert.equal(compareVersions('1.2.3', '2.0.0').kind, 'major')
  })

  it('同版本不给更新徽标', () => {
    const result = compareVersions('1.2.3', '1.2.3')
    assert.equal(result.available, false)
    assert.equal(result.kind, 'same')
  })

  it('本地比源上还新时标 ahead，而不是"可更新"', () => {
    const result = compareVersions('2.0.0', '1.9.9')
    assert.equal(result.available, false)
    assert.equal(result.kind, 'ahead')
  })

  it('预发布转正式算更新，正式退回预发布不算', () => {
    assert.equal(compareVersions('1.2.3-beta.1', '1.2.3').kind, 'prerelease')
    assert.equal(compareVersions('1.2.3-beta.1', '1.2.3').available, true)
    assert.equal(compareVersions('1.2.3', '1.2.3-beta.1').available, false)
    assert.equal(compareVersions('1.2.3', '1.2.3-beta.1').kind, 'ahead')
  })

  it('版本号不可解析时给 unknown，不猜', () => {
    const result = compareVersions('1.2', '1.3.0')
    assert.equal(result.available, false)
    assert.equal(result.kind, 'unknown')
    assert.equal(compareVersions('1.2.3', null).kind, 'unknown')
  })
})

describe('buildVersionChain：(from, to] 之间的发布链', () => {
  const packument = {
    'dist-tags': { latest: '2.0.0', next: '2.1.0-beta.1' },
    time: {
      '1.0.0': '2024-01-01T00:00:00.000Z',
      '1.1.0': '2024-02-01T00:00:00.000Z',
      '2.0.0': '2024-03-01T00:00:00.000Z',
      '2.1.0-beta.1': '2024-04-01T00:00:00.000Z',
    },
    versions: {
      '1.0.0': { name: 'pkg' },
      '1.1.0': { name: 'pkg', engines: { dsh: '>=0.6.0' } },
      '2.0.0': { name: 'pkg' },
      '2.1.0-beta.1': { name: 'pkg' },
    },
  }

  it('只保留 (from, to] 区间的版本，按升序', () => {
    const chain = buildVersionChain('pkg', packument, { from: '1.0.0', to: '2.0.0' })
    assert.deepEqual(chain.versions.map((item) => item.version), ['1.1.0', '2.0.0'])
    assert.equal(chain.total, 2)
    assert.equal(chain.latest, '2.0.0')
  })

  it('跨主版本的条目打 breaking，engines.dsh 带出来', () => {
    const chain = buildVersionChain('pkg', packument, { from: '1.0.0', to: '2.0.0' })
    const minor = chain.versions.find((item) => item.version === '1.1.0')
    const major = chain.versions.find((item) => item.version === '2.0.0')
    assert.equal(minor.breaking, false)
    assert.equal(minor.enginesDsh, '>=0.6.0')
    assert.equal(major.breaking, true)
    assert.equal(minor.publishedAt, '2024-02-01T00:00:00.000Z')
  })

  it('预发布被标出来，且不会被当成正式版', () => {
    const chain = buildVersionChain('pkg', packument, { from: '2.0.0', to: '2.1.0-beta.1' })
    assert.deepEqual(chain.versions.map((item) => item.version), ['2.1.0-beta.1'])
    assert.equal(chain.versions[0].prerelease, true)
  })

  it('给了 limit 只保留最近若干个，但 total 仍是全集', () => {
    const chain = buildVersionChain('pkg', packument, { from: '1.0.0', to: '2.1.0-beta.1', limit: 1 })
    assert.equal(chain.versions.length, 1)
    assert.equal(chain.total, 3)
  })
})

describe('UpdateService：官方优先，npm 兜底', () => {
  const compat = (version) => ({ get: (pkg) => (version ? { version, status: 'ok', checkedAt: '2026-01-01T00:00:00.000Z' } : null) })

  it('官方 inspect 接受时用官方版本，并记录 registry', async () => {
    const service = new UpdateService({
      compat: compat('9.9.9'),
      getManager: () => ({
        inspect: async () => ({ status: 'accepted', version: '1.4.0', name: 'pkg', registry: 'https://npm.example.com' }),
      }),
    })
    const entry = await service.resolve({ pkg: 'pkg', installed: '1.2.3' })
    assert.equal(entry.source, 'pluginManager')
    assert.equal(entry.latest, '1.4.0')
    assert.equal(entry.available, true)
    assert.equal(entry.kind, 'minor')
    assert.equal(entry.registry, 'https://npm.example.com')
  })

  it('官方拒绝时退回 npm latest，来源标成 npm', async () => {
    const service = new UpdateService({
      compat: compat('1.2.5'),
      getManager: () => ({ inspect: async () => ({ status: 'refused', problem: 'not-found' }) }),
    })
    const entry = await service.resolve({ pkg: 'pkg', installed: '1.2.3' })
    assert.equal(entry.source, 'npm')
    assert.equal(entry.latest, '1.2.5')
    assert.equal(entry.kind, 'patch')
  })

  it('没有任何管理器时也能给结论（compat 缓存即 npm latest）', async () => {
    const service = new UpdateService({ compat: compat('2.0.0'), getManager: () => null })
    const entry = await service.resolve({ pkg: 'pkg', installed: '1.0.0' })
    assert.equal(entry.source, 'npm')
    assert.equal(entry.kind, 'major')
    assert.equal(entry.available, true)
  })

  it('check 只跑过期的包；status 汇总已检查数量', async () => {
    let calls = 0
    const service = new UpdateService({
      compat: compat('1.0.1'),
      getManager: () => ({ inspect: async () => { calls += 1; return { status: 'accepted', version: '1.0.1' } } }),
    })
    await service.check([{ pkg: 'a', installed: '1.0.0' }], { force: false })
    await service.check([{ pkg: 'a', installed: '1.0.0' }], { force: false })
    assert.equal(calls, 1)
    const status = service.status()
    assert.equal(status.checked, 1)
    assert.equal(status.available, 1)
    assert.equal(status.running, false)
  })

  it('stale 按 checkedAt 判断，坏时间视为过期', () => {
    const service = new UpdateService({ now: () => Date.parse('2026-01-02T00:00:00.000Z') })
    // TTL 是 30 分钟：15 分钟前算新鲜，40 分钟前就该重查
    assert.equal(service.stale({ checkedAt: '2026-01-01T23:45:00.000Z' }), false)
    assert.equal(service.stale({ checkedAt: '2026-01-01T23:20:00.000Z' }), true)
    assert.equal(service.stale({ checkedAt: 'not-a-date' }), true)
    assert.equal(service.stale(null), true)
  })
})

/**
 * 0.4.0 的闸：本地装法（@local/*、link:、github:）不该被丢给 pnpm inspect。
 * 0.3.x 那么做过，pnpm 每次回 invalid-spec / already-installed，
 * 失败记录堆在 .plugin-manager/logs 里，官方插件页就把这些 bundle 标成异常。
 */
describe('isRegistryCandidate：只问 registry 上真正存在的包', () => {
  it('registry 包放行', () => {
    assert.equal(isRegistryCandidate('semver', '^7.7.3'), true)
    assert.equal(isRegistryCandidate('@scope/name', null), true)
    assert.equal(isRegistryCandidate('@scope/name', '1.2.3'), true)
  })

  it('本地装法全部拦掉', () => {
    assert.equal(isRegistryCandidate('@local/market-lens', null), false)
    assert.equal(isRegistryCandidate('@local/apk-lab', 'link:G:/x/y'), false)
    assert.equal(isRegistryCandidate('somepkg', 'link:../somepkg'), false)
    assert.equal(isRegistryCandidate('somepkg', 'file:./pkg.tgz'), false)
    assert.equal(isRegistryCandidate('somepkg', 'workspace:*'), false)
    assert.equal(isRegistryCandidate('somepkg', 'github:owner/repo'), false)
    assert.equal(isRegistryCandidate('somepkg', 'git+https://example.com/a.git'), false)
    assert.equal(isRegistryCandidate('somepkg', 'C:\\work\\pkg'), false)
    assert.equal(isRegistryCandidate('', null), false)
  })

  it('被拦下的包不出现在 resolve 的检查结果里，也不留 error', async () => {
    let inspected = 0
    const service = new UpdateService({
      compat: { get: () => ({ version: '9.9.9' }) },
      getManager: () => ({ inspect: async () => { inspected += 1; return { status: 'accepted', version: '9.9.9' } } }),
    })
    const entry = await service.resolve({ pkg: '@local/market-lens', installed: '0.3.5', spec: 'link:G:/AI PGRM/DSH/plugins/market-lens' })
    assert.equal(inspected, 0)
    assert.equal(entry.source, 'skipped')
    assert.equal(entry.kind, 'local')
    assert.equal(entry.available, false)
    assert.equal(entry.error, null)
    await service.check([{ pkg: '@local/market-lens', installed: '0.3.5', spec: 'link:x' }], { force: true })
    assert.equal(service.status().source, 'idle')
  })

  it('官方回 already-installed 时当作「没有新版本」，不算错误', async () => {
    let calls = 0
    const service = new UpdateService({
      compat: { get: () => null },
      getManager: () => ({ inspect: async () => { calls += 1; return { status: 'refused', problem: 'already-installed' } } }),
    })
    const entry = await service.resolve({ pkg: 'pkg', installed: '1.0.0' })
    assert.equal(calls, 1)
    assert.equal(entry.error, null)
    assert.equal(entry.available, false)
  })
})
