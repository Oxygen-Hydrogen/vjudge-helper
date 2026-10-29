'use strict';

/**
 * 「随机来一道题」的选题逻辑。
 *
 * 三条通道，按可靠性排序：
 *  1. Codeforces 官方 API（`/api/problemset.problems`）——匿名可读，自带 rating，
 *     所以能按难度过滤。整份题库一次拿回（约 2 MB），内存里缓存 6 小时。
 *  2. 洛谷题目列表页（`/problem/list`）——匿名可读，服务端支持 `difficulty=1..8`（2026-06 起 8 档）。
 *     分页是 50 条/页，所以先看第 1 页拿到 count，再随机跳到某一页。
 *  3. VJudge 自己的 `/problem/data`——**要登录**，用于「其他 OJ」；
 *     没有难度的概念，只能按 OJ 随机。
 *
 * 注意：**不要在匿名状态下走 VJudge 那条**。匿名调 `/problem/data` 虽然返回 200，
 * 但 `data` 是空数组、`recordsTotal` 是假的 9999999，直接拿它当题目总数会抽出不存在的偏移量。
 *
 * 标签（算法标签）只有 CF 和洛谷有：
 *   - CF 的题库接口每道题带 `tags: ['dp','graphs',…]`，本地过滤；
 *   - 洛谷的标签表在 `GET /_lfe/tags`（`types` 里 `type==='Algorithm'` 那类，id 形如 3=动态规划），
 *     列表端点吃 `tag=3,6`，**多标签是并集（命中任一）**，实测 `tag=3,11` 的 count 正好是两档并集。
 * VJudge 自己的题目库没有算法标签，所以「VJudge 全站 / 其他 OJ」两条通道不支持标签筛选。
 */

const { request, CookieJar } = require('./http');

const CF_PROBLEMS_URL = 'https://codeforces.com/api/problemset.problems';
const LUOGU_LIST_URL = 'https://www.luogu.com.cn/problem/list';
const CF_CACHE_TTL = 6 * 60 * 60 * 1000;

/** 匿名调 /problem/data 时服务端回的这个假总数，见到就说明没登录 */
const FAKE_TOTAL = 9999999;

/* ----------------------------- 难度预设 ----------------------------- */

/** Codeforces rating 区间 */
const CF_PRESETS = [
  { id: 'any', label: '不限难度', min: 0, max: 9999 },
  { id: 'cf-800-1000', label: '800 – 1000 · 入门', min: 800, max: 1000 },
  { id: 'cf-1000-1200', label: '1000 – 1200 · 新手', min: 1000, max: 1200 },
  { id: 'cf-1200-1400', label: '1200 – 1400 · 普及', min: 1200, max: 1400 },
  { id: 'cf-1400-1600', label: '1400 – 1600 · 普及+', min: 1400, max: 1600 },
  { id: 'cf-1600-1900', label: '1600 – 1900 · 提高', min: 1600, max: 1900 },
  { id: 'cf-1900-2200', label: '1900 – 2200 · 提高+', min: 1900, max: 2200 },
  { id: 'cf-2200-2500', label: '2200 – 2500 · 省选', min: 2200, max: 2500 },
  { id: 'cf-2500-9999', label: '2500+ · 神仙', min: 2500, max: 9999 },
];

/**
 * Codeforces 官方标签的中文对照（只用于菜单上的说明文字，过滤一律用英文原值）。
 * 没收录的标签就显示空说明，不影响筛选。
 */
