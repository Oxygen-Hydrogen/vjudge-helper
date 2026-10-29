'use strict';

/**
 * 「随机来一道题」的流程自检（不联网）。
 *
 * 只验接线，不验网络：
 *   - 菜单顺序对不对（没有历史时第一项是「选条件…」，有历史时第一项是「再来一道」）；
 *   - 选 OJ → 选难度 → 真正去抽的时候，参数有没有传对（oj / rating / levels）；
 *   - 抽完有没有把条件记进 globalState（下次「再来一道」靠它）；
 *   - 「其他 OJ」走 ojName，不要把它当普通 OJ 名丢掉。
 *
 * 办法：把 openIn 设成 browser（省掉题面请求），再把 randomLib.pickRandom 打桩，
 * 于是整条命令只剩 QuickPick + 打开 URL，全程不碰网络。
 *
 * 跑法：node test/random-flow-check.js
 */

const Module = require('module');
const path = require('path');

const DEFAULTS = {
  baseUrl: 'https://vjudge.net',
  username: '',
  cookie: '',
  openIn: 'browser', // 关键：不打开面板，直接走 openExternal
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

const createdCommands = new Map();
let openedUrls = [];
/** 每一步 QuickPick 期待的回答：字符串 = 标签包含它；函数 = 自己挑 */
let quickPickScript = [];
let pickRandomCalls = [];

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
    // 随机抽完没登录会弹这个：返回 undefined = 用户直接关掉，流程继续
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async (items, opts) => {
      const step = quickPickScript.shift();
      if (step === undefined) {
        throw new Error(`QuickPick 被调用了，但脚本里没有下一步：${(items || []).map((i) => i.label).join(' | ')}`);
      }
      if (typeof step === 'function') return step(items, opts);
      const hit = (items || []).find((i) => String(i.label).includes(step));
      if (!hit) throw new Error(`QuickPick 里找不到「${step}」，实际有：${(items || []).map((i) => i.label).join(' | ')}`);
      // 多选菜单要返回数组
      return opts && opts.canPickMany ? [hit] : hit;
    },
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
      openedUrls.push(String(uri));
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

/* 把网络那一步打桩 */
const randomLib = require('../src/random');
randomLib.pickRandom = async (options) => {
  pickRandomCalls.push({ ...options, client: options.client ? 'client' : undefined });
  return { key: 'CodeForces-4A', title: 'Watermelon', detail: 'rating 800', source: 'codeforces' };
};
// 标签列表也走网络，一起打桩
randomLib.fetchLuoguTags = async () => [
  { id: 3, name: '动态规划 DP', parentName: '' },
  { id: 6, name: '图论', parentName: '' },
];
randomLib.codeforcesTags = async () => [
  { tag: 'dp', count: 1200 },
  { tag: 'graphs', count: 900 },
];

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

let failed = 0;
function ok(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label} —— ${err.message}`);
  }
}

async function runCommand() {
  await createdCommands.get('vjudgeHelper.openRandomProblem')();
}

(async () => {
  console.log('============================================================');
  console.log('随机来一道题 · 流程');
  console.log('============================================================');

  await extension.activate(fakeContext);

  // [1] 没有历史：直接选「不限 OJ」
  quickPickScript = ['不限 OJ'];
  openedUrls = [];
  await runCommand();
  ok('不限 OJ 走的是 oj=any，且不带难度', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (!call) throw new Error('pickRandom 没被调用');
    if (call.oj !== 'any') throw new Error(`oj=${call.oj}`);
    if (call.rating || call.levels) throw new Error('不该带难度');
  });
  ok('抽完打开了题目链接', () => {
    if (!openedUrls.some((u) => u.includes('CodeForces-4A'))) {
      throw new Error(`打开的地址不对：${openedUrls.join(', ') || '（没打开任何地址）'}`);
    }
  });
  ok('条件写进了 globalState', () => {
    const saved = fakeContext.globalState.get('vjudge.randomFilter');
    if (!saved) throw new Error('没存');
    if (saved.oj !== 'any') throw new Error(`存的 oj=${saved.oj}`);
    if (!saved.label) throw new Error('没有可读的 label');
  });

  // [2] 有历史：第一项应当是「再来一道」，一键复用
  let firstLabels = [];
  quickPickScript = [
    (items) => {
      firstLabels = items.map((i) => String(i.label));
      return items[0];
    },
  ];
  await runCommand();
  ok('有历史时第一项是「再来一道」', () => {
    if (!firstLabels[0] || !firstLabels[0].includes('再来一道')) {
      throw new Error(`第一项是「${firstLabels[0]}」`);
    }
  });
  ok('「再来一道」只弹一次菜单就抽了', () => {
    if (quickPickScript.length) throw new Error('还有没消费的 QuickPick 步骤');
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (!call) throw new Error('pickRandom 没被调用');
  });

  // [3] 洛谷 + 难度 + 标签：levels / tags 都要传到 pickRandom
  quickPickScript = ['选条件', '洛谷', '提高+/省选−', '动态规划 DP'];
  await runCommand();
  ok('洛谷「提高+/省选−（蓝）」传成 levels=[6]', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (call.oj !== '洛谷') throw new Error(`oj=${call.oj}`);
    if (!Array.isArray(call.levels) || call.levels.join(',') !== '6') {
      throw new Error(`levels=${JSON.stringify(call.levels)}`);
    }
  });
  ok('洛谷选「动态规划 DP」传成 tags=[3]', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (!Array.isArray(call.tags) || call.tags.join(',') !== '3') {
      throw new Error(`tags=${JSON.stringify(call.tags)}`);
    }
    const saved = fakeContext.globalState.get('vjudge.randomFilter');
    if (!saved.tagLabel || !saved.tagLabel.includes('动态规划')) {
      throw new Error(`存的 tagLabel=${saved.tagLabel}`);
    }
    if (!saved.label.includes('标签')) throw new Error(`label 里没有标签：${saved.label}`);
  });

  // [3d] 标签那一步按 Esc = 不限标签（不打断抽题）
  quickPickScript = ['选条件', '洛谷', '入门 · 红', () => undefined];
  const beforeEsc = pickRandomCalls.length;
  await runCommand();
  ok('标签步按 Esc 当「不限标签」，照样抽', () => {
    if (pickRandomCalls.length !== beforeEsc + 1) throw new Error('Esc 之后没抽题');
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (call.tags && call.tags.length) throw new Error(`tags=${JSON.stringify(call.tags)}`);
  });

  // [3c] 标签一个都不选 = 不限
  quickPickScript = ['选条件', '洛谷', '入门 · 红', () => []];
  await runCommand();
  ok('标签一个都不选时不带 tags', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (call.tags && call.tags.length) throw new Error(`tags=${JSON.stringify(call.tags)}`);
  });

  // [3b] 新加的「提高（青）」是 5 档，别按老记忆当成蓝
  quickPickScript = ['选条件', '洛谷', '提高 · 青', () => []];
  await runCommand();
  ok('洛谷「提高（青）」传成 levels=[5]', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (!Array.isArray(call.levels) || call.levels.join(',') !== '5') {
      throw new Error(`levels=${JSON.stringify(call.levels)}`);
    }
  });

  // [4] CF + 自定义区间 + 标签
  quickPickScript = ['选条件', 'Codeforces', '自定义区间', 'dp'];
  fakeVscode.window.showInputBox = async () => '1600-1900';
  await runCommand();
  ok('CF 自定义 1600-1900 传成 rating{1600,1900}', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (call.oj !== 'CodeForces') throw new Error(`oj=${call.oj}`);
    if (!call.rating || call.rating.min !== 1600 || call.rating.max !== 1900) {
      throw new Error(`rating=${JSON.stringify(call.rating)}`);
    }
  });
  ok('CF 选标签 dp 传成 tags=["dp"]', () => {
    const call = pickRandomCalls[pickRandomCalls.length - 1];
    if (!Array.isArray(call.tags) || call.tags.join(',') !== 'dp') {
      throw new Error(`tags=${JSON.stringify(call.tags)}`);
    }
  });

  // [5] 取消（Esc）
  quickPickScript = [() => undefined];
  const before = pickRandomCalls.length;
  await runCommand();
  ok('Esc 取消时不抽题', () => {
    if (pickRandomCalls.length !== before) throw new Error('取消了还去抽题');
  });

  console.log('');
  if (failed) {
    console.log(`✗ ${failed} 项未通过`);
    process.exit(1);
  }
  console.log('全部通过。');
  extension.deactivate();
})();
