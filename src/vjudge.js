'use strict';

const { request, formEncode } = require('./http');
const { LoginRequiredError } = require('./session');
const { splitProblemKey, problemUrl, contestUrl, articleUrl, groupUrl, decodeEntities, escapeHtml, normalizeMathTokens } = require('./util');
const { highlightCodeBlocks } = require('./highlight');
const { renderMarkdown } = require('./markdown');
const {
  buildSubmitBody, errorText, isCaptchaError, extractLanguageOptions, normalizeLanguageOptions,
  sourceProblem,
} = require('./submit');
const log = require('./log');

const CACHE_TTL = 5 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* HTML / JSON 解析工具                                                */
/* ------------------------------------------------------------------ */

/** 提取 vjudge 页面里隐藏的 dataJson */
function extractDataJson(html) {
  if (!html) return null;
  const m = /<textarea[^>]*name=["']dataJson["'][^>]*>([\s\S]*?)<\/textarea>/i.exec(html);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    } catch {
      return null;
    }
  }
}

/** 深度查找第一个命中的 key */
function deepGet(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = deepGet(value, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * 收集对象里所有"看起来像 HTML 正文"的字符串字段
 * @returns {{path: string, value: string}[]}
 */
function collectHtmlFields(obj, prefix = '', out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      if (value.length > 80 && /<[a-z][\w-]*[\s>]/i.test(value)) {
        out.push({ path, value });
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectHtmlFields(value, path, out, depth + 1);
    }
  }
  return out;
}

/** 在对象里找最长的纯文本字段（题面可能是 markdown） */
function findLongTextField(obj, keyPattern, prefix = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  let best = null;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      if (!keyPattern.test(key)) continue;
      if (value.length < 60) continue;
      if (/^https?:\/\//.test(value)) continue;
      if (!best || value.length > best.value.length) best = { path, value };
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findLongTextField(value, keyPattern, path, depth + 1);
      if (nested && (!best || nested.value.length > best.value.length)) best = nested;
    }
  }
  return best;
}

/** 按 class / id 提取一个元素的内部 HTML（支持嵌套同名标签） */
function extractElement(html, patterns) {
  for (const pattern of patterns) {
    const open = new RegExp(pattern, 'i').exec(html);
    if (!open) continue;
    // 属性片段可能不含 '<'，向前找最近的标签开头
    const tagStart = open[0].trimStart().startsWith('<') ? open.index : html.lastIndexOf('<', open.index);
    if (tagStart < 0) continue;
    const tagMatch = /^<([a-z][\w-]*)/i.exec(html.slice(tagStart, tagStart + 60));
    if (!tagMatch) continue;
    const tagName = tagMatch[1];
    const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
    // 从标签起始位置开始扫，才能正确计算嵌套层级
    tagRe.lastIndex = tagStart;
    let depth = 0;
    let m;
    while ((m = tagRe.exec(html))) {
      if (m[1] === '/') {
        depth -= 1;
        if (depth === 0) {
          const inner = html.slice(open.index + open[0].length, m.index);
          if (inner.trim()) return inner;
        }
      } else if (!m[0].endsWith('/>')) {
        depth += 1;
      }
    }
  }
  return null;
}

function looksLikeStatement(html) {
  if (!html) return false;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 60;
}

/** 从完整页面 HTML 里兜底抓题面 */
function extractStatementFromHtml(html) {
  const candidates = [
    'id="problem-statement"',
    "id='problem-statement'",
    'class="[^"]*\\bproblem-statement\\b',
    'class="[^"]*\\bproblem-content\\b',
    'class="[^"]*\\bproblem-desc\\b',
    'id="problem-content"',
    'class="[^"]*\\bmarkdown-body\\b',
  ].map((p) => `${p}[^>]*>`);
  const found = extractElement(html, candidates);
  if (looksLikeStatement(found)) return found;

  const article = extractElement(html, ['<article[^>]*>']);
  if (looksLikeStatement(article)) return article;
  return null;
}