const CF_TAG_ZH = {
  implementation: '模拟',
  math: '数学',
  greedy: '贪心',
  dp: '动态规划',
  'data structures': '数据结构',
  'brute force': '暴力',
  'constructive algorithms': '构造',
  graphs: '图论',
  sortings: '排序',
  'binary search': '二分',
  'dfs and similar': 'DFS / 搜索',
  trees: '树',
  strings: '字符串',
  'number theory': '数论',
  combinatorics: '组合数学',
  geometry: '计算几何',
  bitmasks: '位运算',
  'two pointers': '双指针',
  dsu: '并查集',
  'shortest paths': '最短路',
  hashing: '哈希',
  games: '博弈论',
  matrices: '矩阵',
  flows: '网络流',
  probabilities: '概率期望',
  'divide and conquer': '分治',
  interactive: '交互题',
  'ternary search': '三分',
  'meet-in-the-middle': '折半搜索',
  'expression parsing': '表达式解析',
  schedules: '调度',
  '2-sat': '2-SAT',
  'chinese remainder theorem': '中国剩余定理',
  fft: 'FFT',
  'graph matchings': '图匹配',
  'string suffix structures': '后缀结构',
  '*special problem': '特殊题',
};

/**
 * 洛谷难度档位（2026 年 6 月改版后是 8 档，0 = 暂无评定）。
 *
 * 这张表照抄洛谷自己的配置接口 `GET https://www.luogu.com.cn/_lfe/config`
 * 里的 `ProblemDifficulty`（`type` / `id` / `name` / `color` 都是原值），
 * 改版前只有 1..7，**新插进来的「提高（青）」是 5**，蓝/紫/黑整体后移一位
 * （蓝=6、紫=7、黑=8）。别再按老的四档记忆写死 —— 2026-06 那次改版把
 * 「提高+/省选−」和「省选/NOI−」两档拆成了 青 / 蓝 / 紫 三档。
 *
 * 想核对有没有再次改版：`node test/random-check.js --live`。
 */
const LUOGU_LEVELS = [
  { id: 0, type: 'Nil', name: '暂无评定', color: 'grey-3' },
  { id: 1, type: 'Pupil', name: '入门', color: 'pink-3', colorName: '红' },
  { id: 2, type: 'JuniorUnder', name: '普及−', color: 'orange-3', colorName: '橙' },
  { id: 3, type: 'Junior', name: '普及', color: 'gold-3', colorName: '黄' },
  { id: 4, type: 'JuniorAbove', name: '普及+/提高−', color: 'green-3', colorName: '绿' },
  { id: 5, type: 'Senior', name: '提高', color: 'cyan-3', colorName: '青', cf: 'CF 2000 – 2400' },
  { id: 6, type: 'SeniorAbove', name: '提高+/省选−', color: 'blue-3', colorName: '蓝', cf: 'CF 2300 – 2700' },
  { id: 7, type: 'NoiUnder', name: '省选/NOI−', color: 'purple-3', colorName: '紫', cf: 'CF 2700 – 3100' },
  { id: 8, type: 'Noi', name: 'NOI/NOI+/CTS', color: 'lapis-4', colorName: '黑' },
];

/** 难度 id → 展示文案（不带 0：0 在菜单里就是「不限」） */
const LUOGU_LEVEL_LABEL = LUOGU_LEVELS.filter((l) => l.id > 0).reduce((acc, level) => {
  acc[level.id] = level.colorName ? `${level.name}（${level.colorName}）` : level.name;
  return acc;
}, {});

/** 洛谷难度：0 = 不限，1..8 各一档 */
const LUOGU_PRESETS = [
  { id: 'any', label: '不限难度', levels: [0] },
  ...LUOGU_LEVELS.filter((level) => level.id > 0).map((level) => ({
    id: `lg-${level.id}`,
    level: level.id,
    label: `${level.name} · ${level.colorName}`,
    note: level.cf || '',
    levels: [level.id],
  })),
];

/* ----------------------------- 小工具 ----------------------------- */

function pickOne(list, rng) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return null;
  const r = typeof rng === 'function' ? rng() : Math.random();
  const idx = Math.min(items.length - 1, Math.max(0, Math.floor(r * items.length)));
  return items[idx];
}

/** 解析 `1500-1900` / `1500~1900` / `1500` 这类输入 */
function parseRatingRange(text) {
  const raw = String(text || '').replace(/[–—~～]/g, '-').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{3,4})\s*-\s*(\d{3,4})$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
    return { min, max };
  }
  const single = raw.match(/^(\d{3,4})$/);
  if (single) {
    const v = Number(single[1]);
    // 单个数字当成「这个难度附近 ±100」
    return { min: Math.max(800, v - 100), max: v + 100 };
  }
  return null;
}

