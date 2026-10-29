'use strict';

const vscode = require('vscode');

const { Session, LoginRequiredError } = require('./src/session');
const { VJudgeClient } = require('./src/vjudge');
const { Store } = require('./src/store');
const { VJudgeTreeProvider } = require('./src/explorer');
const { showPanel } = require('./src/webview/shell');
const { renderProblem, renderArticle, renderContest, renderGroup, renderStandingsInner } = require('./src/webview/renderers');
const {
  parseInput,
  problemUrl,
  findProblemKeyInText,
  splitProblemKey,
  normalizeProblemKey,
  escapeHtml,
} = require('./src/util');
const submitLib = require('./src/submit');
const { buildStandings } = require('./src/standings');
const log = require('./src/log');

let session;
let client;
let store;
let treeProvider;
let treeView;
let statusItem;
let judgeItem;
/** 提交日志：出问题时能直接看「打到哪条通道、服务端回了什么」 */
let outputLog;

/** 最近打开的对象，供「在浏览器中打开」「收藏」这类无参命令使用 */
let lastOpened = null;
/**
 * 当前正在看的题目（可能带比赛上下文）。
 * 和 lastOpened 分开：打开比赛 / 文章面板不该把「我要提交哪道题」冲掉。
 * 同时持久化到 globalState，扩展重启后仍然有效。
 */
let currentProblem = null;
/** 榜单自动刷新 */
let standingsPoll = null;
/** 最近一次提交的记录页，状态栏点击可直达 */
let lastSolutionUrl = '';
let judgeHideTimer = null;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function config() {
  return vscode.workspace.getConfiguration('vjudgeHelper');
}

function withProgress(title, task) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    task
  );
}

function handleError(err) {
  const message = err && err.message ? err.message : String(err);
  if (err && err.code === 'LOGIN_REQUIRED') {
    vscode.window
      .showWarningMessage(message, '去登录', '手动粘贴 Cookie')
      .then((choice) => {
        if (choice === '去登录') vscode.commands.executeCommand('vjudgeHelper.login');
        if (choice === '手动粘贴 Cookie') vscode.commands.executeCommand('vjudgeHelper.setCookie');
      });
    return;
  }
  vscode.window.showErrorMessage(`VJudge: ${message}`);
}

function wrap(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      handleError(err);
    }
  };
}