/** 解析题目元信息 */
function buildProblemMeta(data, key, html) {
  const { oj, num } = splitProblemKey(key);
  const title =
    deepGet(data, ['title', 'problemTitle', 'name']) ||
    (html && (/<title>([^<]*)<\/title>/i.exec(html) || [])[1]) ||
    key;
  const timeLimit = deepGet(data, ['timeLimit', 'time', 'timeLimitMs', 'time_limit']);
  const memoryLimit = deepGet(data, ['memoryLimit', 'memory', 'memoryLimitKb', 'memory_limit']);
  const source = deepGet(data, ['source', 'origin', 'sourceTitle']);
  return {
    key,
    oj: deepGet(data, ['ojId', 'oj', 'ojName']) || oj,
    num: deepGet(data, ['probNum', 'num', 'problemNumber']) || num,
    title: String(title).replace(/\s*-\s*Virtual Judge\s*$/, '').trim(),
    source: typeof source === 'string' ? stripTags(source) : '',
    timeLimit: normalizeLimit(timeLimit),
    memoryLimit: normalizeLimit(memoryLimit),
  };
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** 把相对路径的图片补成绝对地址，否则 webview 里加载不出来 */
function absolutizeHtml(html, baseUrl) {
  if (!html) return html;
  return String(html)
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])\/(?!\/)/gi, `$1${baseUrl}/`)
    .replace(/(<img\b[^>]*?\bdata-src\s*=\s*["'])\/(?!\/)/gi, `$1${baseUrl}/`)
    .replace(/(<img\b[^>]*?)\sdata-src\s*=\s*["']([^"']+)["']/gi, (m, pre, src) => `${pre} src="${src}"`);
}

/**
 * 从 VJudge 的 HTML 错误页里抠一句人能读的话。
 * （提交被拒时服务端回的是整页 HTML，正文里那句才是真正的原因）
 */
function htmlMessage(html) {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

/* ------------------------------------------------------------------ */
/* 题面描述：/problem/description/{descKey}?{version}                   */
/* ------------------------------------------------------------------ */
/** 题面里的图片 / 公式图片都用 CDN_BASE_URL/ 占位；真实值由 /util/cfg 下发 */
const DEFAULT_CDN_BASE = 'https://cdn.vjudge.net.cn/';

/** 题面格式：VJudge 用 HTML / MD 两种 */
function isMarkdownFormat(format) {
  return /^(md|markdown|mdown)$/i.test(String(format || '').trim()) ||
    /markdown/i.test(String(format || ''));
}

function looksLikeDescBrief(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const key = Number(item.key);
  if (!Number.isFinite(key) || key <= 0) return false;
  return Number.isFinite(Number(item.version)) || 'lang' in item || 'author' in item || 'type' in item;
}

/** 从 dataJson（descBriefs 等）和题目页 DOM（#prob-descs li）里收集题面版本 */
function collectDescriptionRefs(html, data) {
  const refs = [];
  const seen = new Set();
  const push = (key, version, extra) => {
    const k = Number(key);
    if (!Number.isFinite(k) || k <= 0 || seen.has(k)) return;
    seen.add(k);
    refs.push({ key: k, version: Number(version) || 0, ...(extra || {}) });
  };

  const arrays = [];
  if (data) {
    for (const name of ['descBriefs', 'descriptions', 'descriptionBriefs', 'problemDescBriefs']) {
      if (Array.isArray(data[name])) arrays.push(data[name]);
    }
    // 兜底：有界深挖，找形如 {key, version, lang} 的数组
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4) return;
      if (Array.isArray(node)) {
        if (node.some(looksLikeDescBrief)) arrays.push(node);
        node.slice(0, 20).forEach((child) => walk(child, depth + 1));
        return;
      }
      Object.keys(node)
        .slice(0, 60)
        .forEach((k) => walk(node[k], depth + 1));
    };
    walk(data, 0);
  }

  for (const list of arrays) {
    for (const item of list) {
      if (!looksLikeDescBrief(item)) continue;
      push(item.key, item.version, {
        lang: item.lang,
        type: item.type,
        authorKey: item.authorKey,
        official: item.official === true,
        mainOfficial: item.mainOfficial === true,
        publicVisible: item.publicVisible,
      });
    }
  }

  // 页面 DOM：<li data-key="..." data-version="..." data-author="...">
  const liRe = /<li\b[^>]*\bdata-key\s*=\s*["'](\d+)["'][^>]*>/gi;
  let m;
  while ((m = liRe.exec(html || ''))) {
    const tag = m[0];
    const version = (/\bdata-version\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    const author = (/\bdata-author\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    const type = (/\bdata-type\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    push(m[1], version, { author, type, fromDom: true });
  }

  // 标签名不一定是 li，兜底再扫一遍同时带 data-key / data-version 的标签
  const tagRe = /<[a-z][\w-]*\b[^>]*\bdata-key\s*=\s*["'](\d+)["'][^>]*\bdata-version\s*=\s*["']([^"']*)["'][^>]*>/gi;
  while ((m = tagRe.exec(html || ''))) {
    push(m[1], m[2], { fromDom: true });
  }

  // dataJson 里直接给的 descriptionId 也能用（不带 version 也返回 200）
  const directId = data && (data.descriptionId || data.descId);
  if (directId && /^\d+$/.test(String(directId))) push(directId, 0, { fromDataJson: true });

  return refs;
}

/** 语言代码 -> 显示名（优先用站点 /util/cfg 给的 statementLanguages） */
const LANG_LABELS = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ru: 'русский',
  es: 'Español',
  vi: 'Tiếng Việt',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  pt: 'português',
  it: 'Italiano',
  pl: 'Polski',
  tr: 'Türkçe',
  uk: 'Українська',
  ar: 'العربية',
  fa: 'فارسی',
  hi: 'हिन्दी',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  ro: 'Română',
  kk: 'Қазақ тілі',
  az: 'Azərbaycan',
  bn: 'বাংলা',
};

function langLabelOf(lang, cfg) {
  const code = String(lang || '').trim().toLowerCase();
  if (!code) return '';
  const table = (cfg && cfg.statementLanguages) || {};
  return table[code] || LANG_LABELS[code] || code;
}

/** 面板里下拉显示的一行：中文 · 官方 / 翻译 · 作者 */
function describeDescRef(ref, cfg) {
  const parts = [];
  const lang = langLabelOf(ref.lang, cfg);
  if (lang) parts.push(lang);
  if (ref.mainOfficial) parts.push('官方');
  else if (ref.official) parts.push('官方');
  else if (ref.type === 'translator') parts.push('译文');
  else if (ref.type === 'user') parts.push('用户版');
  else if (ref.fromDom || ref.type) parts.push(ref.type || '版本');
  if (ref.author && !ref.mainOfficial) parts.push(ref.author);
  if (!parts.length) parts.push(`版本 ${ref.key}`);
  return parts.join(' · ');
}

/** 官方主版本优先，其次英文，再其次任意 */
function pickDescriptionRef(refs) {
  if (!refs || !refs.length) return null;
  const score = (r) =>
    (r.mainOfficial ? 8 : 0) +
    (r.official ? 4 : 0) +
    (r.type === 'main' ? 3 : 0) +
    (r.authorKey === 'main' ? 2 : 0) +
    (r.lang === 'en' ? 1 : 0);
  return [...refs].sort((a, b) => score(b) - score(a))[0];
}

/**
 * 统一公式定界符：MathJax 只吃 \( \) / \[ \]，所以把题面里的 $...$ / $$...$$ / $$$...$$$ 都规范化。
 * 只处理文本节点（跳过标签内部），避免动到属性。
 * 具体规则见 util.js 的 mathTokenToLatex —— 定界符必须「长的先匹配」，
 * 否则 $$$n$$$ 会被 $$ 规则吃掉一层变成 \(\(n\)\)。
 */
function normalizeMathDelimiters(html) {
  const src = String(html || '');
  // <pre>/<code> 里是原样展示的内容（样例输入输出），里面的 $ 不是公式，先整块保护起来
  const guarded = [];
  const masked = src.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    guarded.push(m);
    return `\u0000G${guarded.length - 1}\u0000`;
  });
  const out = masked
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (!part || part.charAt(0) === '<') return part;
      return normalizeMathTokens(part);
    })
    .join('');
  return out.replace(/\u0000G(\d+)\u0000/g, (_, i) => guarded[Number(i)] || '');
}

/** 题面 JSON -> HTML（{prependHtml, sections:[{title, value:{format, content}}]}） */
function descriptionPayloadToHtml(payload, cdnBase) {
  const parts = [];
  const sections = payload && Array.isArray(payload.sections) ? payload.sections : [];

  for (const section of sections) {
    const value = (section && section.value) || {};
    let content = typeof value.content === 'string' ? value.content : '';
    if (!content.trim()) continue;
    // 公式统一留到最后 normalizeMathDelimiters 处理，这里只管格式
    if (isMarkdownFormat(value.format)) content = renderMarkdown(content);
    if (section.title) {
      parts.push(`<h4 class="vj-desc-title">${escapeHtml(decodeEntities(section.title))}</h4>`);
    }
    parts.push(content);
  }

  if (!parts.length) {
    const legacy =
      typeof payload === 'string' ? payload : (payload && (payload.description || payload.content)) || '';
    if (typeof legacy === 'string' && legacy.trim()) parts.push(legacy);
  }

  let html = parts.join('\n');
  if (cdnBase) html = html.replace(/CDN_BASE_URL\//g, cdnBase);
  return html;
}

/** 从描述页里取出 JSON（textarea.data-json-container） */
function extractDescriptionPayload(html) {
  const text = String(html || '');
  const patterns = [
    /<textarea[^>]*class="[^"]*data-json-container[^"]*"[^>]*>([\s\S]*?)<\/textarea>/i,
    /<textarea[^>]*name="dataJson"[^>]*>([\s\S]*?)<\/textarea>/i,
    /<textarea[^>]*>([\s\S]*?)<\/textarea>/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(decodeEntities(raw));
      } catch {
        /* 继续尝试下一个 */
      }
    }
  }
  // 有些版本直接返回裸 JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number') {
    if (value > 100000) return `${(value / 1000).toFixed(0)} s`;
    return `${value}`;
  }
  return String(value).trim();
}

/* ------------------------------------------------------------------ */

class VJudgeClient {
  constructor(session) {
    this.session = session;
    this.cache = new Map();
  }

  get baseUrl() {
    return this.session.baseUrl;
  }

  cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }
    return hit.value;
  }

  cacheSet(key, value) {
    if (this.cache.size > 60) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });
  }

  clearCache() {
    this.cache.clear();
    this._myUserId = undefined;
  }

  async httpGet(pathname, extraHeaders) {
    const url = pathname.startsWith('http') ? pathname : `${this.baseUrl}${pathname}`;
    const res = await request(url, {
      headers: {
        Referer: `${this.baseUrl}/`,
        'X-Requested-With': 'XMLHttpRequest',
        ...extraHeaders,
      },
      jar: this.session.jar,
      timeout: this.session.timeout,
    });
    return res;
  }

  assertNotLoginWall(res) {
    const finalUrl = String(res.url || '');
    if (/[?&]login=1/i.test(finalUrl) || /\/user\/login/i.test(finalUrl)) {
      throw new LoginRequiredError(
        this.session.hasCredentials
          ? 'VJudge 登录状态已失效，请重新登录（VJudge: 登录 / 更新凭据）'
          : '该页面需要登录 VJudge 才能查看，请先执行「VJudge: 登录 / 更新凭据」'
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new LoginRequiredError(`VJudge 返回 ${res.status}，可能需要登录或权限不足`);
    }
  }

  /* --------------------------- 题目 --------------------------- */

  /**
   * @param {string} key 形如 CodeForces-1A
   * @param {{fresh?: boolean}} [options]
   */
  async fetchProblem(key, options = {}) {
    const cacheKey = `problem:${key}:${options.descKey || ''}`;
    if (!options.fresh) {
      const cached = this.cacheGet(cacheKey);
      if (cached) return cached;
    }

    const res = await this.httpGet(`/problem/${encodeURIComponent(key)}`);
    this.assertNotLoginWall(res);

    const html = res.body || '';
    const data = extractDataJson(html);

    let statementHtml = null;
    let statementSource = '';
    let descriptionId = null;
    let diagnostics = null;

    if (data) {
      descriptionId = deepGet(data, ['descriptionId', 'descId']);

      const fields = collectHtmlFields(data).sort((a, b) => b.value.length - a.value.length);
      const preferred = fields.find((f) => /description|statement|content|problem/i.test(f.path));
      const picked = preferred || fields[0];
      if (picked && looksLikeStatement(picked.value)) {
        statementHtml = picked.value;
        statementSource = `dataJson:${picked.path}`;
      }

      // 题面可能是 markdown 而不是 HTML
      if (!statementHtml) {
        const md = findLongTextField(data, /description|statement|content|problem/i);
        if (md && md.value.length > 60) {
          statementHtml = renderMarkdown(md.value);
          statementSource = `dataJson-markdown:${md.path}`;
        }
      }

      if (!statementHtml) {
        diagnostics = {
          hasDataJson: true,
          keys: Object.keys(data).slice(0, 30),
          textFields: collectHtmlFields(data).map((f) => f.path).slice(0, 10),
        };
      }
    } else {
      diagnostics = { hasDataJson: false, htmlLength: html.length };
    }

    if (!statementHtml) {
      const fromHtml = extractStatementFromHtml(html);
      if (fromHtml) {
        statementHtml = fromHtml;
        statementSource = 'html';
      }
    }

    // 主线：新版 VJudge 的题面在独立接口 /problem/description/{descKey}?{version}
    const refs = collectDescriptionRefs(html, data);
    const cfg = refs.length ? await this.siteConfig() : {};
    const descVersions = refs.map((r) => ({
      ...r,
      langLabel: langLabelOf(r.lang, cfg),
      label: describeDescRef(r, cfg),
    }));
    let descCurrent = null;

    // 用户指定了版本就优先用它
    if (options.descKey) {
      const wanted = descVersions.find((v) => v.key === Number(options.descKey));
      if (wanted) {
        descVersions.unshift(...descVersions.splice(descVersions.indexOf(wanted), 1));
      }
    }

    if (!statementHtml) {
      for (const ref of descVersions.slice(0, 3)) {
        try {
          const descHtml = await this.fetchProblemDescription(ref);
          if (looksLikeStatement(descHtml)) {
            statementHtml = descHtml;
            statementSource = `description:${ref.key}`;
            descCurrent = ref;
            break;
          }
        } catch {
          /* 换下一个版本 */
        }
      }
      if (!statementHtml && diagnostics) diagnostics.descRefs = refs.length;
    }

    const meta = buildProblemMeta(data, key, html);
    const result = {
      ...meta,
      // 顺序：先统一公式定界符，再给代码块上色（上色会插 <span>，放在公式处理之后省得互相干扰）
      statementHtml: statementHtml
        ? absolutizeHtml(highlightCodeBlocks(normalizeMathDelimiters(statementHtml)), this.baseUrl)
        : '',
      statementSource: statementSource || 'none',
      descVersions,
      descCurrent,
      descLang: descCurrent ? descCurrent.langLabel : '',
      url: problemUrl(key, this.baseUrl),
      data,
      diagnostics,
      rawHtml: statementHtml ? undefined : html.slice(0, 4000),
      fetchedAt: Date.now(),
    };

    this.cacheSet(cacheKey, result);
    return result;
  }

  /** 站点配置（含真实 CDN 地址、语言名），缓存 30 分钟 */
  async siteConfig() {
    const now = Date.now();
    if (this._cfg && this._cfgAt && now - this._cfgAt < 30 * 60 * 1000) return this._cfg;
    try {
      const res = await this.httpGet('/util/cfg');
      const cfg = JSON.parse(res.body);
      if (cfg && typeof cfg === 'object') {
        this._cfg = cfg;
        this._cfgAt = now;
        return cfg;
      }
    } catch {
      /* 拿不到就用默认值 */
    }
    return this._cfg || {};
  }

  /** 取题面正文：/problem/description/{descKey}?{version} */
  async fetchProblemDescription(ref) {
    const version = ref && ref.version ? `?${ref.version}` : '';
    const res = await this.httpGet(`/problem/description/${encodeURIComponent(ref.key)}${version}`);

    const cfg = await this.siteConfig();
    const cdnBase =
      (cfg && cfg.cdnBaseUrl) || (this.session && this.session.cdnBaseUrl) || DEFAULT_CDN_BASE;

    const payload = extractDescriptionPayload(res.body);
    if (payload) {
      const html = descriptionPayloadToHtml(payload, cdnBase);
      if (html.trim()) return absolutizeHtml(html, String(cdnBase).replace(/\/$/, ''));
    }

    // 万一返回的是已经渲染好的页面，退回 DOM 提取
    return extractStatementFromHtml(res.body || '') || '';
  }

  /** 随机题目：访问 /problem/random 后从重定向地址里取出题号 */
  async randomProblem() {
    const res = await this.httpGet('/problem/random');
    this.assertNotLoginWall(res);
    const match = /\/problem\/([A-Za-z0-9_.%+-]+)\s*(?:[?#]|$)/.exec(res.url || '');
    if (!match) {
      throw new Error('VJudge 没有返回随机题目（可能需要登录，或该功能暂时不可用）');
    }
    return decodeURIComponent(match[1]);
  }

  /* --------------------------- 提交 / 评测 --------------------------- */

  /**
   * 提交代码。
   *
   * 练习提交走 POST /problem/submit/{key}，
   * 比赛内提交走 POST /contest/submit/{contestId}/{problemNum}（problemNum 是 A/B/C…）。
   * 表单和 VJudge 提交弹窗一致：method&language&open&source=&captcha&password
   * ——source 是**代码原文**，URL 编码交给表单序列化，千万别自己 base64。
   * 比赛提交还**必须**带上比赛的 version（网页端 `version: St.version`，即比赛 dataJson.version），
   * 少了它服务端直接 400。
   *
   * @param {{key: string, code: string, language: string|number,
   *          contestId?: string|number, problemNum?: string,
   *          method?: number|string, bindingId?: string|number,
   *          version?: string|number, accessCode?: string,
   *          open?: boolean, password?: string, captcha?: string, token?: string}} options
   * @returns {Promise<{runId: string|number, raw: object, url: string, contestId: string, problemNum: string}>}
   */
  async submitCode(options = {}) {
    const key = String(options.key || '').trim();
    const code = String(options.code === undefined || options.code === null ? '' : options.code);
    if (!key) throw new Error('没有指定要提交的题目');
    if (!code.trim()) throw new Error('代码是空的，没什么可提交的');
    const badSource = sourceProblem(code);
    if (badSource) throw new Error(badSource);
    if (!this.session.hasCredentials) {
      throw new LoginRequiredError('提交代码需要先登录 VJudge（VJudge: 登录 / 更新凭据）');
    }

    const contestId = options.contestId ? String(options.contestId) : '';
    const problemNum = options.problemNum ? String(options.problemNum) : '';
    const inContest = !!(contestId && problemNum);
    const path = inContest
      ? `/contest/submit/${encodeURIComponent(contestId)}/${encodeURIComponent(problemNum)}`
      : `/problem/submit/${encodeURIComponent(key)}`;

    const body = buildSubmitBody({
      method: options.method,
      bindingId: options.bindingId,
      language: options.language,
      code,
      open: options.open,
      password: options.password,
      captcha: options.captcha,
      version: options.version,
      accessCode: options.accessCode,
      token: options.token,
    });

    // 记下这次到底打到哪条通道、带了什么字段（不记源码本身，只记长度）
    log.write('submit.request', {
      path,
      channel: inContest ? 'contest' : 'problem',
      key,
      contestId,
      problemNum,
      method: body.method,
      bindingId: body.bindingId || '',
      language: body.language,
      open: body.open,
      version: body.version || '',
      hasAccessCode: body.accessCode !== undefined,
      hasToken: body.token !== undefined,
      codeLength: code.length,
    });

    // 和浏览器一致：比赛提交的 Referer 是比赛页，练习提交是题目页
    const referer = inContest
      ? `${this.baseUrl}/contest/${encodeURIComponent(contestId)}`
      : problemUrl(key, this.baseUrl);

    let res;
    try {
      res = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: referer,
          Origin: this.baseUrl,
        },
        body: formEncode(body),
        jar: this.session.jar,
        timeout: this.session.timeout,
      });
    } catch (err) {
      log.write('submit.network_error', { path, message: String(err && err.message) });
      throw err;
    }
    log.write('submit.response', {
      path,
      status: res.status,
      body: log.snippet(res.body, 400),
    });

    let payload = null;
    try {
      payload = JSON.parse(res.body);
    } catch {
      payload = null;
    }

    if (payload && payload.error) {
      log.write('submit.error', {
        path,
        i18nKey: String(payload.error.i18nKey || payload.error.key || ''),
        i18nArgs: payload.error.i18nArgs || null,
      });
      const err = new Error(errorText(payload.error));
      err.i18nKey = String(payload.error.i18nKey || payload.error.key || '');
      err.captcha = isCaptchaError(payload.error);
      // 让上层的 handleError 走「去登录」提示
      if (err.captcha === false && /login|auth|session/i.test(err.i18nKey)) {
        err.code = 'LOGIN_REQUIRED';
      }
      throw err;
    }

    if (!payload || payload.runId === undefined || payload.runId === null || payload.runId === '') {
      // 没登录时 VJudge 会 303 到登录页，这时 body 是 HTML，交给 assertNotLoginWall 判断
      log.write('submit.no_runid', { path, status: res.status });
      this.assertNotLoginWall(res);
      if (res.status === 400) {
        // VJudge 对「字段不对 / 通道不对」一律回 400 + HTML 错误页，
        // 把页面正文抠出来塞进报错里，比一句猜出来的原因有用得多。
        const detail = htmlMessage(res.body);
        log.write('submit.http400', { path, detail });
        const err = new Error(
          `VJudge 拒绝了这次提交（HTTP 400）${detail ? `：${detail}` : ''}`
        );
        err.status = 400;
        err.detail = detail;
        throw err;
      }
      if (res.status >= 400) throw new Error(`提交失败（HTTP ${res.status}）`);
      throw new Error('提交失败：VJudge 没有返回提交编号（runId），站点结构可能已变化');
    }

    log.write('submit.ok', { path, channel: inContest ? 'contest' : 'problem', runId: payload.runId });

    return {
      runId: payload.runId,
      raw: payload,
      url: `${this.baseUrl}/solution/${payload.runId}`,
      contestId,
      problemNum,
      method: Number(options.method) || 0,
    };
  }

  /**
   * 自己在各 OJ 上绑定的账号（提交方式「自己的账号」要用）。
   * GET /user/remoteAccounts/list?oj=CodeForces -> {bindings:[{id, accountId, accountDisplay, runtimeStatus}]}
   * runtimeStatus === 'READY' 才真的能用来交题。
   */
  async fetchRemoteAccounts(oj) {
    const query = oj ? `?oj=${encodeURIComponent(oj)}` : '';
    const res = await this.httpGet(`/user/remoteAccounts/list${query}`);
    this.assertNotLoginWall(res);
    let data = null;
    try {
      data = JSON.parse(res.body);
    } catch {
      data = null;
    }

    // 真实形态是 {groups: {CodeForces: {bindings: [...]}}}；另外兼容扁平写法
    const list = [];
    const groups = data && data.groups;
    if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
      for (const [groupOj, group] of Object.entries(groups)) {
        if (oj && String(groupOj) !== String(oj)) continue;
        for (const item of Array.isArray(group && group.bindings) ? group.bindings : []) {
          list.push({ ...item, oj: item.oj || groupOj });
        }
      }
    } else if (Array.isArray(data && data.bindings)) {
      list.push(...data.bindings);
    } else if (Array.isArray(data)) {
      list.push(...data);
    }

    return list
      .map((item) => {
        const status = String(item.runtimeStatus || item.status || '');
        const health = String(item.healthStatus || '').toUpperCase();
        return {
          id: String(item.id === undefined || item.id === null ? '' : item.id),
          accountId: String(item.accountId || ''),
          display: stripTags(item.accountDisplay || item.accountId || '') || String(item.accountId || ''),
          oj: String(item.oj || oj || ''),
          status,
          // 只有 READY 且没被标记 incomplete 的绑定才真的能用来交题
          ready: status === 'READY' && health !== 'INCOMPLETE' && item.isIncomplete !== true,
        };
      })
      .filter((item) => item.id);
  }

  /** 这个 OJ 有没有绑定过账号 */
  get remoteAccountUrl() {
    return `${this.baseUrl}/user/remoteAccounts`;
  }

  /** 单次查询评测结果（VJudge 前端也是这么轮询的） */
  async fetchSolution(runId) {
    const id = String(runId === undefined || runId === null ? '' : runId).trim();
    if (!id) throw new Error('缺少提交编号');
    const res = await request(`${this.baseUrl}/solution/data/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${this.baseUrl}/solution/${encodeURIComponent(id)}`,
      },
      body: 'showCode=false',
      jar: this.session.jar,
      timeout: this.session.timeout,
    });

    let payload = null;
    try {
      payload = JSON.parse(res.body);
    } catch {
      payload = null;
    }
    if (!payload) throw new Error(`拿不到提交 ${id} 的评测结果（HTTP ${res.status}）`);
    if (payload.error) throw new Error(errorText(payload.error));
    return payload;
  }

  /**
   * 轮询到出结果为止。超时把最后一次状态返回（不算失败）。
   * @param {string|number} runId
   * @param {{intervalMs?: number, timeoutMs?: number, isCancelled?: () => boolean,
   *          onTick?: (solution: object|null) => void, onError?: (err: Error) => void}} [options]
   */
  async waitForVerdict(runId, options = {}) {
    const interval = Math.max(Number(options.intervalMs) || 1500, 500);
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
    const deadline = Date.now() + timeoutMs;
    let latest = null;

    while (Date.now() < deadline) {
      if (options.isCancelled && options.isCancelled()) return latest;
      try {
        latest = await this.fetchSolution(runId);
      } catch (err) {
        if (options.onError) options.onError(err);
      }
      if (latest && latest.processing !== true) return latest;
      if (options.onTick) options.onTick(latest);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return latest;
  }

  /**
   * 这道题能用的提交语言。
   * 先看题目页 dataJson（VJudge 的提交弹窗就用它），
   * 拿不到再退回 /util/cfg 里各 OJ 的语言表。
   * @returns {Promise<{id: string, name: string}[]>}
   */
  async problemLanguages(problem) {
    const fromData = extractLanguageOptions(problem && problem.data);
    if (fromData.length) return fromData;

    const oj = (problem && (problem.oj || splitProblemKey(problem.key).oj)) || '';
    try {
      const cfg = await this.siteConfig();
      const remote = (cfg.remoteOJs || {})[oj] || {};
      return normalizeLanguageOptions(remote.languages);
    } catch {
      return [];
    }
  }

  /** 比赛内题目：先拿到题目 key，再取题面 */
  async resolveContestProblem(contestId, index) {
    const problems = await this.fetchContestProblems(contestId);
    const wanted = String(index).toUpperCase();
    const hit = problems.find(
      (p) => String(p.index).toUpperCase() === wanted || String(p.num).toUpperCase() === wanted
    );
    if (!hit) {
      throw new Error(`比赛 ${contestId} 中找不到题目 ${index}（可能需要登录或该比赛已隐藏题目）`);
    }
    return hit;
  }

  async fetchContestProblems(contestId, contestData) {
    const cacheKey = `contestProblems:${contestId}`;
    const cached = this.cacheGet(cacheKey);
    if (cached && cached.length) return cached;

    // 首选：比赛页 dataJson.problems（新版页面就是这么渲染的，
    // 公开比赛未登录也能拿到，私有比赛在有权限时会带上）
    const fromPage = parseContestPageProblems(contestData);
    if (fromPage.length) {
      this.cacheSet(cacheKey, fromPage);
      return fromPage;
    }

    // 兜底：老接口，未登录 / 无权限时会被 303 回 /contest
    try {
      const res = await this.httpGet(`/contest/filterProblem?contestId=${encodeURIComponent(contestId)}`);
      this.assertNotLoginWall(res);
      const body = String(res.body || '').trim();
      const isJson =
        /json/i.test(String(res.headers['content-type'] || '')) || body.startsWith('[') || body.startsWith('{');
      if (isJson) {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = null;
        }
        const problems = parseContestProblems(payload);
        if (problems.length) {
          this.cacheSet(cacheKey, problems);
          return problems;
        }
      }
    } catch {
      /* 落到下面的原因解析 */
    }

    throw new Error(explainNoProblems(contestData));
  }

  /* --------------------------- 比赛 --------------------------- */

  /**
   * @param {{mode?: 'live'|'recent', page?: number, pageSize?: number}} options
   *  live   = 进行中 + 即将开始（合并 running 列表与最新列表，去掉已结束的）
   *  recent = 最新创建的比赛
   */
  async listContests(options = {}) {
    const mode = options.mode === 'recent' ? 'recent' : 'live';
    const pageSize = Math.min(Number(options.pageSize) || 20, 100);
    const page = Math.max(Number(options.page) || 1, 1);

    if (mode === 'recent') {
      const list = await this.fetchContestRows({ pageSize, page });
      return list;
    }

    // vjudge 的 running=1 只包含"未开始"的比赛，正在进行的要另取最新列表
    const [live, latest] = await Promise.all([
      this.fetchContestRows({ pageSize: Math.max(pageSize, 20), running: true }),
      this.fetchContestRows({ pageSize: Math.max(pageSize, 20) }),
    ]);
    const map = new Map();
    for (const contest of [...live, ...latest]) {
      if (contest.state === 'ended') continue;
      if (!map.has(contest.id)) map.set(contest.id, contest);
    }
    const list = [...map.values()];
    list.sort((a, b) => {
      const rank = (c) => (c.state === 'running' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.state === 'upcoming') return a.begin - b.begin;
      return b.id - a.id;
    });
    return list.slice(0, pageSize);
  }

  /** 拉取比赛列表原始行并转成对象 */
  async fetchContestRows({ pageSize = 20, page = 1, running = false } = {}) {
    const params = new URLSearchParams({
      draw: '1',
      start: String((page - 1) * pageSize),
      length: String(pageSize),
      sortCol: '0',
      sortDir: 'desc',
    });
    if (running) params.set('running', '1');

    const res = await this.httpGet(`/contest/data?${params.toString()}`);
    let payload;
    try {
      payload = JSON.parse(res.body);
    } catch {
      throw new Error('比赛列表返回了无法解析的内容，站点结构可能已变化');
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const now = Date.now();

    return rows.map((row) => {
      const begin = Number(row[3]) || 0;
      const end = Number(row[4]) || 0;
      const state = end && now > end ? 'ended' : begin && now < begin ? 'upcoming' : 'running';
      return {
        id: row[0],
        title: row[1],
        type: row[2],
        begin,
        end,
        openness: row[5],
        contestants: row[6],
        manager: row[7],
        groupName: row[8],
        isFav: !!row[10],
        avatar: row[11],
        url: contestUrl(row[0], this.baseUrl),
        state,
      };
    });
  }

  async fetchContest(id) {
    const cacheKey = `contest:${id}`;
    const cached = this.cacheGet(cacheKey);
    if (cached) return cached;

    const res = await this.httpGet(`/contest/${encodeURIComponent(id)}`);
    this.assertNotLoginWall(res);
    const data = extractDataJson(res.body || '') || {};

    let problems = [];
    let problemsError = '';
    try {
      problems = await this.fetchContestProblems(id, data);
    } catch (err) {
      problemsError = err instanceof LoginRequiredError ? '登录后可查看题目列表' : err.message;
    }

    const result = {
      id: String(id),
      title: decodeEntities(data.title) || `比赛 ${id}`,
      begin: data.begin,
      end: data.end,
      type: data.type,
      openness: data.openness,
      opennessLabel: opennessLabel(data),
      authStatus: data.authStatus,
      loggedIn: !!(this.session && this.session.hasCredentials),
      accessLabel: accessLabel(data),
      access: contestAccess(data),
      started: data.started,
      ended: data.ended,
      managerId: data.managerId,
      penalty: data.penalty,
      sumTime: data.sumTime,
      partialScore: data.partialScore,
      oneShot: data.oneShot,
      enableFreeze: data.enableFreeze,
      freezeTime: data.freezeTime,
      unfreezeTime: data.unfreezeTime,
      problemsHash: data.problemsHash,
      // 比赛快照版本：比赛内提交必须原样回传，否则服务端直接 400（前端是 version: St.version）
      version: data.version === undefined || data.version === null ? '' : String(data.version),
      privatePeerContestIds: data.privatePeerContestIds,
      participation: data.participation,
      fav: data.fav,
      problems,
      problemsError,
      url: contestUrl(id, this.baseUrl),
      data,
    };
    this.cacheSet(cacheKey, result);
    return result;
  }

  /**
   * 比赛榜单原始数据。网页前端也是每 5 秒拉一次这个接口。
   *
   * GET /contest/rank/single/{id}
   * → { id, title, begin, length, isReplay, participants: {uid: {...}}, submissions: [[uid, probIdx, status, sec, ...]] }
   *
   * 不缓存：榜单本来就是要「实时」。
   */
  async fetchContestRank(id) {
    const res = await this.httpGet(`/contest/rank/single/${encodeURIComponent(id)}`, {
      Referer: `${contestUrl(id, this.baseUrl)}#rank`,
      Accept: 'application/json, text/javascript, */*; q=0.01',
    });
    this.assertNotLoginWall(res);

    let payload = null;
    try {
      payload = JSON.parse(res.body);
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== 'object') {
      if (res.status === 403 || res.status === 401) {
        throw new LoginRequiredError('榜单需要登录 / 报名这场比赛后才能查看');
      }
      throw new Error(`拿不到比赛 ${id} 的榜单（HTTP ${res.status}）`);
    }
    if (payload.error) throw new Error(errorText(payload.error));
    if (!payload.participants && !payload.submissions) {
      throw new Error(`比赛 ${id} 的榜单数据为空（可能还没开始或已被隐藏）`);
    }
    return {
      id: String(payload.id != null ? payload.id : id),
      title: payload.title || '',
      begin: payload.begin,
      length: payload.length,
      isReplay: !!payload.isReplay,
      participants: payload.participants || {},
      submissions: Array.isArray(payload.submissions) ? payload.submissions : [],
      raw: payload,
    };
  }

  /** 自己的 userId（用于榜单高亮）。拿不到就返回空串，不影响其它功能。 */
  async myUserId() {
    if (this._myUserId !== undefined) return this._myUserId;
    if (!this.session.hasCredentials) {
      this._myUserId = '';
      return '';
    }
    try {
      const res = await this.httpGet('/user/');
      const data = extractDataJson(res.body || '') || {};
      const id = data.userId != null ? data.userId : data.id;
      this._myUserId = id != null ? String(id) : '';
    } catch {
      this._myUserId = '';
    }
    return this._myUserId;
  }

  /* --------------------------- 文章 --------------------------- */

  async fetchArticle(id) {
    const cacheKey = `article:${id}`;
    const cached = this.cacheGet(cacheKey);
    if (cached) return cached;

    const res = await this.httpGet(`/article/${encodeURIComponent(id)}`);
    this.assertNotLoginWall(res);
    const data = extractDataJson(res.body || '');
    if (!data) {
      throw new Error(`无法解析文章 ${id}，可能文章不存在或已删除`);
    }

    let problems = [];
    const brief = deepGet(data, ['problemsBrief']);
    if (typeof brief === 'string') {
      try {
        const parsed = JSON.parse(brief);
        problems = Object.entries(parsed).map(([key, value]) => ({
          key,
          title: Array.isArray(value) ? value[0] : '',
          source: Array.isArray(value) && typeof value[2] === 'string' ? stripTags(value[2]) : '',
          acCount: Array.isArray(value) ? value[3] : undefined,
          submitCount: Array.isArray(value) ? value[4] : undefined,
        }));
      } catch {
        problems = [];
      }
    }

    const result = {
      id: String(data.id || id),
      title: data.title || `文章 ${id}`,
      author: data.author || '',
      content: data.content || '',
      createTime: data.createTime,
      updateTime: data.updateTime,
      viewCnt: data.viewCnt,
      likeCnt: data.likeCnt,
      isWorkbook: !!data.isWorkbook,
      problems,
      url: articleUrl(id, this.baseUrl),
      data,
    };
    this.cacheSet(cacheKey, result);
    return result;
  }

  /* --------------------------- 团队（group） --------------------------- */

  /**
   * 团队首页：我的团队 / 收到的邀请 / 公开团队
   * @returns {Promise<{mine: object[], invitations: object[], discover: object[]}>}
   */
  async listGroups() {
    const cacheKey = 'groups';
    const cached = this.cacheGet(cacheKey);
    if (cached) return cached;

    const res = await this.httpGet('/group');
    this.assertNotLoginWall(res);
    const data = extractDataJson(res.body || '');
    if (!data) throw new Error('无法解析团队列表，VJudge 站点结构可能已变化');

    const result = {
      mine: (data.myGroups || []).map(toGroupCard),
      invitations: (data.invitationGroups || []).map(toGroupCard),
      discover: (data.newGroupCards || []).map(toGroupCard),
    };
    this.cacheSet(cacheKey, result);
    return result;
  }

  /** 搜索团队：POST /group/search，返回团队卡片列表 */
  async searchGroups(keyword) {
    const query = String(keyword || '').trim();
    if (!query) return [];

    const res = await request(`${this.baseUrl}/group/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${this.baseUrl}/group`,
      },
      body: formEncode({ name: query }),
      jar: this.session.jar,
      timeout: this.session.timeout,
    });
    this.assertNotLoginWall(res);

    let payload;
    try {
      payload = JSON.parse(res.body);
    } catch {
      return [];
    }
    const cards = payload && Array.isArray(payload.cards) ? payload.cards : [];
    return cards.map(toGroupCard);
  }

  /**
   * 打开团队：接受 shortName、`/group/xxx` 链接、数字 ID 或团队名称
   * @param {string} nameOrId
   * @param {{fresh?: boolean}} [options]
   */
  async fetchGroup(nameOrId, options = {}) {
    const key = normalizeGroupKey(nameOrId);
    if (!key) throw new Error('请输入团队短名、团队链接或团队名称');

    const cacheKey = `group:${key}`;
    if (!options.fresh) {
      const cached = this.cacheGet(cacheKey);
      if (cached) return cached;
    }

    let data = await this.loadGroupPage(key);
    if (!data) {
      // 数字 ID / 团队名称进不去，用列表或搜索换成 shortName 再试一次
      const shortName = await this.resolveGroupKey(key);
      if (!shortName) throw new Error(`找不到团队「${key}」，请确认短名或链接是否正确`);
      data = await this.loadGroupPage(shortName);
      if (!data) throw new Error(`团队「${key}」打不开，可能已解散或你没有访问权限`);
    }

    const group = buildGroup(data, this.baseUrl);
    this.cacheSet(`group:${group.shortName}`, group);
    this.cacheSet(cacheKey, group);
    return group;
  }

  /** 拉团队页并解析 dataJson；不是团队页时返回 null（数字 ID 会 303 回 /group） */
  async loadGroupPage(key) {
    const res = await this.httpGet(`/group/${encodeURIComponent(key)}`);
    this.assertNotLoginWall(res);
    const data = extractDataJson(res.body || '');
    return data && data.shortName ? data : null;
  }

  /** 用团队列表 / 搜索接口把数字 ID 或团队名解析成 shortName */
  async resolveGroupKey(key) {
    const query = String(key).trim();
    if (!query) return null;

    if (/^\d+$/.test(query)) {
      try {
        const { mine, invitations, discover } = await this.listGroups();
        const hit = [...mine, ...invitations, ...discover].find((g) => String(g.id) === query);
        if (hit) return hit.shortName;
      } catch {
        /* 列表拿不到就继续走搜索 */
      }
    }

    const cards = await this.searchGroups(query).catch(() => []);
    const lower = query.toLowerCase();
    const exact =
      cards.find((g) => String(g.shortName).toLowerCase() === lower) ||
      cards.find((g) => String(g.name).toLowerCase() === lower);
    return (exact || cards[0] || {}).shortName || null;
  }

  /* --------------------------- 题目搜索 --------------------------- */

  async searchProblems(options = {}) {
    const pageSize = Math.min(Number(options.pageSize) || 30, 100);
    const page = Math.max(Number(options.page) || 1, 1);
    const params = new URLSearchParams({
      draw: '1',
      start: String((page - 1) * pageSize),
      length: String(pageSize),
      OJId: options.oj || 'All',
      probNum: options.num || '',
      title: options.title || '',
      source: options.source || '',
      category: options.category || 'all',
      sortCol: '0',
      sortDir: 'desc',
    });
    const res = await this.httpGet(`/problem/data?${params.toString()}`);
    let payload;
    try {
      payload = JSON.parse(res.body);
    } catch {
      return { problems: [], total: 0 };
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return {
      problems: rows.map((row) => ({
        key: row[0],
        title: row[1],
        source: typeof row[2] === 'string' ? stripTags(row[2]) : '',
        acCount: row[3],
        submitCount: row[4],
      })),
      total: Number(payload.recordsFiltered) || rows.length,
    };
  }
}

