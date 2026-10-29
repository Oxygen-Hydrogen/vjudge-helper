'use strict';

/**
 * 提交记录（/status/data + /solution/data）的离线自检。
 *
 * 全程不联网：
 *   - HTTP 层把 `src/http` 的 request 换成桩（vjudge.js 在加载时就解构了它，
 *     所以必须先打桩、再 require vjudge，顺序不能反）
 *   - /status/data 的返回结构是 2026-10 抓的真实字段
 *   - 代码图片用一张 1x1 PNG 的字节冒充
 *
 * 跑法：node test/status-check.js
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// vscode 模块在 Node 里不存在，按需打桩
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

/* ------------------------------------------------------------------ */
/* HTTP 桩                                                             */
/* ------------------------------------------------------------------ */

const httpLib = require(path.join(ROOT, 'src', 'http'));

/** 每次调用记下 {url, options}，按 handler 返回 */
const calls = [];
let handler = null;

httpLib.request = async function stubRequest(url, options = {}) {
  calls.push({ url, options });
  if (!handler) throw new Error('测试没有设置 handler：' + url);
  return handler(url, options);
};

const {
  VJudgeClient,
  normalizeSubmissionRow,
  submissionResultKind,
} = require(path.join(ROOT, 'src', 'vjudge'));
const renderers = require(path.join(ROOT, 'src', 'webview', 'renderers'));

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

