'use strict';

const vscode = require('vscode');
const { request, CookieJar, formEncode } = require('./http');

const SECRET_COOKIE = 'vjudgeHelper.cookie';
const SECRET_PASSWORD = 'vjudgeHelper.password';

class LoginRequiredError extends Error {
  constructor(message) {
    super(message || '需要登录 VJudge 才能访问该页面');
    this.name = 'LoginRequiredError';
    this.code = 'LOGIN_REQUIRED';
  }
}

const LOGIN_ERROR_TEXT = {
  'user.auth.error.username_or_email_required': '请输入用户名',
  'user.auth.error.password_required': '请输入密码',
  'user.auth.error.username_or_password_error': '用户名或密码错误',
  'user.auth.error.user_not_found': '用户不存在',
  'user.error.human_verification_failed': 'VJudge 要求人机验证，请在浏览器登录后使用「手动粘贴 Cookie」',
  'user.auth.error.account_disabled': '账号已被禁用',
};

class Session {
  constructor(context, getConfig) {
    this.context = context;
    this.getConfig = getConfig || (() => vscode.workspace.getConfiguration('vjudgeHelper'));
    this.jar = new CookieJar();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this._lastChecked = 0;
    this._loggedIn = false;
  }

  get baseUrl() {
    const configured = String(this.getConfig().get('baseUrl') || 'https://vjudge.net').trim();
    return configured.replace(/\/+$/, '') || 'https://vjudge.net';
  }

  get timeout() {
    return Number(this.getConfig().get('requestTimeout')) || 20000;
  }

  /** 题面里图片用的 CDN 前缀（CDN_BASE_URL 的替换值） */
  get cdnBaseUrl() {
    const configured = String(this.getConfig().get('cdnBaseUrl') || '').trim();
    return configured;
  }

  /** 插件启动时恢复凭据 */
  async init() {
    let stored = null;
    try {
      stored = await this.context.secrets.get(SECRET_COOKIE);
    } catch {
      stored = null;
    }
    const fallback = String(this.getConfig().get('cookie') || '').trim();
    const cookie = stored || fallback;
    if (cookie) {
      this.jar = new CookieJar(cookie);
      this._loggedIn = false;
    }
  }

  get hasCredentials() {
    return !this.jar.isEmpty;
  }

  notifyChange() {
    this._onDidChange.fire();
  }

  async saveCookie(cookieString) {
    this.jar = new CookieJar(cookieString);
    try {
      await this.context.secrets.store(SECRET_COOKIE, cookieString);
    } catch {
      /* 某些环境不支持 secrets，退化为内存保存 */
    }
    this.notifyChange();
  }

  /** 从浏览器 Cookie 头里挑出 vjudge 需要的键 */
  normalizeCookieInput(input) {
    const jar = new CookieJar(input);
    const keep = new CookieJar();
    for (const [name, value] of jar.map) {
      if (/^(JSESSIONID|JSESSlONID|__cf_bm|_ga|remember|username|SERVERID)$/i.test(name) || /session/i.test(name)) {
        keep.map.set(name, value);
      }
    }
    if (keep.isEmpty) return jar.toString();
    return keep.toString();
  }

  /**
   * 用户名 + 密码登录；成功时 cookie 会写入密钥链。
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async login(username, password) {
    const body = formEncode({ username: String(username || '').trim(), password: String(password || '') });
    const res = await request(`${this.baseUrl}/user/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${this.baseUrl}/`,
        Origin: this.baseUrl,
      },
      body,
      jar: this.jar,
      timeout: this.timeout,
      maxRedirects: 0,
    });

    let payload = null;
    try {
      payload = JSON.parse(res.body);
    } catch {
      payload = null;
    }

    if (res.status >= 400 || (payload && payload.i18nKey)) {
      const key = payload && payload.i18nKey;
      const message = LOGIN_ERROR_TEXT[key] || (key ? `登录失败：${key}` : `登录失败（HTTP ${res.status}）`);
      return { ok: false, message };
    }

    if (this.jar.isEmpty) {
      return { ok: false, message: '登录接口没有返回会话 Cookie，可能触发了人机验证，请改用「手动粘贴 Cookie」。' };
    }

    const verification = await this.checkLogin({ force: true });
    if (!verification.loggedIn) {
      return { ok: false, message: '登录后校验未通过，请稍后再试或改用「手动粘贴 Cookie」。' };
    }

    await this.saveCookie(this.jar.toString());
    try {
      await this.context.secrets.store(SECRET_PASSWORD, String(password || ''));
    } catch {
      /* ignore */
    }
    return { ok: true, message: '登录成功' };
  }

  /** @returns {Promise<{loggedIn: boolean, message: string}>} */
  async checkLogin(options = {}) {
    if (this.jar.isEmpty) {
      this._loggedIn = false;
      return { loggedIn: false, message: '尚未配置凭据' };
    }
    if (!options.force && Date.now() - this._lastChecked < 60 * 1000) {
      return { loggedIn: this._loggedIn, message: this._loggedIn ? '已登录' : '未登录' };
    }
    try {
      const res = await request(`${this.baseUrl}/user/checkLogInStatus`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: '',
        jar: this.jar,
        timeout: this.timeout,
        maxRedirects: 0,
      });
      const text = String(res.body || '').trim().toLowerCase();
      const loggedIn = text === 'true' || text === '1' || text === '"true"';
      this._loggedIn = loggedIn;
      this._lastChecked = Date.now();
      return { loggedIn, message: loggedIn ? '已登录' : '凭据已过期或无效' };
    } catch (err) {
      return { loggedIn: false, message: `无法连接 VJudge：${err.message}` };
    }
  }

  async logout() {
    try {
      await this.context.secrets.delete(SECRET_COOKIE);
      await this.context.secrets.delete(SECRET_PASSWORD);
    } catch {
      /* ignore */
    }
    this.jar = new CookieJar();
    this._loggedIn = false;
    this._lastChecked = 0;
    this.notifyChange();
  }

  async getSavedPassword() {
    try {
      return await this.context.secrets.get(SECRET_PASSWORD);
    } catch {
      return undefined;
    }
  }
}

module.exports = { Session, LoginRequiredError };