function ratingLabel(min, max) {
  if (!min && !max) return '不限难度';
  return `${min} – ${max >= 9999 ? '∞' : max}`;
}

/* --------------------------- Codeforces --------------------------- */

let cfCache = { at: 0, problems: null };

function resetCodeforcesCache() {
  cfCache = { at: 0, problems: null };
}

/** 只保留真正能在 VJudge 上打开的题：有 contestId、不是特殊题库（acmsguru 之类）、有 rating */
function filterCodeforcesProblems(problems, range, tags) {
  const min = range && Number.isFinite(range.min) ? range.min : 0;
  const max = range && Number.isFinite(range.max) ? range.max : 9999;
  const wanted = Array.isArray(tags) ? tags.filter(Boolean) : [];
  return (Array.isArray(problems) ? problems : []).filter(
    (p) =>
      p &&
      Number.isFinite(p.contestId) &&
      p.index &&
      !p.problemsetName &&
      p.type !== 'PROBLEM_SET' &&
      Number.isFinite(p.rating) &&
      p.rating >= min &&
      p.rating <= max &&
      // 多选标签 = 命中任一（和洛谷的 tag=&tag=a,b 语义保持一致）
      (!wanted.length || (Array.isArray(p.tags) && p.tags.some((t) => wanted.includes(t))))
  );
}

/**
 * 从 CF 题库里统计所有标签及其题数，按题数倒序。
 * 只统计「抽得到」的题（有 contestId、不是特殊题库、有 rating），
 * 这样菜单上的「N 题」和实际能抽到的数量对得上。
 * 标签是英文小写（`dp` / `graphs`），中文说明见 CF_TAG_ZH。
 */
