'use strict';

const { escapeHtml, formatDateTime, relativeTime, normalizeMathTokens } = require('../util');
const { renderMarkdown } = require('../markdown');
const { formatClock, formatPenalty } = require('../standings');
const { submitMethodsOf } = require('../submit');
const { highlightCodeBlocks, normalizeLang } = require('../highlight');

/** 提交里的语言名（"C++ 17" / "CPP" / "Python3"）→ 高亮器认的键；认不出就不染色 */
function normalizeHighlightLang(raw) {
  try {
    return normalizeLang(raw) || null;
  } catch {
    return null;
  }
}

function linkProblem(key, text) {
  return `<a class="vj-prob-link" href="vjudge-problem:${encodeURIComponent(key)}">${escapeHtml(text || key)}</a>`;
}

function linkContest(id, text) {
  return `<a class="vj-prob-link" href="vjudge-contest:${encodeURIComponent(id)}">${escapeHtml(text || `#${id}`)}</a>`;
}

function linkArticle(id, text) {
  return `<a class="vj-prob-link" href="vjudge-article:${encodeURIComponent(id)}">${escapeHtml(text || `文章 #${id}`)}</a>`;
}

/**
 * 题名里常常自带题号（比赛列表给的是 "Potions (Hard Version) - CodeForces-1526C2"），
 * 再拼一次 `${key} · ${title}` 就出现重复题号，顺手去掉尾巴。
 */
function cleanTitle(title, key) {
  const raw = String(title || '').trim();
  const k = String(key || '').trim();
  if (!raw || !k) return raw;
  if (raw.toLowerCase().endsWith(k.toLowerCase())) {
    const head = raw
      .slice(0, raw.length - k.length)
      .replace(/[\s\-–—:·]+$/, '')
      .trim();
    if (head) return head;
  }
  return raw;
}

function emptyState(title, detail, hint) {
  return `<div class="vj-empty">
    <div class="vj-empty__icon">◍</div>
    <div class="vj-empty__title">${escapeHtml(title)}</div>
    ${detail ? `<div class="vj-empty__detail">${escapeHtml(detail)}</div>` : ''}
    ${hint ? `<div class="vj-empty__hint">${hint}</div>` : ''}
  </div>`;
}

/** 题面面板 */
function renderProblem(problem, options = {}) {
  const meta = [
    { label: 'OJ', value: problem.oj },
    { label: '题号', value: problem.num },
  ];
  if (problem.timeLimit) meta.push({ label: '时限', value: problem.timeLimit });
  if (problem.memoryLimit) meta.push({ label: '内存', value: problem.memoryLimit });
  if (problem.source) meta.push({ label: '来源', value: problem.source });
  if (problem.descLang) meta.push({ label: '题面语言', value: problem.descLang });

  // Codeforces 之类的题 VJudge 不允许默认账号代交，必须用自己绑定的账号
  const methods = submitMethodsOf(problem);
  const needOwnAccount = methods.known && !methods.defaultAccount && methods.ownAccount;
  const archiveOnly = methods.known && !methods.defaultAccount && !methods.ownAccount;
  if (needOwnAccount) {
    meta.push({ label: '提交方式', value: '用你自己的账号（VJudge 不代交这道题）', tone: 'warn' });
  } else if (archiveOnly) {
    meta.push({ label: '提交方式', value: '仅存档（不能判题）', tone: 'warn' });
  }
  if (options.contestId) {
    const ended = options.contestEnded === true;
    meta.push({
      label: '比赛',
      value: `#${options.contestId}${options.problemNum ? ` · ${options.problemNum} 题` : ''}${ended ? '（已结束）' : ''}`,
      tone: ended ? 'muted' : 'warn',
    });
    if (options.contestTitle) meta.push({ label: '', value: options.contestTitle });
    if (ended) {
      meta.push({
        label: '',
        value: '比赛已结束：提交会记在这场比赛下（练习模式），不计入榜单',
        tone: 'muted',
      });
    }
  }

  const submitAction = {
    id: 'submit',
    label: options.contestId
      ? `提交到比赛${options.problemNum ? ` ${options.problemNum}` : ''}`
      : '提交代码',
    primary: true,
    title: options.contestEnded
      ? `比赛 #${options.contestId} 已结束：提交会记在这场比赛下（练习模式），不计入榜单；万一 VJudge 关掉了比赛通道，会自动改走补题`
      : options.contestId
        ? `把编辑器里的代码交到比赛 #${options.contestId} 的 ${options.problemNum || ''} 题（会计入这场比赛的榜单）`
        : '把编辑器里的代码提交到这道题',
  };

  if (needOwnAccount) {
    submitAction.title = `VJudge 不允许用默认账号提交这道题，会用你在 ${problem.oj || '该 OJ'} 上绑定的账号提交`;
  } else if (archiveOnly) {
    submitAction.title = '这道题在 VJudge 上只能存档、不能判题';
  }

  const actions = [
    submitAction,
    options.contestId
      ? { id: 'contest', label: '返回比赛', title: '回到这场比赛的面板（含实时榜单）' }
      : null,
    { id: 'browser', label: '浏览器打开' },
    {
      id: 'submissions',
      label: '提交记录',
      title: '看这道题的提交记录：默认只看我的（能看源码），可切「全部」看别人的（VJudge 只给图片）',
    },
    { id: 'copy', label: '复制链接' },
    { id: 'favorite', label: options.isFavorite ? '★ 已收藏' : '☆ 收藏', primary: false },
    { id: 'refresh', label: '刷新' },
  ].filter(Boolean);
  if (Array.isArray(problem.descVersions) && problem.descVersions.length > 1) {
    actions.splice(1, 0, { id: 'version', label: `切换题面（${problem.descVersions.length}）` });
  }

  let body;
  if (problem.statementHtml) {
    body = `<article class="vj-statement vj-markdown">${problem.statementHtml}</article>`;
  } else {
    const raw = problem.rawHtml
      ? `<details class="vj-raw"><summary>查看页面原始内容（用于排查）</summary><pre>${escapeHtml(problem.rawHtml)}</pre></details>`
      : '';
    const diag = problem.diagnostics
      ? `<details class="vj-raw"><summary>诊断信息</summary><pre>${escapeHtml(
          JSON.stringify(problem.diagnostics, null, 2)
        )}</pre></details>`
      : '';
    const needLogin = problem.diagnostics && problem.diagnostics.hasDataJson === false;
    body = emptyState(
      needLogin ? '暂时拿不到题面（需要登录）' : '拿不到这道题的题面',
      needLogin
        ? 'VJudge 的题目页要登录才返回数据，所以现在只拿到了登录页。'
        : '题目页本身读到了，但 VJudge 没有给出题面正文（可能是题面还没爬取，或被设成隐藏）。',
      (needLogin
        ? '执行命令「VJudge: 登录 / 更新凭据」，或「手动粘贴 Cookie」。'
        : '点「浏览器打开」确认网页上是否能看到题面。') + raw + diag
    );
  }

  const footer = `<span>${escapeHtml(problem.url || '')}</span><span>${
    problem.statementSource && problem.statementSource !== 'none' ? `解析方式：${escapeHtml(problem.statementSource)}` : ''
  }</span>`;

  return {
    title: `${problem.key} · ${cleanTitle(problem.title, problem.key)}`,
    subtitle: 'VJudge 题面',
    meta,
    actions,
    body,
    footer,
    data: problem,
  };
}

