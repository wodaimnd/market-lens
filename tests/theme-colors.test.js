/**
 * 主题色选用的回归：语义色 vs 品牌色。
 *
 * 现场事故（2026-11-08）：用户说"怎么都是黑色的，不是按时间设了区分度吗"。
 *
 * 根因在 dsh-client-ui-theme 的实测值：
 *
 *   --dsw-alias-brand-primary 亮色主题 = var(--dsw-static-neutral-bluish-1000) = #0f1115  ← 近黑
 *   --dsw-alias-brand-primary 暗色主题 = var(--dsw-static-neutral-bluish-50)                ← 近白
 *
 * 它的职责是「与背景强对比」（按钮填充、焦点环），**不是「可辨别的彩色」**。
 *
 * 而我把它当分类色和变化标记的颜色用，于是：
 *   · 变化标记「有变化」的空心环 → 在亮色主题下画出一颗近黑的环
 *   · 分类色「能力/工具类」→ 四个分类全是同一片黑
 *
 * 真正的彩色只有语义色（state-*），它们不随主题明暗变：
 *   state-success-primary  = #22c55e 绿
 *   state-warn-primary     = #f59e0b 橙
 *   state-error-primary    = #dc2626 红
 *   state-done-primary     = violet-600 紫
 *   state-business-primary = deepseek-500 蓝
 */
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** 抽一段源码：从 marker 到下一个 `\n    }`。 */
function block(marker) {
  const start = source.indexOf(marker)
  assert.ok(start > 0, '应有 ' + marker)
  const end = source.indexOf('\n    }', start)
  return source.slice(start, end)
}

describe('分类颜色只能用语义色', () => {
  it('CATEGORY_COLORS 里不出现 brand-primary', () => {
    const body = block('const CATEGORY_COLORS = {')
    assert.doesNotMatch(
      body,
      /--dsw-alias-brand-primary/,
      'brand-primary 在亮色主题下是 #0f1115 近黑，当分类色会让整列变成一片黑',
    )
  })

  it('也不用中性灰（label-tertiary / label-secondary 分不出组）', () => {
    const body = block('const CATEGORY_COLORS = {')
    // 只允许「其余/未知」那几档用中性色，正文分类必须是彩色
    const colorLines = body.split('\n').filter((line) => /:\s*'var\(--dsw-alias-/.test(line))
    const neutral = colorLines.filter((line) => /label-tertiary|label-secondary|label-primary/.test(line))
    // sigil 行之后的中性档位（session/browser/vision/creator/fun/other）是刻意留的
    assert.ok(neutral.length <= 6, '中性色的分类不该超过 6 个，实际 ' + neutral.length)
  })

  it('至少用到 4 种不同的语义色（否则分类还是分不出来）', () => {
    const body = block('const CATEGORY_COLORS = {')
    const used = new Set((body.match(/--dsw-alias-state-[a-z-]+/g) || []))
    assert.ok(used.size >= 4, '只用了 ' + used.size + ' 种语义色：' + [...used].join(', '))
  })
})

describe('变化标记只能用语义色', () => {
  it('CHANGE_META 里不出现 brand-primary', () => {
    const body = block('const CHANGE_META = {')
    assert.doesNotMatch(body, /--dsw-alias-brand-primary/)
  })

  it('三种状态各用一种语义色（新增橙 / 有变化绿 / 下架红）', () => {
    const body = block('const CHANGE_META = {')
    // 0.17.7 起两档对调：新增用橙（更醒目），有变化用绿（最常见、最不刺眼）
    assert.match(body, /added:[\s\S]{0,140}state-warn-primary/)
    assert.match(body, /updated:[\s\S]{0,140}state-success-primary/)
    assert.match(body, /removed:[\s\S]{0,140}state-error-primary/)
  })
})

describe('更新圆点只能用语义色', () => {
  it('updateDotStyle 不用 brand-primary', () => {
    const body = block('function updateDotStyle(freshness) {')
    assert.doesNotMatch(body, /--dsw-alias-brand-primary/)
  })

  it('用 success 绿（真绿 #22c55e），且分档靠亮度与光晕', () => {
    const body = block('function updateDotStyle(freshness) {')
    assert.match(body, /state-success-primary/, '绿点必须是真绿')
    // 分档：tracked 有双层光晕，fading 用半透明
    assert.match(body, /boxShadow:[\s\S]{0,200}34%/, 'tracked 档要有更强的光晕')
    assert.match(body, /color-mix[\s\S]{0,120}55%/, 'fading 档要用半透明')
  })
})

test('brand-primary 仍允许用于「强对比」场景（按钮填充 / 焦点环）', () => {
  // 这不是禁令 —— brand-primary 的本职就是与背景强对比。
  // 只禁止把它当"彩色语义"用。
  const buttonBody = block('const buttonStyle = (primary, disabled, small, tone) => {')
  assert.match(buttonBody, /brand-primary/, '主按钮填充应当继续用 brand-primary')
})

test('分类与变化标记的语义色都指向真实彩色（不写死十六进制）', () => {
  for (const marker of ['const CATEGORY_COLORS = {', 'const CHANGE_META = {']) {
    const body = block(marker)
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}/i, marker + ' 不该写死十六进制，主题切换会失控')
  }
})
