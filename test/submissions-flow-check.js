'use strict';

/**
 * 提交记录面板的端到端演练（不联网）：
 *   node test/submissions-flow-check.js
 *
 * 覆盖：
 *   1. 一条命令能打开面板，默认「我的」，头部显示登录用户名
 *   2. 切「全部」/「只看通过」会带着新条件重新拉
 *   3. 点一行 → 自己的提交给源码（带高亮），别人的给图片（data URI）
 *   4. 「加载更多」按已加载条数翻页，只推送列表片段
 *   5. 没登录时自动退成「全部」，不弹一堆错
 */

const Module = require('module');
const path = require('path');

const DEFAULTS = {
  baseUrl: 'https://vjudge.net',
  openIn: 'panel',
  enableMathJax: false,
  contestPageSize: 10,
  showStatusBar: false,
  requestTimeout: 30000,
  autoRefreshContests: false,
  submitOpen: false,
  submitConfirm: false,
  judgeTimeout: 30,
  standingsInterval: 5,
  cdnBaseUrl: '',
};

const log = { infos: [], errors: [], panels: [], status: [] };

class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {}
}

const fakeVscode = {
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}` }),
    parse: (p) => ({ fsPath: p, scheme: 'https', path: p, toString: () => p }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), scheme: 'file' }),
  },
  __commands: new Map(),
  commands: {
    registerCommand: (id, fn) => {
      fakeVscode.__commands.set(id, fn);
      return { dispose: () => {} };
    },
    executeCommand: async (id, ...args) => {
      const fn = fakeVscode.__commands.get(id);
      if (fn) return fn(...args);
      return undefined;
    },
  },
  window: {
    createTreeView: () => ({ dispose: () => {}, title: '' }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      visible: false,
      show() {},
      hide() {},
      dispose() {},
    }),
    createWebviewPanel: (viewType, title) => {
      const panel = {
        viewType,
        title,
        visible: true,
        messages: [],
        webview: {
          html: '',
          cspSource: 'vscode-webview://test',
          asWebviewUri: (uri) => uri,
          onDidReceiveMessage: (cb) => {
            panel.receive = cb;
            return { dispose: () => {} };
          },
          postMessage: async (msg) => {
            panel.messages.push(msg);
            return true;
          },
        },
        reveal() {},
        onDidDispose: () => ({ dispose: () => {} }),
        dispose() {},
      };
      log.panels.push(panel);
      return panel;
    },
    withProgress: async (options, task) =>
      task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    showQuickPick: async (items) => items[0],
    showInputBox: async () => (fakeVscode.__inputs || []).shift(),
    showInformationMessage: async (message) => {
      log.infos.push(message);
      return undefined;
    },
    showWarningMessage: async () => undefined,
    showErrorMessage: async (message) => {
      log.errors.push(message);
      return undefined;
    },
    setStatusBarMessage: (message) => {
      log.status.push(String(message));
      return { dispose() {} };
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key) => DEFAULTS[key],
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  env: {
    openExternal: async () => true,
    clipboard: { readText: async () => '', writeText: async () => undefined },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

/* --------------------------- 打桩数据 --------------------------- */

const { VJudgeClient } = require('../src/vjudge');
const { Session } = require('../src/session');

Session.prototype.checkLogin = async () => ({ loggedIn: true, message: '已登录' });

function stubRow(overrides = {}) {
  return {
    runId: '9001',
    userName: 'HydrogenOxygen',
    userId: '935212',
    avatarUrl: '',
    oj: 'CodeForces',
    probNum: '1A',
    problemKey: 'CodeForces-1A',
    contestId: '',
    contestNum: '',
    contestOpenness: 0,
    status: 'Accepted',
    statusType: 0,
    processing: false,
    runtime: 15,
    memory: 256,
    language: 'C++ 17',
    languageCanonical: 'CPP',
    length: 42,
    time: Date.now() - 60000,
    ...overrides,
  };
}

let loggedIn = true;
let listCalls = [];
let listRows = [];

VJudgeClient.prototype.myUsername = async function myUsername() {
  if (!loggedIn) {
    const err = new Error('要只看自己的提交，得先登录 VJudge');
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }
  return 'HydrogenOxygen';
};

VJudgeClient.prototype.fetchSubmissionList = async function fetchSubmissionList(options = {}) {
  listCalls.push({ ...options });
  const start = Number(options.start) || 0;
  const length = Number(options.length) || 20;
  const slice = listRows.slice(start, start + length);
  return { rows: slice, start, length, hasMore: slice.length >= length, url: 'https://vjudge.net/status', raw: {} };
};

VJudgeClient.prototype.fetchSubmissionCode = async function fetchSubmissionCode(runId) {
  if (String(runId) === '9001') {
    return {
      kind: 'code',
      code: '#include <cstdio>\nint main() { return 0; }\n',
      language: 'C++ 17',
      prismClass: 'cpp',
      detail: { runId: '9001', author: 'HydrogenOxygen', status: 'Accepted', length: 42 },
    };
  }
  if (String(runId) === '9002') {
    return { kind: 'image', url: 'https://vjudge.net/solution/9002/image', detail: { runId: '9002', author: 'tourist' } };
  }
  return {
    kind: 'denied',
    message: '看提交详情要先登录 VJudge',
    detail: { runId: String(runId) },
  };
};

VJudgeClient.prototype.fetchCodeImage = async function fetchCodeImage() {
  return { dataUri: 'data:image/png;base64,AAAA', mime: 'image/png', bytes: 100, url: '' };
};

/* ------------------------------- 运行 ------------------------------- */

const extension = require('../extension');

const context = {
  subscriptions: [],
  extensionUri: fakeVscode.Uri.file(path.join(__dirname, '..')),
  globalState: {
    store: new Map(),
    get(key) {
      return this.store.get(key);
    },
    async update(key, value) {
      this.store.set(key, value);
    },
  },
  secrets: {
    store: new Map(),
    async get(key) {
      return this.store.get(key);
    },
    async store(key, value) {
      this.store.set(key, value);
    },
    async delete(key) {
      this.store.delete(key);
    },
  },
};

let failed = 0;
function pass(name, ok, extra) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || extra === undefined ? '' : ` -> ${extra}`}`);
  if (!ok) failed += 1;
}

