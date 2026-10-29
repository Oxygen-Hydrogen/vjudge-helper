'use strict';

/**
 * 提交相关的纯逻辑（不依赖 vscode，方便 test/ 里直接跑）：
 *
 *   - 从文件名 / VS Code languageId 认出「语言族」（cpp / python / java …）
 *   - 把 VJudge 给出的语言列表（对象 / 数组，字段名五花八门）归一化成 {id, name}
 *   - 按语言族挑一个最合适的语言（C++23 优先于 C++98，Python3 优先于 Python2）
 *   - 组装提交表单（source 就是代码原文，表单序列化时才做 URL 编码）
 *   - 把 {"error":{"i18nKey":"submit.error.xxx"}} 翻成人话
 *
 * 接口细节来自 VJudge 前端实际请求（bundle 7430 的 #submit-form 处理函数）：
 *   POST /problem/submit/{oj}-{probNum}
 *   POST /contest/submit/{contestId}/{problemNum}
 *   body: method=0&language=<id>&open=0|1&source=<代码原文>&captcha=&password=
 *   比赛还要带 accessCode（比赛密码）+ version（题目版本），自己的账号代交带 bindingId
 */

/* ------------------------------------------------------------------ */
/* 语言识别                                                            */
/* ------------------------------------------------------------------ */

/** 扩展名 -> 语言族 */
const EXTENSION_FAMILY = {
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  cp: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  c: 'c',
  h: 'c',
  py: 'python',
  py3: 'python',
  pyw: 'python',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  go: 'go',
  rs: 'rust',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  scala: 'scala',
  pl: 'perl',
  pm: 'perl',
  hs: 'haskell',
  d: 'd',
  pas: 'pascal',
  pp: 'pascal',
  m: 'objective-c',
  mm: 'objective-c',
  nim: 'nim',
  jl: 'julia',
  erl: 'erlang',
  ex: 'elixir',
  exs: 'elixir',
  ml: 'ocaml',
  fs: 'fsharp',
  vb: 'vb',
  f90: 'fortran',
  f95: 'fortran',
  sh: 'bash',
};

/** VS Code languageId -> 语言族 */
const LANGUAGE_ID_FAMILY = {
  cpp: 'cpp',
  'objective-cpp': 'cpp',
  c: 'c',
  python: 'python',
  java: 'java',
  javascript: 'javascript',
  typescript: 'javascript',
  javascriptreact: 'javascript',
  typescriptreact: 'javascript',
  go: 'go',
  rust: 'rust',
  csharp: 'csharp',
  php: 'php',
  ruby: 'ruby',
  kotlin: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  scala: 'scala',
  perl: 'perl',
  haskell: 'haskell',
  d: 'd',
  pascal: 'pascal',
  'objective-c': 'objective-c',
  nim: 'nim',
  julia: 'julia',
  erlang: 'erlang',
  elixir: 'elixir',
  ocaml: 'ocaml',
  fsharp: 'fsharp',
  vb: 'vb',
  fortran: 'fortran',
  shellscript: 'bash',
};

/**
 * 认语言族：先看扩展名，再看 VS Code 的 languageId。
 * @param {string} [fileName]
 * @param {string} [languageId]
 * @returns {string|null}
 */
function detectLanguageFamily(fileName, languageId) {
  const name = String(fileName || '').trim();
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (EXTENSION_FAMILY[ext]) return EXTENSION_FAMILY[ext];
  }
  const id = String(languageId || '').trim().toLowerCase();
  if (id && LANGUAGE_ID_FAMILY[id]) return LANGUAGE_ID_FAMILY[id];
  return null;
}

/**
 * 各语言族在 VJudge 语言名里的特征。
 * pattern：命中才算「这个族」；bonus / penalty：同族内挑新版本、避开老版本。
 */
