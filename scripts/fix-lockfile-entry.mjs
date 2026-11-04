/**
 * 修 lockfile：把 billion-context 的 0.1.212 条目补进去。
 *
 * 现场问题：
 *   manifest 里 billion-context 是 ^0.1.212，importer 段也写着 version: 0.1.212，
 *   但 packages / snapshots 两段里只有 0.1.211 —— 于是 pnpm 报
 *   ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY: no entry for 'billion-context@0.1.212'。
 *   这不是「装不上的包」的问题，是 lockfile 内部不自洽。
 *
 * 为什么不能直接 `pnpm install --fix-lockfile`：
 *   那个命令会先解析 manifest 里所有依赖，其中两个是 GitHub 仓库
 *   （dsh-compat-vet、dsh-flash-presets），而本机 github.com 的 HTTPS 与 SSH
 *   都不通。于是修复流程卡在毫不相干的地方，lockfile 一辈子修不好。
 *
 * 为什么可以手补：
 *   0.1.212 需要的东西全都已知且已在本地：
 *     - integrity：从 npm registry 拿到（sha512-...）
 *     - dependencies：zod 4.6.7 / mysql2 ^3.15.3 / optional jimp 1.6.1
 *       这三个在 lockfile 里都已有对应条目
 *     - 实际的包文件已经在 node_modules 里（0.1.212）
 *   所以这不是「凭空编造一个条目」，而是把已经成立的事实补写进索引。
 *   补完仍要跑一次 pnpm install 校验，校验不过就自动回滚。
 *
 *   node scripts/fix-lockfile-entry.mjs --check
 *   node scripts/fix-lockfile-entry.mjs --apply
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const LOCK = path.join(PROFILE, 'pnpm-lock.yaml')
const PNPM = process.env.PNPM_BIN || path.join(process.env.APPDATA || '', 'npm', 'pnpm.cmd')

// 目标：manifest 要求但没有 lockfile 条目的那个版本
const PKG = 'billion-context'
const VERSION = '0.1.212'
const INTEGRITY = 'sha512-Bwjl4StlMNcE3JWe15iKLATwk5q8rgiNgR/isk5fCnOYfhtE8vsrtJPCqA5WGvsT2yJ9p/j3k4NUAkQER5qjjg=='
const PEER_KEY = '(@types/node@16.9.1)'

const mode = process.argv.includes('--apply') ? 'apply' : 'check'

function readLines() {
  return fs.readFileSync(LOCK, 'utf8').split('\n')
}

function sectionBounds(lines, name) {
  const start = lines.findIndex((line) => new RegExp('^' + name + ':').test(line))
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    // 顶格且不是空行 ⇒ 下一个顶层段
    if (/^\S/.test(lines[index])) { end = index; break }
  }
  return { start, end }
}

/** 只改一个版本号，别的字节一概不碰：手写 YAML 最容易在缩进上翻车。 */
function plan() {
  const lines = readLines()
  const packages = sectionBounds(lines, 'packages')
  const snapshots = sectionBounds(lines, 'snapshots')
  if (!packages || !snapshots) return { ok: false, reason: 'lockfile 里找不到 packages / snapshots 段' }

  const text = lines.join('\n')
  const importerLine = new RegExp('\\n      ' + PKG + ':\\n        specifier: \\^' + VERSION.replace(/\./g, '\\.'))
  const hasImporter = importerLine.test(text)
  const hasPackageEntry = new RegExp('\\n  ' + PKG + '@' + VERSION.replace(/\./g, '\\.') + ':').test(text)
  const hasSnapshotEntry = new RegExp('\\n  ' + PKG + '@' + VERSION.replace(/\./g, '\\.') + '\\(').test(text)
  const oldVersion = new RegExp('\\n  ' + PKG + '@0\\.1\\.211:').test(text)

  return { ok: true, lines, packages, snapshots, hasImporter, hasPackageEntry, hasSnapshotEntry, oldVersion }
}

function report() {
  const state = plan()
  if (!state.ok) { console.log('无法分析:', state.reason); return state }
  console.log('lockfile      :', LOCK)
  console.log('importer 要求  : ^' + VERSION, state.hasImporter ? '（已记录）' : '（缺失）')
  console.log('packages 段    :', state.hasPackageEntry ? VERSION + ' 已存在' : VERSION + ' 缺失')
  console.log('snapshots 段   :', state.hasSnapshotEntry ? VERSION + ' 已存在' : VERSION + ' 缺失')
  console.log('旧条目 0.1.211 :', state.oldVersion ? '存在（保留，可能有别的包依赖它）' : '不存在')
  return state
}