function openExternal(url) {
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

function openWithPreferred(url, fallbackPanel) {
  const mode = config().get('openIn') || 'panel';
  if (mode === 'browser') return openExternal(url);
  if (mode === 'simpleBrowser') return vscode.commands.executeCommand('simpleBrowser.show', url);
  return fallbackPanel();
}

function updateStatusBar() {
  if (!statusItem) return;
  if (!config().get('showStatusBar')) {
    statusItem.hide();
    return;
  }
  const loggedIn = session.hasCredentials;
  statusItem.text = loggedIn ? '$(book) VJudge' : '$(book) VJudge 未登录';
  statusItem.tooltip = loggedIn
    ? 'VJudge Helper：点击打开菜单'
    : 'VJudge Helper：还没有登录，题面需要登录后才能查看（点击打开菜单）';
  statusItem.command = 'vjudgeHelper.showMenu';
  statusItem.show();
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */

async function renderProblemPanel(key, options = {}) {
  const problem = await withProgress(`正在获取 ${key} 题面…`, () => client.fetchProblem(key, options));
  const isFavorite = store.isFavoriteProblem(problem.key);
  const contestId = options.contestId ? String(options.contestId) : '';
  const problemNum = options.problemNum ? String(options.problemNum).toUpperCase() : '';
  const contestEnd = Number(options.contestEnd) || 0;
  const contestEnded = !!contestId && !!contestEnd && Date.now() > contestEnd;
  const view = renderProblem(problem, {
    isFavorite,
    contestId,
    problemNum,
    contestTitle: options.contestTitle || '',
    contestEnded,
    contestEnd,
  });

  currentProblem = {
    key: problem.key,
    title: problem.title,
    contestId,
    problemNum,
    contestTitle: options.contestTitle || '',
    contestVersion: options.contestVersion ? String(options.contestVersion) : '',
    contestEnd,
  };
  store.setLastProblem(currentProblem).catch(() => {});
  lastOpened = {
    kind: 'problem',
    key: problem.key,
    id: problem.key,
    title: problem.title,
    url: problem.url,
    ...currentProblem,
  };

  showPanel(appContext, 'problem', {
    ...view,
    enableMathJax: config().get('enableMathJax') !== false,
    onMessage: (msg) => handleProblemMessage(msg, problem, {
      ...options,
      contestId,
      problemNum,
      contestVersion: currentProblem.contestVersion,
      contestEnd,
    }),
  });

  await store.pushHistory({
    kind: 'problem',
    id: problem.key,
    title: `${problem.key} ${problem.title}`.trim(),
  });
  treeProvider.refresh();
}

/** 题面版本 / 翻译切换 */
async function pickProblemVersion(problem, options = {}) {
  const versions = Array.isArray(problem.descVersions) ? problem.descVersions : [];
  if (versions.length < 2) {
    vscode.window.showInformationMessage('这道题只有一个题面版本。');
    return;
  }
  const currentKey = problem.descCurrent ? problem.descCurrent.key : null;
  const picked = await vscode.window.showQuickPick(
    versions.map((v) => ({
      label: `${v.label}${v.key === currentKey ? '（当前）' : ''}`,
      description: v.official || v.mainOfficial ? '官方题面' : '译文 / 用户贡献',
      detail: `descKey ${v.key}`,
      key: v.key,
    })),
    { placeHolder: '选择要显示的题面版本（含各语言翻译）', title: `${problem.key} 题面版本` }
  );
  if (!picked || picked.key === currentKey) return;
  await renderProblemPanel(problem.key, {
    descKey: picked.key,
    contestId: options.contestId,
    problemNum: options.problemNum,
    contestTitle: options.contestTitle,
    contestEnd: options.contestEnd,
    contestVersion: options.contestVersion,
  });
}

async function showProblem(key, options = {}) {
  // 任何入口进来的题号都先折成 VJudge 认的写法（luogu-P1001 -> 洛谷-P1001）
  key = normalizeProblemKey(key) || String(key || '').trim();
  const mode = config().get('openIn') || 'panel';
  if (mode === 'browser') {
    await openExternal(problemUrl(key, session.baseUrl));
    return;
  }
  if (mode === 'simpleBrowser') {
    await vscode.commands.executeCommand('simpleBrowser.show', problemUrl(key, session.baseUrl));
    return;
  }
  await renderProblemPanel(key, options);
}

function handleProblemMessage(msg, problem, options = {}) {
  if (!msg) return;
  if (msg.type === 'openExternal' && msg.url) {
    openExternal(msg.url);
    return;
  }
  if (msg.type === 'openPath' && msg.path) {
    openExternal(`${session.baseUrl}${msg.path}`);
    return;
  }
  if (msg.type === 'openProblem' && msg.key) {
    showProblem(msg.key).catch(handleError);
    return;
  }
  if (msg.type === 'openContest' && msg.id) {
    showContest(msg.id).catch(handleError);
    return;
  }
  if (msg.type === 'openGroup' && msg.name) {
    showGroup(msg.name).catch(handleError);
    return;
  }
  if (msg.type !== 'action') return;

  switch (msg.action) {
    case 'browser':
      openExternal(problem.url);
      break;
    case 'copy':
      vscode.env.clipboard.writeText(problem.url).then(() => {
        vscode.window.setStatusBarMessage('已复制题目链接', 2000);
      });
      break;
    case 'submit':
      submitCurrentCode({
        key: problem.key,
        title: problem.title,
        contestId: options.contestId,
        problemNum: options.problemNum,
        contestTitle: options.contestTitle,
        contestVersion: options.contestVersion,
        contestEnd: options.contestEnd,
      }).catch(handleError);
      break;
    case 'contest':
      if (options.contestId) showContest(options.contestId).catch(handleError);
      break;
    case 'version':
      pickProblemVersion(problem, options).catch(handleError);
      break;
    case 'favorite':
      store.toggleProblem(problem).then((added) => {
        vscode.window.setStatusBarMessage(added ? '已收藏' : '已取消收藏', 2000);
        treeProvider.refresh();
        renderProblemPanel(problem.key, { fresh: false, ...options }).catch(() => {});
      });
      break;
    case 'refresh':
      client.clearCache();
      renderProblemPanel(problem.key, { fresh: true, ...options }).catch(handleError);
      break;
    default:
      break;
  }
}

async function showArticle(id) {
  const article = await withProgress(`正在获取文章 #${id}…`, () => client.fetchArticle(id));
  const view = renderArticle(article, { isFavorite: store.isFavoriteArticle(article.id) });
  lastOpened = { kind: 'article', key: String(article.id), id: String(article.id), title: article.title, url: article.url };
  showPanel(appContext, 'article', {
    ...view,
    enableMathJax: config().get('enableMathJax') !== false,
    onMessage: (msg) => {
      if (msg.type === 'openExternal' && msg.url) return openExternal(msg.url);
      if (msg.type === 'openPath' && msg.path) return openExternal(`${session.baseUrl}${msg.path}`);
      if (msg.type === 'openProblem' && msg.key) return showProblem(msg.key).catch(handleError);
      if (msg.type === 'openContest' && msg.id) return showContest(msg.id).catch(handleError);
      if (msg.type === 'openGroup' && msg.name) return showGroup(msg.name).catch(handleError);
      if (msg.type !== 'action') return undefined;
      switch (msg.action) {
        case 'browser':
          return openExternal(article.url);
        case 'copy':
          return vscode.env.clipboard.writeText(article.url).then(() => {
            vscode.window.setStatusBarMessage('已复制文章链接', 2000);
          });
        case 'favorite':
          return store.toggleArticle(article).then((added) => {
            vscode.window.setStatusBarMessage(added ? '已收藏文章' : '已取消收藏', 2000);
            treeProvider.refresh();
            return showArticle(article.id).catch(() => {});
          });
        case 'refresh':
          client.clearCache();
          return showArticle(article.id).catch(handleError);
        default:
          return undefined;
      }
    },
  });
  await store.pushHistory({
    kind: 'article',
    id: String(article.id),
    title: article.title,
  });
  treeProvider.refresh();
}

/* ------------------------------------------------------------------ */
/* 比赛榜单（实时）                                                     */
/* ------------------------------------------------------------------ */

/** 设置里的刷新间隔（秒），0 / 非法值 = 不自动刷新 */
function standingsInterval() {
  const value = Number(config().get('standingsInterval'));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(3, Math.round(value));
}

function stopStandingsPoll() {
  if (standingsPoll && standingsPoll.timer) clearTimeout(standingsPoll.timer);
  standingsPoll = null;
}

/**
 * 拉一次榜单并推到面板里（只换 #vj-standings-inner，不重载整页）
 * @param {object} contest
 * @param {vscode.WebviewPanel} panel
 * @param {{quiet?: boolean}} [options]
 */
async function pushStandings(contest, panel, options = {}) {
  if (!panel || !panel.webview) return null;
  try {
    const rank = await client.fetchContestRank(contest.id);
    const myId = await client.myUserId().catch(() => '');
    const standings = buildStandings(contest, rank, { myParticipantId: myId });
    panel.webview.postMessage({
      type: 'standings',
      html: renderStandingsInner(standings),
      updatedAt: standings.updatedAt,
    });
    if (!options.quiet) {
      vscode.window.setStatusBarMessage(`榜单已更新 · ${standings.participantCount} 人参赛`, 2500);
    }
    return standings;
  } catch (err) {
    if (!options.quiet) {
      panel.webview.postMessage({
        type: 'standings',
        html: `<p class="vj-dim">${escapeHtml(err.message)}</p>`,
        updatedAt: Date.now(),
      });
    }
    return null;
  }
}

/** 每 N 秒刷新当前比赛面板的榜单；面板隐藏时跳过，比赛结束后自动降频 */
function startStandingsPoll(contest, panel) {
  stopStandingsPoll();
  const interval = standingsInterval();
  if (!interval) return;

  const state = {
    contestId: String(contest.id),
    panel,
    timer: null,
    busy: false,
    interval,
  };
  standingsPoll = state;

  const contestEnded = () => contest.end && Date.now() > contest.end;

  const tick = async () => {
    if (standingsPoll !== state) return;
    if (state.busy) return;
    if (panel.visible === false) return;
    state.busy = true;
    try {
      await pushStandings(contest, panel, { quiet: true });
    } finally {
      state.busy = false;
    }
  };
  state.tick = tick;

  const schedule = () => {
    if (standingsPoll !== state) return;
    // 比赛结束后没必要 5 秒一次，降到 60 秒
    const seconds = contestEnded() ? Math.max(state.interval, 60) : state.interval;
    state.timer = setTimeout(async () => {
      await tick();
      schedule();
    }, seconds * 1000);
  };
  schedule();
}

/** 提交完如果有对应比赛面板开着，立刻刷一次榜单（不用等下一个周期） */
function refreshStandingsSoon(contestId) {
  if (!standingsPoll || standingsPoll.contestId !== String(contestId)) return;
  if (standingsPoll.tick) standingsPoll.tick();
}

async function showContest(id, options = {}) {
  const contest = await withProgress(`正在获取比赛 #${id}…`, () => client.fetchContest(id));

  let standings = null;
  let standingsError = '';
  try {
    standings = await withProgress('正在读取榜单…', async () => {
      const [rank, myId] = await Promise.all([
        client.fetchContestRank(contest.id),
        client.myUserId().catch(() => ''),
      ]);
      return buildStandings(contest, rank, { myParticipantId: myId });
    });
  } catch (err) {
    standingsError = err && err.code === 'LOGIN_REQUIRED' ? '榜单需要登录 / 报名后才能查看' : err.message;
  }

  const interval = standingsInterval();
  const view = renderContest(contest, { standings, standingsError, pollInterval: interval });
  lastOpened = { kind: 'contest', key: String(contest.id), id: String(contest.id), title: contest.title, url: contest.url };

  let panel = null;
  panel = showPanel(appContext, 'contest', {
    ...view,
    enableMathJax: false,
    onDispose: () => stopStandingsPoll(),
    onVisibilityChange: (visible) => {
      // 从编辑器切回榜单标签页时立刻刷一次，不用等下一个周期
      if (visible && standingsPoll && standingsPoll.contestId === String(contest.id)) standingsPoll.tick();
    },
    onMessage: (msg) => {
      if (!msg) return undefined;
      if (msg.type === 'openExternal' && msg.url) return openExternal(msg.url);
      if (msg.type === 'openPath' && msg.path) return openExternal(`${session.baseUrl}${msg.path}`);
      if (msg.type === 'openProblem' && msg.key) {
        // 从比赛里点进去的题目 = 这场比赛的一道题，提交时走 /contest/submit
        const hit = (contest.problems || []).find((p) => p.key === msg.key);
        return showProblem(msg.key, {
          contestId: contest.id,
          problemNum: hit ? hit.index : '',
          contestTitle: contest.title,
          contestVersion: contest.version,
          contestEnd: contest.end,
        }).catch(handleError);
      }
      if (msg.type === 'openContest' && msg.id) return showContest(msg.id).catch(handleError);
      if (msg.type === 'openGroup' && msg.name) return showGroup(msg.name).catch(handleError);
      if (msg.type !== 'action') return undefined;
      switch (msg.action) {
        case 'browser':
          return openExternal(contest.url);
        case 'copy':
          return vscode.env.clipboard.writeText(contest.url).then(() => {
            vscode.window.setStatusBarMessage('已复制比赛链接', 2000);
          });
        case 'rank':
          return openExternal(`${contest.url}#rank`);
        case 'rankRefresh':
          return pushStandings(contest, panel).catch(handleError);
        case 'login':
          return vscode.commands
            .executeCommand('vjudgeHelper.login')
            .then(() => {
              client.clearCache();
              return showContest(id);
            })
            .catch(handleError);
        case 'refresh':
          client.clearCache();
          return showContest(id).catch(handleError);
        default:
          return undefined;
      }
    },
  });

  startStandingsPoll(contest, panel);

  await store.pushHistory({
    kind: 'contest',
    id: String(contest.id),
    title: contest.title,
  });
  treeProvider.refresh();
}

async function showGroup(nameOrId, options = {}) {
  const group = await withProgress(`正在获取团队 ${nameOrId}…`, () => client.fetchGroup(nameOrId, options));
  const view = renderGroup(group);
  lastOpened = { kind: 'group', key: group.shortName, id: group.shortName, title: group.name, url: group.url };

  showPanel(appContext, 'group', {
    ...view,
    enableMathJax: config().get('enableMathJax') !== false,
    onMessage: (msg) => {
      if (!msg) return undefined;
      if (msg.type === 'openExternal' && msg.url) return openExternal(msg.url);
      if (msg.type === 'openPath' && msg.path) return openExternal(`${session.baseUrl}${msg.path}`);
      if (msg.type === 'openProblem' && msg.key) return showProblem(msg.key).catch(handleError);
      if (msg.type === 'openContest' && msg.id) return showContest(msg.id).catch(handleError);
      if (msg.type === 'openArticle' && msg.id) return showArticle(msg.id).catch(handleError);
      if (msg.type === 'openGroup' && msg.name) return showGroup(msg.name).catch(handleError);
      if (msg.type !== 'action') return undefined;
      switch (msg.action) {
        case 'browser':
          return openExternal(group.url);
        case 'copy':
          return vscode.env.clipboard.writeText(group.url).then(() => {
            vscode.window.setStatusBarMessage('已复制团队链接', 2000);
          });
        case 'refresh':
          client.clearCache();
          return showGroup(group.shortName, { fresh: true }).catch(handleError);
        default:
          return undefined;
      }
    },
  });

  await store.pushHistory({ kind: 'group', id: group.shortName, title: group.name });
  treeProvider.refresh();
}

/* ------------------------------------------------------------------ */
/* 输入解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 比赛的标题 / 结束时间。有了结束时间才能判断「还能不能走比赛提交」，
 * 拉不到就返回空对象（提交时按比赛通道试，被拒了再退成补题）。
 */
async function contestMetaOf(contestId) {
  if (!contestId) return {};
  try {
    const contest = await client.fetchContest(contestId);
    if (!contest) return {};
    return {
      contestTitle: contest.title || '',
      contestEnd: Number(contest.end) || 0,
      contestVersion: contest.version ? String(contest.version) : '',
    };
  } catch {
    return {};
  }
}

async function resolveAndOpen(text, originLabel) {
  const parsed = parseInput(text, session.baseUrl);

  if (parsed.kind === 'problem') {
    if (parsed.convertedFrom) {
      const fromLink = /^https?:\/\//i.test(parsed.convertedFrom);
      vscode.window.setStatusBarMessage(
        fromLink ? `已从链接识别为 ${parsed.key}` : `已按 VJudge 题号识别为 ${parsed.key}`,
        3000
      );
    }
    return showProblem(parsed.key);
  }
  if (parsed.kind === 'contest') return showContest(parsed.id);
  if (parsed.kind === 'article') return showArticle(parsed.id);
  if (parsed.kind === 'group') return showGroup(parsed.name);
  if (parsed.kind === 'contestProblem') {
    const hit = await withProgress('正在解析比赛题目…', () =>
      client.resolveContestProblem(parsed.contestId, parsed.index)
    );
    return showProblem(hit.key, {
      contestId: parsed.contestId,
      problemNum: parsed.index,
      ...(await contestMetaOf(parsed.contestId)),
    });
  }
  if (parsed.kind === 'url') {
    return openExternal(parsed.url);
  }
  if (parsed.kind === 'ambiguous') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: `比赛 #${parsed.id}`, value: 'contest' },
        { label: `文章 #${parsed.id}`, value: 'article' },
      ],
      { placeHolder: '这个编号是哪一种？' }
    );
    if (!pick) return undefined;
    return pick.value === 'contest' ? showContest(parsed.id) : showArticle(parsed.id);
  }

  const key = findProblemKeyInText(text);
  if (key) return showProblem(key);
  throw new Error(`无法识别「${String(text).slice(0, 40)}」，请输入题号（如 CodeForces-1A、洛谷-P1001）或链接`);
}

