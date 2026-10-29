'use strict';

/**
 * 比赛面板的端到端演练（不联网）：
 *   node test/contest-panel-check.js
 *
 * 覆盖用户反馈的三件事：
 *   1. 比赛面板里有「实时榜单」，能手动刷新并且会推送更新
 *   2. 从比赛面板点进题目 = 这场比赛的一道题（面板显示比赛上下文）
 *   3. 这时提交走 /contest/submit/{比赛}/{题号}，不是练习提交
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

const log = { quickPicks: [], infos: [], errors: [], panels: [], status: [] };

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
    showQuickPick: async (items) => {
      log.quickPicks.push(items);
      return items[0];
    },
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

const contestBegin = Date.now() - 30 * 60 * 1000;
const PROBLEMS = [
  { index: 'A', key: 'CodeForces-1A', title: 'A+B', oj: 'CodeForces', num: '1', probNum: '1A' },
  { index: 'B', key: 'CodeForces-1B', title: 'B', oj: 'CodeForces', num: '2', probNum: '1B' },
  { index: 'C', key: 'CodeForces-1C', title: 'C', oj: 'CodeForces', num: '3', probNum: '1C' },
];

Session.prototype.checkLogin = async () => ({ loggedIn: true, message: '已登录' });

// 比赛结束时间可按用例调整（0 = 不知道结束时间）
let contestEndAt = contestBegin + 2 * 3600 * 1000;

VJudgeClient.prototype.fetchContest = async (id) => ({
  id: String(id),
  title: '测试比赛 1000',
  begin: contestBegin,
  end: contestEndAt,
  ended: !!contestEndAt && Date.now() > contestEndAt,
  opennessLabel: '公开',
  accessLabel: '已获得访问权限',
  loggedIn: true,
  url: 'https://vjudge.net/contest/1000',
  problems: PROBLEMS,
  data: { begin: contestBegin, end: contestEndAt, penalty: 1200, sumTime: true, partialScore: false },
});

let rankCalls = 0;
VJudgeClient.prototype.fetchContestRank = async () => {
  rankCalls += 1;
  return {
    id: '1000',
    participants: {
      1: { type: 'user', name: 'alice' },
      2: { type: 'user', name: 'bob' },
    },
    submissions: [[1, 0, 1, 600], [2, 0, 1, 300]],
  };
};
VJudgeClient.prototype.myUserId = async () => '2';

VJudgeClient.prototype.fetchProblem = async (key) => ({
  key,
  title: 'A+B',
  oj: 'CodeForces',
  num: key.split('-')[1],
  data: {},
  statementHtml: '<p>体面</p>',
  url: `https://vjudge.net/problem/${key}`,
  descVersions: [],
});
VJudgeClient.prototype.problemLanguages = async () => [{ id: '54', name: 'GNU G++17 7.3.0' }];

const sent = [];
const attempts = []; // 每次真正发出去的提交（含被服务端拒绝的）
// 模拟服务端拒绝比赛提交（比赛已结束时 VJudge 就是这么回）
let rejectContestSubmit = false;
VJudgeClient.prototype.submitCode = async (options) => {
  attempts.push(options);
  if (rejectContestSubmit && options.contestId) {
    rejectContestSubmit = false;
    const err = new Error('比赛已经结束，不能提交');
    err.i18nKey = 'submit.error.contest_ended';
    throw err;
  }
  sent.push(options);
  return { runId: 700 + sent.length, url: `https://vjudge.net/solution/${700 + sent.length}` };
};
VJudgeClient.prototype.waitForVerdict = async (runId) => ({
  runId,
  statusType: 1,
  status: 'Accepted',
  runtime: 10,
  memory: 256,
  language: 'GNU G++17',
});

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

function pass(name, ok, extra) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || extra === undefined ? '' : ` -> ${extra}`}`);
  if (!ok) process.exitCode = 1;
}

/** 等面板消息处理完（webview 回调是异步的） */
function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function panelOf(kind) {
  return log.panels.filter((p) => p.viewType === `vjudgeHelper.${kind}`).slice(-1)[0];
}

