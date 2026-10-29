'use strict';

/**
 * 提交流程的端到端演练（不联网、不产生真实提交）：
 *   node test/submit-flow-check.js
 *
 * 用假的 vscode API + 打桩的 VJudgeClient 跑一遍「一键提交」：
 *   第一次：没有语言记忆 -> 弹一次语言列表 -> 提交 -> 轮询 -> Accepted
 *   第二次：语言已记住且与 .cpp 同族 -> 不再弹列表（这就是「一键」）
 */

const Module = require('module');
const path = require('path');

/* ------------------------------ 假的 vscode ------------------------------ */

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

const DEFAULTS = {
  baseUrl: 'https://vjudge.net',
  username: 'tester',
  cookie: '',
  openIn: 'panel',
  enableMathJax: true,
  contestPageSize: 10,
  showStatusBar: true,
  requestTimeout: 30000,
  autoRefreshContests: false,
  submitOpen: false,
  submitConfirm: false,
  judgeTimeout: 30,
  cdnBaseUrl: '',
};

/** 记录所有交互，最后统一断言 */
const log = {
  quickPicks: [],
  inputs: [],
  infos: [],
  warnings: [],
  errors: [],
  statusItems: [],
  commandCalls: [],
};

const fakeVscode = {
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}` }),
    parse: (p) => ({ fsPath: p, scheme: 'https', path: p, toString: () => p }),
    joinPath: (base, ...parts) => {
      const joined = path.join(base.fsPath, ...parts);
      return { fsPath: joined, scheme: 'file', path: joined };
    },
  },
  commands: {
    registerCommand: (id, fn) => {
      fakeVscode.__commands.set(id, fn);
      return { dispose: () => {} };
    },
    executeCommand: async (id, ...args) => {
      log.commandCalls.push({ id, args });
      const fn = fakeVscode.__commands.get(id);
      if (fn) return fn(...args);
      return undefined;
    },
  },
  __commands: new Map(),
  window: {
    createTreeView: () => ({ dispose: () => {}, title: '' }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => {
      const item = {
        text: '',
        tooltip: '',
        command: undefined,
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {},
      };
      log.statusItems.push(item);
      return item;
    },
    createWebviewPanel: () => ({
      title: '',
      webview: {
        html: '',
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri) => uri,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: async () => true,
      },
      reveal() {},
      onDidDispose: () => ({ dispose: () => {} }),
      dispose() {},
    }),
    withProgress: async (options, task) =>
      task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    showQuickPick: async (items, options) => {
      log.quickPicks.push({ items, options });
      return items[0];
    },
    showInputBox: async (options) => {
      log.inputs.push(options);
      const queue = fakeVscode.__inputs || [];
      if (queue.length) return queue.shift();
      return 'CodeForces-1A';
    },
    showInformationMessage: async (message) => {
      log.infos.push(message);
      return undefined;
    },
    showWarningMessage: async (message) => {
      log.warnings.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      log.errors.push(message);
      return undefined;
    },
    setStatusBarMessage: (message) => ({ dispose() {} }),
    onDidChangeActiveTextEditor: (callback) => {
      fakeVscode.__onEditorChange = callback;
      return { dispose: () => {} };
    },
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
    openExternal: async (uri) => {
      log.commandCalls.push({ id: 'openExternal', args: [String(uri && uri.toString ? uri.toString() : uri)] });
      return true;
    },
    clipboard: { readText: async () => '', writeText: async () => undefined },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

/* --------------------------- 打桩：网络与提交 --------------------------- */

const { VJudgeClient } = require('../src/vjudge');
const { Session } = require('../src/session');

const sent = [];
Session.prototype.checkLogin = async () => ({ loggedIn: true, message: '已登录' });
VJudgeClient.prototype.fetchProblem = async (key) => ({
  key,
  title: 'A+B',
  oj: 'CodeForces',
  num: key.split('-')[1],
  data: {},
  statementHtml: '',
  descVersions: [],
});
VJudgeClient.prototype.fetchArticle = async (id) => ({ id, title: '测试文章', content: '', problems: [], url: `https://vjudge.net/article/${id}` });
VJudgeClient.prototype.listContests = async () => [];
VJudgeClient.prototype.listGroups = async () => ({ mine: [], invitations: [], discover: [] });
// 比赛结束时间按用例调整：默认「进行中」，[5b] 改成已结束
let contestEndAt = Date.now() + 3600 * 1000;
VJudgeClient.prototype.fetchContest = async (id) => ({
  id: String(id),
  title: '测试比赛',
  version: 'v-42',
  begin: Date.now() - 3600 * 1000,
  end: contestEndAt,
  ended: Date.now() > contestEndAt,
  url: `https://vjudge.net/contest/${id}`,
  problems: [],
});
VJudgeClient.prototype.resolveContestProblem = async (contestId, index) => ({
  key: 'CodeForces-1A',
  index: String(index).toUpperCase(),
  contestId,
});
VJudgeClient.prototype.problemLanguages = async () =>
  fakeVscode.__languages || [
    { id: '54', name: 'GNU G++17 7.3.0' },
    { id: '1', name: 'GNU GCC C11 5.1.0' },
  ];
