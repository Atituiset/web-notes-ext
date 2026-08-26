/**
 * 记忆提取模块 — 从 Q&A 对话中提炼记忆候选 (docs/MEMORY-DESIGN.md §1.2)
 *
 * 与 UI 解耦：panel 只调用 extractAndStore / proposeExtraction，
 * 本模块负责 LLM 压缩、忽略规则、tag 推断。
 */

import { streamChat } from './llm/index.js';
import { saveMemory } from './memory.js';
import { BUDGET } from './chat-pipeline.js';

const COMPRESS_SYSTEM =
  '你是记忆压缩器。从问答对中提炼值得跨会话记住的结论/偏好/事实，输出1-2句中文陈述句。' +
  '只输出内容本身，不要任何前缀或解释。若无值得记的内容，只输出 NONE。';

/** 忽略规则：命中则不产生记忆 */
export function shouldIgnore(question: string, answer: string): boolean {
  const q = String(question || '');
  // 寒暄
  if (/^(你好|您好|hi|hello|再见|thanks|谢谢|ok|好的)[!！.。?\s]*$/i.test(q.trim())) return true;
  // 空内容
  if (!String(answer || '').trim()) return true;
  return false;
}

/** tag 启发式推断 */
export function guessTags(text: string): string[] {
  const tags = ['fact'];
  if (/偏好|喜欢|习惯|不要|请用|希望/.test(text)) tags.push('preference');
  if (/理解错|纠正|其实不是|正确的是/.test(text)) tags.push('correction');
  if (/结论|所以|因此/.test(text)) tags.push('conclusion');
  return tags;
}

/** LLM 压缩 Q&A → 记忆正文；不值得记返回 null */
export async function compressQA(settings, question: string, answer: string): Promise<string | null> {
  if (shouldIgnore(question, answer)) return null;
  const { text } = await streamChat({
    settings,
    messages: [
      { role: 'system', content: COMPRESS_SYSTEM },
      { role: 'user', content: `Q: ${question}\n\nA: ${answer.slice(0, BUDGET.compressAnswerMaxChars)}` },
    ],
  });
  const summary = text.trim();
  if (!summary || /^none$/i.test(summary)) return null;
  return summary;
}

/**
 * 手动记忆（用户点「记住」）：压缩并立即写入 vault。
 * @throws 压缩失败或无值得记的内容时抛错（UI 层提示）
 */
export async function extractAndStore(
  settings,
  question: string,
  answer: string,
  sourceUrl?: string
): Promise<string> {
  const summary = await compressQA(settings, question, answer);
  if (!summary) throw new Error('该内容不值得记忆');
  return saveMemory({
    scope: 'user',
    body: summary,
    tags: guessTags(question + ' ' + summary),
    confidence: 'high', // 用户手动触发
    pinned: false,
    source: sourceUrl,
  });
}

/**
 * 自动提取（设置开关开启时）：返回候选正文供 UI 确认，不写 vault。
 * 返回 null 表示无可记忆内容。
 */
export async function proposeExtraction(
  settings,
  question: string,
  answer: string
): Promise<string | null> {
  return compressQA(settings, question, answer);
}

/** 确认后落盘（UI 确认流第二步调用） */
export async function storeProposed(summary: string, sourceUrl?: string): Promise<string> {
  return saveMemory({
    scope: 'user',
    body: summary,
    tags: guessTags(summary),
    confidence: 'medium',
    pinned: false,
    source: sourceUrl,
  });
}
