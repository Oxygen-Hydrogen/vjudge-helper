'use strict';

/**
 * 端到端冒烟测试：用假的 vscode API 跑一遍 activate()，
 * 验证命令注册、侧边栏树、面板 HTML 生成都正常。
 *   node test/activate-check.js
 */

const Module = require('module');
const path = require('path');

const DEFAULTS = {
  baseUrl: 'https://vjudge.net',
  username: '',
  cookie: '',
  openIn: 'panel',
  enableMathJax: true,
  contestPageSize: 10,
  showStatusBar: true,
  requestTimeout: 30000,
  autoRefreshContests: false,
};

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
  fire(v) {
    for (const l of this.listeners) l(v);
  }
  dispose() {}
}

let lastWebviewHtml = null;
const createdCommands = new Map();

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
    constructor(id, color) {
      this.id = id;
      this.color = color;
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
      createdCommands.set(id, fn);
      return { dispose: () => {} };
    },
    executeCommand: async () => undefined,
  },
  window: {
    createTreeView: () => ({ dispose: () => {}, title: '' }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      show() {},
      hide() {},
      dispose() {},
    }),
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
    withProgress: async (opts, task) => task({ report: () => {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
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
      console.log('  [openExternal]', uri.toString());
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

/* 拦截面板 HTML 以便检查 */
const shell = require('../src/webview/shell');
const originalShowPanel = shell.showPanel;

const extension = require('../extension');

const fakeContext = {
  subscriptions: [],
  extensionUri: fakeVscode.Uri.file(path.join(__dirname, '..')),
  globalState: {
    store: new Map(),
    get(k) {
      return this.store.get(k);
    },
    async update(k, v) {
      this.store.set(k, v);
    },
  },
  secrets: {
    store: new Map(),
    async get(k) {
      return this.store.get(k);
    },
    async store(k, v) {
      this.store.set(k, v);
    },
    async delete(k) {
      this.store.delete(k);
    },
  },
};

function line(t) {
  console.log(`\n${'='.repeat(60)}\n${t}\n${'='.repeat(60)}`);
}

async function main() {
  line('activate()');
  await extension.activate(fakeContext);
  console.log('激活成功，注册命令数:', createdCommands.size);

  line('命令清单核对');
  const pkg = require('../package.json');
  const expected = pkg.contributes.commands.map((c) => c.command);
  const missing = expected.filter((c) => !createdCommands.has(c));
  console.log('package.json 声明:', expected.length, '缺失:', missing.length ? missing : '无');
  const extra = [...createdCommands.keys()].filter((k) => !k.startsWith('vjudgeHelper.internal.'));
  console.log('实际注册:', extra.length);

  line('侧边栏树（真实数据）');
  const { VJudgeClient } = require('../src/vjudge');
  const { CookieJar } = require('../src/http');
  const client = new VJudgeClient({
    baseUrl: 'https://vjudge.net',
    jar: new CookieJar(),
    timeout: 30000,
    hasCredentials: false,
  });
  const { VJudgeTreeProvider } = require('../src/explorer');
  const { Store } = require('../src/store');
  const treeProvider = new VJudgeTreeProvider(
    client,
    new Store(fakeContext),
    { baseUrl: 'https://vjudge.net', hasCredentials: false }
  );
  const roots = await treeProvider.getChildren();
  console.log('根节点:', roots.map((r) => r.label));
  const liveGroup = roots.find((r) => r.id === 'contests-live');
  const liveNodes = await treeProvider.getChildren(liveGroup);
  console.log('进行中/即将开始:');
  for (const n of liveNodes.slice(0, 5)) {
    const item = treeProvider.getTreeItem(n);
    console.log(`  - ${item.label} | ${item.description || ''}`);
  }
  const recentGroup = roots.find((r) => r.id === 'contests-recent');
  const recentNodes = await treeProvider.getChildren(recentGroup);
  console.log('最近的比赛:', recentNodes.length, '条，首条 =', recentNodes[0] && recentNodes[0].label);
  const favNodes = await treeProvider.getChildren(roots.find((r) => r.id === 'favorites'));
  console.log('收藏组占位:', favNodes[0].label);

  line('侧边栏：团队分组');
  const mineGroupNode = roots.find((r) => r.id === 'groups-mine');
  const discoverGroupNode = roots.find((r) => r.id === 'groups-discover');
  console.log('存在「我的团队」:', !!mineGroupNode, ' 存在「发现团队」:', !!discoverGroupNode);
  const discoverNodes = await treeProvider.getChildren(discoverGroupNode);
  console.log('发现团队:', discoverNodes.length, '条，前 3 条：');
  for (const n of discoverNodes.slice(0, 3)) {
    const item = treeProvider.getTreeItem(n);
    console.log(`  - ${item.label} | ${item.description} | ${item.command && item.command.command}`);
  }
  const mineNodes = await treeProvider.getChildren(mineGroupNode);
  console.log('我的团队（未登录）:', mineNodes[0].label);

  line('渲染器 / 面板 HTML（用真实文章数据）');
  const article = await client.fetchArticle(1);
  const { renderArticle } = require('../src/webview/renderers');
  const view = renderArticle(article, { isFavorite: false });
  const html = shell.renderShell({
    webview: {
      cspSource: 'vscode-webview://test',
      asWebviewUri: (u) => u,
    },
    extensionUri: fakeVscode.Uri.file(path.join(__dirname, '..')),
    enableMathJax: true,
    ...view,
  });
  console.log('面板 HTML 长度:', html.length);
  console.log('包含 CSP:', html.includes('Content-Security-Policy'));
  console.log('包含 MathJax:', html.includes('mathjax'));
  console.log('包含 \\bm 宏（中文题面常见，MathJax 默认没有）:', html.includes('boldsymbol'));
  console.log('包含文章标题:', html.includes('计算几何'));
  console.log('包含题目链接:', html.includes('vjudge-problem:'));

  line('团队面板 HTML（用真实团队数据）');
  const { renderGroup } = require('../src/webview/renderers');
  const sampleGroup = await client.fetchGroup(discoverNodes[0].key);
  const groupView = renderGroup(sampleGroup);
  const groupHtml = shell.renderShell({
    webview: { cspSource: 'vscode-webview://test', asWebviewUri: (u) => u },
    extensionUri: fakeVscode.Uri.file(path.join(__dirname, '..')),
    enableMathJax: true,
    ...groupView,
  });
  console.log('团队:', sampleGroup.name, '| 面板 HTML 长度:', groupHtml.length);
  console.log('包含 CSP:', groupHtml.includes('Content-Security-Policy'));
  console.log('包含团队短名:', groupHtml.includes(sampleGroup.shortName));
  console.log('包含成员表:', groupHtml.includes('<h2>成员'));

  line('命令冒烟：refresh / checkLogin');
  await createdCommands.get('vjudgeHelper.refresh')();
  await createdCommands.get('vjudgeHelper.checkLogin')();
  console.log('命令执行无异常');

  extension.deactivate();
  console.log('\n全部通过。');
}

main().catch((err) => {
  console.error('冒烟测试失败:', err);
  process.exitCode = 1;
});
