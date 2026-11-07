/**
 * postinstall 检测回归：装的包会不会改写你的 profile。
 *
 * 现场事故（2026-11-07，dsh-purge 1.1.92）：
 *   pnpm 日志：
 *     node_modules/dsh-purge postinstall$ node scripts/ensure-profile-bundle.mjs
 *     dsh-purge: appended to bundles (profiles\next)
 *     dsh-purge: wrote body insert (profiles\next\cordis.patch.yml)
 *
 *   装完之后 profile 的 cordis.patch.yml 多出一整段 insert，
 *   里面 inject: [systemPrompt, tools] —— 拿到了系统提示词注入权。
 *
 *   安装本身是成功的，所以四层体检全绿。但这件事用户必须**装之前**知道。
 *
 * 为什么 DSH 不报：宿主的 pendingBuilds 只在 pnpm **失败**时记录；
 * 构建脚本被允许并跑成功之后，它改了什么没人知道。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  POSTINSTALL_VERDICTS,
  collectInstallHooks,
  inspectInstalledPackageHooks,
  inspectPostinstall,
} from '../lib/postinstall.js'

describe('collectInstallHooks：三种安装钩子', () => {
  it('postinstall 被收集', () => {
    const hooks = collectInstallHooks({ scripts: { postinstall: 'node setup.mjs' } })
    assert.deepEqual(hooks, [{ hook: 'postinstall', command: 'node setup.mjs' }])
  })

  it('preinstall / install / postinstall 都算，test/build 不算', () => {
    const hooks = collectInstallHooks({
      scripts: {
        test: 'node --test',
        build: 'tsc',
        preinstall: 'echo pre',
        install: 'echo inst',
        postinstall: 'echo post',
      },
    })
    assert.deepEqual(hooks.map((entry) => entry.hook), ['preinstall', 'install', 'postinstall'])
  })

  it('没有 scripts → 空数组', () => {
    assert.deepEqual(collectInstallHooks({}), [])
    assert.deepEqual(collectInstallHooks(null), [])
    assert.deepEqual(collectInstallHooks({ scripts: null }), [])
  })

  it('空白命令被忽略', () => {
    assert.deepEqual(collectInstallHooks({ scripts: { postinstall: '   ' } }), [])
  })
})

describe('inspectPostinstall：两档判据', () => {
  it('没有安装钩子 → none', () => {
    const result = inspectPostinstall({ scripts: { test: 'node --test' } })
    assert.equal(result.verdict, POSTINSTALL_VERDICTS.none)
    assert.equal(result.detail, null)
  })

  it('命令里提到 cordis.patch → writes-profile（真机 dsh-purge 的形状）', () => {
    // dsh-purge 的 postinstall 实际是 `node scripts/ensure-profile-bundle.mjs`，
    // 光看命令看不出会改什么 —— 但它在**脚本里**改了 profiles/next/cordis.patch.yml。
    // 所以我们只能确定"它会跑代码"，见下一条测试。这里先测命令直接提到的情况。
    const result = inspectPostinstall({
      scripts: { postinstall: 'node scripts/write-cordis.patch.mjs' },
    })
    assert.equal(result.verdict, POSTINSTALL_VERDICTS.writesProfile)
    assert.equal(result.touchesProfile, true)
    assert.match(result.detail, /改写你的 profile/)
  })

  it('命令里提到 bundles / dsh.profile / profiles 都判 writes-profile', () => {
    for (const command of [
      'node scripts/ensure-profile-bundle.mjs',
      'node -e "write dsh.profile.bundles"',
      'sh -c "sed -i s/x/y/ profiles/next/package.json"',
    ]) {
      const result = inspectPostinstall({ scripts: { postinstall: command } })
      assert.equal(result.verdict, POSTINSTALL_VERDICTS.writesProfile, command)
    }
  })

  it('看不出改 profile 的钩子 → runs-build（不装作知道它在干什么）', () => {
    const result = inspectPostinstall({ scripts: { postinstall: 'node-gyp rebuild' } })
    assert.equal(result.verdict, POSTINSTALL_VERDICTS.runsBuild)
    assert.equal(result.touchesProfile, false)
    assert.match(result.detail, /任意代码/)
    // 必须给出自查手段，不能只说"我不知道"
    assert.match(result.detail, /cordis\.patch/)
  })

  it('detail 里带出完整命令，让用户自己判断', () => {
    const result = inspectPostinstall({ scripts: { postinstall: 'node x.mjs --flag' } })
    assert.match(result.detail, /postinstall: node x\.mjs --flag/)
  })
})

describe('inspectInstalledPackageHooks：读磁盘', () => {
  function makePackage(manifest) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-post-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
    return dir
  }

  it('从磁盘读出 postinstall', () => {
    const dir = makePackage({ name: 'p', scripts: { postinstall: 'node setup.mjs' } })
    try {
      const result = inspectInstalledPackageHooks(dir)
      assert.equal(result.verdict, POSTINSTALL_VERDICTS.runsBuild)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录不存在时返回 none，不崩也不猜', () => {
    const result = inspectInstalledPackageHooks('/definitely/not/here')
    assert.equal(result.verdict, POSTINSTALL_VERDICTS.none)
  })

  it('null 路径返回 none', () => {
    assert.equal(inspectInstalledPackageHooks(null).verdict, POSTINSTALL_VERDICTS.none)
  })

  it('package.json 坏掉时返回 none（读不出来不等于有问题）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-post-bad-'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{ broken')
    try {
      assert.equal(inspectInstalledPackageHooks(dir).verdict, POSTINSTALL_VERDICTS.none)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('真机样本：dsh-purge 那条 postinstall 必须被标出来', () => {
  // 真实命令是 `node scripts/ensure-profile-bundle.mjs`。
  // 命令文本里带 "profile-bundle" → 命中 PROFILE_TOUCHING 的 profiles?/bundles，
  // 所以判 writes-profile。这是保守但正确的：它确实改了 profile。
  const manifest = {
    name: 'dsh-purge',
    version: '1.1.92',
    scripts: { postinstall: 'node scripts/ensure-profile-bundle.mjs' },
  }
  const result = inspectPostinstall(manifest)
  assert.equal(result.verdict, POSTINSTALL_VERDICTS.writesProfile)
  assert.match(result.detail, /改写你的 profile/)
})