/** 兼容多种 filterProblem 返回格式 */
function parseContestProblems(payload) {
  if (!payload) return [];
  let list = payload;
  if (!Array.isArray(list) && typeof list === 'object') {
    list = list.data || list.problems || list.list || [];
  }
  if (!Array.isArray(list)) return [];

  const result = [];
  list.forEach((item, idx) => {
    if (Array.isArray(item)) {
      // 可能是 [key, title] 或 [num, key, title]
      const key = item.find((v) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]*-\S+$/.test(v));
      const title = item.find((v, i) => typeof v === 'string' && i > 0 && v !== key);
      if (key) {
        result.push({
          key,
          index: item.find((v) => typeof v === 'string' && /^[A-Z]\d?$/.test(v)) || indexToLetter(idx),
          num: String(idx + 1),
          title: title || key,
          source: '',
        });
      }
      return;
    }
    if (item && typeof item === 'object') {
      const values = Object.values(item).filter((v) => typeof v === 'string');
      const key = values.find((v) => /^[A-Za-z][A-Za-z0-9_]*-\S+$/.test(v));
      if (!key) return;
      const letter =
        item.probNum || item.num || item.alias || item.index || item.problemIndex || indexToLetter(idx);
      result.push({
        key,
        index: String(letter).toUpperCase(),
        num: String(idx + 1),
        title: item.title || item.name || key,
        source: typeof item.source === 'string' ? stripTags(item.source) : '',
      });
    }
  });
  return result;
}

