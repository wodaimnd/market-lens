// @local/market-lens — browser half.
// Contract: window.__ModuleLoader__.load({ id, factory(require) {...} }).
// React comes from the browser module table; no @deepseek-ai/dsh-client-* imports.
// All network calls are same-origin POSTs to /api/market-lens; the Host owns
// source allowlists, caching and the npm compatibility checks.

window.__ModuleLoader__.load({
  id: '@local/market-lens',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const {
      useCallback,
      useDeferredValue,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React

    const ENDPOINT = '/api/market-lens'
    const PANEL_ID = 'market-lens'
    const FILTER_STORE = 'market-lens:filters:v2'
    // 浮窗的位置/尺寸也记在 localStorage：换页面回来还在原处，不用每次重新拖。
    const WINDOW_STORE = 'market-lens:windows:v1'
    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

    // 弹层要挂到 document.body 上才躲得开 DSH 面板的 overflow 裁剪与 transform 上下文；
    // react-dom 拿不到时退化成行内渲染，位置会偏但功能不丢。
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    const STATIC_SOURCE_LABELS = {
      '1024store': { label: '1024', long: 'DSH 1024Store', color: '#5b9dff' },
      dshfind: { label: 'find', long: 'dshfind', color: '#b48cff' },
      dshso: { label: 'dsh.so', long: 'dsh.so 市场', color: '#4cc9b0' },
      dshmarketplace: { label: 'dshm', long: 'dshmarketplace.dev', color: '#f08c5a' },
      npm: { label: 'npm', long: 'npm registry', color: '#e0a458' },
    }
    const SOURCE_REGISTRY = new Map(Object.entries(STATIC_SOURCE_LABELS))

    function registerSourceConfig(config) {
      const sources = config && Array.isArray(config.sources) ? config.sources : []
      for (const source of sources) {
        if (!source || typeof source.id !== 'string') continue
        SOURCE_REGISTRY.set(source.id, {
          label: source.short || source.name || source.id,
          long: source.name || source.id,
          color: source.color || '#8a94a6',
        })
      }
    }

    const sourceMeta = (key) => SOURCE_REGISTRY.get(key) || {
      label: String(key || '?').slice(0, 10),
      long: String(key || '?'),
      color: '#8a94a6',
    }
    const sourceLabel = (key) => sourceMeta(key).label
    const sourceLongLabel = (key) => sourceMeta(key).long
    const sourceColor = (key) => sourceMeta(key).color

    const CATEGORY_LABELS = {
      tools: { zh: '工具与能力', en: 'Tools' },
      ui: { zh: '界面增强', en: 'UI' },
      dev: { zh: '开发与运行时', en: 'Dev' },
      skill: { zh: '技能包', en: 'Skills' },
      session: { zh: '会话与消息', en: 'Sessions' },
      model: { zh: '模型与账号', en: 'Models' },
      workflow: { zh: '工作流', en: 'Workflow' },
      fun: { zh: '娱乐', en: 'Fun' },
      notify: { zh: '通知与集成', en: 'Notify' },
      theme: { zh: '主题外观', en: 'Themes' },
      memory: { zh: '记忆', en: 'Memory' },
      client: { zh: '客户端', en: 'Clients' },
      agent: { zh: 'Agent 增强', en: 'Agent' },
      channel: { zh: '通道通知', en: 'Channels' },
      resource: { zh: '资源导航', en: 'Resources' },
      docs: { zh: '文档与内容', en: 'Docs' },
      remote: { zh: '远程运维', en: 'Remote' },
      browser: { zh: '浏览器', en: 'Browser' },
      vision: { zh: '视觉理解', en: 'Vision' },
      market: { zh: '市场与插件管理', en: 'Market' },
      data: { zh: '数据与存储', en: 'Data' },
      security: { zh: '安全', en: 'Security' },
      productivity: { zh: '效率', en: 'Productivity' },
      content: { zh: '内容创作', en: 'Content' },
      office: { zh: '办公文档', en: 'Office' },
      search: { zh: '联网搜索', en: 'Search' },
      agents: { zh: '智能体编排', en: 'Agents' },
      creator: { zh: '内容与社交', en: 'Creator' },
      other: { zh: '其他', en: 'Other' },
    }

    const COMPAT_ORDER = ['ok', 'bad', 'none', 'unknown', 'pending', 'no-package']
    const COMPAT_COLORS = {
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      none: 'var(--dsw-alias-label-secondary)',
      unknown: 'var(--dsw-alias-state-warn-primary)',
      pending: 'var(--dsw-alias-brand-primary)',
      'no-package': 'var(--dsw-alias-label-secondary)',
    }

    // min 是「用户能拖到多窄」，不是推荐宽度：表格动辄 14 列，min 定太大等于
    // 让列宽无法释放给别的列。名称列尤其明显——它默认吃掉 1fr，min 180 时
    // 拖不动，其它列只能横向滚动。这里把 min 压到「够放表头两个汉字 + 省略号」。
    const COLUMNS = [
      { key: 'name', width: 200, min: 96, max: 520, filter: null, sortable: true },
      { key: 'sources', width: 104, min: 48, max: 200, filter: 'set', sortable: false },
      { key: 'category', width: 100, min: 52, max: 180, filter: 'set', sortable: true },
      { key: 'version', width: 92, min: 48, max: 200, filter: 'text', sortable: true, defaultVisible: false },
      { key: 'updatedAt', width: 108, min: 64, max: 190, filter: 'date', sortable: true },
      { key: 'compat', width: 116, min: 60, max: 180, filter: 'set', sortable: true },
      { key: 'users', width: 92, min: 50, max: 160, filter: 'number', sortable: true, align: 'right' },
      { key: 'rating', width: 80, min: 44, max: 140, filter: 'number', sortable: true, align: 'right' },
      { key: 'market', width: 106, min: 52, max: 170, filter: 'number', sortable: true, align: 'right' },
      { key: 'community', width: 106, min: 52, max: 170, filter: 'number', sortable: true, align: 'right' },
      { key: 'stars', width: 84, min: 46, max: 150, filter: 'number', sortable: true, align: 'right' },
      { key: 'downloads', width: 88, min: 46, max: 160, filter: 'number', sortable: true, align: 'right', defaultVisible: false },
      { key: 'security', width: 108, min: 56, max: 190, filter: 'set', sortable: true, defaultVisible: false },
      // 行内「装 / 更新」：安装状态直接长在这颗按钮上（装 → … → 已装 / 更新），
      // 所以不再单开一栏「安装状态」——两栏同时讲一件事，卸载之后还会互相打脸
      // （按钮靠乐观集合显示 ✓、状态列读目录显示「未安装」）。
      // 筛选能力没有丢：这一列承接原来的「已安装 / 未安装」筛选，另外多给一个「可更新」。
      { key: 'actions', width: 78, min: 56, max: 130, filter: 'set', sortable: true, align: 'center' },
    ]
    const DEFAULT_COLUMN_WIDTHS = Object.fromEntries(COLUMNS.map((column) => [column.key, column.width]))
    const DEFAULT_COLUMN_VISIBILITY = Object.fromEntries(COLUMNS.map((column) => [column.key, column.defaultVisible !== false]))
    const COLUMN_STORE = 'market-lens:columns:v2'
    // v3：删掉了「安装状态」列，筛选 key 也从 installed 改成 actions。
    // 旧 key 不升级的话，老会话里存的 {installed:['yes']} 会继续生效却没有对应的
    // 列和 chip —— 表格看着「少了条目」，而用户找不到是哪个筛选在挡。
    const COLUMN_VISIBILITY_STORE = 'market-lens:visibility:v3'
    const FILTER_ROW_STORE = 'market-lens:filterrow:v1'
    // 「我刚翻到第十页」这件事必须活过一次重新进入面板——以前只有 filters 记在
    // sessionStorage 里，页码、每页条数、视图页签、排序、滚动位置全在内存里，
    // 切走再回来就回到第 1 页、默认列数、默认排序，等于每次都要重翻一遍。
    const PAGE_STORE = 'market-lens:page:v1'
    const SORT_KEYS = new Set(COLUMNS.map((column) => column.key))
    const PAGE_SIZES = [50, 100, 200]

    /** 读一份「上次看到哪儿」的快照；任何一步出问题都退回默认值，绝不让面板打不开。 */
    function readPageState() {
      const fallback = { version: 1, view: 'table', page: 1, pageSize: 100, search: '', sort: { key: 'heat', dir: 'desc' }, scrollTop: 0 }
      try {
        const raw = typeof localStorage !== 'undefined' && localStorage ? localStorage.getItem(PAGE_STORE) : null
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return fallback
        return {
          version: 1,
          view: ['table', 'installed', 'custom', 'sources', 'rules', 'logs', 'settings'].includes(parsed.view) ? parsed.view : fallback.view,
          page: Number.isFinite(parsed.page) && parsed.page >= 1 ? Math.floor(parsed.page) : fallback.page,
          pageSize: PAGE_SIZES.includes(parsed.pageSize) ? parsed.pageSize : fallback.pageSize,
          search: typeof parsed.search === 'string' ? parsed.search.slice(0, 200) : fallback.search,
          // 列已经删掉的旧排序列不再认：否则表格按一个不存在的 key 排序，看着像乱了。
          sort: parsed.sort && SORT_KEYS.has(parsed.sort.key) && (parsed.sort.dir === 'asc' || parsed.sort.dir === 'desc')
            ? { key: parsed.sort.key, dir: parsed.sort.dir }
            : fallback.sort,
          scrollTop: Number.isFinite(parsed.scrollTop) && parsed.scrollTop > 0 ? parsed.scrollTop : 0,
        }
      } catch {
        return fallback
      }
    }

    /**
     * 记住当前页签 / 页码 / 每页条数 / 搜索词 / 排序 / 滚动位置。
     * 写失败只是下次要多翻一次，所以静默吞掉异常。
     */
    function writePageState(patch) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return
        const previous = readPageState()
        localStorage.setItem(PAGE_STORE, JSON.stringify({ ...previous, ...patch, version: 1 }))
      } catch {
        // localStorage can be unavailable in a sandboxed webview.
      }
    }

    /** 记住表格滚到哪儿了。高频事件，所以只在数值真的变了之后写。 */
    function rememberScrollTop(node) {
      if (!node) return
      try {
        const top = Math.max(0, Math.round(node.scrollTop || 0))
        if (top === lastScrollTop) return
        lastScrollTop = top
        writePageState({ scrollTop: top })
      } catch {
        // 同上
      }
    }
    let lastScrollTop = 0

    /**
     * 这一行能不能一键安装。必须与 Host 的 installSpecFor 完全一致：
     * 有 npm 包名，或 GitHub 仓库（含 #path: 子目录）。
     * 两边不一致就会出现「按钮亮着但点了 400」。
     */
    function canInstallRow(row) {
      if (!row) return false
      if (typeof row.pkg === 'string' && row.pkg) return true
      return typeof row.repo === 'string' && /^https?:\/\/github\.com\//i.test(row.repo)
    }

    /**
     * 行的稳定身份。Host 的 publicRow 只给 id（= 内部 key），没有 key 字段：
     * 之前按钮用 row.key 比对，undefined === undefined 永远成立，
     * 于是「装一个插件」把整张表都刷成已安装。所有身份比较都必须过这个函数。
     */
    function rowKeyOf(row) {
      if (!row) return ''
      return String(row.id || row.key || row.pkg || row.repo || '')
    }

    /**
     * 安装请求必须带整行快照，而不是只带 key。
     * 目录是异步同步的：用户打开详情后目录刷新/切源，key 可能已经不在当前 rows 里；
     * Host 用快照里的 pkg/repo/installCommand 继续安装，不需要用户先刷新。
     */
    function installTargetForRow(row) {
      if (!row) return null
      return {
        key: rowKeyOf(row) || null,
        pkg: row.pkg || null,
        repo: row.repo || null,
        version: row.version || row.compat?.version || null,
        name: row.name || row.title || null,
        title: row.title || row.name || null,
        installCommand: row.installCommand || null,
      }
    }

    const TEXTS = {
      zh: {
        nav: '插件市场雷达',
        title: '插件市场雷达',
        subtitle: '聚合 DSH 1024Store、dshfind、dsh.so、dshmarketplace 与自定义目录源，按用户数、评分、更新日期和 DSH 兼容性做 Excel 式多重筛选。',
        table: '插件表格',
        sources: '来源与口径',
        navMarket: '市场',
        navInstalled: '已安装',
        navCustom: '自定义安装',
        navSources: '来源',
        navSettings: '设置',
        installedEmpty: '这个 profile 里还没有装任何插件。到「市场」页挑一个装上，或用「自定义安装」直接输入包名。',
        installedTitle: '已安装的插件',
        installedIntro: '本 profile 里已经装好的插件。版本、来源与可更新状态来自宿主的依赖清单与 npm 元数据。',
        installedColName: '包名',
        installedColVersion: '版本',
        installedColSource: '来源',
          installedColActions: '操作',
        installedCheckUpdates: '检查更新',
        installedChecking: '检查中…',
        installedUpToDate: '已是最新',
        installedHasUpdate: '可更新到',
        installedUnknown: '未知',
        installedCountChip: '已装',
        installedUpdatableChip: '可更新',
        installedUpdateAction: '更新',
        installedColLatest: '最新版本',
        installedRefresh: '刷新清单',
        installedSearchPlaceholder: '按包名过滤…',
        installedNoMatch: '没有匹配的已装插件。',
        installedKindLocal: '本地包',
        installedKindArchive: '压缩包',
        installedNoRegistry: '本地安装，没有 registry 版本',
      installedNoRegistryGithub: '从仓库安装，版本由 GitHub 决定',
        customTitle: '自定义安装',
        customIntro: '直接输入 npm 包名（可带版本）、github:owner/repo 或 GitHub 地址，安装走官方插件管理器。同一时刻只允许一个安装任务。',
        customSpecLabel: '安装目标',
        customSpecPlaceholder: '如 dsh-compat-vet 或 github:owner/repo',
        customVerdict: '装前判定',
        customVerdictRun: '判定',
        customVerdictRunning: '判定中…',
        customVerdictApprove: '通过',
        customVerdictWarn: '有提示',
        customVerdictVeto: '被拦下',
        customInstall: '安装',
        customInstalling: '安装中…',
        customVerdictHint: '目标会先过一遍白名单（包名 / github:owner/repo / GitHub 地址），再交给官方插件管理器执行；这里不做人工审核。',
        settingsTitle: '设置',
        settingsIntro: '刷新计划、表格外观、配置导入导出，以及这个插件自身的信息。',
        settingsRefresh: '刷新计划',
        settingsColumns: '表格列',
        settingsTransfer: '配置导入导出',
        settingsGithub: 'GitHub',
        settingsAbout: '关于',
        repoOnGithub: '在 GitHub 上查看',
        reportIssue: '报告问题',
        repoLabel: '仓库',
        licenseLabel: '许可证',
        versionLabel: '版本',
        starLabel: '星标',
        forkLabel: '复刻',
        issueLabel: '议题',
        githubStatsUnavailable: 'GitHub 统计暂不可用（网络或限流），链接仍可正常打开。',
        sync: '同步市场',
        resync: '刷新目录',
        cancel: '取消同步',
        clearCache: '清除缓存',
        clearCacheConfirm: '再点一次确认清除本地缓存',
        searchPlaceholder: '搜索插件、包名、作者、仓库或描述…',
        filters: '筛选',
        clearFilters: '清除全部筛选',
        noData: '无数据',
        loading: '加载中…',
        error: '出错了',
        retry: '重试',
        total: '插件总数',
        withUsers: '有用户数',
        withRating: '有评分',
        compatible: '兼容已判定',
        installedCount: '已安装',
        onboardingTitle: '先把市场搬进本地',
        onboardingBody: '首次同步会拉取已启用的市场源（1024Store 分页目录、dshfind / dsh.so 的 format 1 索引，可选 dshmarketplace），然后用 npm 元数据判定每个插件的 DSH 兼容性。目录会缓存在 $DSH_HOME/market-lens。',
        onboardingSources: '已启用的市场源',
        startSync: '开始同步（约 3–8 分钟）',
        syncing: '同步中',
        compatChecking: '兼容性检测',
        cacheAt: '缓存于',
        neverSynced: '尚未同步',
        noCache: '暂无本地缓存',
        emptyFiltered: '没有符合当前筛选条件的插件。',
        emptyCatalog: '目录为空，先同步一次。',
        freshnessTitle: '部分来源不可用：',
        freshnessRepeated: '（连续失败，本节结果可能缺少它那份条目）',
        freshnessNever: '（从未成功拉取过）',
        freshnessSyncing: '正在同步…',
        freshnessRetry: '强制重试',
        page: '第',
        of: '页，共',
        pageSize: '每页',
        rows: '条',
        exportCsv: '导出 CSV',
        detail: '插件详情',
        close: '关闭',
        description: '描述',
        packageName: 'npm 包',
        author: '作者',
        repo: '仓库',
        source: '来源',
        category: '分类',
        version: '版本',
        updated: '更新日期',
        compat: '适配 DSH',
        users: '用户数',
        rating: '评分',
        market: '市场风评',
        community: '民间风评',
        stars: 'Stars',
        installed: '安装状态',
        yes: '已安装',
        no: '未安装',
        unknown: '未知',
        pending: '检测中',
        noPackage: '无 npm 包',
        notDeclared: '未声明',
        compatibleShort: '兼容',
        incompatible: '不兼容',
        all: '全部',
        selectAll: '全选',
        clear: '清空',
        apply: '应用',
        searchValues: '搜索取值…',
        includeNull: '包含无数据',
        min: '最小',
        max: '最大',
        from: '从',
        to: '到',
        datePreset: '快捷范围',
        last7: '近 7 天',
        last30: '近 30 天',
        last90: '近 90 天',
        thisYear: '今年',
        anyDate: '不限',
        filterTitle: '筛选',
        activeFilters: '已启用筛选',
        userCountNote: '1024Store 去重安装实例数；仅通过 dsh1024 CLI 安装会计入，因此是下限。',
        ratingNote: 'dshfind 自有评分（0–100），仅 167 个插件有；不是用户星级。',
        noUserDataNote: '1024Store 未统计该插件，或该插件没有 npm 包。',
        noRatingDataNote: 'dshfind 没有给该插件评分。',
        compatNote: '用 npm latest 的 engines.dsh 或 @deepseek-ai/dsh-* peerDependencies 对当前 DSH 运行时做 semver 判定。',
        marketNote: '本插件计算的 0–100 风评指数：官方评分、用户数、新鲜度、编辑推荐/覆盖度加权；不是官方评级。',
        communityNote: '本插件计算的 0–100 民间风评：Stars、下载、新鲜度、Forks 加权；无 Stars 时显示无数据。',
        sourcesTitle: '为什么是这些源',
        evaluatedAt: '评估日期',
        columns: '列',
        columnSettings: '列设置',
        nameColumn: '插件',
        versionColumn: '版本',
        downloadsColumn: '周下载',
        securityColumn: '安全 / 验证',
        resetWidths: '恢复默认列宽',
        pluginSources: '插件源',
        sourceFilter: '筛选显示',
        sourceEnabled: '纳入同步',
        addStandardSource: '添加标准目录源',
        standardUrlPlaceholder: 'https://example.com/format1.json 或 manifest.json',
        add: '添加',
        manageSources: '管理来源',
        schedule: '定时刷新',
        scheduleOff: '关闭',
        scheduleEvery: '每',
        scheduleMinutes: '分钟',
        scheduleHours: '小时',
        nextRefresh: '下次刷新',
        manualRefresh: '立即刷新',
        saveSchedule: '保存',
        sourceAdded: '来源已添加，刷新目录后纳入',
        syncNeeded: '来源配置已保存，点击“刷新目录”后生效',
        removeSource: '移除',
        allSources: '全部来源',
        noSourceEnabled: '没有启用的插件源',
        sourceError: '来源错误',
        security: '安全',
        verification: '验证',
        risk: '风险',
        license: '许可证',
        downloads: '周下载',
        verified: '已验证',
        installCheck: '安装验证',
        riskLow: '低风险',
        riskMedium: '中风险',
        riskHigh: '高风险',
        riskUnknown: '未评估',
        riskFlags: '风险标记',
        securityFilter: '安全 / 验证',
        noSecurityData: '无安全结论',
        sourceKind1024: '官方合作 · 分页目录',
        sourceKindDshfind: '官方合作 · format 1',
        sourceKindDshso: '精选市场 · format 1',
        sourceKindDshmarketplace: 'REST API · 安装验证',
        sourceKindStandard: '自定义标准目录',
        sourceKindFormat1: '自定义 format 1',
        sourceRows: '来源条目',
        sourceProgress: '同步状态',
        refreshAll: '刷新全部启用源',
        sourcesIntro: '来源不是按“名气”拍脑袋选的：先看官方/内置集成与数据字段，再看独立站点的实测推荐与维护健康度。分数是编辑判断，证据与日期可复核。',
        marketReputation: '市场风评',
        communityReputation: '民间风评',
        fieldCoverage: '字段覆盖',
        caveats: '注意',
        evidenceMarket: '市场侧证据',
        evidenceCommunity: '民间侧证据',
        officialStatus: '官方社区市场状态',
        officialIntro: '这里的状态来自 DSH 内置的 Community Market。添加来源不会安装插件；切换来源会改变官方市场当前浏览的目录。',
        officialUnavailable: '官方社区市场不可用（可能被禁用或尚未加载）。',
        addToOfficial: '添加到官方市场',
        makeOfficialActive: '设为官方市场当前来源',
        officialActive: '官方市场当前来源',
        addedDisabled: '已添加，未启用',
        confirmSwitch: '再点一次确认切换',
        customSource: '添加标准目录来源',
        customSourcePlaceholder: 'https://example.com/market/manifest.json',
        addCustom: '添加',
        customHint: '必须是 HTTPS、无凭据、443 端口，且符合 Community Market 的 catalog-source 契约。添加后默认未启用。',
        methodology: '口径与算法',
        usersDefinition: '用户数',
        ratingDefinition: '评分',
        compatDefinition: '适配 DSH',
        noDataDefinition: '无数据',
        marketDefinition: '市场风评',
        communityDefinition: '民间风评',
        rejected: '评估过但未纳入',
        refreshOfficial: '刷新官方状态',
        cacheCleared: '缓存已清除',
        syncedAt: '同步完成于',
        sourceErrors: '来源错误',
        partial: '部分成功',
        showDetails: '查看详情',
        openRepo: '打开仓库',
        openHomepage: '打开来源页',
        copyCommand: '复制安装命令',
        copied: '已复制',
        installCommand: '安装命令',
        installFailed: '安装失败',
        installSucceeded: '安装完成',
        installNeedsBuild: '需要允许构建脚本',
        installFallback: '目录里的版本在 npm 上找不到，已退回最新版本安装',
        installFallbackSubdir: '目录里的子目录在仓库中不存在，已退回仓库根目录安装',
        installRetryHint: '再点一次「装」会带上确认的构建脚本重试。',
        installCopyError: '复制错误详情',
        installCopySpec: '复制安装目标',
        installRetry: '重试',
        installManual: '去官方插件页安装',
        installManualTitle: '在官方插件页安装',
        installManualIntro: '这个条目没法在这里直接装（或刚装失败）。官方插件页的「发现」标签用的是同一份市场索引，可以照下面两步装：',
        installManualStep1: '1. 左侧打开「插件」页，切到「发现」标签。',
        installManualStep2: '2. 搜索下面这串包名，或点「已安装 → 安装第三方插件」把它整段粘进去。',
        installManualSearch: '搜索关键词',
        installManualSpec: '包名 / 地址',
        installManualClipboardHint: '已复制，直接粘到官方安装框即可。',
        installNoticeClose: '关闭提示',
        installNoSpec: '这一行没有可用的安装目标，只能复制命令手动装。',
        failLayerPrefix: '安装失败 · ',
        failLayer_state: '目标已就位',
        failLayer_resolve: '目标解析层',
        failLayer_version: '版本解析层',
        failLayer_subdir: '仓库子目录',
        failLayer_compat: '运行时兼容性',
        failLayer_declare: '插件声明',
        failLayer_build: '构建脚本',
        failLayer_workspace: 'pnpm 工作区',
        failLayer_lock: '文件 / 锁定',
        failLayer_permission: '权限',
        failLayer_activation: '插件激活',
        failLayer_inventory: '插件清单',
        failLayer_unknown: '未归类',
        actionRetry: '这是可自行恢复的瞬时错误，稍后点「重试」即可。',
        actionApprove: '点「重试」会带上确认的构建脚本重新安装。',
        actionReapprove: '待批准的构建脚本清单已经变了，点「重试」会重新获取最新清单。',
        actionCopyCmd: '这条错误需要绕开本面板处理：点「复制安装命令」，关掉 DSH 后在终端执行。',
        actionRestart: '这个插件当前仍在运行，需要先关闭 DSH 再操作。',
        actionEdit: '安装目标写法不合法：支持 pkg、pkg@1.2.3、@scope/pkg、github:owner/repo、https://github.com/owner/repo。',
        actionRefresh: '插件清单里找不到这个条目，先刷新再重试。',
        actionDisable: '这个插件仍处于激活状态，先到官方「插件」页禁用它，再重试。',
        actionChoose: '这个目标命中了多个已安装的包，需要先明确是哪一个。',
        actionFallback: '目录里写的版本在 npm 上不存在，可以用最新版本重试。',
        actionExemptGranted: '这条精确版本豁免已经生效；如果仍被拦，重启 DSH 让它重新读取 compatibility.json。',
        actionExemptCanGrant: '宿主需要一条精确版本豁免（{key}）才肯放行。点「仍然安装并授豁免」会写入 profile 的 compatibility.json。',
        actionExemptCannot: '这条豁免没法在这里授予（见下方原因）。',
        installForce: '仍然安装并授豁免',
        installForceHint: '写入精确版本豁免 {key} 后立即重试安装。插件与当前 DSH 版本不兼容，可能崩溃或丢数据。',
        installForceGranted: '已授予豁免',
        installForceRestart: '豁免已写入 profile 的 compatibility.json，但宿主可能要到重启 DSH 才重新读取。如果这次仍然被拦，请重启后再点一次安装。',
        installForceFailed: '授予豁免失败',
        installForceNoKey: '拿不到精确的 package@version，无法授予豁免；请复制安装命令后在命令行执行。',
        installForceNoConsent: '宿主要求明确确认风险（acceptRisk），这次请求没有带上。',
        installNotMounted: '已装好，但没有挂载',
        installNotMountedHint: '文件已下载、也已写进依赖，但它没被加进 profile 的 bundle 列表，重启后不会自动加载。到官方「插件」页把这个包启用一次即可；运行日志里有一条 install.not-mounted 记录。',
        installHealthBad: '装好了，但加载不了',
        installHealthBadHint: '文件与挂载都正常，但插件自带的装载行解析不到：{rows}。这类故障 dsh 不会报错，表现就是重启后没有设置页、没有面板。请在「运行日志」页搜 install.health 看完整结论。',
        installInactive: '装好了，但没激活',
        installInactiveHint: '依赖、挂载、装载行都正常，但插件运行时状态是 {phase}，不是 active。这种情况重启后插件不会出现。请到官方「插件」页确认它已启用，仍不行就看运行日志里 install.health 的 activation 字段。',
        installNeedsConfig: '装好了，但要配置才能用',
        installNeedsConfigHint: '安装与加载都成功，但这个插件依赖外部配置，而下面这些还没满足：{keys}。它现在能启动，但相关功能一用就会失败——这不是安装失败。详见插件的 README，配好环境变量后重启 DSH。',
        requirements: '兼容性证据',
        requirementKey: '要求',
        requirementRange: '范围',
        requirementResult: '结果',
        unmet: '未满足',
        runtime: 'DSH 运行时',
        sourceSnapshot: '来源快照',
        lastChecked: '检测于',
        featured: '编辑推荐',
        installs: '安装次数',
        failures: '失败计数（参考）',
        forks: 'Forks',
        heat: '热度',
        scoreBreakdown: '风评构成',
        noDescription: '来源没有提供描述。',
        expandText: '展开全文',
        collapseText: '收起',
        clearFilter: '清除此筛选',
        value: '取值',
        count: '数量',
        dataFrom: '数据来自',
        cacheHint: '目录缓存 6 小时后建议刷新；兼容性结果保留 7 天。',
        firstSyncHint: '首次同步需要访问 deepseek1024.com、api.dshfind.com 与 registry.npmjs.org。',
        networkError: '无法连接 Host 路由。请确认插件已加载，然后刷新页面。',
        syncFailed: '同步失败',
        compatProgress: '兼容性检测进度',
        incompatibleWarning: '不兼容插件可能导致崩溃或数据丢失；本插件只做只读提示，不提供一键安装。',
        // ---- 本次同步差异 ----
        change: '本次变化',
        changeAdded: '新增',
        changeUpdated: '更新',
        changeRemoved: '下架',
        changeNote: '新增 = 上一份目录里没有；更新 = 版本或更新日期变了；下架 = 本轮来源里已经没有它（只保留一代）。',
        onlyChanged: '仅看本次变化',
        baselinedNote: '本地还没有上一份目录，这次不标差异；下次同步开始生效。',
        // ---- 安全优先视图 ----
        safeView: '安全优先',
        safeViewNote: '只显示 dsh.so 低风险（risk-low）或 dshmarketplace 安装验证通过（installCheck=passed）的条目。',
        safeViewHidden: '安全优先视图已隐藏 ',
        safeViewHiddenTail: ' 条高风险或未审计条目',
        showAllPlugins: '显示全部',
        // ---- 已安装插件可更新 ----
        updateAvailable: '可更新到',
        updateCheck: '检查更新',
        updateRunning: '检查更新中',
        updateQueued: '排队中…',
        updateSource: '版本来源',
        updateSourceOfficial: '官方 pluginManager',
        updateSourceNpm: 'npm registry',
        updateNone: '已是最新',
        updateKindMajor: '主版本',
        updateKindMinor: '次版本',
        updateKindPatch: '补丁',
        // ---- 版本差异 ----
        versionDiff: '版本差异',
        versionDiffNote: '版本链取自 npm packument；跨主版本的升级单独标红，升级前先看兼容性证据。',
        versionChain: '版本链',
        versionChainEmpty: '两者之间没有其它发布版本。',
        breaking: '跨主版本',
        upgradeCommand: '升级命令',
        // ---- 安装 / 更新列（状态就长在按钮上）----
        actInstall: '装',
        actInstalled: '已装',
        actUpdate: '更新',
        actManual: '手动',
        actManualHint: '该条目没有可一键安装的目标，只能在官方插件页手动安装。',
        actInstallHint: '一键安装到当前配置',
        actRetryHint: '上次操作失败；再点一次重试，失败原因在页首回执里。',
        actInstalling: '安装中…',
        actReinstalling: '重装中…',
        actUpgrading: '升级中…',
        actInstalledAt: '已装版本',
        actRetry: '重试',
        actUpdateHint: '装到新版本（不降级：装不到目标版本就算失败）',
        actUpToDateHint: '已是最新；点了会重装同一个目标（幂等）',
        actInstalledLocalHint: '本地 / link / GitHub 安装，没有 registry 版本可比，不能说「已是最新」',
        upgradeSucceeded: '升级完成',
        upgradeFailed: '升级失败',
        upgradeTo: '升级到',
        // ---- 配置导入/导出 ----
        configTransfer: '配置导入/导出',
        exportConfig: '导出配置',
        importConfig: '导入配置',
        configNote: '只导出配置（自定义源、启停、定时、安全视图），不含目录缓存与逐源健康状态。',
        configExported: '配置已导出',
        configImported: '配置已导入',
        importFailed: '导入失败',
        importSkipped: '跳过',
        importReport: '导入结果',
        windowDragHint: '拖动标题栏移动 · 八条边都能拉大小 · 双击标题栏最大化 · ⧉ 开独立窗口',
        windowResetSize: '复位窗口大小与位置',
        windowMinimize: '收起到标题栏',
        windowMaximize: '最大化到整屏',
        windowRestore: '还原窗口',
        windowDetach: '独立窗口（桌面壳子禁止新窗口时自动整屏）',
        windowDetachBlocked: '桌面壳子不允许开新窗口，已改为整屏铺开；用浏览器打开 DSH 网页版时 ⧉ 就是真窗口',
        selfCheck: '自检',
        selfCheckFailed: '自检失败',
        navLogs: '运行日志',
        navRules: '评分规则',
        logsTitle: '运行日志',
        logsIntro: '安装、升级、规则切换、缓存清理都会记在这里。装不上时先看这一屏：请求目标、降级链、pnpm 原文、异常栈都在。日志只留在本次进程，重启即清空。',
        logsEmpty: '还没有日志。装一次插件、换一次规则，这里就会出现记录。',
        logsRefresh: '刷新',
        logsExport: '导出日志',
        logsCopy: '复制',
        logsClear: '清空',
        logsClearConfirm: '清空当前所有日志？此操作不可撤销。',
        logsFollow: '自动跟随',
        logsFilterLevel: '级别',
        logsFilterTag: '标签',
        logsFilterQuery: '搜索内容',
        logsAllLevels: '全部级别',
        logsCount: '条',
        logsDropped: '早于缓冲区上限的条目已丢弃',
        logsSeq: '序号',
        logsTime: '时间',
        logsLevel: '级别',
        logsTag: '标签',
        logsDetail: '内容',
        logsCopied: '已复制',
        rulesTitle: '评分规则',
        rulesIntro: '市场风评、民间风评与热度默认按内置口径算。想换权重、加维度或改分档阈值，可以导出规则文件改完再上传；也可以上传一份写好的规则分享给别人。',
        rulesCurrent: '当前规则',
        rulesSourceDefault: '内置默认',
        rulesSourceFile: '本地上传',
        rulesSourcePreset: '内置预设',
        rulesFactors: '因子',
        rulesLabels: '分档阈值',
        rulesUpload: '上传规则',
        rulesExport: '导出规则',
        rulesTemplate: '下载模版',
        rulesReset: '恢复内置规则',
        rulesResetConfirm: '恢复内置规则会删除当前的规则文件，确定？',
        rulesPresets: '内置预设',
        rulesApplyPreset: '应用',
        rulesUploaded: '规则已应用，分数已重算',
        rulesUploadFailed: '规则未应用',
        rulesTemplateSaved: '模版已下载，照着改完再上传即可',
        rulesIssue: '规则文件有问题，已退回内置口径',
        rulesExplain: '规则文件是纯 JSON：三组分数（market / community / heat）各由若干因子加权得到。模版里带完整字段说明。',
        rulesMetrics: '可用指标',
        rulesNorms: '可用归一化',
        rulesRulesPath: '规则文件位置',
        rulesSelect: '选择评分规则',
        rulesEmptyLibrary: '规则库是空的',
        rulesLibrary: '规则库',
        rulesLibraryHint: '内置与预设随插件发布，只能切换不能删除；自己上传的可以随时删。',
        rulesUserCountUnit: ' 份自定义',
        rulesFactorUnit: ' 个因子',
        rulesNoUserEntries: '还没有自己上传的规则。点「上传规则」把改好的 JSON 加进来，它会出现在上面的下拉框里。',
        rulesOriginBuiltin: '内置',
        rulesOriginPreset: '内置预设',
        rulesOriginUser: '自己上传',
        rulesInUse: '使用中',
        rulesSwitched: '已切换规则',
        rulesUploaded: '规则已加入规则库并启用',
        rulesRenamedTo: '已重命名为',
        rulesDeleted: '已删除规则',
        rulesBackToBuiltin: '已回到内置默认口径',
        rulesDelete: '删除',
        rulesDeleteYes: '确认删除',
        rulesDeleteConfirm: '删掉这份规则？',
        rulesCancel: '取消',
        rulesComposition: '这条规则在算什么',
        rulesGroupInactive: '这一组未参与评分',
        rulesWhenNote: '仅当该指标存在时才用本组',
        rulesFallbackNote: '否则改用',
        rulesMetricUnit: '权重占比',
        rulesTemplateGuide: '规则说明',
        rulesTemplateGuideIntro: '照着下面两张表就能写出自己的规则。改完点「下载模版」拿到骨架文件，或直接在导出的规则上改。',
        rulesTemplateDownload: '下载模版',
        rulesFieldKey: '字段值',
        rulesFieldMeaning: '含义',
        rulesFieldUsedFor: '用在哪',
        rulesMetricsHint: 'metric 可以取哪些值',
        rulesNormsHint: 'norm 可以取哪些值',
        rulesMetricExample: '例：{ "metric": "users", "norm": "log", "weight": 25 } 表示「按安装量、对数压缩、权重 25%」。',
        rulesNormExample: '例：log 会把 100 和 1000 的差距压到 50 分和 100 分，避免头部插件把整张表拉满。',
        rulesStructure: '文件结构',
        rulesStructureSample: '{\n  "rules": {\n    "name": "我的口径",\n    "labels": { "excellent": 80, "good": 60, "fair": 40 },\n    "market": {\n      "factors": [\n        { "metric": "rating", "norm": "raw", "weight": 55 },\n        { "metric": "users",  "norm": "log", "weight": 45 }\n      ]\n    }\n  }\n}',
        rulesGroupsGuide: '三组分数分别是什么',
        rulesNotJson: '文件不是合法 JSON',
        rulesLegacyPath: '旧版单文件（已迁移）',
        logsPath: '日志只在本进程内存中，不写盘。',
      },
      en: {
        nav: 'Plugin market radar',
        title: 'Plugin market radar',
        subtitle: 'Aggregates DSH 1024Store, dshfind, dsh.so, dshmarketplace and custom catalogs, then filters by users, rating, update date and DSH compatibility like a spreadsheet.',
        table: 'Table',
        sources: 'Sources & method',
        navMarket: 'Market',
        navInstalled: 'Installed',
        navCustom: 'Custom install',
        navSources: 'Sources',
        navSettings: 'Settings',
        installedTitle: 'Installed plugins',
        installedIntro: 'Plugins already installed in this profile. Versions, sources and update status come from the host dependency list and npm metadata.',
        installedColName: 'Package',
        installedColVersion: 'Version',
        installedColSource: 'Source',
          installedColActions: 'Actions',
        installedCheckUpdates: 'Check updates',
        installedChecking: 'Checking…',
        installedUpToDate: 'Up to date',
        installedHasUpdate: 'Update to',
        installedUnknown: 'Unknown',
        installedCountChip: 'Installed',
        installedUpdatableChip: 'Updatable',
        installedUpdateAction: 'Update',
        installedColLatest: 'Latest',
        installedRefresh: 'Refresh list',
        installedSearchPlaceholder: 'Filter by package name…',
        installedNoMatch: 'No installed plugin matches that filter.',
        installedKindLocal: 'local',
        installedKindArchive: 'archive',
        installedNoRegistry: 'Installed locally; no registry version',
      installedNoRegistryGithub: 'Installed from a repository; the version follows GitHub',
        installedEmpty: 'Nothing is installed in this profile yet. Pick one on the Market tab, or type a package name under Custom install.',
        customTitle: 'Custom install',
        customIntro: 'Install by npm package name (version allowed), github:owner/repo or a GitHub address; installation goes through the official plugin manager. One install at a time.',
        customSpecLabel: 'Install target',
        customSpecPlaceholder: 'e.g. dsh-compat-vet or github:owner/repo',
        customVerdict: 'Pre-install verdict',
        customVerdictRun: 'Check',
        customVerdictRunning: 'Checking…',
        customVerdictApprove: 'Approve',
        customVerdictWarn: 'Warn',
        customVerdictVeto: 'Blocked',
        customInstall: 'Install',
        customInstalling: 'Installing…',
        customVerdictHint: 'The target is checked against a whitelist (package name / github:owner/repo / GitHub URL) and then handed to the official plugin manager; there is no manual review here.',
        settingsTitle: 'Settings',
        settingsIntro: 'Refresh schedule, table appearance, config import/export, and information about this plugin itself.',
        settingsRefresh: 'Refresh schedule',
        settingsColumns: 'Table columns',
        settingsTransfer: 'Config import/export',
        settingsGithub: 'GitHub',
        settingsAbout: 'About',
        repoOnGithub: 'View on GitHub',
        reportIssue: 'Report an issue',
        repoLabel: 'Repository',
        licenseLabel: 'License',
        versionLabel: 'Version',
        starLabel: 'Stars',
        forkLabel: 'Forks',
        issueLabel: 'Issues',
        githubStatsUnavailable: 'GitHub stats are unavailable right now (network or rate limit); the links still open.',
        sync: 'Sync market',
        resync: 'Refresh catalog',
        cancel: 'Cancel sync',
        clearCache: 'Clear cache',
        clearCacheConfirm: 'Click again to clear the local cache',
        searchPlaceholder: 'Search plugin, package, author, repository or description…',
        filters: 'Filters',
        clearFilters: 'Clear all filters',
        noData: 'No data',
        loading: 'Loading…',
        error: 'Something went wrong',
        retry: 'Retry',
        total: 'Plugins',
        withUsers: 'With users',
        withRating: 'With rating',
        compatible: 'Compatibility known',
        installedCount: 'Installed',
        onboardingTitle: 'Bring the market local',
        onboardingBody: 'The first sync fetches the enabled marketplaces (1024Store pages, dshfind and dsh.so format 1 indexes, optionally dshmarketplace), then checks DSH compatibility from npm metadata. The catalog is cached under $DSH_HOME/market-lens.',
        onboardingSources: 'Enabled sources',
        startSync: 'Start sync (3–8 min)',
        syncing: 'Syncing',
        compatChecking: 'Compatibility checks',
        cacheAt: 'Cached at',
        neverSynced: 'Never synced',
        noCache: 'No local cache yet',
        emptyFiltered: 'No plugins match the current filters.',
        emptyCatalog: 'The catalog is empty. Sync once first.',
        freshnessTitle: 'Some sources are unavailable: ',
        freshnessRepeated: ' (repeatedly failing — this view may be missing its entries)',
        freshnessNever: ' (never fetched successfully)',
        freshnessSyncing: 'Syncing…',
        freshnessRetry: 'Force retry',
        page: 'Page',
        of: 'of',
        pageSize: 'Per page',
        rows: 'rows',
        exportCsv: 'Export CSV',
        detail: 'Plugin details',
        close: 'Close',
        description: 'Description',
        packageName: 'npm package',
        author: 'Author',
        repo: 'Repository',
        source: 'Sources',
        category: 'Category',
        version: 'Version',
        updated: 'Updated',
        compat: 'DSH fit',
        users: 'Users',
        rating: 'Rating',
        market: 'Market score',
        community: 'Community score',
        stars: 'Stars',
        installed: 'Installed',
        yes: 'Installed',
        no: 'Not installed',
        unknown: 'Unknown',
        pending: 'Checking',
        noPackage: 'No npm package',
        notDeclared: 'Not declared',
        compatibleShort: 'Compatible',
        incompatible: 'Incompatible',
        all: 'All',
        selectAll: 'Select all',
        clear: 'Clear',
        apply: 'Apply',
        searchValues: 'Search values…',
        includeNull: 'Include no data',
        min: 'Min',
        max: 'Max',
        from: 'From',
        to: 'To',
        datePreset: 'Presets',
        last7: 'Last 7 days',
        last30: 'Last 30 days',
        last90: 'Last 90 days',
        thisYear: 'This year',
        anyDate: 'Any',
        filterTitle: 'Filter',
        activeFilters: 'Active filters',
        userCountNote: 'Distinct 1024Store install instances; only installs through the dsh1024 CLI count, so this is a lower bound.',
        ratingNote: 'dshfind’s own 0–100 score, available for only 167 plugins; not a user star rating.',
        noUserDataNote: '1024Store did not count this plugin, or it has no npm package.',
        noRatingDataNote: 'dshfind did not score this plugin.',
        compatNote: 'Resolved from the npm latest manifest’s engines.dsh or @deepseek-ai/dsh-* peerDependencies against the running DSH runtime.',
        marketNote: 'A 0–100 index computed here from official rating, users, freshness and editorial/coverage signals; not an official rating.',
        communityNote: 'A 0–100 index computed here from Stars, downloads, freshness and Forks; no data when Stars are unavailable.',
        sourcesTitle: 'Why these sources',
        evaluatedAt: 'Evaluated',
        columns: 'Columns',
        columnSettings: 'Column settings',
        nameColumn: 'Plugin',
        versionColumn: 'Version',
        downloadsColumn: 'Weekly downloads',
        securityColumn: 'Security / verification',
        resetWidths: 'Reset widths',
        pluginSources: 'Plugin sources',
        sourceFilter: 'Show',
        sourceEnabled: 'Sync',
        addStandardSource: 'Add standard catalog',
        standardUrlPlaceholder: 'https://example.com/format1.json or manifest.json',
        add: 'Add',
        manageSources: 'Manage sources',
        schedule: 'Scheduled refresh',
        scheduleOff: 'Off',
        scheduleEvery: 'Every',
        scheduleMinutes: 'minutes',
        scheduleHours: 'hours',
        nextRefresh: 'Next refresh',
        manualRefresh: 'Refresh now',
        saveSchedule: 'Save',
        sourceAdded: 'Source added; refresh the catalog to include it',
        syncNeeded: 'Source settings saved; click "Refresh catalog" to apply',
        removeSource: 'Remove',
        allSources: 'All sources',
        noSourceEnabled: 'No source is enabled',
        sourceError: 'Source error',
        security: 'Security',
        verification: 'Verification',
        risk: 'Risk',
        license: 'License',
        downloads: 'Downloads',
        verified: 'Verified',
        installCheck: 'Install check',
        riskLow: 'Low risk',
        riskMedium: 'Medium risk',
        riskHigh: 'High risk',
        riskFlags: 'Risk flags',
        riskUnknown: 'Not assessed',
        securityFilter: 'Security / verification',
        noSecurityData: 'No security verdict',
        sourceKind1024: 'Official partner · paginated',
        sourceKindDshfind: 'Official partner · format 1',
        sourceKindDshso: 'Curated market · format 1',
        sourceKindDshmarketplace: 'REST API · install verified',
        sourceKindStandard: 'Custom standard catalog',
        sourceKindFormat1: 'Custom format 1',
        sourceRows: 'Source rows',
        sourceProgress: 'Sync state',
        refreshAll: 'Refresh all enabled sources',
        sourcesIntro: 'Sources were not picked by fame: official/built-in integration and field coverage come first, then independent test recommendations and maintenance health. Scores are editorial; evidence and dates are included.',
        marketReputation: 'Market reputation',
        communityReputation: 'Community reputation',
        fieldCoverage: 'Field coverage',
        caveats: 'Caveats',
        evidenceMarket: 'Market evidence',
        evidenceCommunity: 'Community evidence',
        officialStatus: 'Official Community Market status',
        officialIntro: 'Status comes from DSH’s built-in Community Market. Adding a source does not install plugins; switching the active source changes what the official market browses.',
        officialUnavailable: 'The official Community Market is unavailable (disabled or not loaded).',
        addToOfficial: 'Add to official market',
        makeOfficialActive: 'Make it the active official source',
        officialActive: 'Active official source',
        addedDisabled: 'Added, not active',
        confirmSwitch: 'Click again to switch',
        customSource: 'Add a standard catalog source',
        customSourcePlaceholder: 'https://example.com/market/manifest.json',
        addCustom: 'Add',
        customHint: 'Must be HTTPS, credential-free, port 443 and satisfy the Community Market catalog-source contract. Added disabled.',
        methodology: 'Definitions & method',
        usersDefinition: 'Users',
        ratingDefinition: 'Rating',
        compatDefinition: 'DSH fit',
        noDataDefinition: 'No data',
        marketDefinition: 'Market score',
        communityDefinition: 'Community score',
        rejected: 'Evaluated, not included',
        refreshOfficial: 'Refresh official status',
        cacheCleared: 'Cache cleared',
        syncedAt: 'Synced at',
        sourceErrors: 'Source errors',
        partial: 'Partial',
        showDetails: 'Details',
        openRepo: 'Open repository',
        openHomepage: 'Open source page',
        copyCommand: 'Copy install command',
        copied: 'Copied',
        installCommand: 'Install command',
        installFailed: 'Install failed',
        installSucceeded: 'Installed',
        installNeedsBuild: 'Build scripts need approval',
        installFallback: 'The catalog version is not on npm; installed the latest instead',
        installFallbackSubdir: 'The catalog sub-directory is missing; installed the repository root instead',
        installRetryHint: 'Click Get again to retry with the approved build scripts.',
        installCopyError: 'Copy error',
        installCopySpec: 'Copy install target',
        installRetry: 'Retry',
        installManual: 'Install from the official page',
        installManualTitle: 'Install from the official page',
        installManualIntro: 'This row cannot be installed here (or just failed). The official page’s Discover tab reads the same market index — two steps:',
        installManualStep1: '1. Open the Plugins page on the left and switch to the Discover tab.',
        installManualStep2: '2. Search the name below, or open “Installed → Add third-party plugin” and paste the spec.',
        installManualSearch: 'Search for',
        installManualSpec: 'Package / address',
        installManualClipboardHint: 'Copied — paste it into the official install box.',
        installNoticeClose: 'Dismiss',
        installNoSpec: 'This row has no install target; copy the command and install manually.',
        failLayerPrefix: 'Install failed · ',
        failLayer_state: 'target already in place',
        failLayer_resolve: 'target resolution',
        failLayer_version: 'version resolution',
        failLayer_subdir: 'repository sub-directory',
        failLayer_compat: 'runtime compatibility',
        failLayer_declare: 'plugin declaration',
        failLayer_build: 'build scripts',
        failLayer_workspace: 'pnpm workspace',
        failLayer_lock: 'file / lock',
        failLayer_permission: 'permission',
        failLayer_activation: 'plugin activation',
        failLayer_inventory: 'plugin inventory',
        failLayer_unknown: 'unclassified',
        actionRetry: 'This is a transient error you can recover from — click Retry in a moment.',
        actionApprove: 'Retry will install again with the approved build scripts.',
        actionReapprove: 'The pending build list changed; Retry will fetch the current one.',
        actionCopyCmd: 'This one needs to bypass this panel: copy the install command and run it in a terminal with DSH closed.',
        actionRestart: 'This plugin is still running — close DSH first, then retry.',
        actionEdit: 'The install target is malformed: use pkg, pkg@1.2.3, @scope/pkg, github:owner/repo, or https://github.com/owner/repo.',
        actionRefresh: 'The plugin inventory does not list this entry; refresh, then retry.',
        actionDisable: 'This plugin is still active — disable it from the official Plugins page, then retry.',
        actionChoose: 'This target matched several installed packages; pick the one you meant.',
        actionFallback: 'The catalog version is not on npm; retry with the latest instead.',
        actionExemptGranted: 'This exact-version exemption is already active; if it is still refused, restart DSH so it re-reads compatibility.json.',
        actionExemptCanGrant: 'The host needs an exact-version exemption ({key}) before it will allow this. Install anyway grants it by writing the profile compatibility.json.',
        actionExemptCannot: 'This exemption cannot be granted here (see the reason below).',
        installForce: 'Install anyway and grant exemption',
        installForceHint: 'Writes the exact-version exemption for {key} and retries immediately. The plugin is incompatible with this DSH version and may crash or lose data.',
        installForceGranted: 'Exemption granted',
        installForceRestart: 'The exemption is written to the profile compatibility.json, but the host may only re-read it after a DSH restart. If this attempt is still refused, restart and install once more.',
        installForceFailed: 'Granting the exemption failed',
        installForceNoKey: 'No exact package@version could be derived, so no exemption can be granted; copy the install command and run it in a terminal.',
        installForceNoConsent: 'The host requires explicit risk acknowledgement (acceptRisk); this request did not carry it.',
        installNotMounted: 'Installed, but not mounted',
        installNotMountedHint: 'The files are downloaded and the dependency is saved, but the package was not added to the profile bundle list, so it will not load after a restart. Enable it once from the official Plugins page; the runtime log has an install.not-mounted entry.',
        installHealthBad: 'Installed, but cannot load',
        installHealthBadHint: 'Files and mount are fine, but the bundle patch rows do not resolve: {rows}. dsh reports nothing for this — the symptom is a missing settings page or panel after a restart. Open the runtime log and search install.health for the full verdict.',
        installInactive: 'Installed, but not activated',
        installInactiveHint: 'Dependencies, mount and patch rows are all fine, but the runtime state is {phase}, not active — the plugin will not appear after a restart. Confirm it is enabled on the official Plugins page; if it still fails, check the activation field of install.health in the runtime log.',
        installNeedsConfig: 'Installed, but needs configuration',
        installNeedsConfigHint: 'Install and load both succeeded, but this plugin depends on external configuration and these are not satisfied: {keys}. It starts fine, yet the related features fail on first use — this is not an install failure. See the plugin README, set the environment variables, and restart DSH.',
        requirements: 'Compatibility evidence',
        requirementKey: 'Requirement',
        requirementRange: 'Range',
        requirementResult: 'Result',
        unmet: 'Unmet',
        runtime: 'DSH runtime',
        sourceSnapshot: 'Source snapshot',
        lastChecked: 'Checked',
        featured: 'Editor’s pick',
        installs: 'Installs',
        failures: 'Failures (reference)',
        forks: 'Forks',
        heat: 'Heat',
        scoreBreakdown: 'Score breakdown',
        noDescription: 'The source did not provide a description.',
        expandText: 'Show more',
        collapseText: 'Show less',
        clearFilter: 'Clear this filter',
        value: 'Value',
        count: 'Count',
        dataFrom: 'Data from',
        cacheHint: 'Refresh the catalog after ~6 hours; compatibility results are kept for 7 days.',
        firstSyncHint: 'The first sync contacts deepseek1024.com, api.dshfind.com and registry.npmjs.org.',
        networkError: 'Cannot reach the Host route. Make sure the plugin is loaded, then refresh the page.',
        syncFailed: 'Sync failed',
        compatProgress: 'Compatibility progress',
        incompatibleWarning: 'Incompatible plugins may crash or lose data. This panel is read-only and does not install anything.',
        change: 'This sync',
        changeAdded: 'New',
        changeUpdated: 'Updated',
        changeRemoved: 'Delisted',
        changeNote: 'New = absent from the previous catalog; Updated = version or update date changed; Delisted = no source returns it anymore (kept for one generation).',
        onlyChanged: 'Only this sync',
        baselinedNote: 'No previous catalog yet, so nothing is marked; this starts with the next sync.',
        safeView: 'Safe view',
        safeViewNote: 'Shows only dsh.so low risk (risk-low) or dshmarketplace install-verified (installCheck=passed) entries.',
        safeViewHidden: 'Safe view hides ',
        safeViewHiddenTail: ' high-risk or unaudited entries',
        showAllPlugins: 'Show all',
        updateAvailable: 'Update to',
        updateCheck: 'Check updates',
        updateRunning: 'Checking',
        updateQueued: 'Queued…',
        updateSource: 'Version source',
        updateSourceOfficial: 'Official pluginManager',
        updateSourceNpm: 'npm registry',
        updateNone: 'Up to date',
        updateKindMajor: 'Major',
        updateKindMinor: 'Minor',
        updateKindPatch: 'Patch',
        versionDiff: 'Version diff',
        versionDiffNote: 'Version chain comes from the npm packument; major jumps are flagged red. Check compatibility evidence before upgrading.',
        versionChain: 'Version chain',
        versionChainEmpty: 'No other release between the two.',
        breaking: 'Major bump',
        upgradeCommand: 'Upgrade command',
        actInstall: 'Get',
        actInstalled: 'Installed',
        actUpdate: 'Update',
        actManual: 'Manual',
        actManualHint: 'This row has no one-click target; install it from the official plugin page.',
        actInstallHint: 'Install into this profile',
        actRetryHint: 'The last attempt failed; click to retry. The reason is in the receipt at the top.',
        actInstalling: 'Installing…',
        actReinstalling: 'Reinstalling…',
        actUpgrading: 'Upgrading…',
        actInstalledAt: 'Installed version',
        actRetry: 'Retry',
        actUpdateHint: 'Install the new version (never falls back: not reaching the target counts as failure)',
        actUpToDateHint: 'Already the latest; clicking reinstalls the same target (idempotent)',
        actInstalledLocalHint: 'Installed from a local / link / GitHub source — there is no registry version to compare, so it cannot say "up to date"',
        upgradeSucceeded: 'Upgraded',
        upgradeFailed: 'Upgrade failed',
        upgradeTo: 'Upgrade to',
        configTransfer: 'Config import/export',
        exportConfig: 'Export config',
        importConfig: 'Import config',
        configNote: 'Exports configuration only (custom sources, enable flags, schedule, safe view), without the catalog cache or per-source health.',
        configExported: 'Config exported',
        configImported: 'Config imported',
        importFailed: 'Import failed',
        importSkipped: 'Skipped',
        importReport: 'Import report',
        windowDragHint: 'Drag the title bar to move · all eight edges resize · double-click the title bar to maximize · ⧉ opens a separate window',
        windowResetSize: 'Reset window size and position',
        windowMinimize: 'Collapse to title bar',
        windowMaximize: 'Maximize to full screen',
        windowRestore: 'Restore window',
        windowDetach: 'Separate window (fills the screen when the desktop shell blocks popups)',
        windowDetachBlocked: 'The desktop shell blocks new windows, so this fills the screen instead. Run the DSH web build in a browser and ⧉ opens a real window.',
        selfCheck: 'Self-check',
        selfCheckFailed: 'Self-check failed',
        navLogs: 'Logs',
        navRules: 'Scoring rules',
        logsTitle: 'Runtime logs',
        logsIntro: 'Installs, upgrades, rule switches and cache resets are recorded here. When an install fails, start from this screen: target spec, fallback chain, raw pnpm output and stack traces are all kept. Logs live in this process only and reset on restart.',
        logsEmpty: 'No entries yet. Install a plugin or switch a rule and records will show up here.',
        logsRefresh: 'Refresh',
        logsExport: 'Export',
        logsCopy: 'Copy',
        logsClear: 'Clear',
        logsClearConfirm: 'Clear all current logs? This cannot be undone.',
        logsFollow: 'Follow',
        logsFilterLevel: 'Level',
        logsFilterTag: 'Tag',
        logsFilterQuery: 'Search',
        logsAllLevels: 'All levels',
        logsCount: 'rows',
        logsDropped: 'Older entries dropped at buffer limit',
        logsSeq: 'Seq',
        logsTime: 'Time',
        logsLevel: 'Level',
        logsTag: 'Tag',
        logsDetail: 'Detail',
        logsCopied: 'Copied',
        rulesTitle: 'Scoring rules',
        rulesIntro: 'Market score, community score and heat default to the built-in formula. To change weights, add dimensions or move label thresholds, export the rule file, edit it and upload it back — or upload someone else’s file.',
        rulesCurrent: 'Current rules',
        rulesSourceDefault: 'Built-in default',
        rulesSourceFile: 'Uploaded',
        rulesSourcePreset: 'Built-in preset',
        rulesFactors: 'factors',
        rulesLabels: 'Label thresholds',
        rulesUpload: 'Upload rules',
        rulesExport: 'Export rules',
        rulesTemplate: 'Download template',
        rulesReset: 'Restore built-in',
        rulesResetConfirm: 'Restoring the built-in rules deletes the current rule file. Continue?',
        rulesPresets: 'Built-in presets',
        rulesApplyPreset: 'Apply',
        rulesUploaded: 'Rules applied, scores recomputed',
        rulesUploadFailed: 'Rules not applied',
        rulesTemplateSaved: 'Template downloaded — edit it and upload it back',
        rulesIssue: 'Rule file is invalid, fell back to the built-in formula',
        rulesExplain: 'The rule file is plain JSON: three score groups (market / community / heat), each a weighted set of factors. The template documents every field.',
        rulesMetrics: 'Metrics',
        rulesNorms: 'Normalizers',
        rulesRulesPath: 'Rule file location',
        rulesSelect: 'Choose a scoring rule',
        rulesEmptyLibrary: 'The rule library is empty',
        rulesLibrary: 'Rule library',
        rulesLibraryHint: 'Built-in and preset rules ship with the plugin — switch freely, they cannot be deleted. Your own uploads can be removed at any time.',
        rulesUserCountUnit: ' custom',
        rulesFactorUnit: ' factors',
        rulesNoUserEntries: 'No custom rules yet. Click "Upload rules" to add your edited JSON — it will appear in the dropdown above.',
        rulesOriginBuiltin: 'built-in',
        rulesOriginPreset: 'preset',
        rulesOriginUser: 'yours',
        rulesInUse: 'in use',
        rulesSwitched: 'Rule switched',
        rulesUploaded: 'Rule added to the library and activated',
        rulesRenamedTo: 'renamed to',
        rulesDeleted: 'Rule deleted',
        rulesBackToBuiltin: 'Back on the built-in formula',
        rulesDelete: 'Delete',
        rulesDeleteYes: 'Confirm delete',
        rulesDeleteConfirm: 'Delete this rule?',
        rulesCancel: 'Cancel',
        rulesComposition: 'What this rule scores',
        rulesGroupInactive: 'not used by this rule',
        rulesWhenNote: 'this group applies only when that metric exists',
        rulesFallbackNote: 'otherwise uses',
        rulesMetricUnit: 'share',
        rulesTemplateGuide: 'Rule reference',
        rulesTemplateGuideIntro: 'The two tables below contain everything you need to write a rule. Download the template for the skeleton, or edit an exported rule.',
        rulesTemplateDownload: 'Download template',
        rulesFieldKey: 'Value',
        rulesFieldMeaning: 'Meaning',
        rulesFieldUsedFor: 'Used as',
        rulesMetricsHint: 'accepted values for metric',
        rulesNormsHint: 'accepted values for norm',
        rulesMetricExample: 'e.g. { "metric": "users", "norm": "log", "weight": 25 } means "installers, log-scaled, 25% weight".',
        rulesNormExample: 'e.g. log compresses 100 vs 1000 into 50 vs 100 points, so one huge plugin cannot flatten the whole table.',
        rulesStructure: 'File structure',
        rulesStructureSample: '{\n  "rules": {\n    "name": "my formula",\n    "labels": { "excellent": 80, "good": 60, "fair": 40 },\n    "market": {\n      "factors": [\n        { "metric": "rating", "norm": "raw", "weight": 55 },\n        { "metric": "users",  "norm": "log", "weight": 45 }\n      ]\n    }\n  }\n}',
        rulesGroupsGuide: 'What the three score groups do',
        rulesNotJson: 'file is not valid JSON',
        rulesLegacyPath: 'Legacy single file (migrated)',
        logsPath: 'Logs are kept in this process memory only, never written to disk.',
      },
    }

    const EMPTY_SNAPSHOT = { active: 'zh', locales: [], revision: 0 }
    const FALLBACK_SNAPSHOT = {
      active: typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en',
      locales: [],
      revision: 0,
    }
    const localeRef = { service: null }

    const pickDict = (active) => TEXTS[active] || TEXTS[String(active).split('-')[0]] || TEXTS.zh

    function useText() {
      const serviceSnapshot = useRef(null)
      const subscribe = useCallback((onChange) => {
        const service = localeRef.service
        return service ? service.subscribe(onChange) : () => {}
      }, [])
      const read = useCallback(() => {
        const service = localeRef.service
        if (service) {
          try {
            const next = service.getSnapshot()
            const previous = serviceSnapshot.current
            if (!previous || previous.active !== next.active || previous.revision !== next.revision) {
              serviceSnapshot.current = next
            }
            return serviceSnapshot.current
          } catch {
            return EMPTY_SNAPSHOT
          }
        }
        return FALLBACK_SNAPSHOT
      }, [])
      const snapshot = React.useSyncExternalStore(subscribe, read, read)
      const dict = pickDict(snapshot.active)
      const t = useCallback((key) => dict[key] || TEXTS.zh[key] || key, [dict])
      return { t, lang: dict === TEXTS.en ? 'en' : 'zh' }
    }

    const navLabel = () => {
      const service = localeRef.service
      const active = service ? (() => { try { return service.getLocale().active } catch { return 'zh' } })() : 'zh'
      return pickDict(active).nav
    }

    // ---- formatting ----

    const nf = new Intl.NumberFormat('zh-CN')
    const formatNumber = (value) => (Number.isFinite(value) ? nf.format(value) : '—')
    /**
     * 把任意状态值折成字符串：输入框里的值理论上都是字符串，但宿主/状态槽
     * 复用后可能给回 null/对象，`null.trim()` 会直接炸掉整个页签。
     */
    const asText = (value) => (typeof value === "string" ? value : value == null ? "" : String(value))
    /**
     * 大数字缩写。英文界面不能出现「1.2万」——所以按语言换单位：
     * 中文万/亿，英文 K/M/B。lang 缺省按中文走（内部调用方未必都传）。
     */
    const formatCompact = (value, lang) => {
      if (!Number.isFinite(value)) return null
      if (lang === 'en') {
        if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1).replace(/\.0$/u, '') + 'B'
        if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/u, '') + 'M'
        if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/u, '') + 'K'
        return String(value)
      }
      if (value >= 100_000_000) return (value / 100_000_000).toFixed(1).replace(/\.0$/u, '') + '亿'
      if (value >= 10_000) return (value / 10_000).toFixed(1).replace(/\.0$/u, '') + '万'
      if (value >= 1_000) return nf.format(value)
      return String(value)
    }
    const datePart = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '')
    /**
     * 「3 天前」这种人话时间。中文界面写中文，英文界面写英文——
     * 以前无论什么语言都吐「昨天 / 个月前」，英文界面里会突然蹦出汉字。
     */
    const relativeDays = (iso, lang) => {
      if (!iso) return ''
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return ''
      const days = Math.floor((Date.now() - time) / 86_400_000)
      const en = lang === 'en'
      if (days <= 0) return en ? 'today' : '今天'
      if (days === 1) return en ? 'yesterday' : '昨天'
      if (days < 30) return en ? days + (days === 1 ? ' day ago' : ' days ago') : days + ' 天前'
      if (days < 365) {
        const months = Math.floor(days / 30)
        return en ? months + (months === 1 ? ' month ago' : ' months ago') : months + ' 个月前'
      }
      const years = Math.floor(days / 365)
      return en ? years + (years === 1 ? ' year ago' : ' years ago') : years + ' 年前'
    }
    const compatLabel = (status, t) => {
      if (status === 'ok') return t('compatibleShort')
      if (status === 'bad') return t('incompatible')
      if (status === 'none') return t('notDeclared')
      if (status === 'pending') return t('pending')
      if (status === 'no-package') return t('noPackage')
      return t('unknown')
    }
    const compatRank = (status) => {
      const index = COMPAT_ORDER.indexOf(status)
      return index < 0 ? 99 : index
    }
    const scoreTone = (score) => {
      if (!Number.isFinite(score)) return 'var(--dsw-alias-label-secondary)'
      if (score >= 80) return 'var(--dsw-alias-state-success-primary)'
      if (score >= 60) return 'var(--dsw-alias-brand-primary)'
      if (score >= 40) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-label-secondary)'
    }
    const unique = (values) => [...new Set(values)]
    const categoryText = (key, lang) => CATEGORY_LABELS[key]?.[lang] || key

    // ---- request ----

    const request = async (payload) => {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || !body || body.ok !== true) {
        const error = new Error(body && body.error ? String(body.error) : 'HTTP ' + response.status)
        // 安装失败时 Host 会带 code / pendingBuilds；保留在 Error 上，
        // 详情抽屉才能给出「允许构建并重试」，而不是只剩一段 pnpm 输出。
        if (body && typeof body === 'object') {
          if (body.code) error.code = String(body.code)
          if (Array.isArray(body.pendingBuilds)) error.pendingBuilds = body.pendingBuilds.filter((name) => typeof name === 'string' && name)
          error.body = body
        }
        throw error
      }
      return body
    }

    // ---- filter model ----

    const emptyFilter = () => ({})
    /**
     * 把持久化下来的筛选洗一遍。
     *
     * `installed` 这一列已经删掉了（安装状态并入 actions）。老会话里可能还存着
     * `{installed:['yes']}`：那种值域（yes/no）跟现在的（installed/not-installed）
     * 对不上，直接读回来会变成一条"永远匹配不到任何行"的隐形筛选 ——
     * 表现就是列表莫名其妙空了、但筛选栏上看不出原因。所以这里直接丢掉这个键。
     */
    const sanitizeFilters = (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
      const next = { ...input }
      delete next.installed
      return next
    }
    const isSetFilter = (value) => Array.isArray(value) && value.length > 0
    const isRangeActive = (value) =>
      Boolean(value && (value.min != null && value.min !== '' || value.max != null && value.max !== '' || value.includeNull))
    const isDateActive = (value) => Boolean(value && (value.from || value.to || value.includeNull))

    const securityState = (row) => {
      const risk = row.security?.riskLevel
      if (risk === 'low' || risk === 'medium' || risk === 'high') return risk
      if (row.verification?.installCheck === 'passed') return 'verified'
      if (Array.isArray(row.riskFlags) && row.riskFlags.length) return 'flagged'
      return 'unknown'
    }

    const CHANGE_META = {
      added: { labelKey: 'changeAdded', color: 'var(--dsw-alias-state-success-primary)' },
      updated: { labelKey: 'changeUpdated', color: 'var(--dsw-alias-brand-primary)' },
      removed: { labelKey: 'changeRemoved', color: 'var(--dsw-alias-state-error-primary)' },
    }

    /**
     * 与 lib/security.js 的 trustOf 同一口径。Host 已经算好 trust 就照抄；
     * 缓存里的旧行（升级瞬间还没带 trust）就地补算，否则安全视图会先把整张表清空。
     */
    function trustOfRow(row) {
      if (row && row.trust && typeof row.trust.safe === 'boolean') return row.trust
      const risk = row && row.security ? row.security.riskLevel : null
      const installCheck = row && row.verification ? row.verification.installCheck : null
      const flags = Array.isArray(row && row.riskFlags) ? row.riskFlags : []
      const base = { riskLevel: risk || null, installCheck: installCheck || null, label: null }
      if (risk === 'high') return { ...base, tier: 'high', safe: false, reason: 'risk-high' }
      if (installCheck === 'failed') return { ...base, tier: 'flagged', safe: false, reason: 'install-check-failed' }
      if (flags.length) return { ...base, tier: 'flagged', safe: false, reason: 'risk-flags' }
      if (risk === 'medium') return { ...base, tier: 'medium', safe: false, reason: 'risk-medium' }
      if (risk === 'low') return { ...base, tier: 'low', safe: true, reason: 'risk-low' }
      if (installCheck === 'passed') return { ...base, tier: 'verified', safe: true, reason: 'install-check-passed' }
      return { ...base, tier: 'unknown', safe: false, reason: 'unaudited' }
    }

    /** 更新徽标的 tooltip：版本对、差异级别、来源、检测时间，四件事都要能看见。 */
    function updateBadgeTitle(update, t) {
      if (!update) return ''
      const source = update.source === 'pluginManager' ? t('updateSourceOfficial') : t('updateSourceNpm')
      const kind = update.kind === 'major' ? t('updateKindMajor')
        : update.kind === 'minor' ? t('updateKindMinor')
          : update.kind === 'patch' ? t('updateKindPatch')
            : update.kind
      return [
        (update.from || '—') + ' → ' + (update.to || '—'),
        kind,
        t('updateSource') + ': ' + source,
        update.checkedAt ? t('lastChecked') + ' ' + datePart(update.checkedAt) : null,
      ].filter(Boolean).join(' · ')
    }

    const filterActive = (filters, key) => {
      const value = filters[key]
      if (key === 'updatedAt') return isDateActive(value)
      if (key === 'version') return typeof value === 'string' && value.trim() !== ''
      if (['users', 'rating', 'market', 'community', 'stars', 'downloads'].includes(key)) return isRangeActive(value)
      return isSetFilter(value)
    }

    /**
     * 行的「安装 / 更新」状态，行内按钮、筛选、排序都读这一个函数。
     * 以前安装状态分散在两处（按钮靠前端乐观集合，状态列靠目录里的 installed），
     * 于是卸载之后出现「按钮还是 ✓、状态列写未安装」的自相矛盾。
     */
    const actionStateOf = (row) => {
      if (!row) return 'manual'
      if (row.installed) return row.update && row.update.available ? 'update' : 'installed'
      return 'installable'
    }

    const activeFilterCount = (filters) => Object.keys(filters).filter((key) => filterActive(filters, key)).length

    function matchesSet(value, selected) {
      if (!Array.isArray(selected) || selected.length === 0) return true
      return selected.includes(value)
    }

    function matchesRange(value, range) {
      if (!range) return true
      const active = range.min != null && range.min !== '' || range.max != null && range.max !== '' || range.includeNull
      if (!active) return true
      if (value == null || !Number.isFinite(value)) return Boolean(range.includeNull)
      const min = range.min === '' || range.min == null ? null : Number(range.min)
      const max = range.max === '' || range.max == null ? null : Number(range.max)
      if (min != null && Number.isFinite(min) && value < min) return false
      if (max != null && Number.isFinite(max) && value > max) return false
      return true
    }

    function matchesDate(value, range) {
      if (!range) return true
      const active = Boolean(range.from || range.to || range.includeNull)
      if (!active) return true
      if (!value) return Boolean(range.includeNull)
      const day = datePart(value)
      if (range.from && day < range.from) return false
      if (range.to && day > range.to) return false
      return true
    }

    function filterRow(row, filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (!filterActive(filters, key)) continue
        if (key === 'sources') {
          if (!Array.isArray(row.sources) || !row.sources.some((source) => value.includes(source))) return false
        } else if (key === 'compat') {
          if (!matchesSet(row.compat?.status || 'unknown', value)) return false
        } else if (key === 'actions') {
          // 「安装状态」列的筛选并到这里：installed / available-update / not-installed。
          // 老会话里可能还留着 key=installed 的筛选，这里一并吃掉，不让它无声生效。
          const state = actionStateOf(row)
          if (!Array.isArray(value) || value.length === 0) continue
          if (!value.includes(state)) return false
        } else if (key === 'installed') {
          const state = row.installed ? 'installed' : 'not-installed'
          if (!matchesSet(state, value)) return false
        } else if (key === 'change') {
          // 「仅看本次变化」直接写 filters.change，复用 chip / 清除筛选那一套；
          // 没有 change 的普通行会被这里挡掉，正是想要的语义。
          const change = row.change || null
          if (!Array.isArray(value) || value.length === 0) continue
          if (!value.includes(change)) return false
        } else if (key === 'updatedAt') {
          if (!matchesDate(row.updatedAt, value)) return false
        } else if (['users', 'rating', 'market', 'community', 'stars', 'downloads'].includes(key)) {
          const raw = key === 'users' ? row.installers
            : key === 'rating' ? row.score
              : key === 'market' ? row.marketScore
                : key === 'community' ? row.communityScore
                  : key === 'downloads' ? row.downloads
                    : row.stars
          if (!matchesRange(raw, value)) return false
        } else if (key === 'security') {
          if (!matchesSet(securityState(row), value)) return false
        } else if (key === 'version') {
          if (!String(row.version || '').toLowerCase().includes(String(value).toLowerCase())) return false
        } else if (key === 'category') {
          if (!matchesSet(row.category, value)) return false
        } else if (key === 'name') {
          if (value && !String(row.name || '').toLowerCase().includes(String(value).toLowerCase())) return false
        }
      }
      return true
    }

    function searchRow(row, query) {
      if (!query) return true
      const haystack = [row.name, row.title, row.pkg, row.author, row.repo, row.desc, categoryText(row.category, 'zh')]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return haystack.includes(query.toLowerCase())
    }

    function sortRows(rows, sort) {
      const factor = sort.dir === 'asc' ? 1 : -1
      const valueOf = (row, key) => {
        if (key === 'name') return row.name || ''
        if (key === 'updatedAt') return row.updatedAt || ''
        if (key === 'compat') return compatRank(row.compat?.status)
        if (key === 'users') return row.installers
        if (key === 'rating') return row.score
        if (key === 'market') return row.marketScore
        if (key === 'community') return row.communityScore
        if (key === 'stars') return row.stars
        if (key === 'downloads') return row.downloads
        if (key === 'security') {
          const order = { high: 0, medium: 1, low: 2, verified: 3, flagged: 4, unknown: 5 }
          return order[securityState(row)] ?? 9
        }
        // 排序口径与按钮一致：可更新排最前（最该处理的），其次已安装，再次可安装，最后手动。
        if (key === 'actions') {
          const state = canInstallRow(row) ? actionStateOf(row) : 'manual'
          const order = { update: 0, installed: 1, installable: 2, manual: 3 }
          return order[state] ?? 9
        }
        if (key === 'category') return row.category || ''
        if (key === 'version') return row.version || ''
        return row.heat
      }
      return [...rows].sort((left, right) => {
        const a = valueOf(left, sort.key)
        const b = valueOf(right, sort.key)
        const aNull = a == null || a === ''
        const bNull = b == null || b === ''
        if (aNull && bNull) return 0
        if (aNull) return 1
        if (bNull) return -1
        if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b), 'zh-CN') * factor
        return (a - b) * factor
      })
    }

    // ---- styles ----

    const STYLE_TAG = [
      '.ml-row { transition: background-color 110ms ease; }',
      '.ml-row:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.ml-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }',
      '.ml-btn:hover:not(:disabled), .ml-filter-btn:hover, .ml-head-btn:hover { color: var(--dsw-alias-label-primary) !important; }',
      '.ml-btn:focus-visible, .ml-filter-btn:focus-visible, .ml-head-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      // 滚动条统一在这里定义，而不是散落到各个组件的内联样式：
      // 之前只有表格横向滚动有自定义滚动条，日志区、规则页、弹层都是系统默认的
      // 粗条（在 Windows 上是 17px 灰块），既难看又压缩可视区域。
      // 用 .ml-scroll 这个类挂到任何可能溢出的容器上即可。
      '.ml-scroll { overflow: auto; overscroll-behavior: contain; }',
      '.ml-scroll::-webkit-scrollbar { width: 10px; height: 10px; }',
      '.ml-scroll::-webkit-scrollbar-track { background: transparent; }',
      '.ml-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }',
      '.ml-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-secondary); }',
      '.ml-scroll::-webkit-scrollbar-corner { background: transparent; }',
      // Firefox / 非 webkit 内核：标准属性同样生效
      '.ml-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }',
      // 表格自己原有的横向滚动条规则保留（它 class 不同名，行为一致）
      '.ml-table-scroll::-webkit-scrollbar { height: 10px; }',
      '.ml-table-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }',
      '.ml-resizer:hover, .ml-resizer:active { background: var(--dsw-alias-brand-primary); opacity: 0.55; }',
      // 折叠文本：默认只显示 N 行，超出部分淡出，点「展开」看全文。
      // 用 max-height + 渐变遮罩而不是 -webkit-line-clamp，是因为后者在
      // 长串无空格文本（URL、包名）上会算出错误的高度。
      '.ml-clamp { position: relative; overflow: hidden; }',
      '.ml-clamp::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 1.6em; pointer-events: none; background: linear-gradient(to bottom, transparent, var(--dsw-alias-bg-base)); }',
      '.ml-clamp-full::after { display: none; }',
    ].join('\n')

    const buttonStyle = (primary, disabled, small) => ({
      appearance: 'none',
      border: '1px solid ' + (primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
      borderRadius: small ? 6 : 8,
      padding: small ? '4px 9px' : '6px 12px',
      fontFamily: 'inherit',
      fontSize: small ? 12 : 13,
      lineHeight: 1.4,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1,
      background: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
      color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
    })

    const style = {
      page: {
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        padding: '24px 28px 36px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: SANS,
      },
      column: { maxWidth: 1480, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 20, fontWeight: 650, lineHeight: 1.3, letterSpacing: '-0.01em' },
      subtitle: { margin: '4px 0 0', maxWidth: 840, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      headerActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      statusPill: (tone) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 12,
        lineHeight: 1.4,
        color: tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : tone === 'accent' ? 'var(--dsw-alias-brand-primary)' : tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 0 },
      tab: (active) => ({
        appearance: 'none',
        border: 'none',
        borderBottom: active ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
        background: 'transparent',
        padding: '7px 10px',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      }),
      summary: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      search: {
        flex: '1 1 320px',
        minWidth: 220,
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.5,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 12,
        padding: '14px 16px',
      },
      tableWrap: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      tableScroll: { overflowX: 'auto', overflowY: 'visible' },
      headerRow: {
        display: 'grid',
        alignItems: 'stretch',
        minWidth: 1220,
        background: 'var(--dsw-alias-bg-layer-2)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        position: 'sticky',
        top: 0,
        zIndex: 3,
      },
      headerCell: (align) => ({
        boxSizing: 'border-box',
        flex: 'none',
        padding: '8px 10px',
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: 1.35,
        color: 'var(--dsw-alias-label-secondary)',
        textAlign: align || 'left',
        display: 'flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        gap: 4,
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      }),
      row: {
        display: 'grid',
        alignItems: 'stretch',
        minWidth: 1220,
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        cursor: 'pointer',
        background: 'transparent',
      },
      cell: (align) => ({
        boxSizing: 'border-box',
        flex: 'none',
        padding: '8px 10px',
        fontSize: 12.5,
        lineHeight: 1.45,
        textAlign: align || 'left',
        minWidth: 0,
        overflow: 'hidden',
      }),
      pluginTitle: { fontSize: 13, fontWeight: 600, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pluginSub: { marginTop: 1, fontFamily: MONO, fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: (color, active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid ' + (active ? color : 'var(--dsw-alias-border-l2)'),
        color: active ? color : 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        fontSize: 10.5,
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
      }),
      noData: { color: 'var(--dsw-alias-label-secondary)', opacity: 0.8, fontStyle: 'italic', fontSize: 11.5, cursor: 'help' },
      score: (score) => ({ color: scoreTone(score), fontWeight: 600, fontVariantNumeric: 'tabular-nums' }),
      bar: (value, color) => ({
        display: 'inline-block',
        verticalAlign: 'middle',
        width: 34,
        height: 4,
        marginLeft: 5,
        borderRadius: 999,
        background: 'var(--dsw-alias-border-l1)',
        overflow: 'hidden',
        position: 'relative',
      }),
      barFill: (value, color) => ({
        display: 'block',
        width: Math.max(0, Math.min(100, value || 0)) + '%',
        height: '100%',
        background: color,
      }),
      footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '8px 2px' },
      muted: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      errorBox: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
        borderRadius: 10,
        padding: '10px 12px',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      },
      onboarding: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'linear-gradient(135deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-2))',
        borderRadius: 14,
        padding: '26px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 820,
        margin: '18px auto',
      },
      progressTrack: { height: 6, borderRadius: 999, background: 'var(--dsw-alias-border-l1)', overflow: 'hidden' },
      progressFill: (percent) => ({ height: '100%', width: Math.max(0, Math.min(100, percent)) + '%', background: 'var(--dsw-alias-brand-primary)', transition: 'width 200ms ease' }),
      drawerBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.42)', zIndex: 1150 },
      drawer: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(520px, 100vw)',
        background: 'var(--dsw-alias-bg-base)',
        borderLeft: '1px solid var(--dsw-alias-border-l1)',
        zIndex: 1200,
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '22px 22px 34px',
        boxShadow: '-12px 0 40px rgba(0,0,0,0.25)',
      },
      section: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 20 },
      sectionTitle: { margin: 0, fontSize: 12.5, fontWeight: 650, letterSpacing: '0.02em', color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase' },
      kv: { display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: '6px 10px', fontSize: 12.5, lineHeight: 1.55 },
      keyText: { color: 'var(--dsw-alias-label-secondary)' },
      code: { fontFamily: MONO, fontSize: 11.5, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, padding: '8px 10px', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
      sourceCard: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 12,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      sourceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 },
      scoreRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
      bulletList: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.3, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
      tabs: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      preset: (active) => ({
        appearance: 'none',
        border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)' : 'transparent',
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        borderRadius: 999,
        padding: '3px 9px',
        fontFamily: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      }),
    }

    // ---- shared small components ----

    function FunnelIcon({ size = 16, active }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3.5 5.2h17l-6.4 7.3v5.8l-4.2 2.2v-8Z' }),
        active ? h('circle', { cx: 19.2, cy: 4.8, r: 2.4, fill: 'currentColor', stroke: 'none' }) : null,
      )
    }

    function PanelIcon({ size = 20, active }) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3.2, y: 4, width: 17.6, height: 16, rx: 2.2 }),
        h('path', { d: 'M3.4 8.6h17.2M9.2 8.8V19.6' }),
        h('path', { d: 'M12 12.2h5.6M12 15.2h3.8', opacity: active ? 1 : 0.72 }),
      )
    }

    function NoData({ note }) {
      const { t } = useText()
      return h('span', { style: style.noData, title: note || t('noData') }, t('noData'))
    }

    function Badge({ color, children, title }) {
      return h('span', { style: style.badge(color, true), title }, children)
    }

    function ScoreCell({ value, note, color }) {
      if (!Number.isFinite(value)) return h(NoData, { note })
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center' }, title: note },
        h('span', { style: style.score(value) }, String(value)),
        h('span', { style: { width: 34, height: 4, marginLeft: 5, borderRadius: 999, background: 'var(--dsw-alias-border-l1)', overflow: 'hidden', display: 'inline-block' } },
          h('span', { style: style.barFill(value, color || scoreTone(value)) }),
        ),
      )
    }

    function CopyButton({ text, label, copiedLabel }) {
      const [copied, setCopied] = useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const area = document.createElement('textarea')
          area.value = text
          document.body.appendChild(area)
          area.select()
          try { document.execCommand('copy') } catch { /* ignore */ }
          document.body.removeChild(area)
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }
      return h('button', { type: 'button', className: 'ml-btn', style: buttonStyle(false, !text, true), onClick: copy, disabled: !text }, copied ? copiedLabel : label)
    }

    // ---- 安装反馈 ----
    //
    // 安装是秒级到分钟级的 pnpm 调用，失败原因（版本不存在、子目录改名、构建脚本待批准）
    // 只有 Host 说得清。以前这些错误只写进列表顶部的通用 error，而下一次 status 轮询
    // 会把它 setError(null) 抹掉——用户看到的是「点了没反应」。
    // 所以安装结果单独存在 notice 里：只有用户手动关、或下一次安装覆盖它才会消失。

    const NOTICE_TONE = {
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
    }

    function InstallNotice({ notice, t, onClose, onRetry, onManual, onForce }) {
      if (!notice) return null
      const tone = NOTICE_TONE[notice.tone] || NOTICE_TONE.error
      // detail 是「一行原始证据」，fullDetail 是完整 pnpm 输出。
      // 两者都在时：行内只展示证据，完整文本挂在「复制错误详情」上 ——
      // 否则一屏会被几十行 pnpm 进度刷满，而最有用的那行反而被挤到看不见。
      const copyText = notice.fullDetail || notice.detail || null
      // 兼容性拦截且**能授豁免**时，给一颗真的会动作的按钮。
      // 没有这颗，「仍然安装」永远只是文案 —— 用户点了还是同一个错误。
      const exemption = notice.exemption && notice.exemption.canGrant ? notice.exemption : null
      const buttons = h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
        exemption && typeof onForce === 'function'
          ? h('button', {
            type: 'button',
            style: buttonStyle(true, false, true),
            title: t('installForceHint').replace('{key}', exemption.key || ''),
            onClick: () => onForce(),
          }, t('installForce'))
          : null,
        notice.spec ? h(CopyButton, { text: notice.spec, label: t('installCopySpec'), copiedLabel: t('copied') }) : null,
        copyText ? h(CopyButton, { text: copyText, label: t('installCopyError'), copiedLabel: t('copied') }) : null,
        notice.retry && typeof onRetry === 'function'
          ? h('button', { type: 'button', style: buttonStyle(!!exemption ? false : true, false, true), onClick: () => onRetry() }, t('installRetry'))
          : null,
        typeof onManual === 'function'
          ? h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => onManual() }, t('installManual'))
          : null,
        h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onClose, title: t('installNoticeClose') }, '×'),
      )
      return h('div', {
        // 固定在页头下方：无论表格滚到哪、开了哪一层弹窗，失败原因都在视线里。
        style: {
          display: 'flex', flexDirection: 'column', gap: 2, padding: '9px 12px', borderRadius: 8,
          border: '1px solid ' + tone, background: 'color-mix(in srgb, ' + tone + ' 10%, transparent)',
          margin: '0 0 8px',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: tone, fontWeight: 600, fontSize: 13 } },
          h('span', null, notice.title),
          notice.subtitle ? h('span', { style: { ...style.muted, fontWeight: 400 } }, notice.subtitle) : null,
        ),
        notice.detail ? h('pre', {
          className: 'ml-scroll',
          style: {
            margin: '4px 0 0', padding: '6px 8px', maxHeight: 150, borderRadius: 6,
            background: 'rgba(0,0,0,0.22)', fontFamily: MONO, fontSize: 11, lineHeight: 1.45,
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          },
        }, notice.detail) : null,
        notice.hint ? h('div', { style: { ...style.muted, marginTop: 4 } }, notice.hint) : null,
        buttons,
      )
    }

    /**
     * 可折叠的长文本。
     *
     * 要求的行为是「默认缩放」：先只露几行，超出了才给「展开」；
     * 没有超出的短文本不该长出一个没用的按钮（那会让每一行都显得拥挤）。
     *
     * 判断「有没有超出」必须在真实 DOM 上量，不能靠字符数猜：中英文混排、
     * URL 这种无空格长串、以及不同字号下，字符数和行数根本不是线性关系。
     * 所以这里先渲染成收起状态，再用 scrollHeight / clientHeight 对比。
     *
     * @param {{text: string, lines?: number, t: any, style?: object, mono?: boolean}} props
     */
    function ClampText({ text, lines = 3, t, style: extraStyle, mono }) {
      const [expanded, setExpanded] = useState(false)
      const [overflowing, setOverflowing] = useState(false)
      const ref = useRef(null)
      const raw = typeof text === 'string' ? text : String(text ?? '')
      const lineHeight = mono ? 1.55 : 1.65
      const collapsedHeight = Math.round(lines * 12.8 * lineHeight)

      useEffect(() => {
        const node = ref.current
        if (!node || typeof node.scrollHeight !== 'number') return
        // 收起状态下的可视高度是 collapsedHeight；内容更高就说明需要按钮。
        // 留 2px 余量：亚像素行高会把「刚好 N 行」算成超出。
        setOverflowing(node.scrollHeight > collapsedHeight + 2)
      }, [raw, collapsedHeight])

      if (!raw) return null

      const body = h('div', {
        ref,
        className: 'ml-clamp' + (expanded ? ' ml-clamp-full' : ''),
        style: {
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          fontFamily: mono ? MONO : 'inherit',
          fontSize: mono ? 11.5 : 12.8,
          lineHeight: lineHeight,
          color: 'var(--dsw-alias-label-secondary)',
          ...(!expanded ? { maxHeight: collapsedHeight } : {}),
          ...(extraStyle || {}),
        },
      }, raw)

      if (!overflowing && !expanded) return body

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        body,
        h('button', {
          type: 'button',
          onClick: () => setExpanded((value) => !value),
          style: {
            appearance: 'none', border: 'none', background: 'transparent',
            color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer',
            font: 'inherit', fontSize: 11.5, padding: 0, alignSelf: 'flex-start',
          },
          title: expanded ? (t ? t('collapseText') : '收起') : (t ? t('expandText') : '展开全文'),
        }, expanded ? (t ? t('collapseText') : '收起 ↑') : ((t ? t('expandText') : '展开全文') + ' ↓')),
      )
    }

    /**
     * 把 Host 的安装失败转成一条可读提示。
     *
     * Host 现在下发的是**分层结论**，不再只是一句 pnpm 原文：
     *   code     —— 原始码（宿主的 11 个 ManagementFailure 或 pnpm 的码）
     *   layer    —— 哪一层坏了（resolve / compat / build / lock / workspace / …）
     *   action   —— 该给哪颗按钮（retry / approve / reapprove / force / copy-cmd / restart / edit / refresh / choose / disable）
     *   evidence —— 带错误码的那一行原文
     *   retryable / incompatible
     *
     * 所以这里按 layer + action 渲染，而不是硬编码认 subdir-missing / file-busy 这几个码。
     * 硬编码的后果是每加一个码都要改前端 —— 而宿主有 13 个码。
     */
    function noticeFromInstallError(cause, t, lang) {
      const body = (cause && cause.body) || {}
      const code = (cause && cause.code) || body.code || null
      const pending = Array.isArray(cause?.pendingBuilds) && cause.pendingBuilds.length
        ? cause.pendingBuilds
        : (Array.isArray(body.pendingBuilds) ? body.pendingBuilds : [])
      const detail = (cause && cause.message) ? String(cause.message) : String(cause)
      const spec = body.spec || null
      const layer = body.layer || null
      const action = body.action || null
      const evidence = body.evidence || null
      const incompatible = Array.isArray(body.incompatible) ? body.incompatible : []

      // 构建脚本待批准：这条有专属的「允许并重试」交互，优先级最高。
      if (code === 'build-approval-required' || pending.length) {
        return {
          tone: 'warn',
          title: t('installNeedsBuild'),
          subtitle: pending.join(', '),
          detail,
          spec,
          hint: t('installRetryHint'),
          retry: true,
          approvedBuilds: pending,
        }
      }

      // 分层标题：用户第一眼要知道「哪一段坏了」，而不是只看一句"安装失败"。
      const layerTitle = layer ? t('failLayerPrefix') + t('failLayer_' + layer) : t('installFailed')
      const layerHint = hintForAction(action, body, t, lang)

      return {
        // state 层（已安装）不该走到这里 —— Host 会回 200。真走到这儿也按警告处理。
        tone: layer === 'state' ? 'warn' : 'error',
        title: layerTitle,
        subtitle: spec,
        detail: evidence || detail,
        fullDetail: detail,
        spec,
        code,
        layer,
        action,
        incompatible,
        evidence,
        // 兼容性拦截要带出「真的能用的下一步」：宿主的 exact-version exemption。
        // 没有它，「仍然安装」按钮就是个摆设 —— 点了还是同一个错误。
        exemption: body.exemption || null,
        hint: layerHint || (body.fellBackFrom
          ? (lang === 'zh'
            ? '已先按目录版本、再按降级目标各试一次，仍然失败。'
            : 'Tried both the catalog target and a fallback target; both failed.')
          : null),
        retry: Boolean(body.retryable),
      }
    }

    /**
     * action → 用户能读懂的一句话。
     * action 是 Host 给的，前端只负责翻译；**不在这里判断该不该重试**。
     */
    function hintForAction(action, body, t, lang) {
      const zh = lang === 'zh'
      switch (action) {
        case 'retry':
          return t('actionRetry')
        case 'approve':
          return t('actionApprove')
        case 'reapprove':
          return t('actionReapprove')
        case 'force': {
          // 兼容性拦截：不只是把明细摊开，要给出**真的能用的**下一步。
          // 宿主提供 exact-version exemption（写 profile 的 compatibility.json），
          // 这里按 exemption 的状态说清"能授 / 已授 / 授不了"。
          const names = incompatibleNames(body.incompatible, zh)
          const exemption = body.exemption
          if (!exemption) return names
          if (exemption.granted) {
            return (names ? names + ' · ' : '') + t('actionExemptGranted')
          }
          if (exemption.canGrant) {
            return (names ? names + ' · ' : '') + t('actionExemptCanGrant').replace('{key}', exemption.key || '')
          }
          return (names ? names + ' · ' : '') + (exemption.reason || t('actionExemptCannot'))
        }
        case 'copy-cmd':
          return t('actionCopyCmd')
        case 'restart':
          return t('actionRestart')
        case 'edit':
          return t('actionEdit')
        case 'refresh':
          return t('actionRefresh')
        case 'disable':
          return t('actionDisable')
        case 'choose':
          return t('actionChoose')
        case 'fallback':
          return t('actionFallback')
        case 'none':
          return null
        default:
          return null
      }
    }

    /** incompatible 明细：把「哪个包要求了什么」摊开，别只给一个错误码。 */
    function incompatibleNames(list, zh) {
      if (!Array.isArray(list) || !list.length) return null
      const parts = list.slice(0, 4).map((item) => {
        const name = item && typeof item === 'object' ? (item.name || '?') : String(item)
        const unmet = item && typeof item === 'object' && item.unmet && typeof item.unmet === 'object'
          ? Object.entries(item.unmet).map(([key, range]) => key + ' ' + range).join(', ')
          : ''
        return name + (unmet ? '(' + unmet + ')' : '')
      })
      return (zh ? '与当前 DSH 不兼容：' : 'Incompatible with this DSH: ') + parts.join('; ')
    }


    function ManualInstallWindow({ target, t, lang, onClose }) {
      if (!target) return null
      // spec 可能是字符串（能直接复制/安装的目标），也可能被上游塞成对象
      // （{pkg, repo, command} 那种快照）。对象直接渲染会变成 "[object Object]"，
      // 所以统一折成一段可复制的文本。
      const spec = (() => {
        const raw = target.spec
        if (typeof raw === 'string') return raw
        if (!raw || typeof raw !== 'object') return ''
        if (typeof raw.spec === 'string') return raw.spec
        if (typeof raw.pkg === 'string' && raw.pkg) return raw.pkg
        if (typeof raw.repo === 'string' && raw.repo) return raw.repo
        return ''
      })()
      const keyword = target.keyword || ''
      const row = (label, value) => h(React.Fragment, null,
        h('span', { style: style.keyText }, label),
        h('span', { style: { fontFamily: MONO, overflowWrap: 'anywhere' } }, value || '—'),
      )
      return h(FloatingWindow, {
        id: 'manual-install',
        title: t('installManualTitle'),
        defaultWidth: 460,
        defaultHeight: 400,
        minWidth: 320,
        minHeight: 260,
        onClose,
        t,
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', null, t('installManualIntro')),
          h('div', { style: { ...style.muted } }, t('installManualStep1')),
          h('div', { style: { ...style.muted } }, t('installManualStep2')),
          h('div', { style: style.kv },
            row(t('installManualSearch'), keyword),
            row(t('installManualSpec'), spec),
            row(t('installCommand'), target.command || ''),
          ),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            spec ? h(CopyButton, { text: spec, label: t('installCopySpec'), copiedLabel: t('copied') }) : null,
            keyword ? h(CopyButton, { text: keyword, label: lang === 'zh' ? '复制搜索词' : 'Copy search term', copiedLabel: t('copied') }) : null,
            target.command ? h(CopyButton, { text: target.command, label: t('copyCommand'), copiedLabel: t('copied') }) : null,
          ),
          h('div', { style: { ...style.muted } }, t('installManualClipboardHint')),
        ),
      )
    }

    // ---- filter popover ----

    /** 安装列四种状态的文案；筛选、按钮、CSV 都从这里取，避免三处各写一遍。 */
    const ACTION_LABELS = {
      update: (t) => t('actUpdate'),
      installed: (t) => t('actInstalled'),
      installable: (t) => t('actInstall'),
      manual: (t) => t('actManual'),
    }

    function optionsFor(rows, key, t, lang) {
      if (key === 'sources') {
        const counts = new Map()
        for (const row of rows) for (const source of row.sources || []) counts.set(source, (counts.get(source) || 0) + 1)
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: sourceLongLabel(value), count }))
      }
      if (key === 'category') {
        const counts = new Map()
        for (const row of rows) counts.set(row.category || 'other', (counts.get(row.category || 'other') || 0) + 1)
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: categoryText(value, lang), count }))
      }
      if (key === 'compat') {
        const counts = new Map()
        for (const row of rows) counts.set(row.compat?.status || 'unknown', (counts.get(row.compat?.status || 'unknown') || 0) + 1)
        return COMPAT_ORDER.filter((value) => counts.has(value)).map((value) => ({ value, label: compatLabel(value, t), count: counts.get(value) }))
      }
      if (key === 'actions') {
        const counts = new Map()
        for (const row of rows) {
          const state = canInstallRow(row) ? actionStateOf(row) : 'manual'
          counts.set(state, (counts.get(state) || 0) + 1)
        }
        return ['update', 'installed', 'installable', 'manual']
          .filter((value) => counts.has(value))
          .map((value) => ({ value, label: ACTION_LABELS[value](t), count: counts.get(value) }))
      }
      if (key === 'installed') {
        // 兼容老会话留下的 key；新代码只用 actions。
        const yes = rows.filter((row) => row.installed).length
        return [
          { value: 'installed', label: t('actInstalled'), count: yes },
          { value: 'not-installed', label: t('actInstall'), count: rows.length - yes },
        ]
      }
      if (key === 'security') {
        const counts = new Map()
        for (const row of rows) counts.set(securityState(row), (counts.get(securityState(row)) || 0) + 1)
        const labels = {
          low: t('riskLow'),
          medium: t('riskMedium'),
          high: t('riskHigh'),
          verified: t('verified'),
          flagged: t('risk'),
          unknown: t('riskUnknown'),
        }
        return ['low', 'medium', 'high', 'verified', 'flagged', 'unknown']
          .filter((value) => counts.has(value))
          .map((value) => ({ value, label: labels[value], count: counts.get(value) }))
      }
      return []
    }

    // ---- floating window ----
    // 弹层挂在 document.body 上（portal）+ position: fixed：DSH 面板的 overflow/transform
    // 裁不到它，所以不会再被侧栏或工作区挡掉半个筛选框。位置和尺寸可拖可缩，记在 localStorage。

    function readWindowBoxes() {
      try {
        const raw = window.localStorage.getItem(WINDOW_STORE)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writeWindowBox(id, box) {
      if (!id) return
      try {
        const all = readWindowBoxes()
        all[id] = {
          left: Math.round(box.left),
          top: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
        window.localStorage.setItem(WINDOW_STORE, JSON.stringify(all))
      } catch {
        // 无痕模式或配额满：记不住位置不影响使用。
      }
    }

    function viewportSize() {
      try {
        return { width: window.innerWidth || 1280, height: window.innerHeight || 860 }
      } catch {
        return { width: 1280, height: 860 }
      }
    }

    /**
     * 夹回可视区：允许压住面板边缘，但不允许整个窗口滑出屏幕——
     * 否则拖过一次之后下次打开就再也找不到了。
     */
    function clampBox(box, view, minWidth, minHeight) {
      const width = Math.max(minWidth, Math.min(Math.round(box.width), Math.max(minWidth, view.width - 16)))
      const height = Math.max(minHeight, Math.min(Math.round(box.height), Math.max(minHeight, view.height - 16)))
      const maxLeft = Math.max(8, view.width - 160)
      const maxTop = Math.max(8, view.height - 90)
      return {
        left: Math.max(8, Math.min(Math.round(box.left), maxLeft)),
        top: Math.max(8, Math.min(Math.round(box.top), maxTop)),
        width,
        height,
      }
    }

    function portalToBody(node) {
      try {
        if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
          return ReactDOM.createPortal(node, document.body)
        }
      } catch {
        // createPortal 失败就退回行内渲染：位置会受面板裁剪，但功能不丢。
      }
      return node
    }

    // 窗口层级：点哪扇窗就把它抬到最上面，多个筛选窗同时开着不会互相压住。
    let windowZ = 2147482000

    function nextWindowZ() {
      windowZ += 1
      return windowZ
    }

    /** 把主文档的样式表搬进新窗口，否则 portal 过去只是一堆没样式的 div。 */
    function syncDocument(doc, title) {
      try {
        const head = doc.head || doc.getElementsByTagName('head')[0]
        if (!head || head.dataset.marketLensReady === '1') return
        head.dataset.marketLensReady = '1'
        doc.title = title || 'Market Lens'
        const charset = doc.createElement('meta')
        charset.setAttribute('charset', 'utf-8')
        head.appendChild(charset)
        if (typeof document !== 'undefined') {
          for (const node of document.querySelectorAll('style,link[rel="stylesheet"]')) {
            head.appendChild(node.cloneNode(true))
          }
        }
        const base = doc.createElement('style')
        base.textContent = 'html,body{margin:0;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base,#111);font-family:' + SANS + ';}'
        head.appendChild(base)
      } catch {
        // 样式搬不过去就退化成素颜窗口，功能还在
      }
    }

    /**
     * 开一个真窗口。浏览器里能做，DSH 桌面壳子会 deny（主进程的
     * setWindowOpenHandler 一律 openExternal + deny），于是这里返回 null。
     *
     * 注意这里传 'about:blank' 而不是 '': 壳子的 handler 会 `new URL(url)`，
     * 空串会直接抛 TypeError（Electron 经典版就是这样），所以必须给个合法 URL。
     */
    function openPopupWindow({ id, title, width, height, left, top }) {
      try {
        if (typeof window === 'undefined' || typeof window.open !== 'function') return null
        const popup = window.open('about:blank', 'market-lens:' + (id || 'window'), [
          'popup=yes',
          'width=' + Math.round(width),
          'height=' + Math.round(height),
          'left=' + Math.round(left),
          'top=' + Math.round(top),
        ].join(','))
        if (!popup || popup.closed) return null
        if (!popup.document || !popup.document.body) {
          try { popup.close() } catch { /* 已被壳子接管 */ }
          return null
        }
        syncDocument(popup.document, title)
        return popup
      } catch {
        return null
      }
    }

    /** 八向缩放把手：四条边 + 四个角。 */
    function resizeHandles(t, begin) {
      const hint = t ? t('windowDragHint') : undefined
      const edge = (key, axis, style, cursor) => h('div', {
        key,
        title: hint,
        style: { position: 'absolute', touchAction: 'none', cursor, ...style },
        onPointerDown: begin('resize', axis),
      })
      return [
        edge('n', 'n', { top: 0, left: 12, right: 12, height: 5 }, 'ns-resize'),
        edge('s', 's', { bottom: 0, left: 12, right: 12, height: 5 }, 'ns-resize'),
        edge('w', 'w', { left: 0, top: 12, bottom: 12, width: 5 }, 'ew-resize'),
        edge('e', 'e', { right: 0, top: 12, bottom: 12, width: 5 }, 'ew-resize'),
        edge('nw', 'nw', { left: 0, top: 0, width: 12, height: 12 }, 'nwse-resize'),
        edge('ne', 'ne', { right: 0, top: 0, width: 12, height: 12 }, 'nesw-resize'),
        edge('sw', 'sw', { left: 0, bottom: 0, width: 12, height: 12 }, 'nesw-resize'),
        edge('se', 'se', { right: 0, bottom: 0, width: 14, height: 14 }, 'nwse-resize'),
      ]
    }

    function FloatingWindow({
      id,
      title,
      anchor,
      defaultWidth,
      defaultHeight,
      minWidth,
      minHeight,
      headerNote,
      footer,
      onClose,
      t,
      children,
    }) {
      const minW = minWidth || 280
      const minH = minHeight || 220
      const base = () => {
        const view = viewportSize()
        const width = defaultWidth || 380
        const height = defaultHeight || 470
        return clampBox({
          left: Math.max(8, Math.min(anchor?.left ?? Math.round((view.width - width) / 2), view.width - width - 8)),
          top: Math.max(8, Math.min((anchor?.bottom ?? 96) + 6, view.height - height - 8)),
          width,
          height,
        }, view, minW, minH)
      }
      const [box, setBox] = useState(() => {
        const stored = id ? readWindowBoxes()[id] : null
        if (stored && Number.isFinite(stored.width) && Number.isFinite(stored.height)) {
          return clampBox(stored, viewportSize(), minW, minH)
        }
        return base()
      })
      // 拖动/缩放期间只在本地更新，松手才落盘：不然每一帧都写一次 localStorage。
      const [drag, setDrag] = useState(null)
      const [maximized, setMaximized] = useState(false)
      const [collapsed, setCollapsed] = useState(false)
      const [zIndex, setZIndex] = useState(() => nextWindowZ())
      const [popupDoc, setPopupDoc] = useState(null)
      // 壳子拒绝开新窗口时说一句，别让 ⧉ 看起来像「点了没反应」。
      const [detachNote, setDetachNote] = useState(null)
      const detachTimerRef = useRef(null)
      const restoreRef = useRef(null)
      const popupRef = useRef(null)

      const maximizedBox = () => {
        const view = viewportSize()
        return { left: 8, top: 8, width: Math.max(minW, view.width - 16), height: Math.max(minH, view.height - 16) }
      }
      // 最大化不是「改 width」，是叠一层整视口尺寸；还原时原尺寸还在 box 里。
      const frame = maximized ? maximizedBox() : box
      const raise = () => setZIndex((current) => Math.max(current, nextWindowZ()))

      useEffect(() => {
        if (!drag) return undefined
        const onMove = (event) => {
          const view = viewportSize()
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          const from = drag.box
          if (drag.mode === 'move') {
            setBox(clampBox({ ...from, left: from.left + dx, top: from.top + dy }, view, minW, minH))
            return
          }
          const next = { ...from }
          if (drag.axis.includes('e')) next.width = from.width + dx
          if (drag.axis.includes('s')) next.height = from.height + dy
          if (drag.axis.includes('w')) { next.width = from.width - dx; next.left = from.left + dx }
          if (drag.axis.includes('n')) { next.height = from.height - dy; next.top = from.top + dy }
          // 往左/上拉过头：先钉住最小尺寸，再把 left/top 顶回去，否则窗口会跳位。
          if (drag.axis.includes('w') && next.width < minW) { next.left = from.left + (from.width - minW); next.width = minW }
          if (drag.axis.includes('n') && next.height < minH) { next.top = from.top + (from.height - minH); next.height = minH }
          setBox(clampBox(next, view, minW, minH))
        }
        const onUp = () => setDrag(null)
        // pointerdown 里 preventDefault 之后浏览器不再派发 mousemove，所以只监听 pointermove。
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [drag, minW, minH])

      useEffect(() => {
        if (!drag) writeWindowBox(id, box)
      }, [box, drag, id])

      // 浏览器窗口变小后，原本贴在右下角的窗口会整块跑到可视区外，回来时先夹一次。
      useEffect(() => {
        const onResize = () => setBox((current) => clampBox(current, viewportSize(), minW, minH))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [minW, minH])

      // 窗口关掉时把真窗口一并关掉，否则会留下一个空白壳子。
      useEffect(() => () => {
        if (detachTimerRef.current) clearTimeout(detachTimerRef.current)
        const popup = popupRef.current
        popupRef.current = null
        if (popup && !popup.closed) {
          try { popup.close() } catch { /* 壳子接管了，关不掉就算了 */ }
        }
      }, [])

      const begin = (mode, axis) => (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        raise()
        let from = box
        if (maximized) {
          // 最大化时按标题栏：先还原成上一次的尺寸，再以鼠标为中心摆回去。
          const restored = restoreRef.current || base()
          from = clampBox({
            ...restored,
            left: Math.max(8, event.clientX - Math.round(restored.width / 2)),
            top: Math.max(8, event.clientY - 14),
          }, viewportSize(), minW, minH)
          setMaximized(false)
          setBox(from)
        }
        setDrag({ mode, axis, startX: event.clientX, startY: event.clientY, box: from })
      }

      const reset = () => {
        const next = base()
        setMaximized(false)
        setCollapsed(false)
        setBox(next)
        writeWindowBox(id, next)
      }

      const toggleMaximize = () => {
        if (maximized) {
          setMaximized(false)
          return
        }
        restoreRef.current = box
        setMaximized(true)
        setCollapsed(false)
      }

      /**
       * 真·独立窗口：能开就用 window.open 开一个系统窗口，再把整棵 React 树
       * portal 进它的 document。DSH 桌面壳子装了 setWindowOpenHandler 一律
       * deny（见 app.asar 的 main.js），所以那里会返回 null —— 退化成整窗最大化。
       */
      const detach = () => {
        const popup = openPopupWindow({
          id: id || 'window',
          title,
          width: frame.width,
          height: frame.height,
          left: frame.left,
          top: frame.top,
        })
        if (!popup) {
          // 桌面壳子必然走到这里：说清楚为什么，再整屏铺开。
          setDetachNote(t ? t('windowDetachBlocked') : 'popup blocked')
          if (detachTimerRef.current) clearTimeout(detachTimerRef.current)
          detachTimerRef.current = setTimeout(() => setDetachNote(null), 4200)
          toggleMaximize()
          return
        }
        setDetachNote(null)
        popupRef.current = popup
        setPopupDoc(popup.document)
        popup.addEventListener('beforeunload', () => {
          popupRef.current = null
          setPopupDoc(null)
        })
      }

      const chromeButton = (label, handler, key) => h(
        'button',
        {
          type: 'button',
          key,
          style: { ...buttonStyle(false, false, true), width: 22, height: 22, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 },
          onClick: handler,
          onPointerDown: (event) => event.stopPropagation(),
          title: t ? t(key) : undefined,
        },
        label,
      )

      // 真窗口里没有遮罩、没有圆角：铺满 popup 的 body 就行。
      const detachedLayout = Boolean(popupDoc)
      const shellStyle = detachedLayout
        ? {
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--dsw-alias-bg-base)',
          overflow: 'hidden',
        }
        : {
          position: 'fixed',
          left: frame.left,
          top: frame.top,
          width: frame.width,
          height: collapsed ? 34 : frame.height,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--dsw-alias-bg-base)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: maximized ? 0 : 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.44)',
          overflow: 'hidden',
          zIndex,
          pointerEvents: 'auto',
        }

      const surface = h(
        'div',
        {
          role: 'dialog',
          'aria-label': title,
          style: shellStyle,
          onPointerDown: raise,
        },
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 7px 5px 9px',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1)',
              cursor: 'move',
              userSelect: 'none',
              touchAction: 'none',
            },
            title: t ? t('windowDragHint') : undefined,
            onPointerDown: begin('move', ''),
            onDoubleClick: toggleMaximize,
          },
          h('span', { style: { fontSize: 11, opacity: 0.45, letterSpacing: 2 } }, '⠿'),
          h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12.6, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title || ''),
          headerNote ? h('span', { style: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, headerNote) : null,
          chromeButton(collapsed ? '▢' : '–', () => setCollapsed((current) => !current), collapsed ? 'windowRestore' : 'windowMinimize'),
          chromeButton(maximized ? '❐' : '□', toggleMaximize, maximized ? 'windowRestore' : 'windowMaximize'),
          chromeButton('⤢', reset, 'windowResetSize'),
          // 能开真窗口就开，开不了（桌面壳子）就整窗铺开，至少不是「框在面板里」。
          chromeButton('⧉', detach, 'windowDetach'),
          chromeButton('×', onClose, 'close'),
        ),
        collapsed ? null : h(
          'div',
          { className: 'ml-scroll', style: { flex: '1 1 auto', minHeight: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 9 } },
          children,
        ),
        // 壳子拒绝开新窗口时的解释条：只在 ⧉ 失败后出现几秒。
        detachNote && !collapsed
          ? h('div', { style: { flex: 'none', padding: '6px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, detachNote)
          : null,
        footer && !collapsed
          ? h('div', { style: { flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: 7, padding: '8px 10px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, footer)
          : null,
        // 八向缩放：四条边 + 四个角。只给右下角的话，靠右边的窗根本没法往左拉宽。
        collapsed || maximized || detachedLayout ? null : resizeHandles(t, begin),
      )

      if (popupDoc && ReactDOM && typeof ReactDOM.createPortal === 'function') {
        try {
          return ReactDOM.createPortal(surface, popupDoc.body)
        } catch {
          // popup 已经没了（用户手动关窗）：退回浮层
        }
      }

      // 透明遮罩：点窗外关闭（和浏览器弹层的手感一致），但不吃掉窗内的点击。
      const layer = h(
        'div',
        {
          style: { position: 'fixed', inset: 0, zIndex: zIndex - 1, background: maximized ? 'rgba(0,0,0,0.18)' : 'transparent' },
          onPointerDown: (event) => { if (event.target === event.currentTarget) onClose() },
        },
        surface,
      )
      return portalToBody(layer)
    }

    function FilterPopover({ column, anchor, rows, filters, setFilters, onClose }) {
      const { t, lang } = useText()
      const key = column.key
      const current = filters[key]
      const [search, setSearch] = useState('')
      const isSet = ['sources', 'category', 'compat', 'actions', 'security'].includes(key)
      const options = useMemo(() => (isSet ? optionsFor(rows, key, t, lang) : []), [rows, key, t, lang, isSet])
      const [selected, setSelected] = useState(Array.isArray(current) ? current : [])
      const [min, setMin] = useState(current && current.min != null ? String(current.min) : '')
      const [max, setMax] = useState(current && current.max != null ? String(current.max) : '')
      const [includeNull, setIncludeNull] = useState(Boolean(current && current.includeNull))
      const [from, setFrom] = useState(current && current.from ? current.from : '')
      const [to, setTo] = useState(current && current.to ? current.to : '')
      const [text, setText] = useState(typeof current === 'string' ? current : '')

      const apply = () => {
        const next = { ...filters }
        if (isSet) {
          if (selected.length === 0) delete next[key]
          else next[key] = selected
        } else if (column.filter === 'number') {
          const hasValue = min !== '' || max !== '' || includeNull
          if (!hasValue) delete next[key]
          else next[key] = { min: min === '' ? null : Number(min), max: max === '' ? null : Number(max), includeNull }
        } else if (column.filter === 'date') {
          const hasValue = Boolean(from || to || includeNull)
          if (!hasValue) delete next[key]
          else next[key] = { from, to, includeNull }
        } else if (column.filter === 'text') {
          if (text.trim() === '') delete next[key]
          else next[key] = text.trim()
        }
        setFilters(next)
        onClose()
      }

      const clear = () => {
        const next = { ...filters }
        delete next[key]
        setFilters(next)
        onClose()
      }

      const setPreset = (days) => {
        const end = new Date()
        const start = days === 365 ? new Date(end.getFullYear(), 0, 1) : new Date(end.getTime() - days * 86_400_000)
        setFrom(start.toISOString().slice(0, 10))
        setTo(end.toISOString().slice(0, 10))
      }

      return h(
        FloatingWindow,
        {
          id: 'filter:' + key,
          title: t('filterTitle') + ' · ' + (column.label || ''),
          anchor,
          defaultWidth: 380,
          defaultHeight: 470,
          minWidth: 280,
          minHeight: 240,
          t,
          onClose,
          footer: [
            h('button', { key: 'clear', type: 'button', style: buttonStyle(false, false, true), onClick: clear }, t('clear')),
            h('button', { key: 'close', type: 'button', style: buttonStyle(false, false, true), onClick: onClose }, t('close')),
            h('button', { key: 'apply', type: 'button', style: buttonStyle(true, false, true), onClick: apply }, t('apply')),
          ],
        },
          isSet
            ? h(
                React.Fragment,
                null,
                h('input', {
                  style: { ...style.search, flex: 'none', minWidth: 0, width: '100%', padding: '6px 8px', fontSize: 12 },
                  value: search,
                  placeholder: t('searchValues'),
                  onChange: (event) => setSearch(event.target.value),
                }),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => setSelected(options.map((option) => option.value)) }, t('selectAll')),
                  h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => setSelected([]) }, t('clear')),
                ),
                h(
                  'div',
                  { className: 'ml-scroll', style: { display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 260 } },
                  options
                    .filter((option) => !search || option.label.toLowerCase().includes(search.toLowerCase()) || option.value.toLowerCase().includes(search.toLowerCase()))
                    .map((option) =>
                      h(
                        'label',
                        { key: option.value, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 12.3, background: selected.includes(option.value) ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' } },
                        h('input', {
                          type: 'checkbox',
                          checked: selected.includes(option.value),
                          onChange: () => setSelected((previous) => (previous.includes(option.value) ? previous.filter((value) => value !== option.value) : [...previous, option.value])),
                        }),
                        h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, option.label),
                        h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, option.count.toLocaleString('en-US')),
                      ),
                    ),
                ),
              )
            : column.filter === 'number'
              ? h(
                  React.Fragment,
                  null,
                  h('div', { style: { display: 'flex', gap: 8 } },
                    h('input', { type: 'number', style: { ...style.search, flex: '1 1 0', minWidth: 0, padding: '6px 8px', fontSize: 12 }, value: min, placeholder: t('min'), onChange: (event) => setMin(event.target.value) }),
                    h('input', { type: 'number', style: { ...style.search, flex: '1 1 0', minWidth: 0, padding: '6px 8px', fontSize: 12 }, value: max, placeholder: t('max'), onChange: (event) => setMax(event.target.value) }),
                  ),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                    h('input', { type: 'checkbox', checked: includeNull, onChange: (event) => setIncludeNull(event.target.checked) }),
                    t('includeNull'),
                  ),
                  h('div', { style: style.muted }, key === 'rating' ? t('ratingNote') : key === 'users' ? t('userCountNote') : null),
                )
              : column.filter === 'text'
                ? h('input', {
                    style: { ...style.search, width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12 },
                    value: text,
                    placeholder: key === 'version' ? '1.2.3' : t('searchValues'),
                    onChange: (event) => setText(event.target.value),
                  })
                : h(
                  React.Fragment,
                  null,
                  h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                    [[7, t('last7')], [30, t('last30')], [90, t('last90')], [365, t('thisYear')]].map(([days, label]) =>
                      h('button', { key: days, type: 'button', style: style.preset(false), onClick: () => setPreset(days) }, label),
                    ),
                  ),
                  h('div', { style: { display: 'flex', gap: 8 } },
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 0', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, t('from'),
                      h('input', { type: 'date', style: { ...style.search, minWidth: 0, padding: '5px 7px', fontSize: 12 }, value: from, onChange: (event) => setFrom(event.target.value) }),
                    ),
                    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 0', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, t('to'),
                      h('input', { type: 'date', style: { ...style.search, minWidth: 0, padding: '5px 7px', fontSize: 12 }, value: to, onChange: (event) => setTo(event.target.value) }),
                    ),
                  ),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                    h('input', { type: 'checkbox', checked: includeNull, onChange: (event) => setIncludeNull(event.target.checked) }),
                    t('includeNull'),
                  ),
                ),
      )
    }

    // ---- table ----

    function HeaderCell({ column, sort, onSort, onFilter, onResizeStart, active, t, lang, showFilter }) {
      const label = column.label || column.key
      const sorted = sort.key === column.key
      return h(
        'div',
        { style: { ...style.headerCell(column.align), position: 'relative' }, role: 'columnheader' },
        column.sortable
          ? h('button', {
              type: 'button',
              className: 'ml-head-btn',
              style: { appearance: 'none', border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              onClick: () => onSort(column.key),
              title: label,
            }, label, h('span', { style: { fontSize: 9, opacity: sorted ? 1 : 0.35 } }, sorted ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'))
          : h('span', null, label),
        // 筛选栏关掉时表头只留排序，列变窄后表头文字才有地方显示；
        // 已经生效的筛选仍在上方 chip 里可见，不会变成「隐形过滤」。
        column.filter && showFilter !== false
          ? h('button', {
              type: 'button',
              className: 'ml-filter-btn',
              style: { appearance: 'none', border: 'none', background: 'transparent', color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)', padding: 1, marginLeft: 'auto', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' },
              onClick: (event) => onFilter(column, event),
              title: t('filterTitle'),
            }, h(FunnelIcon, { size: 13, active }))
          : null,
        h('div', {
          className: 'ml-resizer',
          title: t('columnSettings'),
          style: { position: 'absolute', right: -3, top: 2, bottom: 2, width: 7, cursor: 'col-resize', zIndex: 2 },
          onPointerDown: (event) => onResizeStart(column, event),
          onClick: (event) => event.stopPropagation(),
        }),
      )
    }

    function Table({
      rows,
      allRows,
      columns,
      columnWidths,
      gridTemplate,
      tableMinWidth,
      onResizeStart,
      filters,
      setFilters,
      sort,
      setSort,
      scrollRef,
      page,
      setPage,
      pageSize,
      setPageSize,
      onOpenDetail,
      t,
      lang,
      showFilters,
      onInstall,
      actionBusy,
      installedKeys,
      onSync,
    }) {
      const [openFilter, setOpenFilter] = useState(null)
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
      const safePage = Math.min(page, pageCount)
      const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize)

      /**
       * 空表必须区分三种情况 —— 它们对用户的下一步动作完全不同。
       *
       * 以前只有一句 `emptyFiltered`（"没有符合当前筛选条件的插件。"），
       * 于是「目录还没同步过」和「筛得太狠」显示同一句话：前者要点同步，
       * 后者要清筛选。用户照着错的那条做，怎么都出不来数据。
       *
       * `emptyCatalog` 这个 i18n key 早就写好了，只是一直没被引用。
       *
       * @returns {object} 空态节点
       */
      const emptyState = () => {
        const total = Array.isArray(allRows) ? allRows.length : rows.length
        const filteredOut = total > 0 && rows.length === 0
        const copy = filteredOut ? t('emptyFiltered') : t('emptyCatalog')
        const box = (extra) => h('div', {
          style: { padding: '36px 20px', textAlign: 'center', ...style.muted },
        }, copy, extra || null)
        // 目录完全没有数据：直接把「去同步」摆在空态里，别让用户自己去工具栏找。
        if (!filteredOut && typeof onSync === 'function') {
          return box(h('div', { style: { marginTop: 10 } },
            h('button', {
              type: 'button',
              style: buttonStyle(true, false, true),
              onClick: (event) => { event.stopPropagation(); void onSync() },
            }, t('sync')),
          ))
        }
        return box(null)
      }

      useEffect(() => {
        if (page !== safePage) setPage(safePage)
      }, [page, safePage, setPage])

      useEffect(() => {
        if (!openFilter) return
        const close = () => setOpenFilter(null)
        window.addEventListener('resize', close)
        return () => window.removeEventListener('resize', close)
      }, [openFilter])

      const labelFor = (key) => {
        if (key === 'name') return lang === 'zh' ? '插件' : 'Plugin'
        if (key === 'sources') return lang === 'zh' ? '来源' : 'Sources'
        if (key === 'category') return lang === 'zh' ? '分类' : 'Category'
        if (key === 'version') return lang === 'zh' ? '版本' : 'Version'
        if (key === 'updatedAt') return lang === 'zh' ? '更新日期' : 'Updated'
        if (key === 'compat') return lang === 'zh' ? '适配 DSH' : 'DSH fit'
        if (key === 'users') return lang === 'zh' ? '用户数' : 'Users'
        if (key === 'rating') return lang === 'zh' ? '评分' : 'Rating'
        if (key === 'market') return lang === 'zh' ? '市场风评' : 'Market'
        if (key === 'community') return lang === 'zh' ? '民间风评' : 'Community'
        if (key === 'stars') return 'Stars'
        if (key === 'downloads') return lang === 'zh' ? '周下载' : 'Downloads'
        if (key === 'security') return lang === 'zh' ? '安全/验证' : 'Security'
        // 状态已经长在按钮上，这一列就叫「安装 / 更新」：它既是动作，也是状态。
        if (key === 'actions') return lang === 'zh' ? '安装 / 更新' : 'Install / update'
        return key
      }

      const securityCell = (row) => {
        const state = securityState(row)
        const risk = row.security?.riskLevel
        const color = risk === 'low' ? 'var(--dsw-alias-state-success-primary)'
          : risk === 'medium' ? 'var(--dsw-alias-state-warn-primary)'
            : risk === 'high' ? 'var(--dsw-alias-state-error-primary)'
              : state === 'verified' ? 'var(--dsw-alias-brand-primary)'
                : state === 'flagged' ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-label-secondary)'
        const label = risk === 'low' ? t('riskLow')
          : risk === 'medium' ? t('riskMedium')
            : risk === 'high' ? t('riskHigh')
              : state === 'verified' ? t('verified')
                : state === 'flagged' ? t('risk')
                  : t('riskUnknown')
        const title = [
          risk ? `${t('risk')}: ${risk}` : null,
          row.verification?.installCheck ? `${t('installCheck')}: ${row.verification.installCheck}` : null,
          ...(row.riskFlags || []),
        ].filter(Boolean).join(' · ')
        if (state === 'unknown') return h(NoData, { note: t('noSecurityData') })
        return h('span', { style: { ...style.badge(color, true), cursor: 'help' }, title }, label)
      }

      const renderCell = (row, column) => {
        if (column.key === 'actions') {
          // 行本身的 onClick 会打开详情：按钮必须 stopPropagation，否则点安装等于点行。
          const rowKey = rowKeyOf(row)
          const busy = Boolean(actionBusy) && actionBusy.key === rowKey
          // 状态只有一个来源：Host 下发的 row.button（见 lib/button-state.js）。
          // 前端乐观集合只用来「装完立刻变样」，一旦 Host 回的目录覆盖了它就以目录为准。
          const done = Boolean(row.installed) || (Boolean(installedKeys) && installedKeys.has(rowKey))
          const update = row.update && row.update.available ? row.update : null
          // 失败优先：这次装/升级失败了，按钮回到可点状态并把失败留在标题上，
          // 点一次就能重试（页头另有完整回执与 pnpm 原文）。
          const failed = Boolean(actionBusy) && actionBusy.key === rowKey && actionBusy.status === 'error'
          // Host 算好的状态；没有就退回一份保守推断（旧 Host 兼容）。
          const button = row.button || null
          const state = failed
            ? 'retry'
            : (button && button.state) || (done ? (update ? 'update' : 'installed-local') : (canInstallRow(row) ? 'install' : 'manual'))

          if (busy) {
            const label = actionBusy.mode === 'upgrade'
              ? t('actUpgrading')
              : (actionBusy.mode === 'reinstall' ? t('actReinstalling') : t('actInstalling'))
            return h('button', {
              type: 'button',
              className: 'ml-row-install',
              title: actionBusy.suffix ? label + ' · ' + actionBusy.suffix : label,
              style: { ...buttonStyle(false, true, true), padding: '2px 8px', whiteSpace: 'nowrap' },
              disabled: true,
            }, '…')
          }

          if (state === 'manual') {
            return h('span', { style: { ...style.muted, fontSize: 11 }, title: t('actManualHint') }, t('actManual'))
          }

          // 六种稳定状态各有一份渲染。以前这里按 done/update 两个布尔拼，
          // 于是「已是最新」这个状态永远上不了屏（installedUpToDate 那个 key 是死的）。
          const mode = button && button.mode ? button.mode : (state === 'update' ? 'upgrade' : (state === 'install' ? 'install' : 'reinstall'))
          const fire = (event) => { event.stopPropagation(); void onInstall(row, mode) }
          const keyStop = (event) => event.stopPropagation()

          if (state === 'update') {
            const to = button && button.version ? button.version : (update ? update.to : null)
            return h('button', {
              type: 'button',
              className: 'ml-row-install',
              title: update ? updateBadgeTitle(update, t) : t('actUpdateHint'),
              style: { ...buttonStyle(true, false, true), padding: '2px 7px', whiteSpace: 'nowrap', fontFamily: MONO },
              onClick: fire,
              onKeyDown: keyStop,
            }, t('actUpdate') + ' ↑ ' + (to || ''))
          }

          if (state === 'current') {
            // 查过、确认没有新版。可点 —— 点了等于重装同一目标（幂等）。
            return h('button', {
              type: 'button',
              className: 'ml-row-install',
              title: (row.installedVersion ? t('actInstalledAt') + ' ' + row.installedVersion : t('actInstalled')) + '\n' + t('actUpToDateHint'),
              style: { ...buttonStyle(false, false, true), padding: '2px 8px', whiteSpace: 'nowrap', color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-border-l1)' },
              onClick: fire,
              onKeyDown: keyStop,
            }, '✓ ' + t('installedUpToDate'))
          }

          if (state === 'installed-local') {
            // 已装但是本地 / link / github —— **没有可比版本**，不能说「已是最新」。
            return h('button', {
              type: 'button',
              className: 'ml-row-install',
              title: (row.installedVersion ? t('actInstalledAt') + ' ' + row.installedVersion : t('actInstalled')) + '\n' + t('actInstalledLocalHint'),
              style: { ...buttonStyle(false, false, true), padding: '2px 8px', whiteSpace: 'nowrap', color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-border-l1)' },
              onClick: fire,
              onKeyDown: keyStop,
            }, '✓ ' + t('actInstalled'))
          }

          if (state === 'retry') {
            return h('button', {
              type: 'button',
              className: 'ml-row-install',
              title: t('actRetryHint'),
              style: { ...buttonStyle(true, false, true), padding: '2px 8px', whiteSpace: 'nowrap', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
              onClick: fire,
              onKeyDown: keyStop,
            }, t('actRetry'))
          }

          // install：未装且折得出目标。
          return h('button', {
            type: 'button',
            className: 'ml-row-install',
            title: t('actInstallHint'),
            style: { ...buttonStyle(true, false, true), padding: '2px 8px', whiteSpace: 'nowrap' },
            onClick: fire,
            onKeyDown: keyStop,
          }, t('actInstall'))
        }
        if (column.key === 'name') {
          const change = CHANGE_META[row.change] || null
          const update = row.update && row.update.available ? row.update : null
          return h(React.Fragment, null,
            h('div', { style: { ...style.pluginTitle, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
              h('span', { title: row.title || row.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title || row.name),
              change
                ? h('span', { style: { ...style.badge(change.color, true), flex: '0 0 auto' }, title: t('changeNote') }, t(change.labelKey))
                : null,
              update
                ? h('span', {
                    style: {
                      ...style.badge(update.kind === 'major' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)', true),
                      flex: '0 0 auto',
                      fontFamily: MONO,
                    },
                    title: updateBadgeTitle(update, t),
                  }, t('updateAvailable') + ' ' + update.to)
                : null,
            ),
            h('div', { style: style.pluginSub, title: row.pkg || row.repo || '' }, row.pkg || row.repo || '—'),
          )
        }
        if (column.key === 'sources') {
          const sources = row.sources || []
          return h(React.Fragment, null,
            ...sources.slice(0, sources.length > 2 ? 1 : 2).map((source) => h('span', { key: source, style: { ...style.badge(sourceColor(source), true), marginRight: 3 } }, sourceLabel(source))),
            sources.length > 2
              ? h('span', { title: sources.map(sourceLongLabel).join(' · '), style: { ...style.badge('var(--dsw-alias-label-secondary)', false), marginRight: 3 } }, '+' + (sources.length - 2))
              : null,
          )
        }
        if (column.key === 'category') return categoryText(row.category, lang)
        if (column.key === 'version') {
          return row.version
            ? h('span', { title: row.version, style: { display: 'block', fontFamily: MONO, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.version)
            : h(NoData, { note: t('noData') })
        }
        if (column.key === 'updatedAt') {
          return row.updatedAt
            ? h('div', null, datePart(row.updatedAt), h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, relativeDays(row.updatedAt, lang)))
            : h(NoData, { note: t('noData') })
        }
        if (column.key === 'compat') {
          return h('span', { style: { ...style.badge(COMPAT_COLORS[row.compat?.status] || COMPAT_COLORS.unknown, true), cursor: 'help' }, title: t('compatNote') }, compatLabel(row.compat?.status, t))
        }
        if (column.key === 'users') {
          return row.installers == null ? h(NoData, { note: t('noUserDataNote') }) : h('span', { title: t('userCountNote'), style: { fontVariantNumeric: 'tabular-nums' } }, formatCompact(row.installers, lang))
        }
        if (column.key === 'rating') {
          return Number.isFinite(row.score) ? h('span', { style: style.score(row.score), title: t('ratingNote') }, String(row.score)) : h(NoData, { note: t('noRatingDataNote') })
        }
        if (column.key === 'market') return h(ScoreCell, { value: row.marketScore, note: t('marketNote') })
        if (column.key === 'community') return h(ScoreCell, { value: row.communityScore, note: t('communityNote') })
        if (column.key === 'stars') return row.stars == null ? h(NoData, { note: t('noData') }) : h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, formatCompact(row.stars, lang))
        if (column.key === 'downloads') return row.downloads == null ? h(NoData, { note: t('noData') }) : h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, formatCompact(row.downloads, lang))
        if (column.key === 'security') return securityCell(row)
        return h(NoData, { note: t('noData') })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: style.tableWrap },
          h(
            'div',
            { className: 'ml-table-scroll', style: style.tableScroll, ref: scrollRef, onScroll: () => rememberScrollTop(scrollRef && scrollRef.current) },
            h(
              'div',
              { style: { minWidth: tableMinWidth } },
              h(
                'div',
                { style: { ...style.headerRow, gridTemplateColumns: gridTemplate, minWidth: tableMinWidth } },
                columns.map((column) =>
                  h(HeaderCell, {
                    key: column.key,
                    column: { ...column, label: labelFor(column.key) },
                    sort,
                    onSort: (key) => setSort((previous) => ({ key, dir: previous.key === key && previous.dir === 'desc' ? 'asc' : 'desc' })),
                    onFilter: (col, event) => setOpenFilter({ key: col.key, column: { ...col, label: labelFor(col.key) }, rect: event.currentTarget.getBoundingClientRect() }),
                    onResizeStart,
                    active: filterActive(filters, column.key),
                    t,
                    lang,
                    showFilter: showFilters,
                  }),
                ),
              ),
              pageRows.length === 0
                ? emptyState()
                : pageRows.map((row) =>
                    h(
                      'div',
                      {
                        key: row.id,
                        className: 'ml-row',
                        style: { ...style.row, gridTemplateColumns: gridTemplate, minWidth: tableMinWidth },
                        onClick: () => onOpenDetail(row.id),
                        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDetail(row.id) } },
                        tabIndex: 0,
                        role: 'button',
                      },
                      ...columns.map((column) =>
                        h('div', { key: column.key, style: style.cell(column.align) }, renderCell(row, column)),
                      ),
                    ),
                  ),
            ),
          ),
        ),
        openFilter
          ? h(FilterPopover, {
              column: openFilter.column,
              anchor: openFilter.rect,
              rows: allRows || rows,
              filters,
              setFilters,
              onClose: () => setOpenFilter(null),
            })
          : null,
        h(
          'div',
          { style: style.footer },
          h('div', { style: style.muted }, t('page') + ' ' + safePage + ' / ' + pageCount + ' · ' + rows.length + ' ' + t('rows')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', { type: 'button', style: buttonStyle(false, safePage <= 1, true), disabled: safePage <= 1, onClick: () => setPage(1) }, '«'),
            h('button', { type: 'button', style: buttonStyle(false, safePage <= 1, true), disabled: safePage <= 1, onClick: () => setPage(safePage - 1) }, '‹'),
            h('button', { type: 'button', style: buttonStyle(false, safePage >= pageCount, true), disabled: safePage >= pageCount, onClick: () => setPage(safePage + 1) }, '›'),
            h('button', { type: 'button', style: buttonStyle(false, safePage >= pageCount, true), disabled: safePage >= pageCount, onClick: () => setPage(pageCount) }, '»'),
            h('select', {
              style: { ...style.search, flex: 'none', width: 'auto', padding: '4px 7px', fontSize: 12 },
              value: pageSize,
              onChange: (event) => { setPageSize(Number(event.target.value)); setPage(1) },
            }, [50, 100, 200].map((size) => h('option', { key: size, value: size }, String(size)))),
          ),
        ),
      )
    }
    // ---- toolbar popovers ----

    // 工具栏弹层同样走浮动窗口：它们原来贴在按钮下方，被面板裁掉尾部时连"保存"都点不到。
    function PopoverFrame({ id, title, anchor, width, height, minWidth, minHeight, onClose, t, children }) {
      return h(FloatingWindow, {
        id,
        title,
        anchor,
        defaultWidth: width,
        defaultHeight: height,
        minWidth,
        minHeight,
        onClose,
        t,
      }, children)
    }

    function ColumnSettingsPopover({ anchor, onClose, visibility, setVisibility, onReset, showFilters, setShowFilters, t, lang }) {
      const columnLabel = (key) => {
        if (key === 'name') return t('nameColumn')
        if (key === 'sources') return t('source')
        if (key === 'category') return t('category')
        if (key === 'version') return t('versionColumn')
        if (key === 'updatedAt') return t('updated')
        if (key === 'compat') return t('compat')
        if (key === 'users') return t('users')
        if (key === 'rating') return t('rating')
        if (key === 'market') return t('market')
        if (key === 'community') return t('community')
        if (key === 'stars') return 'Stars'
        if (key === 'downloads') return t('downloadsColumn')
        if (key === 'security') return t('securityColumn')
        if (key === 'installed') return t('installed')
        if (key === 'actions') return lang === 'zh' ? '安装 / 更新' : 'Install / update'
        return key
      }
      return h(
        PopoverFrame,
        {
          id: 'columns',
          title: t('columnSettings'),
          anchor,
          width: 320,
          height: 500,
          minWidth: 260,
          minHeight: 240,
          onClose,
          t,
        },
        h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onReset }, t('resetWidths')),
        ),
        // 14 列逐个点太慢：给三个预设，名字列永远保留。
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
          ...[
            { label: lang === 'zh' ? '精简' : 'Compact', keys: ['sources', 'updatedAt', 'compat', 'users', 'actions'] },
            { label: lang === 'zh' ? '全部' : 'All', keys: COLUMNS.map((column) => column.key) },
            { label: lang === 'zh' ? '默认' : 'Default', keys: COLUMNS.filter((column) => column.defaultVisible !== false).map((column) => column.key) },
          ].map((preset) => h('button', {
            key: preset.label,
            type: 'button',
            style: buttonStyle(false, false, true),
            onClick: () => setVisibility(Object.fromEntries(
              COLUMNS.map((column) => [column.key, column.key === 'name' || preset.keys.includes(column.key)]),
            )),
          }, preset.label)),
        ),
        h('div', { style: { ...style.muted, fontSize: 11.5 } }, lang === 'zh'
          ? '版本、周下载、安全/验证默认隐藏；拖动表头边缘可把列压得很窄，过长的名称会省略显示。'
          : 'Version, downloads and security are hidden by default; drag header edges to shrink columns, long names are ellipsized.'),
        h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 6, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', fontSize: 12.5 } },
            h('input', {
              type: 'checkbox',
              checked: showFilters !== false,
              onChange: () => setShowFilters(showFilters === false),
            }),
            lang === 'zh' ? '在表头显示筛选按钮' : 'Show filter buttons in header',
          ),
          h('div', { style: { ...style.muted, fontSize: 11, paddingLeft: 4 } }, lang === 'zh'
            ? '关闭后表头只留排序，列压窄时表头文字才有地方显示；已生效的筛选仍显示在表格上方，不会变成隐形过滤。'
            : 'When off, headers keep sorting only so narrow columns can still show their label; active filters stay visible as chips above.'),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 6, paddingTop: 6 } },
          ...COLUMNS.map((column) =>
            h('label', { key: column.key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', fontSize: 12.5, opacity: column.key === 'name' ? 0.55 : 1 } },
              h('input', {
                type: 'checkbox',
                checked: visibility[column.key] !== false,
                disabled: column.key === 'name',
                onChange: () => setVisibility((previous) => ({ ...previous, [column.key]: previous[column.key] === false })),
              }),
              columnLabel(column.key),
            ),
          ),
        ),
      )
    }

    function sourceKindLabel(kind, t) {
      if (kind === '1024store') return t('sourceKind1024')
      if (kind === 'dshfind') return t('sourceKindDshfind')
      if (kind === 'dshso') return t('sourceKindDshso')
      if (kind === 'dshmarketplace') return t('sourceKindDshmarketplace')
      if (kind === 'standard') return t('sourceKindStandard')
      return t('sourceKindFormat1')
    }

    function SourceManagerPopover({ anchor, status, onClose, onStatus, onSync, onOpenSources, filters, setFilters, t, lang }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [message, setMessage] = useState(null)
      const [url, setUrl] = useState('')
      const sources = status?.sourceConfig?.sources || []
      const health = new Map((status?.sourceHealth || []).map((entry) => [entry.id, entry]))
      const selected = Array.isArray(filters.sources) ? filters.sources : []
      const allSelected = selected.length === 0

      const toggleFilter = (id) => {
        if (allSelected) {
          setFilters({ ...filters, sources: [id] })
          return
        }
        const next = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
        const copy = { ...filters }
        if (next.length === 0) delete copy.sources
        else copy.sources = next
        setFilters(copy)
      }

      const toggleSource = async (source) => {
        setBusy(true)
        setError(null)
        try {
          await request({ op: 'sources.toggle', id: source.id, enabled: !source.enabled })
          await onStatus()
          setMessage(t('syncNeeded'))
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setBusy(false)
        }
      }

      const addSource = async () => {
        const value = asText(url).trim()
        if (!value) return
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
          const body = await request({ op: 'sources.add', url: value })
          setUrl('')
          await onStatus()
          setMessage(t('sourceAdded') + (body.source?.name ? ' · ' + body.source.name : ''))
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setBusy(false)
        }
      }

      const removeSource = async (source) => {
        setBusy(true)
        setError(null)
        try {
          await request({ op: 'sources.remove', id: source.id })
          await onStatus()
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setBusy(false)
        }
      }

      return h(
        PopoverFrame,
        {
          id: 'sources',
          title: t('pluginSources'),
          anchor,
          width: 460,
          height: 560,
          minWidth: 320,
          minHeight: 280,
          onClose,
          t,
        },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 } },
          h('button', { type: 'button', style: buttonStyle(false, busy, true), disabled: busy, onClick: () => void onSync() }, t('refreshAll')),
        ),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: buttonStyle(!allSelected, false, true), onClick: () => { const copy = { ...filters }; delete copy.sources; setFilters(copy) } }, t('allSources')),
          ...sources.map((source) => h('button', {
            key: source.id,
            type: 'button',
            style: buttonStyle(selected.includes(source.id), false, true),
            onClick: () => toggleFilter(source.id),
          }, sourceLabel(source.id))),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          ...sources.map((source) => {
            const meta = health.get(source.id) || {}
            const progress = meta.progress || {}
            return h('div', { key: source.id, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '7px 0', display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
                h('span', { style: { ...style.badge(sourceColor(source.id), true) } }, sourceLabel(source.id)),
                h('strong', { style: { fontSize: 12.5 } }, source.name),
                h('span', { style: { ...style.muted, fontSize: 11 } }, sourceKindLabel(source.kind, t)),
                h('span', { style: { ...style.muted, fontSize: 11, marginLeft: 'auto' } }, (meta.rows || 0).toLocaleString('en-US') + ' ' + t('sourceRows')),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
                h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 } },
                  h('input', { type: 'checkbox', checked: source.enabled !== false, disabled: busy, onChange: () => void toggleSource(source) }),
                  t('sourceEnabled'),
                ),
                progress.error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, progress.error) : null,
                meta.lastSuccessAt || meta.failureCount || meta.lastError
                  ? h('span', { style: { ...style.muted, fontSize: 11 }, title: meta.lastError || '' },
                      ((meta.lastSuccessAt ? (lang === 'zh' ? '上次成功 ' : 'last ok ') + relativeDays(meta.lastSuccessAt, lang) : (lang === 'zh' ? '从未成功' : 'never ok')) +
                       (meta.failureCount ? ' · ' + (lang === 'zh' ? '连续失败 ' : 'failed ') + meta.failureCount + (lang === 'zh' ? ' 次' : 'x') : '')))
                  : null,
                !source.builtin ? h('button', { type: 'button', style: buttonStyle(false, busy, true), disabled: busy, onClick: () => void removeSource(source) }, t('removeSource')) : null,
              ),
            )
          }),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('addStandardSource')),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('input', { style: { ...style.search, flex: '1 1 auto', minWidth: 0, fontFamily: MONO, fontSize: 11.5 }, value: url, placeholder: t('standardUrlPlaceholder'), onChange: (event) => setUrl(event.target.value) }),
            h('button', { type: 'button', style: buttonStyle(true, busy || !asText(url).trim(), true), disabled: busy || !asText(url).trim(), onClick: () => void addSource() }, busy ? t('loading') : t('add')),
          ),
          h('div', { style: { ...style.muted, fontSize: 11 } }, lang === 'zh' ? '支持 catalog-source manifest 或 format 1 索引；添加后不会自动安装任何东西。' : 'Accepts a catalog-source manifest or a format 1 index; adding never installs anything.'),
        ),
        message ? h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' } }, message) : null,
        error ? h('div', { style: style.errorBox }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 7 } },
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onOpenSources }, t('manageSources')),
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onClose }, t('close')),
        ),
      )
    }

    function SchedulePopover({ anchor, status, onClose, onStatus, onSync, t, lang }) {
      const current = status?.settings?.refreshIntervalMinutes ?? 0
      const [value, setValue] = useState(current)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [message, setMessage] = useState(null)
      const options = status?.settings?.options || [0, 30, 60, 180, 360, 720, 1440]

      useEffect(() => {
        setValue(current)
      }, [current])

      const labelFor = (minutes) => {
        if (minutes === 0) return t('scheduleOff')
        if (minutes < 60) return t('scheduleEvery') + ' ' + minutes + ' ' + t('scheduleMinutes')
        return t('scheduleEvery') + ' ' + (minutes / 60) + ' ' + t('scheduleHours')
      }

      const save = async () => {
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
          const body = await request({ op: 'settings.set', refreshIntervalMinutes: value })
          await onStatus()
          setMessage(body.settings?.nextAutoRefreshAt
            ? t('nextRefresh') + ': ' + body.settings.nextAutoRefreshAt.slice(0, 16).replace('T', ' ')
            : t('saveSchedule') + ' ✓')
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setBusy(false)
        }
      }

      return h(
        PopoverFrame,
        {
          id: 'schedule',
          title: t('schedule'),
          anchor,
          width: 360,
          height: 400,
          minWidth: 280,
          minHeight: 260,
          onClose,
          t,
        },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          ...options.map((minutes) =>
            h('label', { key: minutes, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', fontSize: 12.5 } },
              h('input', { type: 'radio', name: 'market-lens-schedule', checked: value === minutes, onChange: () => setValue(minutes) }),
              labelFor(minutes),
            ),
          ),
        ),
        status?.settings?.nextAutoRefreshAt
          ? h('div', { style: { ...style.muted, fontSize: 11.5 } }, t('nextRefresh') + ': ' + status.settings.nextAutoRefreshAt.slice(0, 16).replace('T', ' '))
          : h('div', { style: { ...style.muted, fontSize: 11.5 } }, lang === 'zh' ? '当前未设置自动刷新。' : 'No scheduled refresh is set.'),
        message ? h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' } }, message) : null,
        error ? h('div', { style: style.errorBox }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 7 } },
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => { onSync(); onClose() } }, t('manualRefresh')),
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onClose }, t('close')),
          h('button', { type: 'button', style: buttonStyle(true, busy, true), disabled: busy, onClick: () => void save() }, busy ? t('loading') : t('saveSchedule')),
        ),
      )
    }
    // ---- detail drawer ----

    function DetailDrawer({ id, onClose, t, lang, runtime, onInstalled, onNotice, onManualInstall }) {
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState(null)
      const [install, setInstall] = useState({ busy: false, message: null, error: null })
      useEffect(() => {
        let alive = true
        setDetail(null)
        setError(null)
        request({ op: 'detail', id })
          .then((body) => { if (alive) setDetail(body.row) })
          .catch((cause) => { if (alive) setError(cause.message || String(cause)) })
        return () => { alive = false }
      }, [id])

      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const row = detail
      // 与 Host 的 installSpecFor 用同一套判断：有 npm 包名，或 GitHub 仓库（含 #path: 子目录）。
      // 判断不一致会出现「按钮亮着但点了报 400」，所以在两边对齐。
      const canInstall = canInstallRow(row)
      const runInstall = async (approvedBuilds) => {
        if (!row || install.busy) return
        setInstall({ busy: true, message: null, error: null, pendingBuilds: [] })
        try {
          const body = await request({
            op: 'install',
            key: rowKeyOf(row),
            target: installTargetForRow(row),
            approvedBuilds: Array.isArray(approvedBuilds) ? approvedBuilds : undefined,
          })
          const name = body?.result?.name
          const version = body?.result?.version
          const shown = name ? String(name) + (version ? '@' + String(version) : '') : String(body?.spec || '')
          setInstall({ busy: false, message: (lang === 'zh' ? '已安装 ' : 'Installed ') + shown, error: null, pendingBuilds: [] })
          setDetail((previous) => (previous ? { ...previous, installed: true } : previous))
          // 抽屉可能被立刻关掉，所以结果同时喂给列表层的回执，关掉也能看见装了哪个目标。
          if (typeof onNotice === 'function') {
            onNotice({
              tone: 'success',
              title: t('installSucceeded'),
              subtitle: shown || null,
              detail: null,
              spec: (body && body.spec) || null,
              hint: body && body.fellBackFrom ? t('installFallback') : null,
              retry: false,
              row: null,
            })
          }
          if (typeof onInstalled === 'function') await onInstalled()
        } catch (cause) {
          setInstall({
            busy: false,
            message: null,
            error: cause.message || String(cause),
            pendingBuilds: Array.isArray(cause.pendingBuilds) ? cause.pendingBuilds : [],
          })
          if (typeof onNotice === 'function') onNotice({ ...noticeFromInstallError(cause, t, lang), row: null })
        }
      }
      /**
       * 抽屉里的「更新到 x.y.z」。
       *
       * 和列表里那颗更新按钮同一个 op：upgrade 要精确版本，Host 会拒绝降级与
       * 本地/link 包，所以这里只把 update.to 原样送过去，不猜 target。
       */
      const runUpgrade = async () => {
        if (!row || install.busy) return
        const pkg = String(row.pkg || '')
        const to = row.update?.available ? String(row.update.to || '') : ''
        if (!pkg || !to) return
        setInstall({ busy: true, message: null, error: null, pendingBuilds: [] })
        try {
          const body = await request({ op: 'upgrade', pkg, version: to })
          setInstall({ busy: false, message: t('upgradeSucceeded') + ' · ' + pkg + ' → ' + to, error: null, pendingBuilds: [] })
          setDetail((previous) => (previous
            ? { ...previous, installed: true, installedVersion: to, update: null, versionDiff: null }
            : previous))
          if (typeof onNotice === 'function') {
            onNotice({
              tone: 'success',
              title: t('upgradeSucceeded'),
              subtitle: pkg,
              detail: to,
              spec: (body && body.spec) || null,
              hint: null,
              retry: false,
              row: null,
            })
          }
          if (typeof onInstalled === 'function') await onInstalled()
        } catch (cause) {
          setInstall({
            busy: false,
            message: null,
            error: cause.message || String(cause),
            pendingBuilds: Array.isArray(cause.pendingBuilds) ? cause.pendingBuilds : [],
          })
          if (typeof onNotice === 'function') onNotice({ ...noticeFromInstallError(cause, t, lang), row: null })
        }
      }
      const compat = row?.compatFull
      const requirements = compat?.requirements && typeof compat.requirements === 'object' ? Object.entries(compat.requirements) : []
      const runtimeVersion = runtime?.runtimeVersion || '—'
      const versionDiff = row?.versionDiff || null
      const update = row?.update || null
      const updateSource = update ? (update.source === 'pluginManager' ? t('updateSourceOfficial') : t('updateSourceNpm')) : '—'
      const diffFrom = versionDiff?.from || update?.from || row?.installedVersion || null
      const diffTo = versionDiff?.to || update?.to || null
      const versionSection = row && (versionDiff || update)
        ? h('div', { style: style.section },
            h('h3', { style: style.sectionTitle }, t('versionDiff')),
            h('div', { style: style.kv },
              h('span', { style: style.keyText }, t('installed')),
              h('span', { style: { fontFamily: MONO } }, diffFrom || t('noData')),
              h('span', { style: style.keyText }, t('updateAvailable')),
              h('span', { style: { fontFamily: MONO, color: update?.available ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)' } },
                diffTo || (update ? t('updateNone') : t('noData'))),
              h('span', { style: style.keyText }, t('updateSource')),
              h('span', null, updateSource),
              h('span', { style: style.keyText }, t('lastChecked')),
              h('span', null, update?.checkedAt ? datePart(update.checkedAt) : t('noData')),
            ),
            versionDiff && Array.isArray(versionDiff.versions) && versionDiff.versions.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 } },
                  h('div', { style: { ...style.muted, fontWeight: 600 } }, t('versionChain') + ' · ' + formatNumber(versionDiff.total)),
                  ...versionDiff.versions.map((item) =>
                    h('div', { key: item.version, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.8, padding: '3px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                      h('span', { style: { fontFamily: MONO } }, item.version),
                      item.breaking ? h(Badge, { color: 'var(--dsw-alias-state-error-primary)' }, t('breaking')) : null,
                      item.prerelease ? h(Badge, { color: 'var(--dsw-alias-state-warn-primary)' }, 'pre') : null,
                      h('span', { style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-secondary)' } }, item.publishedAt ? datePart(item.publishedAt) : '—'),
                    ),
                  ),
                )
              : h('div', { style: { ...style.muted, marginTop: 4 } },
                  versionDiff && versionDiff.error ? t('networkError') : t('versionChainEmpty')),
            h('div', { style: { ...style.muted, marginTop: 4 } }, t('versionDiffNote')),
            row.pkg && update?.available
              ? h('div', { style: { marginTop: 6 } },
                  h('div', { style: { ...style.muted, marginBottom: 3 } }, t('upgradeCommand')),
                  h('div', { style: style.code }, 'dsh plugin add ' + row.pkg + '@' + update.to),
                )
              : null,
          )
        : null

      return h(
        React.Fragment,
        null,
        h('div', { style: style.drawerBackdrop, onClick: onClose }),
        h(
          'aside',
          { style: style.drawer, role: 'dialog', 'aria-label': t('detail') },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
            h('div', { style: { minWidth: 0 } },
              h('h2', { style: { margin: 0, fontSize: 18, lineHeight: 1.35 } }, row ? row.title || row.name : t('loading')),
              h('div', { style: { ...style.muted, fontFamily: MONO, marginTop: 3, overflowWrap: 'anywhere' } }, row?.pkg || row?.repo || id),
            ),
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onClose }, t('close')),
          ),
          error ? h('div', { style: { ...style.errorBox, marginTop: 14 } }, error) : null,
          !row && !error ? h('div', { style: { ...style.muted, marginTop: 18 } }, t('loading')) : null,
          row
            ? h(
                React.Fragment,
                null,
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
                  ...(row.sources || []).map((source) => h(Badge, { key: source, color: sourceColor(source), title: sourceLongLabel(source) }, sourceLabel(source))),
                  row.featured ? h(Badge, { color: 'var(--dsw-alias-state-warn-primary)' }, t('featured')) : null,
                  row.installed ? h(Badge, { color: 'var(--dsw-alias-state-success-primary)' }, t('yes')) : null,
                ),
                h(ClampText, { text: row.desc || t('noDescription'), lines: 4, t }),
                h('div', { style: style.section },
                  h('h3', { style: style.sectionTitle }, t('detail')),
                  h('div', { style: style.kv },
                    h('span', { style: style.keyText }, t('source')),
                    h('span', null, (row.sources || []).map((source) => sourceLongLabel(source)).join(' + ') || '—'),
                    h('span', { style: style.keyText }, t('category')),
                    h('span', null, categoryText(row.category, lang)),
                    h('span', { style: style.keyText }, t('version')),
                    h('span', { style: { fontFamily: MONO } }, row.version || t('noData')),
                    h('span', { style: style.keyText }, t('updated')),
                    h('span', null, row.updatedAt ? datePart(row.updatedAt) + ' · ' + relativeDays(row.updatedAt, lang) : t('noData')),
                    h('span', { style: style.keyText }, t('author')),
                    h('span', null, row.author || t('noData')),
                    h('span', { style: style.keyText }, t('installed')),
                    h('span', null, row.installed ? t('yes') + (row.installedVersion ? ' · ' + row.installedVersion : '') : t('no')),
                  ),
                ),
                h('div', { style: style.section },
                  h('h3', { style: style.sectionTitle }, t('compat')),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { ...style.badge(COMPAT_COLORS[compat?.status] || COMPAT_COLORS.unknown, true), fontSize: 12, padding: '3px 9px' } }, compatLabel(compat?.status || row.compat?.status, t)),
                    h('span', { style: style.muted }, t('runtime') + ': ' + runtimeVersion + (runtime?.appVersion ? ' · DSH ' + runtime.appVersion : '')),
                  ),
                  compat?.version ? h('div', { style: style.muted }, 'npm latest: ' + compat.version + (compat.checkedAt ? ' · ' + t('lastChecked') + ' ' + datePart(new Date(compat.checkedAt).toISOString()) : '')) : null,
                  row.enginesDsh ? h('div', { style: { ...style.muted, fontFamily: MONO } }, 'engines.dsh: ' + row.enginesDsh) : null,
                  requirements.length
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
                        h('div', { style: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, t('requirements')),
                        h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 0.6fr', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 } },
                          h('span', null, t('requirementKey')), h('span', null, t('requirementRange')), h('span', null, t('requirementResult')),
                        ),
                        ...requirements.map(([requirement, range]) =>
                          h('div', { key: requirement, style: { display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 0.6fr', gap: 6, fontSize: 11.8, padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                            h('span', { style: { fontFamily: MONO, overflowWrap: 'anywhere' } }, requirement),
                            h('span', { style: { fontFamily: MONO, overflowWrap: 'anywhere' } }, range),
                            h('span', { style: { color: (compat?.unmet || []).includes(requirement) ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, (compat?.unmet || []).includes(requirement) ? t('unmet') : '✓'),
                          ),
                        ),
                      )
                    : h('div', { style: style.muted }, compat?.reason === 'no-dsh-requirement' ? t('notDeclared') : compat?.status === 'no-package' ? t('noPackage') : t('compatNote')),
                  h('div', { style: { ...style.muted, marginTop: 2 } }, t('compatNote')),
                  compat?.status === 'bad' ? h('div', { style: { ...style.errorBox, marginTop: 2 } }, t('incompatibleWarning')) : null,
                ),
                versionSection,
                row.security || row.verification || (row.riskFlags && row.riskFlags.length) || row.license
                  ? h('div', { style: style.section },
                      h('h3', { style: style.sectionTitle }, t('security')),
                      h('div', { style: style.kv },
                        h('span', { style: style.keyText }, t('risk')),
                        h('span', null, row.security?.riskLevel
                          ? (row.security.riskLevel === 'low' ? t('riskLow') : row.security.riskLevel === 'medium' ? t('riskMedium') : t('riskHigh'))
                          : h(NoData, { note: t('noSecurityData') })),
                        h('span', { style: style.keyText }, t('installCheck')),
                        h('span', null, row.verification?.installCheck
                          ? row.verification.installCheck
                          : h(NoData, { note: t('noSecurityData') })),
                        h('span', { style: style.keyText }, t('license')),
                        h('span', null, row.license || h(NoData, { note: t('noData') })),
                        h('span', { style: style.keyText }, t('riskFlags')),
                        h('span', { style: { overflowWrap: 'anywhere' } }, row.riskFlags?.length ? row.riskFlags.join(' · ') : h(NoData, { note: t('noSecurityData') })),
                      ),
                    )
                  : null,
                h('div', { style: style.section },
                  h('h3', { style: style.sectionTitle }, t('scoreBreakdown')),
                  h('div', { style: style.kv },
                    h('span', { style: style.keyText }, t('usersDefinition')),
                    h('span', { title: t('userCountNote') }, row.installers == null ? h(NoData, { note: t('noUserDataNote') }) : formatNumber(row.installers) + ' · ' + t('installs') + ' ' + (row.installs == null ? '—' : formatNumber(row.installs))),
                    h('span', { style: style.keyText }, t('ratingDefinition')),
                    h('span', { title: t('ratingNote') }, Number.isFinite(row.score) ? row.score + ' / 100' : h(NoData, { note: t('noRatingDataNote') })),
                    h('span', { style: style.keyText }, t('marketDefinition')),
                    h('span', null, Number.isFinite(row.marketScore) ? row.marketScore + ' / 100' : h(NoData, { note: t('marketNote') })),
                    h('span', { style: style.keyText }, t('communityDefinition')),
                    h('span', null, Number.isFinite(row.communityScore) ? row.communityScore + ' / 100' : h(NoData, { note: t('communityNote') })),
                    h('span', { style: style.keyText }, t('stars')),
                    h('span', null, row.stars == null ? h(NoData, { note: t('noData') }) : formatNumber(row.stars)),
                    h('span', { style: style.keyText }, t('downloads')),
                    h('span', null, row.downloads == null ? h(NoData, { note: t('noData') }) : formatNumber(row.downloads)),
                    h('span', { style: style.keyText }, t('failures')),
                    h('span', null, row.failures == null ? h(NoData, { note: t('noData') }) : formatNumber(row.failures)),
                    h('span', { style: style.keyText }, t('forks')),
                    h('span', null, row.forks == null ? h(NoData, { note: t('noData') }) : formatNumber(row.forks)),
                  ),
                  h('div', { style: { ...style.muted, marginTop: 2 } }, t('marketNote')),
                ),
                h('div', { style: style.section },
                  h('h3', { style: style.sectionTitle }, t('installCommand')),
                  h('div', { style: style.code }, row.installCommand || '—'),
                  h('div', { style: { display: 'flex', gap: 7, marginTop: 2, flexWrap: 'wrap' } },
                    // 一键安装走官方 pluginManager.installBundle；算不出安装目标的条目
                    // 给「去官方插件页安装」，那里能装同一份索引里的东西。
                    // 已装且有新版：先给一颗「更新到 x.y.z」，和已安装页同一条路径；
                    // 其余情况给「安装到当前配置」/「手动安装」。
                    update?.available && row.installed
                      ? h('button', {
                          type: 'button',
                          style: buttonStyle(true, install.busy, false),
                          disabled: install.busy,
                          title: t('upgradeTo') + ' ' + update.to,
                          onClick: () => void runUpgrade(),
                        }, install.busy ? t('actUpgrading') : t('installedUpdateAction') + ' ↑ ' + String(update.to || ''))
                      : canInstall
                      ? h('button', {
                          type: 'button',
                          style: buttonStyle(true, install.busy, false),
                          disabled: install.busy,
                          onClick: () => void runInstall(),
                        }, install.busy ? (lang === 'zh' ? '安装中…' : 'Installing…') : (lang === 'zh' ? '安装到当前配置' : 'Install'))
                      : h('button', {
                          type: 'button',
                          style: buttonStyle(true, false, false),
                          onClick: () => {
                            if (typeof onManualInstall !== 'function') return
                            onManualInstall({
                              spec: installTargetForRow(row) || '',
                              keyword: row.pkg || row.name || row.title || '',
                              command: row.installCommand || '',
                            })
                          },
                        }, t('installManual')),
                    h(CopyButton, { text: row.installCommand || '', label: t('copyCommand'), copiedLabel: t('copied') }),
                    row.repo ? h('a', { href: row.repo, target: '_blank', rel: 'noreferrer', style: { ...buttonStyle(false, false, true), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, t('openRepo')) : null,
                    row.homepage ? h('a', { href: row.homepage, target: '_blank', rel: 'noreferrer', style: { ...buttonStyle(false, false, true), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, t('openHomepage')) : null,
                  ),
                  install.error
                    ? h('div', { style: { ...style.errorBox, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        h('span', { style: { flex: '1 1 220px' } }, install.error),
                        install.pendingBuilds?.length
                          ? h('button', {
                              type: 'button',
                              style: buttonStyle(true, install.busy, true),
                              disabled: install.busy,
                              onClick: () => void runInstall(install.pendingBuilds),
                            }, lang === 'zh' ? '允许构建并重试' : 'Allow builds & retry')
                          : null,
                      )
                    : install.message
                      ? h('div', { style: { ...style.muted, marginTop: 6, color: 'var(--dsw-alias-state-success-primary)' } }, install.message)
                      : null,
                ),
                h('div', { style: style.section },
                  h('h3', { style: style.sectionTitle }, t('sourceSnapshot')),
                  h('div', { style: style.kv },
                    ...(row.sources || []).flatMap((source) => [
                      h('span', { key: source + '-name', style: style.keyText }, sourceLongLabel(source)),
                      h('span', { key: source + '-id', style: { fontFamily: MONO, overflowWrap: 'anywhere' } }, row.sourceIds?.[source] || '—'),
                    ]),
                    h('span', { style: style.keyText }, 'pushedAt'),
                    h('span', null, row.pushedAt ? datePart(row.pushedAt) : '—'),
                    h('span', { style: style.keyText }, 'publishedAt'),
                    h('span', null, row.publishedAt ? datePart(row.publishedAt) : '—'),
                  ),
                  h('div', { style: { ...style.muted, marginTop: 2 } }, t('dataFrom') + ': ' + (row.sources || []).map(sourceLongLabel).join(' · ') + ' · npm registry'),
                ),
              )
            : null,
        ),
      )
    }

    // ---- sources page ----

    function SourceCard({ source, t, lang }) {
      const score = (value) => (Number.isFinite(value) ? value + ' / 100' : t('noData'))
      return h(
        'section',
        { style: style.sourceCard },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 } },
          h('div', null,
            h('div', { style: { fontSize: 15, fontWeight: 650 } }, source.name),
            h('div', { style: { ...style.muted, marginTop: 2 } }, source.role),
          ),
          source.partnership ? h('span', { style: style.badge('var(--dsw-alias-brand-primary)', true) }, lang === 'zh' ? '官方内置合作源' : 'Built-in partner') : null,
        ),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 2 } },
          h('div', { style: style.scoreRow }, h('span', { style: style.keyText }, t('marketReputation')), h('strong', { style: { color: scoreTone(source.marketScore) } }, score(source.marketScore))),
          h('div', { style: style.scoreRow }, h('span', { style: style.keyText }, t('communityReputation')), h('strong', { style: { color: scoreTone(source.communityScore) } }, score(source.communityScore))),
        ),
        h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
          ...Object.entries(source.fields || {}).map(([key, value]) =>
            h('span', { key, style: style.badge(value ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)', Boolean(value)) }, key + ': ' + (value === true ? '✓' : value === false ? '✗' : value)),
          ),
        ),
        h('div', null,
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 3 } }, t('evidenceMarket')),
          h('ul', { style: style.bulletList }, ...(source.marketEvidence || []).map((line, index) => h('li', { key: index }, line))),
        ),
        h('div', null,
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 3 } }, t('evidenceCommunity')),
          h('ul', { style: style.bulletList }, ...(source.communityEvidence || []).map((line, index) => h('li', { key: index }, line))),
        ),
        h('div', null,
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 3 } }, t('caveats')),
          h('ul', { style: style.bulletList }, ...(source.caveats || []).map((line, index) => h('li', { key: index }, line))),
        ),
        h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 2 } },
          ...(source.links || []).map((link) => h('a', { key: link.url, href: link.url, target: '_blank', rel: 'noreferrer', style: { ...buttonStyle(false, false, true), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, link.label)),
        ),
      )
    }

    function SourcesPage({ status, t, lang, onStatus, onSync, onCleared }) {
      const dossier = status?.sources
      const [radarUrl, setRadarUrl] = useState('')
      const [radarBusy, setRadarBusy] = useState(false)
      const [radarError, setRadarError] = useState(null)
      const [radarMessage, setRadarMessage] = useState(null)
      const radarSources = status?.sourceConfig?.sources || []
      const radarHealth = new Map((status?.sourceHealth || []).map((entry) => [entry.id, entry]))
      const [official, setOfficial] = useState({ loading: false, error: null, sources: [], builtIns: [] })
      const [officialBusy, setOfficialBusy] = useState(null)
      const [officialError, setOfficialError] = useState(null)
      const [confirmId, setConfirmId] = useState(null)
      const [customUrl, setCustomUrl] = useState('')
      const [clearArmed, setClearArmed] = useState(false)

      const loadOfficial = useCallback(async () => {
        setOfficial((previous) => ({ ...previous, loading: true, error: null }))
        try {
          const response = await fetch('/api/community-market/state')
          // 该端点是可选能力（由官方 community-market 插件提供）。没有它时
          // 返回的是 404 或宿主首页 HTML，直接 .json() 会抛错并让整个来源页崩掉。
          // 因此这里把「非 200 / 非 JSON」当作「能力不可用」处理，降级而不是崩溃。
          if (!response.ok) {
            setOfficial({ loading: false, error: null, available: false, sources: [], builtIns: [] })
            return
          }
          const contentType = String(response.headers.get('content-type') || '')
          if (!contentType.includes('json')) {
            setOfficial({ loading: false, error: null, available: false, sources: [], builtIns: [] })
            return
          }
          const body = await response.json()
          setOfficial({
            loading: false,
            error: null,
            available: true,
            sources: Array.isArray(body.sources) ? body.sources : [],
            builtIns: Array.isArray(body.builtIns) ? body.builtIns : [],
          })
        } catch (cause) {
          setOfficial((previous) => ({
            loading: false,
            available: previous.available === true,
            error: null,
            sources: previous.sources || [],
            builtIns: previous.builtIns || [],
          }))
        }
      }, [])

      useEffect(() => { void loadOfficial() }, [loadOfficial])

      const builtInFor = (key) => (official.builtIns || []).find((entry) => entry.key === key)
      const sourceFor = (key) => (official.sources || []).find((entry) => entry.builtInProviderKey === key)

      const officialAction = async (action, payload) => {
        setOfficialError(null)
        setOfficialBusy(action + ':' + (payload.key || payload.sourceRecordId || ''))
        try {
          const response = await fetch('/api/community-market/sources', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(body?.error || 'HTTP ' + response.status)
          await loadOfficial()
          setConfirmId(null)
        } catch (cause) {
          const text = cause.message || String(cause)
          if (text.includes('already added')) {
            await loadOfficial()
            setConfirmId(null)
          } else {
            setOfficialError(text)
          }
        } finally {
          setOfficialBusy(null)
        }
      }

      const addBuiltin = (key) => officialAction('add', { action: 'add-builtin', key })
      const selectSource = (sourceRecordId) => {
        if (confirmId !== sourceRecordId) {
          setConfirmId(sourceRecordId)
          return
        }
        void officialAction('select', { action: 'select', sourceRecordId })
      }
      const addStandard = () => {
        const value = asText(customUrl).trim()
        if (!/^https:\/\/[^\s]+$/u.test(value)) {
          setOfficialError(lang === 'zh' ? '请输入 HTTPS manifest URL。' : 'Enter an HTTPS manifest URL.')
          return
        }
        void officialAction('add-standard', { action: 'add-standard', manifestUrl: value })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('section', { style: style.card },
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, t('sourcesTitle')),
          h('p', { style: { ...style.muted, margin: '6px 0 0', lineHeight: 1.65 } }, t('sourcesIntro')),
          dossier
            ? h('div', { style: { ...style.kv, marginTop: 10, gridTemplateColumns: '120px minmax(0, 1fr)' } },
                h('span', { style: style.keyText }, t('evaluatedAt') || 'evaluatedAt'),
                h('span', null, dossier.evaluatedAt || '—'),
                h('span', { style: style.keyText }, t('methodology')),
                h('span', null, dossier.method?.[lang === 'zh' ? 'zh' : 'en'] || '—'),
              )
            : null,
        ),
        h('section', { style: style.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
            h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, t('pluginSources')),
            h('button', {
              type: 'button',
              style: buttonStyle(false, Boolean(status?.sync?.running), true),
              disabled: Boolean(status?.sync?.running),
              onClick: () => { void onSync?.({ force: false }) },
            }, status?.sync?.running ? t('syncing') : t('refreshAll')),
          ),
          h('p', { style: { ...style.muted, margin: '6px 0 8px', lineHeight: 1.6 } },
            lang === 'zh'
              ? '这里控制雷达实际同步哪些市场。停用一个源后，它的条目仍保留到下次刷新；添加来源不会安装任何插件。'
              : 'Controls which marketplaces the radar actually syncs. Disabling a source keeps old rows until the next refresh; adding a source never installs anything.'),
          h('div', { style: { marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, t('addStandardSource')),
            h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
              h('input', { style: { ...style.search, flex: '1 1 320px', minWidth: 0, fontFamily: MONO, fontSize: 12 }, value: radarUrl, placeholder: t('standardUrlPlaceholder'), onChange: (event) => setRadarUrl(event.target.value) }),
              h('button', {
                type: 'button',
                style: buttonStyle(true, radarBusy || !asText(radarUrl).trim(), true),
                disabled: radarBusy || !asText(radarUrl).trim(),
                onClick: async () => {
                  setRadarBusy(true)
                  setRadarError(null)
                  setRadarMessage(null)
                  try {
                    const body = await request({ op: 'sources.add', url: asText(radarUrl).trim() })
                    setRadarUrl('')
                    await onStatus?.()
                    setRadarMessage(t('sourceAdded') + (body.source?.name ? ' · ' + body.source.name : ''))
                  } catch (cause) {
                    setRadarError(cause.message || String(cause))
                  } finally {
                    setRadarBusy(false)
                  }
                },
              }, radarBusy ? t('loading') : t('add')),
            ),
            h('div', { style: { ...style.muted, fontSize: 11.5 } },
              lang === 'zh'
                ? '支持 format 1 索引（如 dsh.so market/index.json）或 catalog-source manifest；HTTPS、443、无凭据。'
                : 'Accepts a format 1 index (e.g. dsh.so market/index.json) or a catalog-source manifest; HTTPS, port 443, no credentials.'),
            radarMessage ? h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' } }, radarMessage) : null,
            radarError ? h('div', { style: style.errorBox }, radarError) : null,
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            ...radarSources.map((source) => {
              const health = radarHealth.get(source.id) || {}
              const progress = health.progress || {}
              return h('div', { key: source.id, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 } },
                h('span', { style: { ...style.badge(sourceColor(source.id), true) } }, sourceLabel(source.id)),
                h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
                  h('div', { style: { fontSize: 13, fontWeight: 600 } }, source.name),
                  h('div', { style: { ...style.muted, fontSize: 11 } }, sourceKindLabel(source.kind, t) + ' · ' + (health.rows || 0).toLocaleString('en-US') + ' ' + t('sourceRows')),
                ),
                progress.error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, progress.error) : null,
                health.lastSuccessAt || health.failureCount || health.lastError
                  ? h('span', { style: { ...style.muted, fontSize: 11 }, title: health.lastError || '' },
                      ((health.lastSuccessAt ? (lang === 'zh' ? '上次成功 ' : 'last ok ') + relativeDays(health.lastSuccessAt, lang) : (lang === 'zh' ? '从未成功' : 'never ok')) +
                       (health.failureCount ? ' · ' + (lang === 'zh' ? '连续失败 ' : 'failed ') + health.failureCount + (lang === 'zh' ? ' 次' : 'x') : '')))
                  : null,
                h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 } },
                  h('input', {
                    type: 'checkbox',
                    checked: source.enabled !== false,
                    disabled: radarBusy,
                    onChange: async () => {
                      setRadarBusy(true)
                      setRadarError(null)
                      try {
                        await request({ op: 'sources.toggle', id: source.id, enabled: source.enabled === false })
                        await onStatus?.()
                      } catch (cause) {
                        setRadarError(cause.message || String(cause))
                      } finally {
                        setRadarBusy(false)
                      }
                    },
                  }),
                  t('sourceEnabled'),
                ),
                !source.builtin ? h('button', {
                  type: 'button',
                  style: buttonStyle(false, radarBusy, true),
                  disabled: radarBusy,
                  onClick: async () => {
                    setRadarBusy(true)
                    setRadarError(null)
                    try {
                      await request({ op: 'sources.remove', id: source.id })
                      await onStatus?.()
                    } catch (cause) {
                      setRadarError(cause.message || String(cause))
                    } finally {
                      setRadarBusy(false)
                    }
                  },
                }, t('removeSource')) : null,
              )
            }),
          ),
        ),
        dossier ? h('div', { style: style.sourceGrid }, ...(dossier.sources || []).map((source) => h(SourceCard, { key: source.key, source, t, lang }))) : null,
        h('section', { style: style.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
            h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, t('officialStatus')),
            h('button', { type: 'button', style: buttonStyle(false, official.loading, true), onClick: () => void loadOfficial(), disabled: official.loading }, t('refreshOfficial')),
          ),
          h('p', { style: { ...style.muted, margin: '6px 0 8px', lineHeight: 1.6 } }, t('officialIntro')),
          official.error
            ? h('div', { style: style.errorBox }, t('officialUnavailable') + ' · ' + official.error)
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
                official.available === false
                  ? h('div', { style: { ...style.muted, fontSize: 11.5, lineHeight: 1.6 } },
                      lang === 'zh'
                        ? '官方 community-market 接口未挂载：本节只读状态不可用，下面的来源启用/添加仍可正常操作。'
                        : 'The official community-market endpoint is not mounted: this read-only status section is unavailable, while enabling and adding sources below still works.')
                  : null,
                ...(dossier?.sources || []).filter((source) => source.key === '1024store' || source.key === 'dshfind').map((source) => {
                  const record = sourceFor(source.key)
                  const builtIn = builtInFor(source.key)
                  const active = Boolean(record?.enabled)
                  return h(
                    'div',
                    { key: source.key, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 } },
                    h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
                      h('div', { style: { fontSize: 13, fontWeight: 600 } }, source.name),
                      h('div', { style: { ...style.muted, fontFamily: MONO, fontSize: 10.5, overflowWrap: 'anywhere' } }, source.endpoint),
                    ),
                    record
                      ? h('span', { style: style.badge(active ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)', active) }, active ? t('officialActive') : t('addedDisabled'))
                      : h('span', { style: style.badge('var(--dsw-alias-label-secondary)', false) }, lang === 'zh' ? '未添加' : 'Not added'),
                    record
                      ? (active ? null : h('button', { type: 'button', style: buttonStyle(false, Boolean(officialBusy), true), disabled: Boolean(officialBusy), onClick: () => selectSource(record.sourceRecordId) }, confirmId === record.sourceRecordId ? t('confirmSwitch') : t('makeOfficialActive')))
                      : (builtIn ? h('button', { type: 'button', style: buttonStyle(true, Boolean(officialBusy), true), disabled: Boolean(officialBusy), onClick: () => void addBuiltin(source.key) }, officialBusy === 'add:' + source.key ? t('loading') : t('addToOfficial')) : null),
                  )
                }),
              ),
          officialError ? h('div', { style: { ...style.errorBox, marginTop: 8 } }, officialError) : null,
          h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, t('customSource')),
            h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
              h('input', { style: { ...style.search, flex: '1 1 320px', minWidth: 0, fontFamily: MONO, fontSize: 12 }, value: customUrl, placeholder: t('customSourcePlaceholder'), onChange: (event) => setCustomUrl(event.target.value) }),
              h('button', { type: 'button', style: buttonStyle(false, Boolean(officialBusy) || !asText(customUrl).trim(), true), disabled: Boolean(officialBusy) || !customUrl.trim(), onClick: addStandard }, officialBusy === 'add-standard:' ? t('loading') : t('addCustom')),
            ),
            h('div', { style: { ...style.muted, fontSize: 11.5 } }, t('customHint')),
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 12 } },
            h('button', {
              type: 'button',
              style: buttonStyle(false, Boolean(officialBusy), true),
              onClick: async () => {
                if (!clearArmed) { setClearArmed(true); return }
                try {
                  await request({ op: 'clear' })
                  setClearArmed(false)
                  onCleared?.()
                } catch (cause) {
                  setOfficialError(cause.message || String(cause))
                }
              },
            }, clearArmed ? t('clearCacheConfirm') : t('clearCache')),
          ),
        ),
        dossier?.rejected?.length
          ? h('section', { style: style.card },
              h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, t('rejected')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
                ...dossier.rejected.map((item) =>
                  h('div', { key: item.name, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 } },
                    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' } },
                      h('strong', { style: { fontSize: 13 } }, item.name),
                      h('span', { style: { ...style.muted, fontSize: 11.5 } }, t('marketReputation') + ' ' + item.marketScore + ' · ' + t('communityReputation') + ' ' + item.communityScore),
                    ),
                    h('div', { style: { ...style.muted, marginTop: 3, lineHeight: 1.55 } }, item.reason),
                    item.url ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 11.5, color: 'var(--dsw-alias-brand-primary)' } }, item.url) : null,
                  ),
                ),
              ),
            )
          : null,
        h('section', { style: style.card },
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, t('methodology')),
          h('div', { style: { ...style.kv, marginTop: 8 } },
            h('span', { style: style.keyText }, t('usersDefinition')),
            h('span', null, t('userCountNote')),
            h('span', { style: style.keyText }, t('ratingDefinition')),
            h('span', null, t('ratingNote')),
            h('span', { style: style.keyText }, t('compatDefinition')),
            h('span', null, t('compatNote')),
            h('span', { style: style.keyText }, t('marketDefinition')),
            h('span', null, t('marketNote')),
            h('span', { style: style.keyText }, t('communityDefinition')),
            h('span', null, t('communityNote')),
            h('span', { style: style.keyText }, t('noDataDefinition')),
            h('span', null, t('noUserDataNote') + ' / ' + t('noRatingDataNote')),
          ),
        ),
      )
    }

    // ---- installed / custom install / settings pages ----

    /**
     * 已安装页（插件更新清单）。
     *
     * 数据以 profile 里真实装着的包为准（status.installed.packages）：
     * 目录行只用来补展示名，市场里没有收录的本地包同样会出现，不会出现
     * 「页头写着已安装 12、表里只有 3 行」这种当面打架。
     *
     * 每一行都有真正的动作按钮：
     *   可更新  → 「更新到 x.y.z」直接装到那个版本（走 op:'upgrade'）
     *   已最新  → 只读说明
     *   本地包  → 说明「没有 registry 版本」，不给必然失败的按钮
     */
    function InstalledPage({ status, t, lang, updating, updatesStatus, onCheckUpdates, onUpgrade, actionBusy, onRefresh }) {
      const [filter, setFilter] = useState('')
      const installed = Array.isArray(status?.installed?.packages) ? status.installed.packages : []
      const updatable = installed.filter((item) => item.update && item.update.available)
      const query = String(filter || '').trim().toLowerCase()
      const visible = query
        ? installed.filter((item) => String(item.pkg || '').toLowerCase().includes(query))
        : installed
      const checkRunning = Boolean(updatesStatus?.running || updatesStatus?.queued)

      const th = { textAlign: 'left', padding: '7px 8px', fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)' }
      const td = { padding: '7px 8px', fontSize: 11.5, borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' }
      const kindLabel = (item) => (item.kind === 'local' ? t('installedKindLocal')
        : item.kind === 'github' ? 'github'
          : item.kind === 'url' ? 'url'
            : item.kind === 'archive' ? t('installedKindArchive')
              : item.registry === false ? t('installedKindLocal') : 'npm')
      // 「没有可比的 registry 版本」有三种原因，说法不能混：本地 link、GitHub 仓库、
      // 压缩包。以前一律写「本地安装」，于是从 GitHub 装上来的那几个看起来像自己写的包。
      const noRegistryText = (item) => (item.kind === 'github' || item.kind === 'external'
        ? t('installedNoRegistryGithub')
        : item.kind === 'archive' ? t('installedNoRegistry')
          : t('installedNoRegistry'))
      const hasRegistryVersion = (item) => item.registry !== false && item.kind !== 'local' && item.kind !== 'github' && item.kind !== 'url' && item.kind !== 'archive' && item.kind !== 'external'

      const head = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, t('installedTitle')),
          h('div', { style: { ...style.muted, fontSize: 11.5, marginTop: 2 } }, t('installedIntro'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          status?.installed?.count ? h('span', { style: style.chip }, t('installedCountChip') + ' · ' + formatNumber(status.installed.count)) : null,
          updatable.length
            ? h('span', { style: { ...style.chip, color: 'var(--dsw-alias-state-warn-primary)' } }, t('installedUpdatableChip') + ' · ' + formatNumber(updatable.length))
            : null,
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void onRefresh?.() }, t('installedRefresh')),
          h('button', {
            type: 'button',
            style: buttonStyle(false, updating || checkRunning, true),
            disabled: updating || checkRunning,
            title: updatesStatus?.source === 'pluginManager' ? t('updateSourceOfficial')
              : updatesStatus?.source === 'mixed' ? 'pluginManager + npm'
                : updatesStatus?.source === 'skipped' ? t('installedKindLocal') : t('updateSourceNpm'),
            onClick: () => void onCheckUpdates(),
          }, (updating || checkRunning)
            ? t('installedChecking') + (updatesStatus?.total ? ' ' + formatNumber(updatesStatus.done) + '/' + formatNumber(updatesStatus.total) : '')
            : t('installedCheckUpdates'))),
      )

      if (!installed.length) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          head,
          h('div', { style: { ...style.muted, padding: '22px 4px', lineHeight: 1.7, fontSize: 13 } }, t('installedEmpty')))
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        head,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            style: { ...style.search, flex: '0 1 320px', minWidth: 160, padding: '5px 9px', fontSize: 12 },
            value: filter,
            placeholder: t('installedSearchPlaceholder'),
            onChange: (event) => setFilter(event.target.value),
          }),
          updatesStatus?.finishedAt
            ? h('span', { style: { ...style.muted, fontSize: 11 } }, t('lastChecked') + ' ' + datePart(updatesStatus.finishedAt) + (updatesStatus.error ? ' · ' + updatesStatus.error : ''))
            : null),
        h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
            h('thead', null, h('tr', null,
              h('th', { style: th }, t('installedColName')),
              h('th', { style: th }, t('installedColVersion')),
              h('th', { style: th }, t('installedColSource')),
              h('th', { style: th }, t('installedColLatest')),
              h('th', { style: th }, t('installedColActions')),
            )),
            h('tbody', null, ...visible.map((item) => {
              const key = String(item.pkg || '')
              const update = item.update && item.update.available ? item.update : null
              const local = !hasRegistryVersion(item)
              const upBusy = Boolean(actionBusy) && actionBusy.pkg === key && actionBusy.mode === 'upgrade' && actionBusy.status !== 'error'
              const upFailed = Boolean(actionBusy) && actionBusy.pkg === key && actionBusy.mode === 'upgrade' && actionBusy.status === 'error'
              return h('tr', { key },
                h('td', { style: { ...td, fontFamily: MONO, overflowWrap: 'anywhere' } },
                  h('div', null, item.pkg || '—'),
                  item.title ? h('div', { style: { ...style.muted, fontFamily: 'inherit', fontSize: 10.5 } }, item.title) : null),
                h('td', { style: { ...td, fontFamily: MONO, whiteSpace: 'nowrap' } }, String(item.version || t('installedUnknown'))),
                h('td', { style: { ...td, ...style.muted } }, kindLabel(item)),
                h('td', { style: td },
                  update
                    ? h('span', { style: style.badge(update.kind === 'major' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)', true), title: updateBadgeTitle(update, t) },
                        t('installedHasUpdate') + ' ' + String(update.to || ''))
                    : local
                      ? h('span', { style: { ...style.muted } }, noRegistryText(item))
                      : h('span', { style: { ...style.muted } }, t('installedUpToDate'))),
                // 本地 / 仓库装的包「可更新」这格已经说明了原因，操作列不再重复同一句话，
                // 只留一个不可点的破折号（以前两列各写一遍「本地安装，没有 registry 版本」）。
                h('td', { style: { ...td, ...style.muted, textAlign: 'center' } },
                  local ? '—' : h('button', {
                        type: 'button',
                        title: upFailed ? t('actRetryHint') : (update ? t('upgradeTo') + ' ' + update.to : t('installedUpToDate')),
                        style: buttonStyle(true, (!update && !upFailed) || upBusy, true),
                        disabled: upBusy,
                        onClick: () => { void onUpgrade(item) },
                      }, upBusy
                        ? t('actUpgrading')
                        : upFailed ? t('actRetry')
                          : (update ? t('installedUpdateAction') : t('installedUpToDate')))))
            })))),
        !visible.length && query
          ? h('div', { style: { ...style.muted, padding: '14px 4px', fontSize: 12.5 } }, t('installedNoMatch'))
          : null,
        // 升级失败时给一句人话，而不是只让按钮变红
        actionBusy && actionBusy.status === 'error' && actionBusy.mode === 'upgrade' && actionBusy.pkg
          ? h('div', { style: { ...style.muted, fontSize: 11.5 } },
              t('upgradeFailed') + ' · ' + actionBusy.pkg + ' ' + (actionBusy.suffix || '') + ' · ' + t('actRetryHint'))
          : null,
      )
    }

    /**
     * 自定义安装页：输入一个目标 → 交给宿主解析 → 安装。
     *
     * 这里只把用户原样输入的目标（`pkg`、`pkg@1.2.3`、`github:o/r`、
     * `https://github.com/o/r`）作为 `spec` 发过去，由宿主用同一套白名单解析，
     * 而不是前端自己猜「这是 pkg 还是 repo」——以前猜错的那一半（github: 写法）
     * 会一路走到宿主才发现「没有可安装目标」，但页面文案却写着支持 GitHub 地址。
     */
    function CustomInstallPage({ t, lang, onInstalled }) {
      const [spec, setSpec] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      // 输入框里只可能是字符串，但状态槽在某些运行时/宿主复用下会给回 null，
      // `null.trim()` 会把整个页签炸成白屏，所以统一先折成字符串。
      const specText = String(spec || '')
      const canRun = Boolean(specText.trim()) && !busy

      const run = async () => {
        const target = specText.trim()
        if (!target) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const body = await request({ op: 'install', spec: target })
          setNotice(t('customInstall') + ' ✓ ' + (body?.spec || target))
          if (typeof onInstalled === 'function') await onInstalled()
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, t('customTitle')),
          h('div', { style: { ...style.muted, fontSize: 11.5, marginTop: 2, lineHeight: 1.7 } }, t('customIntro'))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          h('label', { style: { fontSize: 11.5, fontWeight: 600 } }, t('customSpecLabel')),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              style: { ...style.search, flex: '1 1 auto', minWidth: 0, fontFamily: MONO, fontSize: 12 },
              value: specText,
              placeholder: t('customSpecPlaceholder'),
              onChange: (event) => setSpec(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void run() },
            }),
            h('button', {
              type: 'button',
              style: buttonStyle(true, !canRun, true),
              disabled: !canRun,
              onClick: () => void run(),
            }, busy ? t('customInstalling') : t('customInstall')))),
        h('div', { style: { ...style.muted, fontSize: 11, lineHeight: 1.7 } }, t('customVerdictHint')),
        notice ? h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
        error ? h('div', { style: style.errorBox }, error) : null,
      )
    }

    /**
     * 设置页：刷新计划 / 列设置 / 导入导出 / GitHub / 关于。
     * GitHub 区块用 package.json 的 repository 与 bugs 链接；计数走公开 API，
     * 拿不到就只留链接（不伪装成有数据）。
     */
    function SettingsPage({ status, t, lang, onOpenColumns, onOpenSchedule, onExport, onImport, transfer, repoInfo, githubStats }) {
      const card = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }
      const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }
      const repo = repoInfo || {}
      const stats = githubStats || null

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, t('settingsTitle')),
          h('div', { style: { ...style.muted, fontSize: 11.5, marginTop: 2 } }, t('settingsIntro'))),

        h('div', { style: card },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('settingsRefresh')),
          h('div', { style: rowStyle },
            h('span', { style: { ...style.muted, fontSize: 11.5 } }, t('schedule')),
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onOpenSchedule }, t('schedule')))),

        h('div', { style: card },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('settingsColumns')),
          h('div', { style: rowStyle },
            h('span', { style: { ...style.muted, fontSize: 11.5 } }, t('columnSettings')),
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: onOpenColumns }, t('columns')))),

        h('div', { style: card },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('settingsTransfer')),
          h('div', { style: rowStyle },
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void onExport() }, t('exportConfig')),
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void onImport() }, t('importConfig'))),
          transfer
            ? h('div', { style: { ...style.muted, fontSize: 11, color: transfer.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, transfer.text)
            : null),

        h('div', { style: card },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('settingsGithub')),
          repo.owner && repo.name
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: rowStyle },
                  h('span', { style: { ...style.muted, fontSize: 11.5 } }, t('repoLabel')),
                  h('a', {
                    href: repo.url,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    style: { fontFamily: MONO, fontSize: 11.5, color: 'var(--dsw-alias-brand-primary)' },
                  }, 'github.com/' + repo.owner + '/' + repo.name)),
                stats
                  ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('span', { style: style.chip }, t('starLabel') + ' · ' + formatNumber(stats.stars || 0)),
                      h('span', { style: style.chip }, t('forkLabel') + ' · ' + formatNumber(stats.forks || 0)),
                      h('span', { style: style.chip }, t('issueLabel') + ' · ' + formatNumber(stats.openIssues || 0)))
                  : h('div', { style: { ...style.muted, fontSize: 11 } }, t('githubStatsUnavailable')),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('a', { href: repo.url, target: '_blank', rel: 'noopener noreferrer', style: buttonStyle(false, false, true), }, t('repoOnGithub')),
                  repo.issues
                    ? h('a', { href: repo.issues, target: '_blank', rel: 'noopener noreferrer', style: buttonStyle(false, false, true), }, t('reportIssue'))
                    : null))
            : h('div', { style: { ...style.muted, fontSize: 11.5 } }, t('githubStatsUnavailable'))),

        h('div', { style: card },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('settingsAbout')),
          h('div', { style: style.kv },
            h('span', { style: style.keyText }, t('versionLabel')),
            h('span', { style: { fontFamily: MONO } }, String(repo.version || '—')),
            h('span', { style: style.keyText }, t('licenseLabel')),
            h('span', null, String(repo.license || '—')),
            status?.runtime?.runtimeVersion
              ? h('span', { style: style.keyText }, 'DSH')
              : null,
            status?.runtime?.runtimeVersion
              ? h('span', { style: { fontFamily: MONO } }, String(status.runtime.runtimeVersion))
              : null)),
      )
    }

    // ---- logs page ----

    const LOG_LEVELS = ['debug', 'info', 'warn', 'error']
    const LOG_LEVEL_TONE = {
      debug: 'var(--dsw-alias-label-secondary)',
      info: 'var(--dsw-alias-label-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }
    // 一条日志里除了通用字段以外的键，按原样列成 key=value：排查时最需要的
    // 恰恰是 spec / detail / ms 这些具体值，而不是一句概括。
    const LOG_META_KEYS = new Set(['seq', 'at', 'level', 'tag'])
    const LOG_PAGE_SIZE = 120

    function formatLogLine(entry) {
      const extras = Object.entries(entry)
        .filter(([key, value]) => !LOG_META_KEYS.has(key) && value !== null && value !== undefined)
        .map(([key, value]) => key + '=' + (typeof value === 'string' ? value : JSON.stringify(value)))
      const head = (entry.at || '').replace('T', ' ').slice(0, 19)
      return head + ' [' + String(entry.level || 'info').toUpperCase() + '] ' + (entry.tag || '') + (extras.length ? '  ' + extras.join(' ') : '')
    }

    function LogsPage({ t, lang }) {
      const [entries, setEntries] = useState([])
      const [status, setStatus] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [level, setLevel] = useState('')
      const [tag, setTag] = useState('')
      const [query, setQuery] = useState('')
      const [follow, setFollow] = useState(true)
      const [note, setNote] = useState(null)
      // 已拉到的最大 seq：增量拉取靠它，不然每次刷新都要重发整表。
      const sinceRef = useRef(0)
      const tailRef = useRef(null)

      const load = useCallback(async ({ reset = false } = {}) => {
        try {
          const body = await request({
            op: 'logs',
            since: reset ? 0 : sinceRef.current,
            limit: reset ? 500 : 200,
            level: level || undefined,
            tag: tag || undefined,
            query: query || undefined,
          })
          const items = Array.isArray(body.entries) ? body.entries : []
          const maxSeq = items.length ? items[items.length - 1].seq : sinceRef.current
          if (Number.isFinite(maxSeq)) sinceRef.current = Math.max(sinceRef.current, maxSeq)
          setStatus(body.status || null)
          setEntries((previous) => {
            if (reset) return items
            const seen = new Set(previous.map((entry) => entry.seq))
            return [...previous, ...items.filter((entry) => !seen.has(entry.seq))].slice(-500)
          })
          setError(null)
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setLoading(false)
        }
      }, [level, tag, query])

      useEffect(() => {
        // 筛选条件变了就从头发一遍：增量语义只适用于同一组筛选。
        sinceRef.current = 0
        setLoading(true)
        void load({ reset: true })
      }, [level, tag, query, load])

      useEffect(() => {
        if (!follow) return undefined
        const timer = setInterval(() => { void load() }, 4000)
        return () => clearInterval(timer)
      }, [follow, load])

      // 跟随模式下滚到底：新日志出现在最下面，不自动滚就永远看不见。
      useEffect(() => {
        if (!follow || !tailRef.current) return
        try { tailRef.current.scrollTop = tailRef.current.scrollHeight } catch { /* 非真实 DOM 就跳过 */ }
      }, [entries.length, follow])

      const exportLogs = async () => {
        try {
          const body = await request({ op: 'logs.export', since: 0 })
          const blob = new Blob([String(body.text || '')], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = body.filename || ('market-lens-logs-' + new Date().toISOString().slice(0, 10) + '.txt')
          document.body.appendChild(anchor)
          anchor.click()
          document.body.removeChild(anchor)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setNote({ tone: 'ok', text: t('logsExport') + ' ✓' })
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        }
      }

      const copyLogs = async () => {
        const text = entries.map(formatLogLine).join('\n')
        try {
          if (navigator && navigator.clipboard) await navigator.clipboard.writeText(text)
          setNote({ tone: 'ok', text: t('logsCopied') })
        } catch {
          // 没有剪贴板权限时退化成导出文件
          void exportLogs()
        }
      }

      const clearLogs = async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('logsClearConfirm'))) return
        try {
          await request({ op: 'logs.clear' })
          sinceRef.current = 0
          setEntries([])
          setStatus(null)
          await load({ reset: true })
          setNote({ tone: 'ok', text: t('logsClear') + ' ✓' })
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        }
      }

      const shown = entries.slice(-LOG_PAGE_SIZE)
      const counts = status && status.counts ? status.counts : null

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, t('logsTitle')),
          h('div', { style: { ...style.muted, fontSize: 11.5, marginTop: 2, lineHeight: 1.6 } }, t('logsIntro'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('select', {
            style: { ...style.search, flex: 'none', width: 'auto', padding: '4px 7px', fontSize: 12 },
            value: level,
            onChange: (event) => setLevel(event.target.value),
          }, h('option', { value: '' }, t('logsAllLevels')), LOG_LEVELS.map((value) => h('option', { key: value, value }, value))),
          h('input', {
            style: { ...style.search, flex: '0 0 150px' },
            value: tag,
            placeholder: t('logsFilterTag'),
            onChange: (event) => setTag(event.target.value),
          }),
          h('input', {
            style: { ...style.search, flex: '1 1 200px' },
            value: query,
            placeholder: t('logsFilterQuery'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', style: buttonStyle(follow, false, true), onClick: () => setFollow((value) => !value), title: t('logsFollow') }, t('logsFollow') + (follow ? ' ✓' : '')),
          h('button', { type: 'button', style: buttonStyle(false, loading, true), disabled: loading, onClick: () => void load({ reset: true }) }, t('logsRefresh')),
          h('button', { type: 'button', style: buttonStyle(false, !entries.length, true), disabled: !entries.length, onClick: () => void copyLogs() }, t('logsCopy')),
          h('button', { type: 'button', style: buttonStyle(false, !entries.length, true), disabled: !entries.length, onClick: () => void exportLogs() }, t('logsExport')),
          h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void clearLogs() }, t('logsClear'))),
        counts
          ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: style.chip }, 'total · ' + formatNumber(counts.total || 0)),
              LOG_LEVELS.map((value) => (counts[value]
                ? h('span', { key: value, style: { ...style.chip, color: LOG_LEVEL_TONE[value] } }, value + ' · ' + formatNumber(counts[value]))
                : null)),
              status && status.dropped ? h('span', { style: style.chip, title: t('logsDropped') }, 'dropped · ' + formatNumber(status.dropped)) : null)
          : null,
        error ? h('div', { style: style.errorBox }, error) : null,
        note
          ? h('div', { style: { fontSize: 11.5, color: note.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, note.text)
          : null,
        h('div', {
          // 日志区自己滚，不把整页顶长：几百条一起铺开就没法看别的了。
          ref: tailRef,
          className: 'ml-scroll',
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-1)',
            fontFamily: MONO,
            fontSize: 11.5,
            lineHeight: 1.65,
            padding: '8px 10px',
            maxHeight: '58vh',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        },
          shown.length === 0
            ? h('div', { style: { ...style.muted, padding: '18px 4px' } }, loading ? '…' : t('logsEmpty'))
            : shown.map((entry) => h('div', { key: entry.seq, style: { color: LOG_LEVEL_TONE[entry.level] || 'var(--dsw-alias-label-primary)' } }, formatLogLine(entry)))),
      )
    }

    // ---- rules page ----

    const RULE_PRESET_LABEL = (preset, lang) => (preset && preset.name ? (typeof preset.name === 'string' ? preset.name : (preset.name[lang] || preset.name.zh || preset.name.en)) : '')
    const RULE_LOCALIZED = (value, lang) => {
      if (typeof value === 'string') return value
      if (value && typeof value === 'object') return value[lang] || value.zh || value.en || ''
      return ''
    }
    // 来源标签：内置 / 预设 / 自己传的。下拉框里要一眼看出哪些能删。
    const RULE_ORIGIN_LABEL = (origin, t) => (
      origin === 'builtin' ? t('rulesOriginBuiltin')
        : origin === 'preset' ? t('rulesOriginPreset')
          : origin === 'user' ? t('rulesOriginUser')
            : origin || '—'
    )
    const RULE_ORIGIN_COLOR = (origin) => (
      origin === 'builtin' ? 'var(--dsw-alias-brand-primary)'
        : origin === 'preset' ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-label-secondary)'
    )
    const GROUP_LABELS = {
      market: { zh: '市场风评', en: 'Market score' },
      community: { zh: '民间风评', en: 'Community score' },
      heat: { zh: '热度', en: 'Heat' },
    }
    const GROUP_HINT = {
      market: { zh: '表格里「市场风评」列用的就是它，也是主排序参考。', en: 'Drives the Market column and the primary ranking.' },
      community: { zh: '社区活跃度；没有 Star 数的条目这一列显示「无数据」。', en: 'Community traction; rows without stars show no data.' },
      heat: { zh: '默认排序键；某个指标缺值时权重会自动在剩余指标间重新分配。', en: 'Default sort key; missing metrics redistribute weight.' },
    }
    const METRIC_HINTS = {
      rating: { zh: '市场方给的原评分（0–100）', en: 'Rating supplied by the marketplace' },
      users: { zh: '安装人数', en: 'Number of installers' },
      stars: { zh: '仓库 Star 数', en: 'Repository stars' },
      downloads: { zh: '周下载量', en: 'Weekly downloads' },
      forks: { zh: 'Fork 数', en: 'Forks' },
      installs: { zh: '累计安装次数', en: 'Total installs' },
      failures: { zh: '安装失败次数', en: 'Failed installs' },
      freshness: { zh: '最后更新时间距现在的远近', en: 'How recently the plugin was updated' },
      pick: { zh: '是否被市场标为精选', en: 'Whether the marketplace features it' },
      coverage: { zh: '被几个来源同时收录', en: 'How many sources list it' },
      sources: { zh: '收录来源的数量', en: 'Number of listing sources' },
      enginesDsh: { zh: '声明要求的最低 DSH 版本', en: 'Declared minimum DSH version' },
    }
    const NORM_HINTS = {
      fixed: { zh: '命中就给高分，不命中给低分', en: 'High score when matched, low otherwise' },
      coverage: { zh: '来源数达到门槛给高分，否则给低分', en: 'High when source count reaches the threshold' },
      pick: { zh: '精选给高分，否则给低分', en: 'High when featured' },
      freshness: { zh: '按 7 / 30 / 90 / 180 / 365 天分档', en: 'Buckets at 7 / 30 / 90 / 180 / 365 days' },
      log: { zh: '对数压缩：抑制头部极值，小数值也能拉开差距', en: 'Log scale: tames outliers' },
      quantile: { zh: '按本次目录内的排名给分', en: 'Rank within the current catalog' },
      linear: { zh: '线性映射：小于 from 记 0，大于 to 记 100', en: 'Linear map from a floor to a ceiling' },
      percent: { zh: '百分比：原值除以满分再乘 100', en: 'Value as a percentage of a maximum' },
      power: { zh: '幂函数：指数越大，越偏向头部', en: 'Power curve: higher exponents favour leaders' },
      raw: { zh: '原值直接截断到 0–100', en: 'Raw value clamped to 0–100' },
    }

    /**
     * 把一条规则渲染成「人能读」的卡片：每组分数一栏，因子一行一个，
     * 显示 指标 → 归一化方式 → 权重占比。用户不需要看 JSON 就懂它在算什么。
     */
    function RuleDigest({ description, lang, t }) {
      if (!description || !description.groups) return null
      const contributions = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        ['market', 'community', 'heat'].map((name) => {
          const group = description.groups[name]
          const label = RULE_LOCALIZED(GROUP_LABELS[name], lang)
          const hint = RULE_LOCALIZED(GROUP_HINT[name], lang)
          const factors = group.factors || []
          return h('div', { key: name, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, label),
              h('span', { style: { ...style.muted, fontSize: 11 } }, hint),
              // 这一组根本没参与打分时要说清楚，否则用户以为配了没用
              factors.length === 0 ? h('span', { style: { ...style.chip, color: 'var(--dsw-alias-state-warn-primary)' } }, t('rulesGroupInactive')) : null),
            factors.length === 0
              ? null
              : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                  factors.map((factor) => h('span', {
                    key: factor.key,
                    style: { ...style.chip, fontFamily: MONO, fontSize: 11 },
                    title: RULE_LOCALIZED(METRIC_HINTS[factor.metric], lang) + ' · ' + RULE_LOCALIZED(NORM_HINTS[factor.norm], lang),
                  },
                    RULE_LOCALIZED({ zh: factor.metricLabel, en: factor.metricLabel }, lang) || factor.metric,
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, ' · ' + (RULE_LOCALIZED(NORM_HINTS[factor.norm], lang) || factor.norm)),
                    h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, ' · ' + String(factor.share) + '%')))),
            group.when
              ? h('div', { style: { ...style.muted, fontSize: 10.5 } }, t('rulesWhenNote') + '：' + (RULE_LOCALIZED(METRIC_HINTS[group.when], lang) || group.when))
              : null,
            group.fallback && group.fallback.length
              ? h('div', { style: { ...style.muted, fontSize: 10.5 } },
                  t('rulesFallbackNote') + '：' + group.fallback.map((factor) => (RULE_LOCALIZED(METRIC_HINTS[factor.metric], lang) || factor.metric)).join(' · '))
              : null)
        }))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, t('rulesComposition')),
          h('span', { style: style.chip }, t('rulesLabels') + ' · ' + description.labels.excellent + ' / ' + description.labels.good + ' / ' + description.labels.fair)),
        contributions)
    }

    /** 模版说明表：指标一张、归一化一张。用户照着这两张表就能写规则。 */
    function TemplateGuide({ guide, lang, t }) {
      if (!guide) return null
      const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }
      const cell = { padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top', textAlign: 'left' }
      const headCell = { ...cell, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l2)' }
      const codeCell = { ...cell, fontFamily: MONO, color: 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap' }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h('div', null,
          h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, t('rulesMetrics') + ' — ' + t('rulesMetricsHint')),
          h('table', { style: tableStyle },
            h('thead', null, h('tr', null,
              h('th', { style: headCell }, t('rulesFieldKey')),
              h('th', { style: headCell }, t('rulesFieldMeaning')),
              h('th', { style: headCell }, t('rulesFieldUsedFor')))),
            h('tbody', null,
              (guide.metrics || []).map((item) => h('tr', { key: item.key },
                h('td', { style: codeCell }, item.key),
                h('td', { style: cell }, RULE_LOCALIZED(METRIC_HINTS[item.key], lang) || RULE_LOCALIZED(item.label, lang) || ''),
                h('td', { style: { ...cell, ...style.muted } }, RULE_LOCALIZED(item.label, lang) || ''))))),
          h('div', { style: { ...style.muted, fontSize: 10.5, marginTop: 4 } }, t('rulesMetricExample'))),
        h('div', null,
          h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, t('rulesNorms') + ' — ' + t('rulesNormsHint')),
          h('table', { style: tableStyle },
            h('thead', null, h('tr', null,
              h('th', { style: headCell }, t('rulesFieldKey')),
              h('th', { style: headCell }, t('rulesFieldMeaning')),
              h('th', { style: headCell }, t('rulesFieldUsedFor')))),
            h('tbody', null,
              (guide.norms || []).map((item) => h('tr', { key: item.key },
                h('td', { style: codeCell }, item.key),
                h('td', { style: cell }, RULE_LOCALIZED(NORM_HINTS[item.key], lang) || RULE_LOCALIZED(item.description, lang) || ''),
                h('td', { style: { ...cell, ...style.muted } }, RULE_LOCALIZED(item.label, lang) || ''))))),
          h('div', { style: { ...style.muted, fontSize: 10.5, marginTop: 4 } }, t('rulesNormExample'))),
        h('div', null,
          h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, t('rulesStructure')),
          h('div', { style: { ...style.muted, fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: MONO, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, padding: '8px 10px' } },
            t('rulesStructureSample'))),
        h('div', null,
          h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, t('rulesGroupsGuide')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            (guide.groups || []).map((group) => h('div', { key: group.key, style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
              h('span', { style: { ...style.chip, fontFamily: MONO } }, group.key),
              h('span', { style: { fontSize: 11.5, fontWeight: 600 } }, RULE_LOCALIZED(group.label, lang)),
              h('span', { style: { ...style.muted, fontSize: 11 } }, RULE_LOCALIZED(group.desc, lang))))))
      )
    }

    function RulesPage({ status, t, lang, onStatus }) {
      const [detail, setDetail] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [guide, setGuide] = useState(null)
      const [showGuide, setShowGuide] = useState(false)
      const [pendingDelete, setPendingDelete] = useState(null)
      const fileRef = useRef(null)

      const summary = status?.rules || null
      // 下拉框的候选只从 rules.get 拿（status 里的 choices 是同一份，先渲染它避免闪烁）
      const choices = (detail && Array.isArray(detail.library)) ? detail.library : ((summary && Array.isArray(summary.choices)) ? summary.choices : [])
      const activeId = (detail && detail.activeId) || (summary && summary.activeId) || ''
      const activeChoice = choices.find((item) => item.id === activeId) || null

      const loadDetail = useCallback(async () => {
        try {
          const body = await request({ op: 'rules.get' })
          setDetail(body)
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { void loadDetail() }, [loadDetail])

      // 模版说明是静态内容，只在用户第一次展开时拉一次。
      const loadGuide = useCallback(async () => {
        if (guide) return
        try {
          const body = await request({ op: 'rules.template' })
          setGuide({ metrics: body.metrics || [], norms: body.norms || [], groups: body.groups || [], template: body.template || null })
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        }
      }, [guide])

      // 换规则后 Host 会重算全表分数；这里顺手把规则详情与状态都刷一遍。
      const afterChange = async (body, okText) => {
        setNote({ tone: 'ok', text: okText })
        await loadDetail()
        if (typeof onStatus === 'function') await onStatus()
      }

      /** 下拉框选项变化：直接启用库里的那一条，不动库本身。 */
      const selectRule = async (id) => {
        if (!id || id === activeId) return
        setBusy(true)
        try {
          const body = await request({ op: 'library.activate', id })
          const choice = choices.find((item) => item.id === id)
          await afterChange(body, t('rulesSwitched') + ' · ' + (choice ? choice.name : id))
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
          // 失败要把下拉框拨回真实值，否则界面会停在用户以为切过去了的那一项
          await loadDetail()
        } finally {
          setBusy(false)
        }
      }

      const applyDocument = async (document, name) => {
        setBusy(true)
        try {
          const body = await request({ op: 'library.add', document, name })
          await afterChange(body, t('rulesUploaded') + (body.renamed ? ' · ' + t('rulesRenamedTo') + ' ' + (body.entry ? body.entry.name : '') : ''))
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        } finally {
          setBusy(false)
        }
      }

      const deleteRule = async (id) => {
        setBusy(true)
        try {
          const body = await request({ op: 'library.remove', id })
          await afterChange(body, t('rulesDeleted') + ' · ' + (body.removed ? body.removed.name : id) + (body.wasActive ? ' · ' + t('rulesBackToBuiltin') : ''))
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        } finally {
          setBusy(false)
          setPendingDelete(null)
        }
      }

      const resetRules = async () => {
        setBusy(true)
        try {
          const body = await request({ op: 'rules.reset' })
          await afterChange(body, t('rulesBackToBuiltin'))
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        } finally {
          setBusy(false)
        }
      }

      const exportRules = async () => {
        try {
          const body = await request({ op: 'rules.export' })
          const blob = new Blob([JSON.stringify(body.document, null, 2)], { type: 'application/json;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = body.filename || ('market-lens-scoring-rules-' + new Date().toISOString().slice(0, 10) + '.json')
          document.body.appendChild(anchor)
          anchor.click()
          document.body.removeChild(anchor)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setNote({ tone: 'ok', text: t('rulesExport') + ' ✓' })
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        }
      }

      const downloadTemplate = async () => {
        try {
          const body = await request({ op: 'rules.template' })
          setGuide({ metrics: body.metrics || [], norms: body.norms || [], groups: body.groups || [], template: body.template || null })
          const blob = new Blob([JSON.stringify(body.template, null, 2)], { type: 'application/json;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = body.filename || 'market-lens-scoring-rules.template.json'
          document.body.appendChild(anchor)
          anchor.click()
          document.body.removeChild(anchor)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setNote({ tone: 'ok', text: t('rulesTemplateSaved') })
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        }
      }

      const uploadRules = async (file) => {
        if (!file) return
        setBusy(true)
        try {
          const text = await file.text()
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            throw new Error(t('rulesUploadFailed') + '：' + t('rulesNotJson'))
          }
          // 文件名（去掉扩展名）默认作为规则名：用户上传时不用再手填
          const baseName = typeof file.name === 'string' ? file.name.replace(/\.json$/i, '') : ''
          await applyDocument(parsed, baseName)
        } catch (cause) {
          setNote({ tone: 'error', text: (cause.message || String(cause)) })
        } finally {
          setBusy(false)
          if (fileRef.current) fileRef.current.value = ''
        }
      }

      const issues = (detail && detail.issue) || (summary && summary.issue) || null
      const userEntries = choices.filter((item) => item.origin === 'user')
      const description = (detail && detail.description) || null
      const card = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }

      // 用户规则列表单独建树：这部分原来嵌在 return 里，三处三元 + map 回调
      // 叠在一起，括号数稍一错位就整页编译不过，很难看出是哪一层的问题。
      const userRows = userEntries.map((item) => {
        const confirming = pendingDelete === item.id
        return h('div', {
          key: item.id,
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' },
        },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('span', { style: { fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              item.name,
              item.id === activeId ? h('span', { style: { ...style.chip, color: 'var(--dsw-alias-brand-primary)' } }, t('rulesInUse')) : null,
              h('span', { style: { ...style.muted, fontSize: 10.5 } }, String(item.factorCount) + t('rulesFactorUnit'))),
            item.description ? h('span', { style: { ...style.muted, fontSize: 11 } }, item.description) : null),
          confirming
            ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { ...style.muted, fontSize: 11 } }, t('rulesDeleteConfirm')),
                h('button', { type: 'button', style: buttonStyle(false, busy, true), disabled: busy, onClick: () => void deleteRule(item.id) }, t('rulesDeleteYes')),
                h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => setPendingDelete(null) }, t('rulesCancel')))
            : h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => setPendingDelete(item.id) }, t('rulesDelete')))
      })

      const libraryList = userEntries.length === 0
        ? h('div', { style: { ...style.muted, fontSize: 11.5 } }, t('rulesNoUserEntries'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, ...userRows)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 920 } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, t('rulesTitle')),
          h('div', { style: { ...style.muted, fontSize: 11.5, marginTop: 2, lineHeight: 1.6 } }, t('rulesIntro'))),

        h('div', null,
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('rulesSelect')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
            h('select', {
              // 下拉框是这次改动的核心：所有可选口径（内置 + 预设 + 自己传的）都在这里
              className: 'ml-rule-select',
              style: { ...style.search, flex: '1 1 260px', maxWidth: 420, padding: '5px 8px', fontSize: 12.5 },
              value: activeId,
              disabled: busy || loading || choices.length === 0,
              onChange: (event) => void selectRule(event.target.value),
            }, choices.length === 0
              ? h('option', { value: '' }, loading ? '…' : t('rulesEmptyLibrary'))
              : choices.map((item) => h('option', { key: item.id, value: item.id },
                  // 选项文字自带来源与因子数，用户不用逐条点开就知道选的是哪一类
                  item.name + ' · ' + RULE_ORIGIN_LABEL(item.origin, t) + ' · ' + String(item.factorCount) + t('rulesFactorUnit')))),
            activeChoice
              ? h('span', { style: { ...style.chip, color: RULE_ORIGIN_COLOR(activeChoice.origin) } }, RULE_ORIGIN_LABEL(activeChoice.origin, t))
              : null),
          activeChoice && activeChoice.description
            ? h('div', { style: { ...style.muted, fontSize: 11.5, marginTop: 2 } }, activeChoice.description)
            : null),

        issues ? h('div', { style: style.errorBox }, t('rulesIssue') + '：' + issues) : null,
        note
          ? h('div', { style: { fontSize: 11.5, color: note.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, note.text)
          : null,

        // 当前规则在算什么：不读 JSON 也能懂
        description ? h('div', { style: card }, h(RuleDigest, { description, lang, t })) : null,

        h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } },
              t('rulesLibrary') + (userEntries.length ? ' · ' + String(userEntries.length) + t('rulesUserCountUnit') : '')),
            h('span', { style: { ...style.muted, fontSize: 11 } }, t('rulesLibraryHint'))),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: buttonStyle(true, busy, true), disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, t('rulesUpload')),
            h('button', { type: 'button', style: buttonStyle(showGuide, false, true), onClick: () => { setShowGuide((value) => !value); if (!showGuide) void loadGuide() } }, t('rulesTemplateGuide') + (showGuide ? ' ✓' : '')),
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void downloadTemplate() }, t('rulesTemplateDownload')),
            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void exportRules() }, t('rulesExport')),
            h('button', { type: 'button', style: buttonStyle(false, busy || Boolean(summary && summary.isDefault), true), disabled: busy || Boolean(summary && summary.isDefault), onClick: () => void resetRules() }, t('rulesReset')),
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: 'application/json,.json',
              style: { display: 'none' },
              onChange: (event) => {
                const file = event.target.files && event.target.files[0]
                void uploadRules(file)
              },
            })),
          // 自己传的规则列表：可以删（内置与预设只在下拉框里出现，不给删除入口）
          libraryList),

        showGuide
          ? h('div', { style: card },
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('rulesTemplateGuide')),
              h('div', { style: { ...style.muted, fontSize: 11.5, lineHeight: 1.6 } }, t('rulesTemplateGuideIntro')),
              guide
                ? h(TemplateGuide, { guide, lang, t })
                : h('div', { style: { ...style.muted, fontSize: 11.5 } }, '…'))
          : null,

        h('div', { style: { ...style.muted, fontSize: 11, lineHeight: 1.6 } },
          t('rulesRulesPath') + '：' + ((detail && detail.paths && detail.paths.library) || '—'),
          detail && detail.paths && detail.paths.legacy && !(detail.summary && detail.summary.migratedFrom)
            ? h('div', null, t('rulesLegacyPath') + '：' + detail.paths.legacy)
            : null),
      )
    }

    // ---- onboarding ----

    function Onboarding({ status, t, onSync }) {
      const running = Boolean(status?.sync?.running)
      const progress = status?.sync?.progress || {}
      const enabled = (status?.sourceConfig?.sources || []).filter((source) => source.enabled !== false)
      const compat = progress.compat || {}
      const percent = (() => {
        const parts = enabled.map((source) => {
          const item = progress[source.id] || {}
          if (item.status === 'done') return 1
          if (item.total) return Math.min(1, (item.done || 0) / item.total)
          return 0
        })
        if (compat.total) parts.push(compat.done / compat.total)
        return parts.length ? Math.round((parts.reduce((sum, value) => sum + value, 0) / parts.length) * 100) : 0
      })()
      return h(
        'div',
        { style: style.onboarding },
        h('h2', { style: { margin: 0, fontSize: 21, fontWeight: 650 } }, t('onboardingTitle')),
        h('p', { style: { ...style.muted, margin: 0, lineHeight: 1.7, fontSize: 13 } }, t('onboardingBody')),
        h('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 4 } }, t('onboardingSources')),
        h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap' } },
          ...enabled.map((source) => h('span', { key: source.id, style: { ...style.badge(sourceColor(source.id), true), fontSize: 12, padding: '3px 9px' } }, source.name)),
        ),
        running
          ? h(
              React.Fragment,
              null,
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, ...style.muted } },
                h('span', null, status.sync.message || t('syncing')),
                h('span', null, percent + '%'),
              ),
              h('div', { style: style.progressTrack }, h('div', { style: style.progressFill(percent) })),
              h('div', { style: { ...style.muted, fontSize: 11.5, display: 'flex', gap: 12, flexWrap: 'wrap' } },
                ...enabled.map((source) => {
                  const item = progress[source.id] || {}
                  return h('span', { key: source.id }, source.name + ': ' + (item.status === 'done' ? '✓' : item.total ? (item.done || 0) + '/' + item.total : item.status || '—'))
                }),
                h('span', null, t('compatChecking') + ': ' + (compat.done || 0) + '/' + (compat.total || '—')),
              ),
            )
          : h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', { type: 'button', style: buttonStyle(true, false), onClick: () => onSync({ force: false }) }, t('startSync')),
              h('span', { style: { ...style.muted, alignSelf: 'center' } }, t('firstSyncHint')),
            ),
        status?.sync?.phase === 'error' ? h('div', { style: style.errorBox }, t('syncFailed') + ': ' + (status.sync.message || '—')) : null,
      )
    }
    // ---- main page ----

    function PanelPage() {
      const { t, lang } = useText()
      const [status, setStatus] = useState(null)
      const [rows, setRows] = useState([])
      const [meta, setMeta] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      // 「上次看到哪儿」只在挂载时读一次：这中间还夹着 filters 的 sessionStorage
      // 恢复和列宽恢复，每次渲染都去解析一遍 localStorage 纯属白烧。
      const initialPageStateRef = useRef(null)
      if (initialPageStateRef.current === null) initialPageStateRef.current = readPageState()
      const initialPageState = initialPageStateRef.current

      const [view, setView] = useState(initialPageState.view)
      const [search, setSearch] = useState(initialPageState.search)
      const deferredSearch = useDeferredValue(search)
      const [filters, setFilters] = useState(() => {
        try {
          const raw = sessionStorage.getItem(FILTER_STORE)
          return raw ? sanitizeFilters(JSON.parse(raw)) : emptyFilter()
        } catch {
          return emptyFilter()
        }
      })
      const [sort, setSort] = useState(initialPageState.sort)
      const [page, setPage] = useState(() => initialPageState.page)
      const [pageSize, setPageSize] = useState(() => initialPageState.pageSize)
      const [detailId, setDetailId] = useState(null)
      const [syncing, setSyncing] = useState(false)
      const [columnWidths, setColumnWidths] = useState(() => {
        try {
          const raw = localStorage.getItem(COLUMN_STORE)
          return raw ? { ...DEFAULT_COLUMN_WIDTHS, ...JSON.parse(raw) } : { ...DEFAULT_COLUMN_WIDTHS }
        } catch {
          return { ...DEFAULT_COLUMN_WIDTHS }
        }
      })
      const [columnVisibility, setColumnVisibility] = useState(() => {
        try {
          const raw = localStorage.getItem(COLUMN_VISIBILITY_STORE)
          return raw ? { ...DEFAULT_COLUMN_VISIBILITY, ...JSON.parse(raw) } : { ...DEFAULT_COLUMN_VISIBILITY }
        } catch {
          return { ...DEFAULT_COLUMN_VISIBILITY }
        }
      })
      // 筛选栏默认开；关掉只影响表头按钮，不影响已生效的筛选值。
      const [showFilters, setShowFilters] = useState(() => {
        try {
          return localStorage.getItem(FILTER_ROW_STORE) !== '0'
        } catch {
          return true
        }
      })
      const [openPopover, setOpenPopover] = useState(null)
      // 配置导入/导出的回执（成功几行、跳过几条），以及导入用的隐藏 file input
      const [transfer, setTransfer] = useState(null)
      const [updating, setUpdating] = useState(false)
      // 行内安装 / 升级共用一个「忙」状态：同一时刻只有一颗按钮在转。
      // 带上 mode 与 status，按钮就能自己显示「安装中…」「升级中…」或「重试」。
      // 必须声明在所有 effect 之前——effect 的依赖数组是在渲染时求值的，
      // 把 useState 放到用它的 effect 后面会直接踩 TDZ（ReferenceError: Cannot access before initialization），
      // 整个 slot 崩掉，面板就打不开了。
      const [actionBusy, setActionBusy] = useState(null)
      const [installedKeys, setInstalledKeys] = useState(() => new Set())
      // 构建脚本需要用户第二次确认：同一行第一次失败后记下 pendingBuilds，
      // 再点行内按钮时把它们作为 approvedBuilds 发给官方 pluginManager。
      const [installApprovals, setInstallApprovals] = useState({})
      // 安装结果单独存：通用的 error 会被下一次 status 轮询 setError(null) 抹掉，
      // 而安装要么成功要么失败必须让用户看得见，所以 notice 只由用户或下一次安装覆盖。
      const [notice, setNotice] = useState(null)
      const [manual, setManual] = useState(null)
      const fileInputRef = useRef(null)
      const noticeTimer = useRef(null)
      const compatSeq = useRef(0)
      const cacheStamp = useRef(null)
      // 已安装集合的指纹（Host 每次 status 都给）：变了就说明外面装/卸过东西。
      const installedStamp = useRef(null)
      const loadInFlight = useRef(false)
      // 表格滚动容器：用来记住 / 恢复「滚到哪一行」。用 ref 而不是 querySelector，
      // 因为同一个面板理论上可以被挂两次（主面板 + 浮窗形态）。
      const tableScrollRef = useRef(null)
      const scrollRestored = useRef(false)

      useEffect(() => {
        try {
          sessionStorage.setItem(FILTER_STORE, JSON.stringify(filters))
        } catch {
          // sessionStorage can be unavailable in a sandboxed webview.
        }
      }, [filters])

      useEffect(() => {
        try {
          localStorage.setItem(COLUMN_STORE, JSON.stringify(columnWidths))
        } catch {
          // localStorage can be unavailable in a sandboxed webview.
        }
      }, [columnWidths])

      useEffect(() => {
        try {
          localStorage.setItem(COLUMN_VISIBILITY_STORE, JSON.stringify(columnVisibility))
        } catch {
          // localStorage can be unavailable in a sandboxed webview.
        }
      }, [columnVisibility])

      useEffect(() => {
        try {
          localStorage.setItem(FILTER_ROW_STORE, showFilters ? '1' : '0')
        } catch {
          // localStorage can be unavailable in a sandboxed webview.
        }
      }, [showFilters])

      // 页签 / 搜索词 / 排序 / 页码 / 每页条数各自变化都往同一份快照里写一笔。
      useEffect(() => { writePageState({ view }) }, [view])
      useEffect(() => { writePageState({ search }) }, [search])
      useEffect(() => { writePageState({ sort }) }, [sort.key, sort.dir])
      useEffect(() => { writePageState({ page }) }, [page])
      useEffect(() => { writePageState({ pageSize }) }, [pageSize])

      const rowsCount = rows.length

      const loadCatalog = useCallback(async () => {
        if (loadInFlight.current) return
        loadInFlight.current = true
        try {
          const body = await request({ op: 'catalog' })
          registerSourceConfig(body.sourceConfig)
          setRows(Array.isArray(body.rows) ? body.rows : [])
          setMeta(body.meta || null)
          cacheStamp.current = body.meta?.generatedAt || body.cache?.generatedAt || null
          compatSeq.current = Number(body.meta?.compatSeq) || 0
          setStatus((previous) => previous ? {
            ...previous,
            sync: body.sync || previous.sync,
            compat: body.meta?.compat || previous.compat,
            sourceConfig: body.sourceConfig || previous.sourceConfig,
            sourceHealth: body.sourceHealth || previous.sourceHealth,
            settings: body.settings || previous.settings,
          } : previous)
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          loadInFlight.current = false
        }
      }, [])

      const loadStatus = useCallback(async ({ loadIfReady = false } = {}) => {
        try {
          const body = await request({ op: 'status' })
          registerSourceConfig(body.sourceConfig)
          setStatus(body)
          setError(null)
          const changed = Boolean(body.cache?.generatedAt && body.cache.generatedAt !== cacheStamp.current)
          // 已安装集合变了（自己装的、从官方市场装的、命令行装的都算）：重拉目录让安装列立刻跟上。
          const stamp = body.installed?.fingerprint ?? null
          const installedChanged = Boolean(stamp && stamp !== installedStamp.current)
          if (stamp) installedStamp.current = stamp
          if (changed || installedChanged || (loadIfReady && body.cache?.exists && !rowsCount)) await loadCatalog()
          return body
        } catch (cause) {
          setError(cause.message || String(cause))
          return null
        }
        // 只依赖「有没有行」这个事实：把 rows.length 直接写进依赖数组会让
        // loadStatus 每加载完一轮目录就换一个新函数，调用它的轮询 effect 跟着重跑，
        // 于是面板在空闲时也一直在自我刷新。
      }, [loadCatalog, rowsCount])

      useEffect(() => {
        let alive = true
        const boot = async () => {
          setLoading(true)
          try {
            const body = await request({ op: 'status' })
            if (!alive) return
            registerSourceConfig(body.sourceConfig)
            setStatus(body)
            if (body.cache?.exists) {
              await loadCatalog()
            }
          } catch (cause) {
            if (alive) setError(cause.message || String(cause))
          } finally {
            if (alive) setLoading(false)
          }
        }
        void boot()
        return () => { alive = false }
      }, [loadCatalog])

      const applyCompatDelta = useCallback((items) => {
        if (!Array.isArray(items) || items.length === 0) return
        const map = new Map(items.map(([pkg, entry]) => [String(pkg).toLowerCase(), entry]))
        setRows((previous) =>
          previous.map((row) => {
            if (!row.pkg) return row
            const entry = map.get(row.pkg.toLowerCase())
            if (!entry) return row
            return { ...row, compat: { status: entry.status, reason: entry.reason, version: entry.version, checkedAt: entry.checkedAt } }
          }),
        )
      }, [])

      const pollCompat = useCallback(async () => {
        try {
          const body = await request({ op: 'compat', since: compatSeq.current })
          if (Number.isFinite(body.seq)) compatSeq.current = body.seq
          applyCompatDelta(body.items)
        } catch {
          // Polling is best-effort; the next status tick retries.
        }
      }, [applyCompatDelta])

      useEffect(() => {
        const timer = setInterval(() => { void loadStatus() }, 20000)
        return () => clearInterval(timer)
      }, [loadStatus])

      useEffect(() => {
        const running = Boolean(status?.sync?.running) || Boolean(status?.compat?.running) || Boolean(status?.updates?.running)
        if (!running) return undefined
        let cancelled = false
        const tick = async () => {
          const body = await loadStatus({ loadIfReady: true })
          if (cancelled || !body) return
          if (body.compat?.running || body.sync?.phase === 'compat') void pollCompat()
          if (!body.sync?.running && !body.compat?.running) {
            // 同步 / 更新检查刚收尾：重拉目录，把新的差异徽标与版本结论带进表格
            await loadCatalog()
          }
        }
        const timer = setInterval(() => { void tick() }, 1500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [status?.sync?.running, status?.compat?.running, status?.sync?.phase, status?.updates?.running, loadStatus, loadCatalog, pollCompat])

      // 只有「用户改了筛选/排序条件」才回第 1 页。首次挂载时把恢复的页码打回 1
      // 正是「翻到第十页、切走再回来又从头翻」的根因；pageSize 也不该在这里重置——
      // 底部分页控件自己会写 setPage(1)。
      const landed = useRef(false)
      useEffect(() => {
        if (!landed.current) {
          landed.current = true
          return
        }
        setPage(1)
      }, [deferredSearch, filters, sort.key, sort.dir])

      // 安装/升级是长请求（pnpm 下载 + 应用 + 重启生效），装完那一刻界面还停在旧状态。
      // 这期间每 3 秒拉一次 status：指纹一变 loadStatus 自己会把目录重拉，按钮就更新了。
      useEffect(() => {
        if (!actionBusy || actionBusy.status === 'error') return undefined
        let cancelled = false
        const tick = async () => {
          if (cancelled) return
          await loadStatus()
        }
        const timer = setInterval(() => { void tick() }, 3000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [actionBusy, loadStatus])

      const filtered = useMemo(() => {
        let list = rows
        if (deferredSearch) list = list.filter((row) => searchRow(row, deferredSearch))
        list = list.filter((row) => filterRow(row, filters))
        return list
      }, [rows, filters, deferredSearch])

      // 安全优先视图（默认开）：只放行 dsh.so 低风险或安装验证通过的条目。
      // 放在 filterRow 之后，是因为它属于"显示策略"而不是用户手写的筛选条件：
      // 关掉开关应该立刻回到原列表，而不是留在 filters 里变成一条要手动清的 chip。
      const safeView = status?.settings?.safeView !== false
      const safeFiltered = useMemo(
        () => (safeView ? filtered.filter((row) => trustOfRow(row).safe) : filtered),
        [filtered, safeView],
      )
      const hiddenBySafeView = filtered.length - safeFiltered.length

      /**
       * 源级新鲜度状态带。
       *
       * 为什么必须在市场页出现：多源聚合下单个源失败不会报错，只是它那一份条目
       * 少了一批。用户看到的是「这个插件搜不到」——结论错了，而原因在别处。
       *
       * 判定用的是 status.sourceHealth（后端已有 lastSuccessAt / failureCount / lastError）。
       * 全部源都健康时不渲染任何东西 —— 状态带只在"有话说"时出现。
       */
      const freshnessBanner = (() => {
        const healthEntries = Array.isArray(status?.sourceHealth) ? status.sourceHealth : []
        if (!healthEntries.length) return null
        // 只关心**启用且本次失败或从没成功过**的源。
        const degraded = healthEntries.filter((entry) => {
          if (!entry || entry.enabled === false) return false
          if (entry.failureCount > 0) return true
          return entry.lastSuccessAt === null || entry.lastSuccessAt === undefined
        })
        if (!degraded.length) return null
        const syncing = Boolean(status?.sync?.running)
        const tone = 'var(--dsw-alias-state-warn-primary)'
        const names = degraded.slice(0, 4).map((entry) => entry.name || entry.id)
        const more = degraded.length > 4 ? ' +' + (degraded.length - 4) : ''
        return h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '6px 10px', borderRadius: 7, fontSize: 11.5, lineHeight: 1.5,
            border: '1px solid ' + tone,
            background: 'color-mix(in srgb, ' + tone + ' 9%, transparent)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
          h('span', { style: { color: tone, fontWeight: 600 } }, t('freshnessTitle')),
          h('span', null, names.join(' · ') + more),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
            degraded.some((entry) => entry.failureCount > 0)
              ? t('freshnessRepeated')
              : t('freshnessNever')),
          syncing ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('freshnessSyncing')) : null,
          h('button', {
            type: 'button',
            style: buttonStyle(false, syncing, true),
            disabled: syncing,
            onClick: () => void startSync({ force: true }),
          }, t('freshnessRetry')),
        )
      })()

      const sorted = useMemo(() => sortRows(safeFiltered, sort), [safeFiltered, sort])

      // 等目录真的进到表格里再滚回去：在空表上写 scrollTop 会被浏览器截成 0，
      // 用户看到的就是「记是记了，但回来还是顶头」。
      useEffect(() => {
        if (scrollRestored.current) return
        if (view !== 'table' || !sorted.length) return
        if (!tableScrollRef.current) return
        scrollRestored.current = true
        const top = initialPageState.scrollTop
        if (top <= 0) return undefined
        const apply = () => { if (tableScrollRef.current) tableScrollRef.current.scrollTop = top }
        apply()
        // 分页是同步渲染的，但表头行高与图片可能让总高度晚一帧才定，所以补一次。
        const timer = setTimeout(apply, 60)
        return () => clearTimeout(timer)
      }, [view, sorted.length, initialPageState.scrollTop])

      const visibleColumns = useMemo(
        () => COLUMNS.filter((column) => column.key === 'name' || columnVisibility[column.key] !== false),
        [columnVisibility],
      )
      const gridTemplate = useMemo(() => visibleColumns.map((column) =>
        column.key === 'name'
          ? `minmax(${columnWidths[column.key] || column.width}px, 1fr)`
          : `${columnWidths[column.key] || column.width}px`,
      ).join(' '), [visibleColumns, columnWidths])
      const tableMinWidth = useMemo(() => visibleColumns.reduce((sum, column) => sum + (columnWidths[column.key] || column.width), 0) + 6, [visibleColumns, columnWidths])

      const startResize = useCallback((column, event) => {
        if (!event || event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const startWidth = columnWidths[column.key] || column.width
        const min = column.min || 50
        const max = column.max || 600
        const previousCursor = document.body.style.cursor
        document.body.style.cursor = 'col-resize'
        const move = (moveEvent) => {
          const width = Math.max(min, Math.min(max, Math.round(startWidth + moveEvent.clientX - startX)))
          setColumnWidths((previous) => ({ ...previous, [column.key]: width }))
        }
        const up = () => {
          document.body.style.cursor = previousCursor
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }, [columnWidths])

      // 行内安装：和详情抽屉共用同一个 op，状态放在列表这一层，
      // 这样同一时刻只有一个「…」在转，也方便装完立刻把该行标成已安装。
      // 安装回执：成功 8 秒后自动收起，失败留在原地等用户处理。
      const showNotice = useCallback((next) => {
        if (noticeTimer.current) {
          clearTimeout(noticeTimer.current)
          noticeTimer.current = null
        }
        setNotice(next)
        if (next && next.tone === 'success') {
          noticeTimer.current = setTimeout(() => setNotice(null), 8000)
        }
      }, [])

      useEffect(() => () => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
      }, [])

      /**
       * 行内操作：安装 / 重装 / 升级。
       *
       * 三者走同一颗按钮，但语义不同：
       *   install    —— 首次装，目标按目录（可能降级到 latest）
       *   reinstall  —— 已装情况下再点，等于装同一个目标（幂等）
       *   upgrade    —— 已装且有新版，装到**正好**那个版本（不降级，升不到就算失败）
       *
       * actionBusy 同时携带 mode：按钮要显示「安装中…」还是「升级中…」，
       * 以及失败后按钮该回到哪种状态（失败不等于已装）。
       */
      const installRow = useCallback(async (row, mode = 'install') => {
        if (!row || actionBusy) return
        const rowKey = rowKeyOf(row)
        if (!rowKey) {
          showNotice({
            tone: 'error',
            title: t('installFailed'),
            subtitle: null,
            detail: t('installNoSpec'),
            spec: null,
            hint: null,
            retry: false,
            row: null,
          })
          return
        }
        // 目标版本以 Host 下发的 button.version 为准：它是算 buttonState 时
        // 用的同一个值，不会出现「按钮写着 x.y.z，实际装的是另一个版本」。
        const upgradeTo = mode === 'upgrade'
          ? String(row.button?.version || (row.update && row.update.to) || '').trim() || null
          : null
        // reinstall 也要如实标注：它和首次安装走同一个 op，但语义不同 ——
        // 原来这里被折叠成 'install'，日志里分不出「重装」与「首装」。
        setActionBusy({
          key: rowKey,
          mode: upgradeTo ? 'upgrade' : (mode === 'reinstall' ? 'reinstall' : 'install'),
          status: 'pending',
          suffix: upgradeTo ? 'v' + upgradeTo : (row.pkg || null),
        })
        setError(null)
        try {
          const body = upgradeTo
            ? await request({
                op: 'upgrade',
                pkg: row.pkg,
                version: upgradeTo,
                approvedBuilds: Array.isArray(installApprovals[rowKey]) ? installApprovals[rowKey] : undefined,
              })
            : await request({
                op: 'install',
                key: rowKey,
                target: installTargetForRow(row),
                approvedBuilds: Array.isArray(installApprovals[rowKey]) ? installApprovals[rowKey] : undefined,
              })
          setInstalledKeys((previous) => {
            const next = new Set(previous)
            next.add(rowKey)
            return next
          })
          setInstallApprovals((previous) => {
            if (!(rowKey in previous)) return previous
            const next = { ...previous }
            delete next[rowKey]
            return next
          })
          // 只改这一行（按稳定 id 比对），然后从 Host 拉一次真实目录：
          // 装/升级会顺带改版本号与「可更新」结论，乐观更新只够让按钮立刻变样。
          setRows((previous) => previous.map((candidate) => (
            rowKeyOf(candidate) === rowKey
              ? { ...candidate, installed: true, installedVersion: upgradeTo || candidate.installedVersion || candidate.version || null, update: null }
              : candidate
          )))
          if (body && body.installed) installedStamp.current = body.installed.fingerprint || null
          // 装上了但没挂载是最坑的一种「成功」：文件在、已安装清单也看得到，
          // 但重启后 loader 根本不加载它。必须当场说清楚，不能报成绿字。
          const mount = body && body.mount ? body.mount : null
          const mountWarn = Boolean(mount && mount.checked && !mount.mounted)
          // 第二层：挂载对、但插件自带的装载行解析不到 / peer 冲突 —— 表现同样是
          // 「装上但不出现」，而在 dsh 自己的日志里一行都不提。这一类也要当场说。
          const health = body && body.health ? body.health : null
          const healthBad = Boolean(health && health.verdict === 'bad')
          // 第四层：静态全通但运行时没激活（fiber failed / pending / 被禁用）。
          // 这一类最像"什么都没发生"—— 重启后插件就是不出现，必须当场说。
          const healthInactive = Boolean(health && (
            health.verdict === 'installed-not-active' || health.verdict === 'installed-disabled'
          ))
          // 第五层：装了、能加载、甚至跑起来了，但缺外部配置 —— 用不了。
          // 真机案例 dsh-weknora：工具全注册成功（fiber active），
          // 但连的是 patch 默认值 localhost:8080，那里没有服务。
          // 用户看到的就是「显示已安装但没有安装成功」。
          const healthNeedsConfig = Boolean(health && health.verdict === 'needs-config')
          const configKeys = healthNeedsConfig && health.config && Array.isArray(health.config.entries)
            ? health.config.entries
              .filter((entry) => entry.status !== 'satisfied')
              .map((entry) => entry.env.join('/') + '（' + entry.status + '）')
            : []
          const healthWarn = !mountWarn && Boolean(health && health.verdict === 'warn' && !health.unmounted)
          const healthDetail = health && Array.isArray(health.rows)
            ? health.rows.filter((row) => row.status === 'unresolved').map((row) => row.name)
            : []
          const healthPhase = health && health.activation ? String(health.activation.phase) : null
          showNotice({
            tone: mountWarn || healthBad || healthInactive || healthNeedsConfig ? 'warn' : 'success',
            title: mountWarn
              ? t('installNotMounted')
              : (healthBad
                ? t('installHealthBad')
                : (healthInactive
                  ? t('installInactive')
                  : (healthNeedsConfig
                    ? t('installNeedsConfig')
                    : (upgradeTo ? t('upgradeSucceeded') : t('installSucceeded'))))),
            subtitle: row.pkg || row.title || row.name || null,
            detail: upgradeTo ? upgradeTo : null,
            spec: (body && body.spec) || null,
            hint: mountWarn
              ? t('installNotMountedHint')
              : (healthBad
                ? t('installHealthBadHint').replace('{rows}', healthDetail.join(', ') || (health && health.detail) || '?')
                : (healthInactive
                  ? t('installInactiveHint').replace('{phase}', healthPhase || (health && health.detail) || '?')
                  : (healthNeedsConfig
                    ? t('installNeedsConfigHint').replace('{keys}', configKeys.join('、') || (health && health.detail) || '?')
                    : (body && body.fellBackFrom ? t('installFallback') : null)))),
            retry: false,
            row: null,
          })
          void healthWarn

          // 目标插件本身没挂载：重启后也不会出现，所以直接落一条日志，方便回看
          if (mountWarn) {
            try {
              void request({ op: 'logs', limit: 5 }).catch(() => {})
            } catch { /* 日志是尽力而为 */ }
          }
          await Promise.all([loadStatus().catch(() => {}), loadCatalog().catch(() => {})])
        } catch (cause) {
          // 构建脚本待批准：记下来，下次同一行自动带上 approvedBuilds 重试。
          if (cause.code === 'build-approval-required' && Array.isArray(cause.pendingBuilds) && cause.pendingBuilds.length) {
            setInstallApprovals((previous) => ({ ...previous, [rowKey]: cause.pendingBuilds }))
          } else {
            setInstallApprovals((previous) => {
              if (!(rowKey in previous)) return previous
              const next = { ...previous }
              delete next[rowKey]
              return next
            })
          }
          // 失败留在按钮上（title 里带 pnpm 原文入口），页头回执给完整原因。
          setActionBusy({ key: rowKey, mode: upgradeTo ? 'upgrade' : 'install', status: 'error', suffix: upgradeTo ? 'v' + upgradeTo : null })
          showNotice({ ...noticeFromInstallError(cause, t, lang), row })
          return
        }
        setActionBusy(null)
      }, [actionBusy, installApprovals, lang, loadStatus, loadCatalog, showNotice, t])
      /**
       * 「仍然安装」：先授精确版本豁免，再重试安装。
       *
       * 为什么必须分两步：宿主在 pnpm 装完后复核兼容性，检出
       * incompatible-version 就整批回滚。豁免写在 profile 的 compatibility.json 里，
       * **必须在下次安装之前就位**，否则重试还是同一个错误。
       *
       * 豁免的语法与限制全部由 Host 的 exempt.grant 校验（精确版本、当前运行时、
       * acceptRisk）。这里只负责把「用户明确点了仍然安装」翻译成 acceptRisk: true ——
       * 那一下点击就是明确同意。
       */
      const grantAndRetry = useCallback(async () => {
        const current = notice
        const exemption = current && current.exemption ? current.exemption : null
        if (!exemption || !exemption.key) {
          showNotice({
            tone: 'error',
            title: t('installForceFailed'),
            subtitle: null,
            detail: t('installForceNoKey'),
            hint: null,
            retry: false,
            row: null,
          })
          return
        }
        const split = exemption.key.lastIndexOf('@')
        const pkg = exemption.key.slice(0, split)
        const version = exemption.key.slice(split + 1)
        const target = current.row || null
        try {
          const granted = await request({
            op: 'exempt.grant',
            pkg,
            version,
            acceptRisk: true,
          })
          showNotice({
            tone: 'success',
            title: t('installForceGranted'),
            subtitle: exemption.key,
            detail: null,
            spec: current.spec || null,
            hint: granted && granted.restartRequired ? t('installForceRestart') : null,
            retry: false,
            row: null,
          })
          // 豁免写完立刻重试这一次安装。宿主可能要到重启才重新读 compatibility.json，
          // 所以重试仍然可能被拦 —— 那时回执里会显示「已授豁免，重启后再试」。
          if (target) void installRow(target, 'reinstall')
          else await Promise.all([loadStatus().catch(() => {}), loadCatalog().catch(() => {})])
        } catch (cause) {
          const body = (cause && cause.body) || {}
          showNotice({
            tone: 'error',
            title: t('installForceFailed'),
            subtitle: exemption.key,
            detail: (body.error || (cause && cause.message) || '').toString(),
            fullDetail: null,
            spec: current.spec || null,
            hint: body.needsConsent ? t('installForceNoConsent') : null,
            retry: false,
            row: null,
          })
        }
      }, [notice, request, t, installRow, loadStatus, loadCatalog, showNotice])


      const startSync = async ({ force } = {}) => {
        setSyncing(true)
        setError(null)
        try {
          const body = await request({ op: 'sync', force: Boolean(force) })
          registerSourceConfig(body.sourceConfig)
          setStatus((previous) => previous ? { ...previous, sync: body.sync || body } : body)
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setSyncing(false)
        }
      }

      const cancelSync = async () => {
        try {
          await request({ op: 'cancel' })
          await loadStatus()
        } catch (cause) {
          setError(cause.message || String(cause))
        }
      }

      const exportCsv = () => {
        const header = ['插件', 'npm 包', '作者', '分类', '来源', '版本', '更新日期', '适配 DSH', '用户数', '评分', '市场风评', '民间风评', 'Stars', '周下载', '安装状态', '仓库']
        const escape = (value) => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"'
        const lines = [header.map(escape).join(',')]
        for (const row of sorted) {
          lines.push([
            row.title || row.name,
            row.pkg || '',
            row.author || '',
            categoryText(row.category, 'zh'),
            (row.sources || []).join('+'),
            row.version || '',
            datePart(row.updatedAt),
            compatLabel(row.compat?.status, t),
            row.installers == null ? t('noData') : row.installers,
            Number.isFinite(row.score) ? row.score : t('noData'),
            row.marketScore,
            row.communityScore == null ? t('noData') : row.communityScore,
            row.stars == null ? t('noData') : row.stars,
            row.downloads == null ? t('noData') : row.downloads,
            // 安装状态与界面同一口径：已装 / 可更新到 x.y.z / 未安装 / 需手动安装
            !canInstallRow(row) ? t('actManual')
              : row.installed ? (row.update && row.update.available ? t('actUpdate') + ' ' + row.update.to : t('actInstalled'))
                : t('actInstall'),
            row.repo || '',
          ].map(escape).join(','))
        }
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'market-lens-' + new Date().toISOString().slice(0, 10) + '.csv'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      }

      const clearFilters = () => setFilters(emptyFilter())
      const activeCount = activeFilterCount(filters)

      // ---- 本次同步差异：开关直接写 filters.change，复用 chip / 清除筛选 ----
      const onlyChanged = Array.isArray(filters.change) && filters.change.length > 0
      const changeCount = rows.filter((row) => row.change === 'added' || row.change === 'updated' || row.change === 'removed').length
      const toggleOnlyChanged = () => {
        setFilters((previous) => {
          const next = { ...previous }
          if (Array.isArray(next.change) && next.change.length) delete next.change
          else next.change = ['added', 'updated', 'removed']
          return next
        })
      }

      // ---- 安全优先视图：写进 settings（持久化），不是本地临时开关 ----
      const toggleSafeView = async () => {
        try {
          const body = await request({ op: 'settings.set', safeView: !safeView })
          setStatus((previous) => previous ? { ...previous, settings: body.settings || previous.settings } : previous)
        } catch (cause) {
          setError(cause.message || String(cause))
        }
      }

      // ---- GitHub 统计：公开 API 匿名可取，但有 60/h 限流；取不到就留 null，
      // 设置页只显示链接而不是编造数字。结果按 sessionStorage 缓存 30 分钟。 ----
      const [githubStats, setGithubStats] = useState(null)
      useEffect(() => {
        const repo = status?.repo
        if (!repo || !repo.owner || !repo.name) return
        let alive = true
        const cacheKey = 'market-lens:ghstats:v1'
        const TTL = 30 * 60 * 1000
        try {
          const raw = sessionStorage.getItem(cacheKey)
          if (raw) {
            const cached = JSON.parse(raw)
            if (cached && Date.now() - Number(cached.at || 0) < TTL && cached.data) {
              setGithubStats(cached.data)
              return () => { alive = false }
            }
          }
        } catch { /* sessionStorage 不可用时直接走网络 */ }
        (async () => {
          try {
            const response = await fetch('https://api.github.com/repos/' + repo.owner + '/' + repo.name, {
              headers: { accept: 'application/vnd.github+json' },
            })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const body = await response.json()
            const data = {
              stars: Number(body.stargazers_count) || 0,
              forks: Number(body.forks_count) || 0,
              openIssues: Number(body.open_issues_count) || 0,
            }
            if (!alive) return
            setGithubStats(data)
            try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data })) } catch { /* 配额满就跳过 */ }
          } catch {
            // 限流 / 断网 / 仓库还没建：保持 null，设置页显示「统计暂不可用」
            if (alive) setGithubStats(null)
          }
        })()
        return () => { alive = false }
      }, [status?.repo?.owner, status?.repo?.name])

      // ---- 已安装插件可更新：官方 inspect 在 Host 后台跑，这里只触发 + 轮询 ----
      const updatesStatus = status?.updates || meta?.updates || null
      // queued 也算「正在检查」：Host 是排队执行的，点下去先回 queued，
      // 只看 running 的话按钮会瞬间弹回去，看起来像没反应。
      const updatesBusy = Boolean(updating || updatesStatus?.running || updatesStatus?.queued)
      const availableUpdates = rows.filter((row) => row.update && row.update.available).length
      // 页脚只留一句确实有信息量的话：数据来自哪几个源。没启用源就整句不渲染
      // （以前会渲染成「数据来自: . 目录缓存 6 小时后建议刷新……」，既空又啰嗦）。
      const enabledSourceNames = (status?.sourceConfig?.sources || [])
        .filter((source) => source.enabled !== false)
        .map((source) => source.name)
        .filter(Boolean)
      const checkUpdates = async () => {
        if (updatesBusy) return
        setUpdating(true)
        try {
          const body = await request({ op: 'updates.check', force: true })
          if (body?.status) setStatus((previous) => (previous ? { ...previous, updates: body.status } : previous))
          // 真正的进度交给下面的轮询 effect（running/queued 期间每 1.5s 一次），
          // 这里不再一口价把状态写死成「已结束」。
        } catch (cause) {
          setError(cause.message || String(cause))
        } finally {
          setUpdating(false)
        }
      }

      /**
       * 单个包升级到 registry 上的最新版。
       *
       * 和「安装」共用一套忙碌位（actionBusy），但走的是 op:'upgrade'：
       * Host 侧要求精确版本且拒绝降级、拒绝本地/link 包，所以前端不能拿
       * 「装」的路径糊过去——以前更新页没有按钮，就是卡在这一步没人接。
       */
      const upgradeRow = async (item) => {
        const pkg = String(item?.pkg || '')
        const to = item?.update?.available ? String(item.update.to || '') : ''
        if (!pkg || !to) return
        // 同一个包正在升级时不重复发；失败态允许直接重试。
        if (actionBusy && actionBusy.status !== 'error' && actionBusy.pkg === pkg) return
        setActionBusy({ key: pkg, mode: 'upgrade', status: 'pending', pkg, suffix: to })
        try {
          const body = await request({ op: 'upgrade', pkg, version: to })
          setActionBusy(null)
          showNotice({
            tone: 'success',
            title: t('upgradeSucceeded'),
            subtitle: pkg,
            detail: to,
            spec: (body && body.spec) || null,
            hint: null,
            retry: false,
            row: null,
          })
          await Promise.all([loadStatus().catch(() => {}), loadCatalog().catch(() => {})])
        } catch (cause) {
          setActionBusy({ key: pkg, mode: 'upgrade', status: 'error', pkg, suffix: to })
          showNotice({ ...noticeFromInstallError(cause, t, lang), row: null })
          // 构建脚本待批准时 Host 会带回 pendingBuilds：拉一次状态让界面同步
          if (cause.code === 'build-approval-required') await loadStatus().catch(() => {})
        }
      }

      // 检查更新进行中：每 1.5s 拉一次进度；收尾时重拉 status + 目录，
      // 让「可更新 N」与表里的版本号立刻跟新。
      useEffect(() => {
        if (!updatesBusy) return undefined
        let cancelled = false
        const timer = setInterval(async () => {
          try {
            const body = await request({ op: 'updates' })
            if (cancelled) return
            setStatus((previous) => (previous ? { ...previous, updates: body.status || previous.updates } : previous))
            if (body.status && !body.status.running && !body.status.queued) {
              clearInterval(timer)
              await loadStatus()
              await loadCatalog()
            }
          } catch {
            // 轮询是尽力而为：下一拍再试，不打断界面
          }
        }, 1500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [updatesBusy, loadStatus, loadCatalog])

      // ---- 自检：面板出事时先看这一屏，不用翻日志 ----
      const runSelfCheck = async () => {
        try {
          const body = await request({ op: 'selfcheck' })
          const text = JSON.stringify(body, null, 2)
          setTransfer({ kind: 'ok', text: text.length > 1200 ? text.slice(0, 1200) + ' …' : text })
          return body
        } catch (cause) {
          setTransfer({ kind: 'error', text: t('selfCheckFailed') + '：' + (cause.message || String(cause)) })
          return null
        }
      }

      // ---- 配置导入/导出：导出给 JSON 文件，导入走隐藏 file input ----
      const exportConfig = async () => {
        try {
          const body = await request({ op: 'config.export' })
          const blob = new Blob([JSON.stringify(body.document, null, 2)], { type: 'application/json;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'market-lens-sources-' + new Date().toISOString().slice(0, 10) + '.json'
          document.body.appendChild(anchor)
          anchor.click()
          document.body.removeChild(anchor)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setTransfer({ kind: 'ok', text: t('configExported') + ' · ' + t('configNote') })
        } catch (cause) {
          setTransfer({ kind: 'error', text: t('importFailed') + '：' + (cause.message || String(cause)) })
        }
      }

      const importConfig = async (file) => {
        if (!file) return
        try {
          const text = await file.text()
          const body = await request({ op: 'config.import', document: text, mode: 'merge' })
          const report = body.report || { added: [], updated: [], removed: [], skipped: [] }
          registerSourceConfig(body.sourceConfig)
          setTransfer({
            kind: 'ok',
            // 这里原本漏了一个 `+`：`字符串` 换行接 `(条件 ? …)` 会被解析成函数调用，
            // 于是每次导入都以 TypeError 收场 —— 配置其实已经落盘，界面却说「导入失败」。
            text: t('configImported') + ' · +' + report.added.length + ' / ~' + report.updated.length + ' / −' + report.removed.length
              + (report.skipped.length ? ' · ' + t('importSkipped') + ' ' + report.skipped.length : ''),
          })
          await loadStatus()
        } catch (cause) {
          setTransfer({ kind: 'error', text: t('importFailed') + '：' + (cause.message || String(cause)) })
        } finally {
          if (fileInputRef.current) fileInputRef.current.value = ''
        }
      }
      const sync = status?.sync
      const counts = meta?.counts || status?.counts || null
      const compatStatus = status?.compat || meta?.compat || { done: 0, total: 0 }
      const cacheAt = status?.cache?.generatedAt
      const nextRefreshAt = status?.settings?.nextAutoRefreshAt
      const enabledSourceCount = (status?.sourceConfig?.sources || []).filter((source) => source.enabled !== false).length
      const hasRows = rows.length > 0
      const showOnboarding = !loading && !hasRows

      const chips = []
      if (Array.isArray(filters.change) && filters.change.length) {
        chips.push({
          key: 'change',
          label: t('change') + ': ' + filters.change.map((value) => t(CHANGE_META[value] ? CHANGE_META[value].labelKey : 'change')).join(', '),
        })
      }
      if (Array.isArray(filters.sources) && filters.sources.length) chips.push({ key: 'sources', label: t('source') + ': ' + filters.sources.map(sourceLabel).join(', ') })
      if (Array.isArray(filters.category) && filters.category.length) chips.push({ key: 'category', label: t('category') + ': ' + filters.category.map((value) => categoryText(value, lang)).join(', ') })
      if (Array.isArray(filters.compat) && filters.compat.length) chips.push({ key: 'compat', label: t('compat') + ': ' + filters.compat.map((value) => compatLabel(value, t)).join(', ') })
      // 旧的 installed 筛选已并入 actions（安装状态就在那一列）。
      // 老会话的 localStorage 里可能还留着 {installed:[...]}：那种值域是 yes/no，
      // 和后面的 installed/not-installed 对不上，以前会渲染出一个说反了的 chip。
      // 这里显式标成残键，加载时会清掉（见 sanitizeFilters）。
      if (Array.isArray(filters.actions) && filters.actions.length) chips.push({ key: 'actions', label: labelFor('actions') + ': ' + filters.actions.map((value) => (ACTION_LABELS[value] ? ACTION_LABELS[value](t) : value)).join(', ') })
      if (Array.isArray(filters.security) && filters.security.length) chips.push({ key: 'security', label: t('securityFilter') + ': ' + filters.security.join(', ') })
      if (typeof filters.version === 'string' && filters.version.trim()) chips.push({ key: 'version', label: t('version') + ': ' + filters.version })
      for (const key of ['users', 'rating', 'market', 'community', 'stars', 'downloads']) {
        const value = filters[key]
        if (value && isRangeActive(value)) chips.push({ key, label: t(key === 'users' ? 'users' : key === 'rating' ? 'rating' : key === 'market' ? 'market' : key === 'community' ? 'community' : key === 'downloads' ? 'downloads' : 'stars') + ': ' + (value.min ?? '−∞') + ' – ' + (value.max ?? '+∞') + (value.includeNull ? ' + ' + t('noData') : '') })
      }
      if (filters.updatedAt && isDateActive(filters.updatedAt)) chips.push({ key: 'updatedAt', label: t('updated') + ': ' + (filters.updatedAt.from || '…') + ' → ' + (filters.updatedAt.to || '…') })

      return h(
        'div',
        { className: 'ml-scroll', style: style.page },
        h('style', { key: 'market-lens-css' }, STYLE_TAG),
        h(
          'div',
          { style: style.column },
          h(
            'div',
            { style: style.header },
            h('div', null,
              h('h1', { style: style.title }, t('title')),
              h('p', { style: style.subtitle }, t('subtitle')),
            ),
            h(
              'div',
              { style: style.headerActions },
              h('span', { style: { ...style.statusPill(sync?.phase === 'error' ? 'error' : sync?.running ? 'accent' : cacheAt ? 'ok' : 'idle'), cursor: 'help' }, title: t('cacheHint') },
                sync?.running
                  ? '● ' + (sync.message || t('syncing'))
                  : cacheAt
                    ? '● ' + t('cacheAt') + ' ' + datePart(cacheAt) + (nextRefreshAt ? ' · ' + t('nextRefresh') + ' ' + nextRefreshAt.slice(11, 16) : '')
                    : '○ ' + t('neverSynced'),
              ),
              // partial 是「部分源超时但目录已保留」：不给红色，否则和真失败混淆。
              !sync?.running && sync?.partial
                ? h('span', {
                    style: { ...style.statusPill('warn'), cursor: 'help' },
                    title: (sync.errors || []).join('\n') || t('partial'),
                  }, '◐ ' + t('partial'))
                : null,
              sync?.running
                ? h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void cancelSync() }, t('cancel'))
                : h('button', { type: 'button', style: buttonStyle(false, syncing || sync?.running, true), onClick: () => void startSync({ force: false }), disabled: syncing || sync?.running }, t('resync')),
              h('button', { type: 'button', style: buttonStyle(false, !hasRows, true), onClick: exportCsv, disabled: !hasRows }, t('exportCsv')),
            ),
          ),
          // 安装回执紧贴页头：轮询会清掉通用 error，但不能清掉这条。
          h(InstallNotice, {
            notice,
            t,
            onClose: () => showNotice(null),
            onRetry: notice && notice.row
              ? () => { const target = notice.row; showNotice(null); void installRow(target) }
              : null,
            // 「仍然安装」：先授精确版本豁免，再带着它重试。
            // 豁免是宿主 compatibility.json 里的东西，写入后可能要到重启才被重新读取，
            // 所以成功后要明确提示这一点（Host 的响应里带 restartRequired）。
            onForce: notice && notice.exemption && notice.exemption.canGrant
              ? () => { void grantAndRetry() }
              : null,
            onManual: notice
              ? () => setManual({
                  spec: notice.spec || (notice.row ? (installTargetForRow(notice.row) || '') : ''),
                  keyword: notice.row ? (notice.row.pkg || notice.row.name || notice.row.title || '') : '',
                  command: notice.row ? (notice.row.installCommand || '') : '',
                })
              : null,
          }),
          h(
            'div',
            { style: style.tabBar },
            h('button', { type: 'button', style: style.tab(view === 'table'), onClick: () => setView('table') }, t('navMarket')),
            h('button', { type: 'button', style: style.tab(view === 'installed'), onClick: () => setView('installed') }, t('navInstalled')),
            h('button', { type: 'button', style: style.tab(view === 'custom'), onClick: () => setView('custom') }, t('navCustom')),
            h('button', { type: 'button', style: style.tab(view === 'sources'), onClick: () => setView('sources') }, t('navSources')),
            h('button', { type: 'button', style: style.tab(view === 'rules'), onClick: () => setView('rules') }, t('navRules')),
            h('button', { type: 'button', style: style.tab(view === 'logs'), onClick: () => setView('logs') }, t('navLogs')),
            h('button', { type: 'button', style: style.tab(view === 'settings'), onClick: () => setView('settings') }, t('navSettings')),
          ),
          error
            ? h(
              'div',
              { style: { ...style.errorBox, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('strong', null, t('error') + ':'),
              h('span', { style: { flex: '1 1 320px', minWidth: 0, wordBreak: 'break-word' } }, error),
              h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void loadStatus({ loadIfReady: true }) }, t('retry')),
              h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void runSelfCheck() }, t('selfCheck')),
              h('button', {
                type: 'button',
                style: buttonStyle(false, false, true),
                onClick: () => {
                  try { void navigator.clipboard.writeText(error) } catch { /* 没有剪贴板权限就跳过 */ }
                },
              }, t('installCopyError')),
            )
            : null,
          sync?.phase === 'error' ? h('div', { style: style.errorBox }, h('strong', null, t('syncFailed') + ': '), sync.message || '—') : null,
          sync?.errors?.length ? h('div', { style: { ...style.muted, fontSize: 11.5 } }, h('strong', null, t('sourceErrors') + ': '), sync.errors.slice(0, 4).join(' · ')) : null,
          view === 'sources'
            ? h(SourcesPage, {
                status,
                t,
                lang,
                onStatus: loadStatus,
                onSync: startSync,
                onCleared: async () => { setRows([]); setMeta(null); await loadStatus() },
              })
            : view === 'installed'
              ? h(InstalledPage, {
                  status,
                  rows,
                  t,
                  lang,
                  updating: Boolean(updating),
                  updatesStatus,
                  actionBusy,
                  onCheckUpdates: () => void checkUpdates(),
                  onUpgrade: (item) => void upgradeRow(item),
                  onRefresh: () => void loadStatus(),
                })
              : view === 'custom'
                ? h(CustomInstallPage, { t, lang, onInstalled: loadStatus })
                : view === 'rules'
                  ? h(RulesPage, { status, t, lang, onStatus: loadStatus })
                  : view === 'logs'
                    ? h(LogsPage, { t, lang })
                    : view === 'settings'
                  ? h(SettingsPage, {
                      status,
                      t,
                      lang,
                      onOpenColumns: (event) => setOpenPopover({ type: 'columns', rect: event.currentTarget.getBoundingClientRect() }),
                      onOpenSchedule: (event) => setOpenPopover({ type: 'schedule', rect: event.currentTarget.getBoundingClientRect() }),
                      onExport: () => void exportConfig(),
                      onImport: () => fileInputRef.current && fileInputRef.current.click(),
                      transfer,
                      repoInfo: status?.repo || null,
                      githubStats,
                    })
              : h(
                React.Fragment,
                null,
                h('div', { style: style.summary },
                  status?.runtime?.runtimeVersion ? h('span', { style: style.chip }, 'DSH ' + status.runtime.runtimeVersion) : null,
                  counts ? h('span', { style: style.chip }, t('total') + ' · ' + formatNumber(counts.total)) : null,
                  counts ? h('span', { style: style.chip }, t('withUsers') + ' · ' + formatNumber(counts.withUsers)) : null,
                  counts ? h('span', { style: style.chip }, t('withRating') + ' · ' + formatNumber(counts.withRating)) : null,
                  counts ? h('span', { style: style.chip }, t('compatible') + ' · ' + formatNumber(counts.withCompatibility)) : null,
                  counts ? h('span', { style: style.chip }, t('installedCount') + ' · ' + formatNumber(counts.installed)) : null,
                  meta?.diff && !meta.diff.baselined && (meta.diff.added || meta.diff.updated || meta.diff.removed)
                    ? h('span', { style: style.chip }, t('change') + ' · +' + formatNumber(meta.diff.added) + ' / ~' + formatNumber(meta.diff.updated) + ' / −' + formatNumber(meta.diff.removed))
                    : null,
                  availableUpdates
                    ? h('span', { style: style.chip }, t('updateAvailable') + ' · ' + formatNumber(availableUpdates))
                    : null,
                  compatStatus?.total && compatStatus.done < compatStatus.total ? h('span', { style: style.chip }, t('compatProgress') + ' · ' + formatNumber(compatStatus.done) + '/' + formatNumber(compatStatus.total)) : null,
                ),
                showOnboarding
                  ? h(Onboarding, { status, t, onSync: startSync })
                  : h(
                      React.Fragment,
                      null,
                      h('div', { style: style.toolbar },
                        h('input', { style: style.search, value: search, placeholder: t('searchPlaceholder'), onChange: (event) => setSearch(event.target.value) }),
                        h('button', {
                          type: 'button',
                          style: buttonStyle(false, false, true),
                          onClick: (event) => setOpenPopover({ type: 'sources', rect: event.currentTarget.getBoundingClientRect() }),
                        }, t('pluginSources') + ' (' + enabledSourceCount + ')'),
                        h('button', {
                          type: 'button',
                          style: buttonStyle(false, false, true),
                          onClick: (event) => setOpenPopover({ type: 'columns', rect: event.currentTarget.getBoundingClientRect() }),
                        }, t('columns')),
                        h('button', {
                          type: 'button',
                          style: buttonStyle(Boolean(nextRefreshAt), false, true),
                          onClick: (event) => setOpenPopover({ type: 'schedule', rect: event.currentTarget.getBoundingClientRect() }),
                        }, t('schedule') + (nextRefreshAt ? ' · ' + nextRefreshAt.slice(11, 16) : '')),
                        h('button', {
                          type: 'button',
                          style: buttonStyle(onlyChanged, false, true),
                          onClick: toggleOnlyChanged,
                          title: meta?.diff?.baselined ? t('baselinedNote') : t('changeNote'),
                        }, t('onlyChanged') + (changeCount ? ' (' + changeCount + ')' : '')),
                        h('button', {
                          type: 'button',
                          style: buttonStyle(safeView, false, true),
                          onClick: () => void toggleSafeView(),
                          title: t('safeViewNote'),
                        }, t('safeView') + (safeView ? ' ✓' : '')),
                        h('button', {
                          type: 'button',
                          style: buttonStyle(false, updatesBusy, true),
                          onClick: () => void checkUpdates(),
                          disabled: updatesBusy,
                          title: t('updateSource') + ': ' + (updatesStatus?.source === 'pluginManager'
                            ? t('updateSourceOfficial')
                            : updatesStatus?.source === 'mixed' ? 'pluginManager + npm' : t('updateSourceNpm')),
                        }, updatesBusy
                          ? (updatesStatus?.total
                              ? t('updateRunning') + ' ' + formatNumber(updatesStatus.done || 0) + '/' + formatNumber(updatesStatus.total)
                              : t('updateQueued'))
                          : t('updateCheck') + (availableUpdates ? ' (' + availableUpdates + ')' : '')),
                        // 导入按钮留在工具栏之外：设置页已经有「导出 / 导入配置」，
                        // 这里再放一份就是两个入口干同一件事，而且工具栏是高频操作区。
                        h('input', {
                          ref: fileInputRef,
                          type: 'file',
                          accept: 'application/json,.json',
                          style: { display: 'none' },
                          onChange: (event) => {
                            const file = event.target.files && event.target.files[0]
                            void importConfig(file)
                          },
                        }),
                        h('button', { type: 'button', style: buttonStyle(false, activeCount === 0, true), onClick: clearFilters, disabled: activeCount === 0 }, t('clearFilters') + (activeCount ? ' (' + activeCount + ')' : '')),
                      ),
                      // 源级新鲜度：多源聚合下，某个源挂了会让它的条目「凭空消失」，
                      // 用户看到的就是「这个插件没有」，而其实是「源没拉到」。
                      // 数据一直在 status.sourceHealth 里，只是从没上过市场页 ——
                      // 以前只在「来源」页能看到，而用户排查"搜不到"时不会去那儿。
                      freshnessBanner,
                      // 安全视图藏了东西就必须说清楚藏了多少，否则用户会以为目录缺条目
                      safeView && hiddenBySafeView > 0
                        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
                            h('span', null, t('safeViewHidden') + formatNumber(hiddenBySafeView) + t('safeViewHiddenTail')),
                            h('button', { type: 'button', style: buttonStyle(false, false, true), onClick: () => void toggleSafeView() }, t('showAllPlugins')),
                          )
                        : null,
                      transfer
                        ? h('div', { style: { fontSize: 11.5, color: transfer.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, transfer.text)
                        : null,
                      chips.length
                        ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                            ...chips.map((chip) =>
                              h('span', { key: chip.key, style: { ...style.chip, color: 'var(--dsw-alias-label-primary)' } },
                                chip.label,
                                h('button', {
                                  type: 'button',
                                  title: t('clearFilter'),
                                  style: { appearance: 'none', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: 0, font: 'inherit' },
                                  onClick: () => {
                                    const next = { ...filters }
                                    delete next[chip.key]
                                    setFilters(next)
                                  },
                                }, '×'),
                              ),
                            ),
                          )
                        : null,
                      h(Table, {
                        rows: sorted,
                        allRows: rows,
                        columns: visibleColumns,
                        columnWidths,
                        gridTemplate,
                        tableMinWidth,
                        onResizeStart: startResize,
                        filters,
                        setFilters,
                        sort,
                        setSort,
                        scrollRef: tableScrollRef,
                        page,
                        setPage,
                        pageSize,
                        setPageSize,
                        onOpenDetail: setDetailId,
                        t,
                        lang,
                        showFilters,
                        onInstall: installRow,
                        actionBusy,
                        installedKeys,
                        onSync: () => startSync({ force: false }),
                      }),
                      enabledSourceNames.length
                        ? h('div', { style: { ...style.muted, fontSize: 11.5, lineHeight: 1.6 } },
                            t('dataFrom') + ': ' + enabledSourceNames.join(' · '))
                        : null,
                      openPopover?.type === 'sources'
                        ? h(SourceManagerPopover, {
                            anchor: openPopover.rect,
                            status,
                            onClose: () => setOpenPopover(null),
                            onStatus: loadStatus,
                            onSync: () => { setOpenPopover(null); void startSync({ force: false }) },
                            onOpenSources: () => { setOpenPopover(null); setView('sources') },
                            filters,
                            setFilters,
                            t,
                            lang,
                          })
                        : null,
                      openPopover?.type === 'columns'
                        ? h(ColumnSettingsPopover, {
                            anchor: openPopover.rect,
                            onClose: () => setOpenPopover(null),
                            visibility: columnVisibility,
                            setVisibility: setColumnVisibility,
                            onReset: () => {
                              setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS })
                              setColumnVisibility({ ...DEFAULT_COLUMN_VISIBILITY })
                              setShowFilters(true)
                            },
                            showFilters,
                            setShowFilters,
                            t,
                            lang,
                          })
                        : null,
                      openPopover?.type === 'schedule'
                        ? h(SchedulePopover, {
                            anchor: openPopover.rect,
                            status,
                            onClose: () => setOpenPopover(null),
                            onStatus: loadStatus,
                            onSync: () => void startSync({ force: false }),
                            t,
                            lang,
                          })
                        : null,
                    ),
              ),
        ),
        detailId ? h(DetailDrawer, {
          id: detailId,
          onClose: () => setDetailId(null),
          t,
          lang,
          runtime: status?.runtime,
          onNotice: showNotice,
          onManualInstall: (target) => setManual(target),
          onInstalled: async () => {
            // detailId 就是 Host 的 row.id（publicRow 的 id），用 rowKeyOf 统一比，避免再出现 undefined 比对。
            setRows((previous) => previous.map((candidate) => (
              rowKeyOf(candidate) === detailId ? { ...candidate, installed: true } : candidate
            )))
            await Promise.all([loadStatus().catch(() => {}), loadCatalog().catch(() => {})])
          },
        }) : null,
        manual ? h(ManualInstallWindow, { target: manual, t, lang, onClose: () => setManual(null) }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        localeRef.service = ctx.get('locale') || null
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: navLabel }, PanelIcon),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage)),
        )
      },
    }
  },
})

