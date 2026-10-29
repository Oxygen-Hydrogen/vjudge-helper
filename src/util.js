'use strict';

function escapeHtml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 还原 VJudge 数据里常见的 HTML 实体（标题里会带 &#39; 这类） */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

function decodeEntities(input) {
  return String(input == null ? '' : input)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = Number(dec);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&([a-z]+);/gi, (m, name) => {
      const hit = NAMED_ENTITIES[String(name).toLowerCase()];
      return hit === undefined ? m : hit;
    });
}

/** 只转义文本节点，允许出现少量已知安全标签（例如 vjudge 题面里的 <br>） */
function escapeTextKeepBreaks(input) {
  return escapeHtml(input).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 相对时间：3 分钟后 / 2 小时前 */
function relativeTime(ts, now = Date.now()) {
  const diff = Number(ts) - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '后' : '前';
  if (abs < 60 * 1000) return '刚刚';
  if (abs < 3600 * 1000) return `${Math.round(abs / 60000)} 分钟${suffix}`;
  if (abs < 86400 * 1000) return `${Math.round(abs / 3600000)} 小时${suffix}`;
  return `${Math.round(abs / 86400000)} 天${suffix}`;
}

const OJ_NAME_MAP = {
  codeforces: 'CodeForces',
  gym: 'Gym',
  atcoder: 'AtCoder',
  poj: 'POJ',
  hdu: 'HDU',
  zoj: 'ZOJ',
  uva: 'UVALive',
  spoj: 'SPOJ',
  luogu: '洛谷',
  codechef: 'CodeChef',
  libreoj: 'LibreOJ',
  nowcoder: '牛客',
  leetcode: 'LeetCode',
};

/**
 * VJudge 的题号前缀就是它数据里的 OJ 名，**中文的也照样用中文**：
 * 实际存在的 key 是 `洛谷-P1001`、`牛客-xxx`、`黑暗爆炸-xxx`、`计蒜客-xxx`、`代码源-xxx`
 * （OJ 名的权威来源是 `GET /util/cfg` 的 `remoteOJs` 键名）。
 * 用户习惯写 luogu / Luogu / 洛谷，这里统一折成 VJudge 认的那个前缀。
 */
const OJ_KEY_ALIASES = {
  洛谷: '洛谷',
  luogu: '洛谷',
  lg: '洛谷',
  牛客: '牛客',
  nowcoder: '牛客',
  nc: '牛客',
  黑暗爆炸: '黑暗爆炸',
  bzoj: '黑暗爆炸',
  hysbz: '黑暗爆炸',
  计蒜客: '计蒜客',
  代码源: '代码源',
  codeforces: 'CodeForces',
  cf: 'CodeForces',
  gym: 'Gym',
  atcoder: 'AtCoder',
  poj: 'POJ',
  hdu: 'HDU',
  zoj: 'ZOJ',
  uva: 'UVA',
  uvalive: 'UVALive',
  spoj: 'SPOJ',
  codechef: 'CodeChef',
  libreoj: 'LibreOJ',
  loj: 'LibreOJ',
  leetcode: 'LeetCode',
  lc: 'LeetCode',
  cses: 'CSES',
  kattis: 'Kattis',
  topcoder: 'TopCoder',
  lightoj: 'LightOJ',
  ural: 'URAL',
  hihocoder: 'HihoCoder',
};

const OJ_ALIAS_PATTERN = Object.keys(OJ_KEY_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** 用户写的 OJ 名 -> VJudge 里的 OJ 名（认不出来就原样返回） */
function canonicalOjName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (OJ_KEY_ALIASES[raw]) return OJ_KEY_ALIASES[raw];
  if (OJ_KEY_ALIASES[lower]) return OJ_KEY_ALIASES[lower];
  return raw;
}

/**
 * 把「题号」折成 VJudge 的 problem key：
 *   luogu-P1001 / 洛谷 P1001 / 洛谷-P1001  ->  洛谷-P1001
 *   codeforces-1a                          ->  CodeForces-1a
 * 不像题号就返回 null。
 *
 * @param {string} raw
 * @param {{requireKnownOj?: boolean}} [options] requireKnownOj 用于「从一段话里找题号」，
 *        只认已知 OJ 名，免得把 e-mail 这种普通连字符单词当成题号。
 */
function normalizeProblemKey(raw, options = {}) {
  const text = String(raw == null ? '' : raw)
    // 全角横线、全角空格一律当普通分隔符
    .replace(/[\uff0d\u2010-\u2015]/g, '-')
    .replace(/\u3000/g, ' ')
    .trim()
    .replace(/^[「『"'（(<\[]+|[」』"'）)>\]。，,；;]+$/g, '')
    .trim();
  // 2026-10-29 这种日期不是题号（OJ 名可以带数字，比如 51Nod-1000）
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return null;
  const shape = /^([A-Za-z0-9\u4e00-\u9fa5][^\s\-/]{0,23})\s*-\s*([A-Za-z0-9_][A-Za-z0-9_.\-]*)$/;
  const knownOf = (oj) => Boolean(OJ_KEY_ALIASES[oj] || OJ_KEY_ALIASES[String(oj).toLowerCase()]);
  let m = text.match(shape);
  if (!m) {
    // 「洛谷 P1001」这种用空格分隔的写法，只认已知 OJ 名（避免 hello world 被当成题号）
    const spaced = text.match(/^([A-Za-z0-9\u4e00-\u9fa5][^\s\-/]{0,23})\s+([A-Za-z0-9_][A-Za-z0-9_.\-]*)$/);
    if (spaced && knownOf(spaced[1])) m = spaced;
  }
  if (!m) return null;
  if (options.requireKnownOj && !knownOf(m[1])) return null;
  return `${canonicalOjName(m[1])}-${m[2]}`;
}

/**
 * 把原生 OJ 链接转成 VJudge 的 problem key，例如
 * https://codeforces.com/problemset/problem/1/A -> CodeForces-1A
 */
function convertOjUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const path = url.pathname;

  const m = (re) => path.match(re);

  if (host.endsWith('codeforces.com') || host.endsWith('codeforces.ml')) {
    let r = m(/^\/problemset\/problem\/(\d+)\/([A-Za-z]\d?)/);
    if (r) return `CodeForces-${r[1]}${r[2].toUpperCase()}`;
    r = m(/^\/(?:contest|gym)\/(\d+)\/problem\/([A-Za-z]\d?)/);
    if (r) return `CodeForces-${r[1]}${r[2].toUpperCase()}`;
    return null;
  }
  if (host.endsWith('atcoder.jp')) {
    const r = m(/^\/contests\/([^/]+)\/tasks\/([^/]+)/);
    if (r) return `AtCoder-${r[2]}`;
    return null;
  }
  if (host.endsWith('poj.org')) {
    const id = url.searchParams.get('id');
    if (id) return `POJ-${id}`;
    return null;
  }
  if (host.endsWith('hdu.edu.cn') || host === 'acm.hdu.edu.cn') {
    const id = url.searchParams.get('pid');
    if (id) return `HDU-${id}`;
    return null;
  }
  if (host.endsWith('luogu.com.cn') || host.endsWith('luogu.org')) {
    const r = m(/^\/problem\/([A-Za-z]+\d+)/);
    // VJudge 给洛谷用的 OJ 名是中文「洛谷」，不是 Luogu
    if (r) return `洛谷-${r[1].toUpperCase()}`;
    return null;
  }
  if (host.endsWith('codechef.com')) {
    const r = m(/^\/problems\/([A-Za-z0-9_]+)/);
    if (r) return `CodeChef-${r[1]}`;
    return null;
  }
  if (host.endsWith('spoj.com')) {
    const r = m(/^\/problems\/([A-Za-z0-9_]+)/);
    if (r) return `SPOJ-${r[1]}`;
    return null;
  }
  if (host.endsWith('ac.nowcoder.com')) {
    const r = m(/^\/acm\/problem\/(\d+)/);
    if (r) return `牛客-${r[1]}`;
    return null;
  }
  if (host.endsWith('zoj.pintia.cn') || host.endsWith('zoj.com')) {
    const r = m(/\/problem[s]?\/?(\d+)/);
    if (r) return `ZOJ-${r[1]}`;
    return null;
  }
  return null;
}

/**
 * 解析用户输入，得到 {kind, ...}
 * kind: problem | contest | article | url | unknown
 */
function parseInput(raw, baseUrl = 'https://vjudge.net') {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'unknown' };

  // vjudge 内部链接
  const contestProblem = text.match(/vjudge\.(?:net|cn)\/contest\/(\d+)\s*#?\s*problem\/([A-Za-z]\d?)/i);
  if (contestProblem) {
    return { kind: 'contestProblem', contestId: contestProblem[1], index: contestProblem[2].toUpperCase() };
  }
  const contest = text.match(/vjudge\.(?:net|cn)\/contest\/(\d+)/i);
  if (contest) return { kind: 'contest', id: contest[1] };

  const article = text.match(/vjudge\.(?:net|cn)\/article\/(\d+)/i);
  if (article) return { kind: 'article', id: article[1] };

  const group = text.match(/vjudge\.(?:net|cn)\/group\/([A-Za-z0-9_.-]+)/i);
  if (group) return { kind: 'group', name: group[1] };

  const problemUrl = text.match(/vjudge\.(?:net|cn)\/problem\/([A-Za-z0-9_\-.]+(?:-\S+)?)/i);
  if (problemUrl) {
    return { kind: 'problem', key: decodeURIComponent(problemUrl[1]).replace(/[?#].*$/, '') };
  }

  // vjudge 短 key：CodeForces-1A / POJ-1000 / 洛谷-P1001（中文 OJ 名也认）
  if (!/^https?:/i.test(text)) {
    const key = normalizeProblemKey(text);
    if (key) {
      return key === text
        ? { kind: 'problem', key }
        : { kind: 'problem', key, convertedFrom: text };
    }
  }

  // 单数字 -> 比赛
  if (/^\d+$/.test(text)) {
    return { kind: 'ambiguous', id: text };
  }

  // 其它 OJ 链接
  if (/^https?:\/\//i.test(text)) {
    const key = convertOjUrl(text);
    if (key) return { kind: 'problem', key, convertedFrom: text };
    return { kind: 'url', url: text };
  }

  return { kind: 'unknown', text };
}

function problemUrl(key, baseUrl = 'https://vjudge.net') {
  return `${baseUrl.replace(/\/$/, '')}/problem/${encodeURIComponent(key)}`;
}

function contestUrl(id, baseUrl = 'https://vjudge.net') {
  return `${baseUrl.replace(/\/$/, '')}/contest/${id}`;
}

function articleUrl(id, baseUrl = 'https://vjudge.net') {
  return `${baseUrl.replace(/\/$/, '')}/article/${id}`;
}

/** 团队（group）只能用 shortName 访问，数字 ID 打不开 */
function groupUrl(shortName, baseUrl = 'https://vjudge.net') {
  return `${baseUrl.replace(/\/$/, '')}/group/${encodeURIComponent(String(shortName).trim())}`;
}

function splitProblemKey(key) {
  const idx = String(key).indexOf('-');
  if (idx <= 0) return { oj: '', num: String(key) };
  return { oj: key.slice(0, idx), num: key.slice(idx + 1) };
}

/** 从一段文本里挑出第一个像题号的东西 */
function findProblemKeyInText(text) {
  const str = String(text || '');
  const urlMatch = str.match(/vjudge\.(?:net|cn)\/problem\/([A-Za-z0-9_\-]+(?:-[A-Za-z0-9_.]+)?)/i);
  if (urlMatch) return urlMatch[1];
  const native = str.match(/https?:\/\/[^\s)'"]+/i);
  if (native) {
    const converted = convertOjUrl(native[0]);
    if (converted) return converted;
  }
  // 已知 OJ 名（含中文「洛谷-P1001」）——粘在句子里没有空格也能挑出来
  const aliasHit = str.match(
    new RegExp(`(${OJ_ALIAS_PATTERN})\\s*-\\s*([A-Za-z0-9_][A-Za-z0-9_.]*)`, 'i')
  );
  if (aliasHit) {
    const key = normalizeProblemKey(`${aliasHit[1]}-${aliasHit[2]}`);
    if (key) return key;
  }
  // 其余按「空白/中英文标点」切词试一遍，只认已知 OJ 名，免得 e-mail 被当题号
  for (const token of str.split(/[\s,，。；;、（）()「」『』【】"'“”]+/)) {
    const key = normalizeProblemKey(token, { requireKnownOj: true });
    if (key) return key;
  }
  const keyMatch = str.match(/\b([A-Z][A-Za-z0-9]*(?:Code|OJ|Forces|Coder)?-[A-Za-z0-9_.]+)\b/);
  if (keyMatch) return normalizeProblemKey(keyMatch[1]) || keyMatch[1];
  return null;
}

/* ---------------- 公式定界符 ---------------- */

/**
 * 题面里的公式写法一共有五种，MathJax 只认 \( \) / \[ \]，所以统一扫一遍替换：
 *
 *   $$$$$x$$$$$$  Codeforces 的块级公式（CF 前端把 6 个 $ 当 display）
 *   $$$x$$$       Codeforces 的行内公式（CF 前端把 3 个 $ 当 inline，最常见）
 *   $$x$$         一般当块级；短的/夹在文字中间的当行内
 *   $x$           行内
 *   \(x\) \[x\]   已经是目标格式，原样保留
 *
 * 「最长定界符优先」一次扫描是必须的：如果分两遍替换，`$$$n$$$` 会先被 `$$` 规则
 * 吃掉一层，变成 `\(\(n\)\)`，MathJax 匹配外层后会把里面的 `\(` 当成未知命令、
 * 渲染成红色字面量——这就是截图里 `\(n ≤ 200000\)` 那个样子。
 */
const MATH_TOKEN_SOURCE = [
  '\\${6}[\\s\\S]*?\\${6}',
  '\\${3}[\\s\\S]*?\\${3}',
  '\\${2}[\\s\\S]*?\\${2}',
  // 单 $ 要求紧跟非空白，否则 `$5 和 $10` 这种价格会被当成一对公式
  '\\$[^\\s$](?:[^$\\n]*?[^\\s$])?\\$',
  '\\\\\\([\\s\\S]*?\\\\\\)',
  '\\\\\\[[\\s\\S]*?\\\\\\]',
].join('|');

/** 拿一个新的（带 g 的）公式正则：全局正则有 lastIndex 状态，别跨调用复用 */
function mathTokenRegex() {
  return new RegExp(`(${MATH_TOKEN_SOURCE})`, 'g');
}

/**
 * MathJax 3 里没有、但中文题面（洛谷/牛客/VJudge 中文翻译）很爱用的命令。
 * 不补的话 MathJax 的 noundefined 包会把它们**渲染成红色字面量**——
 * 例如洛谷 P1001 的中文题面写的是 `\(\bm a\)`，面板上就直接红字 `\bm a`。
 * 键是命令名（不带反斜杠），值按 MathJax `tex.macros` 的写法：[替换文本, 参数个数]。
 */
const MATHJAX_TEX_MACROS = {
  // bm 宏包：\bm{x} == \boldsymbol{x}（\bm 后面直接跟单个字母也要能用）
  bm: ['\\boldsymbol{#1}', 1],
  // LaTeX 的文本字体命令，MathJax 只认 \text{...}，这些一律折成数学字体
  texttt: ['\\mathtt{#1}', 1],
  textsf: ['\\mathsf{#1}', 1],
  textrm: ['\\mathrm{#1}', 1],
  textnormal: ['\\mathrm{#1}', 1],
  textup: ['\\mathrm{#1}', 1],
  textbf: ['\\mathbf{#1}', 1],
  textit: ['\\mathit{#1}', 1],
  textsl: ['\\mathit{#1}', 1],
  // 其他常见但不在 base 里的写法
  degree: ['{}^\\circ', 0],
  C: ['\\mathbb{C}', 0],
  N: ['\\mathbb{N}', 0],
  Q: ['\\mathbb{Q}', 0],
  R: ['\\mathbb{R}', 0],
  Z: ['\\mathbb{Z}', 0],
};

/**
 * 把 MathJax 不认识的命令就地修一遍（MathJax 那边也配了同样的宏，这里是双保险：
 * 万一宏没生效、或者公式引擎根本没加载，至少看到的是标准写法而不是裸命令）。
 */
function repairLatexCommands(latex) {
  return String(latex == null ? '' : latex)
    // \bm 后面可能直接跟字母（\bm a），也可能带花括号（\bm{a}）；别误伤 \bmod
    .replace(/\\bm(?![A-Za-z])/g, '\\boldsymbol');
}

/** 单个公式 token 转成 MathJax 定界符；不是公式就原样返回 */
function mathTokenToLatex(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text) return text;
  // 已经是 \( \) / \[ \]，只做命令修复，不重新包一层
  if (text.startsWith('\\(') || text.startsWith('\\[')) return repairLatexCommands(text);

  let body = null;
  let forcedInline = false;
  let forcedBlock = false;
  if (text.startsWith('$$$$$$') && text.endsWith('$$$$$$') && text.length > 12) {
    body = text.slice(6, -6);
    forcedBlock = true;
  } else if (text.startsWith('$$$') && text.endsWith('$$$') && text.length > 6) {
    body = text.slice(3, -3);
    forcedInline = true;
  } else if (text.startsWith('$$') && text.endsWith('$$') && text.length > 4) {
    body = text.slice(2, -2);
  } else if (text.startsWith('$') && text.endsWith('$') && text.length > 2) {
    body = text.slice(1, -1);
    forcedInline = true;
  }
  if (body === null) return text;

  const trimmed = body.trim();
  if (!trimmed) return text;
  // 里面还套着一层 \( \) / \[ \]（或残留 $），再包一层就会变成 \(\(..\)\)
  if (/^\\\([\s\S]*\\\)$/.test(trimmed) || /^\\\[[\s\S]*\\\]$/.test(trimmed)) {
    return repairLatexCommands(trimmed);
  }
  if (trimmed.includes('$')) return repairLatexCommands(trimmed);

  const isBlock =
    forcedBlock ||
    /\\(?:begin|displaystyle)\{/.test(trimmed) ||
    (!forcedInline && (trimmed.includes('\n') || trimmed.length > 120));
  const latex = repairLatexCommands(trimmed);
  return isBlock ? `\\[${latex}\\]` : `\\(${latex}\\)`;
}

/** 把一段纯文本里所有公式定界符统一成 \( \) / \[ \] */
function normalizeMathTokens(text) {
  return String(text == null ? '' : text).replace(mathTokenRegex(), (m) => mathTokenToLatex(m));
}

module.exports = {
  escapeHtml,
  decodeEntities,
  mathTokenRegex,
  mathTokenToLatex,
  normalizeMathTokens,
  repairLatexCommands,
  MATHJAX_TEX_MACROS,
  escapeTextKeepBreaks,
  formatDateTime,
  formatDuration,
  relativeTime,
  convertOjUrl,
  parseInput,
  problemUrl,
  contestUrl,
  articleUrl,
  groupUrl,
  splitProblemKey,
  findProblemKeyInText,
  normalizeProblemKey,
  canonicalOjName,
  OJ_NAME_MAP,
  OJ_KEY_ALIASES,
};
