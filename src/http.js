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
    retries = 1,
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
        if (triesLeft > 0 && /socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(err.message))) {
          delay(400).then(() => attempt(url, redirectsLeft, triesLeft - 1).then(resolve).catch(reject));
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

module.exports = { request, CookieJar, formEncode, DEFAULT_UA };