/* ------------------------------------------------------------------ */
/* 提交本地代码                                                        */
/* ------------------------------------------------------------------ */

/** 每种 OJ 上次用过的语言 id，存在 globalState 里，下次直接复用 => 真正的「一键」 */
function languageMemoryKey(oj) {
  return `vjudgeHelper.language.${oj || 'unknown'}`;
}

function getRememberedLanguage(oj) {
  if (!appContext) return undefined;
  try {
    return appContext.globalState.get(languageMemoryKey(oj));
  } catch {
    return undefined;
  }
}

function rememberLanguage(oj, id) {
  if (!appContext || id === undefined || id === null || id === '') return;
  try {
    appContext.globalState.update(languageMemoryKey(oj), String(id));
  } catch {
    /* globalState 不可用时忽略 */
  }
}

/** 状态栏常驻一条判题进度，免得用户不知道提交到哪一步了 */
function setJudgeStatus(text, tooltip, url) {
  if (!judgeItem) return;
  judgeItem.text = text;
  judgeItem.tooltip = tooltip || text;
  judgeItem.command = url
    ? { title: '打开提交记录', command: 'vjudgeHelper.internal.openUrl', arguments: [url] }
    : undefined;
  judgeItem.show();
}

function hideJudgeStatusLater(delay = 60000) {
  if (judgeHideTimer) clearTimeout(judgeHideTimer);
  judgeHideTimer = setTimeout(() => {
    judgeHideTimer = null;
    if (judgeItem) judgeItem.hide();
  }, delay);
}

/** 面板 / 命令带来的题目上下文 */
function normalizeTarget(target) {
  return {
    key: String(target.key || '').trim(),
    title: target.title || '',
    contestId: target.contestId ? String(target.contestId) : '',
    problemNum: target.problemNum ? String(target.problemNum).toUpperCase() : '',
    contestTitle: target.contestTitle || '',
    // 比赛快照版本（提交时原样回传）
    contestVersion: target.contestVersion ? String(target.contestVersion) : '',
    // 比赛结束时间（毫秒）：结束后比赛通道关闭，提交要改走补题
    contestEnd: Number(target.contestEnd) || 0,
  };
}

