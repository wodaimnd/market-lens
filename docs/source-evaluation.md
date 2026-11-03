# 来源评估报告：DSH 插件市场源

评估日期：**2026-11-01**  
运行环境：DSH Desktop `2.0.21-next`，DSH 运行时 `0.2.1-rc.4`  
结论用途：决定 `@local/market-lens` 默认聚合哪些市场、每个源承担什么字段、哪些源只作为可选或暂不内置。

## 1. 判断框架

“市场风评”看的是**作为市场基础设施是否可靠**；“民间风评”看的是**社区是否真的在用、是否推荐、是否持续维护**。两项各 100 分，都是编辑判断，不是任何官方评级。

### 市场风评（100）

| 维度 | 权重 | 看什么 |
| --- | ---: | --- |
| 官方 / 内置集成 | 30 | 是否是 DSH Community Market 的内置合作源；是否有官方 adapter |
| 目录规模与覆盖 | 20 | 条目数、去重后的 npm 包、GitHub 仓库、安装目标类型 |
| 新鲜度与可用性 | 20 | 更新频率、分页/索引稳定性、实测请求是否成功、是否 stale |
| 字段完整度 | 20 | 用户数、评分、版本、更新日期、Stars、下载、兼容性原料、安全/安装验证 |
| 收录校验 / 编辑运营 | 10 | 静态校验、风险标记、安装验证、编辑推荐、分类运营 |

### 民间风评（100）

| 维度 | 权重 | 看什么 |
| --- | ---: | --- |
| GitHub 能见度 | 30 | Stars、Forks、被独立站点收录 |
| 独立推荐 | 30 | dshbase、dshpacks 等第三方站点的“已验证 / 推荐 / 需适配”结论 |
| 维护健康度 | 20 | 最近推送、未关闭 issue、贡献者数量 |
| 社区讨论 | 20 | 社区文章、论坛、对比评测中的口碑与争议 |

## 2. 结论

| 来源 | 市场风评 | 民间风评 | 角色 | 默认 |
| --- | ---: | ---: | --- | --- |
| **DSH 1024Store** | **92** | **78** | 官方合作；用户数、安装热度、Stars、更新日期、周下载 | 是 |
| **dshfind** | **88** | **82** | 官方合作；评分、编辑推荐、npm 版本、Stars | 是 |
| **dsh.so 市场** | **90** | **86** | 精选 format 1；安装验证 L4/L5 + 低风险审计；Stars/榜单 | 是 |
| **dshmarketplace.dev** | **84** | **80** | REST API；15,545 条，installCheck/riskFlags/许可证 | 否（可选） |
| **npm registry** | **95** | **60** | 元数据：版本、peerDependencies、engines.dsh | 是（仅元数据） |
| dshbase.com | 82 | 84 | 20,020 条，但只有 HTML 分页，暂不内置 | 否 |
| dsh.so 全量索引 | 86 | 86 | 27,631 条，含未验证/中高风险，暂不默认 | 否 |
| dshmarket（npm 包） | 60 | 85 | 市场客户端，不是目录源 | 否 |
| AAAMECHANIC/dsh-plugin-market | 55 | 45 | 过滤镜像，不纳入 | 否 |

## 3. DSH 1024Store

**端点**：`https://deepseek1024.com/api/v2/plugins`  
**官方 adapter**：`market.dsh-1024store-v2`（内置合作源）  
**仓库**：<https://github.com/imsai-sh/awesome-deepseek-harness-plugins>

### 市场侧证据

- 官方 Community Market 内置合作提供方；无需额外 adapter。
- 2026-11-01 实测：目录 **13,924 条**，70 页；去重后 **4,987 个 npm 包**、**11,538 个 GitHub 仓库**。
- 字段：`installerCount`、`installCount`、`installs7d/30d`、`stars`、`forks`、`pushedAt`、`updatedAt`、`npmDownloads7d`。是唯一稳定给出“用户数”口径的来源。
- 目录流水线静态校验 `package.json`、`dsh.bundle.patch` 与 patch 文件；不安装、不执行。
- 安装统计由 `dsh1024` CLI 上报，随机安装实例 ID，不上传路径/用户名/会话内容。

### 民间侧证据

- dshbase 标为“已验证 · 实测可装 / 推荐”：291 Stars、275 Forks、69 个未关闭 issue，最近推送 2026-10-13：
  <https://dshbase.com/zh/plugins/awesome-deepseek-harness-plugins/>
- 社区文章把它列为少数提供搜索、排行榜与免费 API 的目录之一，同时指出插件市场同质化严重：
  <https://bsia.org.cn/site/content/34445.html>

### 注意事项

