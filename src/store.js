'use strict';

const MAX_HISTORY = 30;

class Store {
  constructor(context) {
    this.memento = context.globalState;
  }

  _get(key, fallback) {
    const value = this.memento.get(key);
    return Array.isArray(value) ? value : fallback;
  }

  /* ------------------------- 收藏 ------------------------- */

  getProblems() {
    return this._get('vjudge.favorites.problems', []);
  }

  getArticles() {
    return this._get('vjudge.favorites.articles', []);
  }

  isFavoriteProblem(key) {
    return this.getProblems().some((p) => p.key === key);
  }

  isFavoriteArticle(id) {
    return this.getArticles().some((a) => String(a.id) === String(id));
  }

  async toggleProblem(problem) {
    const list = this.getProblems();
    const idx = list.findIndex((p) => p.key === problem.key);
    if (idx >= 0) {
      list.splice(idx, 1);
      await this.memento.update('vjudge.favorites.problems', list);
      return false;
    }
    list.unshift({ key: problem.key, title: problem.title, oj: problem.oj, at: Date.now() });
    await this.memento.update('vjudge.favorites.problems', list.slice(0, 200));
    return true;
  }

  async toggleArticle(article) {
    const list = this.getArticles();
    const idx = list.findIndex((a) => String(a.id) === String(article.id));
    if (idx >= 0) {
      list.splice(idx, 1);
      await this.memento.update('vjudge.favorites.articles', list);
      return false;
    }
    list.unshift({ id: article.id, title: article.title, author: article.author, at: Date.now() });
    await this.memento.update('vjudge.favorites.articles', list.slice(0, 200));
    return true;
  }

  async removeFavorite(kind, idOrKey) {
    if (kind === 'problem') {
      const list = this.getProblems().filter((p) => p.key !== idOrKey);
      await this.memento.update('vjudge.favorites.problems', list);
    } else {
      const list = this.getArticles().filter((a) => String(a.id) !== String(idOrKey));
      await this.memento.update('vjudge.favorites.articles', list);
    }
  }

  /* ------------------------- 历史 ------------------------- */

  getHistory() {
    return this._get('vjudge.history', []);
  }

  async pushHistory(entry) {
    const list = this.getHistory().filter((h) => !(h.kind === entry.kind && h.id === entry.id));
    list.unshift({ ...entry, at: Date.now() });
    await this.memento.update('vjudge.history', list.slice(0, MAX_HISTORY));
  }

  async clearHistory() {
    await this.memento.update('vjudge.history', []);
  }

  /* ------------------------- 其它 ------------------------- */

  /**
   * 最近一次打开的题目（含比赛上下文）。
   * 存在 globalState 里，扩展宿主重启 / 窗口重载后仍能一键提交，不会退化成「请输入题号」。
   */
  getLastProblem() {
    const value = this.memento.get('vjudge.lastProblem');
    return value && typeof value === 'object' && value.key ? value : null;
  }

  async setLastProblem(target) {
    if (!target || !target.key) {
      await this.memento.update('vjudge.lastProblem', undefined);
      return;
    }
    await this.memento.update('vjudge.lastProblem', {
      key: String(target.key),
      title: String(target.title || ''),
      contestId: target.contestId ? String(target.contestId) : '',
      problemNum: target.problemNum ? String(target.problemNum) : '',
      contestTitle: String(target.contestTitle || ''),
      // 比赛快照版本：比赛内提交要原样回传，服务端才认（否则 400）
      contestVersion: target.contestVersion ? String(target.contestVersion) : '',
      // 比赛结束时间：结束后比赛通道关闭，提交要改成补题（practice）
      contestEnd: Number(target.contestEnd) || 0,
      at: Date.now(),
    });
  }

  getLastContestSort() {
    return this.memento.get('vjudge.contestSort', 'running');
  }

  /** 上次用哪个 OJ 账号提交（按 OJ 分开记，提交方式「自己的账号」用） */
  getOwnAccount(oj) {
    const map = this.memento.get('vjudge.ownAccounts', {});
    return (map && map[String(oj || '')]) || '';
  }

  async setOwnAccount(oj, bindingId) {
    if (!oj || !bindingId) return;
    const map = { ...(this.memento.get('vjudge.ownAccounts', {}) || {}) };
    map[String(oj)] = String(bindingId);
    await this.memento.update('vjudge.ownAccounts', map);
  }

  async setLastContestSort(mode) {
    await this.memento.update('vjudge.contestSort', mode);
  }
}

module.exports = { Store };