/** 这道题的比赛是否已经结束（结束后只能补题，不再计入榜单） */
function contestIsOver(target) {
  if (!target || !target.contestId) return false;
  const end = Number(target.contestEnd) || 0;
  return !!end && Date.now() > end;
}

/**
 * 当前要提交的题目。
 * 优先用命令/面板传来的，其次用「正在看的题目」（内存 + globalState 持久化），
 * 都不行才让用户挑——不再直接弹一个空白输入框。
 */
function resolveSubmitTarget(options = {}) {
  if (options.key) return normalizeTarget(options);

  if (currentProblem && currentProblem.key) return normalizeTarget(currentProblem);

  const saved = store.getLastProblem();
  if (saved && saved.key) {
    currentProblem = normalizeTarget(saved);
    return normalizeTarget(saved);
  }
  return null;
}

/** 从文件名里猜题号：2275D.cpp / CodeForces-2275D.cpp / abc300_c.py */
function guessTargetsFromFile(document) {
  const fileName = (document && (document.fileName || (document.uri && document.uri.fsPath))) || '';
  const base = fileName.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  if (!base) return [];
  const out = [];
  if (/^[A-Za-z]+-[A-Za-z0-9_]+$/.test(base)) out.push({ key: base, from: '文件名' });
  const tail = `-${base}`;
  const seen = new Set(out.map((o) => o.key.toLowerCase()));
  const pool = [...store.getHistory().filter((h) => h.kind === 'problem'), ...store.getProblems()];
  for (const item of pool) {
    const key = item.key || item.id;
    if (!key || !String(key).toLowerCase().endsWith(tail.toLowerCase())) continue;
    if (seen.has(String(key).toLowerCase())) continue;
    seen.add(String(key).toLowerCase());
    out.push({ key, from: '文件名', title: item.title || '' });
  }
  return out;
}

async function askSubmitTarget() {
  const items = [];
  const push = (target, label, description, detail) => {
    items.push({ label, description, detail, target: normalizeTarget(target) });
  };

  const document = currentCodeDocument();
  for (const guess of guessTargetsFromFile(document)) {
    push(guess, `$(file-code) ${guess.key}`, `来自${guess.from}`, '回车即可提交到这道题');
  }

  if (currentProblem && currentProblem.key) {
    push(
      currentProblem,
      `$(bookmark) ${currentProblem.key}`,
      currentProblem.contestId
        ? `比赛 #${currentProblem.contestId} · ${currentProblem.problemNum || ''} 题`
        : '最近打开的题目',
      currentProblem.title || ''
    );
  }

  const recent = store.getHistory().filter((h) => h.kind === 'problem');
  for (const item of recent.slice(0, 8)) {
    if (currentProblem && item.id === currentProblem.key) continue;
    push({ key: item.id, title: item.title }, `$(history) ${item.id}`, '最近打开', item.title || '');
  }

  items.push({ label: '$(edit) 输入题号 / 题目链接…', description: '手动指定', target: 'input' });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'VJudge：提交到哪道题',
    placeHolder: '选一道题（先在面板里打开题目，以后就不用再选了）',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return null;

  if (picked.target !== 'input') return picked.target;

  const input = await vscode.window.showInputBox({
    title: 'VJudge：提交到哪道题',
    prompt: '题号或题目链接',
    placeHolder: 'CodeForces-1A / 洛谷-P1001 / https://vjudge.net/problem/CodeForces-1A',
    ignoreFocusOut: true,
  });
  if (!input) return null;
  const parsed = parseInput(input, session.baseUrl);
  if (parsed.kind === 'contestProblem') {
    const hit = await client.resolveContestProblem(parsed.contestId, parsed.index);
    return normalizeTarget({
      key: hit.key,
      problemNum: parsed.index,
      contestId: parsed.contestId,
      ...(await contestMetaOf(parsed.contestId)),
    });
  }
  if (parsed.kind !== 'problem') throw new Error('请输入题号（如 CodeForces-1A、洛谷-P1001）或题目链接');
  return normalizeTarget({ key: parsed.key });
}

/**
 * 选语言：
 *   1. 上次这道 OJ 用过的语言还在列表里、且和当前文件同族 → 直接返回（不打断，一键提交）
 *   2. 否则弹列表，把最合适的（C++17 / Python3 …）排在第一并预选
 *   3. 拿不到语言列表（有些 OJ 不公开）→ 让用户填语言 id，并记住
 */
async function chooseSubmitLanguage({ problem, key, family }) {
  const oj = (problem && problem.oj) || splitProblemKey(key).oj || '';
  const remembered = getRememberedLanguage(oj);

  let options = [];
  try {
    options = await client.problemLanguages(problem || { key });
  } catch {
    options = [];
  }

  if (!options.length) {
    if (remembered) return { id: String(remembered), name: String(remembered), remembered: true };
    const value = await vscode.window.showInputBox({
      title: `提交语言 · ${key}`,
      prompt: 'VJudge 没给出这道题的语言列表，请填提交页里语言的编号或名称（填过一次就会记住）',
      placeHolder: '54 / C++17 / python3',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? undefined : '请填写语言编号'),
    });
    if (!value || !value.trim()) return null;
    return { id: value.trim(), name: value.trim() };
  }

  if (remembered) {
    const hit = options.find((item) => String(item.id) === String(remembered));
    if (hit && (!family || submitLib.languageScore(hit, family) >= 0)) {
      return { ...hit, remembered: true };
    }
  }

  const ordered = submitLib.sortLanguageOptions(options, family);
  const items = ordered.map((item, index) => {
    const tags = [];
    if (index === 0 && family) tags.push('推荐');
    if (remembered && String(item.id) === String(remembered)) tags.push('上次使用');
    return { label: item.name, description: tags.join(' · '), language: item };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `提交语言 · ${key}`,
    placeHolder: family ? `按文件类型推荐 ${submitLib.familyLabel(family) || family}` : '选择提交语言',
    matchOnDescription: true,
  });
  if (!picked) return null;
  return picked.language;
}

function describeTarget(target, practice = false, contestOver = false) {
  if (target.contestId && target.problemNum) {
    const tag = practice ? '，按补题提交' : contestOver ? '，比赛已结束，不计入榜单' : '';
    return `比赛 #${target.contestId} 的 ${target.problemNum} 题（${target.key}）${tag}`;
  }
  return target.key;
}

/** 通知 / 状态栏里用的一行标题：比赛题带上比赛信息 */
function targetLabel(target) {
  return target.contestId && target.problemNum
    ? `比赛 #${target.contestId} ${target.problemNum} 题（${target.key}）`
    : target.key;
}

