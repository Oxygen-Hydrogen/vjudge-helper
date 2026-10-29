'use strict';

/**
 * 私信 + 比赛讨论区 + 榜单「含赛后补题」的离线自检。
 *
 * 全程不联网：
 *   - HTTP 层直接打桩（client.httpGet / client.httpPost 换成返回固定数据的函数）
 *   - 会话列表用 /message 页面的真实结构片段（2026-10 抓的）
 *   - 讨论区用 /comment/thread 的真实返回结构
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// vscode 模块在 Node 里不存在，按需打桩（renderers 会间接 require 到 util）
const Module = require('module');
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'vscode') {
    return {
      Uri: { file: (p) => ({ fsPath: String(p) }), joinPath: () => ({ fsPath: '' }) },
      window: {},
      workspace: { getConfiguration: () => ({ get: () => null }) },
      env: {},
      commands: {},
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { VJudgeClient, parseMessageContacts, extractVisitorName, feedbackErrorText } = require('../src/vjudge');
const renderers = require('../src/webview/renderers');
const { buildStandings } = require('../src/standings');

let passed = 0;
const failures = [];

function ok(title, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + title);
  } catch (err) {
    failures.push({ title, err });
    console.log('  ✗ ' + title + '\n      ' + err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

// 摘自真实 /message 页面（只保留两条会话 + 一条带 class="unread" 的）
const MESSAGE_HTML = `<!DOCTYPE html><html><body>
<input id="visitor_username" name="username" type="hidden" value="HydrogenOxygen">
<input id="visitor_userId" name="userId" type="hidden" value="935212">
<div class="contacts-container">
  <ul class="list-group" id="contacts-list">
    <li class="list-group-item contact active" data-contact-id="1041388">
      <img src="/user/avatar/1041388" height="20">
      <span>&nbsp;&nbsp;<b>_0_px</b></span>
      (<span class="msg-last-time">78 分钟前</span>)
      <br>
      <span class="msg-preview">\`\`\`c++ #include &lt;bit...</span>
    </li>
    <li class="list-group-item contact unread" data-contact-id="1092606">
      <img src="/user/avatar/1092606" height="20">
      <span>&nbsp;&nbsp;<b>summer0703</b></span>
      (<span class="msg-last-time">27 小时前</span>)
      <br>
      <span class="msg-preview">答案是 1</span>
    </li>
  </ul>
</div>
</body></html>`;

const CONVERSATION_JSON = JSON.stringify({
  blockedByMe: false,
  canBlock: true,
  messages: [
    { id: 900274, author: 'HydrogenOxygen', content: '来碗', time: 1793000238000 },
    { id: 900275, author: '_0_px', content: '牛肉\n```cpp\nint a, b;\ncin >> a >> b;\n```', time: 1793000243000 },
  ],
});

const THREAD_JSON = JSON.stringify({
  id: 42,
  path: 'contest/863093',
  commentNumber: 4,
  allowBroadcast: true,
  isManager: false,
  hasMore: false,
  posts: [
    { id: 1, parentId: 0, author: 'alice', authorId: 11, content: 'A 题是二分吧', time: 1793000000000, topIndex: 0, deleted: false, likeCnt: 3 },
    { id: 2, parentId: 1, author: 'bob', authorId: 22, content: '感觉像贪心', time: 1793000100000, topIndex: 0, deleted: false, likeCnt: 0 },
    { id: 3, parentId: 0, author: 'HydrogenOxygen', authorId: 935212, content: '已 AC，贴个思路', time: 1793000200000, topIndex: 0, deleted: false, likeCnt: 1 },
    { id: 4, parentId: 0, author: 'carol', authorId: 33, content: '删了', time: 1793000300000, topIndex: 0, deleted: true, likeCnt: 0 },
  ],
});

function fakeClient(overrides) {
  const session = {
    baseUrl: 'https://vjudge.net',
    jar: {},
    timeout: 1000,
    hasCredentials: true,
  };
  const client = new VJudgeClient(session);
  client.httpGet = async () => ({ status: 200, url: 'https://vjudge.net/message', body: MESSAGE_HTML });
  client.httpPost = async () => ({ status: 200, url: 'https://vjudge.net/message', body: '{}' });
  Object.assign(client, overrides || {});
  return client;
}

/* ------------------------------------------------------------------ */
/* 1. 会话列表解析                                                     */
/* ------------------------------------------------------------------ */