const FAMILY_RULES = {
  cpp: {
    label: 'C++',
    pattern: /c\+\+|g\+\+|clang\+\+|\bcpp\b/i,
    bonus: [
      // C++17 是各 OJ 最通用的版本；再往上按新旧排，98/03 直接压到最低
      [/c\+\+\s*17\b/i, 30],
      [/c\+\+\s*20\b/i, 26],
      [/c\+\+\s*23\b/i, 24],
      [/c\+\+\s*14\b/i, 20],
      [/g\+\+\s*17\b/i, 30],
      [/g\+\+\s*20\b/i, 26],
      [/g\+\+\s*23\b/i, 24],
      [/g\+\+\s*14\b/i, 20],
      [/\bg\+\+\b/i, 12],
      [/\bo2\b/i, 4],
    ],
    penalty: [
      [/c\+\+\s*(98|03)\b/i, 26],
      [/c\+\+\s*11\b/i, 8],
      [/msys/i, 3],
    ],
  },
  c: {
    label: 'C',
    pattern: /(?:^|[^+\w])c(?:$|[^+\w#])|\bgcc\b(?!\+\+)|\bclang\b(?!\+\+)|ansi c|iso c/i,
    bonus: [
      [/\b(17|11|c17|c11|2x)\b/i, 10],
      [/\bgcc\b/i, 4],
    ],
    penalty: [[/\b(98|89)\b/, 8]],
  },
  python: {
    label: 'Python',
    pattern: /python|pypy|\bpy3\b/i,
    bonus: [
      [/python\s*3\.(1[0-9]|[89])/i, 26],
      [/pypy\s*3|pypy3/i, 24],
      [/python\s*3/i, 20],
      [/python/i, 8],
    ],
    penalty: [
      [/(python|pypy)\s*2|python2|pypy2/i, 40],
    ],
  },
  java: {
    label: 'Java',
    pattern: /\bjava\b/i,
    bonus: [
      [/java\s*(2[0-9]|1[1-9])\b/i, 14],
      [/\bopenjdk\b/i, 6],
    ],
    penalty: [/\bjava\s*(6|7|8)\b/i, 10],
  },
  javascript: {
    label: 'JavaScript',
    pattern: /javascript|node\.?js|typescript|deno|bun/i,
    bonus: [
      [/\bjavascript\b/i, 12],
      [/\bnode\.?js\b/i, 10],
    ],
    // OJ 上真正能跑的是 JS（Node），TS 只是同一族里的近亲，排后面
    penalty: [
      [/typescript/i, 6],
      [/deno|bun/i, 4],
    ],
  },
  go: {
    label: 'Go',
    pattern: /\bgo\b|golang/i,
    bonus: [[/\bgo\s*1\.(1[5-9]|2[0-9])/i, 6]],
    penalty: [],
  },
  rust: {
    label: 'Rust',
    pattern: /rust/i,
    bonus: [[/\b20(1[5-9]|2[0-9])\b/, 6]],
    penalty: [],
  },
  csharp: {
    label: 'C#',
    pattern: /c#|csharp|c\s*sharp|mono|\.net/i,
    bonus: [[/\.net\s*[5-9]|mono/i, 6]],
    penalty: [],
  },
  php: { label: 'PHP', pattern: /php/i, bonus: [[/[5-9]\./, 4]], penalty: [] },
  ruby: { label: 'Ruby', pattern: /ruby/i, bonus: [], penalty: [] },
  kotlin: { label: 'Kotlin', pattern: /kotlin/i, bonus: [], penalty: [] },
  swift: { label: 'Swift', pattern: /swift/i, bonus: [], penalty: [] },
  lua: { label: 'Lua', pattern: /\blua\b/i, bonus: [], penalty: [] },
  scala: { label: 'Scala', pattern: /scala/i, bonus: [], penalty: [] },
  perl: { label: 'Perl', pattern: /perl/i, bonus: [], penalty: [] },
  haskell: { label: 'Haskell', pattern: /haskell|ghc/i, bonus: [], penalty: [] },
  d: { label: 'D', pattern: /\bd\b|dlang|dmd/i, bonus: [], penalty: [] },
  pascal: { label: 'Pascal', pattern: /pascal|fpc|delphi/i, bonus: [], penalty: [] },
  'objective-c': {
    label: 'Objective-C',
    pattern: /objective-?c(?!\+\+)/i,
    bonus: [],
    penalty: [],
  },
  nim: { label: 'Nim', pattern: /\bnim\b/i, bonus: [], penalty: [] },
  julia: { label: 'Julia', pattern: /julia/i, bonus: [], penalty: [] },
  erlang: { label: 'Erlang', pattern: /erlang/i, bonus: [], penalty: [] },
  elixir: { label: 'Elixir', pattern: /elixir/i, bonus: [], penalty: [] },
  ocaml: { label: 'OCaml', pattern: /ocaml/i, bonus: [], penalty: [] },
  fsharp: { label: 'F#', pattern: /f#|fsharp/i, bonus: [], penalty: [] },
  vb: { label: 'Visual Basic', pattern: /visual basic|\bvb\.?net\b/i, bonus: [], penalty: [] },
  fortran: { label: 'Fortran', pattern: /fortran/i, bonus: [], penalty: [] },
  bash: { label: 'Shell', pattern: /bash|shell/i, bonus: [], penalty: [] },
};

function familyLabel(family) {
  return (FAMILY_RULES[family] && FAMILY_RULES[family].label) || '';
}

/**
 * 某个语言名跟语言族的匹配得分；-1 表示不是同一个族。
 * @param {{id?: any, name?: any}} language
 * @param {string|null} family
 */
function languageScore(language, family) {
  const rule = FAMILY_RULES[family];
  if (!rule) return 0;
  const name = String((language && (language.name || language.id)) || '');
  if (!name.trim()) return -1;
  if (!rule.pattern.test(name)) return -1;
  let score = 10;
  for (const [re, points] of rule.bonus || []) if (re.test(name)) score += points;
  for (const [re, points] of rule.penalty || []) if (re.test(name)) score -= points;
  return score;
}

/* ------------------------------------------------------------------ */
/* 语言列表归一化                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把 VJudge 的语言表转成 [{id, name}]。
 * 见过的形态：{"54":"GNU G++17"}、{"C++11":"C++11"}、[{id,name}]、["C++"]。
 * @returns {{id: string, name: string}[]}
 */
function normalizeLanguageOptions(raw) {
  const list = [];
  const seen = new Set();
  const push = (id, name) => {
    const key = String(id == null ? '' : id).trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const label = String(name == null ? key : name).trim();
    list.push({ id: key, name: label || key });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'string' || typeof item === 'number') {
        push(item, item);
        continue;
      }
      if (typeof item === 'object') {
        const id =
          item.id !== undefined
            ? item.id
            : item.value !== undefined
              ? item.value
              : item.key !== undefined
                ? item.key
                : item.languageId;
        if (id === undefined || id === null) continue;
        push(id, item.name || item.label || item.title || item.text || item.language || id);
      }
    }
    return list;
  }

  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value && typeof value === 'object') {
        const id = value.id !== undefined ? value.id : value.value !== undefined ? value.value : key;
        push(id, value.name || value.label || value.title || key);
      } else {
        push(key, value === null || value === undefined ? key : String(value));
      }
    }
  }
  return list;
}

