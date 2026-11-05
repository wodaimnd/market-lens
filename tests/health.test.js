/**
 * 装机体检（lib/health.js）回归。
 *
 * 这些断言全部来自真机踩过的坑，不是想象出来的分支：
 *   1. 管理器返回的 name 带版本（`pkg@1.7.15`）—— 直接拿去和 bundles 比会永远不等，
 *      于是「装好了也报没挂载」。dsh-mp-automator 那次真实日志就是 packageName
 *      `dsh-mp-automator@0.3.0` + mounted=false。
 *   2. 包自带 cordis.patch.yml 里某行 name 解析不到 —— 宿主半身与浏览器半身一起不挂，
 *      dsh 不报错。humanizer-ru 的 `@deepseek-ai/dsh-skill-filesystem` 是活样本。
 *   3. exports 没导出 `.` 的包，require.resolve 会 ERR_PACKAGE_PATH_NOT_EXPORTED，
 *      但 loader 只看目录里有没有 package.json —— 这类绝不能报成故障。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyRowName, inspectInstalledHealth, inspectPatchRows, parsePatchRows } from '../lib/health.js'

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'market-lens-health-'))
}

function writePackage(profileDir, name, manifest, extra = {}) {
  const dir = path.join(profileDir, 'node_modules', ...name.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, content] of Object.entries(extra)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
  }
  return dir
}

describe('parsePatchRows：只认 insert 段里的 id/name 对', () => {
  it('解析相对路径行与带引号的裸名', () => {
    const rows = parsePatchRows([
      '- insert:',
      '    - id: gate',
      "      name: './native/index.js'",
      '    - id: clawbot',
      "      name: 'dsh-wechat-remote/clawbot'",
    ].join('\n'))
    assert.deepEqual(rows, [
      { id: 'gate', name: './native/index.js' },
      { id: 'clawbot', name: 'dsh-wechat-remote/clawbot' },
    ])
  })

  it('insert 段外的 name 不算装载行', () => {
    const rows = parsePatchRows(['- patch:', '    - id: x', "      name: 'not-a-row'"].join('\n'))
    assert.deepEqual(rows, [])
  })

  it('没有 name 的 id 行被丢掉，注释行跳过', () => {
    const rows = parsePatchRows(['# 注释', '- insert:', '    - id: orphan', "    - id: real", "      name: '@scope/pkg'"].join('\n'))
    assert.deepEqual(rows, [{ id: 'real', name: '@scope/pkg' }])
  })
})

describe('classifyRowName：判据必须与 loader 一致', () => {
  it('相对路径按 patch 所在目录解析', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'row-path-'))
    fs.mkdirSync(path.join(dir, 'native'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'native', 'index.js'), 'export const name = "gate"')
    const ok = classifyRowName('./native/index.js', { packageDir: dir, profileDir: dir })
    assert.equal(ok.status, 'ok')
    assert.ok(ok.detail.includes('native'))
    const missing = classifyRowName('./nope/index.js', { packageDir: dir, profileDir: dir })
    assert.equal(missing.status, 'unresolved')
  })

  it('包内自引用走包自己的 exports', () => {
    const profileDir = tmpProfile()
    const dir = writePackage(profileDir, 'self-ref-pkg', {
      name: 'self-ref-pkg',
      version: '1.0.0',
      exports: { './sub': './lib/sub.js' },
    }, { 'lib/sub.js': 'export default 1' })
    const row = classifyRowName('self-ref-pkg/sub', { packageDir: dir, profileDir })
    assert.equal(row.status, 'ok')
    assert.equal(row.resolved, path.join(dir, 'lib', 'sub.js'))
  })

  it('exports 没导出 "." 时不算故障：loader 只看 package.json', () => {
    const profileDir = tmpProfile()
    const dir = writePackage(profileDir, 'no-root-export', {
      name: 'no-root-export',
      version: '1.0.0',
      exports: { './sub': './lib/sub.js' },
    }, { 'lib/sub.js': 'export default 1' })
    // 这是 dsh-wechat-remote 的真实形态：require.resolve('dsh-wechat-remote') 报
    // ERR_PACKAGE_PATH_NOT_EXPORTED，但 bundle 本身挂得上。
    const row = classifyRowName('no-root-export', { packageDir: dir, profileDir })
    assert.equal(row.status, 'ok')
    assert.equal(row.kind, 'bare')
  })

  it('真的不存在的包里解析不到 → unresolved', () => {
    const profileDir = tmpProfile()
    const dir = writePackage(profileDir, 'plain-pkg', { name: 'plain-pkg', version: '1.0.0', exports: { '.': './index.js' } })
    const row = classifyRowName('plain-pkg/missing-sub', { packageDir: dir, profileDir })
    assert.equal(row.status, 'unresolved')
  })

  it('!!js 表达式与空 name 判为 unknown，不下结论', () => {
    assert.equal(classifyRowName('!!js ctx.x', {}).status, 'unknown')
    assert.equal(classifyRowName('', {}).status, 'unknown')
  })
})

describe('inspectInstalledHealth：装完之后到底能不能加载', () => {
  it('依赖在、bundles 在、patch 行全通 → ok', () => {
    const profileDir = tmpProfile()
    const dir = writePackage(profileDir, 'good-pkg', {
      name: 'good-pkg',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, {
      'cordis.patch.yml': ['- insert:', '    - id: gate', "      name: './index.js'"].join('\n'),
      'index.js': 'export const name = "gate"',
    })
    const health = inspectInstalledHealth({ profileDir, packageName: 'good-pkg', bundles: ['good-pkg'], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.verdict, 'ok')
    assert.equal(health.mounted, true)
    assert.equal(health.unmounted, false)
    assert.equal(health.rows.length, 1)
    assert.equal(health.patch.exists, true)
    void dir
  })

  it('依赖在、bundles 没有 → warn + unmounted（「装了但不出现」）', () => {
    const profileDir = tmpProfile()
    writePackage(profileDir, 'unmounted-pkg', {
      name: 'unmounted-pkg',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const health = inspectInstalledHealth({ profileDir, packageName: 'unmounted-pkg', bundles: [], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.verdict, 'warn')
    assert.equal(health.unmounted, true)
    assert.match(health.detail, /bundles/)
  })

  it('装载行解析不到 → bad，并把行名报出来', () => {
    const profileDir = tmpProfile()
    writePackage(profileDir, 'bad-row-pkg', {
      name: 'bad-row-pkg',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, {
      'cordis.patch.yml': ['- insert:', '    - id: skills', "      name: '@deepseek-ai/dsh-skill-filesystem'"].join('\n'),
    })
    const health = inspectInstalledHealth({ profileDir, packageName: 'bad-row-pkg', bundles: ['bad-row-pkg'], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.verdict, 'bad')
    assert.equal(health.rows[0].status, 'unresolved')
    assert.match(health.detail, /dsh-skill-filesystem/)
  })

  it('peer 与运行时冲突 → bad，且不因为 patch 通过就报 ok', () => {
    const profileDir = tmpProfile()
    writePackage(profileDir, 'peer-pkg', {
      name: 'peer-pkg',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/dsh': '>=99.0.0' },
    })
    const health = inspectInstalledHealth({ profileDir, packageName: 'peer-pkg', bundles: ['peer-pkg'], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.verdict, 'bad')
    assert.equal(health.peers.status, 'bad')
    assert.deepEqual(health.peers.unmet, ['@deepseek-ai/dsh'])
  })

  it('engines.dsh 优先于 peer（与 app-boot 的口径一致）', () => {
    const profileDir = tmpProfile()
    writePackage(profileDir, 'engines-pkg', {
      name: 'engines-pkg',
      version: '1.0.0',
      engines: { dsh: '>=0.2.0' },
      peerDependencies: { '@deepseek-ai/dsh': '>=99.0.0' },
    })
    const health = inspectInstalledHealth({ profileDir, packageName: 'engines-pkg', bundles: [], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.peers.status, 'ok')
    assert.equal(health.peers.reason, 'engines-dsh')
  })

  it('普通依赖（没有 dsh.bundle）不报「没挂载」', () => {
    const profileDir = tmpProfile()
    writePackage(profileDir, 'plain-dep', { name: 'plain-dep', version: '1.0.0' })
    const health = inspectInstalledHealth({ profileDir, packageName: 'plain-dep', bundles: [], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.verdict, 'ok')
    assert.equal(health.isBundle, false)
    assert.equal(health.mounted, null)
    assert.equal(health.unmounted, false)
  })

  it('包根本不在 node_modules → installed:false，不冒充成功', () => {
    const profileDir = tmpProfile()
    const health = inspectInstalledHealth({ profileDir, packageName: 'ghost-pkg', bundles: [], runtimeVersion: '0.2.1-rc.5' })
    assert.equal(health.installed, false)
    assert.equal(health.verdict, 'skipped')
  })

  it('拿不到包名时直接跳过，不编造结论', () => {
    const health = inspectInstalledHealth({ profileDir: tmpProfile(), packageName: null, bundles: [] })
    assert.equal(health.verdict, 'skipped')
    assert.equal(health.detail, 'unresolved-package-name')
  })

  it('inspectPatchRows 在没有 patch 文件时返回空集，不误报', () => {
    const profileDir = tmpProfile()
    const dir = writePackage(profileDir, 'no-patch', { name: 'no-patch', version: '1.0.0', dsh: { bundle: true } })
    const result = inspectPatchRows(dir, profileDir, 'no-patch')
    assert.equal(result.exists, false)
    assert.deepEqual(result.rows, [])
  })
})

test('真机形态：dsh-wechat-remote 那种 exports 无 "." 的包不应被报成故障', () => {
  const profileDir = tmpProfile()
  writePackage(profileDir, 'dsh-wechat-remote', {
    name: 'dsh-wechat-remote',
    version: '1.7.15',
    exports: { './clawbot': './native/lib/clawbot-component.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'cordis.patch.yml': ['- insert:', '    - id: gate', "      name: './native/index.js'", '    - id: clawbot', "      name: 'dsh-wechat-remote/clawbot'"].join('\n'),
    'native/index.js': 'export const name = "gate"',
    'native/lib/clawbot-component.js': 'export default 1',
  })
  const health = inspectInstalledHealth({ profileDir, packageName: 'dsh-wechat-remote', bundles: ['dsh-wechat-remote'], runtimeVersion: '0.2.1-rc.5' })
  assert.equal(health.verdict, 'ok', JSON.stringify(health.rows, null, 2))
  assert.equal(health.rows.length, 2)
})
