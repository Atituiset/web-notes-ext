// Memory 检索评测数据集 — 纯数据，无逻辑
// 结构：
//   memories: 待写入的记忆语料（含 daysOld，由 runner 换算成 created/updated 日期）
//   queries:  带标准答案的查询（expect = 相关记忆 id 列表）
//   makeNoise(n): 确定性噪声记忆生成器（延迟-规模曲线用，不进 recall 评测）
//
// 类别设计覆盖检索层的关键能力面：事实召回 / 偏好召回 / 知识更新 /
// tag 加权 / 拒答 / 中英混合 / 噪声抗干扰。

export const memories = [
  // ---- preference（10，中文 7 / 英文 3）----
  { id: 'p1', scope: 'user', body: '用户偏好简洁的中文回答，不喜欢长篇大论的客套话。', tags: ['preference'], confidence: 'high', pinned: false, hits: 5, daysOld: 40 },
  { id: 'p2', scope: 'user', body: '代码注释希望保留英文原文，不要翻译成中文。', tags: ['preference', 'code'], confidence: 'high', pinned: false, hits: 2, daysOld: 30 },
  { id: 'p3', scope: 'user', body: '用户习惯用 Obsidian 管理笔记，导出格式要兼容 Dataview 查询。', tags: ['preference', 'obsidian'], confidence: 'medium', pinned: false, hits: 1, daysOld: 60 },
  { id: 'p4', scope: 'user', body: '回答技术问题时优先给出可运行的最小示例，再讲原理。', tags: ['preference'], confidence: 'medium', pinned: false, hits: 0, daysOld: 15 },
  { id: 'p5', scope: 'user', body: '用户不喜欢被推荐付费服务，优先推荐开源或本地方案。', tags: ['preference'], confidence: 'medium', pinned: false, hits: 3, daysOld: 90 },
  { id: 'p6', scope: 'user', body: '读书笔记按「原文-理解-行动」三段式记录，不要只摘抄。', tags: ['preference', 'reading'], confidence: 'high', pinned: false, hits: 1, daysOld: 20 },
  { id: 'p7', scope: 'user', body: '所有回答使用简体中文，专业术语保留英文原词。', tags: ['preference', 'language'], confidence: 'high', pinned: true, hits: 8, daysOld: 120 },
  { id: 'p8', scope: 'user', body: 'User prefers dark mode in all development tools and editors.', tags: ['preference', 'ui'], confidence: 'medium', pinned: false, hits: 0, daysOld: 50 },
  { id: 'p9', scope: 'user', body: 'User wants shell commands shown with explanations for each flag, never bare commands.', tags: ['preference', 'cli'], confidence: 'high', pinned: false, hits: 2, daysOld: 25 },
  { id: 'p10', scope: 'user', body: 'User prefers incremental commits with detailed messages over large squashed commits.', tags: ['preference', 'git'], confidence: 'medium', pinned: false, hits: 1, daysOld: 70 },

  // ---- fact（10，中文 7 / 英文 3）----
  { id: 'f1', scope: 'user', body: 'clangd 的 Protocol.h 定义了 LSP 协议的 C++ 数据结构，重点是 Position/Range/TextEdit 的 JSON 映射。', tags: ['fact', 'clangd'], confidence: 'high', pinned: false, hits: 4, daysOld: 35 },
  { id: 'f2', scope: 'user', body: 'Chrome MV3 的 service worker 会在 30 秒空闲后休眠，长连接请求不能放在里面。', tags: ['fact', 'chrome'], confidence: 'high', pinned: false, hits: 6, daysOld: 45 },
  { id: 'f3', scope: 'user', body: 'IndexedDB 在 service worker 中可用，localStorage 不可用，这是 MV3 存储选型的重要原因。', tags: ['fact', 'chrome', 'storage'], confidence: 'high', pinned: false, hits: 2, daysOld: 55 },
  { id: 'f4', scope: 'user', body: 'Filesystem Access API 的目录句柄可以持久化到 IndexedDB，但权限不会随句柄保留，重启后需重新 query。', tags: ['fact', 'fs-access'], confidence: 'medium', pinned: false, hits: 1, daysOld: 65 },
  { id: 'f5', scope: 'user', body: '艾宾浩斯遗忘曲线描述记忆保留率随时间指数衰减，间隔重复是对抗遗忘的有效手段。', tags: ['fact', 'memory'], confidence: 'medium', pinned: false, hits: 3, daysOld: 80 },
  { id: 'f6', scope: 'user', body: '费曼技巧的核心是用自己的话把概念讲给别人听，讲不清楚就是没有真正理解。', tags: ['fact', 'learning'], confidence: 'medium', pinned: false, hits: 2, daysOld: 18 },
  { id: 'f7', scope: 'user', body: 'BM25 是词面检索的经典打分函数，由词频饱和和文档长度归一化两部分构成。', tags: ['fact', 'retrieval'], confidence: 'medium', pinned: false, hits: 0, daysOld: 100 },
  { id: 'f8', scope: 'user', body: 'SQLite has built-in JSON1 extension, so JSON columns can be queried without external tools.', tags: ['fact', 'sqlite'], confidence: 'high', pinned: false, hits: 1, daysOld: 12 },
  { id: 'f9', scope: 'user', body: 'Ollama exposes an OpenAI-compatible endpoint at localhost:11434/v1, so OpenAI clients work unchanged.', tags: ['fact', 'ollama'], confidence: 'high', pinned: false, hits: 5, daysOld: 28 },
  { id: 'f10', scope: 'user', body: 'Vector embeddings capture semantic similarity, but pure vector retrieval struggles with multi-hop and temporal questions.', tags: ['fact', 'retrieval'], confidence: 'medium', pinned: false, hits: 1, daysOld: 40 },

  // ---- correction（10，中文 7 / 英文 3，含知识更新对 ku1/ku2/ku3）----
  { id: 'c1', scope: 'user', body: '之前以为 flex 布局的 gap 属性浏览器兼容性很差需要回退 margin 方案。', tags: ['correction', 'css'], confidence: 'low', pinned: false, hits: 0, daysOld: 200 },
  { id: 'c2', scope: 'user', body: '已确认 flex 布局的 gap 属性已被主流浏览器全面支持，可以直接使用无需回退。', tags: ['correction', 'css'], confidence: 'high', pinned: false, hits: 2, daysOld: 6 },
  { id: 'c3', scope: 'user', body: '曾认为 content script 可以直接访问页面 window 上的变量，实际它运行在隔离世界。', tags: ['correction', 'chrome'], confidence: 'high', pinned: false, hits: 3, daysOld: 50 },
  { id: 'c4', scope: 'user', body: '纠正：obsidian:// URI 方案在内容超过约 2KB 时会截断，不能作为大文件导出通道。', tags: ['correction', 'obsidian'], confidence: 'high', pinned: false, hits: 1, daysOld: 75 },
  { id: 'c5', scope: 'user', body: '误以为长上下文模型不需要外部记忆，实际超长上下文中模型对中段信息的利用率显著下降。', tags: ['correction', 'memory'], confidence: 'medium', pinned: false, hits: 2, daysOld: 33 },
  { id: 'c6', scope: 'user', body: 'Previously believed SQLite could not do JSON querying at all and needed a document database.', tags: ['correction', 'sqlite'], confidence: 'low', pinned: false, hits: 0, daysOld: 180 },
  { id: 'c7', scope: 'user', body: 'Confirmed SQLite JSON1 functions cover the querying needs, no separate document store required.', tags: ['correction', 'sqlite'], confidence: 'high', pinned: false, hits: 1, daysOld: 10 },
  { id: 'c8', scope: 'user', body: '曾以为 service worker 里可以直接操作 DOM 来渲染侧栏内容，实际必须用扩展页面。', tags: ['correction', 'chrome'], confidence: 'medium', pinned: false, hits: 1, daysOld: 60 },
  { id: 'c9', scope: 'user', body: 'Used to think embedding models must run in the cloud, but Ollama serves local embedding models fine.', tags: ['correction', 'ollama'], confidence: 'medium', pinned: false, hits: 0, daysOld: 22 },
  { id: 'c10', scope: 'user', body: '原以为笔记工具必须配云端同步，本地文件配合 Obsidian 的同步插件已经足够。', tags: ['correction', 'obsidian'], confidence: 'medium', pinned: false, hits: 1, daysOld: 88 },

  // ---- conclusion（10，中文 7 / 英文 3）----
  { id: 'k1', scope: 'user', body: '结论：LLM 流式请求必须放在扩展页面侧执行，绕开 service worker 休眠问题。', tags: ['conclusion', 'chrome'], confidence: 'high', pinned: false, hits: 4, daysOld: 42 },
  { id: 'k2', scope: 'user', body: '结论：记忆检索在个人规模下词面匹配加时间衰减就够用，不需要引入向量数据库。', tags: ['conclusion', 'memory', 'retrieval'], confidence: 'medium', pinned: false, hits: 2, daysOld: 26 },
  { id: 'k3', scope: 'user', body: '结论：主动阅读的关键是制造提取动作，划线和用自己的话写笔记比重复阅读有效得多。', tags: ['conclusion', 'reading'], confidence: 'high', pinned: false, hits: 3, daysOld: 16 },
  { id: 'k4', scope: 'user', body: '结论：上下文预算应该集中管理，材料按选区、笔记、正文的优先级装入。', tags: ['conclusion', 'context'], confidence: 'medium', pinned: false, hits: 1, daysOld: 38 },
  { id: 'k5', scope: 'user', body: '结论：幂等导出比增量导出更可靠，以本地笔记库为准整文件重写避免冲突。', tags: ['conclusion', 'obsidian'], confidence: 'high', pinned: false, hits: 2, daysOld: 52 },
  { id: 'k6', scope: 'user', body: '结论：划线工具的选区要用字符偏移定位而不是 DOM 路径，页面重渲染后更稳定。', tags: ['conclusion', 'design'], confidence: 'medium', pinned: false, hits: 0, daysOld: 95 },
  { id: 'k7', scope: 'user', body: '结论：记忆文件就是普通 Markdown，让用户能在自己的笔记软件里直接查看和修改。', tags: ['conclusion', 'memory'], confidence: 'high', pinned: false, hits: 2, daysOld: 30 },
  { id: 'k8', scope: 'user', body: 'Conclusion: three-factor ranking (recency, importance, relevance) beats pure recency for memory retrieval.', tags: ['conclusion', 'retrieval'], confidence: 'medium', pinned: false, hits: 1, daysOld: 20 },
  { id: 'k9', scope: 'user', body: 'Conclusion: local-first storage with optional sync beats mandatory cloud for personal knowledge tools.', tags: ['conclusion', 'privacy'], confidence: 'high', pinned: false, hits: 2, daysOld: 44 },
  { id: 'k10', scope: 'user', body: 'Conclusion: memory hits should feed back into ranking, so frequently recalled memories surface more easily.', tags: ['conclusion', 'memory'], confidence: 'medium', pinned: false, hits: 1, daysOld: 24 },
];

