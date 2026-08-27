# Memory Eval 过程产物归档

> 归档时间：2026-08-28
> 内容：Memory 检索优化过程中的执行报告与模型选型探针脚本。
> 方法论见 `docs/MEMORY-EVAL-PLAYBOOK.md`，阶段决策见 `docs/plans/memory-opt-roadmap.md`。

## 目录

- `JOURNAL.md` — **全程工程日志**：每一步做了什么、撞了什么墙、怎么绕过去的（含被数据否决的 6 个方案），按时间线回放整个优化过程

- `reports/2026-08-28-v4-nvidia.json` — v4 基线（NVIDIA nemotron-3-embed-1b 通道）的完整执行报告：逐 query 的 expect/got 明细、各指标、100/500/1000 条规模延迟。这是全部达标线达成的那次运行（recall@5 97.0% / precision@5 66.7% / 拒答 100% / 知识更新 100%）。此前各轮报告被同路径覆盖，仅存此最终版。
- `probes/` — embedding 模型选型探针（决定 dense 通道的原始证据）：
  - `probe-minilm.mjs` — 端侧 paraphrase-multilingual-MiniLM-L12-v2 对改述失败对的区分度（结果 7/8，促成混合召回立项）
  - `probe-openrouter.mjs` — liquid/lfm-2.5-embedding-350m:free 难例对照（跨语种 q35 修复但 q28/q33 失败，互补结论）
  - `probe-nvidia.mjs` — NVIDIA NIM 多模型对照（nemotron-3-embed-1b 全优，最终通道）

## 复跑方式

```bash
# 探针（仓库根目录；key 只走环境变量，绝不写入文件）
node archive/memory-eval/probes/probe-minilm.mjs
OR_KEY=sk-or-... node archive/memory-eval/probes/probe-openrouter.mjs
NV_KEY=nvapi-... node archive/memory-eval/probes/probe-nvidia.mjs

# 重新生成执行报告（覆盖写 /tmp/memory-eval-report.json）
DENSE_CHANNEL=nvidia NV_KEY=nvapi-... DENSE_FLOOR=0.2 node tests/eval-memory.mjs
```

## 未归档（及原因）

- `/tmp/hf-cache`（541MB embedding 模型缓存）——可按需重新下载，不入库
- `/tmp/dbg-*.cjs`（OPFS locale 排查等一次性调试脚本）——结论已记入 `docs/MEMORY-EVAL.md` §8 与 playbook §7，脚本本身无保留价值
- Playwright 临时 profile 与 `/tmp/wne-ext-staging`——每次运行自动重建
