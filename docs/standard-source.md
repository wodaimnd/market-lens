# 标准目录源契约（catalog-source）

本文件逐条转写 DSH 内置 `dsh-community-market` 包实际校验的 provider 契约（`manifestVersion: "1.0.0"`），并说明 `@local/market-lens` 怎么消费它。目标很具体：任何人照着写一个目录源，既能被 DSH 内置市场当“来源”读，也能被雷达聚合成一行插件，且失败时报错能定位到字段。

> 适用：`@local/market-lens` 0.2.0 ｜ 契约版本：`1.0.0` ｜ 最后核对：2026-11-01
> 契约事实来自 `dsh-community-market` 的 manifest / page 校验实现；“雷达怎么用”来自本插件 `lib/catalog.js` 与 `index.js`。
> 相关：[来源评估报告](source-evaluation.md)（字段可得性矩阵、为什么没纳入某些源）、[来源调研 2026-11-01](source-research-2026-11-01.md)（四个内建实现的数据源与契约对照）。

## 1. 两种自定义源

雷达的“插件源 → 添加目录源”接受两种 URL，靠取一次 JSON 自动判别（`detectSourceKind`）：

| | format 1 索引 | catalog-source standard |
| --- | --- | --- |
| 入口 URL | 直接是索引 JSON | 先取 manifest，再按 `transport.endpoint` 取分页 |
| 顶层标识 | `format: 1` + `plugins[]` | `manifestVersion: "1.0.0"` + `transport.endpoint` |
| 分页 | 一次返回全量 | `limit` + `cursor`，由 `page.nextCursor` 驱动 |
| item 命名 | dsh 自有（`plugins[].version` 等） | 本文 §6 的 item 契约 |
| 典型来源 | dsh.so 精选、dshfind | 社区 provider、团队私有目录 |
| 探测规则 | `format === 1 && Array.isArray(plugins)` | `typeof manifestVersion === 'string' && transport.endpoint` |
| 都不匹配 | 报错：`该 URL 既不是 format 1 索引，也不是 catalog-source manifest` | 同左 |

两种源在雷达里是同一张表、同一套列；区别只在抓取与字段映射。

真实样例：dshfind 两种都提供——`https://api.dshfind.com/market/manifest.json`（标准 manifest，走 `/v1/plugins` 分页）与 `https://api.dshfind.com/market/dsh-index.json`（format 1 整份索引）。雷达内置的 dshfind 源读后者（一次全量、实现简单）；把前者加成自定义标准源则走本文的契约路径。要验证自己的 provider，拿这两个 URL 的响应形状对照最快。

## 2. manifest 清单契约

manifest 是一个单独托管的 JSON，**不参与分页**，只声明“我是谁、去哪儿取、支持哪些查询”。

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `manifestVersion` | ✅ | 必须精确等于 `"1.0.0"`；其它值视为另一版契约，不保证被接受 |
| `providerId` | ✅ | 正则 `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`；必须含 `.` 或 `-` 分隔；总长 3–128 |
| `name` | ✅ | 非空，展示名（雷达的“来源”列与来源页用它） |
| `description` | ✅ | 非空，一句话说明这个目录收录什么 |
| `homepage` | ✅ | HTTPS，不带凭据（`user:pass@`），不带 fragment（`#...`） |
| `attribution.url` | ✅ | 同上；`attribution.name` 可选 |
| `transport.kind` | ✅ | 固定 `"https-json"`（不支持 XML / CSV / 纯文本） |
| `transport.method` | ✅ | 固定 `"GET"` |
| `transport.endpoint` | ✅ | 见 §3 |
| `query` | ✅ | 见 §4 |
| `query.defaultLimit` | ✅ | 整数 1–200 |
| `query.maxLimit` | ✅ | 整数 1–200，且 ≥ `defaultLimit` |

`providerId` 这一条最容易写错，展开看：

