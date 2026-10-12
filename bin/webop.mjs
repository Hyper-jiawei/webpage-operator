#!/usr/bin/env node
// webop 命令行：把指令发给本机守护进程（未运行时自动拉起）。
// 所有输出为 JSON（stdout），便于脚本与智能体直接解析；提示信息走 stderr。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, STATE_PATH, LOG_PATH, ensureDirs } from '../src/paths.mjs';
import { parseArgs, toNumber } from '../src/args.mjs';
import { sleep, health, call } from '../src/client.mjs';

const HELP = `网页操作工具 webop

用法: webop <命令> [参数]

生命周期:
  start [--headless] [--viewport 390x844]   启动浏览器守护进程（首次会打开 Chrome 窗口）
  stop                                      关闭守护进程与浏览器
  status                                    查看运行状态（不自动启动）

浏览与读取:
  open <url> [--new] [--wait-until domcontentloaded|load|networkidle]
  read [--sanitize] [--with-rows] [--max-labels N] [--max-rows N]    页面结构化信息（所有帧）
  text [--selector CSS] [--frame N] [--all] [--max N]                可见文本
  links [--sanitize] [--max N]                                       页内链接
  frames [--sanitize]                                                帧列表
  screenshot [--full] [--selector CSS] [--out 路径]                  截图

操作:
  click (--text "文本" | --selector CSS) [--exact] [--nth N | --last] [--wait-after MS] [--timeout MS]
  fill (--selector CSS | --placeholder "占位文本") <值> [--press-enter]
  press <键名>，如 Enter / Control+A
  wait (--text "文本" | --selector CSS | --ms 1000 | --networkIdle) [--timeout MS]
  eval "<表达式>" [--frame N]                                        高级：在页面求值（建议只读）
  use <标签页序号> | close-tab <标签页序号>

全局: --port N（默认 ${DEFAULT_PORT}，亦可用 WEBOP_PORT）; --profile 路径（仅 start 时生效）

示例:
  webop open https://example.com
  webop read --sanitize
  webop click --text "中心管理"
  webop screenshot --full
`;

const { positionals, flags } = parseArgs(process.argv.slice(2));
const command = positionals[0] || 'help';
const port = Number(flags.port || process.env.WEBOP_PORT || DEFAULT_PORT);
const num = toNumber;

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function requireArg(value, usage) {
  if (!value) throw new Error(`用法: webop ${usage}`);
}

async function ensureDaemon() {
  if (await health(port)) return;
  await ensureDirs();
  const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.mjs');
  const logFd = fs.openSync(LOG_PATH, 'a');
  const args = [daemonPath, '--port', String(port)];
  if (flags.headless) args.push('--headless');
  if (typeof flags.viewport === 'string') args.push('--viewport', flags.viewport);
  if (typeof flags.profile === 'string') args.push('--profile', flags.profile);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  process.stderr.write(flags.headless ? '[webop] 正在启动浏览器守护进程（无头模式）…\n' : '[webop] 正在启动浏览器守护进程（会打开一个 Chrome 窗口）…\n');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(400);
    if (await health(port)) {
      if (!flags.headless) process.stderr.write('[webop] 守护进程就绪。若页面要求登录，请在 Chrome 窗口中手动登录。\n');
      return;
    }
  }
  throw new Error(`守护进程启动超时，详见日志: ${LOG_PATH}`);
}