/** 团队面板 */
function renderGroup(group) {
  const now = Date.now();
  const running = group.contests.filter((c) => c.state === 'running').length;
  const upcoming = group.contests.filter((c) => c.state === 'upcoming').length;

  const meta = [
    { label: '成员', value: String(group.members.length || '-') },
    { label: '公开性', value: group.isPublic ? '公开团队' : '私密团队' },
    { label: '加入方式', value: group.joinPolicyLabel },
  ];
  if (running) meta.push({ label: '进行中', value: `${running} 场`, tone: 'ok' });
  if (upcoming) meta.push({ label: '即将开始', value: `${upcoming} 场`, tone: 'warn' });
  meta.push({ label: '比赛', value: String(group.contests.length) });
  if (group.articles.length) meta.push({ label: '文章', value: String(group.articles.length) });

  const actions = [
    { id: 'browser', label: '浏览器打开' },
    { id: 'copy', label: '复制链接' },
    { id: 'refresh', label: '刷新' },
  ];

  const introSection = group.introHtml
    ? `<article class="vj-markdown">${group.introHtml}</article>`
    : group.brief
      ? `<p class="vj-dim">${escapeHtml(group.brief)}</p>`
      : emptyState('这个团队还没有简介', `团队短名：${group.shortName}`, '点「浏览器打开」可以到 VJudge 上查看更完整的信息。');

  let contestSection;
  if (group.contests.length) {
    const rows = group.contests
      .slice(0, 200)
      .map((c) => {
        const state = c.state === 'running' ? '进行中' : c.state === 'upcoming' ? '未开始' : '已结束';
        const tone = c.state === 'running' ? 'ok' : c.state === 'upcoming' ? 'warn' : 'muted';
        const contestants = c.contestants != null ? escapeHtml(String(c.contestants)) : '-';
        return `<tr><td>${linkContest(c.id, c.title)}</td><td class="vj-dim">${escapeHtml(
          formatDateTime(c.begin)
        )}</td><td class="vj-dim">${contestants}</td><td class="vj-state vj-state--${tone}">${escapeHtml(
          state
        )}</td></tr>`;
      })
      .join('');
    contestSection = `<section class="vj-problem-table">
      <h2>团队比赛（${group.contests.length}）</h2>
      <table><thead><tr><th>比赛</th><th>开始时间</th><th>参赛</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  } else {
    contestSection = `<section class="vj-problem-table"><h2>团队比赛（0）</h2><p class="vj-dim">这个团队还没有创建比赛。</p></section>`;
  }

  let articleSection = '';
  if (group.articles.length) {
    const items = group.articles
      .slice(0, 200)
      .map((a) => `<li>${linkArticle(a.id, a.title)}</li>`)
      .join('');
    articleSection = `<section class="vj-problem-list">
      <h2>团队文章（${group.articles.length}）</h2>
      <ul>${items}</ul>
    </section>`;
  }

  let memberSection;
  if (group.members.length) {
    const rows = group.members
      .slice(0, 300)
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.nickName || m.username)}</td><td class="vj-dim">${escapeHtml(
            m.username
          )}</td><td class="vj-state${m.role >= 1 ? ' vj-state--ok' : ' vj-state--muted'}">${escapeHtml(
            m.roleLabel
          )}</td><td class="vj-dim">${escapeHtml(formatDateTime(m.joined))}</td></tr>`
      )
      .join('');
    memberSection = `<section class="vj-problem-table">
      <h2>成员（${group.members.length}）</h2>
      <table><thead><tr><th>昵称</th><th>用户名</th><th>角色</th><th>加入时间</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  } else {
    memberSection = `<section class="vj-problem-table"><h2>成员（0）</h2><p class="vj-dim">成员名单不可见（可能需要加入团队后才能查看）。</p></section>`;
  }

  const info = `<section class="vj-contest-info">
      <div class="vj-kv"><span>团队名称</span><b>${escapeHtml(group.name)}</b></div>
      <div class="vj-kv"><span>短名</span><b>${escapeHtml(group.shortName)}</b></div>
      <div class="vj-kv"><span>团队 ID</span><b>${escapeHtml(String(group.id))}</b></div>
      <div class="vj-kv"><span>公开性</span><b>${group.isPublic ? '公开' : '私密'}</b></div>
      <div class="vj-kv"><span>加入方式</span><b>${escapeHtml(group.joinPolicyLabel)}</b></div>
      ${group.arrangeContestPolicyLabel ? `<div class="vj-kv"><span>比赛创建</span><b>${escapeHtml(group.arrangeContestPolicyLabel)}</b></div>` : ''}
    </section>`;

  return {
    title: group.name,
    subtitle: `VJudge 团队 · ${group.shortName}`,
    meta,
    actions,
    body: `${introSection}${info}${contestSection}${articleSection}${memberSection}`,
    footer: `<span>${escapeHtml(group.url || '')}</span>`,
    data: group,
  };
}

/** 文章面板 */
function renderArticle(article, options = {}) {
  const meta = [];
  if (article.author) meta.push({ label: '作者', value: article.author });
  if (article.createTime) meta.push({ label: '发布于', value: formatDateTime(article.createTime) });
  if (article.viewCnt != null) meta.push({ label: '阅读', value: String(article.viewCnt) });
  if (article.likeCnt != null) meta.push({ label: '点赞', value: String(article.likeCnt) });
  if (article.isWorkbook) meta.push({ label: '类型', value: '题单 / 题解集' });

  const actions = [
    { id: 'browser', label: '浏览器打开' },
    { id: 'copy', label: '复制链接' },
    { id: 'favorite', label: options.isFavorite ? '★ 已收藏' : '☆ 收藏' },
    { id: 'refresh', label: '刷新' },
  ];

  const html = renderMarkdown(article.content || '', {
    problemLink: (key) => `vjudge-problem:${encodeURIComponent(key)}`,
  });

  let problemList = '';
  if (article.problems && article.problems.length) {
    const items = article.problems.slice(0, 300).map((p) => {
      const stats =
        p.acCount != null
          ? `<span class="vj-prob-stats">AC ${p.acCount} / ${p.submitCount != null ? p.submitCount : '?'}</span>`
          : '';
      return `<li>${linkProblem(p.key, p.key)}<span class="vj-prob-title">${escapeHtml(p.title || '')}</span>${stats}</li>`;
    });
    problemList = `<section class="vj-problem-list">
      <h2>本文章包含 ${article.problems.length} 道题目</h2>
      <ul>${items.join('')}</ul>
    </section>`;
  }

  return {
    title: article.title || `文章 ${article.id}`,
    subtitle: 'VJudge 文章',
    meta,
    actions,
    body: `<article class="vj-markdown">${html || emptyState('这篇文章没有正文', '', '')}</article>${problemList}`,
    footer: `<span>${escapeHtml(article.url || '')}</span>`,
    data: article,
  };
}

/** 榜单表格：初始渲染和「实时刷新」共用同一段 HTML */
function renderStandingsInner(standings, options = {}) {
  if (!standings) {
    return `<p class="vj-dim">${escapeHtml(options.emptyText || '正在读取榜单…')}</p>`;
  }
  const rows = Array.isArray(standings.rows) ? standings.rows : [];
  const problems = Array.isArray(standings.problems) ? standings.problems : [];
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 300;

  const banners = [];
  if (standings.frozen) {
    banners.push(
      `<div class="vj-banner vj-banner--warn">封榜中：${
        standings.frozenUntil ? `解冻时间 ${escapeHtml(formatDateTime(standings.frozenUntil))}` : '管理员已封榜'
      }，之后的提交按「未通过」显示。</div>`
    );
  }
  if (standings.partialScore) {
    banners.push(`<div class="vj-banner">这场比赛按分数排名（部分分），不是纯 ICPC 罚时。</div>`);
  }
  if (standings.includePractice) {
    banners.push(
      `<div class="vj-banner vj-banner--warn">已包含<b>赛后补题</b>：标 † 的是比赛结束后才通过的，排名会因此比「仅赛时」好看。</div>`
    );
  }

  if (!rows.length) {
    return `${banners.join('')}<p class="vj-dim">还没有人参赛或提交。</p>`;
  }

  const head = problems
    .map(
      (p) =>
        `<th class="vj-st__prob" title="${escapeHtml(
          `${p.label}. ${p.title || p.key || ''}（AC ${p.acCount}）`
        )}">${escapeHtml(p.label)}</th>`
    )
    .join('');

  const renderRow = (row) => {
    const cells = row.cells
      .map((cell) => {
        if (cell.acSeconds !== null) {
          const extra = cell.fails ? `<sup class="vj-st__fails">+${cell.fails}</sup>` : '';
          // †＝赛后补题通过（只有开了「含补题」才可能出现）
          const up = cell.upsolved
            ? `<sup class="vj-st__upsolve" title="赛后补题（不计入赛时成绩）">†</sup>`
            : '';
          const tip = `${cell.upsolved ? '赛后补题通过' : '通过'}于 ${formatClock(cell.acSeconds)}${
            cell.fails ? `，此前错 ${cell.fails} 次` : ''
          }`;
          return `<td class="vj-st__cell vj-st__cell--ac${
            cell.upsolved ? ' is-upsolve' : ''
          }" title="${escapeHtml(tip)}">${formatClock(cell.acSeconds)}${extra}${up}</td>`;
        }
        if (cell.fails > 0) {
          return `<td class="vj-st__cell vj-st__cell--fail" title="未通过 ${cell.fails} 次">${'-'.repeat(
            Math.min(cell.fails, 6)
          )}${cell.fails > 6 ? ` ${cell.fails}` : ''}</td>`;
        }
        return `<td class="vj-st__cell"></td>`;
      })
      .join('');
    const who =
      row.type === 'team'
        ? `<span class="vj-st__name">${escapeHtml(row.name)}</span>${
            row.members.length ? `<span class="vj-st__nick">${escapeHtml(row.members.slice(0, 3).join(', '))}</span>` : ''
          }`
        : `<span class="vj-st__name">${escapeHtml(row.name)}</span>${
            row.nickname && row.nickname !== row.name
              ? `<span class="vj-st__nick">${escapeHtml(row.nickname)}</span>`
              : ''
          }`;
    return `<tr class="vj-st__row${row.isMe ? ' is-me' : ''}">
      <td class="vj-st__rank">${row.rank}</td>
      <td class="vj-st__who">${row.isMe ? '<span class="vj-st__me">你</span>' : ''}${who}</td>
      <td class="vj-st__num">${row.solved}</td>
      <td class="vj-st__num">${formatPenalty(row.penalty)}</td>
      ${cells}
    </tr>`;
  };

  const shown = rows.slice(0, limit);
  const body = shown.map(renderRow).join('');
  const myRow = standings.myRank > limit ? rows.find((r) => r.isMe) : null;

  const notes = [];
  notes.push(`${standings.participantCount} 人参赛`);
  if (standings.myRank) notes.push(`你当前第 ${standings.myRank} 名`);
  if (rows.length > limit) notes.push(`榜单只显示前 ${limit} 名`);

  return `${banners.join('')}
    <div class="vj-st__scroll">
      <table class="vj-st">
        <thead><tr><th class="vj-st__rank">#</th><th class="vj-st__who">参赛者</th><th class="vj-st__num">AC</th><th class="vj-st__num">罚时</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${myRow ? `<div class="vj-st__mine">${renderRow(myRow)}</div>` : ''}
    <p class="vj-dim vj-st__note">${escapeHtml(notes.join(' · '))}</p>`;
}

