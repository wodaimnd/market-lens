/**
 * store-guard 回归：pnpm store 位置不一致。
 *
 * 现场事故（2026-11-07 23:52，next profile）：
 *   [ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
 *   node_modules 是从 G:\AI PGRM\POJ\.diag\pnpm-store\v11 装的，
 *   pnpm 现在要用 C:\Users\Shinelon\AppData\Local\pnpm\store\v11
 *
 * 后果：**任何安装都失败**，而回执只能说"安装失败"，用户看不出
 * 这跟插件无关，是 pnpm 的记账对不上。
 *
 * 为什么会这样：pnpm 的 store 位置取决于**调用时的工作目录**（不是 --dir）。
 * 从 G: 盘调用时它退回 G:\.pnpm-store，并把绝对路径写进 .modules.yaml。
 * 症状**延迟出现** —— 装的时候没事，下次宿主调用 pnpm 才报。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  STORE_VERDICTS,
  inspectStore,
  inspectStoreDirConfig,
  isStoreMismatchError,
  recordedStoreOf,
} from '../lib/store-guard.js'

/** 真机样本：.modules.yaml 里的那一行。 */
const REAL_MODULES = [
  'layoutVersion: 5',
  'storeDir: G:\\AI PGRM\\POJ\\.diag\\pnpm-store\\v11',
  '"storeDir": "G:\\\\AI PGRM\\\\POJ\\\\.diag\\\\pnpm-store\\\\v11"',
  '"virtualStoreDir": "C:\\\\Users\\\\Shinelon\\\\.dsh\\\\profiles\\\\next\\\\node_modules\\\\.pnpm"',
].join('\n')

describe('recordedStoreOf：从 .modules.yaml 抽 storeDir', () => {
  it('解析转义的双反斜杠路径', () => {
    assert.equal(recordedStoreOf(REAL_MODULES), 'G:\\AI PGRM\\POJ\\.diag\\pnpm-store\\v11')
  })

  it('正斜杠路径也能读', () => {
    assert.equal(recordedStoreOf('"storeDir": "C:/Users/x/AppData/Local/pnpm/store/v11"'), 'C:/Users/x/AppData/Local/pnpm/store/v11')
  })

  it('没有记录返回 null', () => {
    assert.equal(recordedStoreOf('layoutVersion: 5'), null)
    assert.equal(recordedStoreOf(''), null)
    assert.equal(recordedStoreOf(null), null)
  })
})

