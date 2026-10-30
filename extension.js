'use strict';

const vscode = require('vscode');
const fsLib = require('fs');
const pathLib = require('path');

const { Session, LoginRequiredError } = require('./src/session');
const { VJudgeClient } = require('./src/vjudge');
const { Store } = require('./src/store');
const { VJudgeTreeProvider } = require('./src/explorer');
const { showPanel } = require('./src/webview/shell');
const {
  renderProblem,
  renderArticle,
  renderContest,
  renderGroup,
  renderStandingsInner,
  renderMessage,
  renderConversationInner,
  renderDiscussionPosts,
  renderSubmissions,
  renderSubmissionsBody,
  renderSubmissionDetail,
} = require('./src/webview/renderers');
const {
  parseInput,
  problemUrl,
  findProblemKeyInText,
  splitProblemKey,
  normalizeProblemKey,
  escapeHtml,
} = require('./src/util');
const submitLib = require('./src/submit');
const randomLib = require('./src/random');
const cphLib = require('./src/cph');
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
/**
 * 榜单是否把「赛后补题」算进去。
 * 只在当前比赛面板有效，换一场比赛时重置（否则上一场的开关会莫名带到下一场）。
 */
let standingsIncludePractice = false;
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
/* 传送样例到 CPH / CPH-NG                                              */
/* ------------------------------------------------------------------ */

/**
 * CPH 系的扩展 id 换过几次（老的 CPH 是 DivyanshuAgrawal.competitive-programming-helper），
 * 所以先按已知 id 找，找不到再按 package.json 的 name 兜底（fork / 改过 publisher 的情况）。
 */
const CPH_EXTENSIONS = [
  { kind: 'cph-ng', id: 'langningchen.cph-ng', label: 'CPH-NG' },
  { kind: 'cph', id: 'DivyanshuAgrawal.competitive-programming-helper', label: 'CPH' },
  { kind: 'cph', id: 'agrawal-d.cp-helper', label: 'CPH' },
];

function findCphExtension() {
  const api = vscode.extensions || {};
  const get = typeof api.getExtension === 'function' ? api.getExtension.bind(api) : null;
  for (const entry of CPH_EXTENSIONS) {
    const hit = (get && get(entry.id)) || null;
    if (hit) return { ...entry, extension: hit };
  }
  const all = Array.isArray(api.all) ? api.all : [];
  const loose = all.find((ext) => {
    const name = String((ext && ext.packageJSON && ext.packageJSON.name) || '');
    return name === 'cph-ng' || name === 'cph';
  });
  if (!loose) return null;
  const isNg = String((loose.packageJSON || {}).name) === 'cph-ng';
  return { kind: isNg ? 'cph-ng' : 'cph', id: loose.id, label: isNg ? 'CPH-NG' : 'CPH', extension: loose };
}

/** 端口：插件设置优先 → CPH-NG 自己的设置 → 默认 27121 */
function cphPortOf(target) {
  const override = Number(config().get('cphPort')) || 0;
  if (override > 0) return override;
  if (target && target.kind === 'cph-ng') {
    const ngConfig = cphNgConfig();
    const port = Number(ngConfig && ngConfig.get('companion.listenPort'));
    if (Number.isFinite(port) && port > 0) return port;
  }
  return cphLib.DEFAULT_PORT;
}

/** 我们随扩展带的 CPH-NG 路径脚本（接管后才生效） */
const CPH_PATH_SCRIPT_KEY = 'companion.customPathScript';
const CPH_SCRIPT_DECLINED = 'cph.scriptDeclined';
const CPH_LANG_MEMORY = 'cph.language';

function cphPathScriptFile() {
  const uri = appContext && appContext.extensionUri;
  const dir = uri && uri.fsPath ? uri.fsPath : '';
  return dir ? pathLib.join(dir, 'res', 'cph-ng-path.js') : '';
}

function cphNgConfig() {
  try {
    return vscode.workspace.getConfiguration('cph-ng');
  } catch {
    return null;
  }
}

/**
 * 让 CPH-NG 用我们的路径脚本决定「源文件放哪」。
 *
 * 默认脚本写死 `.cpp` 且只会放在工作区根目录，不接管就没法选语言、也没法挂到当前文件。
 * 只在它还是默认值（或者本来就是我们的）时自动接管；用户自己写过脚本就先问一句。
 */
async function ensureCphPathScript() {
  const script = cphPathScriptFile();
  if (!script || !fsLib.existsSync(script)) return { ok: false, reason: 'missing' };

  const cfg = cphNgConfig();
  if (!cfg) return { ok: false, reason: 'no-config' };

  const inspect = typeof cfg.inspect === 'function' ? cfg.inspect(CPH_PATH_SCRIPT_KEY) : null;
  const explicit = inspect ? inspect.workspaceValue || inspect.globalValue || '' : '';
  if (explicit === script) return { ok: true, script };

  // 升级扩展后安装目录会变（…-1.8.1 → …-1.8.2），旧值仍然算「我们自己的」，直接改成新路径
  const isOurs = /[\\/]res[\\/]cph-ng-path\.js$/i.test(String(explicit));
  const isDefault = !explicit || isOurs || /res[\\/]defaultScript\.js$/i.test(String(explicit));
  if (!isDefault) {
    if (appContext.globalState.get(CPH_SCRIPT_DECLINED) === explicit) {
      return { ok: false, reason: 'custom' };
    }
    const choice = await vscode.window.showWarningMessage(
      `CPH-NG 的路径脚本被改过（${explicit}），它决定「样例挂到哪个文件」。` +
        '要让 VJudge Helper 指定源文件和语言，得先接管这个脚本。',
      { modal: true },
      '接管（推荐）',
      '保持原样'
    );
    if (choice !== '接管（推荐）') {
      await appContext.globalState.update(CPH_SCRIPT_DECLINED, explicit);
      return { ok: false, reason: 'custom' };
    }
    await appContext.globalState.update(CPH_SCRIPT_DECLINED, undefined);
  }

  const target = inspect && inspect.workspaceValue ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  try {
    await cfg.update(CPH_PATH_SCRIPT_KEY, script, target);
  } catch (error) {
    log.write('cph.script.updateFailed', { message: error.message });
    return { ok: false, reason: 'failed' };
  }
  log.write('cph.script.takeover', { script, scope: target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'global' });
  return { ok: true, script };
}

/**
 * 「当前文件」= 提交时认的那份代码（Ctrl+Alt+Enter 用的就是它）。
 * 面板抢到焦点后 activeTextEditor 会变成 undefined，这时往后退回最近编辑过的文档，
 * 免得从面板里点「传送样例」时认不出你刚写的那份代码。
 */
function codeFilePath() {
  return cphLib.filePathOfDocument(currentCodeDocument());
}

function baseNameOf(file) {
  return String(file || '').split(/[\\/]/).pop() || file;
}

