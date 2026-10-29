'use strict';

const vscode = require('vscode');
const { MATHJAX_TEX_MACROS } = require('../util');

/** 每个 kind 复用一个面板实例 */
const panels = new Map();

function randomNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 生成 webview 页面
 * @param {object} opts
 * @param {vscode.Webview} opts.webview
 * @param {vscode.Uri} opts.extensionUri
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {{label: string, value?: string, tone?: string}[]} [opts.meta]
 * @param {{id: string, label: string, primary?: boolean}[]} [opts.actions]
 * @param {string} opts.body
 * @param {string} [opts.footer]
 * @param {boolean} [opts.enableMathJax]
 */
function renderShell(opts) {
  const { webview, extensionUri, title, subtitle, meta = [], actions = [], body, footer = '' } = opts;
  const nonce = randomNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  const enableMathJax = opts.enableMathJax !== false;

  // 公式：jsDelivr 在部分网络下不可达，准备多个源依次尝试
  const mathJaxConfig = enableMathJax
    ? `<script nonce="${nonce}">
      window.MathJax = {
        tex: {
          // 只用 \( \) / \[ \]：题面里常有不成对的 $，用 $ 配对会把正文吞进数学模式
          inlineMath: [['\\\\(', '\\\\)']],
          displayMath: [['\\\\[', '\\\\]']],
          processEscapes: true,
          // 中文题面爱用 \bm / \texttt 这些 MathJax 3 默认没有的命令，
          // 不补的话 noundefined 包会把它们渲染成红字（洛谷 P1001 就是 \bm a）
          macros: ${JSON.stringify(MATHJAX_TEX_MACROS)}
        },
        options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'a'] },
        startup: { typeset: true }
      };
    </script>
    <script nonce="${nonce}">
      (function () {
        var sources = [
          'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js',
          'https://lib.baomitu.com/mathjax/3.2.2/es5/tex-mml-chtml.js',
          'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-mml-chtml.js'
        ];
        var index = 0;
        function load() {
          if (index >= sources.length) {
            document.body.classList.add('vj-no-mathjax');
            return;
          }
          var s = document.createElement('script');
          s.async = true;
          s.src = sources[index++];
          s.onerror = load;
          document.head.appendChild(s);
        }
        load();
      })();
    </script>`
    : '';

  const metaHtml = meta
    .filter((m) => m && (m.value || m.label))
    .map((m) => {
      const tone = m.tone ? ` vj-chip--${m.tone}` : '';
      const value = m.value ? `<b>${escapeHtml(m.value)}</b>` : '';
      return `<span class="vj-chip${tone}">${m.label ? `<span class="vj-chip__k">${escapeHtml(m.label)}</span>` : ''}${value}</span>`;
    })
    .join('');

  const actionHtml = actions
    .map(
      (a) =>
        `<button class="vj-btn${a.primary ? ' vj-btn--primary' : ''}" data-action="${escapeHtml(a.id)}" title="${escapeHtml(a.title || a.label)}">${escapeHtml(a.label)}</button>`
    )
    .join('');

  const csp = [
    "default-src 'none'",
    `img-src https: data: ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src https: data: ${webview.cspSource}`,
    `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://lib.baomitu.com https://cdnjs.cloudflare.com`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<header class="vj-header">
  <div class="vj-header__row">
    <div class="vj-titlebar">
      <h1 class="vj-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="vj-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
    ${actions.length ? `<div class="vj-actions">${actionHtml}</div>` : ''}
  </div>
  ${metaHtml ? `<div class="vj-meta">${metaHtml}</div>` : ''}
</header>
<main class="vj-body" id="vj-body">${body}</main>
${footer ? `<footer class="vj-footer">${footer}</footer>` : ''}
<div class="vj-toast" id="vj-toast" hidden></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
${mathJaxConfig}
</body>
</html>`;
}

/**
 * 展示/更新面板
 * @param {vscode.ExtensionContext} context
 * @param {string} kind problem | article | contest
 * @param {object} options
 */
function showPanel(context, kind, options) {
  const key = `${context.extensionUri.fsPath}::${kind}`;
  let entry = panels.get(key);

  if (!entry) {
    const panel = vscode.window.createWebviewPanel(
      `vjudgeHelper.${kind}`,
      options.title || 'VJudge',
      options.viewColumn || vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    entry = { panel, handler: null };
    panels.set(key, entry);
    panel.webview.onDidReceiveMessage((msg) => (entry.handler ? entry.handler(msg) : undefined));
    if (typeof panel.onDidChangeViewState === 'function') {
      panel.onDidChangeViewState(() => {
        if (entry.onVisibilityChange) entry.onVisibilityChange(panel.visible);
      });
    }
    panel.onDidDispose(() => {
      if (entry.onDispose) entry.onDispose();
      panels.delete(key);
    });
  }

  entry.handler = options.onMessage;
  entry.onDispose = options.onDispose;
  entry.onVisibilityChange = options.onVisibilityChange;

  if (options.title) entry.panel.title = options.title;
  entry.panel.webview.html = renderShell({
    webview: entry.panel.webview,
    extensionUri: context.extensionUri,
    enableMathJax: options.enableMathJax,
    ...options,
  });
  entry.panel.reveal(undefined, false);
  return entry.panel;
}

function disposePanel(kind) {
  for (const [key, entry] of panels) {
    if (key.endsWith(`::${kind}`)) {
      entry.panel.dispose();
      panels.delete(key);
    }
  }
}

module.exports = { showPanel, disposePanel, renderShell };
