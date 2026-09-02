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
import { getProfile } from './profile.js';

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
 * 为指定站点请求可选 host 权限（必须在用户手势内调用，如点击「发送」）。
 * 授权后 scripting 注入与 tabs.url 访问不再依赖 activeTab ——
 * 页面先于扩展打开（无 content script）时也能自动提取正文。
 */
export async function requestSitePermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin + '/*';
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false; /* 非手势上下文或用户拒绝 */
  }
}

/**
 * 页面正文提取（受限页面返回 null）。
 *
 * 主路径：tabs.sendMessage → annotator.js（isolated world）的 page:get-text，
 * 不依赖 activeTab/scripting 授权（切 tab 后授权常失效，曾导致静默拿不到正文）。
 *
 * 兜底：executeScript 注入 MAIN world 调 __wneExtract（extract.js 挂载），
 * 覆盖 content script 尚未注入的旧标签页。isolated world 看不到 MAIN world
 * window 上的 __wneExtract，所以兜底必须 world: 'MAIN'。
 */
export async function extractPageText(tabId: number): Promise<string | null> {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'page:get-text' });
    if (r && r.ok && r.text) return String(r.text);
  } catch { /* content script 未注入，走注入兜底 */ }
  try {
    const call = () => chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN', // 与页面 window 同世界才能看到 __wneExtract
      func: () => ((window as any).__wneExtract ? (window as any).__wneExtract() : null),
    });
    let [res] = await call();
    if (!res || !res.result) {
      // 页面先于扩展安装/更新打开：__wneExtract 不存在。
      // activeTab 授权下按需注入 extract.js 再取（自愈，省去手动刷新页面）
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['content/extract.js'],
      });
      [res] = await call();
    }
    return res && res.result ? String(res.result.text || '') : null;
  } catch {
    return null; /* 受限页面 / 无 activeTab 授权 */
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
    systemPrompt: opts.settings.systemPrompt, // 缺省=默认 prompt；空串=不带 system 消息
  });
  const messages = built.messages.slice();
  // system 存在时插到其后；无 system（用户清空）则插到最前
  const insertAt = messages.length && messages[0].role === 'system' ? 1 : 0;

  // 长期记忆注入（设置可关；vault 未授权静默降级）
  if (opts.settings.memoryInject !== false) {
    // 用户画像（Phase 5）：若有，作为「用户是谁」卡片注入，优先级等同 pinned，位于记忆之前
    try {
      const profile = await getProfile();
      if (profile) {
        messages.splice(insertAt, 0, {
          role: 'user',
          content: '【用户画像】\n' + profile + '\n\n以上画像概括了用户的背景与偏好，回答时请以此为理解用户的基调。',
        });
      }
    } catch { /* vault 未授权等 */ }
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
      scope: 'page',
      originUrl: opts.pageUrl,
      kind: 'ai-qa',
      content: 'Q: ' + opts.question + '\n\nA: ' + opts.answer,
      sel: null,
      aiMeta: { provider: opts.provider, model: opts.model, q: opts.question },
    },
    page: { title: opts.title, host: opts.host },
  });
  return true;
}
