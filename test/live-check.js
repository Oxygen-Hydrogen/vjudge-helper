'use strict';

/**
 * 本地联调脚本（不需要启动 VS Code）：
 *   node test/live-check.js
 * 会真实访问 vjudge.net 验证解析逻辑。
 */

const Module = require('module');
const path = require('path');

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
    for (const l of this.listeners) l(value);
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

/* ---------- 被测模块 ---------- */
const { VJudgeClient } = require('../src/vjudge');
const { CookieJar } = require('../src/http');
const { renderMarkdown } = require('../src/markdown');
const { parseInput, convertOjUrl, findProblemKeyInText } = require('../src/util');

const fakeSession = {
  baseUrl: 'https://vjudge.net',
  jar: new CookieJar(),
  timeout: 30000,
  hasCredentials: false,
};

function line(title) {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
}

async function main() {
  const client = new VJudgeClient(fakeSession);

  line('1. parseInput / convertOjUrl');
  const samples = [
    'CodeForces-1A',
    '洛谷-P1001',
    'luogu-P1001',
    '洛谷 P1001',
    'https://vjudge.net/problem/POJ-1000',
    'https://vjudge.net/contest/863093#problem/A',
    'https://codeforces.com/problemset/problem/1/A',
    'https://atcoder.jp/contests/abc300/tasks/abc300_a',
    'https://www.luogu.com.cn/problem/P1000',
    '863093',
    'https://vjudge.net/article/1',
  ];
  for (const s of samples) {
    console.log(String(s).padEnd(58), '->', JSON.stringify(parseInput(s)));
  }
  console.log('findProblemKeyInText("看这道 洛谷-P1001 吧") ->',
    findProblemKeyInText('看这道 洛谷-P1001 吧'));
  console.log('findProblemKeyInText("看这道 https://codeforces.com/contest/1/problem/B 吧") ->',
    findProblemKeyInText('看这道 https://codeforces.com/contest/1/problem/B 吧'));

  line('2. 文章解析 /article/1');
  const article = await client.fetchArticle(1);
  console.log({
    id: article.id,
    title: article.title,
    author: article.author,
    contentLen: (article.content || '').length,
    isWorkbook: article.isWorkbook,
    problems: article.problems.length,
    firstProblem: article.problems[0],
    problemLinkRendered: renderMarkdown(article.content.slice(0, 400)).includes('vjudge-problem:'),
  });
  const html = renderMarkdown(article.content, { problemLink: (k) => `vjudge-problem:${k}` });
  console.log('渲染后 HTML 长度:', html.length);
  console.log('HTML 片段:', html.slice(0, 400).replace(/\n/g, ' '));

  line('3. 比赛列表（进行中/即将开始）');
  const running = await client.listContests({ mode: 'live', pageSize: 5 });
  console.log(running.map((c) => `#${c.id} ${c.title} [${c.state}] ${new Date(c.begin).toLocaleString()}`));

  line('4. 比赛列表（最新）');
  const recent = await client.listContests({ mode: 'recent', pageSize: 5 });
  console.log(recent.map((c) => `#${c.id} ${c.title} [${c.state}] begin=${new Date(c.begin).toLocaleString()}`));

  line('5. 比赛详情 /contest/' + recent[0].id);
  const contest = await client.fetchContest(recent[0].id);
  console.log({
    id: contest.id,
    title: contest.title,
    begin: new Date(contest.begin).toLocaleString(),
    end: new Date(contest.end).toLocaleString(),
    problems: contest.problems.length,
    problemsError: contest.problemsError,
  });

  line('6. 题面（未登录，预期抛出需要登录）');
  try {
    const p = await client.fetchProblem('CodeForces-1A');
    console.log('意外成功:', p.title, p.statementSource, (p.statementHtml || '').length);
  } catch (err) {
    console.log('预期错误:', err.code || err.name, '|', err.message);
  }

  line('7. 纯逻辑：空题面兜底');
  const { extractStatementFromHtml, extractDataJson } = require('../src/vjudge');
  const fakeHtml = `<html><body><div class="problem-statement"><h2>Title</h2><p>${'x'.repeat(80)}</p></div></body></html>`;
  console.log('extractStatementFromHtml ->', (extractStatementFromHtml(fakeHtml) || '').slice(0, 60));
  console.log('extractDataJson(no data) ->', extractDataJson('<p>hi</p>'));
  console.log('extractDataJson(ok) ->', extractDataJson('<textarea name="dataJson">{"a":1}</textarea>'));

  line('8. 模拟已登录：题面解析的 4 条路径');
  const paths = [
    {
      name: 'A. dataJson.description（HTML）',
      html: `<html><body><textarea style="display:none" name="dataJson">${JSON.stringify({
        ojId: 'CodeForces',
        probNum: '1A',
        title: 'Theatre Square',
        timeLimit: 1000,
        memoryLimit: 256,
        description:
          '<div class="ptx"><p>Capital of Berland has a rectangular shape with the size n×m meters.</p><img src="/upload/1a.png" data-src="/upload/1a_big.png"></div>',
      })}</textarea></body></html>`,
    },
    {
      name: 'B. dataJson.description（Markdown）',
      html: `<html><body><textarea name="dataJson">${JSON.stringify({
        title: 'Markdown Problem',
        description:
          '## 题目描述\n\n给定一个长度为 $n$ 的数组，求区间和。这一行必须够长才会被识别为正文，所以再多写一些填充文字，让长度超过一百二十个字符，确保逻辑能命中。',
      })}</textarea></body></html>`,
    },
    {
      name: 'C. 只有 DOM 里的 .problem-statement',
      html: `<html><body><div class="problem-statement"><h2>DOM Title</h2><p>${'y'.repeat(200)}</p></div></body></html>`,
    },
    {
      name: 'D. 什么都没有',
      html: '<html><body><p>nothing here</p></body></html>',
    },
  ];

  for (const item of paths) {
    const fakeClient = new VJudgeClient({ ...fakeSession, jar: new CookieJar() });
    fakeClient.httpGet = async () => ({ status: 200, headers: {}, body: item.html, url: 'https://vjudge.net/problem/X-1' });
    const res = await fakeClient.fetchProblem('CodeForces-1A');
    const text = (res.statementHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(
      `${item.name}\n   title=${res.title} | limit=${res.timeLimit}/${res.memoryLimit} | source=${res.statementSource} | 文本长度=${text.length}`
    );
    if (item.name.startsWith('A')) {
      console.log('   图片绝对化:', /https:\/\/vjudge\.net\/upload\/1a\.png/.test(res.statementHtml));
      console.log('   data-src 提升:', /src="\/upload\/1a_big\.png"/.test(res.statementHtml) ? '未处理' : '已处理');
    }
    if (item.name.startsWith('B')) {
      console.log('   Markdown 渲染出 h3:', /<h3>/.test(res.statementHtml));
    }
    if (item.name.startsWith('D')) {
      console.log('   diagnostics:', JSON.stringify(res.diagnostics));
    }
  }

  line('9. 团队：列表 / 搜索 / 详情');
  const groups = await client.listGroups();
  console.log(`我的团队 ${groups.mine.length} · 邀请 ${groups.invitations.length} · 发现 ${groups.discover.length}`);
  console.log('公开团队前 3 个:', groups.discover.slice(0, 3).map((g) => `${g.name}(${g.shortName})`));
  const searchHits = await client.searchGroups('code');
  console.log('搜索 "code" ->', searchHits.length, '个:', searchHits.slice(0, 3).map((g) => g.name));
  console.log('空关键词 ->', (await client.searchGroups('')).length, '个');

  const sample = groups.discover.slice(0, 6).find((g) => g.members > 5) || groups.discover[0];
  const group = await client.fetchGroup(sample.shortName);
  console.log('团队详情:', {
    name: group.name,
    shortName: group.shortName,
    id: group.id,
    members: group.members.length,
    contests: group.contests.length,
    articles: group.articles.length,
    joinPolicy: group.joinPolicyLabel,
    introLen: group.introHtml.length,
  });
  if (group.contests[0]) console.log('  首场比赛:', JSON.stringify(group.contests[0]));
  if (group.members[0]) console.log('  首位成员:', JSON.stringify(group.members[0]));

  line('10. 团队：ID / 名称 / 链接 都能打开');
  for (const input of [String(group.id), group.name, `https://vjudge.net/group/${group.shortName}`]) {
    try {
      const hit = await client.fetchGroup(input);
      console.log(`  ${String(input).padEnd(52)} -> ${hit.shortName}`);
    } catch (err) {
      console.log(`  ${String(input).padEnd(52)} -> 失败: ${err.message}`);
    }
  }
  try {
    await client.fetchGroup('这个团队肯定不存在-zzzz-001');
    console.log('  不存在的团队: 意外成功');
  } catch (err) {
    console.log('  不存在的团队 -> 预期错误:', err.message);
  }

  line('11. 团队面板渲染');
  const { renderGroup } = require('../src/webview/renderers');
  const view = renderGroup(group);
  console.log({
    title: view.title,
    meta: view.meta.map((m) => `${m.label || '-'}=${m.value || ''}`),
    actions: view.actions.map((a) => a.id),
    bodyLen: view.body.length,
    hasContestLink: view.body.includes('vjudge-contest:'),
    hasMemberTable: view.body.includes('<h2>成员'),
  });

  console.log('\n全部检查完成。');
}

/** 比赛题目列表：公开比赛直接读 dataJson.problems */
async function contestProblemsCheck() {
  const { VJudgeClient, contestAccess } = require('../src/vjudge');
  const { CookieJar } = require('../src/http');
  const { renderContest } = require('../src/webview/renderers');
  const client = new VJudgeClient({
    baseUrl: 'https://vjudge.net',
    jar: new CookieJar(),
    timeout: 30000,
    hasCredentials: false,
  });

  // 挑最近一个公开（openness=0）且已结束的比赛 —— 未登录也能读到题目
  const rows = await client.fetchContestRows({ pageSize: 100 });
  const now = Date.now();
  const pub = rows.find((c) => Number(c.openness) === 0 && c.end && c.end < now);
  line(`12. 公开比赛题目列表 /contest/${pub ? pub.id : '(没找到)'}`);
  if (!pub) {
    console.log('最近 100 个比赛里没有已结束的公开比赛，跳过');
    return;
  }
  client.clearCache();
  const detail = await client.fetchContest(pub.id);
  console.log({
    title: detail.title,
    openness: detail.opennessLabel,
    access: detail.accessLabel,
    problems: detail.problems.length,
    problemsError: detail.problemsError || '(none)',
  });
  console.log(
    detail.problems.slice(0, 5).map((p) => `${p.index} ${p.key} | ${p.title} | ${p.timeLimit || '-'}`)
  );

  line('13. 无权限比赛的提示（构造数据）');
  const locked = contestAccess({ openness: 2, type: 0, started: true, ended: false, authStatus: 0 });
  console.log({
    code: locked.code,
    title: locked.title,
    needLogin: locked.needLogin,
    hint: locked.hint,
  });
  const notStarted = contestAccess({ openness: 0, type: 0, started: false, ended: false, authStatus: 1 });
  console.log({ code: notStarted.code, title: notStarted.title });

  line('14. 无权限时的面板渲染');
  const view = renderContest({
    ...detail,
    problems: [],
    access: locked,
    problemsError: locked.title,
  });
  console.log({
    actions: view.actions.map((a) => a.label),
    meta: view.meta.map((m) => `${m.label || '-'}=${m.value || ''}`),
    hasLoginButton: view.actions.some((a) => a.id === 'login'),
  });
}

/** 题面正文：/problem/description/{key}?{version} */
async function problemDescriptionCheck() {
  const { VJudgeClient } = require('../src/vjudge');
  const { CookieJar } = require('../src/http');
  const client = new VJudgeClient({
    baseUrl: 'https://vjudge.net',
    jar: new CookieJar(),
    timeout: 30000,
    hasCredentials: false,
  });

  line('15. 题面正文接口（匿名也能读）');
  const html = await client.fetchProblemDescription({ key: 315382590508085, version: 1792687525000 });
  const titles = (html.match(/vj-desc-title[^>]*>([^<]*)/g) || []).map((s) => s.replace(/.*>/, ''));
  console.log({ length: html.length, sections: titles, hasParagraph: /<p>/.test(html) });
  console.log(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));

  line('16. 题面引用收集 + 完整 fetchProblem（页面用假数据）');
  const { collectDescriptionRefs, pickDescriptionRef } = require('../src/vjudge');
  const fakeData = {
    title: 'Watermelon',
    descBriefs: [{ key: 315382590508085, version: 1792687525000, lang: 'en', type: 'main', mainOfficial: true }],
  };
  const ref = pickDescriptionRef(collectDescriptionRefs('', fakeData));
  console.log('pick ->', ref && ref.key);

  const fakePage =
    '<html><body><textarea style="display:none" name="dataJson">' +
    JSON.stringify(fakeData) +
    '</textarea></body></html>';
  const original = client.httpGet.bind(client);
  client.httpGet = async (path) =>
    path.indexOf('/problem/description/') === 0
      ? original(path)
      : { status: 200, url: `https://vjudge.net${path}`, headers: {}, body: fakePage };
  client.clearCache();
  const problem = await client.fetchProblem('CodeForces-4A', { fresh: true });
  console.log({
    statementSource: problem.statementSource,
    statementHtmlLength: problem.statementHtml.length,
    title: problem.title,
  });

  line('17. 题面格式转换：MD / HTML 的 $ 公式 + CDN');
  const { descriptionPayloadToHtml, isMarkdownFormat } = require('../src/vjudge');
  console.log('isMarkdownFormat("MD") ->', isMarkdownFormat('MD'));
  const mdHtml = descriptionPayloadToHtml(
    {
      sections: [
        { title: '', value: { format: 'MD', content: 'Each of the $n$ employees gets $b_i$ with $1 \\le b_i \\le n$.' } },
        { title: 'Input', value: { format: 'MD', content: 'Only one integer $n$.' } },
      ],
    },
    'https://cdn.vjudge.net.cn/'
  );
  console.log(mdHtml.replace(/<[^>]+>/g, '|'));
  console.log('公式已转 \\( \\):', /\\\(n\\\)/.test(mdHtml), '| 未残留 $:', !/\$/.test(mdHtml));
  const htmlOut = descriptionPayloadToHtml(
    { sections: [{ title: 'Note', value: { format: 'HTML', content: '<p>Use $n$ here.</p><img src="CDN_BASE_URL/x">' } }] },
    'https://cdn.vjudge.net.cn/'
  );
  console.log(htmlOut);

  line('18. 题面版本（翻译）切换');
  console.log('descVersions:', problem.descVersions.map((v) => v.label).join(' | '));
  console.log('当前版本:', problem.descLang || '(页面自带)');
  const cfg = await client.siteConfig();
  console.log('站点 CDN:', cfg.cdnBaseUrl, '| 语言数:', Object.keys(cfg.statementLanguages || {}).length);

  line('19. 公式定界符规范化（$$$n$$$ / $$n$$ / $n$）');
  const { normalizeMathDelimiters } = require('../src/vjudge');
  // 每条：[输入, 期望结果]。$$$ 是 Codeforces 的写法，之前被 $$ 规则吃掉一层变成
  // \(\(n\)\)，MathJax 把里面的 \( 当未知命令渲染成红色字面量 —— 就是那个 bug。
  const cases = [
    ['共有$$n$$名员工，编号从$$1$$到$$n$$。', '共有\\(n\\)名员工，编号从\\(1\\)到\\(n\\)。'],
    ['in this version $$$n \\le 200000$$$.', 'in this version \\(n \\le 200000\\).'],
    ['potions $$$a_i$$$ and $$$a_j$$$', 'potions \\(a_i\\) and \\(a_j\\)'],
    ['<p>Set <b>$$b_i$$</b> then $$2 \\le n$$</p>', '<p>Set <b>\\(b_i\\)</b> then \\(2 \\le n\\)</p>'],
    ['<p>$$\\begin{cases} a \\\\ b \\end{cases}$$</p>', '<p>\\[\\begin{cases} a \\\\ b \\end{cases}\\]</p>'],
    ['$$$$$$x^2$$$$$$', '\\[x^2\\]'],
    ['已经是 \\(n\\) 就不要再包一层', '已经是 \\(n\\) 就不要再包一层'],
    ['$$$a_i$$$ 和 $$b_j$$ 混着写', '\\(a_i\\) 和 \\(b_j\\) 混着写'],
    ['价格 $5 和 $10 不该被当成公式', '价格 $5 和 $10 不该被当成公式'],
    // <pre> 里是样例输入输出，$ 不是公式
    ['<pre>a$b$c</pre> 只有 $$$n$$$', '<pre>a$b$c</pre> 只有 \\(n\\)'],
  ];
  let pass = 0;
  for (const [input, expect] of cases) {
    const got = normalizeMathDelimiters(input);
    const ok = got === expect;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${input}\n      -> ${got}${ok ? '' : `\n      期望 ${expect}`}`);
  }
  // 关键回归：任何样本都不许出现双重包裹（截图里那个红 \, 就是它）
  const all = cases.map(([input]) => normalizeMathDelimiters(input)).join('\n');
  console.log(`通过 ${pass}/${cases.length}`);
  console.log('重复包裹:', /\\\(\\\(/.test(all) ? '有（BUG）' : '无');
  console.log('残留 $ 个数:', (all.match(/\$/g) || []).length, '（允许 $5 / $10 这类非公式文本）');

  line('20. 面板 HTML：标题不重复题号、不出现双重包裹');
  const { renderProblem } = require('../src/webview/renderers');
  const view = renderProblem({
    key: 'CodeForces-1526C2',
    title: 'Potions (Hard Version) - CodeForces-1526C2',
    oj: 'CodeForces',
    num: '1526C2',
    descLang: 'English',
    descVersions: new Array(28).fill({ key: '1', label: 'English' }),
    statementHtml: normalizeMathDelimiters('<p>in this version $$$n \\le 200000$$$.</p>'),
    url: 'https://vjudge.net/problem/CodeForces-1526C2',
    statementSource: 'description:1',
  });
  console.log('title :', view.title);
  console.log('真实题名已去掉重复题号:', view.title === 'CodeForces-1526C2 · Potions (Hard Version)');
  console.log('题面无双重包裹:', !/\\\(\\\(/.test(view.body));
  console.log('题面:', /<p>[^<]*<\/p>/.exec(view.body.replace(/\n/g, ''))?.[0] || view.body.slice(0, 80));
}

main()
  .then(contestProblemsCheck)
  .then(problemDescriptionCheck)
  .catch((err) => {
    console.error('检查失败:', err);
    process.exitCode = 1;
  });