/** 在题目 dataJson 里找语言表（有界深挖，只认明确的几个键名） */
const LANGUAGE_KEYS = ['languages', 'languageList', 'languageOptions', 'submitLanguages', 'enabledLanguages', 'langs'];

function findLanguageContainer(node, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node.slice(0, 30)) {
      const hit = findLanguageContainer(child, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  for (const key of LANGUAGE_KEYS) {
    const value = node[key];
    if (value && typeof value === 'object' && Object.keys(value).length) return value;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findLanguageContainer(value, depth + 1, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 从题目页 dataJson 里取提交语言列表（VJudge 的提交弹窗就是用这份数据渲染的）。
 * 拿不到时返回空数组，由调用方退回 /util/cfg。
 */
function extractLanguageOptions(data) {
  if (!data || typeof data !== 'object') return [];
  const container = findLanguageContainer(data);
  if (!container) return [];
  const list = normalizeLanguageOptions(container);
  // 过滤掉明显不是语言表的东西（例如只有几个 key 的杂项对象）
  return list.filter((item) => item.name && item.name.length < 80);
}

/**
 * 挑一个最合适的语言。
 * @param {{id: string, name: string}[]} options
 * @param {string|null} family 语言族
 * @param {string|number} [preferredId] 上次用过的语言 id（同族才认）
 */
function pickLanguage(options, family, preferredId) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!list.length) return null;

  if (preferredId !== undefined && preferredId !== null && String(preferredId) !== '') {
    const hit = list.find((item) => String(item.id) === String(preferredId));
    if (hit && (!family || languageScore(hit, family) >= 0)) return hit;
  }

  if (!family) return list[0];

  const scored = list
    .map((item) => ({ item, score: languageScore(item, family) }))
    .filter((row) => row.score >= 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || String(a.item.name).length - String(b.item.name).length);
  return scored[0].item;
}

/** 语言表的展示顺序：最合适的排最前，其余同族按得分，再按名字排 */
function sortLanguageOptions(options, family) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  const best = pickLanguage(list, family, null);
  const rest = list
    .filter((item) => !best || String(item.id) !== String(best.id))
    .sort((a, b) => {
      const scoreA = family ? languageScore(a, family) : 0;
      const scoreB = family ? languageScore(b, family) : 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return String(a.name).localeCompare(String(b.name), 'en');
    });
  return best ? [best, ...rest] : rest;
}

/* ------------------------------------------------------------------ */
/* 源码编码 / 请求体                                                    */
/* ------------------------------------------------------------------ */

/**
 * source 字段 = 代码原文。
 *
 * VJudge 提交弹窗里就是 `n.data.source = $("#submit-solution").val()`，而那个
 * textarea 由 CodeMirror 的 save() 写入编辑器内容 —— 没有任何编码；URL 编码由
 * jQuery 的表单序列化完成。
 *
 * 别再按老博客写成 base64(encodeURIComponent(code))：后端不会解码，判题机拿到的
 * 就是一串 base64 文本，直接 CE（`program.cpp:1:1: error: stray ...`）。
 */
function sourceField(code) {
  return String(code === undefined || code === null ? '' : code);
}

/**
 * 前端提交前的两处校验（lone surrogate / 控制字符），提前拦下来，省得白交一发。
 * @returns {string} 空串表示没问题
 */
function sourceProblem(code) {
  const text = sourceField(code);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return '代码里有无法识别的字符（半个 UTF-16 代理对），用 UTF-8 重新保存一下文件';
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return '代码里有不可见的控制字符，先清理掉再提交';
  }
  return '';
}

