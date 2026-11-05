/**
 * 修 lockfile 第三阶段：把 packages 段的 billion-context@0.1.212 补回来。
 *
 * 演进过程（每一步的错误信息都更接近真相）：
 *   1. no entry for 'billion-context@0.1.212'
 *      → importer 的 version 丢了 peer 后缀，pnpm 在找无后缀的 key
 *   2. 改正 importer 后：
 *      Lockfile has a snapshot entry 'billion-context@0.1.212(@types/node@16.9.1)'
 *      with no matching metadata entry 'billion-context@0.1.212' in packages:
 *      → snapshots 段（依赖图）有了，但 packages 段（包元数据）还没有
 *
 * 至此 lockfile 的结构要求已经清楚：
 *   packages  段：name@version              ← 包元数据（integrity / engines / bin）
 *   snapshots 段：name@version(peer 组合)   ← 依赖图
 * 两段都要有，且 key 形式不同。
 *
 *   node scripts/fix-lockfile-packages.mjs --dry
 *   node scripts/fix-lockfile-packages.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const LOCK = path.join(PROFILE, 'pnpm-lock.yaml')
const DRY = process.argv.includes('--dry')

const PKG = 'billion-context'
const NEW = '0.1.212'
const OLD = '0.1.211'
const INTEGRITY = 'sha512-Bwjl4StlMNcE3JWe15iKLATwk5q8rgiNgR/isk5fCnOYfhtE8vsrtJPCqA5WGvsT2yJ9p/j3k4NUAkQER5qjjg=='

const block = [
  '  ' + PKG + '@' + NEW + ':',
  '    resolution: {integrity: ' + INTEGRITY + '}',
  "    engines: {node: '>=20'}",
  '    hasBin: true',
  '',
]

function main() {
  const lines = fs.readFileSync(LOCK, 'utf8').split('\n')
  const packagesStart = lines.findIndex((line) => /^packages:/.test(line))
  const snapshotsStart = lines.findIndex((line) => /^snapshots:/.test(line))
  if (packagesStart < 0 || snapshotsStart < 0) { console.error('段结构异常'); process.exitCode = 1; return }

  const needs = !lines.some((line) => line.trim() === PKG + '@' + NEW + ':')
  const hasSnapshot = lines.some((line) => line.trim() === PKG + '@' + NEW + '(@types/node@16.9.1):')

  console.log('packages 段  :', (packagesStart + 1) + '-' + snapshotsStart)
  console.log('需要补 packages 条目:', needs)
  console.log('snapshots 已有条目  :', hasSnapshot)

  if (!needs) { console.log('\n无需改动'); return }

  if (DRY) {
    console.log('\n将插入:'); block.forEach((line) => console.log('  |' + line))
    return
  }

  // 锚点：packages 段内的 billion-context@0.1.211 条目，插在它后面
  const anchor = lines.findIndex((line, index) =>
    index > packagesStart && index < snapshotsStart && line.trim() === PKG + '@' + OLD + ':')
  if (anchor < 0) { console.error('packages 段里找不到锚点 ' + OLD); process.exitCode = 1; return }

  let end = anchor + 1
  for (let index = anchor + 1; index < lines.length; index += 1) {
    if (/^  \S/.test(lines[index])) { end = index; break }
  }

  const backup = LOCK + '.bak-pkgs-' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(LOCK, backup)
  console.log('\n备份:', path.basename(backup))

  lines.splice(end, 0, ...block)
  fs.writeFileSync(LOCK, lines.join('\n'), 'utf8')
  console.log('已插入 packages 条目（位置 ' + (end + 1) + ' 行前）')

  console.log('\n写入后 ' + PKG + ' 相关行:')
  lines.forEach((line, index) => { if (line.includes(PKG)) console.log('  ' + (index + 1) + ': ' + JSON.stringify(line)) })
}

main()
