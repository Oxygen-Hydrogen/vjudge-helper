'use strict';

/**
 * 极简日志：一行一条 JSON，写到扩展的 logUri 目录里（VS Code 会把它放在
 * logs/<时间>/window1/exthost/<扩展ID>/ 下），同时镜像一份到输出面板。
 *
 * 为什么需要它：提交这种「服务端说行/不行」的流程，光靠通知栏说不清楚到底
 * 走了哪条通道、服务端回了什么。留一份可回溯的记录，出问题时能直接对账。
 *
 * 这里不 require('vscode')，测试环境（假 vscode）里也能安全使用。
 */

const fs = require('fs');
const path = require('path');

let filePath = '';
let sink = null;

/**
 * @param {{dir?: string, sink?: (line: string) => void}} options
 *   dir  —— 日志目录（通常是 context.logUri.fsPath）
 *   sink —— 额外输出（比如 OutputChannel.appendLine）
 */
function init(options = {}) {
  sink = typeof options.sink === 'function' ? options.sink : null;
  filePath = '';
  if (!options.dir) return '';
  try {
    fs.mkdirSync(options.dir, { recursive: true });
    filePath = path.join(options.dir, 'vjudge-submit.log');
  } catch {
    filePath = '';
  }
  return filePath;
}

function logPath() {
  return filePath;
}

/** 记一条事件；data 里的敏感字段（源码）由调用方自己裁剪 */
function write(tag, data) {
  const line = `${new Date().toISOString()} ${tag} ${safeJson(data)}`;
  if (sink) {
    try {
      sink(line);
    } catch {
      /* 输出面板不可用时忽略 */
    }
  }
  if (!filePath) return;
  try {
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch {
    /* 磁盘写失败不该影响提交 */
  }
}

function safeJson(data) {
  try {
    return JSON.stringify(data === undefined ? {} : data);
  } catch {
    return String(data);
  }
}

/** 只留开头几十个字符，用来判断服务端回的是 JSON 还是 HTML 错误页 */
function snippet(text, limit = 300) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

module.exports = { init, write, snippet, logPath };
