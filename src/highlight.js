'use strict';

/**
 * 极简语法高亮（零依赖，纯字符串拼接）。
 *
 * 为什么不引 highlight.js / Prism：
 *   - 项目约定零运行时依赖，webview 里也不能指望 CDN（MathJax 已经踩过 jsDelivr 不通的坑）；
 *   - OI 题面里的代码 99% 是 C++ / Pascal / Python / Java，一个几百行的分词器足够，
 *     而且能在渲染时（Node 侧）一次性生成好，webview 不用再跑 JS。
 *
 * 只做「词法」级别的着色：注释、字符串、字符、预处理行、数字、关键字、类型、函数名。
 * 运算符和标点保持正文色（跟 VS Code 默认一致，全上色反而更花）。
 */

/** 代码里的 & < > " 必须转义；单引号不用（属性一律用双引号） */
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const set = (s) => new Set(String(s).trim().split(/\s+/));

// ---------------------------------------------------------------- 词表

const CPP_KEYWORDS = set(`
  alignas alignof and and_eq asm auto bitand bitor bool break case catch char char16_t char32_t
  class compl const constexpr const_cast continue decltype default delete do double dynamic_cast
  else enum explicit export extern false float for friend goto if inline int long mutable namespace
  new noexcept not not_eq nullptr operator or or_eq private protected public register
  reinterpret_cast return short signed sizeof static static_assert static_cast struct switch
  template this thread_local throw true try typedef typeid typename union unsigned using virtual
  void volatile wchar_t while xor xor_eq NULL
`);

const CPP_TYPES = set(`
  size_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t
  string wstring vector map multimap set multiset queue stack deque priority_queue pair tuple
  list forward_list array bitset unordered_map unordered_set unordered_multimap iterator
  istream ostream istringstream ostringstream stringstream ifstream ofstream fstream
  cin cout cerr clog endl std __int128 __gcd
`);

const JAVA_KEYWORDS = set(`
  abstract assert boolean break byte case catch char class const continue default do double else
  enum extends final finally float for goto if implements import instanceof int interface long
  native new package private protected public return short static strictfp super switch
  synchronized this throw throws transient try void volatile while var record yield
  true false null
`);

const JAVA_TYPES = set(`
  String StringBuilder StringBuffer Integer Long Double Float Boolean Character Byte Short
  Object List ArrayList LinkedList Map HashMap TreeMap Set HashSet TreeSet Queue Deque
  ArrayDeque Scanner System Math Arrays Collections Comparator Optional Stream
`);

const JS_KEYWORDS = set(`
  async await break case catch class const continue debugger default delete do else export
  extends finally for from function get if import in instanceof let new of return set static
  super switch this throw try typeof var void while with yield true false null undefined NaN
`);

const JS_TYPES = set(`
  Array Object String Number Boolean Promise Map Set WeakMap WeakSet JSON Math Date RegExp
  Error Symbol BigInt console window document parseInt parseFloat
`);

