/**
 * 修 lockfile 第二阶段：把 importer 的 version 改回带 peer 后缀的形式。
 *
 * 为什么之前补了条目还是报错：
 *   pnpm 报 "no entry for 'billion-context@0.1.212'" 时，它找的其实是
 *   importer 里 version 字段那一串字面值。历史备份（16:19 / 21:54）里写的是
 *
 *       version: 0.1.211(@types/node@16.9.1)      ← 带 peer 后缀
 *
 *   而现在这个文件里被改成了
 *
 *       version: 0.1.212                          ← 后缀丢了
 *
 *   于是 pnpm 去 snapshots 里找 key `billion-context@0.1.212`（无后缀），
 *   而我上一轮补的是 `billion-context@0.1.212(@types/node@16.9.1)`（有后缀）。
 *   两边对不上，所以补了也没用。
 *
 * 正确的修法是把 importer 那一行改回带后缀，并删掉我多加的无后缀条目。
 *
 *   node scripts/fix-lockfile-importer.mjs --dry
 *   node scripts/fix-lockfile-importer.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const LOCK = path.join(PROFILE, 'pnpm-lock.yaml')
const DRY = process.argv.includes('--dry')

const PKG = 'billion-context'
const VERSION = '0.1.212'
const PEER = '(@types/node@16.9.1)'

function main() {
  if (!fs.existsSync(LOCK)) { console.error('找不到 lockfile'); process.exitCode = 1; return }
  const lines = fs.readFileSync(LOCK, 'utf8').split('\n')

  // 1) importer：把 "version: 0.1.212" 改成 "version: 0.1.212(@types/node@16.9.1)"
  const importerIndex = lines.findIndex((line, index) => {
    if (!/^\s+version: 0\.1\.212\s*$/.test(line)) return false
    // 往上两行应该能看到 billion-context:
    const head = lines.slice(Math.max(0, index - 3), index).join('\n')
    return head.includes(PKG + ':')
  })
  if (importerIndex < 0) {
    console.log('importer 里没有找到 version: ' + VERSION + '（可能已经修好，或结构变了）')
  } else {
    console.log('importer 行', importerIndex + 1, ':', JSON.stringify(lines[importerIndex]))
  }

  // 2) 我上一轮多加的无后缀 packages 条目：删掉（正确的形态是带 peer 的那个）
  const strayPackageIndex = lines.findIndex((line) => line.trim() === PKG + '@' + VERSION + ':')
  if (strayPackageIndex >= 0) {
    console.log('多余的 packages 条目（无 peer 后缀）在第', strayPackageIndex + 1, '行')
  }

  const hasPeerSnapshot = lines.some((line) => line.trim() === PKG + '@' + VERSION + PEER + ':')
  console.log('带 peer 的 snapshots 条目:', hasPeerSnapshot ? '已存在' : '缺失')

  if (DRY) {
    console.log('\n(dry run)')
    console.log('将改 importer:', importerIndex >= 0)
    console.log('将删无后缀 packages 条目:', strayPackageIndex >= 0)
    return
  }

  const backup = LOCK + '.bak-importer-' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(LOCK, backup)
  console.log('\n备份:', path.basename(backup))

  const working = lines.slice()

  // 先删无后缀条目（在后），再改 importer（在前），避免行号偏移
  if (strayPackageIndex >= 0) {
    let end = strayPackageIndex + 1
    for (let index = strayPackageIndex + 1; index < working.length; index += 1) {
      if (/^  \S/.test(working[index])) { end = index; break }
    }
    working.splice(strayPackageIndex, end - strayPackageIndex)
    console.log('已删除无后缀 packages 条目')
  }

  // importer 行可能因为上面的删除而位移，重新定位
  const target = working.findIndex((line, index) => {
    if (!/^\s+version: 0\.1\.212\s*$/.test(line)) return false
    const head = working.slice(Math.max(0, index - 3), index).join('\n')
    return head.includes(PKG + ':')
  })
  if (target >= 0) {
    working[target] = '        version: ' + VERSION + PEER
    console.log('已改 importer version →', VERSION + PEER)
  }

  fs.writeFileSync(LOCK, working.join('\n'), 'utf8')
  console.log('已写入')

  console.log('\n写入后 ' + PKG + ' 相关行:')
  working.forEach((line, index) => {
    if (line.includes(PKG)) console.log('  ' + (index + 1) + ': ' + JSON.stringify(line))
  })
}

main()