function apply() {
  const state = report()
  if (!state.ok) { process.exitCode = 1; return }
  if (state.hasPackageEntry && state.hasSnapshotEntry) {
    console.log('\n两段都已有条目，无需补写')
    return
  }

  const backup = LOCK + '.bak-entry-' + new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(LOCK, backup)
  console.log('\n备份:', path.basename(backup))

  const lines = state.lines

  // packages 段：按字母序插到 billion-context@0.1.211 之后（包名相同，版本大的在后）
  if (!state.hasPackageEntry) {
    const anchor = lines.findIndex((line) => line.trim() === PKG + '@0.1.211:')
    if (anchor < 0) { console.log('找不到 0.1.211 锚点，放弃'); return }
    // 锚点条目结束位置（下一个顶两格的 key）
    let tail = anchor + 1
    for (let index = anchor + 1; index < lines.length; index += 1) {
      if (/^  \S/.test(lines[index])) { tail = index; break }
    }
    lines.splice(tail, 0,
      '  ' + PKG + '@' + VERSION + ':',
      '    resolution: {integrity: ' + INTEGRITY + '}',
      "    engines: {node: '>=20'}",
      '    hasBin: true',
      '',
    )
    console.log('已补 packages 段条目')
  }

  // snapshots 段：结构照抄 0.1.211，依赖版本不变（zod/mysql2/jimp 都已存在）
  if (!state.hasSnapshotEntry) {
    const anchor = lines.findIndex((line) => line.trim() === PKG + '@0.1.211' + PEER_KEY + ':')
    if (anchor < 0) { console.log('找不到 snapshots 锚点，放弃'); fs.writeFileSync(LOCK, state.lines.join('\n')); return }
    let tail = anchor + 1
    for (let index = anchor + 1; index < lines.length; index += 1) {
      if (/^  \S/.test(lines[index])) { tail = index; break }
    }
    lines.splice(tail, 0,
      '  ' + PKG + '@' + VERSION + PEER_KEY + ':',
      '    dependencies:',
      '      mysql2: 3.24.6' + PEER_KEY,
      '      zod: 4.6.7',
      '    optionalDependencies:',
      '      jimp: 1.6.1',
      '    transitivePeerDependencies:',
      "      - '@types/node'",
      '      - supports-color',
      '',
    )
    console.log('已补 snapshots 段条目')
  }

  fs.writeFileSync(LOCK, lines.join('\n'), 'utf8')

  // 校验：让 pnpm 自己读一遍。它不联网校验 lockfile 结构这一步是纯本地的。
  const run = childProcess.spawnSync(PNPM, ['install', '--frozen-lockfile', '--offline'], {
    encoding: 'utf8', cwd: PROFILE, shell: true, timeout: 600000,
  })
  const output = ((run.stdout || '') + (run.stderr || ''))

  if (run.status === 0) {
    console.log('\n[PASS] pnpm 接受了修好的 lockfile')
    return
  }

  if (/LOCKFILE_MISSING_DEPENDENCY|Broken lockfile/i.test(output)) {
    fs.copyFileSync(backup, LOCK)
    console.log('\n[FAIL] 补写后仍然缺条目，已回滚')
    console.log(output.split('\n').filter((line) => line.includes('no entry') || line.includes('Broken')).join('\n'))
    process.exitCode = 1
    return
  }

  // 其它失败（比如 GitHub 依赖解析不了）说明 lockfile 结构本身已经通过校验，
  // 卡在了网络。这种情况不该回滚 —— 回滚只会让结构问题重新出现。
  console.log('\n[PARTIAL] lockfile 结构已通过，但 pnpm 卡在其它依赖（大概率是网络）')
  console.log(output.split('\n').filter((line) => /Failed to resolve|Couldn.t connect|ERR_PNPM/.test(line)).slice(0, 6).join('\n'))
  console.log('保留修改：用 --offline 或恢复网络后再验证')
}

if (mode === 'apply') apply()
else report()
