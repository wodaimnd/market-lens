// 源级新鲜度状态带：市场页必须能说清「某个源没拉到」。
//
// 现场问题：多源聚合下单个源失败不会报错，只是它那份条目少了一批。
// 用户看到的是「这个插件搜不到」—— 结论错了，原因却在别处。
// 数据一直在 status.sourceHealth（lastSuccessAt / failureCount / lastError），
// 但以前只在「来源」页可见，而用户排查"搜不到"时不会去那儿。
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** 取出 freshnessBanner 的 IIFE 段（从声明到 `})()` 结束）。 */
function bannerBody() {
  const start = source.indexOf('const freshnessBanner = (() => {')
  assert.ok(start > 0, '应有 freshnessBanner')
  const end = source.indexOf('})()', start)
  assert.ok(end > start, 'freshnessBanner 应是 IIFE')
  return source.slice(start, end)
}

describe('判定口径', () => {
  it('读的是 status.sourceHealth（后端已有的持久化健康字段）', () => {
    const body = bannerBody()
    assert.match(body, /status\?\.sourceHealth/, '不能另建一套健康数据')
  })

  it('只把「本次失败」或「从未成功」的源算作降级', () => {
    const body = bannerBody()
    assert.match(body, /failureCount > 0/, '连续失败要算降级')
    assert.match(body, /lastSuccessAt === null/, '从未成功过也要算降级')
  })

  it('被禁用的源不算降级（用户自己关的，不是故障）', () => {
    const body = bannerBody()
    assert.match(body, /enabled === false/, '禁用的源要排除')
  })

  it('全部源健康时返回 null —— 状态带只在有话说时出现', () => {
    const body = bannerBody()
    assert.match(body, /if \(!degraded\.length\) return null/, '健康时不能刷存在感')
  })

  it('同步中要标出来，并禁用重试按钮', () => {
    const body = bannerBody()
    assert.match(body, /syncing/, '同步中要区分')
    assert.match(body, /disabled: syncing/, '同步中不能重复触发')
  })
})

describe('文案与出口', () => {
  it('状态带被真的渲染进市场页（不是定义了没用）', () => {
    assert.match(source, /freshnessBanner,\s*\n/, '必须在页面 JSX 里被引用')
  })

  it('中英各 5 条文案齐全', () => {
    for (const key of ['freshnessTitle', 'freshnessRepeated', 'freshnessNever', 'freshnessSyncing', 'freshnessRetry']) {
      const count = (source.match(new RegExp(key + ':', 'g')) || []).length
      assert.equal(count, 2, key + ' 应有 zh + en 两条，实际 ' + count)
    }
  })

  it('提供「强制重试」出口：不能只报错不给动作', () => {
    const body = bannerBody()
    assert.match(body, /startSync\(\{ force: true \}\)/, '要给一键强制重试')
    assert.match(body, /t\('freshnessRetry'\)/, '按钮文案要接上')
  })

  it('最多点名 4 个源，其余折叠成 +N（避免状态带撑爆一行）', () => {
    const body = bannerBody()
    assert.match(body, /slice\(0, 4\)/, '点名数量要封顶')
    assert.match(body, /degraded\.length - 4/, '超出部分要折叠')
  })
})
