'use strict';

const { escapeHtml, mathTokenRegex, mathTokenToLatex } = require('./util');
const { highlight, normalizeLang, detectLanguage, LANGUAGES } = require('./highlight');

/** 代码块：能认出语言就上色，认不出就原样 */
function codeBlockHtml(code, lang) {
  const language = normalizeLang(lang) || detectLanguage(code);
  if (!language) return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
  return `<pre class="code-block vj-code" data-lang="${LANGUAGES[language].label}"><code class="vj-lang-${language}">${highlight(code, language)}</code></pre>`;
}

/** 极简 Markdown 渲染器（够用于 VJudge 文章/题面） */
function sanitize(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/ on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function inline(text) {
  let out = text;

  // 公式先摘出来，避免 _ * \ 被 Markdown 语法误伤（后面统一交给 MathJax）
  // 定界符规则集中在 util.mathTokenToLatex：$$$x$$$ / $$x$$ / $x$ / \(x\) 都认
  const maths = [];
  out = out.replace(mathTokenRegex(), (m) => {
    maths.push(m);
    return `\u0000M${maths.length - 1}\u0000`;
  });

  // 行内代码优先
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const safe = /^(https?:|\/|#|vjudge-problem:|mailto:)/i.test(href) ? href : '#';
      return `<a href="${safe}">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/  \n/g, '<br>\n');

  out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || '');
  // 公式统一换成 \( \) / \[ \]，避免 MathJax 用 $ 配对时把正文吞进数学模式
  out = out.replace(/\u0000M(\d+)\u0000/g, (_, i) => mathTokenToLatex(maths[Number(i)] || ''));
  return out;
}

/** $x$ -> \(x\)；$$$x$$$ / $$x$$ / \(x\) 都规范化，规则见 util.mathTokenToLatex */
function toMathDelimiters(raw) {
  return mathTokenToLatex(raw);
}

/**
 * @param {string} markdown
 * @param {{problemLink?: (key: string) => string}} [options]
 */
function renderMarkdown(markdown, options = {}) {
  const problemLink =
    options.problemLink || ((key) => `vjudge-problem:${encodeURIComponent(key)}`);

  const src = String(markdown || '').replace(/\r\n/g, '\n');

  // 保护代码块
  const blocks = [];
  let text = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(codeBlockHtml(code, String(lang).trim()));
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  // [problem:POJ-1000] -> 内部题面链接
  text = text.replace(/\[problem:([^\]]+)\]/gi, (_, key) => {
    const clean = key.trim();
    return `[${clean}](${problemLink(clean)})`;
  });
  // <problem:POJ-1000> 兼容写法
  text = text.replace(/&lt;problem:([^&]+?)&gt;|<problem:([^>]+)>/gi, (_, a, b) => {
    const clean = (a || b).trim();
    return `[${clean}](${problemLink(clean)})`;
  });

  const lines = text.split('\n');
  const out = [];
  let inCode = null;
  let listType = null;
  let paragraph = [];
  let quoteLines = [];
  let tableBuffer = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join('\n'))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quoteLines.length) {
      out.push(`<blockquote>${inline(quoteLines.join('\n'))}</blockquote>`);
      quoteLines = [];
    }
  };
  const flushTable = () => {
    if (!tableBuffer.length) return;
    const rows = tableBuffer.filter((l) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l));
    if (rows.length) {
      const cellsOf = (l) =>
        l
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = cellsOf(rows[0]);
      const body = rows.slice(1);
      let html = '<table><thead><tr>';
      html += head.map((c) => `<th>${inline(c)}</th>`).join('');
      html += '</tr></thead><tbody>';
      for (const row of body) {
        html += `<tr>${cellsOf(row).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      }
      html += '</tbody></table>';
      out.push(html);
    }
    tableBuffer = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine;

    if (inCode) {
      if (/^\s*```/.test(line)) {
        out.push(codeBlockHtml(inCode.lines.join('\n'), inCode.lang));
        inCode = null;
      } else {
        inCode.lines.push(line);
      }
      continue;
    }
    const fenceOpen = /^\s*```\s*([^`\s]*)\s*$/.exec(line);
    if (fenceOpen) {
      flushAll();
      inCode = { lang: fenceOpen[1] || '', lines: [] };
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }

    const blockRef = /^\u0000B(\d+)\u0000$/.exec(line.trim());
    if (blockRef) {
      flushAll();
      out.push(blocks[Number(blockRef[1])] || '');
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      tableBuffer.push(line);
      continue;
    } else if (tableBuffer.length) {
      flushTable();
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      quoteLines.push(line.replace(/^\s*>\s?/, ''));
      continue;
    } else if (quoteLines.length) {
      flushQuote();
    }

    // 列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushParagraph();
      const wanted = ul ? 'ul' : 'ol';
      if (listType !== wanted) {
        flushList();
        listType = wanted;
        out.push(`<${wanted}>`);
      }
      out.push(`<li>${inline((ul || ol)[1].trim())}</li>`);
      continue;
    } else if (listType) {
      flushList();
    }

    paragraph.push(line);
  }

  if (inCode) {
    out.push(codeBlockHtml(inCode.lines.join('\n'), inCode.lang));
  }
  flushAll();

  return sanitize(out.join('\n'));
}

module.exports = { renderMarkdown };