const GO_KEYWORDS = set(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var true false nil iota
`);

const GO_TYPES = set(`
  bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
  uint uint8 uint16 uint32 uint64 uintptr make new len cap append copy delete panic recover
  fmt os strings sort math time sync
`);

const RUST_KEYWORDS = set(`
  as async await break const continue crate dyn else enum extern false fn for if impl in let
  loop match mod move mut pub ref return self static struct super trait true type unsafe use
  where while
`);

const RUST_TYPES = set(`
  i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec
  Option Some None Result Ok Err Box Rc RefCell HashMap HashSet println print vec format
`);

const PASCAL_KEYWORDS = set(`
  and array as asm begin case const constructor destructor div do downto else end except
  exports file finalization finally for function goto if implementation in inherited
  initialization inline interface is label library mod nil not object of on operator or packed
  procedure program property raise record repeat set shl shr then threadvar to try type unit
  until uses var while with xor break continue exit halt
`);

const PASCAL_TYPES = set(`
  integer longint int64 shortint byte word longword cardinal real single double extended
  comp boolean bytebool wordbool longbool char ansichar widechar string ansistring shortstring
  unicodestring text pchar pointer tobject
`);

const PYTHON_KEYWORDS = set(`
  False None True and as assert async await break class continue def del elif else except
  finally for from global if import in is lambda nonlocal not or pass raise return try while
  with yield match case self
`);

const PYTHON_TYPES = set(`
  print input len range int float str bool list dict set tuple frozenset bytes bytearray
  open abs sum min max sorted reversed enumerate zip map filter round pow divmod hex oct bin
  ord chr any all isinstance type object super format repr
`);

// ---------------------------------------------------------------- 语言定义

/**
 * family 决定用哪套分词器：
 *   c   —— //、/* *\/、可带 # 预处理行（C/C++/Java/JS/Go/Rust…都是这个形状）
 *   pas —— { }、(* *)、// 注释，字符串用 '' 转义
 *   py  —— # 注释，三引号字符串
 */
const LANGUAGES = {
  cpp: { family: 'c', pre: true, keywords: CPP_KEYWORDS, types: CPP_TYPES, label: 'C++' },
  c: { family: 'c', pre: true, keywords: CPP_KEYWORDS, types: CPP_TYPES, label: 'C' },
  java: { family: 'c', pre: false, keywords: JAVA_KEYWORDS, types: JAVA_TYPES, label: 'Java' },
  js: { family: 'c', pre: false, keywords: JS_KEYWORDS, types: JS_TYPES, label: 'JavaScript' },
  go: { family: 'c', pre: false, keywords: GO_KEYWORDS, types: GO_TYPES, label: 'Go' },
  rust: { family: 'c', pre: false, keywords: RUST_KEYWORDS, types: RUST_TYPES, label: 'Rust' },
  pascal: { family: 'pas', keywords: PASCAL_KEYWORDS, types: PASCAL_TYPES, label: 'Pascal', ci: true },
  python: { family: 'py', keywords: PYTHON_KEYWORDS, types: PYTHON_TYPES, label: 'Python' },
};

// 别名 -> 语言键。VJudge / 各 OJ 的写法五花八门，这里一次抹平
const ALIASES = {
  'c++': 'cpp', cpp: 'cpp', cxx: 'cpp', 'c plus plus': 'cpp', cc: 'cpp', hpp: 'cpp', 'cpp17': 'cpp',
  cpp14: 'cpp', cpp11: 'cpp', 'gnu++17': 'cpp', c: 'c', 'gcc': 'c',
  'c#': 'cpp', csharp: 'cpp', cs: 'cpp', dotnet: 'cpp', 'c++17': 'cpp', 'c++14': 'cpp', objc: 'cpp',
  pas: 'pascal', pascal: 'pascal', delphi: 'pascal', 'free pascal': 'pascal', freepascal: 'pascal',
  fpc: 'pascal', pp: 'pascal',
  py: 'python', python: 'python', python3: 'python', py3: 'python',
  java: 'java', 'java8': 'java', 'java11': 'java', jdk: 'java',
  js: 'js', javascript: 'js', node: 'js', ts: 'js', typescript: 'js',
  golang: 'go', go: 'go',
  rs: 'rust', rust: 'rust',
};

/** 把 "C++"、"language-cpp"、"lang-cc"、".cpp"、"cpp17" 之类的写法折成语言键 */
function normalizeLang(raw) {
  const text = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/^(language|lang|highlight-source)[-_]/, '')
    .replace(/^\./, '')
    .replace(/[_\s]+/g, ' ');
  if (!text) return null;
  const compact = text.replace(/\s+/g, '');
  const candidates = [text, compact, compact.replace(/\d+$/, '')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (ALIASES[candidate]) return ALIASES[candidate];
  }
  return null;
}

/** 猜语言：只认「强信号」，猜不出来就原文不动（样例输入输出不能被瞎上色） */
function detectLanguage(code) {
  const text = String(code == null ? '' : code);
  if (!text.trim()) return null;

  if (/(^|\n)\s*#\s*(include|define|pragma|ifndef|import)\b/.test(text)) return 'cpp';
  if (/\busing\s+namespace\s+\w+/.test(text)) return 'cpp';
  if (/\bstd::|\bcout\s*<<|\bcin\s*>>|\bscanf\s*\(|\bprintf\s*\(/.test(text)) return 'cpp';
  // Java 要在「void main」之前判，否则 `public static void main` 会被当成 C++
  if (/\bpublic\s+(final\s+|abstract\s+)?(class|static\s+void\s+main)\b/.test(text)) return 'java';
  if (/\bSystem\.(out|in)\./.test(text)) return 'java';
  if (/\b(int|void|double|long long)\s+main\s*\(/.test(text)) return 'cpp';

  if (/\bprogram\s+[\w.]+\s*[;(]/.test(text) && /\bbegin\b/i.test(text)) return 'pascal';
  if (/^\s*(var|const|type)\b[\s\S]*\bbegin\b[\s\S]*\bend\.?\s*$/im.test(text)) return 'pascal';

  if (/^\s*def\s+\w+\s*\(/m.test(text) && /:\s*$/m.test(text)) return 'python';
  if (/^\s*(import\s+\w+|from\s+\w+\s+import)\b/m.test(text) && /^\s*(def|class)\s+\w+/m.test(text)) return 'python';
  if (/^\s*print\s*\(/m.test(text) && !/[;{}]/.test(text)) return 'python';

  if (/\bfunc\s+\w+\s*\(/.test(text) && /\bpackage\s+\w+/.test(text)) return 'go';
  if (/\bfn\s+\w+\s*\(/.test(text) && /\blet\s+(mut\s+)?\w+/.test(text)) return 'rust';
  if (/\b(const|let|var)\s+\w+\s*=/.test(text) && /=>|function\s*\(/.test(text)) return 'js';
  return null;
}

// ---------------------------------------------------------------- 分词器

const C_PATTERN = [
  '(?<com>/\\*[\\s\\S]*?(?:\\*/|$))',
  '(?<line>//[^\\n]*)',
  '(?<str>"(?:\\\\.|[^"\\\\\\n])*"?)',
  '(?<chr>\'(?:\\\\.|[^\'\\\\\\n])*\')',
  '(?<pre>^[ \\t]*#[^\\n]*)',
  '(?<num>\\b\\d[\\w.\']*)',
  '(?<word>\\b[A-Za-z_]\\w*\\b)',
].join('|');

const PAS_PATTERN = [
  '(?<com>\\{[\\s\\S]*?(?:\\}|$))',
  '(?<com2>\\(\\*[\\s\\S]*?(?:\\*\\)|$))',
  '(?<line>//[^\\n]*)',
  "(?<str>'(?:''|[^'\\n])*'?)",
  '(?<num>\\b\\d[\\w.]*)',
  '(?<word>\\b[A-Za-z_]\\w*\\b)',
].join('|');

const PY_PATTERN = [
  '(?<line>#[^\\n]*)',
  '(?<str>"""[\\s\\S]*?(?:"""|$))',
  "(?<str2>'''[\\s\\S]*?(?:'''|$))",
  '(?<str3>"(?:\\\\.|[^"\\\\\\n])*"?)',
  "(?<str4>'(?:\\\\.|[^'\\\\\\n])*'?)",
  '(?<num>\\b\\d[\\w.]*)',
  '(?<word>\\b[A-Za-z_]\\w*\\b)',
].join('|');

/** 预处理行：`#include <iostream>` 里把 <iostream> / "x.h" 当字符串染，其余算指令本身 */
function renderPreprocessor(raw) {
  const m = /^([ \t]*#[ \t]*[A-Za-z]\w*)([\s\S]*)$/.exec(raw);
  if (!m) return `<span class="vj-tok-pre">${esc(raw)}</span>`;
  const rest = esc(m[2]).replace(/(&lt;[^&<>]*&gt;|&quot;[^&]*&quot;)/g, '<span class="vj-tok-str">$1</span>');
  return `<span class="vj-tok-pre">${esc(m[1])}</span>${rest}`;
}

function wordClass(word, language, after) {
  const spec = LANGUAGES[language];
  const key = spec.ci ? word.toLowerCase() : word;
  // 后面跟 ( 就是调用/定义，优先级高于词表（printf、sort 这类本来也都是普通标识符）
  if (/^\s*\(/.test(after)) {
    if (spec.types.has(key) || spec.keywords.has(key)) return spec.types.has(key) ? 'typ' : 'kw';
    return 'fn';
  }
  if (spec.keywords.has(key)) return 'kw';
  if (spec.types.has(key)) return 'typ';
  return null;
}

/**
 * 把代码切成 HTML。
 * @param {string} code 源码
 * @param {string} language LANGUAGES 的键（调用前先 normalizeLang / detectLanguage）
 */
function tokenize(code, language) {
  const spec = LANGUAGES[language];
  if (!spec) return esc(code);
  const pattern = spec.family === 'pas' ? PAS_PATTERN : spec.family === 'py' ? PY_PATTERN : C_PATTERN;
  const re = new RegExp(pattern, 'gm');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m.index > last) out += esc(code.slice(last, m.index));
    const g = m.groups || {};
    if (g.com || g.com2 || g.line) {
      out += `<span class="vj-tok-com">${esc(m[0])}</span>`;
    } else if (g.str || g.str2 || g.str3 || g.str4 || g.chr) {
      out += `<span class="vj-tok-str">${esc(m[0])}</span>`;
    } else if (g.pre) {
      out += renderPreprocessor(g.pre);
    } else if (g.num) {
      out += `<span class="vj-tok-num">${esc(m[0])}</span>`;
    } else if (g.word) {
      const cls = wordClass(g.word, language, code.slice(m.index + g.word.length));
      out += cls ? `<span class="vj-tok-${cls}">${esc(g.word)}</span>` : esc(g.word);
    } else {
      out += esc(m[0]);
    }
    last = m.index + m[0].length;
    if (!m[0]) re.lastIndex += 1;
  }
  out += esc(code.slice(last));
  return out;
}

/**
 * 高亮一段代码。
 * @param {string} code 源码原文（会自动转义）
 * @param {string} [lang] 语言提示，空则自动检测
 * @returns {string} HTML；识别不出语言时返回纯转义文本（不上色，免得把样例输入染花）
 */
function highlight(code, lang) {
  const text = String(code == null ? '' : code);
  if (!text.trim()) return esc(text);
  const language = normalizeLang(lang) || detectLanguage(text);
  if (!language) return esc(text);
  return tokenize(text, language);
}

// ---------------------------------------------------------------- 题面 HTML 里的 <pre>

const PRE_RE = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi;

/** 从标签属性里找语言提示：class="lang-cpp" / class="brush:cpp;" / data-lang="C++" / class="cpp" */
function langFromAttrs(attrs) {
  const text = String(attrs || '');
  const classMatch = /class\s*=\s*"([^"]*)"/i.exec(text) || /class\s*=\s*'([^']*)'/i.exec(text);
  const candidates = [];
  if (classMatch) {
    const cls = classMatch[1];
    // SyntaxHighlighter 的老写法：class="brush: cpp; gutter: false"
    const brush = /brush\s*:\s*([\w+#.-]+)/i.exec(cls);
    if (brush) candidates.push(brush[1]);
    for (const token of cls.split(/\s+/)) {
      const hit = /^(?:language|lang|highlight-source)[-_](.+)$/i.exec(token);
      if (hit) candidates.push(hit[1]);
      else if (normalizeLang(token)) candidates.push(token);
    }
  }
  const data = /data-(?:lang|language)\s*=\s*["']([^"']*)["']/i.exec(text);
  if (data) candidates.push(data[1]);
  for (const candidate of candidates) {
    const language = normalizeLang(candidate);
    if (language) return language;
  }
  return '';
}

/** 解码 <pre> 里的实体（VJudge / 洛谷 都会转义） */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 给题面 HTML 里的代码块上色。
 *
 * 三个必须绕开的坑：
 *   1. 样例区是 `<table class="vjudge_sample">` 里的 `<pre>`，那是输入输出数据，不能当代码染；
 *   2. 有些 `<pre>` 里塞的是图文混排（`<img>`、`<a>`、`<div>`），这种原样保留；
 *   3. 有些 `<pre>` 已经被别的工具上过色了（洛谷/CF 的 hljs `<span class="hljs-*">`），
 *      那些 class 我们没有样式，看着就是一片同色 —— 剥掉标签按我们的规则重染。
 */
function highlightCodeBlocks(html) {
  const src = String(html || '');
  if (!src || src.indexOf('<pre') < 0) return src;

  // 样例表格整块保护起来
  const tables = [];
  const masked = src.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => {
    tables.push(m);
    return `\u0000T${tables.length - 1}\u0000`;
  });

  const out = masked.replace(PRE_RE, (whole, attrs, inner) => {
    // 自己已经处理过的别再处理一遍（否则 data-lang 会叠两层）
    if (/\bvj-code\b/.test(attrs)) return whole;
    // <br> 先换成换行
    let flat = inner.replace(/<br\s*\/?>/gi, '\n');
    // 只允许「包装用」的标签；出现图片、链接、div 之类说明这块不是纯代码，原样放过
    if (/<(?!\/?(?:code|pre|span|em|strong|b|i|u|font)\b)[a-z]/i.test(flat)) return whole;
    // 剥标签之前先记住 <code> 上的语言提示（剥完就没属性了）
    const codeTag = /<code\b([^>]*)>/i.exec(flat);
    const codeLang = codeTag ? langFromAttrs(codeTag[1]) : '';
    if (/<(?!\/?(?:code|pre)\b)/i.test(flat)) flat = flat.replace(/<[^>]*>/g, '');
    const codeWrapper = /^\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*$/i.exec(flat);
    const body = codeWrapper ? codeWrapper[2] : flat;
    const raw = decodeEntities(body);
    if (!raw.trim()) return whole;
    // 语言提示可能在 <pre> 上，也可能在里头那个 <code> 上（GitHub / VJudge 两种写法都有）
    const language =
      langFromAttrs(attrs) || (codeWrapper ? langFromAttrs(codeWrapper[1]) : '') || codeLang || detectLanguage(raw);
    if (!language) return whole;
    // <pre> 上的 class 要合并，不能出现两个 class 属性（浏览器只认第一个）
    const preAttrs = /class\s*=\s*(["'])([\s\S]*?)\1/i.test(attrs)
      ? attrs.replace(/class\s*=\s*(["'])([\s\S]*?)\1/i, (m0, q, cls) => {
          const tokens = [...new Set(`${cls} code-block vj-code`.trim().split(/\s+/))];
          return `class="${tokens.join(' ')}"`;
        })
      : `${attrs} class="code-block vj-code"`;
    const label = LANGUAGES[language].label;
    return `<pre${preAttrs} data-lang="${label}"><code class="vj-lang-${language}">${tokenize(raw, language)}</code></pre>`;
  });

  return out.replace(/\u0000T(\d+)\u0000/g, (_, i) => tables[Number(i)] || '');
}

module.exports = {
  highlight,
  tokenize,
  detectLanguage,
  normalizeLang,
  highlightCodeBlocks,
  LANGUAGES,
};