function indexToLetter(idx) {
  return String.fromCharCode(65 + (idx % 26));
}

/* ------------------------------------------------------------------ */
/* 比赛题目列表（dataJson.problems）                                     */
/* ------------------------------------------------------------------ */

/** 从 properties 里挑出时限 / 内存 */
function propertyOf(properties, name) {
  if (!Array.isArray(properties)) return '';
  const hit = properties.find((p) => p && String(p.title).toLowerCase() === name);
  return hit && hit.content ? stripTags(decodeEntities(hit.content)) : '';
}

/**
 * 新版比赛页把题目放在 dataJson.problems 里，字段形如：
 * { pid, title, oj, probNum, num:'A', weight, properties:[{title:'time_limit',content:'1000 ms'}] }
 */
function parseContestPageProblems(data) {
  const list = data && data.problems;
  if (!Array.isArray(list) || !list.length) return [];

  return list.map((item, idx) => {
    const oj = decodeEntities(item.oj || '');
    const probNum = decodeEntities(item.probNum || '');
    const title = decodeEntities(item.title || '');
    const index = String(item.num || indexToLetter(idx)).toUpperCase();
    return {
      key: oj && probNum ? `${oj}-${probNum}` : '',
      pid: item.pid,
      index,
      num: String(idx + 1),
      oj,
      probNum,
      title: title || (oj && probNum ? `${oj}-${probNum}` : `题目 ${index}`),
      source: oj && probNum ? `${oj}-${probNum}` : '',
      weight: item.weight,
      timeLimit: propertyOf(item.properties, 'time_limit'),
      memoryLimit: propertyOf(item.properties, 'mem_limit'),
      hasDescription: Array.isArray(item.enabledDescKeys) ? item.enabledDescKeys.length > 0 : undefined,
    };
  });
}

