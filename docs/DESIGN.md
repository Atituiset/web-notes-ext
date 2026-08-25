# Web Notes Ext — 网页笔记 → Obsidian → LLM 问答 浏览器插件 设计文档（草稿）

> **状态**：设计草稿 v0.1（2026-08-25）
> **本文档的用途**：作为 session 切换/新会话的唯一上下文入口。所有决策背景、参考代码位置、坑位都在这里，不需要读历史对话。
> **一句话定位**：在任意网页上划词记笔记，一键沉淀到本地 Obsidian vault，并带着页面内容+已有笔记实时问大模型。

---

## 0. 参考资产（新会话必读）

| 资产 | 路径 | 可复用内容 |
|------|------|-----------|
| **notes.js 原型** | `/home/atituiset/Projects/computer-science/notes.js` | 完整可用的划词笔记实现：选区→字符偏移锚定、`<mark>` 重高亮、面板 UI、localStorage 存储。576 行零依赖 vanilla JS |
| **增强版** | `/home/atituiset/Projects/ai-infra-collect/docs/notes.js` | 在原型基础上加了"整页/全站导出 Markdown 文件"（Blob 下载），661 行 |
| **宿主项目背景** | 两个 mdBook 站点（computer-science、ai-infra）已内置 notes.js——本插件未来可直接兼容/替代它们 |

复用策略：把 notes.js 的核心逻辑（`captureSelection` / `textLengthUpTo` / `applyHighlight` / `unwrapMarks`）移植为 content script，存储层从 localStorage 换成 IndexedDB（经 service worker），其余交互逻辑基本平移。

---

## 1. 动机与市场空白

三个能力单独看都有成熟产品，**组合起来是空白**：

| 能力 | 现有产品 | 缺口 |
|------|---------|------|
| 网页标注 | Hypothes.is | 数据锁在它家服务器，无 LLM |
| 剪藏到 Obsidian | Obsidian Web Clipper（官方） | 只做整页剪藏，无划词标注、无 LLM |
| 网页 LLM 对话 | Sider / Glarity / Monica | 笔记不流入自己的知识库 |

**目标闭环**：阅读 → 划词标注 + 写心得 → 一键进自己的 vault → 选区/整页问模型 → 有价值的问答也回写笔记。

**非目标（防 scope creep）**：
- 不做多设备同步（数据本地为准，导出即同步）
- 不做 PDF/EPUB 标注（V2 再议）
- 不做团队协作/分享链接
- 不做账号系统

## 2. 核心功能需求

### F1 划词标注（content script）
- 选中正文文字 → 浮动工具条「📝 记笔记」→ 弹窗输入（支持 Markdown）
- 刷新后自动重高亮；点击高亮可查看/编辑/删除
- 锚定方案：MVP 用**字符偏移**（继承 notes.js）；V2 加 TextQuoteSelector 兜底动态页面

### F2 导出到本地 Obsidian
- 主通道：**Filesystem Access API**——用户一次性授权 vault 目录，句柄持久化到 IndexedDB
- 幂等写入：同一 URL 永远更新同一个 `.md` 文件（按 frontmatter `source` 字段匹配），不产生重复文件
- 兜底通道：`obsidian://new?...` URI（零配置但大内容受限）；高级选项：Local REST API 插件（127.0.0.1:27123）

### F3 LLM 实时问答（side panel）
- 触发：选中文字问 / 整页问 / 基于"该页已有笔记"问
- 流式输出（SSE）；问答记录可选存为该页笔记（一并导出）
- Provider 抽象统一云端 BYOK 与本地 Ollama

### 三者联动的灵魂
**上下文构建器**：`Readability 提取的正文 + 用户当前选区 + 该页已有笔记` 组装成 prompt。用户的标注成为模型的上下文——这是与所有竞品的本质差异。