/** 比赛面板 */
function renderContest(contest, options = {}) {
  const now = Date.now();
  const state = contest.ended || (contest.end && now > contest.end) ? '已结束' : contest.begin && now < contest.begin ? '未开始' : '进行中';
  const tone = state === '进行中' ? 'ok' : state === '未开始' ? 'warn' : 'muted';

  const meta = [
    { label: '状态', value: state, tone },
    { label: '开始', value: formatDateTime(contest.begin) },
    { label: '结束', value: formatDateTime(contest.end) },
  ];
  if (contest.opennessLabel) meta.push({ label: '类型', value: contest.opennessLabel });
  if (contest.begin && now < contest.begin) {
    meta.push({ label: '', value: `${relativeTime(contest.begin, now)}开始`, tone: 'warn' });
  }
  if (contest.begin && contest.end && now >= contest.begin && now <= contest.end) {
    meta.push({ label: '剩余', value: relativeTime(contest.end, now).replace('后', ''), tone: 'ok' });
  }

  const actions = [
    { id: 'browser', label: '浏览器打开' },
    { id: 'copy', label: '复制链接' },
    { id: 'rankRefresh', label: '刷新榜单' },
    { id: 'rank', label: '网页看榜' },
    { id: 'refresh', label: '刷新' },
  ];
  if (!contest.problems || !contest.problems.length) {
    if (contest.access && contest.access.needLogin) actions.unshift({ id: 'login', label: '登录 VJudge' });
  }

  let problemSection;
  if (contest.problems && contest.problems.length) {
    const rows = contest.problems
      .map((p) => {
        const label = p.key || p.source || `题目 ${p.index}`;
        // 私有比赛可能隐藏原题出处，这时只能跳原网页的题目锚点
        const name = p.key
          ? linkProblem(p.key, p.key)
          : `<a class="vj-prob-link" href="${contest.url}#problem/${encodeURIComponent(
              String(p.index || '')
            )}">${escapeHtml(label)}</a>`;
        const extra = [p.timeLimit, p.memoryLimit].filter(Boolean).join(' / ');
        return `<tr><td class="vj-index">${escapeHtml(String(p.index || ''))}</td><td>${name}</td><td>${escapeHtml(
          p.title || ''
        )}</td><td class="vj-dim">${escapeHtml(extra)}</td></tr>`;
      })
      .join('');
    problemSection = `<section class="vj-problem-table">
      <h2>题目列表（${contest.problems.length}）</h2>
      <table><thead><tr><th>#</th><th>题目</th><th>标题</th><th>限制</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="vj-dim">${
        state === '已结束'
          ? '比赛已结束，点题号进去还能继续交：提交会记在这场比赛下（练习模式），不计入榜单。'
          : '点题号进入题面后，面板上的「提交」会自动算进这场比赛（走比赛接口，不用回网页）。'
      }</p>
    </section>`;
  } else {
    const access = contest.access || {};
    const notes = [];
    if (contest.opennessLabel) notes.push(`比赛类型：${contest.opennessLabel}`);
    if (contest.accessLabel) notes.push(`当前权限：${contest.accessLabel}`);
    if (access.needLogin && contest.loggedIn === false) notes.push('你还没有在插件里配置 VJudge 登录凭据');
    problemSection = emptyState(
      access.title || '题目列表暂不可见',
      access.detail || contest.problemsError || '该比赛的题目需要报名或登录后才能查看。',
      [access.hint, notes.join('；')].filter(Boolean).join('　')
    );
  }

  const interval = Number(options.pollInterval) > 0 ? Number(options.pollInterval) : 0;
  const includePractice = !!options.includePractice;
  const standingsSection = `<section class="vj-standings" id="vj-standings-section">
    <div class="vj-standings__head">
      <h2>实时榜单</h2>
      <span class="vj-live${interval ? '' : ' is-off'}" id="vj-live-hint">${
        interval ? `<i class="vj-live__dot"></i>每 ${interval} 秒自动刷新` : '自动刷新已关闭（设置 vjudgeHelper.standingsInterval）'
      }</span>
      <span class="vj-dim" id="vj-standings-updated">${
        options.standings ? `更新于 ${new Date(options.standings.updatedAt).toLocaleTimeString('zh-CN')}` : ''
      }</span>
      <button class="vj-btn vj-btn--mini${includePractice ? ' is-on' : ''}" id="vj-practice-toggle"
        data-action="standingsPractice" data-on="${includePractice ? '1' : '0'}"
        title="切到「含补题」会把比赛结束后才通过的提交也算进排名（标 †）">${
          includePractice ? '含赛后补题 ✓' : '仅赛时'
        }</button>
      <button class="vj-btn vj-btn--mini" data-action="rankRefresh">立即刷新</button>
    </div>
    <div id="vj-standings-inner">${renderStandingsInner(options.standings, {
      emptyText: options.standingsError,
    })}</div>
  </section>`;

  const discussionSection = renderContestDiscussion(options.discussion, {
    contestId: contest.id,
    error: options.discussionError,
    me: options.me,
  });

  return {
    title: contest.title || `比赛 ${contest.id}`,
    subtitle: 'VJudge 比赛',
    meta,
    actions,
    body: `<section class="vj-contest-info">
      <div class="vj-kv"><span>比赛 ID</span><b>${escapeHtml(String(contest.id))}</b></div>
      <div class="vj-kv"><span>开始时间</span><b>${escapeHtml(formatDateTime(contest.begin))}</b></div>
      <div class="vj-kv"><span>结束时间</span><b>${escapeHtml(formatDateTime(contest.end))}</b></div>
      <div class="vj-kv"><span>状态</span><b>${escapeHtml(state)}</b>${
        contest.end && now < contest.end
          ? ` <span class="vj-dim">剩余 <b data-vj-countdown="${contest.end}">--:--</b></span>`
          : ''
      }</div>
      ${contest.opennessLabel ? `<div class="vj-kv"><span>比赛类型</span><b>${escapeHtml(contest.opennessLabel)}</b></div>` : ''}
      ${contest.accessLabel ? `<div class="vj-kv"><span>当前权限</span><b>${escapeHtml(contest.accessLabel)}</b></div>` : ''}
    </section>${standingsSection}${problemSection}${discussionSection}`,
    footer: `<span>${escapeHtml(contest.url || '')}</span>`,
    data: contest,
  };
}