export const queries = [
  // ---- fact-recall ×6 ----
  { id: 'q1', q: 'clangd 的 Protocol.h 里重点要看哪些类型？', expect: ['f1'], category: 'fact-recall', relevant: ['f1'] },
  { id: 'q2', q: 'MV3 的 service worker 为什么会中断长连接？', expect: ['f2'], category: 'fact-recall', relevant: ['f2', 'k1'] },
  { id: 'q3', q: '为什么 MV3 里存储要用 IndexedDB 而不是 localStorage？', expect: ['f3'], category: 'fact-recall', relevant: ['f3'] },
  { id: 'q4', q: '目录句柄持久化之后权限还在吗？', expect: ['f4'], category: 'fact-recall', relevant: ['f4'] },
  { id: 'q5', q: '遗忘曲线讲的是什么规律？', expect: ['f5'], category: 'fact-recall', relevant: ['f5'] },
  { id: 'q6', q: 'BM25 打分由哪几部分构成？', expect: ['f7'], category: 'fact-recall', relevant: ['f7'] },

  // ---- preference-recall ×4 ----
  { id: 'q7', q: '回答风格上我有什么偏好？', expect: ['p1', 'p4', 'p7'], category: 'preference-recall', relevant: ['p1', 'p4', 'p7', 'p2'] },
  { id: 'q8', q: '代码注释应该用什么语言写？', expect: ['p2'], category: 'preference-recall', relevant: ['p2', 'p7'] },
  { id: 'q9', q: '推荐工具时应该注意我的什么倾向？', expect: ['p5'], category: 'preference-recall', relevant: ['p5', 'k9', 'c10'] },
  { id: 'q10', q: '我的读书笔记是什么格式？', expect: ['p6'], category: 'preference-recall', relevant: ['p6'] },

  // ---- knowledge-update ×3（新版必须排在旧版前）----
  { id: 'q11', q: 'flex 布局的 gap 属性能不能直接用？', expect: ['c2'], expectBefore: { newer: 'c2', older: 'c1' }, category: 'knowledge-update', relevant: ['c1', 'c2'] },
  { id: 'q12', q: 'SQLite can query JSON columns, right?', expect: ['c7', 'f8'], expectBefore: { newer: 'c7', older: 'c6' }, category: 'knowledge-update', relevant: ['c6', 'c7', 'f8'] },
  { id: 'q13', q: 'content script 能直接读页面 window 变量吗？', expect: ['c3'], category: 'knowledge-update', relevant: ['c3'] },

  // ---- tag-boost ×3（正文不含查询关键词，靠 tags 命中）----
  { id: 'q14', q: 'clangd 相关的东西我记过什么？', expect: ['f1'], category: 'tag-boost', relevant: ['f1'] },
  { id: 'q15', q: 'ollama 本地部署有什么要点？', expect: ['f9', 'c9'], category: 'tag-boost', relevant: ['f9', 'c9'] },
  { id: 'q16', q: 'git 提交习惯上我有什么讲究？', expect: ['p10'], category: 'tag-boost', relevant: ['p10'] },

  // ---- abstain ×4（语料中无相关记忆，期望零注入）----
  { id: 'q17', q: '怎么做天然酵母酸面包？', expect: [], category: 'abstain', relevant: [] },
  { id: 'q18', q: 'Kubernetes 的 HPA 怎么配置？', expect: [], category: 'abstain', relevant: [] },
  { id: 'q19', q: '2026 年世界杯冠军是谁？', expect: [], category: 'abstain', relevant: [] },
  { id: 'q20', q: 'How do I replace the battery of a ThinkPad X1?', expect: [], category: 'abstain', relevant: [] },

  // ---- en-mixed ×3 ----
  { id: 'q21', q: 'Does Ollama work with OpenAI client libraries?', expect: ['f9'], category: 'en-mixed', relevant: ['f9'] },
  { id: 'q22', q: 'What are the limits of pure vector retrieval?', expect: ['f10'], category: 'en-mixed', relevant: ['f10'] },
  { id: 'q23', q: 'How should memory hits influence ranking?', expect: ['k10'], category: 'en-mixed', relevant: ['k10', 'k8'] },

  // ---- paraphrase ×8（改述：查询与记忆措辞完全不同、语义相同，测词法检索的语义天花板）----
  { id: 'q26', q: '为什么我的流式回答总是中途断掉？', expect: ['f2'], category: 'paraphrase', relevant: ['f2', 'k1'] },
  { id: 'q27', q: '学过的东西很快就忘，该怎么办？', expect: ['f5'], category: 'paraphrase', relevant: ['f5'] },
  { id: 'q28', q: '以后回复我能不能别那么啰嗦？', expect: ['p1'], category: 'paraphrase', relevant: ['p1', 'p7'] },
  { id: 'q29', q: '怎样读书才能记得牢？', expect: ['k3'], category: 'paraphrase', relevant: ['k3', 'f6'] },
  { id: 'q30', q: 'OpenAI 的 SDK 想直接连本地模型，改个地址就行吗？', expect: ['f9'], category: 'paraphrase', relevant: ['f9'] },
  { id: 'q31', q: 'why does my assistant fail when a question needs two facts at once?', expect: ['f10'], category: 'paraphrase', relevant: ['f10'] },
  { id: 'q32', q: "don't just dump commands on me, tell me what each part does", expect: ['p9'], category: 'paraphrase', relevant: ['p9'] },
  { id: 'q33', q: '我记的东西下次还能被想起来吗，还是说过段时间就沉底了？', expect: ['k10'], category: 'paraphrase', relevant: ['k10', 'f5'] },

  // ---- noise-robust ×2（词面高重合但语义无关，不应被误导）----
  { id: 'q24', q: 'CSS 盒模型里 padding 指什么？', expect: ['c1', 'c2'], category: 'fact-recall', relevant: ['c1', 'c2'] },
  { id: 'q25', q: '记忆面包和记忆曲线有什么关系？', expect: ['f5'], category: 'noise-robust', relevant: ['f5'] },
];

// ---- 噪声记忆生成器（确定性 LCG，延迟-规模曲线用）----
const NOISE_TOPICS = ['笔记', '协议', '布局', '缓存', '索引', '摘要', '句柄', '检索', '导出', '会话', '窗口', '队列'];
const NOISE_ATTRS = ['性能', '兼容性', '稳定性', '可维护性', '一致性', '安全性', '可用性', '扩展性'];
const NOISE_TAILS = ['需要进一步验证', '已有明确结论', '在实践中被反复确认', '存在边界情况', '与预期一致', '需要关注'];

export function makeNoise(n) {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      scope: 'user',
      body: `关于${pick(NOISE_TOPICS)}的${pick(NOISE_ATTRS)}问题，${pick(NOISE_TAILS)}。噪声条目编号${i}。`,
      tags: ['noise'],
      confidence: 'low',
      pinned: false,
      daysOld: Math.floor(rand() * 200),
    });
  }
  return out;
}
