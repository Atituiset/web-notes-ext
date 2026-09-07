/**
 * 文件/项目 两级 key（vscode-ext 笔记分级，url-key 的文件系统类比）
 *
 * 分级模型（note.scope）：
 *   'file'    — 笔记绑定单个文件。key = 相对 workspace 根的 posix 相对路径
 *   'project' — 笔记绑定整个项目。key = 'project:' + workspace 文件夹名
 *
 * 幂等约定：fileKey 对「已经是相对 key 的输入」返回归一后的原值
 * （反斜杠转正斜杠、去 './' 前缀），调用方可安全重复归一。
 * 纯字符串运算，不依赖 node:path —— core 保持平台无关。
 */

/** posix 归一：反斜杠 → 正斜杠，去末尾斜杠（根路径除外） */
function posix(p: string): string {
  let s = String(p || '').replace(/\\/g, '/');
  s = s.replace(/\/+$/, '');
  return s;
}

/** file 级 key：绝对路径 → workspace 相对 posix 路径；越出根的路径按 posix 化原样返回 */
export function fileKey(absPath: string, root: string): string {
  const p = posix(absPath).replace(/^\.\//, '');
  const r = posix(root);
  if (!r) return p;
  if (p === r) return '';
  if (p.startsWith(r + '/')) return p.slice(r.length + 1);
  return p;
}

/** project 级 key：'project:' 前缀 + workspace 文件夹名（与 file key 命名空间隔离） */
export function projectKey(folderName: string): string {
  return 'project:' + String(folderName || '');
}

export function isProjectKey(key: string): boolean {
  return String(key || '').startsWith('project:');
}

/** 检索某文件可见的全部笔记 key 集合：file key + project key */
export function lookupKeys(absPath: string, root: string, folderName: string): string[] {
  const keys = new Set<string>();
  const fk = fileKey(absPath, root);
  if (fk) keys.add(fk);
  const pk = projectKey(folderName);
  if (folderName) keys.add(pk);
  return [...keys];
}
