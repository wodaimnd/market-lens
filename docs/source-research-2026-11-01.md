# DSH 插件市场：来源调研与接入契约（2026-11-01）

调研对象：`G:\AI PGRM\DSH\plugins\market-lens` 要不要接、接什么、按什么契约接。
方法：先读本机 asar 里 4 个市场实现与官方契约文档（一手），再用 web_fetch 实测端点（二手证据）。**未改动任何代码或配置。**

---

## 0. 结论先行

1. **DSH 没有"官方插件市场服务端"。** 官方市场（`@deepseek-ai/dsh-plugin-market`）是一个**读取器**：`indexes` 默认 `[]`，零索引源，用户不加源就不发任何请求。所以"接市场"不是接官方 API，而是接**第三方目录源**。
2. **本机已存在两套并存的标准契约**，这是本次调研最重要的发现：
   - **A. 目录提供方契约 v1**（`dsh-community-market`，Desktop 内置）：静态 manifest + `GET /v1/plugins` + provider page，严格 JSON Schema，匿名、无 token、同源、HTTPS 443。
   - **B. 市场索引 format 1**（`@deepseek-ai/dsh-plugin-market-index`）：**单个静态 JSON**，`format:1` + `plugins[].versions[]`，支持 npm / git 两种安装源和 `engines.dsh`。
3. **"用户数 / 评分"在这两套契约里都没有一等字段。** A 套完全没有；B 套只能塞进 `metadata.sortKeys.<id>`（声明式数值排序键，配 `metadata.sortKeys.<id>.title/order`）。dsh.so 正是这样把 `stars` / `downloads` 装进去的，market-lens 也正是从 `sortKeys.score/stars/downloads` 读的。
4. **真正给出装机量的只有一个源**：1024Store v2（`installCount` / `installerCount` / `installs7d|30d`）。其余全部只能拿 GitHub star 或 npm 下载量当代理。
5. 公开可接入的 DSH 目录源已经**不止 4 个**，但质量分层明显；HTML 抓取（dshbase）应继续拒绝。

---

## 1. 本机已有的 4 个市场实现 × 各自数据源与契约