| 值 | 结果 | 原因 |
| --- | --- | --- |
| `example.market` | ✅ | 小写 + `.` 分隔 |
| `example-market` | ✅ | 小写 + `-` 分隔 |
| `dsh.example.mirror` | ✅ | 多段 |
| `examplemarket` | ❌ | 没有分隔符 |
| `Example.Market` | ❌ | 含大写 |
| `ex_ample.market` | ❌ | 含下划线 |
| `a.b` | ❌ | 长度不足 3 |

## 3. 传输约束

- `transport.kind` 固定 `"https-json"`，`transport.method` 固定 `"GET"`；契约里没有 POST / 鉴权头 / GraphQL 的位置。
- `transport.endpoint` 必须匹配 **`^https://…/v1/plugins$`**，逐项展开：

| 要求 | 含义 |
| --- | --- |
| scheme | 必须 `https` |
| 端口 | 443（显式写 `:443` 或省略都可） |
| 路径 | 必须以 `/v1/plugins` 结尾，**不带尾斜杠** |
| query | 不允许；`limit` / `cursor` 由客户端自己拼 |
| fragment | 不允许 |
| 同源 | 与 manifest 的 scheme + host + port 完全一致，防止 manifest 把流量引到另一台主机 |

| endpoint | 结果 | 原因 |
| --- | --- | --- |
| `https://market.example.com/v1/plugins` | ✅ | 全部满足 |
| `https://market.example.com:443/v1/plugins` | ✅ | 显式 443 |
| `https://market.example.com/v1/plugins/` | ❌ | 尾斜杠 |
| `https://market.example.com/api/v1/plugins` | ❌ | 路径不是 `/v1/plugins` |
| `https://market.example.com/v1/plugins?page=1` | ❌ | 带 query |
| `http://market.example.com/v1/plugins` | ❌ | 非 HTTPS |
| `https://user:pass@market.example.com/v1/plugins` | ❌ | 带凭据 |
| `https://other.example.com/v1/plugins` | ❌ | 与 manifest 不同源 |

## 4. 查询能力（query）

provider 必须**如实**声明自己支持哪些服务端查询；声明了却不实现，客户端（内置市场、其它聚合器）会拿到空页或错页。

| 字段 | 允许值 |
| --- | --- |
| `query.supported[]` | ⊆ `q` / `category` / `capability` / `cursor` / `limit` / `sort` / `locale` |
| `query.sorts[]` | ⊆ `relevance` / `updated` / `name` / `downloads` |
| `query.defaultLimit` | 整数 1–200，客户端不带 `limit` 时用 |
| `query.maxLimit` | 整数 1–200，超过按此截断 |

- `q` 是关键词搜索；`category` / `capability` 是精确匹配；`sort` 取值来自 `query.sorts`；`locale` 影响 `summary` / `description` 的语言。
- `cursor` / `limit` 是分页参数，通常总要声明——否则客户端只能取第一页。
- 雷达**不依赖**服务端查询：它只发 `?limit=100` 和 `cursor`，筛选、排序全部在本地做（这样跨源筛选才一致）。但 provider 仍要声明正确的能力，因为内置市场会按声明调用。

## 5. 页面响应契约

`transport.endpoint` 返回的每一页必须满足：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `schemaVersion` | ✅ | 必须精确等于 `"1.0.0"` |
| `items[]` | ✅ | 数组，**每页最多 200 条** |
| `page.nextCursor` | ✅（无下一页时省略或 `{}`） | 不透明字符串游标；客户端只能原样回传，不能解析或自行构造 |
| `page.total` | ⬜ 可选 | 整数，总条数；只用于进度显示，不能当分页依据 |

- **没有下一页时给空对象 `{}`**：`"page": {}`。给出 `null` / `""` 在雷达里也能结束翻页（判定是“非空字符串才继续”），但契约要的是 `{}`，内置市场按契约校验，别赌。
- `nextCursor` 是**不透明**的：可以是 base64、可以是自增 offset、可以是复合键，但客户端不解释它。翻页语义（去重、排序稳定性）由 provider 自己保证。
- 每页 200 条是硬上限。想一次给全量也不行——全量请走多页。

