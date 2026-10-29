'use strict';

const { escapeHtml, formatDateTime, relativeTime } = require('../util');
const { renderMarkdown } = require('../markdown');
const { formatClock, formatPenalty } = require('../standings');
const { submitMethodsOf } = require('../submit');

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
          return `<td class="vj-st__cell vj-st__cell--ac" title="通过于 ${formatClock(
            cell.acSeconds
          )}${cell.fails ? `，此前错 ${cell.fails} 次` : ''}">${formatClock(cell.acSeconds)}${extra}</td>`;
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
  const standingsSection = `<section class="vj-standings" id="vj-standings-section">
    <div class="vj-standings__head">
      <h2>实时榜单</h2>
      <span class="vj-live${interval ? '' : ' is-off'}" id="vj-live-hint">${
        interval ? `<i class="vj-live__dot"></i>每 ${interval} 秒自动刷新` : '自动刷新已关闭（设置 vjudgeHelper.standingsInterval）'
      }</span>
      <span class="vj-dim" id="vj-standings-updated">${
        options.standings ? `更新于 ${new Date(options.standings.updatedAt).toLocaleTimeString('zh-CN')}` : ''
      }</span>
      <button class="vj-btn vj-btn--mini" data-action="rankRefresh">立即刷新</button>
    </div>
    <div id="vj-standings-inner">${renderStandingsInner(options.standings, {
      emptyText: options.standingsError,
    })}</div>
  </section>`;

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
    </section>${standingsSection}${problemSection}`,
    footer: `<span>${escapeHtml(contest.url || '')}</span>`,
    data: contest,
  };
}

module.exports = {
  renderProblem,
  renderArticle,
  renderContest,
  renderGroup,
  renderStandingsInner,
  emptyState,
  linkProblem,
  linkContest,
  linkArticle,
};
