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

describe('CHANGE_META：三种状态各有形状标记', () => {
  it('shape 只作为语义标记，三种状态都渲染成实心圆', () => {
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

  it('宽度不超过 8px', () => {
    const body = changeBadgeBody()
    // 全部实心圆：新增 7px / 有变化 6px / 下架 4px
    assert.doesNotMatch(body, /width: (8|[1-9][0-9])/, '不能有超过 7px 的宽度')
    assert.match(body, /width: size/, '尺寸应当由 size 变量统一决定')
  })
})

describe('三种状态都是实心圆，靠尺寸 + 颜色区分', () => {
  it('全部用 borderRadius 50% + background（没有空心环）', () => {
    const body = changeBadgeBody()
    assert.match(body, /borderRadius: '50%'/, '必须是圆')
    assert.match(body, /background: change\.color/, '必须是实心填充')
    assert.doesNotMatch(body, /background: 'transparent'/, '不能有空心（用户说圆环太难分辨）')
    assert.doesNotMatch(body, /border: '1\.5px solid/, '不能有描边环')
  })

  it('尺寸分三档：新增 7px / 有变化 6px / 下架 4px', () => {
    const body = changeBadgeBody()
    assert.match(body, /shape === 'solid' \? 7/, '新增 7px')
    assert.match(body, /shape === 'ring' \? 6/, '有变化 6px')
    assert.match(body, /: 4/, '下架 4px')
  })

  it('下架用低透明度（"退场"感），其余全不透明', () => {
    const body = changeBadgeBody()
    assert.match(body, /shape === 'strike' \? 0\.55 : 1/)
  })

  it('只有新增给光晕', () => {
    const body = changeBadgeBody()
    assert.match(body, /boxShadow: change\.shape === 'solid'/)
    assert.match(body, /: 'none'/)
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