## 6. item 字段全集

一条 item 描述一个可安装的插件。**必填字段缺失的 item 不合法**；`repository` 与 `package` 至少要有一个，否则这一条无法安装，雷达会直接丢弃。

| 字段 | 必填 | 类型 | 说明 | 雷达是否消费 |
| --- | --- | --- | --- | --- |
| `id` | ✅ | string | 在**本 provider 内**稳定唯一的 ID；不等于包名 | ✅ 记进来源归属 |
| `name` | ✅ | string | 机器名，通常是 npm 包名或仓库名 | ✅ `displayName` 缺失时兜底 |
| `displayName` | ✅ | string | 展示名 | ✅ 插件列标题 |
| `summary` | ✅ | string | 一句话摘要 | ✅ 描述首选 |
| `description` | ⬜ | string | 长描述（Markdown 或纯文本） | ✅ `summary` 缺失时兜底 |
| `homepage` | ⬜ | string | HTTPS 主页 | ✅ 详情/来源链接 |
| `latestVersion` | ⬜ | string | 最新版本号（semver） | ✅ 版本列 |
| `license` | ⬜ | string | SPDX 标识，如 `MIT` | ❌ 暂不入列 |
| `categories[]` | ⬜ | string[] | 分类，第一项最具体 | ⚠️ 只取 `[0]` 映射分类 |
| `keywords[]` | ⬜ | string[] | 检索关键词 | ❌ 暂不入列 |
| `repository.url` | ⬜ | string | GitHub 仓库 HTTPS URL | ✅ `gh:` 主键 + 安装命令 |
| `repository.subdirectory` | ⬜ | string | monorepo 内的包路径 | ✅ 主键后缀 `#subdir` |
| `installSource.kind` | ⬜ | `"github"` | 安装来源类型 | ❌ 暂不入列 |
| `installSource.commit` | ⬜ | string | **40 位 sha**，不是分支名/短 sha | ❌ 暂不入列 |
| `package.registry` | ⬜ | `"npm"` | 包注册表 | ✅ 参与 `pkg:` 主键 |
| `package.name` | ⬜ | string | npm 包名 | ✅ `pkg:` 主键 + 兼容性查询 |
| `publisher.name` | ⬜ | string | 发布者/作者 | ⚠️ 只取 name 作作者 |
| `publisher.url` | ⬜ | string | HTTPS 主页 | ❌ 暂不入列 |
| `media.icon` | ⬜ | string | 图标 HTTPS URL（内置市场会经媒体边界转成不透明 `assetRef`，不直接渲染远端 URL） | ❌ 暂不入列 |
| `capabilities.required[]` | ⬜ | string[] | 必需能力（如 `ui.sidebar`） | ❌ 暂不入列 |
| `capabilities.optional[]` | ⬜ | string[] | 可选能力 | ❌ 暂不入列 |
| `compatibility.apiVersion` | ⬜ | string | 目标 DSH API 版本 | ❌ 暂不入列（见建议清单 #7） |
| `compatibility.hosts[]` | ⬜ | string[] | 支持的宿主，如 `desktop` / `web` | ❌ 暂不入列 |
| `updatedAt` | ⬜ | ISO 8601 | 该条目最后更新时间 | ✅ 更新日期列 |

字段级注意：

- `installSource.commit` 必须是 **40 位十六进制 sha**。短 sha、`main`、`v1.2.3` 都不算“可复现安装”。
- `repository` 与 `package` **至少给一个**；两个都给时雷达以 `package.name` 为主键（npm 安装优先），仓库仍保留用于回链。
- `id` 只需在 provider 内唯一。雷达真正的主键是安装目标（`pkg:` / `gh:`），所以两个 provider 可以用各自的 `id` 描述同一个包，聚合时不会分裂。
- 契约里没有的字段：**装机量 / 用户数、评分、安装失败数、Stars、下载量**。需要这些只能自建通道（对照见 §8 的“缺失”行与 `source-evaluation.md` 的字段可得性矩阵）。