async function main() {
  await extension.activate(context);

  const document = {
    fileName: 'D:/work/a.cpp',
    languageId: 'cpp',
    isClosed: false,
    uri: { fsPath: 'D:/work/a.cpp' },
    getText: () => '#include <cstdio>\nint main(){}',
  };
  fakeVscode.window.activeTextEditor = { document };

  console.log('\n[1] 打开比赛面板（应自带榜单）');
  fakeVscode.__inputs = ['1000'];
  await fakeVscode.__commands.get('vjudgeHelper.openContest')();

  const contestPanel = panelOf('contest');
  pass('创建了比赛面板', !!contestPanel);
  pass('首次就拉了榜单', rankCalls >= 1, rankCalls);
  pass('HTML 里有榜单容器', /id="vj-standings-inner"/.test(contestPanel.webview.html));
  pass('榜单里有 alice / bob', /alice/.test(contestPanel.webview.html) && /bob/.test(contestPanel.webview.html));
  pass('题号列表也在', /CodeForces-1A/.test(contestPanel.webview.html));
  pass('自己那一行高亮（my id = 2）', /is-me/.test(contestPanel.webview.html));
  pass('有自动刷新提示', /每 5 秒自动刷新/.test(contestPanel.webview.html));

  console.log('\n[2] 点「刷新榜单」：只推送局部 HTML，不重载整页');
  const callsBefore = rankCalls;
  await contestPanel.receive({ type: 'action', action: 'rankRefresh' });
  await tick();
  const push = contestPanel.messages.filter((m) => m.type === 'standings').slice(-1)[0];
  pass('又拉了一次榜单', rankCalls === callsBefore + 1, rankCalls);
  pass('推送了 standings 消息', !!push);
  pass('推送内容是表格片段（不含 <html>）', !!push && /vj-st__row/.test(push.html) && !/<html/i.test(push.html));
  pass('带上了更新时间', !!push && !!push.updatedAt);

  console.log('\n[3] 在比赛面板里点题目：应该打开「这场比赛的那道题」');
  await contestPanel.receive({ type: 'openProblem', key: 'CodeForces-1B' });
  await tick();
  const problemPanel = panelOf('problem');
  pass('打开了题面面板', !!problemPanel);
  pass('面板写明比赛 #1000 · B 题', /#1000/.test(problemPanel.webview.html) && /B 题/.test(problemPanel.webview.html));
  pass('按钮是「提交到比赛 B」', /提交到比赛/.test(problemPanel.webview.html));
  pass('有「返回比赛」按钮', /data-action="contest"/.test(problemPanel.webview.html));
  pass(
    '持久化了比赛上下文',
    (context.globalState.store.get('vjudge.lastProblem') || {}).contestId === '1000',
    JSON.stringify(context.globalState.store.get('vjudge.lastProblem'))
  );

  console.log('\n[4] 这时按快捷键提交：必须走比赛接口');
  await fakeVscode.__commands.get('vjudgeHelper.submitCode')();
  await tick();
  pass('提交带 contestId', sent[0] && sent[0].contestId === '1000', sent[0] && sent[0].contestId);
  pass('提交带题号 B', sent[0] && sent[0].problemNum === 'B', sent[0] && sent[0].problemNum);
  pass(
    '没有弹「提交到哪道题」',
    log.quickPicks.every((items) => !items.some((item) => /输入题号/.test(String(item.label)))),
    log.quickPicks.length
  );
  pass('通知里写清了是比赛题', log.infos.some((m) => /比赛 #1000/.test(m)), JSON.stringify(log.infos));

  console.log('\n[5] 交完之后榜单会被顺手刷新一次');
  const callsAfterSubmit = rankCalls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  pass('提交后触发了榜单刷新', rankCalls >= callsAfterSubmit, `${callsAfterSubmit} -> ${rankCalls}`);

  console.log('\n[6] 比赛结束后点进题目：仍然走比赛通道（网页上赛后也能交，记在这场比赛下）');
  contestEndAt = Date.now() - 60 * 1000; // 比赛已经结束
  fakeVscode.__inputs = ['1000'];
  await fakeVscode.__commands.get('vjudgeHelper.openContest')();
  await tick();
  const overduePanel = panelOf('contest');
  pass('比赛面板写明已结束', /已结束/.test(overduePanel.webview.html));
  pass('比赛面板提示还能继续交', /还能继续交/.test(overduePanel.webview.html));

  await overduePanel.receive({ type: 'openProblem', key: 'CodeForces-1C' });
  await tick();
  const practicePanel = panelOf('problem');
  pass('题面面板标出比赛已结束', /已结束/.test(practicePanel.webview.html));
  pass('按钮仍然是「提交到比赛 …」', /提交到比赛/.test(practicePanel.webview.html), 'button missing');
  pass('还留着「返回比赛」', /data-action="contest"/.test(practicePanel.webview.html));

  const sentBefore = sent.length;
  await fakeVscode.__commands.get('vjudgeHelper.submitCode')();
  await tick();
  pass('赛后提交仍带 contestId', sent[sentBefore] && sent[sentBefore].contestId === '1000', sent[sentBefore] && sent[sentBefore].contestId);
  pass('赛后提交仍带题号', !!sent[sentBefore] && !!sent[sentBefore].problemNum, sent[sentBefore] && sent[sentBefore].problemNum);
  pass(
    '提示说明了不计入榜单',
    log.status.some((m) => /不计入榜单/.test(m)) || log.infos.some((m) => /不计入榜单/.test(m)),
    JSON.stringify(log.status.slice(-3))
  );

  console.log('\n[7] 不知道结束时间时：服务端说「比赛已结束」，要自动重试成补题');
  contestEndAt = 0; // 结束时间未知（旧记忆 / 从别处进来）
  fakeVscode.__inputs = ['1000'];
  await fakeVscode.__commands.get('vjudgeHelper.openContest')();
  await tick();
  const unknownPanel = panelOf('contest');
  await unknownPanel.receive({ type: 'openProblem', key: 'CodeForces-1A' });
  await tick();

  const beforeFallback = sent.length;
  rejectContestSubmit = true;
  await fakeVscode.__commands.get('vjudgeHelper.submitCode')();
  await tick();
  pass(
    '第一次仍按比赛接口提交（被服务端拒绝）',
    attempts[attempts.length - 2] && attempts[attempts.length - 2].contestId === '1000',
    JSON.stringify(attempts.slice(-2).map((a) => a.contestId || '(练习)'))
  );
  pass('拒绝了之后又提交了一次', sent.length === beforeFallback + 1, `${beforeFallback} -> ${sent.length}`);
  pass(
    '重试那次是练习提交',
    sent[beforeFallback] && !sent[beforeFallback].contestId && !sent[beforeFallback].problemNum,
    JSON.stringify(sent[beforeFallback] && { c: sent[beforeFallback].contestId, n: sent[beforeFallback].problemNum })
  );
  pass(
    '提示里说明了改成练习通道（并给出被拒原因）',
    log.status.some((m) => /改成练习通道/.test(m) && /比赛已经结束/.test(m)),
    JSON.stringify(log.status.slice(-3))
  );

  extension.deactivate();
  console.log('\n演练结束');
}

main().catch((err) => {
  console.error('演练失败:', err);
  process.exitCode = 1;
});
