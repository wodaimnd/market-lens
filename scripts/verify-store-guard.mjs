/**
 * 验证 try-install.mjs 的 store 前置保护真的会拦。
 *
 * 做法：把 .modules.yaml 里的 storeDir 故意改成一个错的，跑 try-install，
 * 它应该在动手之前就中止并提示修法；然后恢复原文件。
 *
 *   node scripts/verify-store-guard.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const MODULES = path.join(PROFILE, 'node_modules', '.modules.yaml')
const BAK = MODULES + '.bak-guardtest'

function readStoreDir() {
  const text = fs.readFileSync(MODULES, 'utf8')
  const match = text.match(/"storeDir": "([^"]+)"/)
  return match ? match[1] : null
}

function main() {
  if (!fs.existsSync(MODULES)) {
    console.log('跳过：没有 .modules.yaml（profile 还没装过依赖）')
    return
  }
  const original = fs.readFileSync(MODULES, 'utf8')
  const before = readStoreDir()
  console.log('原始 storeDir :', before)

  try {
    // 造一个「与 pnpm 探测结果不符」的记录，模拟上次污染后的状态
    const broken = original.replace(/"storeDir": "[^"]+"/, '"storeDir": "C:\\\\\\\\.pnpm-store\\\\v11"')
    fs.writeFileSync(MODULES, broken, 'utf8')
    console.log('伪造 storeDir :', readStoreDir())

    // 跑 try-install（--keys 也会先过前置检查）
    const run = childProcess.spawnSync(
      process.execPath,
      [path.join(HERE, 'try-install.mjs'), 'humanizer-ru', '--keys'],
      { encoding: 'utf8', cwd: PROFILE, timeout: 180000, shell: false },
    )
    const output = ((run.stdout || '') + (run.stderr || '')).trim()

    if (/ABORT/.test(output)) {
      console.log('\n[PASS] 前置检查拦住了不一致的 store')
      console.log(output.split('\n').filter((line) => line.includes('store') || line.includes('记录') || line.includes('探测') || line.includes('ABORT') || line.includes('fix-profile')).join('\n'))
    } else {
      console.log('\n[FAIL] 没有拦住，输出如下：')
      console.log(output.slice(0, 600))
    }
  } finally {
    fs.writeFileSync(MODULES, original, 'utf8')
    if (fs.existsSync(BAK)) fs.rmSync(BAK, { force: true })
    console.log('\n已恢复 storeDir :', readStoreDir())
  }
}

main()
