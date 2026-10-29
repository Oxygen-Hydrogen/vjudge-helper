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

  /** 私信：当前会话 id（右半边 data-contact 与左侧高亮都以它为准） */
  function currentContact() {
    const box = document.getElementById('vj-pm-conversation');
    return box ? box.getAttribute('data-contact') || '' : '';
  }

  function setActiveContact(contactId) {
    const items = document.querySelectorAll('#vj-pm-list [data-contact]');
    for (let i = 0; i < items.length; i += 1) {
      items[i].classList.toggle('is-active', items[i].getAttribute('data-contact') === contactId);
    }
    const box = document.getElementById('vj-pm-conversation');
    if (box) box.setAttribute('data-contact', contactId);
  }

  /** 讨论区的「回复谁」状态存在 DOM 上，发帖时读出来 */
  function replyTarget() {
    const box = document.getElementById('vj-discuss-replyto');
    if (!box || box.hidden) return { post: '0', author: '' };
    return { post: box.getAttribute('data-post') || '0', author: box.getAttribute('data-author') || '' };
  }

  function setReplyTarget(post, author) {
    const box = document.getElementById('vj-discuss-replyto');
    const name = document.getElementById('vj-discuss-reply-name');
    if (!box) return;
    if (post) {
      box.hidden = false;
      box.setAttribute('data-post', String(post));
      box.setAttribute('data-author', author || '');
      if (name) name.textContent = '@' + (author || '');
    } else {
      box.hidden = true;
      box.removeAttribute('data-post');
      box.removeAttribute('data-author');
      if (name) name.textContent = '';
    }
  }

  /** 已经显示了多少条：用来算「查看更早」的 start（站点每次 20 条） */
  function shownMessages() {
    return document.querySelectorAll('#vj-pm-thread .vj-pm__msg').length;
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

    // 私信：点左栏切联系人
    const contact = event.target.closest('#vj-pm-list [data-contact]');
    if (contact) {
      event.preventDefault();
      const id = contact.getAttribute('data-contact');
      setActiveContact(id);
      vscode.postMessage({ type: 'pmOpen', contactId: id });
      return;
    }

    const button = event.target.closest('[data-action]');
    if (button) {
      event.preventDefault();
      const action = button.getAttribute('data-action');
      const contactId = currentContact();

      // 这些动作需要带内容/参数，不能只发一个 action 字符串
      if (action === 'pmSend') {
        const input = document.getElementById('vj-pm-input');
        vscode.postMessage({ type: 'pmSend', contactId, content: input ? input.value : '' });
        return;
      }
      if (action === 'pmOlder') {
        const shown = shownMessages();
        vscode.postMessage({ type: 'pmOlder', contactId, start: Math.max(20, Math.ceil(shown / 20) * 20) });
        return;
      }
      if (action === 'pmDelete') {
        vscode.postMessage({ type: 'pmDelete', contactId, id: button.getAttribute('data-id') || '' });
        return;
      }
      if (action === 'pmBlock') {
        vscode.postMessage({
          type: 'pmBlock',
          contactId,
          blocked: button.getAttribute('data-blocked') !== '1',
        });
        return;
      }
      if (action === 'pmRefresh') {
        vscode.postMessage({ type: 'pmRefresh', contactId });
        return;
      }
      if (action === 'discussReply') {
        setReplyTarget(button.getAttribute('data-post'), button.getAttribute('data-author'));
        const input = document.getElementById('vj-discuss-input');
        if (input) input.focus();
        return;
      }
      if (action === 'discussCancelReply') {
        setReplyTarget('', '');
        return;
      }
      if (action === 'discussSend') {
        const input = document.getElementById('vj-discuss-input');
        const target = replyTarget();
        vscode.postMessage({
          type: 'discussSend',
          content: input ? input.value : '',
          parent: target.post || '0',
        });
        return;
      }
      if (action === 'discussDelete') {
        vscode.postMessage({ type: 'discussDelete', post: button.getAttribute('data-post') || '' });
        return;
      }

      vscode.postMessage({ type: 'action', action });
    }
  });

  window.addEventListener('message', function (event) {
    const data = event.data || {};
    if (data.type === 'toast') showToast(data.text);
    if (data.type === 'scrollTop') window.scrollTo({ top: 0 });
    if (data.type === 'standings') applyStandings(data);
    if (data.type === 'pmConversation') applyConversation(data);
    if (data.type === 'pmClear') {
      const input = document.getElementById('vj-pm-input');
      if (input) input.value = '';
    }
    if (data.type === 'discussionPosts') applyDiscussion(data);
    if (data.type === 'discussClear') {
      const input = document.getElementById('vj-discuss-input');
      if (input) input.value = '';
      setReplyTarget('', '');
    }
  });

  /** 切联系人 / 刷新后只换右半边 */
  function applyConversation(data) {
    const box = document.getElementById('vj-pm-conversation');
    if (!box || typeof data.html !== 'string') return;
    box.innerHTML = data.html;
    if (data.contactId) {
      box.setAttribute('data-contact', data.contactId);
      setActiveContact(data.contactId);
    }
    const thread = document.getElementById('vj-pm-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  /** 讨论区只换帖子列表，草稿框不动 */
  function applyDiscussion(data) {
    const box = document.getElementById('vj-discussion-posts');
    if (box && typeof data.html === 'string') box.innerHTML = data.html;
    const count = document.getElementById('vj-discuss-count');
    if (count && data.count !== undefined) count.textContent = data.count ? data.count + ' 条评论' : '';
  }

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
    // 「仅赛时 / 含赛后补题」按钮跟着后端状态走
    const toggle = document.getElementById('vj-practice-toggle');
    if (toggle && typeof data.includePractice === 'boolean') {
      toggle.setAttribute('data-on', data.includePractice ? '1' : '0');
      toggle.textContent = data.includePractice ? '含赛后补题 ✓' : '仅赛时';
      toggle.classList.toggle('is-on', data.includePractice);
    }
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

  // Ctrl / Cmd + Enter：私信和讨论区都直接发送
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    const target = event.target;
    if (!target || target.tagName !== 'TEXTAREA') return;
    if (target.id === 'vj-pm-input') {
      event.preventDefault();
      const button = document.querySelector('[data-action="pmSend"]');
      if (button) button.click();
      return;
    }
    if (target.id === 'vj-discuss-input') {
      event.preventDefault();
      const button = document.querySelector('[data-action="discussSend"]');
      if (button) button.click();
    }
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