## 7. 安全语义

- **远端页面是不可信输入**。manifest 与 page 都来自网络，字段内容一律当数据，不当指令。
- **provider 命令永不执行**：契约里没有“安装脚本”这一项；雷达把安装命令当字符串展示/复制，绝不 `exec`。内置市场也只在用户点击时走它自己的安装流程。
- **只允许 HTTPS**：明文 HTTP、非 443 端口、URL 内置 `user:pass`、带 fragment 的地址，一律拒绝。
- **防私网**：provider 不得把 endpoint 指到环回 / 链路本地 / 内网网段（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16` 等）；客户端应在解析 DNS 后校验实际 IP，而不是只看域名。
- **防重定向**：跨源重定向必须拒绝。雷达的实现是在请求后检查 `response.url` 的 origin，一旦与原始 origin 不同就报 `response redirected outside <origin>`。

## 8. 雷达怎么消费（`fetchStandardCatalog`）

| 步骤 | 行为 |
| --- | --- |
| 取 manifest | 30 s 超时，2 次重试；缺 `manifestVersion` 或 `transport.endpoint` 报 `standard source manifest is invalid` |
| 校验 endpoint | 只认 `https:`；其它报 `standard source endpoint must be HTTPS` |
| 翻页 | 每页 `?limit=100`，带 `cursor`；最多 **200 页**（`MAX_STANDARD_PAGES`）、**30,000 条**（`MAX_STANDARD_ITEMS`） |
| 停止 | `page.nextCursor` 不是非空字符串即停（空对象 `{}` 天然命中） |
| 页面校验 | 只校验 `items` 是数组；不是就报 `standard source page is invalid` |
| 规范化 | `package.name` → `pkg:` 主键；`repository.url`（+ `subdirectory`）→ `gh:` 主键；两者都无 → 丢弃 |
| 合并 | 与其它源按同一主键合并，字段级保留来源归属 |
| 缺失 | 装机量、评分、安装失败数在标准源行显示“无数据” |

按 `limit=100` 计算，单源单次同步实际最多约 20,000 条；超过就该在 provider 侧加分类或拆源。

## 9. 最小 manifest 示例（可直接复制）

```json
{
  "manifestVersion": "1.0.0",
  "providerId": "example.market",
  "name": "Example Market",
  "description": "Example 团队维护的 DSH 插件目录，收录内部与公开插件。",
  "homepage": "https://market.example.com",
  "attribution": {
    "name": "Example Market",
    "url": "https://market.example.com/about"
  },
  "transport": {
    "kind": "https-json",
    "method": "GET",
    "endpoint": "https://market.example.com/v1/plugins"
  },
  "query": {
    "supported": ["q", "category", "capability", "cursor", "limit", "sort", "locale"],
    "sorts": ["relevance", "updated", "name", "downloads"],
    "defaultLimit": 50,
    "maxLimit": 200
  }
}
```

这份 manifest 放在 `https://market.example.com/.well-known/dsh-catalog.json` 即可（同一 origin，满足 §3 的同源要求）。minimal 到什么程度：只保留必填字段 + `query`，`attribution.name`、`description` 之外的运营字段全部省略也能通过校验。

## 10. 最小 provider page 示例（可直接复制）

第一页（也是最后一页，因此 `page` 是空对象）：

