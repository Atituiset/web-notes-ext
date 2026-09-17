# Contributing — Markpilot VS Code Extension

Development setup and verification for `packages/vscode-ext`. For usage, see [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md).

## Debug (F5)

1. At the repo root: `npm install`, then `npm run compile -w @markpilot/vscode-ext`
2. Open the **repo root** in VS Code → Run and Debug → "Run Extension" (or F5) to launch the Extension Development Host
   - If there is no launch config, use type `extensionHost` with `args: ["--extensionDevelopmentPath=${workspaceFolder}/packages/vscode-ext"]`
3. In the dev host window, open any project, run `Markpilot: Set LLM API Key` (or use an opencode free model), then try the three selection commands

## Manual verification checklist (inside the dev host)

0. Chat view title gear → Open Settings → switch providers (key status follows), paste & save a key (shows "已保存 ✓"), fetch the online model list, run Test Connection (✓/✗), pick a vault via Browse…; reopen the page and confirm everything persisted (webview UI can't be driven automatically — manual only)
1. Command Palette → Quick Setup → pick opencode (QuickPick/inputBox can't be automated — manual only) → pick a free preset → "配置完成" toast; run again with deepseek to exercise the API key step (Esc should abort silently)
2. Select code → right-click Add Note on Selection → enter a note → yellow highlight appears; insert/delete lines above and confirm the anchor shifts
3. Select code → Ask AI about Selection → context card appears in the sidebar → ask → streamed answer → click 存为笔记
4. Point `vaultPath` at an Obsidian vault → ask again (memory injection should degrade gracefully without errors); sidebar 导出本文件笔记 → `Markpilot-Code/code-*.md` appears in the vault
5. Select Chinese text → Translate Selection → streamed translation → 替换选区 → the editor selection is replaced

## Integration tests (real extension host)

```bash
npm run test:vscode
```

Downloads VS Code via `@vscode/test-electron` and launches a headed extension host (WSLg) running `src/test/suite.ts` (Mocha): activation & command registration, VaultFS + memory retrieval loop, note anchor shifting (driven by real edit events), and mock-LLM SSE end-to-end translate/ask. First run downloads ~100 MB and needs a display; not part of `npm test`.

## Packaging

```bash
npm run package -w @markpilot/vscode-ext
```

Produces `packages/vscode-ext/markpilot-code-<version>.vsix`. vsce rejects npm-scoped package names, so `scripts/vsix.mjs` temporarily rewrites `name` to `markpilot-code` and restores it afterwards; `--no-dependencies` skips collecting monorepo-hoisted dependencies.

## Publishing

The extension is published to the VS Code Marketplace via the web portal (`https://marketplace.visualstudio.com/manage` → publisher `atituiset` → ⋯ → Update). A `vsce publish` path also exists (`npm run publish:market`) for when an Azure DevOps PAT is available; `scripts/publish.mjs` additionally strips `"private": true` during the call.

## Structure

```
src/
  extension.ts        entry: platform wiring + command registration + highlight restore/shift
  chat-view.ts        sidebar webview (ask/translate/export UI & message bridge)
  notes-store.ts      notes storage (globalState) + decoration highlights
  embedding-node.ts   Node on-device dense ranker (setDenseRanker wiring into core memory.ts)
  platform/           core port adapters (VaultFS/KVStore/SettingsStore/TextSource)
```

Core logic is reused from `packages/core/src/`: chat-pipeline (message assembly), memory (hybrid recall), llm (providers/SSE), translate (translation prompt), markdown (frontmatter/callout), file-key (file/project-level keys).