## 3. 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| 平台 | Chrome MV3（兼容 Edge） | Filesystem Access API 是 Chromium-only，正好是主通道依赖 |
| 框架 | **vanilla JS 起步**（延续 notes.js 零依赖风格）；复杂后再迁 WXT/Vite | MVP 体量小，构建链是负资产 |
| 存储 | IndexedDB（service worker 内） | localStorage 在 SW 不可用；MV3 SW 会休眠，IndexedDB 是官方推荐持久层；顺带存 FileSystemDirectoryHandle |
| 正文提取 | @mozilla/readability 或自写简化版 | 标准算法，DOMParser + 打分 |
| UI | Side Panel API（chrome.sidePanel）+ content script 注入样式 | 比 popup 空间大、不随点击关闭 |

**目录结构（规划）**：
```
web-notes-ext/
├── docs/DESIGN.md          ← 本文档
├── manifest.json           # MV3
├── src/
│   ├── background/
│   │   └── sw.js           # service worker: 存储/导出/LLM 网关
│   ├── content/
│   │   ├── annotator.js    # notes.js 移植: 选区捕获/高亮/工具条
│   │   └── extract.js      # Readability 正文提取
│   ├── panel/
│   │   ├── panel.html/js   # side panel: 笔记列表 + 聊天流式 UI
│   ├── lib/
│   │   ├── db.js           # IndexedDB 封装 (stores: pages, notes, handles, settings)
│   │   ├── obsidian.js     # 三通道导出器 (fs-access / uri / rest-api)
│   │   ├── llm/
│   │   │   ├── index.js    # provider 抽象 + SSE 解析
│   │   │   ├── openai.js / anthropic.js / openrouter.js / ollama.js
│   │   │   └── context.js  # 上下文构建器 ★灵魂组件
│   │   └── markdown.js     # frontmatter 渲染/解析 (幂等匹配用)
│   └── options/            # 设置页: provider/key/vault 授权/导出模板
└── icons/
```

## 4. 关键设计决策（含理由，防止未来反复）

### D1 Obsidian 通道 = Filesystem Access API 主 + URI 兜底
```js
// 首次授权 (必须在用户手势内调用)
const handle = await showDirectoryPicker({ mode: 'readwrite' });
await idbPut('handles', 'vault', handle);       // 句柄持久化

// 后续使用前恢复权限
const h = await idbGet('handles', 'vault');
if ((await h.queryPermission({mode:'readwrite'})) !== 'granted')
  // 需要 UI 提示用户点一次按钮重新授权 (浏览器安全模型, 无绕过)
```
- 已知限制：权限重启后可能需要一次点击恢复（Chrome 的 persistent permissions 在演进，代码要兼容两种状态）
- `obsidian://new?vault=X&file=Y&content=<encodeURIComponent(md)>` 作为未授权时的降级路径（注意 ~2KB 以上的 content 要提示走主通道）

### D2 LLM Provider 统一抽象
```js
// 统一接口: streamChat({messages, model, onToken}) -> AsyncIterable<string>
// - OpenAI/OpenRouter/Ollama: 标准 OpenAI chat completions 格式 (ollama 跑在 http://localhost:11434/v1)
// - Anthropic: 必须带 header 'anthropic-dangerous-direct-browser-access': 'true'
//   且 system 放顶层字段、max_tokens 必填 —— 在 anthropic.js 里抹平差异
```
- Key 存 chrome.storage.local（仅本机），设置页明示；绝不硬编码

### D3 上下文构建器（context.js）★ 本产品差异化核心
```
组装顺序（预算内从上往下装）:
  [system] 你是阅读助手; 回答基于给定材料, 材料没有的说不知道
  [材料1] 页面正文 (Readability, 截断到 token 预算, 保留标题结构)
  [材料2] 用户在该页的已有笔记 (时间序)   ← 让模型知道"我已经想到了什么"
  [材料3] 当前选区原文 (若有)
  [question]
```