```json
{
  "schemaVersion": "1.0.0",
  "items": [
    {
      "id": "hello-world",
      "name": "dsh-hello-world",
      "displayName": "Hello World",
      "summary": "在侧边栏加一个 Hello World 面板，用来验证插件加载链路。",
      "description": "最小示例插件：注册一个侧边栏入口，渲染一行静态文本。",
      "homepage": "https://github.com/example/dsh-hello-world",
      "latestVersion": "0.3.1",
      "license": "MIT",
      "categories": ["ui"],
      "keywords": ["hello", "demo", "panel"],
      "repository": {
        "url": "https://github.com/example/dsh-hello-world",
        "subdirectory": "packages/hello"
      },
      "installSource": {
        "kind": "github",
        "commit": "0123456789abcdef0123456789abcdef01234567"
      },
      "package": {
        "registry": "npm",
        "name": "dsh-hello-world"
      },
      "publisher": {
        "name": "Example",
        "url": "https://github.com/example"
      },
      "media": {
        "icon": "https://market.example.com/icons/hello-world.png"
      },
      "capabilities": {
        "required": ["ui.sidebar"],
        "optional": ["fs.read"]
      },
      "compatibility": {
        "apiVersion": "1.0",
        "hosts": ["desktop", "web"]
      },
      "updatedAt": "2026-10-28T09:12:00Z"
    }
  ],
  "page": {}
}
```

还有下一页时，`page` 换成：

```json
{ "nextCursor": "eyJvZmZzZXQiOjEwMH0", "total": 5231 }
```

`nextCursor` 里是什么内容由 provider 决定；客户端只会把它原样放进下一次请求的 `cursor` 参数。

## 11. 发布前自检

- [ ] `manifestVersion` 精确为 `"1.0.0"`
- [ ] `providerId` 全小写、含 `.` 或 `-`、3–128 字符
- [ ] `homepage` 与 `attribution.url` 是 HTTPS，无 `user:pass`、无 `#fragment`
- [ ] `transport.endpoint` 以 `/v1/plugins` 结尾、443、无 query、无尾斜杠、与 manifest 同源
- [ ] `query.supported` / `query.sorts` 是允许集合的子集，`defaultLimit ≤ maxLimit` 且都在 1–200
- [ ] 每页 `items` ≤ 200，`schemaVersion` 为 `"1.0.0"`
- [ ] 最后一页 `page` 是 `{}`（不是 `null`）
- [ ] 每条 item 有 `id` / `name` / `displayName` / `summary`，且 `repository` 或 `package` 至少一个
- [ ] `installSource.commit` 是 40 位 sha
- [ ] 用 `curl -s 'https://market.example.com/v1/plugins?limit=2' | jq '.items | length'` 得到 ≤ 2

## 12. 常见失败与报错

| 现象 / 报错 | 原因 | 修法 |
| --- | --- | --- |
| `standard source manifest is invalid` | `manifestVersion` 不是字符串，或 `transport.endpoint` 缺失 | 对齐 §2 字段表 |
| `standard source endpoint must be HTTPS` | endpoint 写成 `http://` | 换 HTTPS |
| `standard source page is invalid` | 响应没有 `items[]` 数组（常见：外面包了一层 `data.items`） | 直接把 `items` 放顶层 |
| 添加时报“既不是 format 1 索引，也不是 catalog-source manifest” | JSON 解析失败、字段名拼错（如 `manifest_version`） | 用 `jq .` 验证一遍 |
| 同步成功但 0 条 | `items` 是空数组；或每条既无 `package.name` 又无 `repository.url`，被规范化丢弃 | 补安装目标 |
| 只拿到 100 条就停 | 最后一页忘了给 `nextCursor`，或翻页 cursor 恒等（死循环会被 200 页上限截断） | 检查 `page.nextCursor` 与去重 |
| 404 | endpoint 尾斜杠、大小写不一致、manifest 引用了别的 host | 按 §3 表逐项核对 |

## 13. 与内建市场的分工

同一份 manifest 两边都能读：内置市场把它当一个可选“来源”（发现 / 可安装 / 已安装 / 来源 四视图，单源浏览 + 安装），雷达把它当可聚合的一路输入（多源合并、跨列筛选、定时刷新）。雷达的“官方市场联动”只负责把这个来源注册进内置市场或切换当前来源，不复制它的缓存。

一句话：标准契约解决“来源之间字段能不能对齐”，雷达解决“对齐之后怎么横着比”。