console.log('\n[1] /message 页面解析');

ok('解析出两条会话，字段齐全', () => {
  const list = parseMessageContacts(MESSAGE_HTML);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map((c) => c.id), ['1041388', '1092606']);
  assert.strictEqual(list[0].name, '_0_px');
  assert.strictEqual(list[0].timeText, '78 分钟前');
  assert.strictEqual(list[0].active, true);
  assert.strictEqual(list[0].unread, false);
});

ok('unread 标记与实体解码', () => {
  const list = parseMessageContacts(MESSAGE_HTML);
  assert.strictEqual(list[1].unread, true, 'unread 没认出来');
  assert.ok(list[0].preview.includes('#include <bit'), '预览里的 &lt; 没解码：' + list[0].preview);
});

ok('空页面不抛异常', () => {
  assert.deepStrictEqual(parseMessageContacts(''), []);
  assert.deepStrictEqual(parseMessageContacts(null), []);
});

ok('当前用户名从 hidden input 取', () => {
  assert.strictEqual(extractVisitorName(MESSAGE_HTML), 'HydrogenOxygen');
  assert.strictEqual(extractVisitorName('<html></html>'), '');
});

/* ------------------------------------------------------------------ */
/* 2. 客户端方法（打桩 HTTP）                                          */
/* ------------------------------------------------------------------ */

console.log('\n[2] 私信客户端');

