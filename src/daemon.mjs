#!/usr/bin/env node
// webop 守护进程：保持一个可见的 Chrome 窗口（登录状态持久化在 ~/.webop/profile），
// 通过 127.0.0.1 HTTP 接口接受指令。仅监听本机回环地址，不接受外部连接。
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { PROFILE_DIR, SHOT_DIR, STATE_PATH, DEFAULT_PORT, ensureDirs } from './paths.mjs';
import { parseArgs, toNumber } from './args.mjs';
import { sleep, health } from './client.mjs';
import { snapshotPage, pageText, pageLinks, listFrames, locateTarget, frameByIndex, PAGE_URL_RE } from './extract.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const PORT = Number(flags.port || DEFAULT_PORT);
const HEADLESS = !!flags.headless && flags.headless !== 'false';
const VIEWPORT = typeof flags.viewport === 'string' ? flags.viewport : null;
const PROFILE = typeof flags.profile === 'string' ? path.resolve(flags.profile) : PROFILE_DIR;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const describePage = async page => ({ url: page.url(), title: await page.title().catch(() => '') });

async function main() {
  if (await health(PORT)) {
    log(`端口 ${PORT} 已有守护进程在运行，本次启动取消。`);
    return;
  }
  await ensureDirs();

  const viewport = VIEWPORT
    ? (([w, h]) => ({ width: Number(w), height: Number(h) }))(VIEWPORT.split('x'))
    : null;
  if (viewport && (!viewport.width || !viewport.height)) {
    log('viewport 参数无效，应形如 --viewport 390x844');
    process.exitCode = 1;
    return;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chrome',
      headless: HEADLESS,
      viewport,
      locale: 'zh-CN',
      args: ['--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--window-size=1440,900'],
    });
  } catch (error) {
    log('启动 Chrome 失败：', error?.message || error);
    process.exitCode = 1;
    return;
  }

  let active = context.pages()[0] || await context.newPage();

  async function shutdown(code) {
    try { await context.close(); } catch { /* 忽略关闭异常 */ }
    try { await fsp.rm(STATE_PATH, { force: true }); } catch { /* 忽略 */ }
    process.exit(code);
  }
  context.on('close', () => {
    fsp.rm(STATE_PATH, { force: true }).catch(() => {});
    log('Chrome 已被关闭，守护进程退出。');
    process.exit(0);
  });
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  const server = http.createServer(async (req, res) => {
    const send = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid, port: PORT, headless: HEADLESS, tabs: context.pages().length });
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(400, { ok: false, error: 'invalid json body' });
    }
    try {
      send(200, { ok: true, ...(await route(req.url, payload)) });
    } catch (error) {
      send(500, { ok: false, error: error?.message || String(error) });
    }
  });

  server.on('error', async error => {
    log('HTTP 服务启动失败：', error?.message || error);
    await shutdown(1);
  });

  server.listen(PORT, '127.0.0.1', async () => {
    await fsp.writeFile(STATE_PATH, JSON.stringify({ pid: process.pid, port: PORT, headless: HEADLESS, profile: PROFILE, startedAt: new Date().toISOString() }, null, 2));
    log(`守护进程就绪：http://127.0.0.1:${PORT}（pid ${process.pid}${HEADLESS ? '，无头模式' : ''}）`);
    log('可在浏览器窗口手动登录；登录状态保存在 profile，仅存本机。');
  });

  async function route(url, body) {
    switch (url) {
      case '/status': {
        const pages = context.pages();
        const tabs = await Promise.all(pages.map(async (page, index) => ({ index, active: page === active, ...(await describePage(page)) })));
        return { pid: process.pid, port: PORT, headless: HEADLESS, profile: PROFILE, activeIndex: Math.max(0, pages.indexOf(active)), tabs };
      }
      case '/open': {
        if (!body.url) throw new Error('缺少 url 参数');
        const target = body.newTab ? await context.newPage() : active;
        await target.goto(body.url, { waitUntil: body.waitUntil || 'domcontentloaded', timeout: body.timeoutMs || 45000 });
        active = target;
        await settle(target, { networkIdle: true });
        return { url: target.url(), title: await target.title().catch(() => '') };
      }
      case '/read':
        return await snapshotPage(active, body);
      case '/text':
        return await pageText(active, body);
      case '/links':
        return await pageLinks(active, body);
      case '/frames':
        return await listFrames(active, body);
      case '/click': {
        if (!body.text && !body.selector) throw new Error('需要 text 或 selector 参数');
        const found = await locateTarget(active, body);
        if (!found) throw new Error(`未找到可点击的元素：${body.text || body.selector}`);
        const newPages = [];
        const onPage = page => newPages.push(page);
        context.on('page', onPage);
        try {
          await found.locator.click({ timeout: body.timeoutMs || 15000 });
        } finally {
          context.off('page', onPage);
        }
        if (body.waitAfterMs !== 0) await sleep(body.waitAfterMs ?? 700);
        let switchedTo = null;
        if (newPages.length) {
          active = newPages[newPages.length - 1];
          await active.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          await sleep(400);
          switchedTo = active.url();
        }
        await settle(active);
        return {
          clickedIn: found.frameUrl,
          visibleMatches: found.visibleCount,
          switchedTo,
          url: active.url(),
          title: await active.title().catch(() => ''),
        };
      }
      case '/fill': {
        const spec = body.selector ? { selector: body.selector } : body.placeholder ? { placeholder: body.placeholder } : null;
        if (!spec) throw new Error('需要 selector 或 placeholder 参数');
        const found = await locateTarget(active, spec);
        if (!found) throw new Error(`未找到输入框：${body.selector || body.placeholder}`);
        await found.locator.fill(String(body.value ?? ''), { timeout: body.timeoutMs || 15000 });
        if (body.pressEnter) await found.locator.press('Enter');
        return { filledIn: found.frameUrl, pressEnter: !!body.pressEnter };
      }
      case '/press': {
        if (!body.key) throw new Error('缺少 key 参数');
        await active.keyboard.press(body.key);
        return { key: body.key };
      }
      case '/wait':
        return await waitFor(active, body);
      case '/screenshot': {
        await fsp.mkdir(SHOT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const out = body.out ? path.resolve(body.out) : path.join(SHOT_DIR, `${stamp}.png`);
        if (body.selector) {
          const found = await locateTarget(active, { selector: body.selector });
          if (!found) throw new Error(`未找到需要截图的选择器：${body.selector}`);
          await found.locator.screenshot({ path: out });
        } else {
          await active.screenshot({ path: out, fullPage: !!body.full });
        }
        const { size } = await fsp.stat(out);
        return { path: out, bytes: size };
      }
      case '/eval': {
        if (!body.expression) throw new Error('缺少 expression 参数');
        const frame = frameByIndex(active, body.frame);
        const value = await frame.evaluate(body.expression);
        let result;
        try {
          result = JSON.parse(JSON.stringify(value ?? null));
        } catch {
          result = String(value);
        }
        return { frameUrl: frame.url(), result };
      }
      case '/use': {
        const page = context.pages()[body.index];
        if (!page) throw new Error(`标签页不存在：${body.index}`);
        active = page;
        await page.bringToFront().catch(() => {});
        return { active: { index: body.index, ...(await describePage(page)) } };
      }
      case '/close-tab': {
        const pages = context.pages();
        const page = pages[body.index];
        if (!page) throw new Error(`标签页不存在：${body.index}`);
        if (pages.length <= 1) throw new Error('不能关闭最后一个标签页');
        await page.close();
        if (active === page) active = context.pages()[0];
        return { tabs: context.pages().length };
      }
      case '/stop': {
        setTimeout(() => shutdown(0), 200);
        return { stopping: true };
      }
      default:
        throw new Error(`未知指令：${url}`);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// 页面稳定：等待 DOM 就绪，必要时等网络空闲（均为尽力而为，不阻塞失败路径）。
async function settle(page, { networkIdle = false } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  if (networkIdle) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(250);
}

async function waitFor(page, body) {
  const timeout = Number(body.timeoutMs || 30000);
  const started = Date.now();
  if (body.ms) {
    await sleep(Number(body.ms));
    return { waitedMs: Number(body.ms) };
  }
  if (!body.text && !body.selector && !body.networkIdle) throw new Error('需要 text、selector、ms 或 networkIdle 之一');
  if (body.networkIdle) {
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    return { elapsedMs: Date.now() - started };
  }
  const deadline = started + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!PAGE_URL_RE.test(frame.url())) continue;
      try {
        const ok = await frame.evaluate(({ sel, txt }) => {
          if (txt) return !!(document.body && document.body.innerText.includes(txt));
          const el = document.querySelector(sel);
          return !!el && el.getClientRects().length > 0;
        }, { sel: body.selector || null, txt: typeof body.text === 'string' ? body.text : null });
        if (ok) return { elapsedMs: Date.now() - started, frameUrl: frame.url(), matched: body.text || body.selector };
      } catch {
        // 帧未就绪，继续轮询
      }
    }
    await sleep(400);
  }
  throw new Error(`等待超时：${body.text || body.selector}`);
}

main().catch(error => {
  log('守护进程异常退出：', error?.message || error);
  process.exitCode = 1;
});