/** 新建文件放哪：跟正在写的文件放一起，其次工作区根目录 */
function folderForNewFile() {
  const current = codeFilePath();
  if (current) return pathLib.dirname(current);
  const folders = vscode.workspace.workspaceFolders;
  if (Array.isArray(folders) && folders.length && folders[0].uri) return folders[0].uri.fsPath;
  return '';
}

/** 语言选择；记住上次用的，下次直接排在第一位 */
async function pickCphLanguage(problem, folder) {
  const remembered = appContext.globalState.get(CPH_LANG_MEMORY);
  const list = cphLib.LANGUAGES.slice().sort((a, b) => (a.id === remembered ? -1 : b.id === remembered ? 1 : 0));
  const picked = await vscode.window.showQuickPick(
    list.map((lang) => ({
      label: lang.label,
      description: `.${lang.ext}`,
      detail: `${folder}${pathLib.sep}${cphLib.fileBaseName(problem)}.${lang.ext}`,
      lang,
    })),
    { placeHolder: '样例要送到哪种语言的源文件？（决定新建文件的扩展名）', title: '选择语言' }
  );
  if (!picked) return null;
  await appContext.globalState.update(CPH_LANG_MEMORY, picked.lang.id);
  return picked.lang;
}

/**
 * 问一句：样例挂到哪个文件上。
 *
 * 「当前文件」就是提交时认的那份（Ctrl+Alt+Enter / 面板上的「提交」用的是同一个），
 * 面板抢走焦点后也能认出来，所以它排在第一项——直接回车就是挂到这份代码上。
 *
 * @returns {Promise<{mode: 'new'|'current'|'auto', file?: string} | null>} null = 用户取消
 */
async function chooseCphTarget(problem, target) {
  const canChooseFile = target.kind === 'cph-ng';
  const configured = String(config().get('cphFileMode') || 'ask');
  const current = codeFilePath();
  const currentLang = current ? cphLib.languageOf(current) : null;

  if (canChooseFile && configured === 'current' && current && currentLang) {
    return { mode: 'current', file: current };
  }
  if (canChooseFile && configured === 'new') {
    const folder = folderForNewFile();
    if (!folder) return { mode: 'auto' };
    const remembered = cphLib.languageById(String(config().get('cphLanguage') || 'ask'));
    const lang = remembered || (await pickCphLanguage(problem, folder));
    if (!lang) return null;
    return { mode: 'new', file: pathLib.join(folder, `${cphLib.fileBaseName(problem)}.${lang.ext}`) };
  }
  if (configured === 'auto' || !canChooseFile) return { mode: 'auto' };

  const items = [];
  if (current && currentLang) {
    const record = cphRecordPath(current);
    const hasProblem = !!record && fsLib.existsSync(record);
    items.push({
      id: 'current',
      label: `$(file-code) 用当前文件：${baseNameOf(current)}`,
      description: hasProblem
        ? `${currentLang.label} · CPH-NG 里已有这道题，样例会被换成题面里的`
        : `${currentLang.label} · 就是 Ctrl+Alt+Enter 提交的那个文件`,
      detail: current,
    });
  }
  const folder = folderForNewFile();
  if (folder) {
    items.push({
      id: 'new',
      label: '$(new-file) 新建一个源文件',
      description: `${cphLib.fileBaseName(problem)}.cpp 之类`,
      detail: `放在 ${folder}，下一步选语言`,
    });
  }
  // 什么都没有时就别问了，1.8.0 的老行为照走
  if (!items.length) return { mode: 'auto' };
  items.push({
    id: 'auto',
    label: `$(wrench) 让 ${target.label} 自己决定`,
    description: '按它默认的路径脚本建题（一般是工作区里的 .cpp）',
    detail: '和浏览器里的 Competitive Companion 发过去一样',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `这 ${Array.isArray(problem.samples) ? problem.samples.length : 0} 组样例送到哪里？`,
    title: `传送样例至 ${target.label}`,
  });
  if (!picked) return null;
  if (picked.id === 'auto') return { mode: 'auto' };
  if (picked.id === 'current') return { mode: 'current', file: current };

  const lang = await pickCphLanguage(problem, folder);
  if (!lang) return null;
  return { mode: 'new', file: pathLib.join(folder, `${cphLib.fileBaseName(problem)}.${lang.ext}`) };
}

/** 等 CPH-NG 把文件建出来（它收题是异步的，POST 返回 ok 时文件可能还没落地） */
async function waitForFile(file, timeout) {
  const deadline = Date.now() + (timeout || 4000);
  while (Date.now() < deadline) {
    if (fsLib.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fsLib.existsSync(file);
}

/** CPH-NG 的题目记录：`<工作区>/.cph-ng/<相对路径>.bin`（算不出来就返回空串） */
function cphRecordPath(file) {
  if (!file || typeof vscode.workspace.getWorkspaceFolder !== 'function') return '';
  try {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    const root = folder && folder.uri && folder.uri.fsPath;
    return cphLib.recordPathFor(root, file);
  } catch {
    return '';
  }
}

function mtimeOf(file) {
  try {
    return fsLib.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Windows 上大小写不敏感，比较路径前统一一下 */
function sameFile(a, b) {
  if (!a || !b) return false;
  try {
    return pathLib.resolve(a).toLowerCase() === pathLib.resolve(b).toLowerCase();
  } catch {
    return a === b;
  }
}

/**
 * 把 CPH-NG 内存里「这个文件的题」挤出去。
 *
 * 它导入时先写记录文件，然后 `repo.loadByPath(path)`——而这个查找**先看内存**
 * （`problem.isRelated()` 比 src.path），命中就直接返回那道旧题，磁盘上刚写的新题看都不看。
 * 结果就是：文件真的写了（`.cph-ng/*.bin` 里样例齐全），侧边栏却还是旧题、样例是空的。
 *
 * 换个活动文本编辑器会触发它的 `onActiveEditorChanged()`：先把旧题 persist 到磁盘
 * 再从内存里卸掉。之后再导入就能正常读到新记录。所以这里先切走、等它存完盘，再发。
 *
 * @returns {Promise<object|null>} 我们自己开的临时文档（发完要关掉）
 */
async function detachCphActiveProblem(targetFile, record) {
  const before = mtimeOf(record);
  let scratch = null;
  try {
    const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all) ? vscode.window.tabGroups.all : [];
    const other = groups
      .reduce((all, group) => all.concat(Array.isArray(group.tabs) ? group.tabs : []), [])
      .find((tab) => {
        const uri = tab && tab.input && tab.input.uri;
        return uri && uri.scheme === 'file' && uri.fsPath !== targetFile;
      });
    if (other) {
      const doc = await vscode.workspace.openTextDocument(other.input.uri);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    } else {
      // 没有别的标签页可切：临时开一个空白文档，发完再关
      scratch = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });
      await vscode.window.showTextDocument(scratch, { preview: true, preserveFocus: false });
    }
  } catch (error) {
    log.write('cph.detach.failed', { message: error && error.message });
    return { scratch: null, confirmed: false };
  }

  // 它 persist 时会重写记录文件，等这个时间戳变一下就算卸载完了（一般几十毫秒，最多等 1.2 秒）
  for (let i = 0; i < 10; i += 1) {
    if (mtimeOf(record) !== before) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const confirmed = mtimeOf(record) !== before;
  log.write('cph.detach', { file: record, changed: confirmed });
  return { scratch, confirmed };
}

/** 关掉我们临时开的空白文档（按标签页找，别误关用户自己的） */
async function closeScratchEditor(doc) {
  if (!doc || !doc.uri || !vscode.window.tabGroups) return;
  const want = doc.uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs || []) {
      const uri = tab && tab.input && tab.input.uri;
      if (uri && uri.scheme === 'untitled' && uri.toString() === want) {
        await vscode.window.tabGroups.close(tab, true);
        return;
      }
    }
  }
}