/**
 * 提交表单字段（和 VJudge 提交弹窗完全一致）。
 * @param {{language?: string|number, code?: string, open?: boolean, password?: string,
 *          captcha?: string, method?: string|number, bindingId?: string|number,
 *          accessCode?: string, version?: string|number, token?: string}} options
 */
function buildSubmitBody(options = {}) {
  const body = {
    method: options.method === undefined ? '0' : String(options.method),
    language: options.language === undefined || options.language === null ? '' : String(options.language),
    open: options.open ? '1' : '0',
    source: sourceField(options.code),
    captcha: options.captcha ? String(options.captcha) : '',
    password: options.password ? String(options.password) : '',
  };
  // method=1/2（用自己在 OJ 上绑定的账号 / 存档）要带上绑定 ID
  if (options.bindingId) body.bindingId = String(options.bindingId);
  // 比赛提交额外要题目版本 + 比赛密码（前端 7430 的 inContest 分支）
  if (options.version !== undefined && options.version !== null && options.version !== '') {
    body.version = String(options.version);
  }
  if (options.accessCode !== undefined && options.accessCode !== null) {
    body.accessCode = String(options.accessCode);
  }
  if (options.token) body.token = String(options.token);
  return body;
}

/* ------------------------------------------------------------------ */
/* 错误 / 结果                                                         */
/* ------------------------------------------------------------------ */

