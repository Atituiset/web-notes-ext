/**
 * 笔记 URL 分级 key（v0.4 起）
 *
 * 分级模型（note.scope）：
 *   'page' — 笔记绑定单个页面。key = origin + pathname + 内容区分型 query
 *            （白名单参数，见 CONTENT_PARAMS；utm_* 等跟踪参数全部丢弃）
 *   'site' — 笔记绑定整个域名。key = hostname（去 www.），同域名下所有页面互通可见
 *
 * 旧数据兼容（v0.3 及更早）：
 *   旧笔记一律存 origin + pathname（无 query、无 scope 字段），升级后仍按 page 级
 *   检索；对同 path 的 query 变体页面，matchesPage() 做「裸 path 家族匹配」，
 *   保证旧笔记在 xxx?id=1 与 xxx?id=2 上依然可见（与升级前行为一致）。
 *
 * 幂等约定：pageKey/siteKey 对「已经是 key 的输入」返回原值，调用方可安全重复归一。
 */

/**
 * 内容区分型 query 参数白名单：命中则保留进 page key。
 * 取舍原则 —— 保留「换个值就是另一篇内容」的参数，丢弃排序/跟踪/分页工具参数。
 */
const CONTENT_PARAMS = new Set([
  // 通用 CMS / 论坛
  'id', 'p', 'pid', 'post', 'post_id', 'article', 'aid', 'entry',
  'thread', 'tid', 'topic', 'node', 'board', 'bid',
  'page', 'pg',
  // 音视频
  'v', 'vid', 'bv', 'bvid', 'sid', 'cid',
  // 搜索 / 知识库
  'q', 'query', 'keyword', 'wd', 's', 'doc', 'docid',
  // 电商
  'item', 'sku', 'spu', 'product', 'goods',
  // 内容定位
  'slug', 'section', 'chapter', 'question',
  // 栏目与语言
  'cat', 'category', 'tag', 'lang', 'user', 'uid',
]);

/** 仅 http(s) 参与归一；chrome:// 等受限页原样透传（其 origin 恒为 'null'，不可作 key） */
function parseHttp(url) {
  try {
    const x = new URL(url);
    return /^https?:$/.test(x.protocol) ? x : null;
  } catch {
    return null;
  }
}

/** page 级 key：origin + pathname + 白名单 query（按参数名排序，保证稳定） */
export function pageKey(url) {
  const x = parseHttp(url);
  if (!x) return url || '';
  const base = x.origin + x.pathname;
  const kept = [];
  for (const [k, v] of x.searchParams) {
    if (CONTENT_PARAMS.has(k.toLowerCase())) kept.push([k, v]);
  }
  if (!kept.length) return base;
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return base + '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** site 级 key：hostname，去 www.（example.com 与 www.example.com 视为同站） */
export function siteKey(url) {
  const x = parseHttp(url);
  if (!x) return url || '';
  return x.hostname.replace(/^www\./, '');
}

/**
 * 笔记在指定页面上是否「本页可见」（高亮/本页分组判定）。
 * @param noteUrl 笔记的 url（page key / 旧裸 path key）或其 originUrl
 * @param currentUrl 当前页面原始 URL
 */
export function matchesPage(noteUrl, currentUrl) {
  if (!noteUrl || !currentUrl) return false;
  const n = pageKey(noteUrl);
  const c = pageKey(currentUrl);
  if (n === c) return true;
  // 家族匹配：仅当笔记侧是无 query 的裸 path key（= 全部旧数据 + 无 query 页新数据）时，
  // 对同 origin+pathname 的 query 变体仍可见。反向不合并——带 query 的新 key 不回漏到裸 path 页。
  if (n.includes('?')) return false;
  return stripQuery(c) === n;
}

function stripQuery(key) {
  const i = key.indexOf('?');
  return i < 0 ? key : key.slice(0, i);
}

/** 检索某页面可见的全部笔记 key 集合：page key + 裸 path（旧数据）+ site key */
export function lookupKeys(url) {
  const keys = new Set([siteKey(url)]);
  const p = pageKey(url);
  if (p) {
    keys.add(p);
    keys.add(stripQuery(p));
  }
  keys.delete('');
  return [...keys];
}
