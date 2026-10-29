'use strict';
/**
 * 「随机来一道题」自检（不联网）。
 *
 * 覆盖的都是踩过的坑：
 *   - 匿名调 VJudge /problem/random 会拿回登录页，URL 里最后一个片段正好是 `random`，
 *     以前会把「random」当题号打开（面板因此显示 random - random）；
 *   - 匿名调 /problem/data 返回空数组 + 假的 recordsTotal(9999999)，
 *     拿它当题目总数会抽出根本不存在的偏移量；
 *   - CF 题库里 rating 为空 / problemsetName 有值（acmsguru 之类）的题不能抽，
 *     抽到了在 VJudge 上打不开；
 *   - 洛谷有 WAF，第一次 302 种 Cookie，第二次才给 HTML —— 必须自动重试；
 *   - 「网络连接被中断」这类 TLS/ECONNRESET 必须判成可重试，
 *     正是用户看到的 "Client network socket disconnected before secure TLS connection was established"。
 *
 * 跑法：node test/random-check.js
 */
const assert = require('assert');

// src/session.js 会 require('vscode')，Node 里没有这个模块，先打个桩
const Module = require('module');
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'vscode') {
    return {
      Uri: { file: (p) => ({ fsPath: String(p) }), joinPath: () => ({ fsPath: '' }) },
      window: {},
      workspace: { getConfiguration: () => ({ get: () => null }) },
      env: {},
      commands: {},
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { isRetryable } = require('../src/http');
const { LoginRequiredError } = require('../src/session');
const { VJudgeClient } = require('../src/vjudge');
const randomLib = require('../src/random');

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
async function okAsync(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label} —— ${err.message}`);
  }
}

const rngZero = () => 0;
const rngLast = () => 0.999999;

function luoguHtml(problems, extra = {}) {
  const payload = {
    instance: 'main',
    template: 'problem.list',
    status: 200,
    data: {
      problems: {
        perPage: 50,
        count: extra.count === undefined ? problems.length : extra.count,
        result: problems.map((p) => ({
          pid: p.pid,
          name: p.name || p.pid,
          difficulty: p.difficulty,
        })),
      },
    },
  };
  return `<!DOCTYPE html><html><body><script id="lentille-context" type="application/json">${JSON.stringify(
    payload
  )}</script></body></html>`;
}

/** 假 VJudgeClient（只实现 httpGet） */
function fakeClient(handler) {
  const client = new VJudgeClient({
    baseUrl: 'https://vjudge.net',
    hasCredentials: true,
    jar: null,
    timeout: 1000,
  });
  client.httpGet = handler;
  return client;
}

(async () => {
  console.log('============================================================');
  console.log('随机来一道题');
  console.log('============================================================');

  /* ---------------------- 网络错误可重试 ---------------------- */

  ok('TLS 断连 / ECONNRESET 判为可重试', () => {
    const err = new Error(
      'Client network socket disconnected before secure TLS connection was established'
    );
    err.code = 'ECONNRESET';
    assert.strictEqual(isRetryable(err), true, '这正是用户报的那个错，必须重试');

    const noCode = new Error(
      'Client network socket disconnected before secure TLS connection was established'
    );
    assert.strictEqual(isRetryable(noCode), true, '没有 code 时靠文案也要认出来');

    const cert = new Error('unable to verify the first certificate');
    cert.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    assert.strictEqual(isRetryable(cert), false, '证书错误重试也没用，别重试');
  });

  /* ---------------------- 难度区间解析 ---------------------- */

  ok('rating 区间解析', () => {
    assert.deepStrictEqual(randomLib.parseRatingRange('1600-1900'), { min: 1600, max: 1900 });
    assert.deepStrictEqual(randomLib.parseRatingRange('1600 ~ 1900'), { min: 1600, max: 1900 });
    assert.deepStrictEqual(randomLib.parseRatingRange('1600—1900'), { min: 1600, max: 1900 });
    assert.deepStrictEqual(randomLib.parseRatingRange('1800'), { min: 1700, max: 1900 });
    assert.strictEqual(randomLib.parseRatingRange('1900-1600'), null, 'min > max 要判非法');
    assert.strictEqual(randomLib.parseRatingRange('难'), null);
  });

  /* ---------------------- Codeforces ---------------------- */

  ok('CF filter 掉没有 rating / 特殊题库 / 没 contestId 的题', () => {
    const pool = randomLib.filterCodeforcesProblems(
      [
        { contestId: 1, index: 'A', rating: 1500, name: 'ok' },
        { contestId: 2, index: 'B', rating: 1500, problemsetName: 'acmsguru' },
        { index: 'C', rating: 1500 },
        { contestId: 4, index: 'D', name: 'no rating' },
        { contestId: 5, index: 'E', rating: 2600 },
      ],
      { min: 1400, max: 2000 }
    );
    assert.deepStrictEqual(
      pool.map((p) => `${p.contestId}${p.index}`),
      ['1A'],
      'filter 结果不对'
    );
  });

  await okAsync('CF 抽题：键名是 CodeForces-<contestId><index>', async () => {
    randomLib.resetCodeforcesCache();
    const body = JSON.stringify({
      status: 'OK',
      result: {
        problems: [
          { contestId: 1, index: 'A', name: 'Theatre Square', rating: 800 },
          { contestId: 4, index: 'A', name: 'Watermelon', rating: 800 },
        ],
      },
    });
    const http = { get: async () => ({ status: 200, body }) };
    const got = await randomLib.randomCodeforces({ min: 800, max: 1000, rng: rngLast, http });
    assert.strictEqual(got.key, 'CodeForces-4A');
    assert.strictEqual(got.rating, 800);
    assert.ok(got.detail.includes('800'));
  });

  /* ---------------------- Codeforces 标签筛选 ---------------------- */

  const cfTagPool = {
    status: 'OK',
    result: {
      problems: [
        { contestId: 1, index: 'A', name: 'dp easy', rating: 800, tags: ['dp'] },
        { contestId: 2, index: 'B', name: 'graph easy', rating: 800, tags: ['graphs'] },
        { contestId: 3, index: 'C', name: 'both', rating: 800, tags: ['dp', 'graphs'] },
        { contestId: 4, index: 'D', name: 'dp hard', rating: 2600, tags: ['dp'] },
        { contestId: 5, index: 'E', name: 'no tags', rating: 800 },
      ],
    },
  };

  await okAsync('CF 标签筛选：多选是「命中任一」', async () => {
    randomLib.resetCodeforcesCache();
    const http = { get: async () => ({ status: 200, body: JSON.stringify(cfTagPool) }) };
    const pool = randomLib.filterCodeforcesProblems(
      cfTagPool.result.problems,
      { min: 800, max: 1000 },
      ['dp', 'graphs']
    );
    assert.deepStrictEqual(
      pool.map((p) => `${p.contestId}${p.index}`),
      ['1A', '2B', '3C'],
      `命中任一的语义不对：${pool.map((p) => p.contestId).join(',')}`
    );
    // 不限标签时 5E（没标签但有 rating）也在池子里
    assert.strictEqual(randomLib.filterCodeforcesProblems(cfTagPool.result.problems, null, []).length, 5);
    // 单标签 + 难度区间：只有 1A（4D 超区间、5E 没标签）
    const only = await randomLib.randomCodeforces({ min: 800, max: 1000, tags: ['dp'], rng: rngZero, http });
    assert.strictEqual(only.key, 'CodeForces-1A');
    assert.ok(only.tags.includes('dp'), '返回结果里没带标签');
  });

  await okAsync('CF 标签 + 难度没交集时报错，不能偷偷退化成整库', async () => {
    randomLib.resetCodeforcesCache();
    const http = { get: async () => ({ status: 200, body: JSON.stringify(cfTagPool) }) };
    let message = '';
    try {
      await randomLib.randomCodeforces({ min: 3000, max: 3500, tags: ['dp'], http });
    } catch (err) {
      message = err.message;
    }
    assert.ok(/标签/.test(message), `没提到标签：${message}`);
  });

  await okAsync('CF 标签列表：统计题数并倒序', async () => {
    randomLib.resetCodeforcesCache();
    const http = { get: async () => ({ status: 200, body: JSON.stringify(cfTagPool) }) };
    const tags = await randomLib.codeforcesTags({ http });
    assert.deepStrictEqual(
      tags.map((t) => `${t.tag}:${t.count}`),
      ['dp:3', 'graphs:2'],
      `标签统计不对：${JSON.stringify(tags)}`
    );
  });

  await okAsync('CF 接口报错时给出可读提示（不是 JSON）', async () => {
    randomLib.resetCodeforcesCache();
    const http = { get: async () => ({ status: 200, body: '<html>blocked</html>' }) };
    let message = '';
    try {
      await randomLib.randomCodeforces({ http });
    } catch (err) {
      message = err.message;
    }
    assert.ok(/Codeforces/.test(message), `错误提示不合预期：${message}`);
  });

  /* ---------------------- 洛谷 ---------------------- */

  ok('洛谷页面 JSON 解析', () => {
    const parsed = randomLib.parseLuoguList(
      luoguHtml([
        { pid: 'P1001', name: 'A+B Problem', difficulty: 1 },
        { pid: 'P1002', difficulty: 2 },
      ])
    );
    assert.ok(parsed, '没解析出数据');
    assert.strictEqual(parsed.count, 2);
    assert.strictEqual(parsed.perPage, 50);
    assert.deepStrictEqual(parsed.items[0], { pid: 'P1001', title: 'A+B Problem', difficulty: 1 });
    assert.strictEqual(randomLib.parseLuoguList('<html>没有脚本</html>'), null);
  });

  await okAsync('洛谷抽题：先 302 再 200 也能拿到（WAF 重试）', async () => {
    let calls = 0;
    const http = {
      get: async (url) => {
        calls += 1;
        if (!url.includes('/problem/list')) throw new Error(`奇怪的 URL: ${url}`);
        if (calls === 1) return { status: 302, body: '<html>302 Found</html>' };
        return {
          status: 200,
          body: luoguHtml([
            { pid: 'P1001', name: 'A+B Problem', difficulty: 1 },
            { pid: 'P1007', name: '独木桥', difficulty: 3 },
          ]),
        };
      },
    };
    const got = await randomLib.randomLuogu({ levels: [1, 3], rng: rngZero, http });
    assert.ok(['洛谷-P1001', '洛谷-P1007'].includes(got.key), `键名不对：${got.key}`);
    assert.ok(got.detail, '难度描述为空');
    assert.strictEqual(got.source, 'luogu');
  });

  await okAsync('洛谷难度参数：0 表示不限', async () => {
    const seen = [];
    const http = {
      get: async (url) => {
        seen.push(url);
        return { status: 200, body: luoguHtml([{ pid: 'P1000', difficulty: 1 }], { count: 120 }) };
      },
    };
    await randomLib.randomLuogu({ levels: [0], rng: rngZero, http });
    assert.ok(seen[0].includes('difficulty=0'), `URL 里没有 difficulty=0：${seen[0]}`);
    assert.ok(seen[0].includes('type=P'), 'URL 里没有 type=P');
  });

  await okAsync('洛谷一直不给数据时要报错，不能返回空题号', async () => {
    const http = { get: async () => ({ status: 302, body: '' }) };
    let message = '';
    try {
      await randomLib.randomLuogu({ levels: [1], http });
    } catch (err) {
      message = err.message;
    }
    assert.ok(/洛谷/.test(message), `错误提示不合预期：${message}`);
  });

  /* ---------------------- 洛谷标签筛选 ---------------------- */

  ok('洛谷标签：从 /_lfe/tags 里只取 Algorithm 那一类', () => {
    const payload = JSON.stringify({
      types: [
        { id: 1, type: 'Region', name: '区域' },
        { id: 2, type: 'Algorithm', name: '算法' },
      ],
      tags: [
        { id: 3, name: '动态规划 DP', type: 2, parent: null },
        { id: 4, name: '背包', type: 2, parent: 3 },
        { id: 5, name: 'NOIP', type: 3, parent: null },
      ],
    });
    const tags = randomLib.parseLuoguTags(payload);
    assert.ok(Array.isArray(tags), '没解析出标签');
    assert.deepStrictEqual(
      tags.map((t) => `${t.id}:${t.name}`).sort(),
      ['3:动态规划 DP', '4:背包'],
      `取错了类型：${JSON.stringify(tags)}`
    );
    const child = tags.find((t) => t.id === 4);
    assert.strictEqual(child.parentName, '动态规划 DP', 'parentName 没解析出来');
    assert.strictEqual(randomLib.parseLuoguTags('{"tags":[]}'), null);
    assert.strictEqual(randomLib.parseLuoguTags('不是 JSON'), null);
  });

  ok('洛谷列表 URL：标签用逗号连接（多选 = 命中任一）', () => {
    const plain = randomLib.luoguListUrl([5], 1);
    assert.ok(!plain.includes('tag='), `不该有 tag 参数：${plain}`);
    const tagged = randomLib.luoguListUrl([5], 2, [3, 6]);
    assert.ok(tagged.includes('tag=3%2C6'), `tag 参数不对：${tagged}`);
    assert.ok(tagged.includes('difficulty=5'), 'difficulty 丢了');
    assert.ok(tagged.includes('page=2'), 'page 丢了');
    // 空数组 / 脏数据不能拼出 tag=
    assert.ok(!randomLib.luoguListUrl([5], 1, []).includes('tag='));
    assert.ok(!randomLib.luoguListUrl([5], 1, [null, undefined]).includes('tag='));
  });

  await okAsync('洛谷抽题时标签会一路带到翻页请求里', async () => {
    const seen = [];
    const http = {
      get: async (url) => {
        seen.push(url);
        // count 给大一点，保证会翻页
        return { status: 200, body: luoguHtml([{ pid: 'P1002', difficulty: 3 }], { count: 500 }) };
      },
    };
    await randomLib.randomLuogu({ levels: [3], tags: [3], rng: rngLast, http });
    assert.strictEqual(seen.length, 2, `应该请求两次（首页 + 随机页），实际 ${seen.length}`);
    seen.forEach((url) => assert.ok(url.includes('tag=3'), `有请求没带标签：${url}`));
    assert.ok(seen[1].includes('page=10'), `翻页页码不对：${seen[1]}`);
  });

  await okAsync('洛谷标签 + 难度没交集时提示要提到标签', async () => {
    const http = {
      get: async () => ({ status: 200, body: luoguHtml([], { count: 0 }) }),
    };
    let message = '';
    try {
      await randomLib.randomLuogu({ levels: [8], tags: [3], http });
    } catch (err) {
      message = err.message;
    }
    assert.ok(/标签/.test(message), `没提到标签：${message}`);
  });

  /* ---------------------- VJudge 兜底 ---------------------- */

  await okAsync('按 OJ 抽题：用 start 偏移取第 N 条', async () => {
    const rows = [{ originOJ: 'HDU', originProb: '1000', title: 'A + B' }];
    const client = fakeClient(async (pathname) => {
      assert.ok(pathname.startsWith('/problem/data?'), `路径不对：${pathname}`);
      assert.ok(pathname.includes('OJId=HDU'), 'OJId 没带上');
      assert.ok(pathname.includes('recordsTotal') === false);
      assert.ok(/start=\d+/.test(pathname), 'start 没带上');
      return { status: 200, url: 'https://vjudge.net/problem/data', body: JSON.stringify({ recordsTotal: 5000, data: rows }) };
    });
    const got = await randomLib.randomFromVJudge(client, 'HDU', { rng: rngZero });
    assert.strictEqual(got.key, 'HDU-1000');
    assert.strictEqual(got.title, 'A + B');
  });

  await okAsync('匿名（假 recordsTotal=9999999）要判成需要登录', async () => {
    const client = fakeClient(async () => ({
      status: 200,
      url: 'https://vjudge.net/problem/data',
      body: JSON.stringify({ recordsTotal: 9999999, recordsFiltered: 9999999, data: [] }),
    }));
    let code = '';
    let message = '';
    try {
      await client.problemCountInOj('');
    } catch (err) {
      code = err.code || '';
      message = err.message;
    }
    assert.strictEqual(code, 'LOGIN_REQUIRED', `没抛登录错误：${message}`);
    assert.ok(/登录/.test(message));
  });

  /* ---------------------- /problem/random 的老坑 ---------------------- */

  await okAsync('/problem/random 拿回登录页时不许把 random 当题号', async () => {
    const client = fakeClient(async () => ({
      status: 200,
      url: 'https://vjudge.net/problem/random',
      body: '<!DOCTYPE html><html><body><form id="login-form"></form></body></html>',
    }));
    let code = '';
    try {
      await client.randomProblem();
    } catch (err) {
      code = err.code || '';
    }
    assert.strictEqual(code, 'LOGIN_REQUIRED', '应当抛登录错误（而不是返回 key=random）');
  });

  await okAsync('/problem/random 正常时从 URL 里取题号', async () => {
    const client = fakeClient(async () => ({
      status: 200,
      url: 'https://vjudge.net/problem/CodeForces-1234E',
      body: '<textarea name="dataJson">{}</textarea>',
    }));
    assert.strictEqual(await client.randomProblem(), 'CodeForces-1234E');
  });

  /* ---------------------- 组合逻辑 ---------------------- */

  await okAsync('不限 OJ：CF 挂了自动换洛谷', async () => {
    randomLib.resetCodeforcesCache();
    const http = {
      get: async (url) => {
        if (url.includes('codeforces.com')) return { status: 200, body: '<html>down</html>' };
        return { status: 200, body: luoguHtml([{ pid: 'P1001', difficulty: 1 }]) };
      },
    };
    const got = await randomLib.pickRandom({ oj: 'any', rng: rngZero, http });
    assert.strictEqual(got.key, '洛谷-P1001');
  });

  await okAsync('oj=vjudge 时 OJId 传空串（全站）', async () => {
    let pathname = '';
    const client = fakeClient(async (p) => {
      pathname = p;
      return {
        status: 200,
        url: 'https://vjudge.net/problem/data',
        body: JSON.stringify({ recordsTotal: 100, data: [{ originOJ: 'HDU', originProb: '1', title: 'x' }] }),
      };
    });
    const got = await randomLib.pickRandom({ oj: 'vjudge', client, rng: rngZero });
    assert.strictEqual(got.key, 'HDU-1');
    assert.ok(/OJId=(&|$)/.test(pathname), `OJId 不是空串：${pathname}`);
  });

  /* ---------------------- 洛谷难度表（2026-06 改版） ---------------------- */

  ok('洛谷难度表是 8 档，新插进来的「提高（青）」是 5', () => {
    const ids = randomLib.LUOGU_LEVELS.map((l) => l.id);
    assert.deepStrictEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8], `档位不对：${ids.join(',')}`);
    const senior = randomLib.LUOGU_LEVELS.find((l) => l.id === 5);
    assert.strictEqual(senior.name, '提高', '5 档不是「提高」');
    assert.strictEqual(senior.colorName, '青', '5 档颜色不是青');
    assert.strictEqual(senior.color, 'cyan-3', '5 档色号不是 cyan-3');
    assert.strictEqual(randomLib.LUOGU_LEVELS.find((l) => l.id === 6).name, '提高+/省选−');
    assert.strictEqual(randomLib.LUOGU_LEVELS.find((l) => l.id === 7).name, '省选/NOI−');
    assert.strictEqual(randomLib.LUOGU_LEVELS.find((l) => l.id === 8).name, 'NOI/NOI+/CTS');
  });

  ok('难度预设覆盖 1..8，且每档只对应一个 id', () => {
    const presets = randomLib.LUOGU_PRESETS.filter((p) => p.id !== 'any');
    assert.strictEqual(presets.length, 8, `预设数量不对：${presets.length}`);
    presets.forEach((preset, i) => {
      assert.deepStrictEqual(preset.levels, [i + 1], `${preset.id} 的 levels 不对`);
    });
    assert.ok(presets[4].label.includes('青'), '第 5 档标签里没有「青」');
    assert.strictEqual(randomLib.LUOGU_LEVEL_LABEL[5], '提高（青）');
    assert.strictEqual(randomLib.LUOGU_LEVEL_LABEL[8], 'NOI/NOI+/CTS（黑）');
  });

  ok('/_lfe/config 的 ProblemDifficulty 能解析成难度表', () => {
    const payload = JSON.stringify({
      ProblemDifficulty: [
        { type: 'Nil', id: 0, name: '暂无评定', color: 'grey-3' },
        { type: 'Senior', id: 5, name: '提高', color: 'cyan-3' },
        { type: 'Noi', id: 8, name: 'NOI/NOI+/CTS', color: 'lapis-4' },
      ],
    });
    const list = randomLib.parseLuoguDifficulties(payload);
    assert.deepStrictEqual(
      list.map((x) => x.id),
      [0, 5, 8],
      'id 排序不对'
    );
    assert.strictEqual(list[1].name, '提高');
    assert.strictEqual(randomLib.parseLuoguDifficulties('{"foo":1}'), null);
    assert.strictEqual(randomLib.parseLuoguDifficulties('不是 JSON'), null);
  });

  console.log('');
  if (failed) {
    console.log(`✗ ${failed} 项未通过`);
    process.exit(1);
  }
  console.log('全部通过。');

  // 加了 --live 才联网核对静态表和洛谷线上的表有没有再次分叉
  if (process.argv.includes('--live')) {
    try {
      const remote = await randomLib.fetchLuoguDifficulties();
      const local = randomLib.LUOGU_LEVELS.map((l) => `${l.id}:${l.name}`);
      const online = (remote || []).map((l) => `${l.id}:${l.name}`);
      if (!online.length) {
        console.log('⚠ 没拿到线上难度表，跳过对照');
      } else if (online.join('|') === local.join('|')) {
        console.log(`✓ 线上难度表和本地一致（${online.length} 档）`);
      } else {
        console.log('✗ 难度表和洛谷线上不一致：');
        console.log(`  本地：${local.join('  ')}`);
        console.log(`  线上：${online.join('  ')}`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.log(`⚠ 对照失败（网络问题？）：${err.message}`);
    }
  }
})();