/* ------------------------------------------------------------------ */
/* 私信                                                                */
/* ------------------------------------------------------------------ */

/** 头像位置只放首字母：站点头像是 /user/avatar/<id>，带登录态，webview 里加载会掉图 */
function avatarInitial(name) {
  const text = String(name || '?').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

/** 会话列表（左栏）。data-contact 是点击时回传给扩展的 id */
function renderContactList(contacts, activeId) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (!list.length) {
    return `<ul class="vj-pm__list" id="vj-pm-list"><li class="vj-pm__empty">还没有任何会话</li></ul>`;
  }
  const items = list
    .map((c) => {
      const active = String(c.id) === String(activeId);
      const preview = String(c.preview || '').replace(/\s+/g, ' ').trim();
      return `<li class="vj-pm__item${active ? ' is-active' : ''}${c.unread ? ' is-unread' : ''}" data-contact="${
        escapeHtml(c.id)
      }" title="${escapeHtml(c.name)}">
        <span class="vj-pm__avatar">${escapeHtml(avatarInitial(c.name))}</span>
        <span class="vj-pm__who">
          <b>${escapeHtml(c.name || `#${c.id}`)}</b>
          <span class="vj-pm__time">${escapeHtml(c.timeText || '')}</span>
        </span>
        <span class="vj-pm__preview">${escapeHtml(preview)}</span>
      </li>`;
    })
    .join('');
  return `<ul class="vj-pm__list" id="vj-pm-list">${items}</ul>`;
}

/**
 * 一段会话的内容（可单独替换，切联系人时只换这块）
 * @param {{messages: object[], blockedByMe: boolean, canBlock: boolean, start: number}} conversation
 * @param {{contact?: object, me?: string, error?: string}} options
 */
function renderConversationInner(conversation, options = {}) {
  const contact = options.contact || {};
  const me = String(options.me || '');
  if (options.error) {
    return `<div class="vj-pm__thread">${emptyState('打不开这个会话', options.error)}</div>`;
  }
  if (!conversation) {
    return `<div class="vj-pm__thread"><p class="vj-dim">选择左侧的联系人开始看私信。</p></div>`;
  }

  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const blocked = conversation.blockedByMe === true;
  const hasOlder = conversation.start > 0 || messages.length >= 20;

  const head = `<div class="vj-pm__head">
    <span class="vj-pm__avatar vj-pm__avatar--lg">${escapeHtml(avatarInitial(contact.name))}</span>
    <b>${escapeHtml(contact.name || `#${conversation.contactId}`)}</b>
    <span class="vj-dim">${messages.length ? `${messages.length} 条` : ''}</span>
    ${
      conversation.canBlock === false
        ? ''
        : `<button class="vj-btn vj-btn--mini${blocked ? ' is-on' : ''}" data-action="pmBlock" data-blocked="${
            blocked ? '1' : '0'
          }">${blocked ? '解除拉黑' : '拉黑'}</button>`
    }
    <button class="vj-btn vj-btn--mini" data-action="pmRefresh">刷新</button>
  </div>`;

  const banner = blocked
    ? `<div class="vj-banner vj-banner--warn">已拉黑这个会话：双方都发不了消息。</div>`
    : '';

  const body = messages.length
    ? messages
        .map((m) => {
          const mine = !!me && m.author === me;
          const html = renderMarkdown(normalizeMathTokens(m.content || ''));
          return `<div class="vj-pm__msg${mine ? ' is-me' : ''}">
            <div class="vj-pm__meta">
              <b>${escapeHtml(m.author || '?')}</b>
              <span class="vj-dim">${escapeHtml(formatDateTime(m.time))}</span>
              <button class="vj-pm__del" data-action="pmDelete" data-id="${escapeHtml(
                m.id
              )}" title="撤回这条消息">×</button>
            </div>
            <div class="vj-md">${html}</div>
          </div>`;
        })
        .join('')
    : `<p class="vj-dim">还没有聊过，往下写第一句吧。</p>`;

  const older = hasOlder
    ? `<button class="vj-btn vj-btn--mini" data-action="pmOlder">查看更早消息</button>`
    : '';

  return `${head}${banner}
    <div class="vj-pm__thread" id="vj-pm-thread">${older}${body}</div>
    <div class="vj-pm__compose">
      <textarea id="vj-pm-input" rows="3" placeholder="用 Markdown 写，Ctrl+Enter 发送"${
        blocked ? ' disabled' : ''
      }></textarea>
      <div class="vj-pm__compose-bar">
        <span class="vj-dim">${blocked ? '已拉黑，不能发送' : 'Ctrl+Enter 发送'}</span>
        <button class="vj-btn vj-btn--primary" data-action="pmSend"${blocked ? ' disabled' : ''}>发送</button>
      </div>
    </div>`;
}

/** 私信面板（整页） */
function renderMessage(view, options = {}) {
  const contacts = (view && view.contacts) || [];
  const activeId = view && view.activeId ? String(view.activeId) : '';
  const contact = contacts.find((c) => String(c.id) === activeId) || {};

  const meta = [{ label: '会话', value: String(contacts.length) }];
  if (view && view.me) meta.push({ label: '登录为', value: view.me });

  const actions = [{ id: 'pmRefreshList', label: '刷新列表' }, { id: 'browser', label: '浏览器打开' }];

  const body = view && view.error
    ? emptyState('私信打不开', view.error, '私信需要登录 VJudge；登录后重开这个面板即可。')
    : `<div class="vj-pm">
        <aside class="vj-pm__contacts">
          <div class="vj-pm__contacts-head">私信 <span class="vj-dim">${contacts.length}</span></div>
          ${renderContactList(contacts, activeId)}
        </aside>
        <section class="vj-pm__conversation" id="vj-pm-conversation" data-contact="${escapeHtml(
          activeId
        )}" data-me="${escapeHtml((view && view.me) || '')}">
          ${renderConversationInner(view && view.conversation, {
            contact,
            me: (view && view.me) || '',
            error: (view && view.conversationError) || '',
          })}
        </section>
      </div>`;

  return {
    title: 'VJudge 私信',
    subtitle: view && view.me ? `登录为 ${view.me}` : 'VJudge 站内私信',
    meta,
    actions,
    body,
    footer: `<span>${escapeHtml((view && view.url) || '')}</span>`,
    data: view,
  };
}

/* ------------------------------------------------------------------ */
/* 讨论区（文章 / 比赛 / 题目共用一套评论）                              */
/* ------------------------------------------------------------------ */

/** 把扁平 posts 组织成 parentId → children 的树，深度最多 3 层 */
function buildCommentTree(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const byParent = new Map();
  for (const post of list) {
    const key = String(post.parentId || '0');
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(post);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.time - b.time);
  return byParent;
}

/** 讨论区帖子列表（可单独替换） */
function renderDiscussionPosts(discussion, options = {}) {
  if (options.error) return `<p class="vj-dim">${escapeHtml(options.error)}</p>`;
  if (!discussion) return `<p class="vj-dim">正在读取讨论区…</p>`;

  const posts = Array.isArray(discussion.posts) ? discussion.posts : [];
  if (!posts.length) return `<p class="vj-dim">这里还没有人发言，抢个沙发？</p>`;

  const byParent = buildCommentTree(posts);
  const myId = String(options.myId || '');
  const shown = new Set();

  const renderOne = (post, depth) => {
    if (!post || shown.has(post.id)) return '';
    shown.add(post.id);
    const children = (byParent.get(String(post.id)) || []).filter((c) => !shown.has(c.id));
    const mine = !!myId && String(post.authorId || '') === myId;
    const content = post.deleted
      ? '<span class="vj-dim">[已删除]</span>'
      : renderMarkdown(normalizeMathTokens(post.content || ''));
    const kids =
      depth < 3 && children.length
        ? `<div class="vj-discuss__kids">${children.map((c) => renderOne(c, depth + 1)).join('')}</div>`
        : '';

    return `<article class="vj-discuss__post${post.deleted ? ' is-deleted' : ''}${
      mine ? ' is-me' : ''
    }" data-post="${escapeHtml(post.id)}">
      <div class="vj-discuss__meta">
        <span class="vj-pm__avatar">${escapeHtml(avatarInitial(post.author))}</span>
        <b>${escapeHtml(post.author || '?')}</b>
        <span class="vj-dim">${escapeHtml(formatDateTime(post.time))}</span>
        ${post.likeCnt ? `<span class="vj-dim">👍 ${post.likeCnt}</span>` : ''}
        ${post.deleted ? '' : `<button class="vj-btn vj-btn--mini" data-action="discussReply" data-post="${escapeHtml(post.id)}" data-author="${escapeHtml(post.author || '')}">回复</button>`}
        ${mine && !post.deleted ? `<button class="vj-btn vj-btn--mini" data-action="discussDelete" data-post="${escapeHtml(post.id)}">删除</button>` : ''}
      </div>
      <div class="vj-md">${content}</div>
      ${kids}
    </article>`;
  };

  const roots = (byParent.get('0') || []).slice();
  // 父帖不在这批数据里的（分页截断）也当根节点显示，免得整棵树消失
  for (const post of posts) {
    if (!byParent.has(String(post.parentId || '0')) && String(post.parentId || '0') !== '0') roots.push(post);
  }
  if (!roots.length) roots.push(...posts);
  roots.sort((a, b) => (b.topIndex || 0) - (a.topIndex || 0) || a.time - b.time);

  return roots.map((p) => renderOne(p, 0)).join('');
}

/**
 * 比赛讨论区整块。
 * @param {object|null} discussion fetchDiscussion 的返回
 * @param {{contestId?: string, error?: string, me?: string}} options
 */
function renderContestDiscussion(discussion, options = {}) {
  const count = discussion ? discussion.commentNumber || (discussion.posts || []).length : 0;
  return `<section class="vj-discuss" id="vj-discussion-section">
    <div class="vj-standings__head">
      <h2>讨论区</h2>
      <span class="vj-dim" id="vj-discuss-count">${count ? `${count} 条评论` : ''}</span>
      <button class="vj-btn vj-btn--mini" data-action="discussRefresh">刷新</button>
      <button class="vj-btn vj-btn--mini" data-action="discussBrowser">网页打开</button>
    </div>
    <div id="vj-discussion-posts">${renderDiscussionPosts(discussion, options)}</div>
    <div class="vj-discuss__compose">
      <div class="vj-discuss__replyto" id="vj-discuss-replyto" hidden>
        回复 <b id="vj-discuss-reply-name"></b>
        <button class="vj-btn vj-btn--mini" data-action="discussCancelReply">取消</button>
      </div>
      <textarea id="vj-discuss-input" rows="3" placeholder="用 Markdown 写，Ctrl+Enter 发表"></textarea>
      <div class="vj-discuss__compose-bar">
        <span class="vj-dim">Ctrl+Enter 发表 · 讨论区是公开的，注意别透露题解以外的隐私</span>
        <button class="vj-btn vj-btn--primary" data-action="discussSend">发表</button>
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* 提交记录                                                            */
/* ------------------------------------------------------------------ */

