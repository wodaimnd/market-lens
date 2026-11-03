/**
 * 安全优先视图的判定口径。
 *
 * 目录里的安全结论来自两处，彼此独立：
 *   - dsh.so 的 metadata.labels（risk-low / risk-medium / risk-high）→ row.security
 *   - dshmarketplace 的 item.installCheck（passed / failed / …）→ row.verification
 *
 * 「安全优先视图」默认只放行这两类正面结论：dsh.so 低风险，或安装验证通过。
 * 没审计过的条目（既没有风险评级，也没跑过安装验证）算 unfiltered 噪音，
 * 默认藏起来——这是「默认隐藏高风险/未审计」这条要求的落点。
 *
 * 判定必须与 client.js 的 securityState() 保持一致，否则会出现「表格里显示
 * 低风险，但安全视图把它藏了」这种自相矛盾的界面。两边都从这里取口径。
 */

/** 界面/筛选用的档位，顺序即「从安全到不安全」的展示顺序。 */
export const TRUST_TIERS = ['low', 'verified', 'unknown', 'medium', 'flagged', 'high']

const RISK_LEVELS = new Set(['low', 'medium', 'high'])

/**
 * 计算一行的信任档位。
 * @param {{security?: {riskLevel?: string, label?: string}|null, verification?: {installCheck?: string}|null, riskFlags?: string[]}} row
 * @returns {{tier: 'low'|'verified'|'unknown'|'medium'|'flagged'|'high', safe: boolean, reason: string, label: string|null, installCheck: string|null, riskLevel: 'low'|'medium'|'high'|null}}
 */
export function trustOf(row) {
  const security = row && typeof row === 'object' ? row.security : null
  const verification = row && typeof row === 'object' ? row.verification : null
  const rawRisk = security && typeof security === 'object' ? security.riskLevel : null
  const riskLevel = RISK_LEVELS.has(rawRisk) ? rawRisk : null
  const installCheck = verification && typeof verification === 'object' && verification.installCheck
    ? String(verification.installCheck)
    : null
  const flags = Array.isArray(row?.riskFlags) ? row.riskFlags.filter((flag) => typeof flag === 'string' && flag) : []
  const label = security && typeof security === 'object' && security.label ? String(security.label) : null

  const base = { label, installCheck, riskLevel }

  // 顺序即优先级：高风险与验证失败是否决项，不能被另一侧的正面结论抵消。
  if (riskLevel === 'high') return { ...base, tier: 'high', safe: false, reason: 'risk-high' }
  if (installCheck === 'failed') return { ...base, tier: 'flagged', safe: false, reason: 'install-check-failed' }
  if (flags.length) return { ...base, tier: 'flagged', safe: false, reason: flags.join(',') }
  if (riskLevel === 'medium') return { ...base, tier: 'medium', safe: false, reason: 'risk-medium' }
  if (riskLevel === 'low') return { ...base, tier: 'low', safe: true, reason: label || 'risk-low' }
  if (installCheck === 'passed') return { ...base, tier: 'verified', safe: true, reason: 'install-check-passed' }
  return { ...base, tier: 'unknown', safe: false, reason: 'unaudited' }
}

/** 安全优先视图里这一行是否可见。 */
export function safeViewVisible(row) {
  return trustOf(row).safe
}
