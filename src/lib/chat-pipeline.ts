/**
 * 问答流水线 — 从「用户提问」到「LLM 回答落盘」的业务逻辑层。
 *
 * panel.ts 只做渲染与事件绑定；本模块负责：
 *   - token 预算常量集中管理（BUDGET）
 *   - LLM 消息组装：system → 长期记忆 → 多轮 history → 当前问题
 *   - 页面正文提取（chrome.scripting）
 *   - AI 问答存为本页笔记（kind=ai-qa），含同页数量上限裁剪
 *
 * 与 UI 解耦：不操作 DOM，不持有面板状态。
 */

import { buildContext } from './llm/context.js';
import { streamChat } from './llm/index.js';
import { searchMemories } from './memory.js';

// ---------- token / 数量预算（集中管理，接长上下文模型时只改这里） ----------
export const BUDGET = {
  /** 送入上下文的多轮对话条数上限 */
  historyTurns: 8,
  /** 整页正文提取的最大字符数 */
  pageTextMaxChars: 40000,
  /** 记忆压缩时答案截取长度 */
  compressAnswerMaxChars: 2000,
  /** 注入长期记忆的 token 预算 */
  memoryTokenBudget: 1500,
  /** 同一页保留的 ai-qa 笔记上限（超出删最旧） */
  aiQaMaxPerPage: 20,
} as const;

/**
 * 页面正文提取（受限页面返回 null）。
 *
 * 关键：必须注入到 MAIN world。content script 运行在 isolated world，
 * 看不到页面 window 上的 __wneExtract；而 extract.js 是以 content_scripts
 * 方式注册的（isolated world），所以它挂的 __wneExtract 只有 MAIN world
 * 注入的代码才能读到……反过来才对：content_scripts 默认 isolated world，
 * 页面 JS 与 MAIN-world 注入共享同一个 window，因此这里用 world: 'MAIN'
 * 才能访问 content script 挂到「页面可见 window」上的函数——前提是
 * extract.js 自己也在 MAIN world 注册（见 manifest.json）。
 */
export async function extractPageText(tabId: number): Promise<string | null> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN', // 与页面 window 同世界才能看到 __wneExtract
      func: () => ((window as any).__wneExtract ? (window as any).__wneExtract() : null),
    });
    return res && res.result ? String(res.result.text || '') : null;
  } catch {
    return null; /* 受限页面 */
  }
}

/**
 * 组装 LLM 消息序列：
 *   [system(页面材料+指令)] + [长期记忆(并入 system 语义)] + [多轮 history] + [当前问题]
 * 记忆作为独立 user 消息紧跟 system，位于 history 之前，避免夹在对话中间语义断裂。
 */
export async function buildLlmMessages(opts: {
  settings: any;
  question: string;
  pageText: string | null;
  notes: any[];
  selection: string | null;
  history: { role: string; content: string }[];
}): Promise<{ messages: { role: string; content: string }[] }> {
  const built = buildContext({
    question: opts.question,
    pageText: opts.pageText,
    notes: opts.notes,
    selection: opts.selection,
  });
  const messages = built.messages.slice();
  const insertAt = 1; // system 之后

  // 长期记忆注入（设置可关；vault 未授权静默降级）
  if (opts.settings.memoryInject !== false) {
    try {
      const { memories } = await searchMemories(opts.question, {
        tokenBudget: BUDGET.memoryTokenBudget,
      });
      if (memories.length) {
        const memMd =
          '【用户长期记忆】\n' +
          memories.map((m) => `- (${m.tags.join(',') || 'note'}) ${m.body}`).join('\n') +
          '\n\n以上是用户过往的记忆，回答时请衔接这些背景。若与本次材料冲突以新材料为准。';
        messages.splice(insertAt, 0, { role: 'user', content: memMd });
      }
    } catch { /* vault 未授权等 */ }
  }

  if (opts.history.length) messages.splice(insertAt, 0, ...opts.history);
  return { messages };
}

/** 取本线程最近 N 轮作为多轮上下文 */
export function recentHistory(messages: any[] | null | undefined) {
  return (messages || [])
    .slice(-BUDGET.historyTurns)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** 流式调用 LLM（透传 abort 与 onToken） */
export function runStream(args: Parameters<typeof streamChat>[0]) {
  return streamChat(args);
}

/**
 * AI 问答存为本页笔记（kind=ai-qa），并裁剪同页超限的旧 ai-qa。
 * @param send SW 消息通道（panel 传入，便于单测替换）
 * @returns 实际写入返回 true；页面无效或空回答返回 false
 */
export async function saveAiQaNote(opts: {
  send: (msg: any) => Promise<any>;
  pageUrl: string;
  title: string;
  host: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  /** 本页现有笔记（含 ai-qa），用于上限裁剪 */
  pageNotes: any[];
}): Promise<boolean> {
  if (!opts.pageUrl || !opts.answer) return false;

  // 上限裁剪：同页 ai-qa 超过 BUDGET.aiQaMaxPerPage 时删除最旧的
  const aiQa = opts.pageNotes
    .filter((n) => n.kind === 'ai-qa')
    .sort((a, b) => a.ts - b.ts);
  const overflow = aiQa.length - (BUDGET.aiQaMaxPerPage - 1);
  for (let i = 0; i < overflow; i++) {
    await opts.send({ type: 'notes:delete', id: aiQa[i].id }).catch(() => {});
  }

  await opts.send({
    type: 'notes:put',
    note: {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      updatedAt: Date.now(),
      url: opts.pageUrl,
      kind: 'ai-qa',
      content: 'Q: ' + opts.question + '\n\nA: ' + opts.answer,
      sel: null,
      aiMeta: { provider: opts.provider, model: opts.model, q: opts.question },
    },
    page: { title: opts.title, host: opts.host },
  });
  return true;
}
