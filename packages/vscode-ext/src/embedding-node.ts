/**
 * 端侧 dense ranker（Node 通道）— 直接 setDenseRanker 接线到 core memory.ts，
 * 不走 core 的 local 通道（它经 AssetResolver 加载浏览器版 transformers.js，不适用于 Node）。
 *
 * 向量形状对齐 core/embedding.ts：pooling 'mean' + normalize → 点积即 cosine；
 * 地板与 CHANNEL_FLOOR.local 对齐（0.33，MiniLM 判别力下的实测最优）。
 *
 * @xenova/transformers 懒加载：解析不到（未安装）时静默降级为词法单路。
 * TODO: BYOK embedding 通道（nvidia/openrouter）可复用 core initEmbedding，MVP 未接线。
 */
import type * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { setDenseRanker, setDenseSimFloor } from '../../core/src/memory.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

let _pipe: any = null;

/** 按设置初始化语义召回；@returns 实际生效的通道（'off' = 未启用或降级） */
export async function initNodeEmbedding(
  context: vscode.ExtensionContext,
  settings: any
): Promise<string> {
  if ((settings && settings.semanticRecall) !== 'local') {
    setDenseRanker(null);
    return 'off';
  }
  try {
    if (!_pipe) {
      const mod: any = await import('@xenova/transformers');
      const dir = context.globalStorageUri.fsPath;
      await fs.mkdir(dir, { recursive: true });
      mod.env.cacheDir = dir; // 模型缓存进扩展全局存储目录
      _pipe = await mod.pipeline('feature-extraction', MODEL, { quantized: true });
    }
    const embed = async (texts: string[]): Promise<number[][]> => {
      const out: number[][] = [];
      for (const t of texts) {
        const r = await _pipe(t, { pooling: 'mean', normalize: true });
        out.push(Array.from(r.data));
      }
      return out;
    };
    setDenseSimFloor(0.33);
    setDenseRanker(async (query, candidates) => {
      const [qv, ...bodyVecs] = await embed([query, ...candidates.map((c) => c.body)]);
      return candidates
        .map((c, i) => ({ file: c.file, sim: qv.reduce((s, x, j) => s + x * bodyVecs[i][j], 0) }))
        .sort((a, b) => b.sim - a.sim);
    });
    return 'local';
  } catch (e) {
    console.warn('[markpilot] embedding 初始化失败，降级为词法单路:', e);
    setDenseRanker(null);
    return 'off';
  }
}
