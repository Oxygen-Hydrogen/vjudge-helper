'use strict';

/**
 * 榜单计算的单元测试（不联网）：
 *   node test/standings-check.js
 * 加 --live 会额外用真实比赛数据跑一遍：
 *   node test/standings-check.js --live
 */

const { buildStandings, formatClock, formatPenalty } = require('../src/standings');
const { renderStandingsInner, renderContest } = require('../src/webview/renderers');

function pass(name, ok, extra) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || extra === undefined ? '' : ` -> ${extra}`}`);
  if (!ok) process.exitCode = 1;
}

/* ----------------------------- 造一场比赛 ----------------------------- */

const begin = Date.parse('2026-10-28T09:00:00Z');

function makeContest(overrides = {}) {
  const data = {
    begin,
    end: begin + 2 * 3600 * 1000,
    penalty: 1200,
    sumTime: true,
    partialScore: false,
    enableFreeze: false,
    freezeTime: 0,
    unfreezeTime: 0,
    ...overrides.data,
  };
  return {
    id: '1000',
    title: '测试赛',
    begin: data.begin,
    end: data.end,
    problems: [
      { index: 'A', key: 'CodeForces-1A', title: 'A+B' },
      { index: 'B', key: 'CodeForces-1B', title: 'B' },
      { index: 'C', key: 'CodeForces-1C', title: 'C' },
    ],
    data,
  };
}

const participants = {
  1: { type: 'user', name: 'alice', nickname: '爱丽丝' },
  2: { type: 'user', name: 'bob' },
  3: { type: 'user', name: 'carol' },
};

// alice：A 先错 1 次再 10 分钟通过；B 30 分钟通过
// bob：A 10 分钟通过；B 20 分钟通过
// carol：只提交了 A，全错
const submissions = [
  [1, 0, 2, 300],
  [1, 0, 1, 600],
  [1, 1, 1, 1800],
  [2, 0, 1, 600],
  [2, 1, 1, 1200],
  [3, 0, 2, 100],
  [3, 0, 2, 200],
];

console.log('\n基础：AC / 罚时 / 排名');
{
  const standings = buildStandings(makeContest(), { participants, submissions }, { now: begin + 3600 * 1000 });
  const [first, second, third] = standings.rows;
  pass('参赛人数 3', standings.participantCount === 3, standings.participantCount);
  pass('bob 第一（两题都快）', first.name === 'bob', first.name);
  pass('alice 第二', second.name === 'alice', second.name);
  pass('carol 第三（没通过，且有两罚）', third.name === 'carol', third.name);
  pass('bob 罚时 = 10 + 20 分钟', formatPenalty(first.penalty) === '30', formatPenalty(first.penalty));
  pass('alice 罚时 = 10+20(罚) + 30 分钟', formatPenalty(second.penalty) === '60', formatPenalty(second.penalty));
  pass('alice 的 A 记录了一次罚时', second.cells[0].fails === 1, second.cells[0].fails);
  pass('carol 的 A 有两次失败', third.cells[0].fails === 2, third.cells[0].fails);
  pass('每题 AC 数', standings.problems.map((p) => p.acCount).join('') === '220', standings.problems.map((p) => p.acCount).join(''));
  pass('时间格式 10 分钟 = 10:00', formatClock(600) === '10:00', formatClock(600));
}

console.log('\n比赛结束后：赛后的补题不计入榜单（VJudge 默认视图）');
{
  const standings = buildStandings(
    makeContest(),
    { participants, submissions: [...submissions, [3, 0, 1, 3 * 3600]] },
    { now: begin + 4 * 3600 * 1000 }
  );
  const carol = standings.rows.find((r) => r.name === 'carol');
  pass('赛后补题不算通过', carol.cells[0].acSeconds === null, carol.cells[0].acSeconds);
  pass('罚时也不受影响', carol.penalty === 0, carol.penalty);
}

console.log('\n封榜：封榜后的提交按「未通过」算');
{
  const contest = makeContest({
    data: { enableFreeze: true, freezeTime: begin + 10 * 60 * 1000, unfreezeTime: begin + 5 * 3600 * 1000 },
  });
  // bob 在封榜前（第 5 分钟）过了 C 题；10 分钟整的那批提交正好在封榜边界上
  const subs = [...submissions, [2, 2, 1, 300]];
  const standings = buildStandings(contest, { participants, submissions: subs }, { now: begin + 1500 * 1000 });
  pass('处于封榜状态', standings.frozen === true);
  const alice = standings.rows.find((r) => r.name === 'alice');
  const bob = standings.rows.find((r) => r.name === 'bob');
  pass('封榜后 alice 的 B（30 分钟）不算通过', alice.cells[1].acSeconds === null, alice.cells[1].acSeconds);
  pass('封榜边界（第 10 分钟）也按未通过处理', alice.cells[0].acSeconds === null, alice.cells[0].acSeconds);
  pass('封榜前的通过仍然算', bob.cells[2].acSeconds === 300, bob.cells[2].acSeconds);
  pass('页面会提示封榜', /封榜中/.test(renderStandingsInner(standings)));
}

console.log('\n部分分（partialScore）');
{
  const contest = makeContest({ data: { partialScore: true, sumTime: true } });
  const subs = [
    [1, 0, 1, 600, 50, 100],
    [2, 0, 1, 900, 100, 100],
  ];
  const standings = buildStandings(contest, { participants, submissions: subs }, { now: begin + 3600 * 1000 });
  pass('alice 拿到一半分', standings.rows.find((r) => r.name === 'alice').score === 0.5);
  pass('bob 满分排第一', standings.rows[0].name === 'bob', standings.rows[0].name);
  pass('页面会提示按分数排名', /部分分/.test(renderStandingsInner(standings)));
}

console.log('\n自己那一行会高亮');
{
  const standings = buildStandings(makeContest(), { participants, submissions }, {
    now: begin + 3600 * 1000,
    myParticipantId: 2,
  });
  pass('myRank = 1', standings.myRank === 1, standings.myRank);
  pass('行上有 isMe', standings.rows[0].isMe === true);
  const html = renderStandingsInner(standings);
  pass('HTML 里带「你」标记', /vj-st__me/.test(html) && /is-me/.test(html));
  pass('HTML 里有题目表头', /vj-st__prob/.test(html));
}

console.log('\n空榜单 / 没数据不报错');
{
  const standings = buildStandings(makeContest(), { participants: {}, submissions: [] }, { now: begin });
  pass('0 人也能算', standings.participantCount === 0);
  pass('渲染出空提示', /还没有人参赛/.test(renderStandingsInner(standings)));
  pass('null 时不抛异常', /正在读取榜单/.test(renderStandingsInner(null)));
}

console.log('\n比赛面板里嵌了榜单区块');
{
  const contest = makeContest();
  const standings = buildStandings(contest, { participants, submissions }, { now: begin + 3600 * 1000 });
  const view = renderContest(contest, { standings, pollInterval: 5 });
  pass('有 vj-standings-inner 容器', /id="vj-standings-inner"/.test(view.body));
  pass('写了自动刷新间隔', /每 5 秒自动刷新/.test(view.body));
  pass('有倒计时节点', /data-vj-countdown/.test(view.body));
  pass('按钮里有「刷新榜单」', view.actions.some((a) => a.id === 'rankRefresh'));
}

module.exports = { makeContest, participants, submissions };

/* --------------------------- 可选：真实接口 --------------------------- */

if (process.argv.includes('--live')) {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return {
        EventEmitter: class {
          get event() {
            return { dispose() {} };
          }
        },
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        window: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const { VJudgeClient } = require('../src/vjudge');
  const { CookieJar } = require('../src/http');
  (async () => {
    console.log('\n真实接口：比赛 #33 的榜单');
    const client = new VJudgeClient({
      baseUrl: 'https://vjudge.net',
      jar: new CookieJar(),
      timeout: 30000,
      hasCredentials: false,
    });
    const contest = await client.fetchContest(33);
    const rank = await client.fetchContestRank(33);
    const standings = buildStandings(contest, rank);
    pass('拿到参赛者', standings.participantCount > 0, standings.participantCount);
    pass('题目数与比赛一致', standings.problems.length === contest.problems.length);
    const top = standings.rows[0];
    pass('第一名字非空', !!top && !!top.name, top && top.name);
    console.log('  前 3 名：', standings.rows.slice(0, 3).map((r) => `${r.rank}. ${r.name} (${r.solved} 题 / ${formatPenalty(r.penalty)} 分)`).join('  '));
  })().catch((err) => {
    console.error('真实接口检查失败：', err.message);
    process.exitCode = 1;
  });
}