(async () => {
  {
    const client = fakeClient();
    const book = await client.fetchMessageContacts();
    ok('fetchMessageContacts 返回 contacts/me', () => {
      assert.strictEqual(book.contacts.length, 2);
      assert.strictEqual(book.me, 'HydrogenOxygen');
      assert.strictEqual(book.url, 'https://vjudge.net/message');
    });
  }

  {
    // 登录墙：页面里既没有 #contacts-list，也解析不出会话
    const client = fakeClient({
      httpGet: async () => ({ status: 200, url: 'https://vjudge.net/', body: '<html>Please login</html>' }),
    });
    let caught = null;
    try {
      await client.fetchMessageContacts();
    } catch (err) {
      caught = err;
    }
    ok('拿不到会话列表时按「需要登录」报错', () => {
      assert.ok(caught, '没抛错');
      assert.strictEqual(caught.code, 'LOGIN_REQUIRED', '错误码不对：' + caught.message);
    });
  }

  {
    let posted = null;
    const client = fakeClient({
      httpPost: async (p, fields) => {
        posted = { path: p, fields };
        return { status: 200, url: 'https://vjudge.net/message', body: CONVERSATION_JSON };
      },
    });
    const conv = await client.fetchConversation(1041388, { start: 0 });
    ok('fetchConversation 打到 /message/conversation/{id}', () => {
      assert.strictEqual(posted.path, '/message/conversation/1041388');
      assert.strictEqual(String(posted.fields.start), '0');
    });
    ok('会话消息字段被规范化', () => {
      assert.strictEqual(conv.messages.length, 2);
      assert.strictEqual(conv.messages[0].author, 'HydrogenOxygen');
      assert.strictEqual(conv.messages[0].time, 1793000238000);
      assert.strictEqual(conv.blockedByMe, false);
      assert.strictEqual(conv.canBlock, true);
    });
  }

  {
    // 未登录时这个接口回的是 `{}`，必须当成需要登录
    const client = fakeClient({ httpPost: async () => ({ status: 200, url: 'https://vjudge.net/message', body: '{}' }) });
    let caught = null;
    try {
      await client.fetchConversation(1, {});
    } catch (err) {
      caught = err;
    }
    ok('会话接口回 {} 时提示需要登录', () => {
      assert.ok(caught, '没抛错');
      assert.strictEqual(caught.code, 'LOGIN_REQUIRED', '错误码不是 LOGIN_REQUIRED：' + caught.message);
    });
  }

  {
    let sent = null;
    const client = fakeClient({
      httpPost: async (p, fields) => {
        sent = { path: p, fields };
        return { status: 200, url: 'https://vjudge.net/message', body: '{"ok":1}' };
      },
    });
    await client.sendMessage(1041388, '你好\n第二行');
    ok('sendMessage 的字段名是 contactId + content', () => {
      assert.strictEqual(sent.path, '/message/post');
      assert.strictEqual(sent.fields.contactId, '1041388');
      assert.strictEqual(sent.fields.content, '你好\n第二行');
    });
  }

  {
    let del = null;
    const client = fakeClient({
      httpPost: async (p, fields) => {
        del = { path: p, fields };
        return { status: 200, url: 'https://vjudge.net/message', body: '' };
      },
    });
    await client.deleteMessage(900274);
    ok('deleteMessage 的 id 在 query 上而不是 body', () => {
      assert.strictEqual(del.path, '/message/delete?id=900274');
      assert.strictEqual(del.fields, null);
    });
  }

  {
    let block = null;
    const client = fakeClient({
      httpPost: async (p, fields) => {
        block = { path: p, fields };
        return { status: 200, url: 'https://vjudge.net/message', body: '{}' };
      },
    });
    await client.setContactBlocked(1041388, true);
    ok('拉黑带 contactId + blocked', () => {
      assert.strictEqual(block.path, '/message/block');
      assert.strictEqual(block.fields.contactId, '1041388');
      assert.strictEqual(block.fields.blocked, 'true');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 3. 讨论区                                                           */
  /* ------------------------------------------------------------------ */

  console.log('\n[3] 讨论区客户端');

  {
    let url = '';
    const client = fakeClient({
      httpGet: async (p) => {
        url = p;
        return { status: 200, url: 'https://vjudge.net/contest/863093', body: THREAD_JSON };
      },
    });
    const d = await client.fetchDiscussion('contest/863093');
    ok('讨论路径是 contest/{id}，loadAll=1', () => {
      assert.ok(/^\/comment\/thread\?path=contest%2F863093&loadAll=1&t=\d+$/.test(url), 'URL 不对：' + url);
    });
    ok('帖子按 id/parentId 规范化', () => {
      assert.strictEqual(d.posts.length, 4);
      assert.strictEqual(d.posts[1].parentId, '1');
      assert.strictEqual(d.commentNumber, 4);
      assert.strictEqual(d.posts[3].deleted, true);
    });
  }

  {
    const client = fakeClient();
    let caught = null;
    try {
      await client.fetchDiscussion('not-a-path');
    } catch (err) {
      caught = err;
    }
    ok('非法讨论路径直接拒绝（不打请求）', () => {
      assert.ok(caught, '没抛错');
      assert.ok(/不合法/.test(caught.message));
    });
  }

  {
    let posted = null;
    const client = fakeClient({
      httpPost: async (p, fields) => {
        posted = { path: p, fields };
        return { status: 200, url: 'https://vjudge.net/contest/863093', body: '{"id":99}' };
      },
    });
    await client.postComment({ path: 'contest/863093', content: '贴个思路', parent: 1 });
    ok('发评论带 path/parent/content/broadcast', () => {
      assert.strictEqual(posted.path, '/comment/post');
      assert.strictEqual(posted.fields.path, 'contest/863093');
      assert.strictEqual(posted.fields.parent, '1');
      assert.strictEqual(posted.fields.broadcast, 'true');
    });
  }

  {
    const client = fakeClient({
      httpPost: async () => ({
        status: 200,
        url: 'https://vjudge.net/comment/post',
        body: '{"error":{"i18nKey":"comment.error.login_required"}}',
      }),
    });
    let caught = null;
    try {
      await client.postComment({ path: 'contest/1', content: 'x' });
    } catch (err) {
      caught = err;
    }
    ok('接口返回 i18nKey 时翻译成人话', () => {
      assert.ok(caught, '没抛错');
      assert.strictEqual(caught.message, '请先登录 VJudge');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4. 渲染                                                             */
  /* ------------------------------------------------------------------ */

  console.log('\n[4] 渲染');

  const contacts = parseMessageContacts(MESSAGE_HTML);
  const me = extractVisitorName(MESSAGE_HTML);
  const conversation = {
    contactId: '1041388',
    start: 0,
    blockedByMe: false,
    canBlock: true,
    messages: JSON.parse(CONVERSATION_JSON).messages.map((m) => ({ ...m, id: String(m.id) })),
  };
  const view = renderers.renderMessage({
    contacts,
    me,
    activeId: '1041388',
    conversation,
    url: 'https://vjudge.net/message',
  });

  ok('私信面板包含左栏、右栏与发送按钮', () => {
    assert.ok(view.body.includes('id="vj-pm-list"'));
    assert.ok(view.body.includes('id="vj-pm-conversation"'));
    assert.ok(view.body.includes('data-action="pmSend"'));
    assert.ok(view.body.includes('id="vj-pm-input"'));
  });

  ok('自己的消息靠右（is-me），对方的不加', () => {
    const mine = /class="vj-pm__msg is-me"[\s\S]*?HydrogenOxygen/.test(view.body);
    assert.ok(mine, '自己的消息没标 is-me');
    assert.ok(view.body.includes('class="vj-pm__msg"'), '对方消息不该有 is-me');
    assert.strictEqual((view.body.match(/is-me/g) || []).length, 1);
  });

  ok('私信里的代码块照样上色', () => {
    assert.ok(/vj-tok-kw|vj-lang-cpp/.test(view.body), '代码块没高亮');
  });

  ok('被拉黑时禁止发送', () => {
    const html = renderers.renderConversationInner({ ...conversation, blockedByMe: true }, { contact: contacts[0], me });
    assert.ok(/id="vj-pm-input"[^>]*disabled/.test(html), '输入框没禁用');
    assert.ok(/data-action="pmSend"[^>]*disabled/.test(html), '发送按钮没禁用');
    assert.ok(/解除拉黑/.test(html), '拉黑按钮文案没切换');
  });

  ok('会话读取失败时给出空状态而不是白屏', () => {
    const html = renderers.renderConversationInner(null, { contact: contacts[0], me, error: '需要登录' });
    assert.ok(html.includes('vj-empty'), '没有空状态');
    assert.ok(html.includes('需要登录'));
  });

  const discussion = {
    path: 'contest/863093',
    commentNumber: 4,
    posts: JSON.parse(THREAD_JSON).posts.map((p) => ({ ...p, id: String(p.id), parentId: String(p.parentId) })),
  };

  ok('讨论区按 parentId 嵌套，回复缩进', () => {
    const html = renderers.renderDiscussionPosts(discussion, { myId: '935212' });
    assert.ok(html.includes('vj-discuss__kids'), '没有嵌套容器');
    assert.strictEqual((html.match(/<article/g) || []).length, 4, '帖子条数不对');
  });

  ok('自己的评论才显示删除按钮', () => {
    const html = renderers.renderDiscussionPosts(discussion, { myId: '935212' });
    assert.strictEqual((html.match(/data-action="discussDelete"/g) || []).length, 1, '删除按钮数量不对');
    const other = renderers.renderDiscussionPosts(discussion, { myId: '11' });
    assert.strictEqual((other.match(/data-action="discussDelete"/g) || []).length, 1);
    const nobody = renderers.renderDiscussionPosts(discussion, { myId: '' });
    assert.strictEqual((nobody.match(/data-action="discussDelete"/g) || []).length, 0);
  });

  ok('删除的评论占位而不是消失', () => {
    const html = renderers.renderDiscussionPosts(discussion, { myId: '935212' });
    assert.ok(html.includes('[已删除]'));
  });

  ok('讨论区整块带发帖框与计数', () => {
    const html = renderers.renderContestDiscussion(discussion, { myId: '935212' });
    assert.ok(html.includes('id="vj-discussion-posts"'));
    assert.ok(html.includes('id="vj-discuss-input"'));
    assert.ok(html.includes('4 条评论'));
  });

  /* ------------------------------------------------------------------ */
  /* 5. 榜单「含补题」                                                   */
  /* ------------------------------------------------------------------ */

  console.log('\n[5] 榜单：仅赛时 vs 含赛后补题');

  const T = 1793000000000;
  const contest = {
    id: '1',
    problems: [{ index: 'A', key: 'X-1', title: 'A', weight: 1 }],
    data: { begin: T, end: T + 3600000, penalty: 1200, sumTime: true },
  };
  const rank = {
    id: '1',
    participants: { '11': { type: 'user', name: 'alice' } },
    // A 题：赛时错一次，赛后（+7200 秒）才过
    submissions: [
      [11, 0, 2, 600],
      [11, 0, 1, 7200],
    ],
  };

  ok('默认只算赛时：赛后补题不计入', () => {
    const st = buildStandings(contest, rank, { now: T + 86400000 });
    const row = st.rows[0];
    assert.strictEqual(row.solved, 0, '赛时不该有通过');
    assert.strictEqual(row.cells[0].acSeconds, null);
    assert.strictEqual(row.cells[0].fails, 1);
    assert.strictEqual(st.includePractice, false);
  });

  ok('打开 includePractice 后补题算进排名并标 upsolved', () => {
    const st = buildStandings(contest, rank, { now: T + 86400000, includePractice: true });
    const row = st.rows[0];
    assert.strictEqual(row.solved, 1, '补题没算进来');
    assert.strictEqual(row.cells[0].acSeconds, 7200);
    assert.strictEqual(row.cells[0].upsolved, true, '没标成赛后补题');
    assert.strictEqual(st.includePractice, true);
  });

  ok('赛时就过了的题不会被误标成补题', () => {
    const st = buildStandings(
      contest,
      { ...rank, submissions: [[11, 0, 1, 1200], [11, 0, 1, 7200]] },
      { now: T + 86400000, includePractice: true }
    );
    assert.strictEqual(st.rows[0].cells[0].acSeconds, 1200);
    assert.strictEqual(st.rows[0].cells[0].upsolved, false, '赛时 AC 被标成补题了');
  });

  ok('榜单 HTML：含补题时有提示与 † 标记', () => {
    const st = buildStandings(contest, rank, { now: T + 86400000, includePractice: true });
    const html = renderers.renderStandingsInner(st);
    assert.ok(html.includes('赛后补题'), '没有补题横幅');
    assert.ok(html.includes('vj-st__upsolve'), '没有 † 标记');
    const plain = renderers.renderStandingsInner(buildStandings(contest, rank, { now: T + 86400000 }));
    assert.ok(!plain.includes('vj-st__upsolve'), '仅赛时不该有 †');
  });

  ok('比赛面板带补题开关和讨论区', () => {
    const c = {
      ...contest,
      title: 'T',
      begin: T,
      end: T + 3600000,
      problems: [{ index: 'A', key: 'X-1', title: 'A' }],
      url: 'https://vjudge.net/contest/1',
    };
    const on = renderers.renderContest(c, { includePractice: true, discussion, myId: '935212' });
    assert.ok(on.body.includes('data-action="standingsPractice"'));
    assert.ok(on.body.includes('data-on="1"'), '开关状态没反映到 DOM');
    assert.ok(on.body.includes('id="vj-discussion-section"'));
    const off = renderers.renderContest(c, { includePractice: false });
    assert.ok(off.body.includes('data-on="0"'));
    assert.ok(off.body.includes('仅赛时'));
  });

  ok('错误文案翻译', () => {
    assert.strictEqual(feedbackErrorText({ i18nKey: 'message.error.blocked' }), '这个会话已被拉黑，消息没有发出去');
    assert.strictEqual(feedbackErrorText({ i18nKey: 'comment.error.reply_too_deep' }), '回复层级太深，直接回复上层吧');
    assert.ok(feedbackErrorText({ i18nKey: 'message.error.weird_thing' }));
  });

  /* ------------------------------------------------------------------ */

  console.log('\n' + '='.repeat(60));
  if (failures.length) {
    console.log(`${failures.length} 项失败，${passed} 项通过`);
    for (const f of failures) console.log(' - ' + f.title + ': ' + f.err.message);
    process.exitCode = 1;
  } else {
    console.log(`全部通过（${passed} 项）`);
  }
})();