/**
 * VJudge 的报错都是 {"error":{"i18nKey":"submit.error.xxx","i18nArgs":{...}}}
 * 这里把常见 key 翻成中文；没见过的 key 按关键词猜，再不行就把原始信息露出来。
 */
const SUBMIT_ERROR_TEXT = {
  'submit.error.login_required': '需要登录 VJudge 才能提交',
  'submit.error.not_login': '需要登录 VJudge 才能提交',
  'submit.error.problem_not_found': 'VJudge 上找不到这道题',
  'submit.error.contest_not_found': 'VJudge 上找不到这个比赛',
  'submit.error.contest_not_started': '比赛还没开始，不能提交',
  'submit.error.contest_ended': '比赛已经结束，不能提交',
  'submit.error.contest_not_attended': '你还没有报名这场比赛，先在网页上报名',
  'submit.error.contest_not_allowed': '当前账号没有在这场比赛中提交的权限',
  'submit.error.password_required': '这场比赛需要先输入密码',
  'submit.error.password_error': '比赛密码不正确',
  'submit.error.language_required': '请选择提交语言',
  'submit.error.submit_method.not_allowed': 'VJudge 不允许用默认账号提交这道题（要用你自己在该 OJ 上绑定的账号）',
  'submit.error.submit_method.not_found': '这个提交方式不可用，换一种方式试试',
  'submit.error.language_not_found': '这门语言在这道题上不可用，换一个试试',
  'submit.error.source_required': '代码是空的',
  'submit.error.code_required': '代码是空的',
  'submit.error.captcha_required': 'VJudge 要求输入验证码',
  'submit.error.captcha_error': '验证码不正确',
  'submit.error.too_frequent': '提交太频繁了，等一会儿再试',
  'submit.error.submission_limit': '提交次数已达上限',
  'submit.error.unknown_error': '提交失败，VJudge 没给出原因',
  'solution.error.submission_not_found': 'VJudge 上找不到这次提交',
  'solution.error.crawler_blocked': 'VJudge 挡住了这次请求，稍后重试或到网页上查看',
};

