/**
 * 上下文构建器 ★ 产品差异化核心 (DESIGN.md D3)
 *
 * 组装顺序（预算内从上往下装）:
 *   [system] 阅读助手指令（默认 DEFAULT_SYSTEM_PROMPT，设置页可自定义/清空）
 *   [材料1]  页面正文（截断到字符预算，保留标题结构）
 *   [材料2]  用户在该页的已有笔记（时间序） ← 让模型知道"我已经想到了什么"
 *   [材料3]  当前选区原文（若有）
 *   [user]   问题
 */

// 粗略 token 估算：中文 ~1 字/token，英文 ~4 字符/token → 统一按 chars/2.5 折算
export function estTokens(s) {
  return Math.ceil(String(s || '').length / 2.5);
}

/**
 * 默认 system prompt。
 * 定位为阅读助手但以「材料优先」而非「仅限材料」：允许模型用自己的知识补充，
 * 只要求分清来源、不谎称出自材料——避免过度收敛导致回答干瘪。
 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个阅读助手。优先依据给定的「页面正文」「用户笔记」「选中原文」材料回答问题；' +
  '材料不足时可以结合你自己的知识补充，但需分清哪些来自材料、哪些是你的补充，不要把材料中没有的内容谎称为出自材料。' +
  '用户笔记代表用户已有的思考，回答时请衔接和回应这些思考。';

/**
 * @param {object} opts
 * @param {string} opts.question          用户问题
 * @param {string|null} opts.pageText     Readability 提取的正文
 * @param {Array}  opts.notes             该页已有笔记（时间序）
 * @param {string|null} opts.selection    当前选区原文
 * @param {number} [opts.budgetTokens=24000] 总预算
 * @param {string} [opts.systemPrompt]    自定义 system prompt；缺省用默认，空串=不带 system 消息
 */
export function buildContext({ question, pageText, notes, selection, budgetTokens = 24000, systemPrompt }) {
  const sys = systemPrompt === undefined || systemPrompt === null
    ? DEFAULT_SYSTEM_PROMPT
    : String(systemPrompt).trim();
  const fixed = estTokens(sys) + estTokens(question) + 200;
  let remaining = budgetTokens - fixed;

  // 材料3 选区优先级最高（用户正盯着它问）
  const selMd = selection ? `【选中原文】\n${selection}` : '';
  if (selMd) remaining -= estTokens(selMd);

  // 材料2 用户笔记
  let notesMd = '';
  for (const n of notes || []) {
    const block = `- ${n.kind === 'ai-qa' ? '[AI问答]' : ''}${n.content}`;
    const cost = estTokens(block) + 2;
    if (cost > remaining) break;
    notesMd += block + '\n';
    remaining -= cost;
  }

  // 材料1 页面正文：剩余预算全给它，超长则头尾保留
  let pageMd = '';
  if (pageText) {
    const maxChars = Math.max(1000, Math.floor(remaining * 2.5));
    pageMd = pageText.length <= maxChars
      ? pageText
      : pageText.slice(0, Math.floor(maxChars * 0.7)) +
        '\n\n[……中间内容因长度限制省略……]\n\n' +
        pageText.slice(-Math.floor(maxChars * 0.3));
  }

  const material = [
    selMd,
    notesMd ? '【用户在该页的笔记】\n' + notesMd : '',
    pageMd ? '【页面正文】\n' + pageMd : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [];
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: material + '\n\n【问题】\n' + question });
  return { messages };
}