const RESULT_CLASS = {
  accepted: 'is-ac',
  failed: 'is-fail',
  pending: 'is-pending',
};

function resultKind(row) {
  const status = String((row && row.status) || '');
  if (row && row.processing === true) return 'pending';
  if (row && row.statusType === 1) return 'accepted';
  if (row && row.statusType === 2) return 'failed';
  if (/^accepted$/i.test(status)) return 'accepted';
  if (!status || /^(pending|queue|judging|running|compiling|processing)$/i.test(status)) return 'pending';
  return 'failed';
}

function formatMemory(kb) {
  const n = Number(kb) || 0;
  if (!n) return '—';
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${n} KB`;
}

/** 行里显示的题目标签：优先 `OJ-题号`，缺字段就退回 problemKey */
function submissionProblemLabel(row) {
  const r = row || {};
  if (r.oj && r.probNum) return `${r.oj}-${r.probNum}`;
  return r.problemKey || '';
}

/** 一行提交 */
function renderSubmissionRow(row, options = {}) {
  const me = String(options.me || '');
  const kind = resultKind(row);
  const mine = !!me && row.userName === me;
  const label = submissionProblemLabel(row);
  const problem = row.problemKey ? linkProblem(row.problemKey, label) : escapeHtml(label);
  const contest = row.contestId
    ? ` <a class="vj-sub__contest" href="vjudge-contest:${encodeURIComponent(row.contestId)}" title="这场比赛里的 ${escapeHtml(
        row.contestNum || '?'
      )} 题">#${escapeHtml(row.contestId)}${row.contestNum ? ` ${escapeHtml(row.contestNum)}` : ''}</a>`
    : '';
  return `<tr class="vj-sub ${RESULT_CLASS[kind] || ''}${mine ? ' is-me' : ''}" data-action="subOpen" data-run="${escapeHtml(
    row.runId
  )}" title="点击查看这条提交的代码">
    <td class="vj-sub__time">${escapeHtml(formatDateTime(row.time))}</td>
    <td class="vj-sub__user">${
      mine ? `<b>${escapeHtml(row.userName)}</b>` : `<a href="vjudge-user:${encodeURIComponent(row.userName)}">${escapeHtml(row.userName)}</a>`
    }</td>
    <td class="vj-sub__prob">${problem}${contest}</td>
    <td class="vj-sub__res">${escapeHtml(row.status || (row.processing ? '判题中…' : '?'))}</td>
    <td class="vj-sub__num">${row.runtime ? `${row.runtime} ms` : '—'}</td>
    <td class="vj-sub__num">${escapeHtml(formatMemory(row.memory))}</td>
    <td class="vj-sub__lang">${escapeHtml(row.language || '—')}</td>
    <td class="vj-sub__num">${row.length ? `${row.length} B` : '—'}</td>
    <td class="vj-sub__act"><span class="vj-sub__open">代码</span></td>
  </tr>`;
}

