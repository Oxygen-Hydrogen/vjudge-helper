'use strict';

/**
 * 比赛榜单。
 *
 * 数据来源（实测）：
 *   GET /contest/rank/single/{contestId}
 *   {
 *     id, title, begin, length, isReplay,
 *     participants: { "<userId>": { type: 'user'|'team', name, nickname, image, members: [] } },
 *     submissions:  [ [userId, problemIndex, status, seconds, pts?, fullPts?], ... ]
 *   }
 *
 * status：0 未知 / 排队中，1 通过，2 未通过。
 * problemIndex 是 data.problems 里的下标（0 = A 题）。
 *
 * 排名：分数降序 → 罚时升序 → 最后通过时间升序。
 * 有部分分（partialScore）的比赛按 得分 = Σ 题目权重 × 完成比例。
 */

const DEFAULT_PENALTY_SECONDS = 1200;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/** 0 → A、25 → Z、26 → AA（比赛题号就这么多） */
function indexToLetter(index) {
  let n = Number(index);
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** 秒 → 1:23:45 / 23:45 */
function formatClock(seconds) {
  const total = Math.max(0, Math.round(num(seconds, 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 罚时按分钟展示：VJudge 页面上写的就是分钟数 */
function formatPenalty(seconds) {
  return String(Math.round(num(seconds, 0) / 60));
}

function contestWindow(contest) {
  const data = (contest && contest.data) || contest || {};
  const begin = num(data.begin, 0);
  const end = num(data.end, 0);
  return {
    begin,
    end,
    lengthSeconds: Math.max(0, Math.round((end - begin) / 1000)),
    data,
  };
}

/** 封榜：生效后平台只给到封榜时刻的数据，之后的提交按「未通过」算 */
function freezeState(contest, now) {
  const data = (contest && contest.data) || contest || {};
  const begin = num(data.begin, 0);
  const freezeAt = num(data.freezeTime, 0);
  const unfreezeAt = num(data.unfreezeTime, 0);
  if (!data.enableFreeze || !freezeAt) return { frozen: false, from: 0, until: 0 };
  const at = num(now, Date.now());
  const frozen = at >= freezeAt && (!unfreezeAt || at < unfreezeAt);
  return {
    frozen,
    from: Math.max(0, Math.round((freezeAt - begin) / 1000)),
    until: unfreezeAt,
  };
}

function participantInfo(raw) {
  const item = raw || {};
  const members = Array.isArray(item.members) ? item.members : [];
  return {
    type: item.type === 'team' ? 'team' : 'user',
    name: String(item.name || item.nickname || '未命名'),
    nickname: String(item.nickname || ''),
    image: String(item.image || ''),
    excluded: !!item.excluded,
    members: members
      .map((m) => (typeof m === 'string' ? m : m && (m.name || m.nickname || m.username)))
      .filter(Boolean),
  };
}

/**
 * 计算榜单。
 * @param {object} contest fetchContest 的返回值（要带 problems / data）
 * @param {object} rank /contest/rank/single/{id} 的原始返回
 * @param {{myParticipantId?: string|number, now?: number}} [options]
 */
function buildStandings(contest, rank, options = {}) {
  const now = num(options.now, Date.now());
  const source = rank || {};
  const { begin, end, lengthSeconds, data } = contestWindow(contest);
  let problemList = Array.isArray(contest && contest.problems) ? contest.problems.slice() : [];
  const penaltyPerFail = num(data.penalty, DEFAULT_PENALTY_SECONDS);
  const sumTime = data.sumTime !== false; // 默认按 ICPC「各题通过时间之和」
  const partialScore = !!data.partialScore;

  const participants = source.participants || {};
  const submissions = Array.isArray(source.submissions) ? source.submissions : [];
  // 私有比赛看不到题目列表时，用榜单里的题目下标把列补出来（只是没有标题）
  if (!problemList.length && submissions.length) {
    const maxIndex = submissions.reduce((max, raw) => Math.max(max, num(raw[1], -1)), -1);
    problemList = Array.from({ length: maxIndex + 1 }, (_, i) => ({
      index: indexToLetter(i),
      key: '',
      title: `题目 ${indexToLetter(i)}`,
      weight: 1,
      inferred: true,
    }));
  }
  // 只统计比赛时间内的提交：赛后的「补题」不计入榜单（和 VJudge 默认视图一致）
  const elapsedSeconds =
    begin > 0 ? Math.max(0, Math.round((Math.min(now, end || now) - begin) / 1000)) : Number.POSITIVE_INFINITY;
  const horizon = Math.min(elapsedSeconds, lengthSeconds || Number.POSITIVE_INFINITY);
  const frozen = freezeState(contest, now);

  const rows = new Map();
  function ensure(pid) {
    const id = String(pid);
    if (!rows.has(id)) {
      const info = participantInfo(participants[id]);
      rows.set(id, {
        participantId: id,
        ...info,
        score: 0,
        penalty: 0,
        solved: 0,
        lastAcSeconds: Number.POSITIVE_INFINITY,
        lastSubmitSeconds: 0,
        submitCount: 0,
        cells: problemList.map(() => ({ best: 0, acSeconds: null, fails: 0, attempts: 0, lastSeconds: 0 })),
      });
    }
    return rows.get(id);
  }

  Object.keys(participants).forEach((pid) => ensure(pid));

  const ordered = submissions
    .map((raw) => ({
      pid: String(raw[0]),
      index: num(raw[1], -1),
      status: num(raw[2], 0),
      seconds: Math.max(0, num(raw[3], 0)),
      pts: raw[4] === undefined || raw[4] === null ? null : Number(raw[4]),
      fullPts: raw[5] === undefined || raw[5] === null ? null : Number(raw[5]),
    }))
    .filter((s) => s.index >= 0 && s.index < problemList.length)
    .filter((s) => s.seconds <= horizon)
    .sort((a, b) => a.seconds - b.seconds || a.status - b.status);

  for (const sub of ordered) {
    const row = ensure(sub.pid);
    const cell = row.cells[sub.index];
    if (!cell) continue;

    // 封榜后提交的数据不可信，按「未通过」计入（和网页一致）
    const isFrozen = frozen.frozen && sub.seconds >= frozen.from;
    const status = isFrozen ? 2 : sub.status;

    row.submitCount += 1;
    row.lastSubmitSeconds = sub.seconds;
    cell.attempts += 1;
    cell.lastSeconds = sub.seconds;

    let fraction = 0;
    if (status === 1) {
      fraction = partialScore && !isFrozen && sub.pts !== null && sub.fullPts ? clamp01(sub.pts / sub.fullPts) : 1;
    } else if (partialScore && !isFrozen && sub.pts !== null && sub.fullPts) {
      fraction = clamp01(sub.pts / sub.fullPts);
    }

    if (fraction > cell.best) {
      cell.best = fraction;
      if (fraction >= 1) cell.acSeconds = sub.seconds;
    }
    if (status !== 1 && cell.best < 1) cell.fails += 1;
  }

  const standings = [];
  for (const row of rows.values()) {
    let score = 0;
    let solved = 0;
    let lastAc = Number.POSITIVE_INFINITY;
    let sumAcSeconds = 0;
    let totalFails = 0;

    row.cells.forEach((cell, index) => {
      const weight = num(problemList[index] && problemList[index].weight, 1) || 1;
      if (cell.best > 0) score += weight * cell.best;
      if (cell.acSeconds !== null) {
        solved += 1;
        sumAcSeconds += cell.acSeconds;
        totalFails += cell.fails;
        lastAc = Math.min(lastAc, cell.acSeconds);
      }
    });

    row.score = Math.round(score * 100) / 100;
    row.solved = solved;
    row.lastAcSeconds = lastAc;
    row.penalty = sumTime
      ? sumAcSeconds + penaltyPerFail * totalFails
      : (lastAc === Number.POSITIVE_INFINITY ? 0 : lastAc) + penaltyPerFail * totalFails;
    standings.push(row);
  }

  standings.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    if (a.lastAcSeconds !== b.lastAcSeconds) return a.lastAcSeconds - b.lastAcSeconds;
    return a.participantId.localeCompare(b.participantId);
  });

  const myId =
    options.myParticipantId === undefined || options.myParticipantId === null ? '' : String(options.myParticipantId);
  let myRank = 0;
  standings.forEach((row, index) => {
    row.rank = index + 1;
    row.isMe = !!myId && row.participantId === myId;
    if (row.isMe) myRank = row.rank;
  });

  const problems = problemList.map((p, index) => {
    let acCount = 0;
    let fails = 0;
    for (const row of standings) {
      const cell = row.cells[index];
      if (!cell) continue;
      if (cell.acSeconds !== null) acCount += 1;
      fails += cell.fails;
    }
    return {
      index,
      label: String(p.index || index + 1),
      key: p.key || '',
      title: p.title || '',
      weight: num(p.weight, 1) || 1,
      acCount,
      fails,
    };
  });

  return {
    rows: standings,
    problems,
    participantCount: standings.length,
    frozen: frozen.frozen,
    frozenFrom: frozen.from,
    frozenUntil: frozen.frozen ? frozen.until : 0,
    partialScore,
    sumTime,
    penaltyPerFail,
    myRank,
    myParticipantId: myId,
    contestId: String((contest && contest.id) || source.id || ''),
    begin,
    end,
    lengthSeconds,
    updatedAt: now,
  };
}

module.exports = { buildStandings, formatClock, formatPenalty, freezeState };