async function reportVerdict(target, solution, result, practice = false, contestOver = false, practiceReason = '') {
  const stillJudging = !solution || solution.processing === true;
  const label = targetLabel(target);
  const channel = result && result.contestId && result.problemNum ? 'contest' : 'problem';
  const note = practice
    ? `（走了练习通道${practiceReason ? `：${practiceReason}` : ''}，不计入比赛）`
    : contestOver
      ? '（比赛已结束，这条提交记在这场比赛下，不计入榜单）'
      : '';
  log.write('submit.verdict', {
    runId: result && result.runId,
    channel,
    contestId: (result && result.contestId) || '',
    problemNum: (result && result.problemNum) || '',
    statusType: solution ? solution.statusType : null,
    processing: stillJudging,
    note,
  });
  if (stillJudging) {
    setJudgeStatus(`$(clock) VJudge ${label} 判题中`, `已提交 #${result.runId}，还没出结果`, result.url);
    hideJudgeStatusLater(120000);
    vscode.window.showInformationMessage(
      `VJudge：${label} 已提交（#${result.runId}）${note}，评测结果还没出来，可以点状态栏查看`
    );
    return;
  }

  const verdict = submitLib.verdictOf(solution);
  const summary = submitLib.solutionSummary(solution) || verdict.text;
  const icon = verdict.level === 'accepted' ? '$(pass-filled)' : verdict.level === 'failed' ? '$(error)' : '$(clock)';
  setJudgeStatus(`${icon} VJudge ${label} ${verdict.text}`, `${summary} · #${result.runId}`, result.url);
  hideJudgeStatusLater();

  const text = `VJudge ${label}：${summary}${note}`;
  const action = '打开提交记录';
  const picked =
    verdict.level === 'failed'
      ? await vscode.window.showWarningMessage(text, action)
      : await vscode.window.showInformationMessage(text, action);
  if (picked === action) openExternal(result.url);
}

/** 最近一次激活过的编辑器文档：面板获得焦点时 activeTextEditor 可能为 undefined */
let lastEditorDocument = null;

/** 提交时拿「当前正在编辑的代码」：优先 activeTextEditor，其次最近用过的文档 */
function currentCodeDocument() {
  const active = vscode.window.activeTextEditor;
  if (active && active.document) return active.document;
  if (lastEditorDocument && !lastEditorDocument.isClosed) return lastEditorDocument;
  return null;
}

/**
 * 提交方式「自己的账号」：挑一个能用的 OJ 账号绑定。
 *
 * Codeforces 之类的题在 VJudge 上不允许默认账号代交（method=0 会被拒：
 * submit_method.not_allowed），必须用你自己在该 OJ 上绑定的账号（method=1 + bindingId）。
 * 没有可用的绑定就提示去绑，返回 null。
 */
async function ensureOwnAccount(oj) {
  const name = oj || '该 OJ';
  const manageUrl = `${session.baseUrl}/user/remoteAccounts${oj ? `?oj=${encodeURIComponent(oj)}` : ''}`;
  let accounts = [];
  try {
    accounts = await withProgress(`正在读取 ${name} 账号绑定…`, () => client.fetchRemoteAccounts(oj));
  } catch {
    accounts = [];
  }

  const ready = accounts.filter((a) => a.ready);
  if (!ready.length) {
    const action = '打开账号绑定页';
    const reason = accounts.length
      ? `${name} 账号的登录状态已失效`
      : `还没有绑定 ${name} 账号`;
    const picked = await vscode.window.showWarningMessage(
      `VJudge 不允许用默认账号提交这道题，需要用它代交的「自己的 ${name} 账号」。\n${reason}，绑定（或重新登录）之后再提交。`,
      action
    );
    if (picked === action) openExternal(manageUrl);
    return null;
  }

  const remembered = store.getOwnAccount(oj);
  if (ready.length === 1) {
    store.setOwnAccount(oj, ready[0].id).catch(() => {});
    return ready[0];
  }
  const ordered = [...ready].sort((a, b) => {
    if (a.id === remembered) return -1;
    if (b.id === remembered) return 1;
    return 0;
  });
  const picked = await vscode.window.showQuickPick(
    ordered.map((a) => ({
      label: a.display || a.accountId || a.id,
      description: a.id === remembered ? '上次使用' : '',
      account: a,
    })),
    { title: `用哪个 ${name} 账号提交`, placeHolder: '选一个账号（也可以在网页上解绑多余的）' }
  );
  if (!picked) return null;
  store.setOwnAccount(oj, picked.account.id).catch(() => {});
  return picked.account;
}

/**
 * 提交当前编辑器里的代码。
 * @param {{key?: string, title?: string, contestId?: string, problemNum?: string}} [options]
 */
