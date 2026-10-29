(function () {
  const vscode = acquireVsCodeApi();
  const toast = document.getElementById('vj-toast');

  /** 面板内部的自定义协议：前缀 -> 发给扩展的消息类型 */
  const SCHEMES = [
    ['vjudge-problem:', 'openProblem', 'key'],
    ['vjudge-contest:', 'openContest', 'id'],
    ['vjudge-article:', 'openArticle', 'id'],
    ['vjudge-group:', 'openGroup', 'name'],
  ];

  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.hidden = true;
    }, 1800);
  }

  document.addEventListener('click', function (event) {
    const anchor = event.target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      for (const [prefix, type, field] of SCHEMES) {
        if (href.indexOf(prefix) === 0) {
          event.preventDefault();
          const payload = { type };
          payload[field] = decodeURIComponent(href.slice(prefix.length));
          vscode.postMessage(payload);
          return;
        }
      }
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        vscode.postMessage({ type: 'openExternal', url: href });
        return;
      }
      if (href.charAt(0) === '/' && !href.startsWith('//')) {
        event.preventDefault();
        vscode.postMessage({ type: 'openPath', path: href });
        return;
      }
    }

    const button = event.target.closest('[data-action]');
    if (button) {
      event.preventDefault();
      vscode.postMessage({ type: 'action', action: button.getAttribute('data-action') });
    }
  });

  window.addEventListener('message', function (event) {
    const data = event.data || {};
    if (data.type === 'toast') showToast(data.text);
    if (data.type === 'scrollTop') window.scrollTo({ top: 0 });
    if (data.type === 'standings') applyStandings(data);
  });

  /** 榜单原地刷新：只换表格，不重载整页（滚动位置、展开状态都保留） */
  function applyStandings(data) {
    const inner = document.getElementById('vj-standings-inner');
    if (inner && typeof data.html === 'string') inner.innerHTML = data.html;
    const stamp = document.getElementById('vj-standings-updated');
    if (stamp && data.updatedAt) {
      stamp.textContent = '更新于 ' + new Date(data.updatedAt).toLocaleTimeString('zh-CN');
    }
    const hint = document.getElementById('vj-live-hint');
    if (hint && data.message) hint.innerHTML = '<i class="vj-live__dot"></i>' + data.message;
  }

  /** 比赛倒计时（本地每秒走，不用等扩展推送） */
  function tickCountdown() {
    const nodes = document.querySelectorAll('[data-vj-countdown]');
    for (let i = 0; i < nodes.length; i += 1) {
      const end = Number(nodes[i].getAttribute('data-vj-countdown'));
      if (!end) continue;
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      const s = left % 60;
      const pad = (v) => String(v).padStart(2, '0');
      nodes[i].textContent = h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
    }
  }
  tickCountdown();
  setInterval(tickCountdown, 1000);

  // 复制后给出反馈
  document.addEventListener('click', function (event) {
    const button = event.target.closest('[data-action="copy"]');
    if (!button) return;
    const text = button.getAttribute('data-copy') || '';
    if (!text) return;
    navigator.clipboard.writeText(text).catch(function () {});
  });

  // 公式自检：5 秒后看 MathJax 到底有没有干活，没干活就把原因说出来
  setTimeout(function () {
    const hasDelimiters = /\\\(|\\\[/.test(document.body.textContent || '');
    if (!hasDelimiters) return;
    const typeset = document.querySelectorAll('mjx-container').length;
    if (typeset === 0) {
      if (typeof window.MathJax === 'undefined') {
        showToast('公式引擎没加载出来（三个 CDN 都不通），公式显示为标准写法');
      } else {
        showToast('MathJax 已加载但没识别到公式，可点「浏览器打开」对照');
      }
      return;
    }
    // 引擎在干活，但个别公式里有它不认识的命令（会渲染成红字，例如 \bm）
    const errors = document.querySelectorAll('mjx-merror');
    if (!errors.length) return;
    const unknown = [];
    for (let i = 0; i < errors.length; i += 1) {
      const hit = (errors[i].textContent || '').match(/\\[A-Za-z]+/g) || [];
      for (const cmd of hit) if (unknown.indexOf(cmd) < 0) unknown.push(cmd);
    }
    const detail = unknown.length ? '（' + unknown.slice(0, 4).join('、') + '）' : '';
    showToast('有 ' + errors.length + ' 处公式含 MathJax 不认识的命令' + detail + '，可点「浏览器打开」对照原文');
  }, 5000);
})();