function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function panelOf(kind) {
  return log.panels.filter((p) => p.viewType === `vjudgeHelper.${kind}`).slice(-1)[0];
}

function lastPush(panel) {
  return panel.messages.filter((m) => m.type === 'submissionView').slice(-1)[0];
}

/** 取出某个 data-scope 的按钮标签，看它有没有 is-on */
function tabOn(html, scope) {
  const m = html.match(new RegExp(`<button[^>]*data-scope="${scope}"[^>]*>`));
  return !!m && /is-on/.test(m[0]);
}

async function main() {
  await extension.activate(context);

  listRows = [
    stubRow(),
    stubRow({ runId: '9002', userName: 'tourist', memory: 0, runtime: 46 }),
    stubRow({ runId: '9003', userName: 'sddz1212', oj: '洛谷', probNum: 'B3720', problemKey: '洛谷-B3720', contestId: '863131', contestNum: 'B' }),
  ];

  console.log('\n[1] 「我的提交记录」能打开面板');
  listCalls = [];
  await fakeVscode.__commands.get('vjudgeHelper.mySubmissions')();
  const panel = panelOf('submissions');
  pass('创建了提交面板', !!panel);
  pass('默认按我的用户名查', listCalls[0] && listCalls[0].user === 'HydrogenOxygen', JSON.stringify(listCalls[0]));
  pass('HTML 里有可替换容器', /id="vj-sub-inner"/.test(panel.webview.html));
  pass('头部显示登录用户', /登录为/.test(panel.webview.html) && /HydrogenOxygen/.test(panel.webview.html));
  pass('「我的」是高亮的', tabOn(panel.webview.html, 'mine'));
  pass('三行都在', (panel.webview.html.match(/class="vj-sub /g) || []).length === 3);
  pass('比赛标记没丢', /vjudge-contest:863131/.test(panel.webview.html));

  console.log('\n[2] 切「全部」→ 带空用户名重新查');
  listCalls = [];
  await panel.receive({ type: 'subScope', scope: 'all' });
  await tick();
  pass('又重新拉了一次', listCalls.length === 1, listCalls.length);
  pass('un 变成空 = 全站', listCalls[0].user === '', JSON.stringify(listCalls[0].user));
  pass('新页面里「全部」高亮', tabOn(panel.webview.html, 'all'));

  console.log('\n[3] 只看通过 → res=AC');
  listCalls = [];
  await panel.receive({ type: 'subResult', res: 'AC' });
  await tick();
  pass('res 传成 AC', listCalls[0] && listCalls[0].res === 'AC', JSON.stringify(listCalls[0]));

  console.log('\n[4] 点自己的提交 → 源码 + 高亮');
  await panel.receive({ type: 'subOpen', runId: '9001' });
  await tick();
  const codePush = lastPush(panel);
  pass('推了 submissionView', !!codePush);
  pass('有代码块', !!codePush && /vj-subd__pre/.test(codePush.html));
  pass('代码被染色', !!codePush && /vj-tok-(kw|pre)/.test(codePush.html));
  pass('有复制按钮', !!codePush && /data-action="copy"/.test(codePush.html));

  console.log('\n[5] 点别人的提交 → 图片');
  await panel.receive({ type: 'subOpen', runId: '9002' });
  await tick();
  const imgPush = lastPush(panel);
  pass('推了图片视图', !!imgPush && /<img class="vj-subd__img" src="data:image\/png;base64,AAAA"/.test(imgPush.html));

  console.log('\n[6] 返回列表');
  await panel.receive({ type: 'action', action: 'subBack' });
  await tick();
  const backPush = lastPush(panel);
  pass('回到列表（又出现表格）', !!backPush && /vj-subs__tbl/.test(backPush.html));
  pass('没有整页重载（仍是一段 HTML）', !!backPush && !/<html/i.test(backPush.html));

  console.log('\n[7] 加载更多按已加载条数翻页');
  listRows = [];
  for (let i = 0; i < 25; i += 1) listRows.push(stubRow({ runId: String(9100 + i) }));
  listCalls = [];
  await fakeVscode.__commands.get('vjudgeHelper.submissions')();
  pass('第一次 20 条', (listCalls[0].length = listCalls[0].length || 20) === 20);
  listCalls = [];
  await panel.receive({ type: 'subMore' });
  await tick();
  pass('第二次 start=20', listCalls[0] && listCalls[0].start === 20, JSON.stringify(listCalls[0] && listCalls[0].start));
  const morePush = lastPush(panel);
  pass('推送里 25 行', !!morePush && (morePush.html.match(/class="vj-sub /g) || []).length === 25);

  console.log('\n[8] 没登录：「我的」自动退成「全部」');
  loggedIn = false;
  listCalls = [];
  await fakeVscode.__commands.get('vjudgeHelper.mySubmissions')();
  tick(10);
  pass('查询没带用户名（退成全站）', listCalls[0] && listCalls[0].user === '', JSON.stringify(listCalls[0] && listCalls[0].user));
  pass('状态栏说明了原因', log.status.some((s) => /登录/.test(s)));
  pass('面板没崩，还是能看列表', /vj-subs__tbl|没有符合条件的提交/.test(panel.webview.html));

  console.log('');
  if (failed) {
    console.log(`✗ ${failed} 项未通过`);
    process.exit(1);
  }
  console.log('全部通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