/** 0 = 公开，1 = 需要密码，2 = 私有；type>=2 为特殊赛制 */
function contestOpennessKind(data) {
  const type = Number(data && data.type);
  if (Number.isFinite(type) && type >= 2) return 'special';
  const openness = Number(data && data.openness);
  if (openness === 0) return 'public';
  if (openness === 1) return 'protected';
  return 'private';
}

function opennessLabel(data) {
  return {
    public: '公开',
    protected: '需要密码',
    private: '私有（仅受邀 / 已报名）',
    special: '特殊赛制',
  }[contestOpennessKind(data)];
}

function accessLabel(data) {
  const status = Number(data && data.authStatus) || 0;
  if (status >= 3) return '管理员 / 出题人';
  if (status > 0) return '已获得访问权限';
  return '未登录或未报名';
}

/** 说明为什么拿不到题目列表，返回给 UI 用的结构化信息 */
function contestAccess(data) {
  const kind = contestOpennessKind(data);
  const started = data && data.started;
  const ended = data && data.ended;
  const status = Number(data && data.authStatus) || 0;

  if (!started && !ended) {
    return {
      code: 'not-started',
      title: '比赛还没开始',
      detail: 'VJudge 要到比赛开始后才公开题目列表，开始后点「刷新」即可看到。',
      hint: '',
      needLogin: false,
    };
  }
  if (kind === 'private') {
    return {
      code: 'private',
      title: '私有比赛的题目需要报名后才能看',
      detail:
        status > 0
          ? '当前账号在这个比赛里还没有参赛权限，先在 VJudge 页面报名 / 接受邀请，再点「刷新」。'
          : '这是私有比赛，VJudge 只对已报名或被邀请的账号返回题目。先登录，再在网页上报名。',
      hint: '「浏览器打开」→ 报名 / 输密码 → 回来点「刷新」。',
      needLogin: status === 0,
    };
  }
  if (kind === 'protected') {
    return {
      code: 'protected',
      title: '这是需要密码的比赛',
      detail: 'VJudge 要先用比赛密码进入，才会返回题目列表。',
      hint: '「浏览器打开」→ 输入比赛密码 → 回来点「刷新」。',
      needLogin: status === 0,
    };
  }
  return {
    code: 'unknown',
    title: '题目列表暂不可见',
    detail: 'VJudge 没有返回题目数据，可能比赛刚创建、题目还没绑定，或站点结构有变动。',
    hint: '点「打开原网页」可以在浏览器里确认。',
    needLogin: status === 0,
  };
}