- 2026-11-01 请求返回 `source=stale`，目录更新有延迟。
- 大量同仓库/同包重复；本插件按 npm 包名与仓库身份去重。
- 没有评分字段（0 / 13,924），评分列显示“无数据”。
- `failureCount` 口径不透明，只放详情作参考。
- 用户数只统计 `dsh1024` CLI 安装，是下限。

## 4. dshfind

**索引**：`https://api.dshfind.com/market/dsh-index.json`（format 1）  
**官方 adapter**：`market.dshfind-v1`（内置合作源）  
**站点**：<https://dshfind.com>  
**仓库**：<https://github.com/hikariming/dshfind>

### 市场侧证据

- 官方 Community Market 内置合作提供方；另提供 format 1 索引。
- 2026-11-01 实测：**6,222 条**（比上次 5,974 增长），全部 npm 包且仓库回链；每日刷新。
- 字段：`metadata.sortKeys.stars`、`metadata.sortKeys.score`、`metadata.labels`（featured）、`category`、`versions[].version/publishTimestamp`。
- 评分只覆盖 **167** 个（约 2.7%），不是全量评分；不提供用户数/安装数。
- 不提供 peerDependencies/engines，需要 npm latest 判定兼容性。

### 民间侧证据

- dshbase 标为“已验证 · 实测可装 / 推荐”：306 Stars、21 Forks、39 个未关闭 issue，最近推送 2026-10-13：
  <https://dshbase.com/zh/plugins/dshfind/>
- dshpacks 显示 190 Stars、最近推送 2026-09-21，并标注“needs adapt”，说明第三方站点对其适配状态有分歧：
  <https://www.dshpacks.com/plugins/hikariming-dshfind/>

### 注意事项

- 没有用户数/安装数；只在 dshfind 出现的插件用户数列显示“无数据”。
- 评分是 dshfind 自有运营评分，不是用户星级。
- 评分覆盖低，不能外推。

## 5. dsh.so 市场

**索引**：`https://cdn.dsh.so/market/index.json`（format 1，10,366 条）  
**全量索引**：`https://cdn.dsh.so/plugins-index.json`（27,631 条，未默认）  
**数据接口**：<https://www.dsh.so/zh/data/>  
**站点**：<https://www.dsh.so>

### 市场侧证据

- 独立社区项目，提供 24,185 个插件的目录、L1–L5 安装验证、安全审计、榜单与开放数据接口。
- 精选市场只收“当前 dsh 版本安装验证通过（L4/L5）+ 安全结论低风险”的组合包；critical/medium/未审计/装不上被排除。
- 2026-11-01 实测：索引 **10,366 条**，全部有 `install-verified` 与 `risk-low` 标签；7 MB，CDN 每小时缓存，免密钥、CORS 全开。
- 字段：stars、分类、版本、`engines.dsh`、榜单/风险标签；不提供用户数/评分。
- 全量索引 27,631 条，含 24,814 audited/low、1,196 medium、360 high、19 critical；默认不接，避免把高风险条目混入首屏。

### 民间侧证据

- 数据接口、安装验证、安全审计与榜单在社区中被多处引用；规模位于生态前列。
- 精选市场的低风险过滤，与 dshbase/dshmarketplace 的实测推荐形成交叉验证。
- 独立项目，不隶属 DeepSeek；安全结论是站点自有审计，不是官方评级。

### 注意事项

- 只有精选子集，覆盖小于全量索引。
- format 1 没有用户数/安装数；安全/验证等级只作展示与筛选参考。
- 榜单标签/编辑推荐由 dsh.so 运营，不等于本插件背书。

## 6. dshmarketplace.dev

**API**：`https://dshmarketplace.dev/api/v1/plugins`  
**站点**：<https://dshmarketplace.dev>  
**Python 客户端**：<https://pypi.org/project/dshmarketplace/>

### 市场侧证据

- 公开 REST API：2026-11-01 实测 `total=15,545`，`page/limit` 分页，limit 实际上限约 96 条/页。
- 字段：`npmPackage`、`install`、`installCheck`、`installCheckDsh`、`riskFlags`、`summaryZh`、`license`、`stars`、`pushedAt`、`repoUrl`。
- 安装验证状态（passed/failed/unknown）与风险标记（terminal surface、requires credentials 等）可直接筛选。
- 同时被 Python 包与 npm CLI 读取，数据口径相对稳定。

### 民间侧证据

- 在 DSH 社区被多个客户端/教程引用，提供网页、npm CLI、Python 库三种入口。
- 条目有摘要、许可证、GitHub 活跃度，适合交叉校验。
- 没有官方合作身份；收录与验证是站点自有运营。

### 注意事项