describe('inspectStore：四种判定', () => {
  function makeProfile(modulesText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-store-'))
    if (modulesText !== null) {
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'node_modules', '.modules.yaml'), modulesText, 'utf8')
    }
    return dir
  }

  it('一致 → ok', () => {
    const profileDir = makeProfile('"storeDir": "C:/Users/x/store/v11"')
    try {
      const result = inspectStore({ profileDir, detectedStore: 'C:\\Users\\x\\store\\v11' })
      assert.equal(result.verdict, STORE_VERDICTS.ok, 'C:/ 与 C:\\ 是同一个路径，不该假报不一致')
      assert.equal(result.detail, null)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('不一致 → mismatch，并说清后果与修法', () => {
    // 真机上的确切形状：记录在 G: 盘的 rogue store
    const profileDir = makeProfile('"storeDir": "G:\\\\AI PGRM\\\\POJ\\\\.diag\\\\pnpm-store\\\\v11"')
    try {
      const result = inspectStore({
        profileDir,
        detectedStore: 'C:\\Users\\Shinelon\\AppData\\Local\\pnpm\\store\\v11',
      })
      assert.equal(result.verdict, STORE_VERDICTS.mismatch)
      assert.match(result.recorded, /POJ/)
      assert.match(result.detail, /ERR_PNPM_UNEXPECTED_STORE/)
      // 必须明说"这不是插件的问题"
      assert.match(result.detail, /不是插件的问题/)
      // 修法必须指向重装，而不是手改记录
      assert.match(result.fix, /pnpm install/)
      assert.match(result.fix, /不要手改/)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('没有 .modules.yaml → not-installed（还没初始化，不是故障）', () => {
    const profileDir = makeProfile(null)
    try {
      const result = inspectStore({ profileDir, detectedStore: 'C:/x' })
      assert.equal(result.verdict, STORE_VERDICTS.notInstalled)
      assert.match(result.detail, /还没用 pnpm 装过东西/)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('探测不到 store → unknown，不猜', () => {
    const profileDir = makeProfile('"storeDir": "C:/x"')
    try {
      const result = inspectStore({ profileDir, detectedStore: null })
      assert.equal(result.verdict, STORE_VERDICTS.unknown)
      assert.match(result.detail, /探测不到/)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('.modules.yaml 里没有 storeDir 记录 → unknown', () => {
    const profileDir = makeProfile('layoutVersion: 5')
    try {
      const result = inspectStore({ profileDir, detectedStore: 'C:/x' })
      assert.equal(result.verdict, STORE_VERDICTS.unknown)
      assert.match(result.detail, /没有 storeDir 记录/)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('null profileDir 不崩', () => {
    assert.equal(inspectStore({ profileDir: null }).verdict, STORE_VERDICTS.unknown)
    assert.equal(inspectStore({}).verdict, STORE_VERDICTS.unknown)
  })

  it('samePath 处理相对路径差异（必须 resolve 后比较）', () => {
    const profileDir = makeProfile('"storeDir": "./store/v11"')
    try {
      // 相对路径 resolve 到不同位置 → 报不一致（这是对的：相对路径本身就有歧义）
      const result = inspectStore({ profileDir, detectedStore: 'C:/Users/other/store/v11' })
      assert.equal(result.verdict, STORE_VERDICTS.mismatch)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })
})

describe('inspectStoreDirConfig：storeDir 写成带版本目录 = 病根', () => {
  it('.../store/v11 → 识别为带版本目录，给出基础路径', () => {
    const result = inspectStoreDirConfig('C:/Users/x/AppData/Local/pnpm/store/v11')
    assert.equal(result.looksVersioned, true)
    assert.equal(result.base, 'C:/Users/x/AppData/Local/pnpm/store')
    assert.match(result.detail, /基础路径/)
    assert.match(result.detail, /v11/)
  })

  it('基础路径 → 正常，不报', () => {
    for (const value of [
      'C:/Users/x/AppData/Local/pnpm/store',
      '/mnt/shared/pnpm-store',
      'C:\\Users\\x\\AppData\\Local\\pnpm\\store',
    ]) {
      const result = inspectStoreDirConfig(value)
      assert.equal(result.looksVersioned, false, value + ' 不该被当成带版本目录')
    }
  })

  it('v3 / v10 这些老版本目录也认', () => {
    assert.equal(inspectStoreDirConfig('/home/u/.pnpm-store/v3').looksVersioned, true)
    assert.equal(inspectStoreDirConfig('/home/u/.pnpm-store/v10').looksVersioned, true)
  })

  it('没配置时返回空结论', () => {
    for (const value of [null, '', undefined]) {
      const result = inspectStoreDirConfig(value)
      assert.equal(result.looksVersioned, false)
      assert.equal(result.detail, null)
    }
  })

  it('名字里含 v11 但不是目录结尾时不算（如 /storev11）', () => {
    assert.equal(inspectStoreDirConfig('C:/x/storev11').looksVersioned, false)
  })
})

describe('路径归一：混合分隔符不能假报不一致', () => {
  it('记录 .../store/v11 与探测 .../store\\v11 是同一个目录', () => {
    // 真机现场：改了 storeDir 之后 pnpm 输出 `.../store\v11`（混合分隔符），
    // 而 .modules.yaml 记的是 `.../store/v11` —— 不做归一会假报 mismatch。
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-store-slash-'))
    try {
      fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(profileDir, 'node_modules', '.modules.yaml'),
        '"storeDir": "C:/Users/x/AppData/Local/pnpm/store/v11"',
        'utf8',
      )
      const result = inspectStore({
        profileDir,
        detectedStore: 'C:/Users/x/AppData/Local/pnpm/store\\v11',
      })
      assert.equal(result.verdict, STORE_VERDICTS.ok, '混合分隔符必须视为同一路径')
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('末尾多余的反斜杠也被归一', () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-store-slash2-'))
    try {
      fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(profileDir, 'node_modules', '.modules.yaml'),
        '"storeDir": "C:/x/store/v11"',
        'utf8',
      )
      const result = inspectStore({ profileDir, detectedStore: 'C:/x/store/v11\\' })
      assert.equal(result.verdict, STORE_VERDICTS.ok)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })
})

describe('storeDir 配置写错时即便当下一致也要报', () => {
  it('记录与探测一致、但 storeDir 写成 v11 → 判 mismatch', () => {
    // 这是 2026-11-08 现场：配置写成 .../store/v11，pnpm 又追加一次变成 v11/v11。
    // 即便此刻 .modules.yaml 与探测碰巧一致，下次 pnpm 重算就会错位 ——
    // 所以必须提前报，而不是等它坏。
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-store-cfg-'))
    try {
      fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(profileDir, 'node_modules', '.modules.yaml'),
        '"storeDir": "C:/x/store/v11"',
        'utf8',
      )
      const result = inspectStore({
        profileDir,
        detectedStore: 'C:/x/store/v11',
        configuredStoreDir: 'C:/x/store/v11',
      })
      assert.equal(result.verdict, STORE_VERDICTS.mismatch)
      assert.match(result.detail, /基础路径/)
      assert.match(result.fix, /去掉末尾的/)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('storeDir 是基础路径时，一致就判 ok', () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-store-cfg2-'))
    try {
      fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(profileDir, 'node_modules', '.modules.yaml'),
        '"storeDir": "C:/x/store/v11"',
        'utf8',
      )
      const result = inspectStore({
        profileDir,
        detectedStore: 'C:/x/store/v11',
        configuredStoreDir: 'C:/x/store',
      })
      assert.equal(result.verdict, STORE_VERDICTS.ok)
      assert.equal(result.config.looksVersioned, false)
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true })
    }
  })
})


describe('isStoreMismatchError：把必然失败的病认出来', () => {
  it('认 ERR_PNPM_UNEXPECTED_STORE', () => {
    assert.equal(isStoreMismatchError('[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location'), true)
  })

  it('认不带前缀的措辞', () => {
    assert.equal(isStoreMismatchError('Unexpected store location'), true)
  })

  it('别的错误不算', () => {
    for (const text of ['ERR_PNPM_EPERM', 'ERR_PNPM_NO_MATCHING_VERSION', 'ETIMEDOUT']) {
      assert.equal(isStoreMismatchError(text), false, text)
    }
    assert.equal(isStoreMismatchError(null), false)
  })
})

test('真机样本：G: 盘 rogue store 必须被判为 mismatch', () => {
  // 这就是 2026-11-07 23:52 那次安装失败的现场
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-store-real-'))
  try {
    fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(profileDir, 'node_modules', '.modules.yaml'), REAL_MODULES, 'utf8')
    const result = inspectStore({
      profileDir,
      detectedStore: 'C:/Users/Shinelon/AppData/Local/pnpm/store/v11',
    })
    assert.equal(result.verdict, STORE_VERDICTS.mismatch)
    assert.equal(result.recorded, 'G:\\AI PGRM\\POJ\\.diag\\pnpm-store\\v11')
    assert.equal(isStoreMismatchError('The dependencies are currently linked from the store'), false, '这条措辞不完整时不该硬认')
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
})