| # | 实现 | 角色 | 上游数据源（实测） | 契约形态 | 认证 | 字段要点 | 风险 |
|---|---|---|---|---|---|---|---|
| 1 | `dsh-community-market` 0.1.0-dev.0（Desktop 内置） | 官方"社区市场"UI + 受限 HTTP + 安装交接 | 无内置目录；用户登记的 **manifest URL**；另有两个受审合作 adapter：`deepseek1024.com/api/v2/plugins`、`api.dshfind.com` | 契约 A：manifest + `GET /v1/plugins`，4 份 Draft 2020-12 Schema | 匿名，契约**禁止**任何 header/token/cookie | 无 users/rating；有 latestVersion、license、updatedAt、engines 无（兼容性靠 `compatibility.hosts` 自由字符串） | 低（schema 严格、fail-closed） |
| 2 | `@deepseek-ai/dsh-plugin-market-index` 0.2.1-rc.4 | format 1 **校验器库**（无 I/O） | 无（纯函数） | 契约 B：`parseMarketIndex(value, indexUrl)` | 无 | 支撑 `author`、`repository`、`versions[].{version,publishTimestamp,source,engines.dsh}`、`metadata.sortKeys` | 低 |
| 3 | `@deepseek-ai/dsh-plugin-market` 0.2.1-rc.4 | Web「发现」页 + `plugin_market` 工具 | **无默认源**（`indexes: []`），只读用户配置的 URL | 消费 format 1，拒绝重定向，`maxBytes` 128 MiB，15 s 超时，`cacheTtlMs` 10 min | 无 | 只暴露索引里有的字段；无 users/rating 概念 | 低 |
| 4 | `dshmarket`（第三方大市场） | 完整市场 App（安装/更新/回滚/热禁用） | `https://awesome-dsh-plugin.com/plugins.json`（实时，无快照兜底）；npm 包 `dsh-plugin-catalog` 作镜像；索引镜像 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` | 自有 wire 格式 + 对外提供 format 1 索引 + 更新 API v1（beta） | 无 | 目录由 CI 每日刷新；star、npm 映射来自上游；自带 npm 镜像回退 | 中（依赖单一上游 + GitHub Pages 可达性） |

**备注**

- **1**：契约原文明确"没有默认、优先或兜底目录来源"，首次启动必须由用户选择；`BUILT_IN_PROVIDERS` 只有 `1024store` 和 `dshfind` 两个合作源，且都需要用户显式添加。见 `docs/catalog-provider-contract.zh.md`、`lib/catalog/service.js:8`。
- **2**：这是**最轻的接入面**——一份 JSON 就能被 DSH Web 的「发现」页和 `plugin_market` 工具读到，不需要服务端。见 `lib/index.js`（`parseMarketIndex`）。
- **3**：默认零源是关键约束——market-lens 若能产出一份 format 1 索引，就是"给官方市场供源"，而不是"再做一个市场"。
- **4**：`dshmarket/README.zh.md` 第 130 行起「数据源」一节写得很清楚：每次打开都实时请求 `plugins.json`，刻意不做本地快照兜底。

来源 URL：
<https://github.com/anywhere-labs/deepseek-harness-desktop>（`dsh-community-market` 仓库字段）·
<https://github.com/deepseek-ai/deepseek-harness>（`dsh-plugin-market` / `-index` 仓库字段）·
<https://github.com/dsh-market/dsh-market>

---

## 2. 可接入来源主表（外部端点）

| 来源 | 类型 | endpoint / 拉取方式 | 认证 | 配额 | 可得字段（更新 / 适配版本 / 装机量 / 评分） | 风险 |
|---|---|---|---|---|---|---|
| **DSH 1024Store v2** | 合作 REST（分页 JSON） | `GET https://deepseek1024.com/api/v2/plugins?page={n}&limit={1..200}&q=&category=&sort=name\|active\|installs` | 无 | 未公布（**未证实**） | 更新 ✅`pushedAt`/`updatedAt`；适配 ⚠️仅 install 命令里的 npm 名；**装机量 ✅唯一**（`installCount`/`installerCount`/`installs7d|30d`）；评分 ❌ | 中 |
| **dshfind 标准源** | 契约 A 标准来源 | `GET https://api.dshfind.com/market/manifest.json` → `GET /market/v1/plugins?q=&category=&cursor=&limit=` | 无 | 契约文档记 30 次/分、突发 10（**引用，未自测**） | 更新 ✅`pushed_at`；适配 ❌（无 engines）；装机量 ❌；评分 ✅但仅 167 条 `sortKeys.score` | 低-中 |
| **dshfind format 1 索引** | 静态 JSON | `GET https://api.dshfind.com/market/dsh-index.json` | 无 | 同上 | 同上 + `versions[].engines.dsh` | 低-中 |
| **dsh.so 精选市场** | 静态 JSON（format 1） | `GET https://cdn.dsh.so/market/index.json` | 无（免密钥，CORS 全开） | CDN 每小时缓存；无公布配额 | 更新 ✅`publishTimestamp`；适配 ✅`engines.dsh`；装机量 ❌（只有 `sortKeys.downloads` 的 npm 周下载快照）；评分 ❌（有 `install-verified`/`risk-low` 标签） | 低 |
| **dshmarketplace.dev** | REST（分页） | `GET https://dshmarketplace.dev/api/v1/plugins?page=&limit=`（实测上限约 96/页） | 无 | 未公布（**未证实**） | 更新 ✅`pushedAt`；适配 ✅`installCheckDsh`（如 `0.2.1-rc.5`）；装机量 ❌；评分 ❌（有 `installCheck`、`riskFlags`） | 中 |
| **npm registry** | 包元数据 | `GET https://registry.npmjs.org/{pkg}/latest` | 无 | 未公布 | 更新 ✅`time`；适配 ✅`engines.dsh` + peerDeps；装机量 ❌；评分 ❌ | 低 |
| **npm downloads API** | 统计 | `GET https://api.npmjs.org/downloads/point/last-week/{pkg}` | 无 | 未公布 | **装机量代理 ✅**（实测 `dshmarket` last-week = 361,739）；其余 ❌ | 低 |
| **npm search API** | 检索 | `GET https://registry.npmjs.org/-/v1/search?text=dsh-plugin&size=250` | 无 | 未公布 | `downloads.weekly/monthly`、`score.final`、`date`、`license`、`publisher`；**`total` 是文本命中数，不是包数**（实测 300,466） | 中 |
| **GitHub topic 检索** | REST 检索 | `GET https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&per_page=100` | token 可选（匿名可用） | **实测** core 60/h、search 10/min | 更新 ✅`pushed_at`；适配 ❌；装机量 ❌；评分＝star ⚠️（实测 `topic:dsh-plugin` 命中 25,464 个仓库，大量蹭标签，精度极低） | 高 |
| **GitHub 仓库元数据** | REST | `GET https://api.github.com/repos/{owner}/{repo}` | 同上 | 同上 | `stargazers_count`/`forks_count`/`pushed_at`/`license`/`topics`/`archived` | 低 |
| **MCP Registry（官方）** | 官方 registry REST | `GET https://registry.modelcontextprotocol.io/v0/servers?limit=&cursor=` | 无（读取） | 未公布 | 更新 ✅`publishedAt`/`updatedAt`；适配 ❌；装机量 ❌；评分 ❌；`_meta.official.status` 才是它的价值 | 低 |
| **awesome-dsh-plugin 目录** | GitHub Pages 静态 JSON | `GET https://awesome-dsh-plugin.com/plugins.json` | 无 | 未公布 | star / npm 映射 / 精选（由 `dshmarket` 消费）；**本次 30 s 两次超时，内容未证实** | 中-高 |
| **dsh-plugin-catalog（npm）** | npm 分发的同一目录 | `GET https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` | 无 | 未公布 | format 1；**本次 fetch failed，未证实** | 中 |
| **dshbase.com** | HTML 分页 | 201 页 × 100 条 | 无 | 未知 | 号称有信任等级/协议/更新时间；**无公开 JSON API** | 高（抓取脆弱） |