/** 列表主体（可单独替换，加载更多时只换这一块） */
function renderSubmissionsInner(view) {
  const v = view || {};
  if (v.error) {
    return emptyState('提交记录打不开', v.error, '需要登录 VJudge 才能看自己的提交；看全站的提交不用登录。');
  }
  const rows = Array.isArray(v.rows) ? v.rows : [];
  if (!rows.length) {
    return emptyState(
      v.loaded ? '没有符合条件的提交' : '正在读提交记录…',
      v.loaded ? '换个用户名 / 题目，或者把结果筛选改成「全部」' : ''
    );
  }
  const more = v.hasMore
    ? `<div class="vj-subs__more"><button class="vj-btn vj-btn--mini" data-action="subMore">加载更多（已 ${rows.length} 条）</button></div>`
    : `<div class="vj-subs__more vj-dim">已经到底了，共 ${rows.length} 条</div>`;

  return `<table class="vj-subs__tbl">
    <thead>
      <tr>
        <th>时间</th><th>用户</th><th>题目</th><th>结果</th>
        <th>用时</th><th>内存</th><th>语言</th><th>长度</th><th></th>
      </tr>
    </thead>
    <tbody>${rows.map((row) => renderSubmissionRow(row, { me: v.me })).join('')}</tbody>
  </table>${more}`;
}