- 没有用户数/评分；安装验证不等同于安全审计。
- 全量约 162 页，首次同步较慢；默认关闭。
- riskFlags 是站点判断，本插件只展示原始标记。

## 7. npm registry

**端点**：`https://registry.npmjs.org/{package}/latest`  
**用途**：版本、`engines.dsh`、`@deepseek-ai/dsh*` peerDependencies；不作为发现列表。

- DSH 官方插件管理器安装 registry 包时的版本与 peer 兼容性权威来源；本插件沿用 app-boot 规则。
- 覆盖去重后的 **8,806 个 npm 包**；GitHub-only 条目显示“无 npm 包”。
- 没有用户数、评分、收录审核或 DSH 兼容性徽章。

## 8. 为什么没纳入其他源

### dshbase.com

- 20,020 个插件、7,843 个已验证、15 大类；字段含信任等级、协议、更新时间、安装命令。
- 但目录是 HTML 分页（201 页×100），没有发现稳定公开 JSON API；抓取脆弱，暂不内置。
- **0.3.0 的正式决定**：不接 HTML。解析模板类名与分页结构，对方改一次版式就静默坏掉，而坏掉时表现为“这个源的插件变少了”而不是“解析失败”，属于最难排查的一类错误。现在 `detectSourceKind` 会在探测前按域名拦下 dshbase，导入配置里的 `kind: "dshbase"` 也会被跳过并写明原因；等它有 JSON 端点，按 `docs/standard-source.md` 的契约接入即可，不用改其它代码。
- <https://dshbase.com/zh/plugins/directory/>

### dsh.so 全量索引

- 27,631 条，字段更全，但含 1,196 medium、360 high、19 critical；默认不混入首屏。
- 需要更完整的风险提示/过滤后再作为默认源。

### dshmarket / 其他客户端

- 本身是市场 UI，不是可复用目录源；数据仍来自上游目录。

### GitHub topic / awesome list

- 上游发现机制，不带用户数/评分/安装验证；通过上述标准化源间接覆盖。

## 9. 实测复核

| 项目 | 值 |
| --- | --- |
| 合并去重插件 | **23,033** |
| 来源条目 | 1024Store 13,924 · dshfind 6,222 · dsh.so 10,366 |
| 有用户数 | 9,982 |
| 有评分 | 167 |
| 有 Stars | 21,678 |
| 有安全/验证结论 | 10,366 |
| npm 包 | 8,806 |
| 兼容 / 不兼容 | 3,544 / 1,817 |
| 未声明 / 未知 / 无 npm | 3,380 / 65 / 14,227 |
| 检测中 | 0 |
| 标准源实测 | format 1 索引与 standard manifest 均可添加、同步、移除 |
| 运行时 | 0.2.1-rc.4 |
| 评估日期 | 2026-11-01 |

## 10. 字段可得性矩阵

选源时最容易犯的错，是“加了一列”就默认“每个源都填得出来”。按列拆开看，结论完全不同：

| 我们的列 | 标准 catalog 契约 | 1024Store v2 API |
| --- | --- | --- |
| 更新日期 | `updatedAt` | `updatedAt` / `pushedAt` |
| 适配 DSH 版本 | `compatibility.apiVersion` + `hosts` | 无直接字段，需从 npm engines 推断 |
| 插件版本 | `latestVersion` | 无 |
| 装机量（用户数） | **契约无此字段** | `installCount` / `installerCount` / `installs30d` |
| 评分 | **无** | **无**（只有 `stars` 星数） |
| 安装失败数 | 无 | `failureCount` |

### 10.1 三条硬规则

1. **评分在任何来源都拿不到真实用户评分。** 只有 dshfind 的 0–100 运营评分，覆盖 167/6,222；其余来源连字段都没有。所以“评分”列正确做法是显示 **“无数据”**，而不是 0——0 在数值排序里会把“没数据”压到底，读起来像差评，这是把缺失当成负向信号，属于数据失真。
2. **用户数只在 1024Store 通道可得。** `installerCount` 只统计 `dsh1024` CLI 安装，是下限样本；标准契约、dshfind、dsh.so、dshmarketplace 都没有等价字段。
3. **安装失败数只有 1024Store 的 `failureCount`**，口径不透明。市场风评的加权项是 rating / users / freshness / pick，民间风评是 stars / downloads / freshness / forks，都不含 failures——所以它只能当参考，不能当质量结论。目前仅出现在详情“失败计数（参考）”。

### 10.2 合并后的实际覆盖（实测 2026-11-01）

