'use strict';

/**
 * 提交功能自检：
 *
 *   1) 纯逻辑（不需要网络）：语言识别 / 语言挑选 / 源码字段 / 报错翻译
 *   2) 匿名接口探测（需要网络，但不需要账号）：确认提交与评测接口的形态没变
 *   3) 真实提交（需要账号）：带上 Cookie 跑一次完整流程
 *
 * 用法：
 *   node test/submit-check.js
 *   VJ_COOKIE='JSESSIONID=xxx; JSESSlONID=yyy' node test/submit-check.js
 *   VJ_COOKIE='...' VJ_PROBLEM=CodeForces-1A VJ_FILE=./a.cpp VJ_LANG=54 node test/submit-check.js
 *
 * 注意：第 3 步会真的在 VJudge 上产生一条提交记录（用 VJ_DRY=1 可以只看前两步）。
 */

const fs = require('fs');
const Module = require('module');

/* ---------- 极简 vscode mock ---------- */
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
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const { VJudgeClient } = require('../src/vjudge');
const { CookieJar } = require('../src/http');
const submitLib = require('../src/submit');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` -> ${extra}` : ''}`);
  }
}

function line(title) {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
}

function newClient(cookie, options = {}) {
  return new VJudgeClient({
    baseUrl: 'https://vjudge.net',
    jar: new CookieJar(cookie || ''),
    timeout: 30000,
    // hasCredentials 只控制「本地是否短路」，匿名探测时故意设 true，让请求真的发出去
    hasCredentials: options.assumeLoggedIn === true ? true : !!cookie,
  });
}

/* ------------------------------------------------------------------ */

function logicChecks() {
  line('1. 语言识别');

  const cases = [
    ['D:/work/a.cpp', '', 'cpp'],
    ['D:/work/a.CC', '', 'cpp'],
    ['D:/work/a.c', '', 'c'],
    ['D:/work/main.py', '', 'python'],
    ['D:/work/Main.java', '', 'java'],
    ['D:/work/a.rs', '', 'rust'],
    ['D:/work/a.go', '', 'go'],
    ['', 'cpp', 'cpp'],
    ['', 'python', 'python'],
    ['D:/work/notes.txt', 'plaintext', null],
  ];
  for (const [file, langId, expect] of cases) {
    const got = submitLib.detectLanguageFamily(file, langId);
    check(`${file || '(无文件名)'} + ${langId || '(无 languageId)'} -> ${expect}`, got === expect, got);
  }

  line('2. 语言挑选（VJudge 的语言表五花八门）');

  const cppList = submitLib.normalizeLanguageOptions({
    54: 'GNU G++17 7.3.0',
    73: 'GNU G++17 9.2.0 (64bit, msys2)',
    91: 'GNU G++23 14.2 (64bit, msys2)',
    1: 'GNU GCC C11 5.1.0',
    2: 'Microsoft Visual C++ 2010',
  });
  check('对象形态归一化成 5 项', cppList.length === 5, JSON.stringify(cppList));
  check('C++ 选出 G++17（不是 98 / 2010）', /G\+\+17/.test(submitLib.pickLanguage(cppList, 'cpp').name), JSON.stringify(submitLib.pickLanguage(cppList, 'cpp')));
  check('C 语言选出 GCC C11', /GCC C11/.test(submitLib.pickLanguage(cppList, 'c').name));
  check('语言表里没有 Python 时返回 null', submitLib.pickLanguage(cppList, 'python') === null);

  const pyList = submitLib.normalizeLanguageOptions(['Python 3.7', 'Python 2.7', 'PyPy 3']);
  check('数组形态归一化成 3 项', pyList.length === 3);
  check('Python 避开 2.7', !/2\.7/.test(submitLib.pickLanguage(pyList, 'python').name));

  const luogu = submitLib.normalizeLanguageOptions({ '3': 'C++98', '11': 'C++14', '12': 'C++17', '27': 'C++20' });
  check('洛谷语言 id 保留原始 id', submitLib.pickLanguage(luogu, 'cpp').id === '12', JSON.stringify(submitLib.pickLanguage(luogu, 'cpp')));

  check('记住的语言同族优先', submitLib.pickLanguage(cppList, 'cpp', '91').id === '91');
  check('记住的语言不同族时忽略', submitLib.pickLanguage(cppList, 'python', '91') === null);

  const fromData = submitLib.extractLanguageOptions({
    problem: { submitConfig: { languages: { 54: 'GNU G++17 7.3.0' } } },
  });
  check('从 dataJson 里挖语言表', fromData.length === 1 && fromData[0].id === '54');
  check('没有语言表时返回空数组', submitLib.extractLanguageOptions({ title: 'x' }).length === 0);

  line('3. 源码编码 / 表单');

  const code = '#include <bits/stdc++.h>\nint main(){ puts("你好 a+b"); }';
  const field = submitLib.sourceField(code);
  check('source 就是代码原文（不再 base64）', field === code);
  check('非 ASCII 原样保留', field.includes('你好'));
  check('null / undefined 变空串', submitLib.sourceField(null) === '' && submitLib.sourceField(undefined) === '');
  check('lone surrogate 会被拦下', /UTF-16/.test(submitLib.sourceProblem('int main(){ /*\ud800*/ }')));
  check('控制字符会被拦下', /控制字符/.test(submitLib.sourceProblem('int main(){\u0007}')));
  check('正常代码不报问题', submitLib.sourceProblem(code) === '' && submitLib.sourceProblem('a\tb\r\n') === '');

  const body = submitLib.buildSubmitBody({ language: 54, code, open: false });
  check('表单字段齐全', ['method', 'language', 'open', 'source', 'captcha', 'password'].every((k) => k in body));
  check('method=0 / open=0', body.method === '0' && body.open === '0');
  check('open=true -> 1', submitLib.buildSubmitBody({ code, open: true }).open === '1');
  check('method=1 带 bindingId', submitLib.buildSubmitBody({ code, method: 1, bindingId: 9 }).bindingId === '9');
  check('method=0 不带 bindingId', !('bindingId' in submitLib.buildSubmitBody({ code })));
  check('表单里的 source 就是原文', body.source === code);
  // 走一遍真正的表单序列化，确认服务端解码后拿到的还是原文（含中文 / 换行 / +&=）
  const tricky = 'a+b & c=d\n换行 😀';
  const wire = new URLSearchParams(require('../src/http').formEncode(submitLib.buildSubmitBody({ code: tricky })));
  check('表单编码 -> 解码 无损', wire.get('source') === tricky, JSON.stringify(wire.get('source')));
  check('比赛提交带 version / accessCode', (() => {
    const b = submitLib.buildSubmitBody({ code, version: 3, accessCode: 'pw' });
    return b.version === '3' && b.accessCode === 'pw';
  })());
  check('练习提交不带 version', !('version' in submitLib.buildSubmitBody({ code })));

  line('3.5 提交方式（submitMethods）');

  // Codeforces 的题在 VJudge 上是 [false,true,true]：不允许默认账号代交
  const cfMethods = submitLib.submitMethodsOf({ data: { submitMethods: [false, true, true] } });
  check('Codeforces 题：默认账号不可用', cfMethods.defaultAccount === false && cfMethods.ownAccount === true);
  const plain = submitLib.submitMethodsOf({ data: { submitMethods: [true, false, false] } });
  check('普通题：默认账号可用', plain.defaultAccount === true && plain.ownAccount === false);
  const unknown = submitLib.submitMethodsOf({ data: {} });
  check('拿不到时默认按默认账号试', unknown.defaultAccount === true && unknown.known === false);
  check('数组形态也认', submitLib.submitMethodsOf({ submitMethods: [0, 1, 0] }).ownAccount === true);
  check(
    'submit_method 报错能被识别',
    submitLib.isSubmitMethodError({ i18nKey: 'submit.error.submit_method.not_allowed' })
  );
  check(
    'submit_method 报错有中文文案',
    submitLib.errorText({ i18nKey: 'submit.error.submit_method.not_allowed' }).includes('默认账号')
  );
  check('别的报错不会被误判', !submitLib.isSubmitMethodError({ i18nKey: 'submit.error.login_required' }));

  line('4. 报错翻译 / 评测结论');

  check(
    '登录失效',
    submitLib.errorText({ i18nKey: 'submit.error.login_required' }).includes('登录')
  );
  check('未知 key 有兜底', submitLib.errorText({ i18nKey: 'submit.error.whatever' }).includes('whatever'));
  check(
    'i18nArgs 会把占位符填上',
    submitLib.errorText({ i18nKey: 'solution.error.submission_not_found', i18nArgs: { run_id: 7 } }).includes('找不到')
  );
  check(
    'HTML 报错被清成纯文本',
    submitLib.errorText({ error: '<div class="alert">Too many submissions</div>' }) === 'Too many submissions'
  );
  check('验证码能被识别', submitLib.isCaptchaError({ i18nKey: 'submit.error.captcha_required' }));

  const pending = submitLib.verdictOf({ processing: true, status: 'Waiting' });
  const ac = submitLib.verdictOf({ statusType: 1, status: 'Accepted', runtime: 15, memory: 512, language: 'GNU G++17' });
  const wa = submitLib.verdictOf({ statusType: 2, status: 'Wrong Answer', runtime: 15, memory: 512 });
  check('判题中 -> pending', pending.level === 'pending');
  check('statusType=1 -> accepted', ac.level === 'accepted' && /15 ms/.test(ac.detail));
  check('statusType=2 -> failed', wa.level === 'failed');
  check('摘要含语言', submitLib.solutionSummary({ status: 'Accepted', language: 'GNU G++17' }) === 'Accepted · GNU G++17');
}

/* ------------------------------------------------------------------ */

/** 远程账号列表解析（不联网：把 httpGet 换成假响应） */
async function remoteAccountChecks() {
  line('4.5 解析 OJ 账号绑定（提交方式「自己的账号」用）');

  const client = newClient('fake-cookie');
  const respond = (body) => {
    client.httpGet = async () => ({ url: 'https://vjudge.net/user/remoteAccounts/list', status: 200, body: JSON.stringify(body) });
  };

  respond({
    groups: {
      CodeForces: {
        bindings: [
          { id: 11, accountId: 'tourist', accountDisplay: '<b>tourist</b>', runtimeStatus: 'READY' },
          { id: 12, accountId: 'old', runtimeStatus: 'INCOMPLETE', healthStatus: 'INCOMPLETE' },
        ],
      },
      LibreOJ: { bindings: [{ id: 21, accountId: 'loj_user', runtimeStatus: 'READY' }] },
    },
  });

  const cf = await client.fetchRemoteAccounts('CodeForces');
  check('只返回该 OJ 的绑定', cf.length === 2 && cf.every((a) => a.oj === 'CodeForces'), JSON.stringify(cf));
  check('READY 的算可用', cf.find((a) => a.id === '11').ready === true);
  check('INCOMPLETE 的不算可用', cf.find((a) => a.id === '12').ready === false);
  check('accountDisplay 里的 HTML 被清掉', cf.find((a) => a.id === '11').display === 'tourist');

  const all = await client.fetchRemoteAccounts('');
  check('不传 OJ 时返回全部', all.length === 3, all.length);

  respond([]);
  check('空响应不炸', (await client.fetchRemoteAccounts('CodeForces')).length === 0);
}

/* ------------------------------------------------------------------ */

async function anonymousApiChecks() {
  line('5. 匿名探测提交接口（不带账号，只看报错形态）');

  // hasCredentials 设成 true 只是为了越过本地检查，Cookie 是空的 => 服务端当作未登录
  const client = newClient('', { assumeLoggedIn: true });

  try {
    await client.submitCode({ key: 'CodeForces-1A', code: 'int main(){}', language: '54' });
    check('未登录提交应当失败', false, '居然成功了');
  } catch (err) {
    check('未登录提交 -> 中文提示', /登录/.test(err.message), err.message);
    check('错误里带 i18nKey', !!err.i18nKey, err.i18nKey);
    check('被识别为需要登录', err.code === 'LOGIN_REQUIRED', err.code);
  }

  try {
    const solution = await client.fetchSolution(1);
    check('查询不存在的提交应当失败', false, JSON.stringify(solution));
  } catch (err) {
    check('查询不存在的提交 -> 中文提示', /找不到/.test(err.message), err.message);
  }

  const contests = await client.fetchContestRows({ pageSize: 40 });
  const withProblems = [];
  for (const contest of contests.filter((c) => Number(c.openness) === 0).slice(0, 12)) {
    try {
      const detail = await client.fetchContest(contest.id);
      if (detail.problems && detail.problems.length) withProblems.push(detail);
      if (withProblems.length >= 1) break;
    } catch {
      /* 跳过读不到的比赛 */
    }
  }
  if (!withProblems.length) {
    console.log('  (没找到公开比赛，跳过比赛提交探测)');
    return;
  }
  const contest = withProblems[0];
  const problem = contest.problems[0];
  try {
    await client.submitCode({
      key: problem.key || 'CodeForces-1A',
      code: 'int main(){}',
      language: '54',
      contestId: contest.id,
      problemNum: problem.index,
    });
    check('比赛提交在未登录时应当失败', false);
  } catch (err) {
    const readable = /登录|比赛|拒绝|权限|找不到|语言|次数/.test(err.message);
    check(`比赛 #${contest.id} ${problem.index} 提交报错可读：${err.message}`, readable);
  }
}