try {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stderr.write(HELP);
      break;
    case 'version':
    case '--version': {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'));
      output({ ok: true, name: pkg.name, version: pkg.version });
      break;
    }
    case 'start': {
      const existing = await health(port);
      if (existing) {
        output({ ok: true, alreadyRunning: true, ...existing });
        break;
      }
      await ensureDaemon();
      output({ ok: true, ...(await health(port)) });
      break;
    }
    case 'stop': {
      const existing = await health(port);
      if (!existing) {
        output({ ok: true, alreadyStopped: true, port });
        break;
      }
      await call(port, '/stop', {}, { timeoutMs: 5000 }).catch(() => null);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (!(await health(port))) break;
        await sleep(300);
      }
      fs.rmSync(STATE_PATH, { force: true });
      output({ ok: true, stopped: true });
      break;
    }
    case 'status': {
      const existing = await health(port);
      if (!existing) {
        output({ ok: true, running: false, port });
        break;
      }
      const details = await call(port, '/status', {}, { timeoutMs: 10000 }).catch(() => existing);
      output({ ok: true, running: true, ...details });
      break;
    }
    case 'open': {
      requireArg(positionals[1], 'open <url>');
      await ensureDaemon();
      output(await call(port, '/open', { url: positionals[1], newTab: !!flags.new, waitUntil: typeof flags['wait-until'] === 'string' ? flags['wait-until'] : undefined, timeoutMs: num(flags.timeout) }));
      break;
    }
    case 'read': {
      await ensureDaemon();
      output(await call(port, '/read', { sanitize: !!flags.sanitize, withRows: !!flags['with-rows'], maxLabels: num(flags['max-labels']), maxRows: num(flags['max-rows']) }));
      break;
    }
    case 'text': {
      await ensureDaemon();
      output(await call(port, '/text', { selector: flags.selector, frame: num(flags.frame), all: !!flags.all, maxChars: num(flags.max), sanitize: !!flags.sanitize }));
      break;
    }
    case 'links': {
      await ensureDaemon();
      output(await call(port, '/links', { sanitize: !!flags.sanitize, max: num(flags.max) }));
      break;
    }
    case 'frames': {
      await ensureDaemon();
      output(await call(port, '/frames', { sanitize: !!flags.sanitize }));
      break;
    }
    case 'click': {
      if (!flags.text && !flags.selector) throw new Error('用法: webop click --text "文本" 或 --selector "CSS"');
      await ensureDaemon();
      const timeoutMs = num(flags.timeout) || 15000;
      output(await call(port, '/click', {
        text: typeof flags.text === 'string' ? flags.text : undefined,
        selector: typeof flags.selector === 'string' ? flags.selector : undefined,
        exact: !!flags.exact,
        nth: num(flags.nth),
        last: !!flags.last,
        timeoutMs,
        waitAfterMs: num(flags['wait-after']),
      }, { timeoutMs: timeoutMs + 40000 }));
      break;
    }
    case 'fill': {
      if (!flags.selector && !flags.placeholder) throw new Error('用法: webop fill --selector "CSS" <值> 或 --placeholder "占位文本" <值>');
      await ensureDaemon();
      const value = flags.value !== undefined ? String(flags.value) : (positionals[1] ?? '');
      output(await call(port, '/fill', { selector: flags.selector, placeholder: flags.placeholder, value, pressEnter: !!flags['press-enter'], timeoutMs: num(flags.timeout) }));
      break;
    }
    case 'press': {
      requireArg(positionals[1], 'press <键名>');
      await ensureDaemon();
      output(await call(port, '/press', { key: positionals[1] }));
      break;
    }
    case 'wait': {
      await ensureDaemon();
      const timeoutMs = num(flags.timeout) || 30000;
      output(await call(port, '/wait', {
        text: typeof flags.text === 'string' ? flags.text : undefined,
        selector: typeof flags.selector === 'string' ? flags.selector : undefined,
        ms: num(flags.ms),
        networkIdle: !!flags.networkIdle,
        timeoutMs,
      }, { timeoutMs: timeoutMs + 15000 }));
      break;
    }
    case 'screenshot': {
      await ensureDaemon();
      output(await call(port, '/screenshot', { full: !!flags.full, selector: flags.selector, out: typeof flags.out === 'string' ? flags.out : undefined }, { timeoutMs: 60000 }));
      break;
    }
    case 'eval': {
      requireArg(positionals[1], 'eval "<表达式>"');
      await ensureDaemon();
      output(await call(port, '/eval', { expression: positionals[1], frame: num(flags.frame) }));
      break;
    }
    case 'use': {
      requireArg(positionals[1], 'use <标签页序号>');
      await ensureDaemon();
      output(await call(port, '/use', { index: Number(positionals[1]) }));
      break;
    }
    case 'close-tab': {
      requireArg(positionals[1], 'close-tab <标签页序号>');
      await ensureDaemon();
      output(await call(port, '/close-tab', { index: Number(positionals[1]) }));
      break;
    }
    default:
      throw new Error(`未知命令：${command}\n\n${HELP}`);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exit(1);
}