async function submitCurrentCode(options = {}) {
  const document = currentCodeDocument();
  if (!document) throw new Error('先在编辑器里打开要提交的代码文件，再执行提交');
  const code = document.getText();
  if (!code.trim()) throw new Error('当前文件是空的，没有可提交的代码');

  const status = await session.checkLogin();
  if (!status.loggedIn) {
    throw new LoginRequiredError(`提交代码需要先登录 VJudge（${status.message}）`);
  }

  const target = resolveSubmitTarget(options) || (await askSubmitTarget());
  if (!target) return;

  log.write('submit.target', {
    key: target.key,
    contestId: target.contestId || '',
    problemNum: target.problemNum || '',
    contestEnd: target.contestEnd || 0,
    from: options.key ? '面板/命令' : '当前题目',
    file: (document.fileName || '').split(/[\\/]/).pop() || '',
  });

  // 比赛结束后网页上照样能从比赛页提交：VJudge 会把这条记在这场比赛下（练习模式），
  // 只是不计入榜单。所以先照常走比赛通道，等服务端明确说「比赛已结束/关闭」再退回练习通道。
  let practice = false;
  const contestOver = contestIsOver(target);
  const label = targetLabel(target);

  // 题面里的 dataJson 带着语言列表；拿不到（比如题目被隐藏）就退回 /util/cfg，不阻塞提交
  let problem = null;
  try {
    problem = await withProgress(`正在读取 ${target.key}…`, () => client.fetchProblem(target.key));
  } catch (err) {
    if (err && err.code === 'LOGIN_REQUIRED') throw err;
    problem = null;
  }

  const fileName = document.fileName || (document.uri && document.uri.fsPath) || '';
  const family = submitLib.detectLanguageFamily(fileName, document.languageId);
  const language = await chooseSubmitLanguage({ problem, key: target.key, family });
  if (!language) return;

  // 这道题允许的提交方式。Codeforces 的题在 VJudge 上只允许 [自己的账号, 存档]，
  // 默认账号（直接代交源码）会被服务端拒成 submit_method.not_allowed
  const oj = (problem && problem.oj) || splitProblemKey(target.key).oj;
  const methods = submitLib.submitMethodsOf(problem);
  let method = 0;
  let bindingId = '';
  let ownAccount = null;
  if (!methods.defaultAccount) {
    if (methods.ownAccount) {
      ownAccount = await ensureOwnAccount(oj);
      if (!ownAccount) return; // 已经提示过用户去绑定账号
      method = 1;
      bindingId = ownAccount.id;
    } else if (methods.known) {
      throw new Error(`这道题在 VJudge 上只允许「存档」提交（不判题），插件暂不支持`);
    }
  }

  const methodNote =
    method === 1
      ? `\n提交方式：你在 ${oj} 上绑定的账号${ownAccount && ownAccount.display ? `（${ownAccount.display}）` : ''}`
      : '';

  if (config().get('submitConfirm') === true) {
    const shortName = fileName ? fileName.split(/[\\/]/).pop() : '未命名文件';
    const answer = await vscode.window.showWarningMessage(
      `把 ${shortName}（${code.split('\n').length} 行）提交到 ${describeTarget(target, practice, contestOver)}？\n语言：${language.name}${methodNote}`,
      { modal: true },
      '提交'
    );
    if (answer !== '提交') return;
  }

  // 比赛通道要回传「比赛快照版本」（网页是 version: St.version），漏了服务端直接 400。
  // 老记忆里没有这个字段，就现拉一次比赛数据补上。
  let contestVersion = target.contestVersion || '';
  if (!practice && target.contestId && target.problemNum && !contestVersion) {
    try {
      const contest = await withProgress(`正在读取比赛 #${target.contestId}…`, () =>
        client.fetchContest(target.contestId)
      );
      contestVersion = contest && contest.version ? String(contest.version) : '';
    } catch {
      /* 拉不到就照原样发，服务端报错会写进日志 */
    }
    if (contestVersion && currentProblem && currentProblem.key === target.key) {
      currentProblem = { ...currentProblem, contestVersion };
      store.setLastProblem(currentProblem).catch(() => {});
    }
    log.write('submit.contest_version', { contestId: target.contestId, version: contestVersion });
  }

  const buildPayload = () => ({
    key: target.key,
    code,
    language: language.id,
    contestId: practice ? '' : target.contestId,
    problemNum: practice ? '' : target.problemNum,
    method,
    bindingId,
    open: config().get('submitOpen') === true,
    // 比赛提交要带比赛版本 + 比赛密码（网页端也会带空串）
    version: practice ? '' : contestVersion,
    accessCode: practice ? undefined : '',
  });

  const attemptSubmit = async (caption) => {
    try {
      return { ok: true, result: await withProgress(caption, () => client.submitCode(buildPayload())) };
    } catch (err) {
      return { ok: false, err };
    }
  };

  let attempt = await attemptSubmit(`正在提交 ${label}…`);
  log.write('submit.attempt', {
    channel: practice || !target.contestId ? 'problem' : 'contest',
    ok: attempt.ok,
    error: attempt.ok ? '' : String((attempt.err && attempt.err.message) || ''),
    i18nKey: attempt.ok ? '' : String((attempt.err && attempt.err.i18nKey) || ''),
  });

  // ① 服务端说比赛通道已关闭（赛后不接受、或比赛没报名）→ 改走补题
  let practiceReason = '';
  if (
    !attempt.ok &&
    !practice &&
    target.contestId &&
    target.problemNum &&
    submitLib.isContestClosedError(attempt.err)
  ) {
    practice = true;
    practiceReason = String((attempt.err && attempt.err.message) || '比赛通道已关闭');
    log.write('submit.fallback_practice', { contestId: target.contestId, reason: practiceReason });
    vscode.window.setStatusBarMessage(
      `比赛 #${target.contestId} 的比赛通道被拒（${practiceReason}），已改成练习通道提交`,
      8000
    );
    attempt = await attemptSubmit('比赛通道被拒，改为练习通道提交…');
  }

  // ② 服务端说这个提交方式不允许 → 换成「自己的账号」再来一次
  if (!attempt.ok && method === 0 && submitLib.isSubmitMethodError(attempt.err)) {
    const fallback = await ensureOwnAccount(oj);
    if (!fallback) return; // 已经提示过用户去绑定账号
    method = 1;
    bindingId = fallback.id;
    ownAccount = fallback;
    log.write('submit.fallback_own_account', { oj, bindingId });
    attempt = await attemptSubmit(`正在用你的 ${oj} 账号提交…`);
  }

  if (!attempt.ok) {
    log.write('submit.failed', {
      message: String((attempt.err && attempt.err.message) || ''),
      i18nKey: String((attempt.err && attempt.err.i18nKey) || ''),
    });
    throw attempt.err;
  }
  const result = attempt.result;
  log.write('submit.done', {
    runId: result.runId,
    channel: result.contestId && result.problemNum ? 'contest' : 'problem',
    contestId: result.contestId || '',
    problemNum: result.problemNum || '',
    method,
  });

  if (method === 1) {
    vscode.window.setStatusBarMessage(
      `已用你在 ${oj} 上绑定的账号提交${ownAccount && ownAccount.display ? `（${ownAccount.display}）` : ''}`,
      4000
    );
  }

  // 赛后提交走比赛通道时，VJudge 记的是「练习」，榜单不会再变
  if (contestOver && !practice) {
    vscode.window.setStatusBarMessage(
      `比赛 #${target.contestId} 已结束：这条提交记在这场比赛下（练习模式），不计入榜单`,
      6000
    );
  }

  rememberLanguage(
    (problem && problem.oj) || splitProblemKey(target.key).oj,
    language.id
  );
  lastSolutionUrl = result.url;
  setJudgeStatus(`$(sync~spin) VJudge ${label} 判题中…`, `已提交 #${result.runId}，等待评测`, result.url);
  // 比赛结束后榜单已经封存，刷了也白刷
  if (target.contestId && !practice && !contestOver) refreshStandingsSoon(target.contestId);

  const timeoutMs = Math.max(Number(config().get('judgeTimeout')) || 120, 10) * 1000;
  let solution = null;
  try {
    solution = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VJudge：${label} 判题中…`, cancellable: true },
      async (progress, token) =>
        client.waitForVerdict(result.runId, {
          timeoutMs,
          isCancelled: () => token.isCancellationRequested,
          onTick: (latest) => {
            const current = submitLib.verdictOf(latest);
            setJudgeStatus(
              `$(sync~spin) VJudge ${label} ${current.text}`,
              `已提交 #${result.runId}`,
              result.url
            );
          },
        })
    );
  } catch (err) {
    vscode.window.setStatusBarMessage(`VJudge: 已提交，但查不到评测结果（${err.message}）`, 6000);
  }

  await reportVerdict(target, solution, result, practice, contestOver, practiceReason);
  if (target.contestId && !practice && !contestOver) refreshStandingsSoon(target.contestId);
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

