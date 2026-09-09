/**
 * 划词翻译 — 从 background/sw.ts 的 translate:run 处理器抽出的平台无关部分。
 *
 * 目标语言 tag 由调用方给（chrome 侧取 chrome.i18n.getUILanguage()）；
 * SW 只保留消息管线与保活心跳，prompt 组装与 LLM 调用在本模块。
 */

import { streamChat, laneSettings } from './llm/index.js';

/** 语言 tag 的本地化名（zh-CN → 中文）；未知语言码直接用码本身，模型同样认 */
export function languageName(langTag: string): string {
  try {
    return new Intl.DisplayNames([langTag], { type: 'language' }).of(langTag) || langTag;
  } catch {
    return langTag;
  }
}

/** 翻译消息组装（system prompt 固定为翻译引擎指令） */
export function buildTranslateMessages(text: string, langTag: string): { role: string; content: string }[] {
  const langName = languageName(langTag);
  return [
    {
      role: 'system',
      content:
        `You are a translation engine. Translate the user's text into ${langName} (${langTag}). ` +
        'Preserve the original meaning and formatting. Output only the translation — no explanations, no quotes.',
    },
    { role: 'user', content: text },
  ];
}

/** 流式翻译：token 经 onToken 回调，返回完整译文 */
export async function runTranslate(opts: {
  settings: any;
  text: string;
  langTag: string;
  signal?: AbortSignal;
  onToken?: (tok: string) => void;
}): Promise<{ text: string }> {
  const { text } = await streamChat({
    settings: laneSettings(opts.settings, 'aux'),
    messages: buildTranslateMessages(opts.text, opts.langTag),
    signal: opts.signal,
    onToken: opts.onToken,
  });
  return { text };
}