function explainNoProblems(data) {
  const access = contestAccess(data);
  if (access.code === 'private' || access.code === 'protected') {
    return `${access.title}：在网页报名 / 输入密码后点「刷新」重试`;
  }
  return access.title;
}

/* ------------------------------------------------------------------ */
/* 团队                                                                */
/* ------------------------------------------------------------------ */

const JOIN_POLICY_LABEL = { 0: '公开加入', 1: '需要审核', 2: '仅邀请' };
const CONTEST_POLICY_LABEL = { 0: '成员均可创建比赛', 1: '仅管理员可创建比赛', 2: '已关闭比赛创建' };
const MEMBER_ROLE_LABEL = { 2: '队长', 1: '管理员', 0: '成员' };

/** 团队列表里的一张卡片 */
function toGroupCard(raw) {
  const item = raw || {};
  return {
    id: item.id,
    name: item.name || item.shortName || `团队 ${item.id}`,
    shortName: item.shortName || String(item.id),
    isPublic: item.isPublic !== false,
    logoUrl: item.logoUrl || '',
    members: Number(item.members) || 0,
    brief: typeof item.brief === 'string' ? item.brief.trim() : '',
    myRole: Number(item.myRole) || 0,
    scheduledContests: Number(item.scheduledContests) || 0,
    runningContests: Number(item.runningContests) || 0,
    endedContests: Number(item.endedContests) || 0,
    leaderName: item.leaderName || '',
    hasApplicants: !!item.hasApplicants,
  };
}