**逐行备注**

- **1024Store**：唯一带真实安装统计的源，但也最"脏"——本次抓取返回 `"source":"stale"`、`generatedAt` 2026-11-01T11:48:05Z、`total` 13,924，且大量同仓库重复项。端点见 `lib/adapters/dsh-1024store.js:5`。<https://deepseek1024.com/api/v2/plugins?page=1&limit=1>
- **dshfind**：唯一同时提供"标准 manifest"和"format 1 索引"两种形态的源，manifest 实测 200 且完全合规（`supported:[q,category,cursor,limit]`、`defaultLimit:50`、`maxLimit:100`、`sorts:[]`）。但 `/market/v1/plugins?limit=2` 本次 30 s 超时——分页端点较慢，接入要按 30 次/分做串行节流。<https://api.dshfind.com/market/manifest.json>
- **dsh.so**：`cdn.dsh.so/market/index.json` 实测 200，返回干净 format 1：`metadata.sortKeys = {stars:{order:desc}, downloads:{order:desc}}`，每条的 `metadata.sortKeys` 直接给 `{stars, downloads}`，`labels` 里有 `install-verified`/`risk-low`。这是**评分/热度字段能落地的最好范式**。<https://cdn.dsh.so/market/index.json>
- **dshmarketplace**：实测 `total: 15545`，单条含 `installCheck:"passed"`、`installCheckDsh:"0.2.1-rc.5"`、`riskFlags:["terminal surface"]`、`license:"MIT"`、`stars`、`pushedAt`、`npmPackage`、`subpath`。<https://dshmarketplace.dev/api/v1/plugins?page=1&limit=1>
- **npm downloads**：注意这是**包下载量**，不是"装了多少人"；一个 CI 每次装 20 遍也会计入。作为跨源统一的热度指标够用，作为"用户数"不够。<https://api.npmjs.org/downloads/point/last-week/dshmarket>
- **npm search**：`total` 字段极易被误读——`text=dsh-plugin` 返回 300,466，是文本相关性命中，不是插件数；真实包量要另算。<https://registry.npmjs.org/-/v1/search?text=dsh-plugin&size=2>
- **GitHub topic**：25,464 个仓库里混进了 `morluto/rea`（417k star）、`nexu-io/open-design` 这类只是打了标签的项目。**必须二次过滤**（看 `package.json` 是否有 `dsh` 字段 / `bundle.patch`），否则召回高、精度灾难。<https://api.github.com/search/repositories?q=topic:dsh-plugin&per_page=3>
- **GitHub 配额**：匿名实测 `core 60/h`、`search 10/min`，够做增量校验，不够做全量发现。<https://api.github.com/rate_limit>
- **MCP Registry**：官方预览版，`v0/servers` 支持 cursor，`_meta` 里带 `status/publishedAt/updatedAt/isLatest`；**没有任何热度字段**，官方定位就是"给下游聚合器提供元数据"。<https://registry.modelcontextprotocol.io/v0/servers?limit=1>
- **awesome-dsh-plugin**：组织仓库 21,873 star、6,193 fork、license CC0-1.0，`plugins.json` 是 `dshmarket` 的唯一实时源；但本次连续两次 30 s 超时，只验证到站点首页 200。<https://awesome-dsh-plugin.com/>
- **dshbase**：HTML 分页，无 JSON API，抓取一旦改版就全断，不建议接。<https://dshbase.com/zh/plugins/directory/>

