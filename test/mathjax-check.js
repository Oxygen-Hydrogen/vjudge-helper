'use strict';
/**
 * 面板里那段 MathJax 配置能不能被浏览器原样执行。
 *
 * 背景：shell.js 用 JSON.stringify 把宏表拼进 <script>，只要转义错一层
 * （比如 \boldsymbol 变成 \b + oldsymbol），整段配置就报语法错误，
 * 页面上的公式会全部退化成原始 LaTeX——但单元测试和肉眼审代码都看不出来。
 * 这里用 vm 把注入的那段对象字面量真的跑一遍。
 *
 * 顺带断言：只用 \( \) / \[ \]，不能开 $...$（题面里不成对的 $ 会吞正文）。
 *
 * 跑法：node test/mathjax-check.js
 */
const Module = require('module');
const path = require('path');
const vm = require('vm');

// shell.js 顶层 require('vscode')，这里塞个最小替身
const fakeVscode = {
  Uri: {
    file: (p) => ({ fsPath: p, path: p, toString: () => p }),
    joinPath: (base, ...rest) => fakeVscode.Uri.file(path.join(base.fsPath || base.path, ...rest)),
  },
  ViewColumn: { Active: -1 },
  window: {},
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, ...rest);
};

const { renderShell } = require('../src/webview/shell');
const { MATHJAX_TEX_MACROS } = require('../src/util');

let failed = 0;
function ok(label, condition, extra) {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${extra && !condition ? ` —— ${extra}` : ''}`);
  if (!condition) failed += 1;
}

/** 从 html 里抠出 window.MathJax = {...}; 的对象字面量（按括号配对，忽略字符串里的括号） */
function extractConfigObject(html) {
  const at = html.indexOf('window.MathJax');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

console.log('============================================================');
console.log('MathJax 配置（面板注入）');
console.log('============================================================');

const html = renderShell({
  webview: { cspSource: 'vscode-webview://test', asWebviewUri: (u) => u },
  extensionUri: fakeVscode.Uri.file(path.join(__dirname, '..')),
  title: '配置校验',
  body: '<p>输入 \\(\\bm a\\) 和 \\(\\bm b\\)，输出 \\(a+b\\le 10^9\\)。</p>',
  enableMathJax: true,
});

ok('HTML 里出现 MathJax 配置', html.includes('window.MathJax'));

const objectText = extractConfigObject(html);
ok('能抠出配置对象', Boolean(objectText));

if (objectText) {
  const sandbox = { window: {} };
  let parseError = null;
  try {
    vm.runInNewContext(`window.MathJax = ${objectText};`, sandbox, { timeout: 1000 });
  } catch (err) {
    parseError = err;
  }
  ok('配置能被 JS 解析（转义没错）', !parseError, parseError && parseError.message);

  const cfg = sandbox.window.MathJax;
  if (cfg) {
    const tex = cfg.tex || {};
    const macros = tex.macros || {};

    ok('inlineMath 只有 \\( \\)', JSON.stringify(tex.inlineMath) === JSON.stringify([['\\(', '\\)']]), JSON.stringify(tex.inlineMath));
    ok('displayMath 只有 \\[ \\]', JSON.stringify(tex.displayMath) === JSON.stringify([['\\[', '\\]']]), JSON.stringify(tex.displayMath));
    ok('没有开 $...$', !JSON.stringify(tex.inlineMath).includes('$'));

    // 反斜杠在 HTML → JS 字符串 → 宏表里必须还是完整的一条命令
    const bm = macros.bm;
    ok('宏表里有 bm', Array.isArray(bm), JSON.stringify(bm));
    ok('bm 展开成 \\boldsymbol{#1}', Array.isArray(bm) && bm[0] === '\\boldsymbol{#1}', bm && bm[0]);
    ok('bm 带 1 个参数', Array.isArray(bm) && bm[1] === 1, bm && bm[1]);

    for (const name of ['texttt', 'textbf', 'textit', 'textrm', 'textsf', 'degree', 'R']) {
      ok(`宏表里有 ${name}`, Object.prototype.hasOwnProperty.call(macros, name));
    }

    const broken = Object.entries(macros).filter(([, v]) => !Array.isArray(v) || typeof v[0] !== 'string' || !v[0].trim());
    ok('所有宏都是 [表达式, 参数个数]', broken.length === 0, broken.map(([k]) => k).join(','));

    // 最常见的坑是多转义一层：\boldsymbol 变成字面上的 \\boldsymbol（TeX 里会打印一个反斜杠）
    // 以及 \ 后面跟了空格/数字，那已经不是命令了
    const weird = Object.entries(macros)
      .filter(([, v]) => Array.isArray(v) && (v[0].includes('\\\\') || /\\[^A-Za-z]/.test(v[0])))
      .map(([k, v]) => `${k}=${v[0]}`);
    ok('宏表达式没有多转义/断掉的命令', weird.length === 0, weird.join(','));

    ok('宏表非空', Object.keys(macros).length >= 10, `只有 ${Object.keys(macros).length} 个`);
    ok('注入的宏表与源一致', JSON.stringify(macros) === JSON.stringify(MATHJAX_TEX_MACROS));
  }
}

// 关掉公式时不该残留配置（否则空白面板也要去拉 1 MB 的 MathJax）
const noMath = renderShell({
  webview: { cspSource: 'vscode-webview://test', asWebviewUri: (u) => u },
  extensionUri: fakeVscode.Uri.file(path.join(__dirname, '..')),
  title: '无公式',
  body: '<p>纯文本</p>',
  enableMathJax: false,
});
ok('enableMathJax=false 时不注入配置', !noMath.includes('window.MathJax'));
ok('enableMathJax=false 时不拉 CDN', !noMath.includes('mathjax@3'));

console.log('');
if (failed) {
  console.log(`✗ ${failed} 项未通过`);
  process.exit(1);
}
console.log('全部通过。');