| 列 | 有值的行 | 来源 |
| --- | ---: | --- |
| 用户数 | 9,982 | 仅 1024Store |
| 评分 | 167 | 仅 dshfind |
| Stars | 21,678 | 1024Store + dshfind + dsh.so + dshmarketplace |
| 版本 | 8,806 个 npm 包 | dshfind / dsh.so / npm latest；GitHub-only 行显示“无 npm 包” |
| 安装失败数 | 未统计 | 仅 1024Store，且只在详情展示 |

### 10.3 各来源能填哪些列

- **1024Store**：用户数、安装失败数、Stars、更新日期；无版本、无评分。
- **dshfind**：评分（167）、Stars、版本、发布时间；无用户数。
- **dsh.so**：版本、`engines.dsh`、Stars、安装验证 L4/L5、安全等级；无用户数/评分。
- **dshmarketplace**：`installCheck` / `riskFlags` / `pushedAt` / `license` / `stars`；无版本、无用户数、无评分。
- **npm registry**：版本、`engines.dsh`、`peerDependencies`；没有目录语义，只作判定原料。
- **标准契约**：`updatedAt` / `latestVersion` / `categories[]` / `repository` / `package` / `compatibility`；无用户数、无评分、无安装失败数。

### 10.4 结论

“评分列大面积无数据”不是缺陷，是来源现状；把它换成 0 或隐藏整列才是。需要人气排序时用市场风评 / 民间风评 / 内部 `heat`，不要伪造一个评分。

## 11. 标准目录源（catalog-source）作为第五类通道

### 11.1 为什么单独评估

前面四个目录源都是自有格式（REST 或 format 1），字段随源而变，接入等于写一次映射；**standard 是唯一有公开契约的通道**——任何 provider 按 `manifestVersion 1.0.0` 发布，雷达与 DSH 内置市场读到的是同一份定义。契约全文（manifest / page / item 字段全集 + 可复制示例）见 [标准目录源契约](standard-source.md)。

### 11.2 契约保证什么、不保证什么

| 契约保证（可按字段名依赖） | 契约完全不提供 |
| --- | --- |
| `id` / `name` / `displayName` / `summary` | 装机量 / 用户数 |
| `repository{url,subdirectory}` 或 `package{registry,name}`（至少一个） | 评分 |
| `updatedAt` / `latestVersion` | 安装失败数 `failureCount` |
| `categories[]` / `keywords[]` / `license` | Stars / Forks / 下载量 |
| `installSource{kind,commit}`（40 位 sha） | 编辑推荐 / 榜单 |
| `capabilities` / `compatibility{apiVersion,hosts}` | 安全审计结论 |

### 11.3 定位判断

- **替代不了** 1024Store（用户数唯一来源）、dshfind（评分唯一来源）、npm（兼容性原料）。
- **能补**：长尾目录、团队私有目录、社区自建镜像——接一次就获得与其他源一致的去重、筛选、定时刷新。
- **规模上限**：单源单次同步最多 200 页 / 30,000 条（按 `?limit=100` 计算约 20,000 条），超大目录要在 provider 侧分片或加分类。

### 11.4 安全语义

契约要求：远端页面是不可信输入、provider 命令永不执行、只允许 HTTPS 且不带凭据、防私网与跨源重定向。

本插件当前落实：URL 校验 scheme / 443 / 无凭据 / 无 fragment；重定向只认同源（`response redirected outside <origin>`）；单次响应 ≤ 24 MB。尚未落实：按 DNS 解析结果拦截私网 IP——标准源允许任意第三方域名，这是它的主要攻击面（见建议清单第 9 条）。

### 11.5 与 DSH 内置市场的关系

DSH Desktop 内置 `dsh-community-market`（**发现 / 可安装 / 已安装 / 来源** 四视图，单源浏览 + 安装）与 `@deepseek-ai/dsh-plugin-market`（index URL 模型，一次一个来源）。同一份 manifest 两边都能吃：内置市场把它当一个可选来源，雷达把它当一个可聚合输入。

雷达不重复面板，也不接管安装；差异化的部分只有四件——**跨源聚合去重、Excel 式多列组合筛选、列宽拖动与列显隐、定时刷新**。这些正是内置市场刻意不做的。完整对照见 [README](../README.md) 的“与 DSH 内置市场的关系”一节。

### 11.6 后续

12 条按“价值/成本”排序的落地建议（逐源健康度持久化、错过补偿、`failureCount` 成列、`heat` 升为可见列、CSV 来源归属、源订阅导入、版本区间过滤、快照对比、SSRF 防护、契约校验器、commit 固定安装、源级缓存分片）在 [README](../README.md) 的“额外利好建议清单”里，这里不重复。

> 本报告是产品选源判断，不是安全审计。目录收录、评分、Stars、安全结论都不代表代码安全；安装前请自行审查来源与权限。