VJudgeClient.prototype.submitCode = async (options) => {
  sent.push(options);
  return { runId: 900000 + sent.length, url: `https://vjudge.net/solution/${900000 + sent.length}`, contestId: options.contestId || '', problemNum: options.problemNum || '' };
};
VJudgeClient.prototype.waitForVerdict = async (runId, options = {}) => {
  if (options.onTick) options.onTick({ processing: true, status: 'Running' });
  return { runId, statusType: 1, status: 'Accepted', runtime: 15, memory: 512, language: 'GNU G++17' };
};

/* ------------------------------- 运行 ------------------------------- */

const extension = require('../extension');

const COOKIE_LESS_CONTEXT = {
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
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` -> ${extra}`}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  await extension.activate(COOKIE_LESS_CONTEXT);
  const submit = fakeVscode.__commands.get('vjudgeHelper.submitCode');
  const openProblem = fakeVscode.__commands.get('vjudgeHelper.openProblem');
  const submitToProblem = fakeVscode.__commands.get('vjudgeHelper.submitToProblem');
  if (!submit) throw new Error('没有注册 vjudgeHelper.submitCode');
  if (!openProblem) throw new Error('没有注册 vjudgeHelper.openProblem');
  if (!submitToProblem) throw new Error('没有注册 vjudgeHelper.submitToProblem');

  const document = {
    fileName: 'D:/work/a.cpp',
    languageId: 'cpp',
    isUntitled: false,
    isClosed: false,
    uri: { fsPath: 'D:/work/a.cpp' },
    getText: () => '#include <cstdio>\nint main(){puts("1");}',
  };
  // 模拟「编辑器获得焦点」：VS Code 会触发 onDidChangeActiveTextEditor
  fakeVscode.window.activeTextEditor = { document };
  if (fakeVscode.__onEditorChange) fakeVscode.__onEditorChange({ document });

  /* -------------------- 0. 面板里打开题目后，提交不该再问题号 -------------------- */

  console.log('\n[0] 什么都不打开就直接提交（没有目标时给选择器，而不是空白输入框）');
  await submit();
  const targetPicks = log.quickPicks.filter((p) => /提交到哪道题/.test(String(p.options && p.options.title)));
  pass('弹的是「选题目」列表而不是输入框', targetPicks.length === 1, targetPicks.length);
  pass('列表里带「输入题号」兜底项', targetPicks[0] && /输入题号/.test(targetPicks[0].items.slice(-1)[0].label));
  pass('提交成功', sent.length === 1, sent.length);

  console.log('\n[1] 先打开题目再提交（这是正常路径：面板里有题，快捷键直接交）');
  COOKIE_LESS_CONTEXT.globalState.store.delete('vjudgeHelper.language.CodeForces');
  fakeVscode.__inputs = ['CodeForces-1A'];
  await openProblem();
  sent.length = 0;
  log.quickPicks.length = 0;
  await submit();

  pass('没有再问「提交到哪道题」', log.quickPicks.filter((p) => /提交到哪道题/.test(String(p.options && p.options.title))).length === 0);
  pass('读到了编辑器里的代码', sent.length === 1);
  pass('语言来自语言表（54 = G++17）', sent[0] && sent[0].language === '54', sent[0] && sent[0].language);
  pass('练习提交不带比赛上下文', sent[0] && !sent[0].contestId && !sent[0].problemNum);
  pass('提交了一次语言选择', log.quickPicks.length === 1, log.quickPicks.length);
  pass(
    '推荐语言排在第一（C++17 而不是 C）',
    log.quickPicks[0] && /G\+\+17/.test(log.quickPicks[0].items[0].label),
    log.quickPicks[0] && log.quickPicks[0].items[0].label
  );
  pass(
    '记住语言（供下次一键提交）',
    COOKIE_LESS_CONTEXT.globalState.store.get('vjudgeHelper.language.CodeForces') === '54',
    COOKIE_LESS_CONTEXT.globalState.store.get('vjudgeHelper.language.CodeForces')
  );
  pass('弹出了评测结果', log.infos.some((m) => /Accepted/.test(m)), JSON.stringify(log.infos));
  const judgeItem = log.statusItems.find((item) => /Accepted/.test(item.text));
  pass('状态栏显示 Accepted', !!judgeItem, log.statusItems.map((i) => i.text).join(' | '));

  console.log('\n[2] 第二次提交（语言已记住 + 文件仍是 .cpp，应该完全一键）');
  const before = log.quickPicks.length;
  await submit();
  pass('没有再次弹语言列表', log.quickPicks.length === before, log.quickPicks.length);
  pass('仍然提交成功', sent.length === 2);

  console.log('\n[3] 焦点在面板上，activeTextEditor 为空，靠最近文档兜底');
  fakeVscode.window.activeTextEditor = undefined;
  await submit();
  pass('没有编辑器时仍能拿到刚才的代码', sent.length === 3);
  pass('仍然一键（不弹语言列表）', log.quickPicks.length === before);

  console.log('\n[4] 打开别的面板（比赛/文章）不该把「当前题目」冲掉');
  // 直接写 globalState 模拟「扩展重启后仍记得上次的题」
  COOKIE_LESS_CONTEXT.globalState.store.set('vjudge.lastProblem', {
    key: 'CodeForces-1A',
    title: 'A+B',
    contestId: '',
    problemNum: '',
    at: Date.now(),
  });
  sent.length = 0;
  await submit();
  pass('依然不需要问题号（用了持久化的当前题目）', sent.length === 1, sent.length);
  pass('提交的题号正确', sent[0] && sent[0].key === 'CodeForces-1A', sent[0] && sent[0].key);

  /* -------------------- 5. 比赛题目：面板 + 提交都按比赛来 -------------------- */

  console.log('\n[5] 从比赛题目链接进入：面板带比赛上下文，提交走 /contest/submit');
  fakeVscode.__languages = [{ id: '54', name: 'GNU G++17 7.3.0' }];
  fakeVscode.__inputs = ['https://vjudge.net/contest/863317#problem/A'];
  COOKIE_LESS_CONTEXT.globalState.store.delete('vjudgeHelper.language.CodeForces');
  sent.length = 0;
  log.quickPicks.length = 0;
  await openProblem();
  await submit();

  pass('提交带上了比赛 id 与题号', sent[0] && sent[0].contestId === '863317' && sent[0].problemNum === 'A',
    sent[0] ? `${sent[0].contestId}/${sent[0].problemNum}` : '未提交');
  pass('持久化了比赛上下文', (COOKIE_LESS_CONTEXT.globalState.store.get('vjudge.lastProblem') || {}).contestId === '863317',
    JSON.stringify(COOKIE_LESS_CONTEXT.globalState.store.get('vjudge.lastProblem')));
  pass('带上了比赛快照版本 version（少了服务端会 400）', sent[0] && sent[0].version === 'v-42',
    sent[0] ? JSON.stringify(sent[0].version) : '未提交');
  pass('带上了 accessCode（空串，和网页端一致）', sent[0] && sent[0].accessCode === '',
    sent[0] ? JSON.stringify(sent[0].accessCode) : '未提交');

  const { renderProblem } = require('../src/webview/renderers');
  const view = renderProblem(
    { key: 'CodeForces-1A', title: 'A+B', oj: 'CodeForces', num: '1A', statementHtml: '<p>x</p>', url: 'https://vjudge.net/problem/CodeForces-1A' },
    { contestId: '863317', problemNum: 'A', contestTitle: '测试比赛' }
  );
  pass(
    '面板标题带比赛上下文',
    view.meta.some((m) => m.label === '比赛' && /#863317/.test(String(m.value))),
    JSON.stringify(view.meta)
  );
  pass('按钮写的是「提交到比赛 A」', /提交到比赛/.test(view.actions[0].label), view.actions[0].label);
  pass('多一个「返回比赛」按钮', view.actions.some((a) => a.id === 'contest'));

  console.log('\n[5b] 同一场比赛已经结束：仍然先走比赛通道（网页上赛后也能交，记在比赛下）');
  contestEndAt = Date.now() - 60 * 1000;
  fakeVscode.__inputs = ['https://vjudge.net/contest/863317#problem/A'];
  sent.length = 0;
  await openProblem();
  await submit();
  pass('赛后仍然带比赛上下文', sent[0] && sent[0].contestId === '863317' && sent[0].problemNum === 'A',
    sent[0] ? `${sent[0].contestId}/${sent[0].problemNum}` : '未提交');
  pass('题目还是那道题', sent[0] && sent[0].key === 'CodeForces-1A', sent[0] && sent[0].key);

  const endedView = renderProblem(
    { key: 'CodeForces-1A', title: 'A+B', oj: 'CodeForces', num: '1A', statementHtml: '<p>x</p>', url: 'https://vjudge.net/problem/CodeForces-1A' },
    { contestId: '863317', problemNum: 'A', contestTitle: '测试比赛', contestEnded: true }
  );
  pass('按钮仍然是「提交到比赛 A」', /提交到比赛 A/.test(endedView.actions[0].label), endedView.actions[0].label);
  pass('面板写明不计入榜单', /不计入榜单/.test(JSON.stringify(endedView.meta)), JSON.stringify(endedView.meta));
  contestEndAt = Date.now() + 3600 * 1000;

  console.log('\n[6] 「提交到指定题目」命令：强制选题目');
  log.quickPicks.length = 0;
  fakeVscode.__inputs = [];
  sent.length = 0;
  await submitToProblem();
  pass('弹出了题目选择器', log.quickPicks.some((p) => /提交到哪道题/.test(String(p.options && p.options.title))));
  pass('照常提交', sent.length === 1);

  console.log('\n[7] Codeforces 那类题（submitMethods=[false,true,true]）：自动换成「自己的账号」');
  const originalFetchProblem = VJudgeClient.prototype.fetchProblem;
  VJudgeClient.prototype.fetchProblem = async (key) => ({
    key,
    title: 'A+B',
    oj: 'CodeForces',
    num: key.split('-')[1],
    data: { submitMethods: [false, true, true] },
    submitMethods: [false, true, true],
    statementHtml: '',
    descVersions: [],
  });
  const bindings = [
    { id: 'b1', accountId: 'tourist', display: 'tourist', oj: 'CodeForces', status: 'READY', ready: true },
  ];
  VJudgeClient.prototype.fetchRemoteAccounts = async () => bindings;

  await fakeVscode.__commands.get('vjudgeHelper.internal.openProblem')('CodeForces-1A');
  sent.length = 0;
  await submit();
  pass('提交方式用「自己的账号」（method=1）', sent[0] && sent[0].method === 1, sent[0] && sent[0].method);
  pass('带上了账号绑定 ID', sent[0] && sent[0].bindingId === 'b1', sent[0] && sent[0].bindingId);

  console.log('\n[8] 没有可用绑定：给出可操作提示，而不是发一条注定失败的提交');
  bindings.length = 0;
  sent.length = 0;
  const warnBefore = log.warnings.length;
  await submit();
  pass('没有发出去提交', sent.length === 0, sent.length);
  pass(
    '提示了去绑定账号',
    /绑定/.test(log.warnings.slice(warnBefore).join(' ')),
    JSON.stringify(log.warnings.slice(warnBefore))
  );

  VJudgeClient.prototype.fetchProblem = originalFetchProblem;

  extension.deactivate();
  console.log('\n演练结束');
}

main().catch((err) => {
  console.error('演练失败:', err);
  process.exitCode = 1;
});