async function okAsync(title, fn) {
  try {
    await fn();
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

function makeClient() {
  return new VJudgeClient({
    baseUrl: 'https://vjudge.net',
    jar: null,
    timeout: 5000,
    hasCredentials: true,
  });
}

/** /status/data 的一行（真实字段，取自 2026-10 的返回） */
function rawRow(overrides = {}) {
  return {
    memory: 1064,
    access: 2,
    statusType: 0,
    avatarUrl: 'https://cn.cravatar.com/avatar/x?d=retro',
    runtime: 32,
    language: 'C++ 17',
    userName: 'sddz1212',
    userId: 1328770,
    languageCanonical: 'CPP',
    processing: false,
    runId: 73809282,
    time: 1793259769000,
    oj: '洛谷',
    problemId: 4081958,
    sourceLength: 443,
    probNum: 'B3720',
    status: 'Accepted',
    ...overrides,
  };
}

function jsonResponse(payload) {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AHAAUBAAFJtWnZAAAAAElFTkSuQmCC',
  'base64'
);

/* ------------------------------------------------------------------ */

(async () => {
  console.log('提交记录自检\n');

  /* ---------------------- 行归一化 / 结果分类 ---------------------- */

  ok('normalizeSubmissionRow 把字段折成内部结构', () => {
    const row = normalizeSubmissionRow(rawRow({ contestId: 863131, contestNum: 'B', contestOpenness: 0 }));
    assert.strictEqual(row.runId, '73809282');
    assert.strictEqual(row.userName, 'sddz1212');
    assert.strictEqual(row.oj, '洛谷');
    assert.strictEqual(row.probNum, 'B3720');
    assert.strictEqual(row.problemKey, '洛谷-B3720');
    assert.strictEqual(row.contestId, '863131');
    assert.strictEqual(row.contestNum, 'B');
    assert.strictEqual(row.length, 443);
    assert.strictEqual(row.language, 'C++ 17');
    assert.strictEqual(row.runtime, 32);
    assert.strictEqual(row.memory, 1064);
    assert.strictEqual(row.time, 1793259769000);
  });

  ok('缺字段不炸（空对象也能归一化）', () => {
    const row = normalizeSubmissionRow({});
    assert.strictEqual(row.runId, '');
    assert.strictEqual(row.problemKey, '');
    assert.strictEqual(row.status, '');
    assert.strictEqual(normalizeSubmissionRow(null).runId, '');
  });

  ok('submissionResultKind 区分通过 / 失败 / 判题中', () => {
    assert.strictEqual(submissionResultKind({ statusType: 1, status: 'Accepted' }), 'accepted');
    assert.strictEqual(submissionResultKind({ statusType: 2, status: 'Wrong Answer' }), 'failed');
    assert.strictEqual(submissionResultKind({ status: 'Accepted' }), 'accepted');
    assert.strictEqual(submissionResultKind({ status: 'Running', processing: true }), 'pending');
    assert.strictEqual(submissionResultKind({ status: 'Compiling' }), 'pending');
    assert.strictEqual(submissionResultKind({}), 'pending');
  });

  /* ---------------------- /status/data ---------------------- */

  await okAsync('fetchSubmissionList 拼对查询参数', async () => {
    calls.length = 0;
    handler = () => jsonResponse({ data: [rawRow()], recordsTotal: 9999999 });
    const client = makeClient();
    await client.fetchSubmissionList({
      user: 'sddz1212',
      oj: 'CodeForces',
      probNum: '1A',
      res: 'AC',
      start: 40,
      length: 20,
    });

    const url = calls[calls.length - 1].url;
    const q = new URL(url).searchParams;
    assert.strictEqual(q.get('un'), 'sddz1212');
    assert.strictEqual(q.get('OJId'), 'CodeForces');
    assert.strictEqual(q.get('probNum'), '1A');
    assert.strictEqual(q.get('res'), 'AC');
    assert.strictEqual(q.get('start'), '40');
    assert.strictEqual(q.get('length'), '20');
    assert.strictEqual(q.get('onlyFollowee'), 'false');
    assert.ok(url.startsWith('https://vjudge.net/status/data?'), url);
  });

  await okAsync('不带筛选时 OJId=All、res=all', async () => {
    calls.length = 0;
    handler = () => jsonResponse({ data: [] });
    const client = makeClient();
    await client.fetchSubmissionList({});
    const q = new URL(calls[calls.length - 1].url).searchParams;
    assert.strictEqual(q.get('OJId'), 'All');
    assert.strictEqual(q.get('res'), 'all');
    assert.strictEqual(q.get('un'), '');
    assert.strictEqual(q.get('start'), '0');
    assert.strictEqual(q.get('length'), '20');
  });

  await okAsync('满页 → hasMore=true，并归一化每一行', async () => {
    handler = () =>
      jsonResponse({
        data: [rawRow(), rawRow({ runId: 2, status: 'Wrong Answer', statusType: 2 })],
      });
    const client = makeClient();
    const page = await client.fetchSubmissionList({ length: 2 });
    assert.strictEqual(page.rows.length, 2);
    assert.strictEqual(page.hasMore, true);
    assert.strictEqual(page.rows[0].problemKey, '洛谷-B3720');
    assert.strictEqual(page.rows[1].runId, '2');
  });

  await okAsync('不满页 → hasMore=false（recordsTotal 是假的 9999999）', async () => {
    handler = () => jsonResponse({ data: [rawRow()], recordsTotal: 9999999 });
    const client = makeClient();
    const page = await client.fetchSubmissionList({ length: 20 });
    assert.strictEqual(page.hasMore, false);
    assert.strictEqual(page.rows.length, 1);
  });

  await okAsync('接口回了非 JSON 时给可读报错', async () => {
    handler = () => ({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad gateway</html>' });
    const client = makeClient();
    let err = null;
    try {
      await client.fetchSubmissionList({});
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应该抛错');
    assert.ok(/502/.test(err.message), err.message);
  });

  /* ---------------------- /solution/data ---------------------- */

  await okAsync('自己的提交：code 文本走 kind=code', async () => {
    calls.length = 0;
    handler = () =>
      jsonResponse({
        runId: 73809282,
        author: 'HydrogenOxygen',
        status: 'Accepted',
        language: 'C++ 17',
        prismClass: 'cpp',
        length: 21,
        code: '#include <cstdio>\nint main(){}\n',
      });
    const client = makeClient();
    const got = await client.fetchSubmissionCode('73809282');
    assert.strictEqual(got.kind, 'code');
    assert.ok(got.code.includes('#include'), got.code);
    // showCode 必须是 true，否则服务端不回代码
    const body = calls[calls.length - 1].options.body;
    assert.strictEqual(body, 'showCode=true');
    assert.ok(calls[calls.length - 1].url.endsWith('/solution/data/73809282'));
  });

  await okAsync('别人的提交：codeImgUrl 相对路径补成绝对地址', async () => {
    handler = () =>
      jsonResponse({
        runId: 9,
        author: 'someone',
        codeImgUrl: '/solution/9/image?t=123',
      });
    const client = makeClient();
    const got = await client.fetchSubmissionCode(9);
    assert.strictEqual(got.kind, 'image');
    assert.strictEqual(got.url, 'https://vjudge.net/solution/9/image?t=123');
  });

  await okAsync('没权限：codeAccessInfo 翻成中文提示', async () => {
    handler = () =>
      jsonResponse({
        runId: 9,
        codeAccessInfo: { i18nKey: 'solution.error.code_login_required', trustable: false },
      });
    const client = makeClient();
    const got = await client.fetchSubmissionCode(9);
    assert.strictEqual(got.kind, 'denied');
    assert.ok(got.message.includes('登录'), got.message);
  });

  await okAsync('既没 code 也没图 → kind=none', async () => {
    handler = () => jsonResponse({ runId: 9, status: 'Accepted' });
    const client = makeClient();
    const got = await client.fetchSubmissionCode(9);
    assert.strictEqual(got.kind, 'none');
  });

  /* ---------------------- 代码图片 ---------------------- */

  await okAsync('fetchCodeImage 把图片转成 data URI', async () => {
    calls.length = 0;
    handler = () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG_BYTES });
    const client = makeClient();
    const img = await client.fetchCodeImage('/solution/9/image');
    assert.ok(img.dataUri.startsWith('data:image/png;base64,'), img.dataUri.slice(0, 40));
    assert.strictEqual(img.mime, 'image/png');
    // binary:true 才能拿到原始字节，否则 base64 会先把二进制解坏
    assert.strictEqual(calls[calls.length - 1].options.binary, true);
    assert.ok(img.bytes > 60, String(img.bytes));
  });

  await okAsync('图片还在生成（先 404）→ 重试后拿到', async () => {
    let n = 0;
    handler = () => {
      n += 1;
      if (n === 1) return { status: 404, headers: { 'content-type': 'text/html' }, body: 'not yet' };
      return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG_BYTES };
    };
    const client = makeClient();
    const img = await client.fetchCodeImage('https://vjudge.net/solution/9/image', { tries: 3, waitMs: 10 });
    assert.ok(img.dataUri.startsWith('data:image/png;base64,'));
    assert.strictEqual(n, 2);
  });

  await okAsync('一直拿不到图 → 报错里带状态码并提示重试', async () => {
    handler = () => ({ status: 404, headers: { 'content-type': 'text/html' }, body: 'nope' });
    const client = makeClient();
    let err = null;
    try {
      await client.fetchCodeImage('/solution/9/image', { tries: 2, waitMs: 5 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应该抛错');
    assert.ok(/404/.test(err.message), err.message);
    assert.ok(/重新获取/.test(err.message), err.message);
  });

  /* ---------------------- 自己的用户名 ---------------------- */

  await okAsync('myUsername 从 /message 页读 visitor_username', async () => {
    handler = () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<input id="visitor_username" name="username" type="hidden" value="HydrogenOxygen">',
    });
    const client = makeClient();
    const name = await client.myUsername();
    assert.strictEqual(name, 'HydrogenOxygen');
    // 第二次直接走缓存，不再发请求
    calls.length = 0;
    assert.strictEqual(await client.myUsername(), 'HydrogenOxygen');
    assert.strictEqual(calls.length, 0);
  });

  await okAsync('没登录时 myUsername 抛 LOGIN_REQUIRED', async () => {
    handler = () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>login</html>' });
    const client = makeClient();
    let err = null;
    try {
      await client.myUsername();
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.code, 'LOGIN_REQUIRED');
  });

  /* ---------------------- 渲染 ---------------------- */

  const rows = [
    normalizeSubmissionRow(rawRow({ contestId: 863131, contestNum: 'B' })),
    normalizeSubmissionRow(
      rawRow({ runId: 2, userName: 'HydrogenOxygen', status: 'Wrong Answer', statusType: 2, runtime: 0 })
    ),
  ];

  ok('列表渲染：表头 / 行 / 题目链接 / 比赛标记', () => {
    const html = renderers.renderSubmissionsBody({
      me: 'HydrogenOxygen',
      scope: 'all',
      rows,
      hasMore: false,
      loaded: true,
    });
    for (const th of ['时间', '用户', '题目', '结果', '用时', '内存', '语言', '长度']) {
      assert.ok(html.includes(th), '缺少表头 ' + th);
    }
    assert.ok(html.includes('vjudge-problem:%E6%B4%9B%E8%B0%B7-B3720'), '题目链接不对');
    assert.ok(html.includes('vjudge-user:sddz1212'), '用户名应该是可点的');
    assert.ok(html.includes('data-run="73809282"'), '行上要带 runId');
    assert.ok(html.includes('vjudge-contest:863131'), '比赛标记丢了');
    assert.ok(html.includes('is-fail'), '未通过的行要带 is-fail');
    assert.ok(html.includes('is-me'), '自己的行要带 is-me');
    assert.ok(html.includes('已经到底了'), '到底了要给提示');
  });

  ok('列表渲染：还有下一页时出现「加载更多」', () => {
    const html = renderers.renderSubmissionsBody({ rows, hasMore: true, loaded: true, me: '' });
    assert.ok(html.includes('subMore'), '缺少加载更多按钮');
    assert.ok(html.includes('已 2 条'), html.slice(-200));
  });

  ok('列表渲染：空结果显示提示，错误结果给空状态', () => {
    const empty = renderers.renderSubmissionsBody({ rows: [], loaded: true, me: 'x' });
    assert.ok(empty.includes('没有符合条件的提交'), empty);
    const bad = renderers.renderSubmissionsBody({ rows: [], loaded: true, error: '需要登录', me: 'x' });
    assert.ok(bad.includes('提交记录打不开'), bad);
    assert.ok(bad.includes('需要登录'), bad);
  });

  ok('详情渲染：代码走高亮，且带复制按钮', () => {
    const html = renderers.renderSubmissionDetail(
      {
        kind: 'code',
        code: '#include <cstdio>\nint main() { return 0; }\n',
        language: 'C++ 17',
        row: rows[0],
      },
      { me: 'sddz1212' }
    );
    assert.ok(html.includes('vj-subd__pre'), html.slice(0, 200));
    assert.ok(html.includes('vj-lang-cpp'), 'C++ 17 应该认成 cpp');
    assert.ok(/vj-tok-(kw|pre)/.test(html), '代码没有被染色');
    assert.ok(html.includes('data-action="copy"'), '缺少复制按钮');
    assert.ok(html.includes('3 行'), html);
    assert.ok(html.includes('返回列表'), '缺少返回按钮');
  });

  ok('详情渲染：图片走 <img src="data:...">', () => {
    const html = renderers.renderSubmissionDetail({
      kind: 'image',
      dataUri: 'data:image/png;base64,AAAA',
      row: rows[1],
    });
    assert.ok(html.includes('<img class="vj-subd__img" src="data:image/png;base64,AAAA"'), html.slice(0, 400));
    assert.ok(html.includes('只给这张图'), '应该说明「VJudge 只给图片」');
  });

  ok('详情渲染：没权限时显示原因', () => {
    const html = renderers.renderSubmissionDetail({
      kind: 'denied',
      message: '看提交详情要先登录 VJudge',
      row: rows[0],
    });
    assert.ok(html.includes('看不到这份代码'), html);
    assert.ok(html.includes('要先登录'), html);
  });

  ok('详情渲染：出错时给「重新获取」', () => {
    const html = renderers.renderSubmissionDetail({ row: rows[0], error: '拿不到代码图片（404）' });
    assert.ok(html.includes('subRetry'), html);
    assert.ok(html.includes('代码没取到'), html);
  });

  ok('整页渲染：范围 / 头部按钮 / 筛选条件', () => {
    const view = renderers.renderSubmissions({
      scope: 'mine',
      me: 'HydrogenOxygen',
      rows,
      loaded: true,
      hasMore: true,
      problemKey: '洛谷-B3720',
      res: 'AC',
      url: 'https://vjudge.net/status',
    });
    assert.strictEqual(view.title, 'VJudge 提交记录');
    assert.strictEqual(view.subtitle, '我的提交');
    assert.ok(view.body.includes('id="vj-sub-inner"'), '缺少可替换容器');
    assert.ok(view.body.includes('data-action="subScope"'), '缺少范围切换');
    assert.ok(view.body.includes('data-action="subResult"'), '缺少结果筛选');
    assert.ok(view.body.includes('只看通过'), '筛选条件没显示出来');
    assert.ok(view.meta.some((m) => m.label === '登录为' && m.value === 'HydrogenOxygen'), '头部没显示登录用户');
    assert.ok(view.actions.some((a) => a.id === 'subRefresh'), '缺少刷新按钮');
  });

  /* ---------------------- 汇总 ---------------------- */

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} 项未通过：`);
    for (const f of failures) console.log('  - ' + f.title + '：' + f.err.message);
    process.exit(1);
  }
  console.log(`全部通过（${passed} 项）。`);
})();
