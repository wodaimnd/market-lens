/**
 * 测试夹具：只负责拼出各市场源的原始 item 形状。
 * key 期望值一律在用例里写死成完整字符串，避免夹具与断言互相“对齐”后一起漂移。
 */

export const PROFILE = 'desktop'

/** 按已审核的安装命令形状拼 install 串：dsh plugin --profile <p> add <target>。 */
export function install(target, profile = PROFILE) {
  return `dsh plugin --profile ${profile} add ${target}`
}

/** 1024Store /api/v2/plugins 的 item 形状（字段名来自 index.js 的 normalize1024 调用链）。 */
export function p1024Item(overrides = {}) {
  return {
    id: 9001,
    name: 'Acme Tool',
    url: 'https://github.com/acme/tool',
    install: install('github:acme/tool'),
    description: { zh: '来自 1024Store 的描述' },
    category: 'tools',
    installerCount: 55,
    installCount: 120,
    npmDownloads7d: 12,
    stars: null,
    forks: 3,
    pushedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  }
}

/** format 1 索引（dshfind / dsh.so / 自定义 format1 源）的 item 形状。 */
export function format1Item(overrides = {}) {
  return {
    id: 'f1-1',
    name: 'Acme Tool',
    title: 'Acme Tool',
    homepage: 'https://github.com/acme/tool',
    repository: { url: 'https://github.com/acme/tool' },
    description: '来自 format1 的描述',
    metadata: { category: 'tools', sortKeys: {} },
    ...overrides,
  }
}

/** 标准 catalog-source 页面（/v1/plugins）的 item 形状。 */
export function standardItem(overrides = {}) {
  return {
    id: 'std-1',
    name: 'acme-tool-std',
    displayName: 'Acme Tool',
    homepage: 'https://github.com/acme/tool',
    repository: { url: 'https://github.com/acme/tool' },
    description: '来自标准源的描述',
    categories: ['tools'],
    ...overrides,
  }
}
