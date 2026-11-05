/** Locate the DSH runtime version and the installed profile without importing app internals. */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let runtimeCache
let installedCache

function readAsarEntry(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const headLength = Math.min(stat.size, 24 * 1024 * 1024)
    const head = Buffer.alloc(headLength)
    fs.readSync(fd, head, 0, headLength, 0)

    const start = head.indexOf('{"files"')
    if (start < 0) throw new Error('asar header not found')

    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let index = start; index < head.length; index++) {
      const byte = head[index]
      if (inString) {
        if (escaped) escaped = false
        else if (byte === 0x5c) escaped = true
        else if (byte === 0x22) inString = false
        continue
      }
      if (byte === 0x22) inString = true
      else if (byte === 0x7b) depth++
      else if (byte === 0x7d) {
        depth--
        if (depth === 0) {
          end = index + 1
          break
        }
      }
    }
    if (end < 0) throw new Error('asar header is incomplete')

    const header = JSON.parse(head.subarray(start, end).toString('utf8'))
    let node = header
    for (const segment of entryPath.split('/')) {
      const next = node && node.files ? node.files[segment] : undefined
      if (!next) throw new Error('asar entry not found: ' + entryPath)
      node = next
    }
    if (!node || node.unpacked || typeof node.size !== 'number' || typeof node.offset !== 'string') {
      throw new Error('asar entry is not a packed file: ' + entryPath)
    }

    // Header offsets are relative to the byte after the header, padded to 4 bytes.
    let headerBase = end
    for (let pad = 0; pad < 4; pad++) {
      const probe = Buffer.alloc(1)
      fs.readSync(fd, probe, 0, 1, end + pad + Number(node.offset))
      const char = probe.toString('utf8')
      if (char === '{' || char === '[' || char === '"') {
        headerBase = end + pad
        break
      }
    }

    const content = Buffer.alloc(node.size)
    fs.readSync(fd, content, 0, node.size, headerBase + Number(node.offset))
    return content
  } finally {
    fs.closeSync(fd)
  }
}

function candidateAsarPaths() {
  const candidates = []
  if (process.env.DSH_ASAR) candidates.push(process.env.DSH_ASAR)
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'app.asar'))
  if (process.execPath) candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar'))
  return [...new Set(candidates)]
}

function readJsonFile(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch {
    return null
  }
}

export function getRuntimeInfo() {
  if (runtimeCache) return runtimeCache
  const result = { runtimeVersion: null, appVersion: null, asarPath: null, source: 'unknown' }

  const envVersion = process.env.DSH_RUNTIME_VERSION
  if (typeof envVersion === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(envVersion.trim())) {
    result.runtimeVersion = envVersion.trim()
    result.source = 'environment'
  }

  for (const asarPath of candidateAsarPaths()) {
    if (!fs.existsSync(asarPath)) continue
    result.asarPath = asarPath

    // Inside Electron, app.asar is a virtual directory: fs can read files below
    // it even though stat(asar) reports size 0 and open(asar) is rejected.
    const readVirtual = (entry) => {
      try {
        return fs.readFileSync(path.join(asarPath, entry))
      } catch {
        return null
      }
    }
    const readPacked = (entry) => {
      try {
        return readAsarEntry(asarPath, entry)
      } catch {
        return null
      }
    }

    const appBuffer = readVirtual('package.json') ?? readPacked('package.json')
    if (appBuffer) {
      try {
        const appManifest = JSON.parse(appBuffer.toString('utf8'))
        if (typeof appManifest.version === 'string') result.appVersion = appManifest.version
      } catch {
        // The app manifest is only a display field.
      }
    }

    // 安装体布局在不同版本里是两种：
    //   <asar>/node_modules/@deepseek-ai/dsh-app-boot      —— 老的扁平铺法
    //   <asar>/dsh/node_modules/@deepseek-ai/dsh-app-boot  —— 当前的 desktop 布局
    // 只认第一种的后果是 runtimeVersion 恒为 null，于是「运行时版本不可用」
    // 让全表兼容性统统变成 unknown —— 这不是「查不出来」，是**查错了地方**。
    const bootEntries = [
      'node_modules/@deepseek-ai/dsh-app-boot/package.json',
      'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json',
    ]
    for (const entry of bootEntries) {
      const bootBuffer = readVirtual(entry) ?? readPacked(entry)
      if (!bootBuffer) continue
      try {
        const bootManifest = JSON.parse(bootBuffer.toString('utf8'))
        if (typeof bootManifest.version === 'string') {
          result.runtimeVersion = bootManifest.version
          result.source = 'app.asar:app-boot(' + entry + ')'
          break
        }
      } catch {
        // 换下一个候选
      }
    }
    break
  }

  runtimeCache = result
  return result
}

export function profileDirectory(override) {
  if (typeof override === 'string' && override.trim()) return override.trim()
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
}

/** Read profile dependencies and installed package versions. */
export function getInstalledPackages(overrideDir) {
  const dir = profileDirectory(overrideDir)
  const key = path.resolve(dir)
  if (installedCache && installedCache.key === key && Date.now() - installedCache.at < 15_000) {
    return installedCache.value
  }

  const manifest = readJsonFile(path.join(dir, 'package.json')) ?? {}
  const dependencies = manifest && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const packages = new Map()
  for (const [name, spec] of Object.entries(dependencies)) {
    let version = null
    const installed = readJsonFile(path.join(dir, 'node_modules', name, 'package.json'))
    if (installed && typeof installed.version === 'string') version = installed.version
    if (!version && typeof spec === 'string') {
      const exact = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.exec(spec.trim())
      if (exact) version = exact[0]
    }
    packages.set(name.toLowerCase(), {
      name,
      version,
      spec: typeof spec === 'string' ? spec : '',
      dir,
    })
  }

  installedCache = { key, at: Date.now(), value: packages }
  return packages
}

/**
 * 安装刚结束时 15 秒缓存里还是旧的依赖表：不清掉，界面上就会出现
 * 「安装成功但行还是未安装」，下一轮刷新又突然全变（或者反过来）。
 * 所以写操作完成后必须显式失效。
 */
export function invalidateInstalledCache() {
  installedCache = null
}

export function cacheDirectory() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'market-lens')
}

export function readJson(filename) {
  return readJsonFile(filename)
}

export function writeJsonAtomic(filename, value) {
  const temporary = filename + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8')
  fs.renameSync(temporary, filename)
}