---

## 3. 标准源契约细节（契约 A，`dsh-community-market`）

### 3.1 源声明（manifest）必填字段

`manifestVersion`（固定 `"1.0.0"`）、`providerId`（反向域名，`^[a-z0-9]+(?:[.-][a-z0-9]+)+$`）、`name`、`attribution{name,url}`、`transport{kind:"https-json", endpoint, method:"GET"}`、`query{supported, defaultLimit, maxLimit, sorts}`。

硬约束（schema + 语义校验双重）：

- `endpoint` **必须以 `/v1/plugins` 结尾**，绝对 HTTPS、443 端口、无 query/fragment、无凭据，且与 manifest **同 origin**；
- `additionalProperties: false`，出现 `selected`/`enabled`/`priority`/auth/header/script/install 字段 → 直接拒绝（这是安全边界，不是风格问题）；
- `defaultLimit <= maxLimit <= 200`，`limit` 1–200；
- `supported` 只能取 `q|category|capability|cursor|limit|sort|locale`；
- `sorts` 为空时不得声明支持 `sort`。

### 3.2 拉取与查询

```text
GET https://catalog.example.org/v1/plugins?q=memory&category=utility&limit=50
Accept: application/json
```

- `category` / `capability` 序列化为**重复参数**；`category` 是 OR，`capability` 是 AND。
- 只发送 manifest `query.supported` 里声明过的参数；缺省值省略，不发空串/null。
- 运行预算（写进契约，不是实现细节）：单响应 **2 MiB**、最多 **3 次 redirect**、connect 8 s / first-byte 12 s / total 30 s。
- 网络边界：拒绝 loopback / private / link-local / metadata 地址，DNS pinning 防 rebinding，不带任何 ambient cookie 或 auth header。

### 3.3 分页与快照

- provider page：`{schemaVersion, items[], page{nextCursor?,total?}}`，`items` ≤ 200 且 ≤ 生效 limit。
- Host 注入 provenance（`sourceRecordId` / `adapterId` / `fetchedAt` / `finalUrl`）后产出**标准化 snapshot**；`{sourceRecordId, itemId}` 是条目的唯一身份，跨源绝不合并。
- cursor 只属于「一个来源 + 一个有效 query」，换源/换 filter 必须丢弃。
- 失败语义：超时、非 200、错 content-type、超限、parse 失败、schema version 不支持 → **只让该来源失败**，不回退、不兜底、不影响启动。

### 3.4 鉴权与"不能做什么"

- 公开 v1 **只支持匿名**。没有 token、没有自定义 header、没有 cookie。
- 远程数据不能提供 install command、adapter 代码、mapping 表达式、HTML/script、图标 URL（图标只能经 Host 媒体边界变成不透明 `assetRef`）。
- 想接"已有 API 但结构不合规"的源 → 只能走**受审 adapter**（本地 TS，随 Market 发布），不能让 provider 下发代码。

---

## 4. 最小可用自定义源（可直接落盘）

### 4.1 源侧：你要托管的两份 JSON

**`manifest.json`**（放在 `https://your.host/catalog/manifest.json`）：

```json
{
  "manifestVersion": "1.0.0",
  "providerId": "com.example.my-catalog",
  "name": "My DSH Catalog",
  "attribution": {
    "name": "My DSH Catalog",
    "url": "https://your.host/"
  },
  "transport": {
    "kind": "https-json",
    "endpoint": "https://your.host/catalog/v1/plugins",
    "method": "GET"
  },
  "query": {
    "supported": ["q", "category", "cursor", "limit"],
    "defaultLimit": 50,
    "maxLimit": 50,
    "sorts": []
  }
}
```