/**
 * 把样例按 Competitive Companion 的协议 POST 给 CPH / CPH-NG。
 *
 * CPH-NG 支持「指定源文件」：把绝对路径塞进 URL 片段，由我们随扩展带的路径脚本取出来，
 * 于是可以新建指定语言的源文件、或者直接挂到当前打开的文件上（文件已存在时它不会覆盖）。
 *
 * @returns {Promise<boolean>} 是否真的发出去了
 */
async function pushSamplesToCph(problem) {
  const target = findCphExtension();
  if (!target) {
    vscode.window
      .showWarningMessage('没检测到 CPH / CPH-NG 扩展，样例没地方送。', '我这就去装 CPH-NG')
      .then((choice) => {
        if (choice) {
          openExternal('https://marketplace.visualstudio.com/items?itemName=langningchen.cph-ng');
        }
      });
    return false;
  }

  const samples = Array.isArray(problem && problem.samples) ? problem.samples : [];
  if (!samples.length) {
    vscode.window.showInformationMessage(
      `这道题的题面里没找到样例（交互题、或者样例是图片）——${target.label} 那边就没东西可填。`
    );
    return false;
  }

  const choice = await chooseCphTarget(problem, target);
  if (!choice) return false;

  let payload = cphLib.buildCompanionPayload(problem, samples);
  let targetFile = '';
  if (choice.mode === 'new' || choice.mode === 'current') {
    const ready = await ensureCphPathScript();
    if (!ready.ok) {
      const why =
        ready.reason === 'custom'
          ? `你给 ${target.label} 设了自己的路径脚本，它不认「指定文件」这件事`
          : `没能接管 ${target.label} 的路径脚本`;
      vscode.window.showWarningMessage(`${why}，这次还是让它自己决定文件放哪。`);
      choice.mode = 'auto';
    } else {
      targetFile = choice.file;
    }
  }
  if (targetFile) payload = cphLib.withTargetFile(payload, targetFile);

  const port = cphPortOf(target);
  const existed = targetFile ? fsLib.existsSync(targetFile) : false;
  // 这个文件在 CPH-NG 里已经有题、而且正是它当前打开的那份：内存里那道旧题会把我们写进去的盖住，
  // 先切走让它存盘卸载（目标文件没被 CPH-NG 当成当前题时不用折腾）
  const record = targetFile ? cphRecordPath(targetFile) : '';
  const replacing =
    !!record && fsLib.existsSync(record) && sameFile(codeFilePath(), targetFile);
  const detach = replacing ? await detachCphActiveProblem(targetFile, record) : null;
  const scratch = detach ? detach.scratch : null;
  const detached = !!(detach && detach.confirmed);

  const result = await cphLib.postProblem(payload, { port });
  if (scratch) await closeScratchEditor(scratch);

  log.write('cph.send', {
    key: problem && problem.key,
    target: target.kind,
    port,
    tests: samples.length,
    mode: choice.mode,
    file: targetFile,
    replaced: replacing,
    ok: result.ok,
    status: result.status,
    error: result.error ? result.error.code || result.error.message : '',
  });

  if (result.ok) {
    if (!targetFile) {
      vscode.window.showInformationMessage(
        `已把 ${samples.length} 组样例发给 ${target.label}：它会新建一道「${payload.name}」的题目并打开源文件。`
      );
      return true;
    }
    const name = baseNameOf(targetFile);
    if (existed) {
      if (replacing && !detached) {
        vscode.window.showWarningMessage(
          `样例已经写进 ${name} 的记录，但 ${target.label} 可能还在用它内存里的旧题（它的题目缓存不跟着文件刷新）。` +
            `在 ${target.label} 侧边栏把这道题删掉，再点一次传送就行。`
        );
        return true;
      }
      vscode.window.showInformationMessage(
        replacing
          ? `已把 ${samples.length} 组样例重挂到 ${name}（这道题在 ${target.label} 里原有的样例被换掉了）：侧边栏现在就是这道题。`
          : `已把 ${samples.length} 组样例挂到 ${name}：${target.label} 里打开这个文件就能看到测试样例。`
      );
      return true;
    }
    if (await waitForFile(targetFile, 4000)) {
      vscode.window.showInformationMessage(`已把 ${samples.length} 组样例发给 ${target.label}：新建了 ${targetFile}`);
      return true;
    }
    vscode.window
      .showWarningMessage(
        `样例发出去了，但没在 ${targetFile} 看到文件——${target.label} 的路径脚本可能没生效（它会退回到自己建 .cpp）。`,
        '检查设置'
      )
      .then((pick) => {
        if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'cph-ng.companion.customPathScript');
      });
    return true;
  }

  const reason =
    result.error && result.error.code === 'ECONNREFUSED'
      ? `127.0.0.1:${port} 上没人监听——先在侧边栏点开一次 ${target.label}，让它把接收端启动起来（同一端口只能被一个窗口占用）。`
      : result.error
        ? `连接失败：${result.error.message}`
        : `HTTP ${result.status}`;
  vscode.window.showWarningMessage(`发送样例到 ${target.label} 失败：${reason}`, '复制诊断信息').then((pick) => {
    if (!pick) return;
    const text = JSON.stringify(
      {
        target: target.id,
        port,
        mode: choice.mode,
        file: targetFile,
        status: result.status,
        error: result.error ? result.error.message : '',
        body: result.body || '',
        payloadPreview: { name: payload.name, url: payload.url, tests: payload.tests.map((t) => t.input.length) },
      },
      null,
      2
    );
    vscode.env.clipboard.writeText(text);
  });
  return false;
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
  const cphTarget = findCphExtension();
  const view = renderProblem(problem, {
    isFavorite,
    contestId,
    problemNum,
    contestTitle: options.contestTitle || '',
    contestEnded,
    contestEnd,
    cph: cphTarget ? { label: cphTarget.label } : null,
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
    case 'cph':
      pushSamplesToCph(problem).catch(handleError);
      break;
    case 'version':
      pickProblemVersion(problem, options).catch(handleError);
      break;
    case 'submissions':
      // 从题目面板进来：默认只看这道题里「我的」提交，没登录会自动退成「全部」。
      // oj/题号一律从 key 里拆（比赛题目的 problem.num 是比赛内的 A/B，不是 OJ 题号）
      showSubmissions({ scope: 'mine', problemKey: problem.key }).catch(handleError);
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
    const standings = buildStandings(contest, rank, {
      myParticipantId: myId,
      includePractice: standingsIncludePractice,
    });
    panel.webview.postMessage({
      type: 'standings',
      html: renderStandingsInner(standings),
      updatedAt: standings.updatedAt,
      includePractice: standings.includePractice,
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

  // 换比赛了，补题开关回到「仅赛时」
  standingsIncludePractice = false;

  const myId = await client.myUserId().catch(() => '');
  let standings = null;
  let standingsError = '';
  try {
    standings = await withProgress('正在读取榜单…', async () => {
      const rank = await client.fetchContestRank(contest.id);
      return buildStandings(contest, rank, { myParticipantId: myId, includePractice: standingsIncludePractice });
    });
  } catch (err) {
    standingsError = err && err.code === 'LOGIN_REQUIRED' ? '榜单需要登录 / 报名后才能查看' : err.message;
  }

  // 讨论区匿名也能读，失败不影响榜单
  let discussion = null;
  let discussionError = '';
  try {
    discussion = await client.fetchDiscussion(`contest/${contest.id}`);
  } catch (err) {
    discussionError = (err && err.message) || '讨论区读取失败';
  }

  const interval = standingsInterval();
  const view = renderContest(contest, {
    standings,
    standingsError,
    pollInterval: interval,
    includePractice: standingsIncludePractice,
    discussion,
    discussionError,
    myId,
  });
  lastOpened = { kind: 'contest', key: String(contest.id), id: String(contest.id), title: contest.title, url: contest.url };

  let panel = null;

  /** 重新拉一次讨论区，只换帖子列表（发帖框里的草稿不受影响） */
  const refreshDiscussion = async () => {
    try {
      const fresh = await client.fetchDiscussion(`contest/${contest.id}`);
      if (!panel || !panel.webview) return fresh;
      panel.webview.postMessage({
        type: 'discussionPosts',
        html: renderDiscussionPosts(fresh, { myId }),
        count: fresh.commentNumber,
      });
      return fresh;
    } catch (err) {
      panel.webview.postMessage({ type: 'toast', text: `讨论区刷新失败：${err.message}` });
      return null;
    }
  };

  /** 发评论中：连点「发表」时挡住重复提交（同一时间只允许一条） */
  let discussSending = false;

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

      // 讨论区：发帖 / 删帖（带内容，所以单独走一类消息）
      if (msg.type === 'discussSend') {
        const content = String(msg.content || '');
        if (!content.trim()) {
          panel.webview.postMessage({ type: 'toast', text: '先写点内容' });
          return undefined;
        }
        if (discussSending) return undefined;
        discussSending = true;
        return vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: '正在发表…' },
          async () => {
            try {
              await client.postComment({
                path: `contest/${contest.id}`,
                content,
                parent: Number(msg.parent) || 0,
              });
              panel.webview.postMessage({ type: 'discussClear' });
              await refreshDiscussion();
              vscode.window.setStatusBarMessage('评论已发表', 2500);
            } catch (err) {
              panel.webview.postMessage({ type: 'toast', text: err.message });
            } finally {
              discussSending = false;
              panel.webview.postMessage({ type: 'discussSendDone' });
            }
          }
        );
      }
      if (msg.type === 'discussDelete') {
        return (async () => {
          const pick = await vscode.window.showWarningMessage('删除这条评论？删了就找不回来了。', { modal: true }, '删除');
          if (pick !== '删除') return;
          try {
            await client.deleteComment(msg.post);
            await refreshDiscussion();
            vscode.window.setStatusBarMessage('已删除', 2000);
          } catch (err) {
            panel.webview.postMessage({ type: 'toast', text: err.message });
          }
        })();
      }

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
        case 'standingsPractice': {
          // 赛时榜单 ⇄ 含赛后补题
          standingsIncludePractice = !standingsIncludePractice;
          return pushStandings(contest, panel).then((fresh) => {
            if (fresh) {
              vscode.window.setStatusBarMessage(
                standingsIncludePractice ? '榜单已包含赛后补题（标 †）' : '榜单只算赛时成绩',
                2500
              );
            }
          });
        }
        case 'discussRefresh':
          return refreshDiscussion().then((fresh) => {
            if (fresh) vscode.window.setStatusBarMessage(`讨论区已刷新 · ${fresh.commentNumber} 条`, 2000);
          });
        case 'discussBrowser':
          return openExternal(`${contest.url}#discuss`);
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

/* ------------------------------------------------------------------ */
/* 私信                                                                */
/* ------------------------------------------------------------------ */

/**
 * 私信面板。
 *
 * 会话列表是服务端渲染的 HTML（只有「会话内容 / 发送 / 删除 / 拉黑」是 AJAX），
 * 所以整页只在「刷新列表」时重载；切联系人和发消息都只替换右半边。
 */
async function showMessages(options = {}) {
  let book = null;
  let error = '';
  try {
    book = await withProgress('正在读取私信…', () => client.fetchMessageContacts());
  } catch (err) {
    error = (err && err.message) || '私信读取失败';
  }

  const contacts = (book && book.contacts) || [];
  const me = (book && book.me) || '';
  const url = (book && book.url) || `${session.baseUrl}/message`;
  const preferId = options.contactId ? String(options.contactId) : '';
  const fallback = contacts.find((c) => c.active) || contacts[0] || {};
  const activeId = preferId || (fallback.id ? String(fallback.id) : '');

  let conversation = null;
  let conversationError = '';
  if (activeId && !error) {
    try {
      conversation = await client.fetchConversation(activeId, { start: 0 });
    } catch (err) {
      conversationError = (err && err.message) || '会话读取失败';
    }
  }

  lastOpened = { kind: 'message', key: 'inbox', id: 'inbox', title: '私信', url };
  const view = renderMessage({ contacts, me, activeId, conversation, conversationError, error, url });

  let panel = null;
  /** 正在发送中的会话：webview 连点「发送」/ 反复 Ctrl+Enter 时挡住重复提交 */
  const pmSending = new Set();

  const contactOf = (id) => contacts.find((c) => String(c.id) === String(id)) || {};

  /** 拉一段会话并推到右半边（不重载整页，草稿框不会被清掉） */
  const loadConversation = async (contactId, start) => {
    const contact = contactOf(contactId);
    try {
      const conv = await client.fetchConversation(contactId, { start });
      if (panel && panel.webview) {
        panel.webview.postMessage({
          type: 'pmConversation',
          contactId: String(contactId),
          html: renderConversationInner(conv, { contact, me }),
        });
      }
      return conv;
    } catch (err) {
      if (panel && panel.webview) {
        panel.webview.postMessage({
          type: 'pmConversation',
          contactId: String(contactId),
          html: renderConversationInner(null, { contact, me, error: err.message }),
        });
      }
      return null;
    }
  };

  panel = showPanel(appContext, 'message', {
    ...view,
    enableMathJax: true,
    onMessage: (msg) => {
      if (!msg) return undefined;
      if (msg.type === 'openExternal' && msg.url) return openExternal(msg.url);
      if (msg.type === 'openPath' && msg.path) return openExternal(`${session.baseUrl}${msg.path}`);
      if (msg.type === 'openProblem' && msg.key) return showProblem(msg.key).catch(handleError);
      if (msg.type === 'openContest' && msg.id) return showContest(msg.id).catch(handleError);

      const contactId = msg.contactId ? String(msg.contactId) : activeId;
      if (msg.type === 'pmOpen') return loadConversation(contactId, 0);
      if (msg.type === 'pmOlder') return loadConversation(contactId, Number(msg.start) || 0);
      if (msg.type === 'pmRefresh') {
        return loadConversation(contactId, 0).then((conv) => {
          if (conv) vscode.window.setStatusBarMessage('会话已刷新', 1500);
        });
      }
      if (msg.type === 'pmSend') {
        const content = String(msg.content == null ? '' : msg.content);
        if (!content.trim()) {
          panel.webview.postMessage({ type: 'toast', text: '消息不能为空' });
          return undefined;
        }
        // 同一个会话同时只允许一条在飞：连点按钮会连着发同一段话，多出来的直接丢掉
        if (pmSending.has(contactId)) {
          panel.webview.postMessage({ type: 'toast', text: '上一条还在发送，稍等一下' });
          return undefined;
        }
        pmSending.add(contactId);
        return (async () => {
          try {
            await client.sendMessage(contactId, content);
            panel.webview.postMessage({ type: 'pmClear' });
            await loadConversation(contactId, 0);
          } catch (err) {
            panel.webview.postMessage({ type: 'toast', text: err.message });
          } finally {
            pmSending.delete(contactId);
            // 让前端把「发送中…」的按钮恢复（成功时会整体重绘，这条只是兜住失败/被挡的情况）
            panel.webview.postMessage({ type: 'pmSendDone', contactId });
          }
        })();
      }
      if (msg.type === 'pmDelete') {
        return (async () => {
          const pick = await vscode.window.showWarningMessage('删除这条私信？', { modal: true }, '删除');
          if (pick !== '删除') return;
          try {
            await client.deleteMessage(msg.id);
            await loadConversation(contactId, 0);
          } catch (err) {
            panel.webview.postMessage({ type: 'toast', text: err.message });
          }
        })();
      }
      if (msg.type === 'pmBlock') {
        return (async () => {
          const blocked = msg.blocked === true;
          try {
            await client.setContactBlocked(contactId, blocked);
            await loadConversation(contactId, 0);
            vscode.window.setStatusBarMessage(blocked ? '已拉黑' : '已解除拉黑', 2000);
          } catch (err) {
            panel.webview.postMessage({ type: 'toast', text: err.message });
          }
        })();
      }

      if (msg.type !== 'action') return undefined;
      switch (msg.action) {
        case 'browser':
          return openExternal(url);
        case 'pmRefreshList':
          client.clearCache();
          return showMessages({ contactId: activeId }).catch(handleError);
        case 'refresh':
          client.clearCache();
          return showMessages({ contactId: activeId }).catch(handleError);
        default:
          return undefined;
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 提交记录                                                            */
/* ------------------------------------------------------------------ */

const SUBMISSIONS_PAGE = 20;

/**
 * 提交记录面板。
 * - 自己的提交：`un=<我的用户名>`，服务端会给源码文本（showCode=true → code）
 * - 别人的提交：VJudge 不给文本，只给一张代码图片（codeImgUrl），这里下回来转 data URI
 *
 * @param {{scope?: 'mine'|'all', user?: string, problemKey?: string, oj?: string,
 *          probNum?: string, res?: string}} [options]
 */
async function showSubmissions(options = {}) {
  const state = {
    scope: options.scope === 'all' ? 'all' : 'mine',
    me: '',
    user: String(options.user || ''),
    problemKey: String(options.problemKey || ''),
    oj: String(options.oj || ''),
    probNum: String(options.probNum || ''),
    res: String(options.res || 'all'),
    rows: [],
    start: 0,
    hasMore: false,
    loaded: false,
    error: '',
    notice: '',
    detail: null,
    url: `${session.baseUrl}/status`,
  };

  if (state.problemKey && (!state.oj || !state.probNum)) {
    const parts = splitProblemKey(state.problemKey);
    state.oj = state.oj || parts.oj;
    state.probNum = state.probNum || parts.num;
  }

  // 「只看我的」得先知道自己的用户名：/status/data 的 un 只认真实用户名，
  // 传 mine 没用（那是站点前端自己换算的）
  try {
    state.me = await client.myUsername();
  } catch (err) {
    state.me = '';
    if (state.scope === 'mine') {
      state.scope = 'all';
      state.notice = (err && err.message) || '没登录，先显示全站提交';
    }
  }
  if (state.scope === 'mine' && !state.me) state.scope = 'all';

  /** 面板底部状态栏 / 复制用的那个站内链接 */
  const statusUrl = () => {
    const hash = [];
    const user = state.scope === 'mine' ? state.me : state.user;
    if (user) hash.push(`un=${encodeURIComponent(user)}`);
    if (state.oj) hash.push(`OJId=${encodeURIComponent(state.oj)}`);
    if (state.probNum) hash.push(`probNum=${encodeURIComponent(state.probNum)}`);
    if (state.res && state.res !== 'all') hash.push(`res=${encodeURIComponent(state.res)}`);
    return `${session.baseUrl}/status${hash.length ? `#${hash.join('&')}` : ''}`;
  };

  const load = async (reset) => {
    if (reset) {
      state.start = 0;
      state.rows = [];
      state.loaded = false;
      state.hasMore = false;
    }
    try {
      const page = await client.fetchSubmissionList({
        user: state.scope === 'mine' ? state.me : state.user,
        oj: state.oj,
        probNum: state.probNum,
        res: state.res,
        start: state.start,
        length: SUBMISSIONS_PAGE,
      });
      state.rows = state.rows.concat(page.rows);
      state.start = state.rows.length;
      state.hasMore = page.hasMore && page.rows.length > 0;
      state.error = '';
    } catch (err) {
      state.error = (err && err.message) || '提交记录读取失败';
      state.hasMore = false;
    }
    state.loaded = true;
  };

  await withProgress('正在读取提交记录…', () => load(true));

  // 面板实例要能被 pushList / openDetail 用到，所以先声明再赋值
  // eslint-disable-next-line prefer-const
  let panel = null;

  const pushList = () => {
    if (!panel || !panel.webview) return;
    panel.webview.postMessage({
      type: 'submissionView',
      html: renderSubmissionsBody(state),
      scrollTop: true,
    });
  };
  const pushDetail = () => {
    if (!panel || !panel.webview) return;
    panel.webview.postMessage({
      type: 'submissionView',
      html: renderSubmissionDetail(state.detail, { me: state.me }),
    });
  };

  const openDetail = async (runId) => {
    const id = String(runId || '');
    if (!id) return;
    const row = state.rows.find((r) => r.runId === id) || { runId: id };
    state.detail = { row, loading: true };
    pushDetail();
    try {
      const got = await client.fetchSubmissionCode(id);
      const merged = { ...row };
      const extra = got.detail || {};
      for (const key of [
        'runId',
        'userName',
        'oj',
        'probNum',
        'status',
        'runtime',
        'memory',
        'language',
        'length',
        'time',
      ]) {
        const value = extra[key];
        if (value !== undefined && value !== null && value !== '') merged[key] = value;
      }
      if (!merged.problemKey && merged.oj && merged.probNum) {
        merged.problemKey = `${merged.oj}-${merged.probNum}`;
      }
      if (got.kind === 'image') {
        try {
          const img = await client.fetchCodeImage(got.url);
          state.detail = { ...got, row: merged, dataUri: img.dataUri };
        } catch (err) {
          state.detail = { kind: 'image', row: merged, error: err.message };
        }
      } else {
        state.detail = { ...got, row: merged };
      }
    } catch (err) {
      state.detail = { row, error: (err && err.message) || '代码没取到' };
    }
    pushDetail();
  };

  let handler = null;

  /** 条件变了就整页重画（面板头部的「范围 / 已加载」跟着变） */
  const reloadAll = async () => {
    await withProgress('正在读取提交记录…', () => load(true));
    lastOpened = {
      kind: 'submissions',
      key: state.scope,
      id: state.scope,
      title: '提交记录',
      url: statusUrl(),
    };
    panel = showPanel(appContext, 'submissions', {
      ...renderSubmissions({ ...state, url: statusUrl() }),
      enableMathJax: false,
      onMessage: handler,
    });
  };

  handler = (msg) => {
    if (!msg) return undefined;
    if (msg.type === 'openExternal' && msg.url) return openExternal(msg.url);
    if (msg.type === 'openPath' && msg.path) return openExternal(`${session.baseUrl}${msg.path}`);
    if (msg.type === 'openProblem' && msg.key) return showProblem(msg.key).catch(handleError);
    if (msg.type === 'openContest' && msg.id) return showContest(msg.id).catch(handleError);

    if (msg.type === 'openUser' && msg.name) {
      state.user = String(msg.name);
      state.scope = 'all';
      state.detail = null;
      return reloadAll().catch(handleError);
    }
    if (msg.type === 'subOpen') return openDetail(msg.runId).catch(handleError);
    if (msg.type === 'subScope') {
      const scope = msg.scope === 'all' ? 'all' : 'mine';
      if (scope === 'mine' && !state.me) {
        vscode.window.showInformationMessage(
          '只看自己的提交需要先登录 VJudge（VJudge: 登录 / 更新凭据）'
        );
        return undefined;
      }
      state.scope = scope;
      state.detail = null;
      return reloadAll().catch(handleError);
    }
    if (msg.type === 'subResult') {
      state.res = msg.res === 'AC' ? 'AC' : 'all';
      state.detail = null;
      return reloadAll().catch(handleError);
    }
    if (msg.type === 'subMore') {
      if (!state.hasMore) return undefined;
      return (async () => {
        await withProgress('正在读取更多提交…', () => load(false));
        pushList();
      })();
    }
    if (msg.type === 'subRetry') {
      const id = state.detail && state.detail.row ? state.detail.row.runId : '';
      return openDetail(id).catch(handleError);
    }

    if (msg.type !== 'action') return undefined;
    switch (msg.action) {
      case 'browser':
        // 在详情里点「打开」就打开这条提交的页面，否则打开筛选好的列表
        return openExternal(
          state.detail && state.detail.row && state.detail.row.runId
            ? `${session.baseUrl}/solution/${encodeURIComponent(state.detail.row.runId)}`
            : statusUrl()
        );
      case 'copy':
        return vscode.env.clipboard.writeText(statusUrl()).then(() => {
          vscode.window.setStatusBarMessage('已复制提交记录链接', 2000);
        });
      case 'subRefresh':
        return (async () => {
          await withProgress('正在刷新提交记录…', () => load(true));
          pushList();
        })();
      case 'subBack':
        state.detail = null;
        pushList();
        return undefined;
      case 'subUser':
        return (async () => {
          const typed = await vscode.window.showInputBox({
            title: '只看某个用户的提交',
            prompt: 'VJudge 用户名（留空 = 不限用户）',
            value: state.user || '',
            ignoreFocusOut: true,
          });
          if (typed === undefined) return;
          state.user = typed.trim();
          if (state.user) state.scope = 'all';
          state.detail = null;
          await reloadAll();
        })();
      case 'subProblem':
        return (async () => {
          const typed = await vscode.window.showInputBox({
            title: '只看某道题的提交',
            prompt: '题号，如 CodeForces-1A / 洛谷-P1001（留空 = 不限题目）',
            value: state.problemKey || '',
            ignoreFocusOut: true,
          });
          if (typed === undefined) return;
          const text = typed.trim();
          if (text) {
            const key = normalizeProblemKey(text);
            const parts = splitProblemKey(key);
            state.problemKey = key;
            state.oj = parts.oj;
            state.probNum = parts.num;
          } else {
            state.problemKey = '';
            state.oj = '';
            state.probNum = '';
          }
          state.detail = null;
          await reloadAll();
        })();
      default:
        return undefined;
    }
  };

  lastOpened = {
    kind: 'submissions',
    key: state.scope,
    id: state.scope,
    title: '提交记录',
    url: statusUrl(),
  };
  panel = showPanel(appContext, 'submissions', {
    ...renderSubmissions({ ...state, url: statusUrl() }),
    enableMathJax: false,
    onMessage: handler,
  });

  if (state.notice) vscode.window.setStatusBarMessage(state.notice, 4000);
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
/* 随机来一道题                                                        */
/* ------------------------------------------------------------------ */

/** 随机抽题的可选范围。前三个不需要登录（但看题面仍然要登录）。 */
const RANDOM_OJ_CHOICES = [
  {
    id: 'any',
    label: '$(globe) 不限 OJ',
    description: 'Codeforces / 洛谷 各一半',
    detail: '选题不需要登录；打开题面才需要',
  },
  {
    id: 'CodeForces',
    label: '$(symbol-constant) Codeforces',
    description: '可选 rating 区间 + 算法标签',
    detail: '用官方题库接口，难度和标签都准',
  },
  {
    id: '洛谷',
    label: '$(symbol-constant) 洛谷',
    description: '可选难度（红 → 黑）+ 算法标签',
    detail: '用洛谷题目列表，难度和标签都准',
  },
  {
    id: 'vjudge',
    label: '$(cloud) VJudge 全站随机',
    description: '不挑 OJ，从 VJudge 题库里抽',
    detail: '需要登录 VJudge',
  },
  {
    id: 'other',
    label: '$(ellipsis) 其他 OJ…',
    description: '从 VJudge 收录的 OJ 里挑一个',
    detail: '需要登录 VJudge；这个 OJ 没有难度数据',
  },
];

/** 给「再来一道」用的简短描述 */
function randomFilterSummary(filter) {
  if (!filter) return '';
  const oj =
    filter.oj === 'any'
      ? '不限 OJ'
      : filter.oj === 'vjudge'
        ? 'VJudge 全站'
        : filter.oj === 'other'
          ? filter.ojName || '某 OJ'
          : filter.oj;
  const level = filter.levelLabel ? ` · ${filter.levelLabel}` : '';
  const tags = Array.isArray(filter.tags) && filter.tags.length ? ` · 标签 ${filter.tagLabel || tagCountLabel(filter.tags)}` : '';
  return `${oj}${level}${tags}`;
}

/** 没存标签名时（比如从旧版本恢复的条件）退化成「N 个标签」 */
function tagCountLabel(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return list.length > 2 ? `${list.slice(0, 2).join(' / ')} 等 ${list.length} 个` : list.join(' / ');
}

/** 选 Codeforces 的 rating 区间（含自定义输入） */
async function askCodeforcesRange() {
  const items = randomLib.CF_PRESETS.map((preset) => ({
    label: preset.label,
    description: preset.id === 'any' ? '全部难度' : '',
    preset,
  }));
  items.push({ label: '$(edit) 自定义区间…', description: '比如 1600-1900', custom: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Codeforces 难度',
    placeHolder: '选一个 rating 区间',
    ignoreFocusOut: true,
  });
  if (!pick) return null;

  if (!pick.custom) {
    const preset = pick.preset;
    return {
      rating: { min: preset.min, max: preset.max },
      label: preset.id === 'any' ? '' : preset.label,
    };
  }

  const text = await vscode.window.showInputBox({
    title: 'Codeforces 难度',
    prompt: '输入 rating 区间，如 1600-1900（只写 1800 表示 1700-1900）',
    value: '1600-1900',
    ignoreFocusOut: true,
    validateInput: (value) => (randomLib.parseRatingRange(value) ? '' : '格式像 1600-1900'),
  });
  if (!text) return null;
  const range = randomLib.parseRatingRange(text);
  if (!range) return null;
  return { rating: range, label: randomLib.ratingLabel(range.min, range.max) };
}

/** 选洛谷难度（1 难度一档，或自定义多选） */
async function askLuoguLevels() {
  const items = randomLib.LUOGU_PRESETS.map((preset) => ({
    label: preset.label,
    description: preset.id === 'any' ? '全部难度' : preset.note || '',
    preset,
  }));
  items.push({ label: '$(edit) 自定义（可多选）…', description: '同时抽好几个难度', custom: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: '洛谷难度',
    placeHolder: '选一个难度',
    ignoreFocusOut: true,
  });
  if (!pick) return null;

  if (!pick.custom) {
    const preset = pick.preset;
    return {
      levels: preset.levels.slice(),
      label: preset.id === 'any' ? '' : preset.label,
    };
  }

  const levelItems = randomLib.LUOGU_LEVELS.filter((level) => level.id > 0).map((level) => ({
    label: randomLib.LUOGU_LEVEL_LABEL[level.id],
    description: level.cf || '',
    level: level.id,
    picked: false,
  }));
  const picked = await vscode.window.showQuickPick(levelItems, {
    title: '洛谷难度（可多选）',
    placeHolder: '勾选难度后回车（Esc 取消）',
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked) return null;
  if (!picked.length) return { levels: [0], label: '' };
  return { levels: picked.map((p) => p.level), label: picked.map((p) => p.label).join(' / ') };
}

/**
 * 选算法标签（可多选，命中任一）。
 * 洛谷的标签是中文（id 从 `/_lfe/tags` 来，缓存 6 小时）；CF 的标签是英文小写，配一句中文说明。
 * 返回 `null` = 取消整次抽题；`{ tags: [] }` = 不限标签。
 */
async function askRandomTags(oj) {
  if (oj !== 'CodeForces' && oj !== '洛谷') return { tags: [], tagLabel: '' };

  let items = [];
  try {
    items = await withProgress('正在读取算法标签…', async () => {
      if (oj === '洛谷') {
        const tags = await randomLib.fetchLuoguTags();
        return tags.map((t) => ({
          label: t.name,
          description: t.parentName ? `属于 ${t.parentName}` : '',
          tag: t.id,
        }));
      }
      const tags = await randomLib.codeforcesTags();
      return tags.map((t) => ({
        label: t.tag,
        description: [randomLib.CF_TAG_ZH[t.tag] || '', `${t.count} 题`].filter(Boolean).join(' · '),
        tag: t.tag,
      }));
    });
  } catch (err) {
    // 标签拿不到不该挡着抽题：说一声，然后不带标签继续
    vscode.window.showWarningMessage(
      `标签列表没拿到（${err && err.message ? err.message : err}），这次就不带标签抽了`
    );
    return { tags: [], tagLabel: '' };
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `${oj === '洛谷' ? '洛谷' : 'Codeforces'} 算法标签（可多选）`,
    placeHolder: '回车确认；一个都不选或按 Esc = 不限标签',
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  // 标签是最后一步、也是可选的，Esc 就不当「取消整次抽题」了，直接当不限标签
  if (!picked) return { tags: [], tagLabel: '' };
  if (!picked.length) return { tags: [], tagLabel: '' };
  return { tags: picked.map((p) => p.tag), tagLabel: picked.map((p) => p.label).join(' / ') };
}

/** 从 /util/cfg 的 remoteOJs 里挑一个 OJ（中文 OJ 名就是 VJudge 的写法） */
async function askOtherOj() {
  let remote = {};
  try {
    const cfg = await client.siteConfig();
    remote = (cfg && cfg.remoteOJs) || {};
  } catch {
    remote = {};
  }
  const names = Object.keys(remote).filter((name) => name !== 'CodeForces' && name !== '洛谷');
  if (!names.length) {
    const typed = await vscode.window.showInputBox({
      title: '其他 OJ',
      prompt: '输入 VJudge 上的 OJ 名字（如 HDU、POJ、AtCoder、牛客）',
      ignoreFocusOut: true,
    });
    if (!typed || !typed.trim()) return null;
    return { oj: 'other', ojName: typed.trim(), label: typed.trim() };
  }
  names.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const pick = await vscode.window.showQuickPick(
    names.map((name) => {
      const info = remote[name] || {};
      return {
        label: name,
        description: info.isAlive === false ? '可能已下线' : '',
        detail: info.homepage || '',
        name,
      };
    }),
    {
      title: `VJudge 收录了 ${names.length} 个 OJ（按 OJ 随机需要登录）`,
      placeHolder: '选一个 OJ（Esc 取消）',
      ignoreFocusOut: true,
    }
  );
  if (!pick) return null;
  return { oj: 'other', ojName: pick.name, label: pick.name };
}

/**
 * 问「抽哪个范围」。
 * 会把上次的条件放在第一项，连按两次回车就能「再来一道」。
 * @returns {Promise<null|{oj:string, rating?:object, levels?:number[], label?:string}>}
 */
async function askRandomFilter() {
  const saved = store.getRandomFilter();
  const items = [];
  if (saved && saved.oj) {
    items.push({
      label: '$(debug-restart) 再来一道',
      description: randomFilterSummary(saved),
      detail: '沿用上次的条件直接抽',
      saved,
    });
  }
  items.push({ label: '$(list-unordered) 选条件…', description: '先选 OJ，再选难度 / 标签', choose: true });
  for (const choice of RANDOM_OJ_CHOICES) {
    items.push({
      label: choice.label,
      description: choice.description,
      detail: choice.detail,
      choice,
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: '随机来一道题',
    placeHolder: '选一个范围（Esc 取消）',
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  if (!pick) return null;
  if (pick.saved) return pick.saved;
  if (!pick.choose && !pick.choice) return null;

  // 选条件：先选 OJ
  let choice = pick.choice;
  let base = null;
  if (pick.choose || !choice) {
    const ojPick = await vscode.window.showQuickPick(
      RANDOM_OJ_CHOICES.map((c) => ({
        label: c.label,
        description: c.description,
        detail: c.detail,
        choice: c,
      })),
      { title: '随机来一道题 · 选 OJ', placeHolder: 'Esc 取消', ignoreFocusOut: true, matchOnDetail: true }
    );
    if (!ojPick) return null;
    choice = ojPick.choice;
  }
  if (choice.id === 'other') {
    base = await askOtherOj();
    if (!base) return null;
  } else {
    base = { oj: choice.id };
  }

  // 再选难度：只有 CF / 洛谷有难度数据
  let level = null;
  if (base.oj === 'CodeForces') level = await askCodeforcesRange();
  else if (base.oj === '洛谷') level = await askLuoguLevels();
  if (level === null && (base.oj === 'CodeForces' || base.oj === '洛谷')) return null;

  // 最后选标签（只有 CF / 洛谷有算法标签）
  const tagged = await askRandomTags(base.oj);
  if (tagged === null) return null;

  const filter = {
    ...base,
    ...(level || {}),
    ...(tagged || {}),
    label: randomFilterSummary({ ...base, ...(level || {}), ...(tagged || {}) }),
  };
  return filter;
}

/** 抽一道并打开；抽不到时把话说清楚，别把 Node 的原始报错甩给用户 */
async function pickAndShowRandomProblem(filter) {
  const target = filter.oj === 'other' ? filter.ojName : filter.oj;
  let result = null;
  try {
    result = await withProgress('正在挑一道随机题…', () =>
      randomLib.pickRandom({
        oj: target,
        client,
        rating: filter.rating,
        levels: filter.levels,
        tags: filter.tags,
      })
    );
  } catch (err) {
    // 其他 OJ 走 VJudge 的题目列表，登录失效时给一个能点的入口
    if (err && err.code === 'LOGIN_REQUIRED') throw err;
    throw new Error(
      `${err && err.message ? err.message : err}${filter.oj === 'other' ? '（其他 OJ 的随机抽题需要登录 VJudge）' : ''}`
    );
  }
  if (!result || !result.key) throw new Error('没有抽到题目，再试一次');

  // 记住这次的条件（「再来一道」用）
  await store.setRandomFilter({
    oj: filter.oj,
    ojName: filter.ojName || '',
    rating: filter.rating || null,
    levels: filter.levels || null,
    tags: Array.isArray(filter.tags) && filter.tags.length ? filter.tags : null,
    tagLabel: filter.tagLabel || '',
    label: randomFilterSummary(filter),
  });

  // 题面只对登录用户开放，没登录的话先劝一手，省得打开后又是「拿不到题面」
  if (!session.hasCredentials) {
    const choice = await vscode.window.showWarningMessage(
      `随机到 ${result.key}，但题面需要登录 VJudge 才能查看`,
      '去登录',
      '先打开看看'
    );
    if (choice === '去登录') await vscode.commands.executeCommand('vjudgeHelper.login');
  }

  await showProblem(result.key);
  const extra = [result.detail, result.title].filter(Boolean).join(' · ');
  vscode.window.setStatusBarMessage(`随机到 ${result.key}${extra ? ` · ${extra}` : ''}`, 5000);
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

  openMessages: wrap(async () => showMessages()),

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
    const filter = await askRandomFilter();
    if (!filter) return;
    await pickAndShowRandomProblem(filter);
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

  /** 把当前题目的样例送进 CPH / CPH-NG（没装就提示去装） */
  sendSamplesToCph: wrap(async () => {
    const key = currentProblem && currentProblem.key;
    if (!key) {
      vscode.window.showInformationMessage('请先打开一道 VJudge 题目，再传送样例。');
      return;
    }
    const problem = await withProgress(`正在准备 ${key} 的样例…`, () => client.fetchProblem(key));
    await pushSamplesToCph(problem);
  }),

  /** 我的提交记录：服务端会给源码文本，能直接在面板里看 / 复制 */
  mySubmissions: wrap(async () => {
    await showSubmissions({ scope: 'mine' });
  }),

  /** 全站提交记录（可以按用户 / 题目筛）；别人的代码 VJudge 只给图片 */
  submissions: wrap(async () => {
    await showSubmissions({ scope: 'all' });
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
      { label: '$(comment-discussion) 打开私信', command: 'vjudgeHelper.openMessages' },
      { label: '$(lightbulb) 随机来一道题…', command: 'vjudgeHelper.openRandomProblem' },
      { label: '$(cloud-upload) 提交当前文件代码', command: 'vjudgeHelper.submitCode', description: '提交到当前正在看的题目（比赛题会自动交进比赛）' },
      { label: '$(cloud-upload) 提交到指定题目…', command: 'vjudgeHelper.submitToProblem' },
      { label: '$(zap) 传送样例至 CPH / CPH-NG', command: 'vjudgeHelper.sendSamplesToCph', description: '把样例塞进 CPH，本地对拍用' },
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