const commands = {
  openProblem: wrap(async () => {
    const input = await vscode.window.showInputBox({
      title: 'VJudge：打开题目',
      prompt: '题号、题目链接，或比赛内题目链接（比赛链接 + #problem/A）',
      placeHolder: 'CodeForces-1A / 洛谷-P1001 / https://codeforces.com/problemset/problem/1/A',
      ignoreFocusOut: true,
    });
    if (!input) return;
    await resolveAndOpen(input, 'input');
  }),

  openProblemFromClipboard: wrap(async () => {
    const text = (await vscode.env.clipboard.readText()).trim();
    if (!text) throw new Error('剪贴板是空的');
    await resolveAndOpen(text, 'clipboard');
  }),

  openProblemFromSelection: wrap(async () => {
    const editor = vscode.window.activeTextEditor;
    let text = '';
    if (editor) {
      const selection = editor.selection;
      text = selection.isEmpty
        ? editor.document.lineAt(selection.active.line).text
        : editor.document.getText(selection);
    }
    text = (text || '').trim();
    if (!text) text = (await vscode.env.clipboard.readText()).trim();
    if (!text) throw new Error('没有选中内容，剪贴板也是空的');

    const key = findProblemKeyInText(text);
    if (key) return showProblem(key);
    return resolveAndOpen(text, 'selection');
  }),

  openContest: wrap(async () => {
    const value = await vscode.window.showInputBox({
      title: 'VJudge：打开比赛',
      prompt: '比赛 ID 或比赛链接',
      placeHolder: '863093 / https://vjudge.net/contest/863093',
      ignoreFocusOut: true,
    });
    if (!value) return;
    const parsed = parseInput(value, session.baseUrl);
    if (parsed.kind === 'contest') return showContest(parsed.id);
    if (parsed.kind === 'contestProblem') {
      const hit = await withProgress('正在解析比赛题目…', () =>
        client.resolveContestProblem(parsed.contestId, parsed.index)
      );
      return showProblem(hit.key, {
        contestId: parsed.contestId,
        problemNum: parsed.index,
        ...(await contestMetaOf(parsed.contestId)),
      });
    }
    if (/^\d+$/.test(value.trim())) return showContest(value.trim());
    throw new Error('请输入比赛 ID 或比赛链接');
  }),

  openArticle: wrap(async () => {
    const value = await vscode.window.showInputBox({
      title: 'VJudge：打开文章',
      prompt: '文章 ID 或文章链接',
      placeHolder: '1 / https://vjudge.net/article/1',
      ignoreFocusOut: true,
    });
    if (!value) return;
    const parsed = parseInput(value, session.baseUrl);
    if (parsed.kind === 'article') return showArticle(parsed.id);
    if (/^\d+$/.test(value.trim())) return showArticle(value.trim());
    throw new Error('请输入文章 ID 或文章链接');
  }),

  openGroup: wrap(async () => {
    const value = await vscode.window.showInputBox({
      title: 'VJudge：打开团队',
      prompt: '团队链接、团队短名，或团队名称（名称会自动搜索）',
      placeHolder: 'https://vjudge.net/group/sfera-pg / sfera-pg / SFERA PG',
      ignoreFocusOut: true,
    });
    if (!value || !value.trim()) return;
    const parsed = parseInput(value, session.baseUrl);
    if (parsed.kind === 'group') return showGroup(parsed.name);
    if (parsed.kind === 'url') return openExternal(parsed.url);
    return showGroup(value.trim());
  }),

  searchGroup: wrap(async () => {
    const keyword = await vscode.window.showInputBox({
      title: 'VJudge：搜索团队',
      prompt: '输入团队名称关键词',
      placeHolder: 'ACM / 集训队 / code',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? undefined : '请输入关键词'),
    });
    if (!keyword) return;

    const cards = await withProgress('正在搜索团队…', () => client.searchGroups(keyword));
    if (!cards.length) {
      vscode.window.showInformationMessage(`没有找到名称包含「${keyword.trim()}」的团队`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      cards.map((g) => ({
        label: g.name,
        description: `${g.shortName} · ${g.members} 人`,
        detail: [
          g.isPublic ? '公开' : '私密',
          `比赛 ${g.runningContests + g.scheduledContests + g.endedContests} 场`,
          g.leaderName ? `队长 ${g.leaderName}` : '',
          g.brief,
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 180),
        group: g,
      })),
      { title: `共 ${cards.length} 个团队`, placeHolder: '选择要打开的团队', matchOnDetail: true }
    );
    if (!pick) return;
    return showGroup(pick.group.shortName);
  }),

  openRandomProblem: wrap(async () => {
    const key = await withProgress('正在挑选一道随机题…', () => client.randomProblem());
    await showProblem(key);
  }),

  submitCode: wrap(async () => {
    await submitCurrentCode();
  }),

  submitToProblem: wrap(async () => {
    // 强制走「选择题目」，用来提交到手边没打开的题（比如别人的题单里的下一题）
    const target = await askSubmitTarget();
    if (!target) return;
    await submitCurrentCode(target);
  }),

  openLastSolution: wrap(async () => {
    if (!lastSolutionUrl) {
      vscode.window.showInformationMessage('还没有提交过代码，先执行「VJudge: 提交当前文件代码」');
      return;
    }
    await openExternal(lastSolutionUrl);
  }),

  /** 提交日志：每次提交打到哪条通道、服务端怎么回的，都记在这个文件里 */
  showSubmitLog: wrap(async () => {
    const file = log.logPath();
    if (!file) {
      vscode.window.showInformationMessage('还没有写过提交日志（扩展刚启动时日志文件才建立）');
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showInformationMessage(`还没有写过提交日志：${file}`);
    }
  }),

  login: wrap(async () => {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(account) 用用户名和密码登录',
          description: '自动获取会话 Cookie（密码保存在系统密钥库）',
          value: 'password',
        },
        {
          label: '$(clippy) 粘贴浏览器 Cookie',
          description: '在浏览器登录后复制 Cookie，最稳妥的方式',
          value: 'cookie',
        },
      ],
      { title: 'VJudge 登录方式', ignoreFocusOut: true }
    );
    if (!choice) return;
    if (choice.value === 'password') return commands._loginWithPassword();
    return commands.setCookie();
  }),

  _loginWithPassword: wrap(async () => {
    const username = await vscode.window.showInputBox({
      title: 'VJudge 用户名',
      value: config().get('username') || '',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? undefined : '请输入用户名'),
    });
    if (!username) return;

    const password = await vscode.window.showInputBox({
      title: 'VJudge 密码',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v ? undefined : '请输入密码'),
    });
    if (!password) return;

    const result = await withProgress('正在登录 VJudge…', () => session.login(username, password));
    if (!result.ok) {
      vscode.window
        .showErrorMessage(`VJudge: ${result.message}`, '改用粘贴 Cookie')
        .then((pick) => {
          if (pick) commands.setCookie();
        });
      return;
    }
    await config().update('username', username.trim(), vscode.ConfigurationTarget.Global);
    client.clearCache();
    treeProvider.refresh();
    updateStatusBar();
    vscode.window.showInformationMessage('VJudge: 登录成功');
  }),

  setCookie: wrap(async () => {
    const existing = session.jar.isEmpty ? '' : session.jar.toString();
    const value = await vscode.window.showInputBox({
      title: '粘贴 VJudge Cookie',
      prompt: '浏览器登录 VJudge 后，F12 → Network → 任意请求 → 复制 Cookie 请求头；JSESSIONID 与 JSESSlONID 是关键项',
      value: existing,
      ignoreFocusOut: true,
      placeHolder: 'JSESSIONID=xxx; JSESSlONID=yyy',
      validateInput: (v) => (v && v.includes('=') ? undefined : '请粘贴完整的 Cookie（形如 name=value; name2=value2）'),
    });
    if (!value) return;
    const normalized = session.normalizeCookieInput(value);
    await session.saveCookie(normalized);
    const status = await session.checkLogin({ force: true });
    client.clearCache();
    treeProvider.refresh();
    updateStatusBar();
    if (status.loggedIn) {
      vscode.window.showInformationMessage('VJudge: 凭据已保存，登录状态有效');
    } else {
      vscode.window.showWarningMessage(`VJudge: 凭据已保存，但校验未通过（${status.message}）`);
    }
  }),

  checkLogin: wrap(async () => {
    const status = await withProgress('正在检查登录状态…', () => session.checkLogin({ force: true }));
    client.clearCache();
    updateStatusBar();
    if (status.loggedIn) {
      vscode.window.showInformationMessage('VJudge: 已登录');
    } else {
      vscode.window
        .showWarningMessage(`VJudge: ${status.message}`, '去登录')
        .then((pick) => pick && commands.login());
    }
  }),

  logout: wrap(async () => {
    const pick = await vscode.window.showWarningMessage('确定要清除 VJudge 凭据吗？', { modal: true }, '清除');
    if (pick !== '清除') return;
    await session.logout();
    client.clearCache();
    treeProvider.refresh();
    updateStatusBar();
    vscode.window.showInformationMessage('VJudge: 已清除凭据');
  }),

  refresh: wrap(async () => {
    client.clearCache();
    treeProvider.refresh({ clearContests: true });
  }),

  openInBrowser: wrap(async (node) => {
    const target = node && node.__node ? node.__node : node;
    const url = (target && target.url) || (lastOpened && lastOpened.url);
    if (url) return openExternal(url);
    return openExternal(session.baseUrl);
  }),

  openHome: wrap(async () => openExternal(session.baseUrl)),

  clearHistory: wrap(async () => {
    await store.clearHistory();
    treeProvider.refresh();
    vscode.window.setStatusBarMessage('已清空浏览历史', 2000);
  }),

  toggleFavorite: wrap(async (node) => {
    const target = node && node.__node ? node.__node : node;
    if (target && target.type === 'favorite') {
      const isArticle = String(target.id).startsWith('fav-article-');
      const raw = String(target.id).replace(/^fav-(problem|article)-/, '');
      await store.removeFavorite(isArticle ? 'article' : 'problem', raw);
      treeProvider.refresh();
      vscode.window.setStatusBarMessage('已取消收藏', 2000);
      return;
    }
    if (target && target.key && target.type !== 'contest') {
      const added = await store.toggleProblem(target);
      vscode.window.setStatusBarMessage(added ? '已收藏' : '已取消收藏', 2000);
      treeProvider.refresh();
      return;
    }
    if (!target) {
      // 没有显式目标时：优先收藏「正在看的题目」（带比赛上下文一起恢复）
      if (currentProblem && currentProblem.key) {
        const added = await store.toggleProblem({ key: currentProblem.key, title: currentProblem.title });
        vscode.window.setStatusBarMessage(added ? '已收藏' : '已取消收藏', 2000);
        treeProvider.refresh();
        if (lastOpened && lastOpened.kind === 'problem') {
          await renderProblemPanel(currentProblem.key, currentProblem).catch(() => {});
        }
        return;
      }
      if (lastOpened && lastOpened.kind === 'article') {
        const added = await store.toggleArticle({ id: lastOpened.id, title: lastOpened.title });
        vscode.window.setStatusBarMessage(added ? '已收藏' : '已取消收藏', 2000);
        treeProvider.refresh();
        await showArticle(lastOpened.id).catch(() => {});
        return;
      }
    }
    vscode.window.showInformationMessage('请先打开一个题目或文章，再收藏');
  }),

  removeFavorite: wrap(async (node) => {
    const target = node && node.__node ? node.__node : node;
    if (!target) return;
    const isArticle = String(target.id).startsWith('fav-article-');
    const raw = String(target.id).replace(/^fav-(problem|article)-/, '');
    await store.removeFavorite(isArticle ? 'article' : 'problem', raw);
    treeProvider.refresh();
  }),

  openSettings: wrap(async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'vjudgeHelper');
  }),

  showMenu: wrap(async () => {
    const items = [
      { label: '$(book) 打开题目…', command: 'vjudgeHelper.openProblem' },
      { label: '$(clippy) 从剪贴板打开', command: 'vjudgeHelper.openProblemFromClipboard', description: '自动识别 OJ 链接' },
      { label: '$(trophy) 打开比赛…', command: 'vjudgeHelper.openContest' },
      { label: '$(organization) 打开团队…', command: 'vjudgeHelper.openGroup' },
      { label: '$(search) 搜索团队…', command: 'vjudgeHelper.searchGroup' },
      { label: '$(file-text) 打开文章…', command: 'vjudgeHelper.openArticle' },
      { label: '$(lightbulb) 随机来一道题', command: 'vjudgeHelper.openRandomProblem' },
      { label: '$(cloud-upload) 提交当前文件代码', command: 'vjudgeHelper.submitCode', description: '提交到当前正在看的题目（比赛题会自动交进比赛）' },
      { label: '$(cloud-upload) 提交到指定题目…', command: 'vjudgeHelper.submitToProblem' },
      { label: '$(account) 登录 / 更新凭据', command: 'vjudgeHelper.login' },
      { label: '$(check) 检查登录状态', command: 'vjudgeHelper.checkLogin' },
      { label: '$(refresh) 刷新侧边栏', command: 'vjudgeHelper.refresh' },
      { label: '$(globe) 打开 VJudge 首页', command: 'vjudgeHelper.openHome' },
      { label: '$(gear) 插件设置', command: 'vjudgeHelper.openSettings' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `VJudge Helper${session.hasCredentials ? ' · 已配置凭据' : ' · 未登录'}`,
      placeHolder: '选择要执行的操作',
    });
    if (pick) await vscode.commands.executeCommand(pick.command);
  }),
};