**`/catalog/v1/plugins`** 最小响应（一条即可上线）：

```json
{
  "schemaVersion": "1.0.0",
  "items": [
    {
      "id": "my-plugin",
      "name": "dsh-plugin-my-plugin",
      "displayName": "My Plugin",
      "summary": "一句话说明这个插件做什么。",
      "categories": ["tools"],
      "package": { "registry": "npm", "name": "dsh-plugin-my-plugin" }
    }
  ],
  "page": {}
}
```

> 注意：`id`、`name`、`displayName`、`summary` 四个必填；`repository` 与 `package` **至少给一个**；`page` 是必填对象，没有下一页就给 `{}`。

### 4.2 消费侧：market-lens 真正生效的文件不是 `sources.json`

这是本次最容易踩的坑：

- `plugins/market-lens/sources.json` 是**评估档案（dossier）**——`marketScore` / `marketEvidence` / `caveats` / `numbers`，只用于展示"为什么选这个源"，**不参与运行时拉取**。
- 运行时来源列表在 `source-config.json`（`lib/source-config.js:9`，`CONFIG_FILE`），结构是：

```json
{
  "version": 1,
  "refreshIntervalMinutes": 0,
  "lastAutoRefreshAt": null,
  "sources": [
    {
      "id": "my-catalog",
      "kind": "standard",
      "name": "My DSH Catalog",
      "short": "my",
      "color": "#8a94a6",
      "enabled": true,
      "builtin": false,
      "manifestUrl": "https://your.host/catalog/manifest.json"
    }
  ]
}
```

- `kind` 支持 `1024store | dshfind | dshso | dshmarketplace | standard | format1`（`index.js:513-548`）。`standard` 读 `manifestUrl`，`format1` 读 `url`。
- 也可以用 UI/接口加：`POST` 添加来源时 `detectSourceKind()` 会先 fetch 一次，识别是 `format:1` 索引还是 `manifestVersion` manifest，识别不了直接报"既不是 format 1 索引，也不是 catalog-source manifest"。
- **删掉 `kind` 字段不叫"自定义源"**，会 fallback 成 `standard`。

### 4.3 如果坚持写进 `sources.json`（档案条目）

```json
{
  "key": "my-catalog",
  "name": "My DSH Catalog",
  "short": "mycatalog",
  "role": "标准源 · format 1 / catalog-source manifest",
  "homepage": "https://your.host/",
  "endpoint": "https://your.host/catalog/manifest.json",
  "partnership": false,
  "defaultEnabled": false,
  "marketScore": 0,
  "communityScore": 0,
  "marketEvidence": [],
  "communityEvidence": [],
  "caveats": ["评分待补：未实测字段完整度"],
  "fields": {
    "users": false,
    "rating": false,
    "version": true,
    "updated": true,
    "compatibility": "via-npm",
    "stars": false,
    "downloads": false
  },
  "links": [{ "label": "站点", "url": "https://your.host/" }],
  "numbers": {}
}
```

---

## 5. 推荐的接入优先级（前 3）

1. **dsh.so 精选索引（`https://cdn.dsh.so/market/index.json`）**
   理由：唯一同时满足「format 1 结构干净」「免密钥 + CDN + CORS」「`sortKeys` 里直接有 stars 与 downloads」「自带 install-verified / risk-low 标签」的源；一次 GET 拿全量，没有分页和限流焦虑。缺点是没有装机量、只是精选子集。

2. **DSH 1024Store v2（`https://deepseek1024.com/api/v2/plugins`）**
   理由：**唯一**能给出装机量口径（`installCount` / `installerCount` / `installs7d|30d`）的源，且自带 `stars`、`pushedAt`、分类 facet。任何"按真实使用量排序/显示"的需求都绕不开它。代价是：`source:"stale"`、目录重复、无评分、有 `failureCount` 这类不可解释字段，必须去重并显式标注"下限样本"。

3. **dshfind 标准源（manifest `https://api.dshfind.com/market/manifest.json`）**
   理由：它是全生态里**契约合规度最高**的实现（manifest + `/v1/plugins` 分页 + `data_version` 一致性），还额外给 `sortKeys.score`（167 条运营评分）与 featured 标签，是"评分"这一列唯一有真值的来源。代价是无装机量、端点在本次实测中较慢（30 s 超时），必须串行 + 30 次/分节流。