function stripTags(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从各种 error 形态里抽出可读文案 */
function errorText(error) {
  if (!error) return '提交失败';
  if (typeof error === 'string') return stripTags(error) || '提交失败';

  const key = String(error.i18nKey || error.key || '');
  const args = error.i18nArgs && typeof error.i18nArgs === 'object' ? error.i18nArgs : {};
  let text = SUBMIT_ERROR_TEXT[key];

  if (!text) {
    if (/captcha/i.test(key)) text = 'VJudge 要求输入验证码';
    else if (/login|not_login|auth|session/i.test(key)) text = '需要登录 VJudge 才能提交';
    else if (/password/i.test(key)) text = '比赛密码不正确';
    else if (/language/i.test(key)) text = '这门语言在这道题上不可用';
    else if (/frequent|rate|limit/i.test(key)) text = '提交太频繁了，稍后再试';
    else if (/contest.*(end|start|attend|allow|permission)/i.test(key)) text = '当前比赛不允许提交';
    else if (/not_found/i.test(key)) text = 'VJudge 上找不到对应的题目或提交';
    else text = '';
  }
  if (!text) text = stripTags(error.message || error.html || error.error || '');
  if (!text) text = key ? `提交失败（${key}）` : '提交失败';

  return text.replace(/\{(\w+)\}/g, (match, name) => (args[name] === undefined ? match : String(args[name])));
}

function isCaptchaError(error) {
  if (!error) return false;
  if (error.captcha) return true;
  const key = String(error.i18nKey || error.key || '');
  return /captcha/i.test(key);
}

/**
 * 题目允许的提交方式。
 *
 * VJudge 的 dataJson.submitMethods 是三个布尔：[默认账号, 自己的账号, 存档]。
 * 索引 0 = 由 VJudge 用默认账号代交源码；1 = 用你自己在 OJ 上绑定的账号交；
 * 2 = 只存档不判题。Codeforces 的题几乎都是 [false, true, true]——这就解释了
 * 「提交失败（submit.error.submit_method.not_allowed）」。
 */
function submitMethodsOf(problem) {
  const raw =
    (problem && problem.submitMethods) ||
    (problem && problem.data && problem.data.submitMethods) ||
    null;
  const list = Array.isArray(raw) ? raw.map(Boolean) : null;
  if (!list || !list.length) {
    // 拿不到就按最常见的「默认账号」处理，被拒时再换自己的账号
    return { defaultAccount: true, ownAccount: false, archive: false, known: false, raw: null };
  }
  return {
    defaultAccount: !!list[0],
    ownAccount: !!list[1],
    archive: !!list[2],
    known: true,
    raw: list,
  };
}

/** 默认账号提交被拒（该题只允许自己的账号 / 存档） */
function isSubmitMethodError(error) {
  if (!error) return false;
  const key = String(error.i18nKey || error.key || '');
  if (/submit_method/i.test(key)) return true;
  return /submit_method|提交方式/.test(String(error.message || ''));
}

/**
 * 服务端明确说「这场比赛的提交通道已经关了」。
 *
 * VJudge 在比赛结束后会关掉 /contest/submit，但题目本身还能补（practice），
 * 补题走的是 /problem/submit/{题目}。遇到这种情况插件要自动换一条路，
 * 而不是把「比赛已经结束，不能提交」直接甩给用户。
 */
function isContestClosedError(error) {
  if (!error) return false;
  const key = String(error.i18nKey || error.key || '');
  if (/contest_(ended|closed|finished|expired)/i.test(key)) return true;
  // 没有 i18nKey（比如 400 错误页）时只能看文案
  return /比赛(已经|已)?(结束|截止|关闭)|contest (has )?(ended|closed|expired)/i.test(String(error.message || ''));
}

/**
 * 评测结果 -> {level, text, detail}
 * level: pending | accepted | failed
 * VJudge 的 statusType：0 排队中 / 1 通过 / 2 未通过
 */
function verdictOf(solution) {
  if (!solution) return { level: 'pending', text: '等待评测', detail: '' };
  if (solution.processing === true) {
    return { level: 'pending', text: String(solution.status || '判题中…'), detail: solutionDetail(solution) };
  }
  const type = Number(solution.statusType);
  const level = type === 1 ? 'accepted' : type === 2 ? 'failed' : 'pending';
  const fallback = level === 'accepted' ? 'Accepted' : level === 'failed' ? 'Failed' : 'Pending';
  return { level, text: String(solution.status || fallback), detail: solutionDetail(solution) };
}

/** 耗时 / 内存 / 语言，一行 */
function solutionDetail(solution) {
  if (!solution) return '';
  const parts = [];
  if (solution.runtime) parts.push(`${solution.runtime} ms`);
  if (solution.memory) parts.push(`${solution.memory} kB`);
  if (solution.language) parts.push(String(solution.language));
  return parts.join(' · ');
}

/** 一行摘要：Accepted · 15 ms · 512 kB · GNU G++17 */
function solutionSummary(solution) {
  if (!solution) return '';
  return [solution.status ? String(solution.status) : '', solutionDetail(solution)].filter(Boolean).join(' · ');
}

module.exports = {
  detectLanguageFamily,
  familyLabel,
  languageScore,
  normalizeLanguageOptions,
  extractLanguageOptions,
  pickLanguage,
  sortLanguageOptions,
  sourceField,
  sourceProblem,
  buildSubmitBody,
  errorText,
  isCaptchaError,
  isContestClosedError,
  submitMethodsOf,
  isSubmitMethodError,
  verdictOf,
  solutionDetail,
  solutionSummary,
  FAMILY_RULES,
};