/** 单条提交的代码视图 */
function renderSubmissionDetail(detail, options = {}) {
  const d = detail || {};
  const row = d.row || {};
  const me = String(options.me || '');
  const kind = resultKind(row);
  const back = `<button class="vj-btn vj-btn--mini" data-action="subBack">← 返回列表</button>`;

  const metaBits = [
    row.userName ? `<b>${escapeHtml(row.userName)}</b>${row.userName === me ? '（我）' : ''}` : '',
    row.problemKey
      ? linkProblem(row.problemKey, submissionProblemLabel(row))
      : '',
    row.status ? `<span class="vj-sub__res ${RESULT_CLASS[kind] || ''}">${escapeHtml(row.status)}</span>` : '',
    row.runtime ? `${row.runtime} ms` : '',
    row.memory ? formatMemory(row.memory) : '',
    row.language || '',
    row.length ? `${row.length} B` : '',
    row.time ? formatDateTime(row.time) : '',
    row.runId ? `#${escapeHtml(row.runId)}` : '',
  ].filter(Boolean);

  const head = `<div class="vj-subd__head">
    ${back}
    <span class="vj-subd__meta">${metaBits.join(' <span class="vj-dim">·</span> ')}</span>
  </div>`;

  if (d.loading) {
    return `${head}<p class="vj-dim">正在取代码…</p>`;
  }

  if (d.error) {
    return `${head}
      <div class="vj-subd__toolbar">
        <button class="vj-btn vj-btn--mini" data-action="subRetry">重新获取</button>
        <button class="vj-btn vj-btn--mini" data-action="browser">在网页上打开</button>
      </div>
      ${emptyState('代码没取到', d.error, '别人的代码 VJudge 只给图片，快照有时要等几秒')}`;
  }

  if (d.kind === 'image') {
    return `${head}
      <figure class="vj-subd__figure">
        <img class="vj-subd__img" src="${escapeHtml(d.dataUri || '')}" alt="提交 ${
          escapeHtml(row.runId || '')
        } 的代码（VJudge 提供的图片）" />
        <figcaption class="vj-dim">VJudge 不给别人看源码文本，只给这张图；右键可以另存。</figcaption>
      </figure>`;
  }

  if (d.kind === 'denied') {
    return `${head}${emptyState('看不到这份代码', d.message || 'VJudge 不给你看这份代码', '去网页上试试，或者登录后再看')}`;
  }

  if (d.kind === 'code') {
    const lang = normalizeHighlightLang(d.language || d.prismClass);
    const cls = lang ? ` class="language-${lang}"` : '';
    const html = highlightCodeBlocks(
      `<pre class="vj-subd__pre"><code${cls}>${escapeHtml(d.code || '')}</code></pre>`
    );
    return `${head}
      <div class="vj-subd__toolbar">
        <button class="vj-btn vj-btn--mini" data-action="copy" data-copy="${escapeHtml(d.code || '')}">复制代码</button>
        <span class="vj-dim">${d.code ? `${String(d.code).split('\n').length} 行` : ''}</span>
      </div>
      ${html}`;
  }

  return `${head}${emptyState('这条提交没有代码', d.message || '可能是提交被删了，或者这条记录不带源码')}`;
}