> 次选：`dshmarketplace.dev`（有 `installCheckDsh` 明确的 DSH 版本适配证据 + `riskFlags`，适合做"适配版本"列），以及 `api.npmjs.org/downloads`（做全源统一的下载量补充，不作为独立源）。

---

## 6. 字段缺口说明（现实里拿不到的）

| 字段 | 现实情况 | 建议展示 |
|---|---|---|
| **用户数 / 装机量** | 只有 1024Store 的 `installCount`，且仅统计经 `dsh1024` CLI 的安装，是**下限样本**；npm 周下载量是"安装次数"不是"人数" | 1024Store 以外的源一律显示"无数据"；不要用 star 冒充 |
| **用户评分（星级/打分）** | **全生态不存在开放的评分体系**。dshfind 的 `score` 是站点自有运营评分且只覆盖 167 条；dsh.so 的 `install-verified`/`risk-low` 是标签不是评分 | 显示为"无数据"，或明确标注"dshfind 运营评分（覆盖 N 条）" |
| **适配版本（engines.dsh）** | 只有 format 1 的 `versions[].engines.dsh` 和 npm `engines.dsh` / peerDeps 是机器可读的；契约 A 的 `compatibility.hosts` 是自由字符串，无法比对 | 统一走 npm `latest` 判定；契约 A 只作展示 |
| **许可** | 契约 A 有 `license`（可选），format 1 **没有** license 字段（market-lens 里恒为 `null`）；GitHub API 有 `license.spdx_id` 但只代表仓库 | 有则显示，无则"未知" |
| **更新时间** | 各源口径不同：`pushedAt`（代码推送）、`publishTimestamp`（发布）、`updatedAt`（目录更新）、`generatedAt`（目录生成） | 必须带来源前缀，如"1024Store 更新于…" |
| **评分覆盖度** | dshfind 167/6,222（约 2.7%） | 显示分母，禁止外推 |
| **HTML 抓取源（dshbase）** | 201 页 × 100 条，无公开 JSON API | 不接；标注"暂无机器可读接口" |

---

## 7. market-lens 与这 4 个实现的重叠 / 差异

**重叠（已经覆盖，不用重做）**

- market-lens 的 `kind` 已经是超集：`1024store`、`dshfind`、`dshso`、`dshmarketplace`、`standard`、`format1`（`index.js:513-548`）。
- 字段归一化已就位：`normalizeFormat1` 从 `metadata.sortKeys` 取 `score/stars/downloads`（`lib/catalog.js:199-201`），`normalizeStandardItem` 覆盖 `package/repository/publisher/latestVersion/updatedAt`（`lib/catalog.js:340-407`）。
- 官方那套"无默认源、用户显式选择"的信任模型，market-lens 用"内置源可停用、自定义源需 detect"实现了等价物。

**差异（值得补的）**

1. **数据源入口不同**：官方 dshfind adapter 走 `api.dshfind.com/market/manifest.json` + `/v1/plugins` 分页；market-lens 走 `api.dshfind.com/market/dsh-index.json` 整份索引。后者更简单但绕开了官方一致性校验（`data_version`），且整份拉取更重。
2. **market-lens 没有把 GitHub topic / npm search 作为发现源**：现在完全依赖 4 个成品目录，长尾插件（没进目录的）看不到。这是最大的覆盖缺口，但也是噪声最大的路——必须加 `dsh` 字段/`bundle.patch` 二次过滤。
3. **评估档案 ≠ 运行时配置**：`sources.json` 里的 `marketScore`（92/88/90…）是编辑评分，容易被误读成"官方评级"；建议在 UI 上把口径写死。
4. **`sources.json` 与 `source-config.json` 没有同步机制**：改了档案不会改运行时，反之亦然。接入新源时两处都要写，否则出现"文档里有、UI 里没有"。

---

## 8. 实际访问过的 URL 清单（复核用）

**本机（只读）**

