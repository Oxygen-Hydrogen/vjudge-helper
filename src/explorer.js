'use strict';

const vscode = require('vscode');
const { relativeTime, formatDateTime, splitProblemKey, problemUrl, contestUrl, articleUrl, groupUrl } = require('./util');

class VJudgeTreeProvider {
  constructor(client, store, session) {
    this.client = client;
    this.store = store;
    this.session = session;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this._contestCache = new Map();
    this._groupCache = new Map();
  }

  refresh(options = {}) {
    if (options.clearContests) {
      this._contestCache.clear();
      this._groupCache.clear();
    }
    this._onDidChange.fire();
  }

  getTreeItem(node) {
    const item = new vscode.TreeItem(node.label, node.collapsibleState || vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = node.contextValue;
    item.iconPath = node.iconPath;
    item.description = node.description;
    item.tooltip = node.tooltip || node.label;
    item.command = node.command;
    if (node.resourceUri) item.resourceUri = node.resourceUri;
    // 让右键菜单里的命令能拿回原始节点数据
    item.__node = node;
    return item;
  }

  async getChildren(element) {
    if (!element) return this.rootNodes();
    if (element.type === 'group') {
      try {
        return await element.loader();
      } catch (err) {
        return [errorNode(err, element)];
      }
    }
    return [];
  }

  rootNodes() {
    const C = vscode.TreeItemCollapsibleState;
    const loggedInHint = this.session.hasCredentials ? '' : '（未登录）';
    return [
      {
        type: 'group',
        id: 'contests-live',
        label: '进行中 / 即将开始',
        contextValue: 'group',
        collapsibleState: C.Expanded,
        iconPath: new vscode.ThemeIcon('broadcast'),
        loader: () => this.loadContests('live'),
      },
      {
        type: 'group',
        id: 'contests-recent',
        label: '最近的比赛',
        contextValue: 'group',
        collapsibleState: C.Collapsed,
        iconPath: new vscode.ThemeIcon('history'),
        loader: () => this.loadContests('recent'),
      },
      {
        type: 'group',
        id: 'groups-mine',
        label: '我的团队',
        contextValue: 'group',
        collapsibleState: C.Collapsed,
        iconPath: new vscode.ThemeIcon('organization'),
        loader: () => this.loadGroups('mine'),
      },
      {
        type: 'group',
        id: 'groups-discover',
        label: '发现团队',
        contextValue: 'group',
        collapsibleState: C.Collapsed,
        iconPath: new vscode.ThemeIcon('globe'),
        loader: () => this.loadGroups('discover'),
      },
      {
        type: 'group',
        id: 'favorites',
        label: '我的收藏',
        contextValue: 'group',
        collapsibleState: C.Collapsed,
        iconPath: new vscode.ThemeIcon('star'),
        loader: async () => this.favoriteNodes(),
      },
      {
        type: 'group',
        id: 'history',
        label: '最近浏览',
        contextValue: 'group',
        collapsibleState: C.Collapsed,
        iconPath: new vscode.ThemeIcon('versions'),
        loader: async () => this.historyNodes(),
      },
      {
        type: 'group',
        id: 'actions',
        label: `快捷操作${loggedInHint}`,
        contextValue: 'group',
        collapsibleState: C.Collapsed,
        iconPath: new vscode.ThemeIcon('rocket'),
        loader: async () => this.actionNodes(),
      },
    ];
  }

  async loadContests(mode) {
    const cacheKey = `${mode}:${this.session.baseUrl}`;
    if (this._contestCache.has(cacheKey)) return this._contestCache.get(cacheKey);

    const size = vscode.workspace.getConfiguration('vjudgeHelper').get('contestPageSize') || 20;
    const contests = await this.client.listContests({ mode, pageSize: size });

    const C = vscode.TreeItemCollapsibleState;
    const nodes = contests.map((contest) => ({
      type: 'contest',
      id: `contest-${contest.id}`,
      label: `#${contest.id} ${contest.title}`,
      contextValue: 'contest',
      collapsibleState: C.None,
      url: contestUrl(contest.id, this.session.baseUrl),
      description:
        contest.state === 'running'
          ? `进行中 · 剩余 ${relativeTime(contest.end).replace('后', '')}`
          : contest.state === 'upcoming'
            ? `${relativeTime(contest.begin)}开始`
            : formatDateTime(contest.begin),
      tooltip: new vscode.MarkdownString(
        `**${contest.title}**\n\n- 开始：${formatDateTime(contest.begin)}\n- 结束：${formatDateTime(contest.end)}\n- 组织者：${
          contest.manager || '-'
        }\n- 参赛人数：${contest.contestants != null ? contest.contestants : '-'}`
      ),
      iconPath: new vscode.ThemeIcon(
        contest.state === 'running' ? 'debug-start' : contest.state === 'upcoming' ? 'watch' : 'calendar'
      ),
      command: {
        command: 'vjudgeHelper.internal.openContest',
        title: '打开比赛',
        arguments: [contest.id],
      },
    }));

    if (!nodes.length) {
      nodes.push({
        type: 'info',
        id: `${mode}-empty`,
        label: mode === 'live' ? '暂时没有进行中或即将开始的比赛' : '没有取到比赛数据',
        contextValue: 'info',
        collapsibleState: C.None,
        iconPath: new vscode.ThemeIcon('info'),
      });
    }

    this._contestCache.set(cacheKey, nodes);
    return nodes;
  }

  async loadGroups(mode) {
    const cacheKey = `${mode}:${this.session.baseUrl}`;
    if (this._groupCache.has(cacheKey)) return this._groupCache.get(cacheKey);

    const { mine, invitations, discover } = await this.client.listGroups();
    let groups = mode === 'mine' ? [...invitations, ...mine] : discover;
    if (mode === 'mine') {
      groups = groups.sort((a, b) => b.runningContests - a.runningContests || b.members - a.members);
    }

    const C = vscode.TreeItemCollapsibleState;
    const nodes = groups.map((g) => {
      const contests = g.runningContests + g.scheduledContests + g.endedContests;
      const detail = [`成员 ${g.members}`, `比赛 ${contests}`];
      if (g.runningContests) detail.push(`${g.runningContests} 场进行中`);
      if (g.myRole >= 2) detail.unshift('队长');
      else if (g.myRole === 1) detail.unshift('管理员');
      if (g.hasApplicants) detail.push('有待审申请');

      return {
        type: 'team',
        id: `team-${g.shortName}`,
        label: g.name,
        contextValue: 'team',
        collapsibleState: C.None,
        description: detail.join(' · '),
        url: groupUrl(g.shortName, this.session.baseUrl),
        key: g.shortName,
        iconPath: new vscode.ThemeIcon(g.runningContests ? 'broadcast' : 'organization'),
        tooltip: new vscode.MarkdownString(
          `**${g.name}**（${g.shortName}）\n\n- 成员：${g.members}\n- 比赛：进行中 ${g.runningContests} / 未开始 ${
            g.scheduledContests
          } / 已结束 ${g.endedContests}\n- 队长：${g.leaderName || '-'}${
            g.isPublic ? '' : '\n- 私密团队'
          }${g.brief ? `\n\n${g.brief}` : ''}`
        ),
        command: {
          command: 'vjudgeHelper.internal.openGroup',
          title: '打开团队',
          arguments: [g.shortName],
        },
      };
    });

    if (!nodes.length) {
      nodes.push({
        type: 'info',
        id: `${mode}-groups-empty`,
        label:
          mode === 'mine'
            ? '还没加入团队（在 vjudge.net 加入后会出现在这里）'
            : '暂时没有取到公开团队',
        contextValue: 'info',
        collapsibleState: C.None,
        iconPath: new vscode.ThemeIcon('info'),
        command: { command: 'vjudgeHelper.searchGroup', title: '搜索团队' },
      });
    }

    this._groupCache.set(cacheKey, nodes);
    return nodes;
  }

  favoriteNodes() {
    const C = vscode.TreeItemCollapsibleState;
    const problems = this.store.getProblems();
    const articles = this.store.getArticles();
    const nodes = [];

    for (const p of problems) {
      const { oj } = splitProblemKey(p.key);
      nodes.push({
        type: 'problem',
        id: `fav-problem-${p.key}`,
        label: p.key,
        contextValue: 'favorite',
        collapsibleState: C.None,
        description: p.title || oj,
        url: problemUrl(p.key, this.session.baseUrl),
        key: p.key,
        iconPath: new vscode.ThemeIcon('bookmark'),
        tooltip: `${p.key}\n${p.title || ''}`,
        command: {
          command: 'vjudgeHelper.internal.openProblem',
          title: '打开题面',
          arguments: [p.key],
        },
      });
    }

    for (const a of articles) {
      nodes.push({
        type: 'article',
        id: `fav-article-${a.id}`,
        label: `文章 #${a.id} ${a.title || ''}`.trim(),
        contextValue: 'favorite',
        collapsibleState: C.None,
        description: a.author || '',
        url: articleUrl(a.id, this.session.baseUrl),
        key: String(a.id),
        iconPath: new vscode.ThemeIcon('file-text'),
        command: {
          command: 'vjudgeHelper.internal.openArticle',
          title: '打开文章',
          arguments: [String(a.id)],
        },
      });
    }

    if (!nodes.length) {
      nodes.push({
        type: 'info',
        id: 'fav-empty',
        label: '还没有收藏，打开题目后点「☆ 收藏」',
        contextValue: 'info',
        collapsibleState: C.None,
        iconPath: new vscode.ThemeIcon('info'),
      });
    }
    return nodes;
  }

  historyNodes() {
    const C = vscode.TreeItemCollapsibleState;
    const history = this.store.getHistory();
    if (!history.length) {
      return [
        {
          type: 'info',
          id: 'history-empty',
          label: '暂无浏览记录',
          contextValue: 'info',
          collapsibleState: C.None,
          iconPath: new vscode.ThemeIcon('info'),
        },
      ];
    }
    return history.map((h) => {
      const kind = h.kind === 'group' ? 'group' : h.kind;
      const url =
        kind === 'problem'
          ? problemUrl(h.id, this.session.baseUrl)
          : kind === 'article'
            ? articleUrl(h.id, this.session.baseUrl)
            : kind === 'group'
              ? groupUrl(h.id, this.session.baseUrl)
              : contestUrl(h.id, this.session.baseUrl);
      const icon = kind === 'problem' ? 'book' : kind === 'article' ? 'file-text' : kind === 'group' ? 'organization' : 'trophy';
      const command =
        kind === 'problem'
          ? 'vjudgeHelper.internal.openProblem'
          : kind === 'article'
            ? 'vjudgeHelper.internal.openArticle'
            : kind === 'group'
              ? 'vjudgeHelper.internal.openGroup'
              : 'vjudgeHelper.internal.openContest';
      return {
        type: kind,
        id: `history-${kind}-${h.id}`,
        label: h.title || h.id,
        contextValue: kind,
        collapsibleState: C.None,
        description: relativeTime(h.at),
        key: h.id,
        url,
        iconPath: new vscode.ThemeIcon(icon),
        command: { command, title: '打开', arguments: [h.id] },
      };
    });
  }

  actionNodes() {
    const C = vscode.TreeItemCollapsibleState;
    const mk = (id, label, icon, command) => ({
      type: 'action',
      id: `action-${id}`,
      label,
      contextValue: 'action',
      collapsibleState: C.None,
      iconPath: new vscode.ThemeIcon(icon),
      command: { command, title: label },
    });
    return [
      mk('submit', '提交当前文件代码', 'cloud-upload', 'vjudgeHelper.submitCode'),
      mk('last-solution', '打开最近一次提交', 'history', 'vjudgeHelper.openLastSolution'),
      mk('my-submissions', '我的提交记录', 'history', 'vjudgeHelper.mySubmissions'),
      mk('submissions', '全站提交记录…', 'list-unordered', 'vjudgeHelper.submissions'),
      mk('open-problem', '打开题目…', 'book', 'vjudgeHelper.openProblem'),
      mk('open-article', '打开文章…', 'file-text', 'vjudgeHelper.openArticle'),
      mk('open-contest', '打开比赛…', 'trophy', 'vjudgeHelper.openContest'),
      mk('open-group', '打开团队…', 'organization', 'vjudgeHelper.openGroup'),
      mk('search-group', '搜索团队…', 'search', 'vjudgeHelper.searchGroup'),
      mk('random', '随机来一道题…', 'lightbulb', 'vjudgeHelper.openRandomProblem'),
      mk('login', '登录 / 更新凭据', 'account', 'vjudgeHelper.login'),
      mk('check', '检查登录状态', 'check', 'vjudgeHelper.checkLogin'),
      mk('home', '打开 VJudge 首页', 'globe', 'vjudgeHelper.openHome'),
      mk('settings', '插件设置', 'gear', 'vjudgeHelper.openSettings'),
    ];
  }
}

function errorNode(err, group) {
  const needLogin = err && err.code === 'LOGIN_REQUIRED';
  return {
    type: 'info',
    id: `${group.id}-error`,
    label: needLogin ? '需要登录后才能加载' : `加载失败：${err.message || err}`,
    contextValue: 'info',
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    iconPath: new vscode.ThemeIcon('warning'),
    command: needLogin
      ? { command: 'vjudgeHelper.login', title: '登录' }
      : { command: 'vjudgeHelper.refresh', title: '重试' },
  };
}

module.exports = { VJudgeTreeProvider };