async function codeforcesTags(options = {}) {
  const problems = await codeforcesPool(options);
  const counter = new Map();
  for (const p of filterCodeforcesProblems(problems, null)) {
    for (const tag of Array.isArray(p.tags) ? p.tags : []) counter.set(tag, (counter.get(tag) || 0) + 1);
  }
  return [...counter.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function parseCodeforcesPayload(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Codeforces 返回的不是 JSON（可能需要科学上网，或接口临时抽风）');
  }
  if (!json || json.status !== 'OK' || !json.result || !Array.isArray(json.result.problems)) {
    const why = json && json.comment ? `：${json.comment}` : '';
    throw new Error(`Codeforces 题库没拿到${why}`);
  }
  return json.result.problems;
}

/**
 * @param {{min?:number,max?:number,rng?:Function,http?:object,force?:boolean}} [options]
 */
async function codeforcesPool(options = {}) {
  const now = Date.now();
  if (!options.force && cfCache.problems && now - cfCache.at < CF_CACHE_TTL) {
    return cfCache.problems;
  }
  const get = (options.http && options.http.get) || defaultGet;
  const res = await get(CF_PROBLEMS_URL, { timeout: 45000, accept: 'application/json' });
  const problems = parseCodeforcesPayload(res.body);
  cfCache = { at: now, problems };
  return problems;
}

async function randomCodeforces(options = {}) {
  const problems = await codeforcesPool(options);
  const range = { min: options.min, max: options.max };
  const tags = options.tags;
  const hasTags = Array.isArray(tags) && tags.filter(Boolean).length > 0;
  let pool = filterCodeforcesProblems(problems, range, tags);
  // 没指定标签时，区间内没题就退化成整库；指定了标签就老实报错，别偷偷把标签丢掉
  if (!pool.length && !hasTags) pool = filterCodeforcesProblems(problems, null);
  if (!pool.length) {
    throw new Error(
      hasTags
        ? `Codeforces 上没有同时满足「${(tags || []).join(' / ')}」和当前难度的题，换个标签或放宽难度`
        : 'Codeforces 题库里没有符合条件的题目'
    );
  }
  const picked = pickOne(pool, options.rng);
  if (!picked) throw new Error('Codeforces 题库里没有符合条件的题目');
  return {
    key: `CodeForces-${picked.contestId}${picked.index}`,
    title: picked.name || '',
    detail: [picked.rating ? `rating ${picked.rating}` : '', (picked.tags || []).slice(0, 2).join(' / ')]
      .filter(Boolean)
      .join(' · '),
    rating: picked.rating,
    tags: picked.tags || [],
    source: 'codeforces',
  };
}

/* ----------------------------- 洛谷 ----------------------------- */

/**
 * 从 `/_lfe/config` 的响应里取难度表（洛谷前端自己也是读这个）。
 * 返回 `[{ id, type, name, color }]`，拿不到就返回 null。
 * 只给测试/自检用，正常出菜单走上面那张静态表（省一次请求）。
 */
function parseLuoguDifficulties(payload) {
  let json = payload;
  if (typeof payload === 'string') {
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const list = json && json.ProblemDifficulty;
  if (!Array.isArray(list) || !list.length) return null;
  return list
    .filter((x) => x && Number.isFinite(Number(x.id)) && x.name)
    .map((x) => ({ id: Number(x.id), type: String(x.type || ''), name: String(x.name), color: String(x.color || '') }))
    .sort((a, b) => a.id - b.id);
}

/** 拉一份线上难度表，用来和静态表对照（只有自检/测试会调） */
async function fetchLuoguDifficulties(options = {}) {
  const get = (options.http && options.http.get) || defaultGet;
  const res = await get('https://www.luogu.com.cn/_lfe/config', {
    timeout: 20000,
    accept: 'application/json',
  });
  return parseLuoguDifficulties(res.body);
}

/**
 * 解析洛谷 `/_lfe/tags`：算法标签（`types` 里 id=2 的那一类）。
 * 返回 `[{ id, name, parentName }]`，按名称排序；拿不到就返回 null。
 */
function parseLuoguTags(payload, typeName = 'Algorithm') {
  let json = payload;
  if (typeof payload === 'string') {
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!json || !Array.isArray(json.tags) || !Array.isArray(json.types)) return null;
  const type = json.types.find((t) => t && t.type === typeName);
  if (!type) return null;
  const byId = new Map();
  for (const tag of json.tags) {
    if (tag && Number.isFinite(Number(tag.id))) byId.set(Number(tag.id), tag);
  }
  return json.tags
    .filter((t) => t && Number(t.type) === Number(type.id) && t.name)
    .map((t) => ({
      id: Number(t.id),
      name: String(t.name),
      parentName: t.parent === null || t.parent === undefined ? '' : ((byId.get(Number(t.parent)) || {}).name || ''),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

let luoguTagCache = { at: 0, tags: null };

function resetLuoguTagCache() {
  luoguTagCache = { at: 0, tags: null };
}

/** 拉洛谷的算法标签列表（内存缓存 6 小时；标签变动很慢，不用每次都拉） */
async function fetchLuoguTags(options = {}) {
  const now = Date.now();
  if (!options.force && luoguTagCache.tags && now - luoguTagCache.at < CF_CACHE_TTL) {
    return luoguTagCache.tags;
  }
  const get = (options.http && options.http.get) || defaultGet;
  const res = await get('https://www.luogu.com.cn/_lfe/tags', {
    timeout: 20000,
    accept: 'application/json',
  });
  const tags = parseLuoguTags(res.body);
  if (!tags || !tags.length) throw new Error('洛谷没有返回算法标签列表，稍后再试');
  luoguTagCache = { at: now, tags };
  return tags;
}

/** 从洛谷 SSR 页面里抠出 `lentille-context` 那段 JSON */
function parseLuoguList(html) {
  const text = String(html || '');
  const m = text.match(/<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let json;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const problems = json && json.data && json.data.problems;
  if (!problems || !Array.isArray(problems.result)) return null;
  return {
    count: Number(problems.count) || 0,
    perPage: Number(problems.perPage) || problems.result.length || 50,
    items: problems.result
      .filter((p) => p && p.pid)
      .map((p) => ({
        pid: String(p.pid),
        title: String(p.name || ''),
        difficulty: Number(p.difficulty) || 0,
      })),
  };
}

/**
 * @param {number[]} levels 难度，只取第一个（洛谷只认单值）
 * @param {number} page 页码
 * @param {number[]} [tags] 算法标签 id；多个用逗号连接，洛谷的语义是**命中任一**（并集）
 */
function luoguListUrl(levels, page, tags) {
  const list = Array.isArray(levels) && levels.length ? levels : [0];
  // 洛谷只认单个 difficulty（逗号分隔会被忽略），多选时由调用方分多次请求
  const query = new URLSearchParams({
    difficulty: String(list[0]),
    page: String(page),
    type: 'P',
  });
  // 注意 Number(null) === 0，光用 Number.isFinite(Number(x)) 会把 null 当成 tag 0
  const tagIds = Array.isArray(tags)
    ? tags.filter((t) => t !== null && t !== undefined && Number.isFinite(Number(t)))
    : [];
  if (tagIds.length) query.set('tag', tagIds.map((t) => String(t)).join(','));
  return `${LUOGU_LIST_URL}?${query.toString()}`;
}

/**
 * 洛谷有 WAF：第一次请求会 302 回来并种下 `C3VK`，带上 Cookie 再请求才给 HTML。
 * 所以这里手动跟 0 次重定向，自己重试。
 */
async function fetchLuoguPage(level, page, options = {}) {
  const get = (options.http && options.http.get) || defaultGet;
  const jar = options.jar || new CookieJar();
  const url = luoguListUrl([level], page, options.tags);
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    const res = await get(url, {
      timeout: 20000,
      accept: 'text/html',
      jar,
      maxRedirects: 0,
      headers: { 'x-luogu-type': 'content-only' },
    });
    const parsed = parseLuoguList(res.body);
    if (parsed) return parsed;
    last = res;
  }
  const status = last && last.status ? `（HTTP ${last.status}）` : '';
  throw new Error(`洛谷没有返回题目列表${status}，可能触发了风控，稍后再试`);
}

async function randomLuogu(options = {}) {
  const levels =
    Array.isArray(options.levels) && options.levels.length ? options.levels.slice() : [0];
  const tags = Array.isArray(options.tags) ? options.tags.filter((t) => t !== undefined && t !== null) : [];
  const jar = new CookieJar();
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const http = { ...(options.http || {}), get: (options.http && options.http.get) || defaultGet };

  // 一次把所有难度档的第 1 页拉回来：既拿到每档总数，也顺手拿到前 50 道
  const firstPages = await Promise.all(
    levels.map(async (level) => {
      const parsed = await fetchLuoguPage(level, 1, { ...options, http, jar, tags });
      return { level, parsed };
    })
  );

  const usable = firstPages.filter((x) => x.parsed && x.parsed.count > 0);
  if (!usable.length) {
    throw new Error(
      tags.length
        ? '洛谷上没有同时满足这些标签和难度的题，换个标签或放宽难度'
        : '洛谷没有返回这个难度的题目'
    );
  }

  // 按每档题目数加权抽一档
  const totalCount = usable.reduce((sum, x) => sum + x.parsed.count, 0);
  let cursor = rng() * totalCount;
  let chosen = usable[usable.length - 1];
  for (const item of usable) {
    cursor -= item.parsed.count;
    if (cursor <= 0) {
      chosen = item;
      break;
    }
  }

  const { level, parsed } = chosen;
  const perPage = parsed.perPage || 50;
  const pages = Math.max(1, Math.ceil(parsed.count / perPage));
  const page = 1 + Math.floor(rng() * pages);
  let items = parsed.items;
  if (page > 1) {
    const another = await fetchLuoguPage(level, page, { ...options, http, jar, tags });
    if (another && another.items.length) items = another.items;
  }
  const picked = pickOne(items, rng);
  if (!picked) throw new Error('洛谷这次没抽到题目，再试一次');

  return {
    key: `洛谷-${picked.pid}`,
    title: picked.title,
    detail: LUOGU_LEVEL_LABEL[picked.difficulty] || `难度 ${picked.difficulty}`,
    difficulty: picked.difficulty,
    source: 'luogu',
  };
}

/* --------------------------- VJudge 兜底 --------------------------- */

/**
 * 从 VJudge 的题目库里按 OJ 随机抽一道（需要登录）。
 * @param {object} client VJudgeClient
 */
async function randomFromVJudge(client, oj, options = {}) {
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const label = oj || '全站';
  const total = await client.problemCountInOj(oj);
  if (!total) throw new Error(`VJudge 上「${label}」还没有收录题目`);
  const start = Math.floor(rng() * total);
  const row = await client.problemAtOffset(oj, start);
  if (!row) throw new Error(`VJudge 抽题失败（偏移 ${start} / ${total}）`);
  const key = row.originOJ && row.originProb ? `${row.originOJ}-${row.originProb}` : '';
  if (!key) throw new Error('VJudge 没有返回题号，再试一次');
  return { key, title: row.title || '', detail: oj || '', source: 'vjudge' };
}

/* --------------------------- 统一入口 --------------------------- */

/**
 * @param {object} options
 * @param {'any'|'CodeForces'|'洛谷'|'vjudge'|string} options.oj
 * @param {object} [options.client] VJudge 客户端（只有 oj=vjudge / 其他 OJ 才用得到）
 * @param {{min?:number,max?:number}} [options.rating] Codeforces 难度
 * @param {number[]} [options.levels] 洛谷难度
 * @param {string[]|number[]} [options.tags] 标签：CF 是英文标签名，洛谷是标签 id；多选 = 命中任一
 */
async function pickRandom(options = {}) {
  const oj = options.oj || 'any';
  if (oj === 'any') {
    // CF 和洛谷各占一半；哪边挂了就自动换另一边
    const first = options.rng && options.rng() < 0.5 ? 'luogu' : 'codeforces';
    const order = first === 'luogu' ? ['luogu', 'codeforces'] : ['codeforces', 'luogu'];
    let lastError = null;
    for (const which of order) {
      try {
        return which === 'luogu' ? await randomLuogu(options) : await randomCodeforces(options);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('随机抽题失败，再试一次');
  }
  if (oj === 'CodeForces' || oj === 'Codeforces') {
    return randomCodeforces({ ...options, min: options.rating && options.rating.min, max: options.rating && options.rating.max });
  }
  if (oj === '洛谷') {
    return randomLuogu(options);
  }
  if (!options.client) throw new Error('这个 OJ 的随机抽题需要 VJudge 客户端');
  // oj === 'vjudge' 表示「不挑 OJ」：OJId 传空串，抽的是 VJudge 整个题库
  return randomFromVJudge(options.client, oj === 'vjudge' ? '' : oj, options);
}

/* ------------------------- 默认 HTTP 实现 ------------------------- */

async function defaultGet(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.accept) headers.Accept = options.accept;
  return request(url, {
    headers,
    jar: options.jar,
    timeout: options.timeout || 20000,
    maxRedirects: options.maxRedirects === undefined ? 5 : options.maxRedirects,
    retries: 2,
  });
}

module.exports = {
  CF_PRESETS,
  CF_TAG_ZH,
  LUOGU_PRESETS,
  LUOGU_LEVELS,
  LUOGU_LEVEL_LABEL,
  FAKE_TOTAL,
  parseRatingRange,
  ratingLabel,
  pickOne,
  filterCodeforcesProblems,
  codeforcesTags,
  parseCodeforcesPayload,
  parseLuoguDifficulties,
  fetchLuoguDifficulties,
  parseLuoguTags,
  fetchLuoguTags,
  parseLuoguList,
  luoguListUrl,
  randomCodeforces,
  randomLuogu,
  randomFromVJudge,
  pickRandom,
  resetCodeforcesCache,
  resetLuoguTagCache,
};
