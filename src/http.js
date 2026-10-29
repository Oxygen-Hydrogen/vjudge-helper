'use strict';

/**
 * 极简 HTTP 客户端：Cookie 罐、重定向、gzip、超时。
 * 只用 Node 内置模块，插件零运行时依赖。
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 每个请求单独握手，**不复用 socket**。
 *
 * Node 19 起 `https.globalAgent` 默认 keepAlive=true，连接会被池化复用；
 * VJudge 前面挂着 Cloudflare / 多台前置机，池子里的空闲连接早就被对面单方面掐了，
 * 复用时就会报 "Client network socket disconnected before secure TLS connection was established"
 * （err.code = ECONNRESET）——这在「随机一道题」这种低频点击里特别容易踩到。
 * 关掉 keep-alive 多花一次 TLS 握手（约 100ms），换来的是不再随机失败。
 */
const httpsAgent = new https.Agent({ keepAlive: false });
const httpAgent = new http.Agent({ keepAlive: false });

/** 这些错误都是「连接层面抖了一下」，重试基本就能过 */
const RETRYABLE_CODE = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

function isRetryable(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (RETRYABLE_CODE.has(code)) return true;
  const message = String(err.message || '');
  return /socket hang up|network socket disconnected|before secure TLS connection|Client network socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|请求超时/i.test(
    message
  );
}

class CookieJar {
  constructor(initial) {
    /** @type {Map<string, string>} */
    this.map = new Map();
    if (initial) this.parse(initial);
  }

  /** 解析 `a=1; b=2` 形式的 Cookie 头 */
  parse(text) {
    if (!text || typeof text !== 'string') return this;
    for (const part of text.split(';')) {
      const item = part.trim();
      if (!item) continue;
      const idx = item.indexOf('=');
      if (idx <= 0) continue;
      const name = item.slice(0, idx).trim();
      const value = item.slice(idx + 1).trim();
      if (!name) continue;
      this.map.set(name, value);
    }
    return this;
  }

  /** 处理 Set-Cookie 头 */
  absorb(setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      if (!raw) continue;
      const first = String(raw).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (!name) continue;
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(raw) || value === '') {
        this.map.delete(name);
      } else {
        this.map.set(name, value);
      }
    }
  }

  toString() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get isEmpty() {
    return this.map.size === 0;
  }

  clone() {
    const jar = new CookieJar();
    for (const [k, v] of this.map) jar.map.set(k, v);
    return jar;
  }
}

function decompress(buffer, encoding) {
  try {
    switch ((encoding || '').toLowerCase()) {
      case 'gzip':
        return zlib.gunzipSync(buffer);
      case 'deflate':
        return zlib.inflateSync(buffer);
      case 'br':
        return zlib.brotliDecompressSync(buffer);
      default:
        return buffer;
    }
  } catch {
    return buffer;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string|Buffer} [options.body]
 * @param {CookieJar} [options.jar]
 * @param {number} [options.timeout]
 * @param {number} [options.maxRedirects]
 * @param {number} [options.retries]
 */
function request(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    timeout = 20000,
    maxRedirects = 5,
    retries = 2,
  } = options;

  const attempt = (url, redirectsLeft, triesLeft) =>
    new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (err) {
        reject(new Error(`无效的 URL: ${url}`));
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const finalHeaders = {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        ...headers,
      };
      const cookie = jar ? jar.toString() : '';
      if (cookie) finalHeaders.Cookie = cookie;
      if (body !== undefined) {
        finalHeaders['Content-Length'] = Buffer.byteLength(body);
      }

      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers: finalHeaders,
          timeout,
          agent: isHttps ? httpsAgent : httpAgent,
        },
        (res) => {
          if (jar) jar.absorb(res.headers['set-cookie']);
          const status = res.statusCode || 0;
          const location = res.headers.location;

          if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
            res.resume();
            let nextUrl;
            try {
              nextUrl = new URL(location, url).toString();
            } catch {
              nextUrl = location;
            }
            // 3xx 后一律降级成 GET 并丢弃 body
            attempt(nextUrl, redirectsLeft - 1, triesLeft)
              .then(resolve)
              .catch(reject);
            return;
          }

          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const text = decompress(raw, res.headers['content-encoding']).toString('utf8');
            resolve({
              status,
              headers: res.headers,
              body: text,
              url,
            });
          });
          res.on('error', reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`请求超时（${timeout}ms）: ${url}`));
      });
      req.on('error', (err) => {
        if (triesLeft > 0 && isRetryable(err)) {
          // 逐次退避：400ms、900ms…，给对面 / 代理一点缓冲时间
          const wait = 400 * Math.pow(1.8, retries - triesLeft);
          delay(wait)
            .then(() => attempt(url, redirectsLeft, triesLeft - 1))
            .then(resolve)
            .catch(reject);
        } else if (isRetryable(err)) {
          // 重试也失败：换个人话讲，别把 Node 的原始报错直接甩给用户
          reject(
            new Error(
              `网络连接被中断（${err.code || 'ECONNRESET'}）：连不上 ${parsed.hostname}。` +
                '如果你开了代理 / 加速器，确认它允许这几个域名；否则稍后再试。'
            )
          );
        } else {
          reject(err);
        }
      });

      if (body !== undefined) req.write(body);
      req.end();
    });

  return attempt(rawUrl, maxRedirects, retries);
}

function formEncode(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

module.exports = { request, CookieJar, formEncode, DEFAULT_UA, isRetryable };
