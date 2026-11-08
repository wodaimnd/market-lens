/**
 * 变化标记渲染回归：汉字徽章 → 彩色圆点。
 *
 * 现场问题（2026-11-08）：名字旁挂着「有变化」的方形汉字徽章，一屏十行
 * 有八行带它时，插件名被压成省略号 —— 而名字才是这一列的主体。
 *
 * 改成圆点后必须满足三条：
 *   1. 不渲染任何文字（只靠颜色 + 形状）
 *   2. 三种状态形状不同（色盲也能读）
 *   3. 宽度控制在 10px 内（不挤压名字）
 *
 * 这条测试直接从 client.js 源码里抽 changeBadge 的契约来验 ——
 * client 是工厂函数，完整挂载代价过高，而这里要钉的恰恰是"输出必须是点不是字"。
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** 抽出 changeBadge 函数体。 */
function changeBadgeBody() {
  const start = source.indexOf('function changeBadge(change, t) {')
  assert.ok(start > 0, '应有 changeBadge 函数')
  const end = source.indexOf('\n    }', start)
  assert.ok(end > start, 'changeBadge 应当闭合')
  return source.slice(start, end)
}

describe('CHANGE_META：三种状态各有形状', () => {
  it('新增 = 实心点 / 有变化 = 空心环 / 下架 = 横线', () => {
    const start = source.indexOf('const CHANGE_META = {')
    assert.ok(start > 0)
    // 取到紧随其后的 `}` 行（三行条目 + 一行闭合）
    const end = source.indexOf('\n    }', start)
    assert.ok(end > start, 'CHANGE_META 应当闭合')
    const body = source.slice(start, end)
    assert.match(body, /added:[\s\S]{0,140}shape: 'solid'/)
    assert.match(body, /updated:[\s\S]{0,140}shape: 'ring'/)
    assert.match(body, /removed:[\s\S]{0,140}shape: 'strike'/)
  })
})

describe('渲染输出必须是点，不是字', () => {
  it('不再渲染 labelKey 文字（不出现 t(change.labelKey) 作为 children）', () => {
    const body = changeBadgeBody()
    // 允许出现在 title 里，但不允许作为子节点（children 在 style 之后的那个参数）
    const childrenMatch = /}, t\(change\.labelKey\)/.exec(body)
    assert.equal(childrenMatch, null, '不能把汉字当可见内容渲染')
  })

  it('文字只出现在 title（悬停提示）', () => {
    const body = changeBadgeBody()
    assert.match(body, /title/, '必须有 title 承载解释')
    assert.match(body, /t\('changeNote'\)/, 'title 要带完整说明')
  })

  it('宽度不超过 10px', () => {
    const body = changeBadgeBody()
    // 圆点是 7px，横线是 9px，都在 10 以内
    assert.doesNotMatch(body, /width: (1[0-9]|[2-9][0-9]|1[0-9][0-9])/, '不能有超过 10px 的宽度')
    assert.match(body, /width: 7/, '圆点应当是 7px')
    assert.match(body, /width: 9/, '横线应当是 9px')
  })
})

describe('三种形状的视觉差异', () => {
  it('实心点有背景色', () => {
    const body = changeBadgeBody()
    // solid 分支结尾那段
    const solidPart = body.slice(body.lastIndexOf('// 新增'))
    assert.match(solidPart, /background: change\.color/)
  })

  it('空心环用 border 而不是 background', () => {
    const body = changeBadgeBody()
    const ringPart = body.slice(body.indexOf("if (change.shape === 'ring')"), body.indexOf('// 新增'))
    assert.match(ringPart, /border: .*change\.color/)
    assert.match(ringPart, /background: 'transparent'/)
  })

  it('下架横线的 height 是 2px（细线而非点）', () => {
    const body = changeBadgeBody()
    assert.match(body, /height: 2/, '横线要是 2px 高')
  })
})

test('i18n 文案仍在（tooltip 需要它们）', () => {
  // i18n 表里的写法是 `changeAdded: '…'`（冒号后直接跟引号）
  for (const key of ['changeAdded', 'changeUpdated', 'changeRemoved', 'changeNote']) {
    const count = (source.match(new RegExp(key + ":\\s*'", 'g')) || []).length
    assert.ok(count >= 2, key + ' 应有 zh + en 两份定义，实际 ' + count)
  }
  // changeBadge 里要通过 change.labelKey 动态取值
  assert.match(source, /t\(change\.labelKey\)/, '必须用 labelKey 取文案')
})

test('「有变化」不再写成「更新」（0.17.3 定下的口径）', () => {
  assert.match(source, /changeUpdated: '有变化'/)
  assert.match(source, /changeUpdated: 'Changed'/)
  assert.doesNotMatch(source, /changeUpdated: '更新'/)
})
