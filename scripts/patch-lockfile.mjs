/**
 * 手工把 billion-context@0.1.212 的条目补进 lockfile，并逐步打印每一处改动。
 *
 * 前一版（fix-lockfile-entry.mjs）用「插入后让 pnpm 校验、失败就回滚」的方式，
 * 结果 pnpm 仍然报缺条目。所以这次先把「插入是否真的写进去了」print 出来，
 * 不急着交给 pnpm 判断——先排除「我插到了错位置」这种可能。
 *
 *   node scripts/patch-lockfile.mjs --dry   只看将插入什么
 *   node scripts/patch-lockfile.mjs        实际写盘
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

const packagesBlock = [
  '  ' + PKG + '@' + NEW + ':',
  '    resolution: {integrity: ' + INTEGRITY + '}',
  "    engines: {node: '>=20'}",
  '    hasBin: true',
  '',
]

const snapshotsBlock = [
  '  ' + PKG + '@' + NEW + '(@types/node@16.9.1):',
  '    dependencies:',
  '      mysql2: 3.24.6(@types/node@16.9.1)',
  '      zod: 4.6.7',
  '    optionalDependencies:',
  '      jimp: 1.6.1',
  '    transitivePeerDependencies:',
  "      - '@types/node'",
  '      - supports-color',
  '',
]

function sectionOf(lines, name) {
  const start = lines.findIndex((line) => new RegExp('^' + name + ':').test(line))
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) { end = index; break }
  }
  return { start, end }
}

/** 在指定段内找锚点条目，返回「该条目结束的位置」（下一个同级 key 的索引）。 */
function entryEnd(lines, section, anchorText) {
  const anchor = lines.findIndex((line, index) =>
    index > section.start && index < section.end && line.trim() === anchorText)
  if (anchor < 0) return null
  for (let index = anchor + 1; index < lines.length; index += 1) {
    if (/^  \S/.test(lines[index])) return index
  }
  return null
}

function main() {
  if (!fs.existsSync(LOCK)) { console.error('找不到 lockfile:', LOCK); process.exitCode = 1; return }

  const lines = fs.readFileSync(LOCK, 'utf8').split('\n')
  const packages = sectionOf(lines, 'packages')
  const snapshots = sectionOf(lines, 'snapshots')
  console.log('lockfile   :', LOCK)
  console.log('packages 段:', packages ? (packages.start + 1) + '-' + packages.end : '未找到')
  console.log('snapshots 段:', snapshots ? (snapshots.start + 1) + '-' + snapshots.end : '未找到')
  if (!packages || !snapshots) { process.exitCode = 1; return }

  const hasPackage = new RegExp('^  ' + PKG + '@' + NEW.replace(/\./g, '\\.') + ':', 'm').test(lines.join('\n'))
  const hasSnapshot = new RegExp('^  ' + PKG + '@' + NEW.replace(/\./g, '\\.') + '\\(', 'm').test(lines.join('\n'))
  console.log('已存在 packages :', hasPackage)
  console.log('已存在 snapshots:', hasSnapshot)

  if (hasPackage && hasSnapshot) { console.log('\n无需改动'); return }

  // 注意：必须先处理 snapshots 段（在后面），再处理 packages 段（在前面），
  // 否则前面的插入会把后面锚点的行号挤偏。
  const text = lines.join('\n')
  let working = lines.slice()

  const snapshotEnd = entryEnd(working, snapshots, PKG + '@' + OLD + '(@types/node@16.9.1):')
  if (!snapshotEnd) { console.error('snapshots 段里找不到锚点 ' + OLD); process.exitCode = 1; return }

  const packageEnd = entryEnd(working, packages, PKG + '@' + OLD + ':')
  if (!packageEnd) { console.error('packages 段里找不到锚点 ' + OLD); process.exitCode = 1; return }

  console.log('\n--- 将插入 snapshots 段（位置 ' + (snapshotEnd + 1) + ' 行之前）---')
  for (const line of snapshotsBlock) console.log('  |' + line)
  console.log('--- 将插入 packages 段（位置 ' + (packageEnd + 1) + ' 行之前）---')
  for (const line of packagesBlock) console.log('  |' + line)

  if (DRY) { console.log('\n(dry run，未写盘)'); return }

  const backup = LOCK + '.bak-patch-' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(LOCK, backup)
  console.log('\n备份:', path.basename(backup))

  // 先插后面的（snapshots），再插前面的（packages），行号不会互相干扰
  working.splice(snapshotEnd, 0, ...snapshotsBlock)
  working.splice(packageEnd, 0, ...packagesBlock)

  fs.writeFileSync(LOCK, working.join('\n'), 'utf8')
  console.log('已写入')

  const verify = working.filter((line) => line.includes(PKG))
  console.log('\n写入后所有 ' + PKG + ' 相关行:')
  for (const line of verify) console.log('  ' + line.trim())

  void text
}

main()
