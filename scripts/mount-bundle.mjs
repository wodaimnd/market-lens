/**
 * 把已装但没挂载的插件补进 profile 的 bundles 列表，然后核对结果。
 *
 * 这是市场雷达在「装了但没挂载」时给用户的下一步；这里做成脚本，
 * 一是为了验证这条补救路径确实有效，二是为了在真实环境里确认
 * humanizer-ru 装上后能被 loader 看到。
 *
 *   node scripts/mount-bundle.mjs humanizer-ru          # 挂载
 *   node scripts/mount-bundle.mjs humanizer-ru --check  # 只检查
 *   node scripts/mount-bundle.mjs humanizer-ru --unmount
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profileDir = process.env.DSH_PROFILE_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')
const target = process.argv[2]
const checkOnly = process.argv.includes('--check')
const unmount = process.argv.includes('--unmount')

if (!target) {
  console.error('用法: node scripts/mount-bundle.mjs <package-name> [--check|--unmount]')
  process.exit(1)
}

const profileFile = path.join(profileDir, 'package.json')

function read() {
  return JSON.parse(fs.readFileSync(profileFile, 'utf8'))
}

function main() {
  const manifest = read()
  const deps = manifest.dependencies || {}
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []

  console.log('profile   :', profileDir)
  console.log('target    :', target)
  console.log('dependency:', deps[target] || '（未声明——先装再挂）')
  console.log('挂载状态  :', bundles.includes(target) ? '已挂载' : '未挂载')

  if (checkOnly) {
    process.exit(bundles.includes(target) ? 0 : 1)
  }

  if (!deps[target]) {
    console.error('\n拒绝挂载：这个包不在 dependencies 里。先安装再挂。')
    process.exit(1)
  }

  // 包必须真的落在 node_modules 里，否则挂上去 loader 也解析不到
  const installedManifest = path.join(profileDir, 'node_modules', target, 'package.json')
  if (!fs.existsSync(installedManifest)) {
    console.error('\n拒绝挂载：node_modules 里没有 ' + target)
    process.exit(1)
  }
  const pkg = JSON.parse(fs.readFileSync(installedManifest, 'utf8'))
  if (!pkg?.dsh?.bundle?.patch && !pkg?.dsh?.bundle) {
    console.error('\n拒绝挂载：这个包没有 dsh.bundle 声明，不是可挂载的插件（装了也只是普通依赖）')
    process.exit(1)
  }

  const next = unmount
    ? bundles.filter((entry) => entry !== target)
    : (bundles.includes(target) ? bundles : [...bundles, target])

  if (JSON.stringify(bundles) === JSON.stringify(next)) {
    console.log('\n无需改动（已经是目标状态）')
    process.exit(0)
  }

  const backup = profileFile + '.bak-mount-' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(profileFile, backup)

  manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
  manifest.dsh.profile.bundles = next
  fs.writeFileSync(profileFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log('备份      :', path.basename(backup))
  console.log('bundles   :', bundles.length, '→', next.length)
  console.log(unmount ? '\n已卸载挂载行（依赖仍在）' : '\n已挂载。重启 DSH 后它会出现在插件列表里。')
}

main()