### D4 幂等导出
- 文件名：`<vault>/Clippings/<域名>-<slug>.md`（可在设置改目录模板）
- 写入前扫描已有文件的 frontmatter `source:`；命中则整文件重写（以本地笔记库为准），未命中则新建
- frontmatter 固定字段：`source / title / clipped / updated / tags`

### D5 SPA 与动态页面
- content script 监听 URL 变化（patch history.pushState + popstate），变化时卸载旧高亮、重载对应页笔记
- DOM 变化导致偏移漂移：MVP 接受并在高亮失败时静默跳过（笔记数据无损）；V2 引入 TextQuoteSelector（前缀/后缀各 32 字符）模糊重锚定

## 5. 数据模型（IndexedDB）

```
db: web-notes-ext v1
├── pages: keyPath=url        { url, title, host, lastVisited }
├── notes: keyPath=id, index:url
│     { id, url, ts, updatedAt, content, sel:{start,end,text}|null,
│       kind: 'manual'|'ai-qa', aiMeta:{provider,model,q,a}|null }
├── handles: key=name         { name:'vault', handle }
└── settings: key=key         { provider, model, apiKeys, vaultDirTemplate, exportAiQA }
```

## 6. MVP 范围与验收标准

**包含**：F1 全部、F2 主通道(fs-access)+URI 兜底、F3 单轮流式问答（OpenAI 兼容 + Ollama + Anthropic）、设置页最小集。

**验收清单**：
- [ ] 在静态文档站（mdbook）划词→刷新→高亮还原率 100%
- [ ] 导出的 .md 在 Obsidian 中打开：frontmatter 正确渲染、callout 高亮块显示正常
- [ ] 同一页面二次导出不产生第二个文件（幂等）
- [ ] Ollama 本地模型流式回答可用；Anthropic 云端流式可用
- [ ] SPA 站点（如 YouTube）切换视频后高亮跟随 URL 切换
- [ ] 断网时：标注与导出功能完全可用（local-first 验证）

**MVP 明确不做**：多轮对话记忆、PDF、图片高亮、TextQuote 锚定、Firefox 适配、i18n。

## 7. 路线图

| 版本 | 内容 | 预估 |
|------|------|------|
| **MVP** | 上节范围 | 1-2 个周末 |
| V2 | TextQuote 锚定、多轮对话、AI-QA 自动入导出、PDF、WXT 迁移(若引入构建) | 之后按需 |
| V3 设想 | 反哺自家站点：插件识别两个 mdBook 并接管 notes.js 数据；Ollama 结构化输出自动打标签 | — |

## 8. 已知坑速查（踩过/调研过的）

1. Anthropic 浏览器直连必须加 `anthropic-dangerous-direct-browser-access` 头，否则 CORS 直接挂
2. `showDirectoryPicker` 必须在用户手势事件内调用，不能在 SW 里调——授权流程要放 options/panel 的按钮里
3. MV3 SW 30s 空闲休眠：长流式响应期间保持 alive 靠 port 心跳或干脆把 fetch+SSE 解析放 panel 侧执行（推荐后者，少一个生命周期问题）
4. localStorage 在 content script 与页面共享 origin 但容量小且同步阻塞——一律走 IndexedDB
5. 某些站点的 CSP 不影响 content script 自身注入，但会影响在其 DOM 里创建 iframe 的方案——避免 iframe 方案
6. `URL.createObjectURL` 下载大文件记得 revokeObjectURL（notes.js 里已有现成模式）

## 9. 开放问题（留给实现阶段决定）

- [ ] 正文提取对中文站的覆盖率实测（Readability 中文表现需抽样验证）
- [ ] token 预算估算：字符数/4 够不够（沿用 my-agent 项目的经验值即可起步）
- [ ] AI 问答默认是否入导出（倾向：设置项开关，默认关）
- [ ] 是否给两个 mdBook 出一个"检测到站内笔记，是否导入插件"的一次性迁移按钮
