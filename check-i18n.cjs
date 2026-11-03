const fs = require('node:fs')
const src = fs.readFileSync('client.js', 'utf8').split(/\r?\n/)
// zh: 从 182 行到 en 块之前；en: 从 en 块到它的收尾
const keys = (from, to) => {
  const set = new Set()
  for (let i = from; i < to; i += 1) {
    const m = /^\s{6,8}([A-Za-z][A-Za-z0-9]*):/.exec(src[i])
    if (m) set.add(m[1])
  }
  return set
}
const enStart = src.findIndex((line) => /^\s*en: \{/.test(line))
const endIdx = src.findIndex((line, i) => i > enStart && /^\s{6}\}/.test(line))
const zh = keys(182, enStart)
const en = keys(enStart + 1, endIdx)
const used = new Set()
for (const line of src) for (const m of line.matchAll(/\bt\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)) used.add(m[1])
for (const line of src) for (const m of line.matchAll(/labelKey:\s*'([A-Za-z][A-Za-z0-9]*)'/g)) used.add(m[1])
const missingZh = [...used].filter((k) => !zh.has(k)).sort()
const missingEn = [...used].filter((k) => !en.has(k)).sort()
const onlyZh = [...zh].filter((k) => !en.has(k)).sort()
const onlyEn = [...en].filter((k) => !zh.has(k)).sort()
console.log('zh keys', zh.size, 'en keys', en.size, 'used', used.size)
console.log('missing zh:', missingZh.join(', ') || '(none)')
console.log('missing en:', missingEn.join(', ') || '(none)')
console.log('only zh:', onlyZh.join(', ') || '(none)')
console.log('only en:', onlyEn.join(', ') || '(none)')