/* ------------------------------------------------------------------ */

async function realSubmit(cookie, options) {
  line('6. 真实提交（会产生一条提交记录）');

  const client = newClient(cookie);

  // 用 /user/checkLogInStatus 先确认 Cookie 有效
  const loginCheck = await new Promise((resolve) => {
    const { request } = require('../src/http');
    request('https://vjudge.net/user/checkLogInStatus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: '',
      jar: client.session.jar,
      timeout: 20000,
    }).then((res) => resolve(String(res.body || '').trim().toLowerCase() === 'true')).catch(() => resolve(false));
  });
  check('Cookie 有效（checkLogInStatus=true）', loginCheck);
  if (!loginCheck) {
    console.log('  Cookie 无效，跳过真实提交');
    return;
  }

  const key = options.problem;
  if (!options.file) {
    console.log('  没有指定 VJ_FILE，跳过真实提交（示例：VJ_FILE=./a.cpp VJ_PROBLEM=CodeForces-1A VJ_LANG=54）');
    return;
  }
  const problem = await client.fetchProblem(key).catch(() => null);
  const languages = await client.problemLanguages(problem || { key });
  console.log(`  ${key} 可选语言 ${languages.length} 个：`, languages.slice(0, 6).map((l) => `${l.id}=${l.name}`).join(' | '));

  const family = submitLib.detectLanguageFamily(options.file, '');
  let language = options.language ? { id: options.language, name: options.language } : submitLib.pickLanguage(languages, family);
  if (!language) {
    console.log('  没法自动挑语言，请用 VJ_LANG=<id> 指定');
    return;
  }
  console.log('  语言：', `${language.id}=${language.name}`, '| 文件：', options.file);

  const code = fs.readFileSync(options.file, 'utf8');
  const result = await client.submitCode({ key, code, language: language.id, open: false });
  check(`提交成功，runId=${result.runId}`, !!result.runId);

  const solution = await client.waitForVerdict(result.runId, {
    timeoutMs: 120000,
    onTick: (latest) => process.stdout.write(`  判题中… ${(latest && latest.status) || ''}\r`),
  });
  const verdict = submitLib.verdictOf(solution);
  console.log('\n  结果：', submitLib.solutionSummary(solution) || '(还没出结果)', `[${verdict.level}]`);
  console.log('  记录：', result.url);
}

/* ------------------------------------------------------------------ */

async function main() {
  logicChecks();
  await remoteAccountChecks();
  await anonymousApiChecks();

  const cookie = String(process.env.VJ_COOKIE || '').trim();
  if (!cookie || process.env.VJ_DRY === '1') {
    console.log('\n未提供 VJ_COOKIE（或 VJ_DRY=1），跳过真实提交。');
  } else {
    await realSubmit(cookie, {
      problem: process.env.VJ_PROBLEM || 'CodeForces-1A',
      file: process.env.VJ_FILE || '',
      language: process.env.VJ_LANG || '',
    });
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n自检异常:', err);
  process.exitCode = 1;
});