- `G:\AI PGRM\DSH\plugins\market-lens\sources.json`
- `G:\AI PGRM\DSH\plugins\market-lens\docs\source-evaluation.md`
- `G:\AI PGRM\DSH\plugins\market-lens\index.js` · `lib\catalog.js` · `lib\source-config.js`
- `D:\work tools\AI\DSH\DSH N\DSH NEXT\resources\app.asar` → 解包到 `%TEMP%\dsh-market-pkgs\`：
  `node_modules/dsh-community-market/{README.zh.md,docs/catalog-provider-contract.zh.md,docs/catalog-adapter-guide.zh.md,docs/schemas/*.json,docs/examples/*.json,lib/adapters/{standard-http,dshfind,dsh-1024store}.js,lib/catalog/service.js}`
  `node_modules/@deepseek-ai/dsh-plugin-market-index/{README.zh.md,lib/index.js}`
  `node_modules/@deepseek-ai/dsh-plugin-market/{README.zh.md,lib/types/index-url.js}`
  `node_modules/dshmarket/{README.zh.md,UPDATE-API-V1.md,lib/regions.js}`

**联网实测（HTTP 状态为本次真实返回）**

| URL | 结果 |
|---|---|
| `https://deepseek1024.com/api/v2/plugins?page=1&limit=1` | 200，`total:13924`、`source:"stale"` |
| `https://api.dshfind.com/market/manifest.json` | 200，标准 manifest |
| `https://api.dshfind.com/market/v1/plugins?limit=2` | **30 s 超时**（未证实内容） |
| `https://cdn.dsh.so/market/index.json` | 200，format 1 |
| `https://dshmarketplace.dev/api/v1/plugins?page=1&limit=1` | 200，`total:15545` |
| `https://api.npmjs.org/downloads/point/last-week/dshmarket` | 200，`downloads:361739` |
| `https://registry.npmjs.org/-/v1/search?text=dsh-plugin&size=2` | 200，`total:300466` |
| `https://api.github.com/rate_limit` | 200，core 60/h、search 10/min |
| `https://api.github.com/search/repositories?q=topic:dsh-plugin&per_page=3` | 200，`total_count:25464` |
| `https://api.github.com/search/repositories?q=awesome+dsh+in:name&sort=stars&per_page=5` | 200，`total_count:92` |
| `https://api.github.com/repos/punkpeye/awesome-mcp-servers` | 200，97,154 star（对照：MCP 生态的量级） |
| `https://registry.modelcontextprotocol.io/v0/servers?limit=1` | 200，官方 MCP Registry |
| `https://awesome-dsh-plugin.com/` | 200（首页） |
| `https://awesome-dsh-plugin.com/plugins.json` | **30 s 超时 ×2**（未证实） |
| `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` | **fetch failed**（未证实） |
| `https://dshmarket.com/index.json` | **30 s 超时**（未证实） |
| `https://raw.githubusercontent.com/shutongX/dsh-plugins-index/main/README.md` | **fetch failed**（仓库页面 200，README 内容未证实） |
| `https://raw.githubusercontent.com/vbarter/dsh-plugin-registry/main/README.md` | **fetch failed**（同上） |

**未证实项汇总**：`awesome-dsh-plugin.com/plugins.json` 内容、jsdelivr 镜像、`dshmarket.com/index.json`、两个第三方索引仓库的 README、1024Store / dshmarketplace 的官方配额数字、dshfind 30 次/分的实测（仅引用契约文档）。

**联网补充的"别人也在做收录"**（GitHub 组织/仓库，仅元数据级证实）：

- `awesome-dsh-plugin/awesome-dsh-plugin` — 21,873 star、6,193 fork、CC0-1.0，`dshmarket` 的上游 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- `bruc3van/awesome-dsh-plugin` — 485 star，自称每天抓 `dsh-plugin` 并人工复核 <https://github.com/bruc3van/awesome-dsh-plugin>
- `beancookie/awesome-dsh-plugin` — 186 star，GitHub Pages 站点 <https://github.com/beancookie/awesome-dsh-plugin>
- `Alex-Yanggg/awesome-DSH-plugin` — 104 star <https://github.com/Alex-Yanggg/awesome-DSH-plugin>
- `shutongX/dsh-plugins-index` — 自称 DSH 插件市场索引聚合 <https://github.com/shutongX/dsh-plugins-index>
- `vbarter/dsh-plugin-registry` — 自称社区注册表，支持 browse/publish/auto-discover <https://github.com/vbarter/dsh-plugin-registry>
- `punkpeye/awesome-mcp-servers` — 97,154 star，MCP 生态的对照量级 <https://github.com/punkpeye/awesome-mcp-servers>
- MCP 官方 Registry（预览）— <https://modelcontextprotocol.io/registry/about>