/* ------------------------------------------------------------------ */
/* 激活                                                                */
/* ------------------------------------------------------------------ */

let appContext;

function activate(context) {
  appContext = context;

  session = new Session(context, config);
  client = new VJudgeClient(session);
  store = new Store(context);
  treeProvider = new VJudgeTreeProvider(client, store, session);

  // 上次看的题目（含比赛上下文）——重新打开 VS Code 后提交仍然知道要交到哪
  const savedTarget = store.getLastProblem();
  if (savedTarget && savedTarget.key) currentProblem = normalizeTarget(savedTarget);

  // 提交日志：写到 logs/<会话>/window1/exthost/<扩展ID>/vjudge-submit.log
  outputLog =
    typeof vscode.window.createOutputChannel === 'function'
      ? vscode.window.createOutputChannel('VJudge Helper')
      : null;
  if (outputLog) context.subscriptions.push(outputLog);
  log.init({
    dir: context.logUri && context.logUri.fsPath ? context.logUri.fsPath : '',
    sink: outputLog ? (line) => outputLog.appendLine(line) : undefined,
  });
  log.write('activate', {
    version: context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : '',
    savedTarget: savedTarget
      ? { key: savedTarget.key, contestId: savedTarget.contestId || '', problemNum: savedTarget.problemNum || '' }
      : null,
    logFile: log.logPath(),
  });

  treeView = vscode.window.createTreeView('vjudgeHelper.explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusItem);

  // 判题进度单独占一条，避免和「VJudge 菜单」那条抢位置
  judgeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(judgeItem);

  // 内部命令（不出现在命令面板）
  const internal = {
    'vjudgeHelper.internal.openProblem': (key) => showProblem(key).catch(handleError),
    'vjudgeHelper.internal.openArticle': (id) => showArticle(id).catch(handleError),
    'vjudgeHelper.internal.openContest': (id) => showContest(id).catch(handleError),
    'vjudgeHelper.internal.openGroup': (name) => showGroup(name).catch(handleError),
    'vjudgeHelper.internal.openUrl': (url) => (url ? openExternal(url) : undefined),
  };
  for (const [id, fn] of Object.entries(internal)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

  for (const [name, fn] of Object.entries(commands)) {
    if (name.startsWith('_')) {
      // 内部复用，不注册
      continue;
    }
    context.subscriptions.push(vscode.commands.registerCommand(`vjudgeHelper.${name}`, fn));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('vjudgeHelper._loginWithPassword', commands._loginWithPassword)
  );

  context.subscriptions.push(session.onDidChange(() => updateStatusBar()));

  // 记住最近编辑过的文档：面板拿焦点时 activeTextEditor 会变成 undefined，
  // 这时「提交代码」仍然要能拿到刚才写的代码
  if (vscode.window.activeTextEditor) lastEditorDocument = vscode.window.activeTextEditor.document;
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document) lastEditorDocument = editor.document;
      })
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vjudgeHelper')) {
        updateStatusBar();
        client.clearCache();
      }
    })
  );

  session
    .init()
    .then(() => {
      updateStatusBar();
      if (config().get('autoRefreshContests')) treeProvider.refresh();
      return session.checkLogin();
    })
    .then(() => updateStatusBar())
    .catch(() => updateStatusBar());

  return { dispose() {} };
}

function deactivate() {
  stopStandingsPoll();
  if (judgeHideTimer) {
    clearTimeout(judgeHideTimer);
    judgeHideTimer = null;
  }
  session = undefined;
  client = undefined;
  store = undefined;
  treeProvider = undefined;
  treeView = undefined;
  statusItem = undefined;
  judgeItem = undefined;
  lastEditorDocument = null;
  currentProblem = null;
  lastOpened = null;
}

module.exports = { activate, deactivate };