/** 从链接 / 短名里抠出团队 key */
function normalizeGroupKey(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return '';
  const fromUrl = /vjudge\.(?:net|cn)\/group\/([A-Za-z0-9_.-]+)/i.exec(text);
  if (fromUrl) return fromUrl[1];
  const bare = text.replace(/^\/?group\//i, '').replace(/[?#].*$/, '');
  return bare.trim();
}

/** 团队比赛行兼容：[id, title, type, begin, end, openness, ?, contestants, ...] */
function normalizeGroupContests(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (Array.isArray(row)) {
        return { id: row[0], title: row[1], begin: row[3], end: row[4], contestants: row[7] };
      }
      if (row && typeof row === 'object') {
        return {
          id: row.id,
          title: row.title || row.name,
          begin: row.begin != null ? row.begin : row.startTime,
          end: row.end != null ? row.end : row.endTime,
          contestants: row.contestants != null ? row.contestants : row.members,
        };
      }
      return null;
    })
    .filter((row) => row && row.id != null);
}

/** 团队文章兼容：[[id, title]] 或 [{id, title}] */
function normalizeGroupArticles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (Array.isArray(item)) return { id: item[0], title: item[1] || `文章 ${item[0]}` };
      if (item && typeof item === 'object' && item.id != null) {
        return { id: item.id, title: item.title || item.name || `文章 ${item.id}` };
      }
      return null;
    })
    .filter(Boolean);
}

/** 把团队详情页的 dataJson 整理成面板好用的结构 */
function buildGroup(data, baseUrl) {
  const now = Date.now();
  const shortName = data.shortName || String(data.id);

  const contests = normalizeGroupContests(data.contests).map((row) => {
    const begin = Number(row.begin) || 0;
    const end = Number(row.end) || 0;
    const state = end && now > end ? 'ended' : begin && now < begin ? 'upcoming' : 'running';
    return {
      id: String(row.id),
      title: row.title || `比赛 ${row.id}`,
      begin,
      end,
      contestants: row.contestants,
      state,
      url: contestUrl(row.id, baseUrl),
    };
  });
  contests.sort((a, b) => b.begin - a.begin);

  const members = (data.memberBriefs || [])
    .map((m) => ({
      userId: m.userId != null ? m.userId : m.id,
      username: m.username || m.nickName || '',
      nickName: m.nickName || m.username || '',
      role: Number(m.role) || 0,
      roleLabel: MEMBER_ROLE_LABEL[Number(m.role) || 0] || '成员',
      joined: m.joinTime,
      lastSeen: m.lastSeenTime,
    }))
    .sort((a, b) => b.role - a.role || String(a.username).localeCompare(String(b.username)));

  const intro = data.intro || {};
  const introSource = typeof intro.content === 'string' ? intro.content : '';
  const introFormat = String(intro.format || '').toUpperCase();
  const introHtml =
    !introSource.trim() ? '' : introFormat === 'MD' || introFormat === 'MARKDOWN' ? renderMarkdown(introSource) : introSource;

  const joinPolicy = Number(data.joinPolicy);
  const contestPolicy = Number(data.arrangeContestPolicy);

  return {
    id: data.id,
    shortName,
    name: data.name || shortName,
    brief: typeof data.brief === 'string' ? data.brief.trim() : '',
    isPublic: data.pblc !== false,
    joinPolicy,
    joinPolicyLabel: JOIN_POLICY_LABEL[joinPolicy] || `策略 ${data.joinPolicy}`,
    arrangeContestPolicy: contestPolicy,
    arrangeContestPolicyLabel: CONTEST_POLICY_LABEL[contestPolicy] || '',
    introHtml,
    introSource,
    members,
    contests,
    articles: normalizeGroupArticles(data.articles).concat(normalizeGroupArticles(data.articleNodes)),
    url: groupUrl(shortName, baseUrl),
    data,
  };
}

module.exports = {
  VJudgeClient,
  extractDataJson,
  extractStatementFromHtml,
  extractElement,
  collectHtmlFields,
  deepGet,
  parseContestProblems,
  parseContestPageProblems,
  contestAccess,
  opennessLabel,
  collectDescriptionRefs,
  pickDescriptionRef,
  langLabelOf,
  describeDescRef,
  isMarkdownFormat,
  normalizeMathDelimiters,
  descriptionPayloadToHtml,
  extractDescriptionPayload,
  buildGroup,
  normalizeGroupKey,
  toGroupCard,
};