/** 列表整块（工具栏 + 表格）。切筛选 / 加载更多都整体替换这一块，按钮的选中态才会跟着变 */
function renderSubmissionsBody(view) {
  const v = view || {};
  const scope = v.scope === 'all' ? 'all' : 'mine';
  const onlyAc = v.res === 'AC';
  const filterBits = [];
  if (v.user) filterBits.push(`用户 <b>${escapeHtml(v.user)}</b>`);
  if (v.problemKey) filterBits.push(`题目 ${linkProblem(v.problemKey, v.problemKey)}`);
  if (onlyAc) filterBits.push('只看通过');

  return `<div class="vj-subs__bar">
      <span class="vj-subs__tabs">
        <button class="vj-btn vj-btn--mini${scope === 'mine' ? ' is-on' : ''}" data-action="subScope" data-scope="mine"${
          v.me ? '' : ' title="只看自己需要一个用户名，可能还没登录"'
        }>我的</button>
        <button class="vj-btn vj-btn--mini${scope === 'all' ? ' is-on' : ''}" data-action="subScope" data-scope="all">全部</button>
      </span>
      <span class="vj-subs__tabs">
        <button class="vj-btn vj-btn--mini${onlyAc ? '' : ' is-on'}" data-action="subResult" data-res="all">全部结果</button>
        <button class="vj-btn vj-btn--mini${onlyAc ? ' is-on' : ''}" data-action="subResult" data-res="AC">只看通过</button>
      </span>
      <button class="vj-btn vj-btn--mini" data-action="subUser">${v.user ? '换用户…' : '按用户筛选…'}</button>
      <button class="vj-btn vj-btn--mini" data-action="subProblem">${v.problemKey ? '换题目…' : '按题目筛选…'}</button>
      ${filterBits.length ? `<span class="vj-dim vj-subs__filter">${filterBits.join(' · ')}</span>` : ''}
    </div>
    ${renderSubmissionsInner(v)}`;
}

/** 提交记录整块（工具栏 + 列表） */
function renderSubmissions(view) {
  const v = view || {};
  const scope = v.scope === 'all' ? 'all' : 'mine';
  const label = scope === 'mine' ? '我的提交' : v.user ? `${v.user} 的提交` : '全站提交';
  const counter = Array.isArray(v.rows) ? v.rows.length : 0;

  const meta = [
    { label: '范围', value: label },
    ...(v.me ? [{ label: '登录为', value: v.me }] : []),
    ...(v.problemKey ? [{ label: '题目', value: v.problemKey }] : []),
    { label: '已加载', value: String(counter) },
  ];

  const actions = [
    { id: 'subRefresh', label: '刷新', primary: true },
    { id: 'browser', label: '浏览器打开' },
    { id: 'copy', label: '复制链接', primary: false },
  ];

  const inner = v.detail ? renderSubmissionDetail(v.detail, { me: v.me }) : renderSubmissionsBody(v);
  const body = `<div class="vj-subs" id="vj-sub-inner">${inner}</div>`;

  return {
    title: 'VJudge 提交记录',
    subtitle: label,
    meta,
    actions,
    body,
    footer: `<span>${escapeHtml(v.url || '')}</span>`,
    data: v,
  };
}

module.exports = {
  renderProblem,
  renderArticle,
  renderContest,
  renderGroup,
  renderStandingsInner,
  renderMessage,
  renderContactList,
  renderConversationInner,
  renderContestDiscussion,
  renderDiscussionPosts,
  renderSubmissions,
  renderSubmissionsBody,
  renderSubmissionsInner,
  renderSubmissionDetail,
  renderSubmissionRow,
  emptyState,
  linkProblem,
  linkContest,
  linkArticle,
};
