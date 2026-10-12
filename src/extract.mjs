// 页面信息提取：只读取页面结构与可见文本。
// 不读取 Cookie、localStorage、网络请求体或任何浏览器凭据。
// --sanitize 脱敏模式会剔除业务数值（如「成本 0.087」→「成本[数值已省略]」）与 JWT 令牌串，
// 并把 URL 的查询串去掉，适合把结果作为证据留存或写入报告。

export const PAGE_URL_RE = /^(https?|file):/;

// 默认排除明细行容器，避免把表格里成百上千行的业务数据整段读出来。
export const DEFAULT_EXCLUDE = '.list-body,tbody,.el-table__body-wrapper,.vxe-table--body-wrapper,.ant-table-tbody,script,style,noscript';

export async function snapshotFrame(frame, opts = {}) {
  return frame.evaluate((options) => {
    const VALUE_RE = /(成本|费率|占比|金额|总量|票量|总数|得分|完成率|延误率|业务量|环比|同比)[：:\s]*[-+]?\d+(?:\.\d+)?[%％‱万亿]?(?=$)/g;
    const TOKEN_RE = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{6,}/g;
    const clean = text => {
      let value = String(text ?? '').trim();
      if (options.sanitize) value = value.replace(VALUE_RE, '$1[数值已省略]').replace(TOKEN_RE, '[令牌已省略]');
      return value;
    };
    const visible = el => !!(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
    const uniq = list => [...new Set(list)];
    const exclude = options.excludeSelector || '.list-body,tbody,.el-table__body-wrapper,.vxe-table--body-wrapper,.ant-table-tbody,script,style,noscript';
    const labels = uniq([...document.querySelectorAll('body *')]
      .filter(el => !el.children.length && !el.closest(exclude) && visible(el))
      .map(el => clean(el.innerText))
      .filter(text => text && text.length < 160 &&
        !/^[\s\d.,%‱+\-−/：:()（）年月日时分秒万亿元件单人个]+$/.test(text) &&
        !/^(数据时间|更新于|更新时间|统计时间)[：:]/.test(text)))
      .slice(0, options.maxLabels || 250);
    const tableHeaders = uniq([...document.querySelectorAll('.list-head,thead,[role=columnheader]')]
      .filter(visible).map(el => clean(el.innerText))).slice(0, 60);
    const buttons = uniq([...document.querySelectorAll('button,[role=button],.btn,input[type=button],input[type=submit]')]
      .filter(visible).map(el => clean(el.innerText || el.value || el.getAttribute('aria-label') || '')))
      .filter(Boolean).slice(0, 60);
    const rows = options.withRows
      ? [...document.querySelectorAll('tbody tr,.el-table__row,.vxe-body--row,.ant-table-row')].slice(0, options.maxRows || 30)
          .map(row => uniq([...row.querySelectorAll('td,th')].map(td => {
            const cell = clean(td.innerText);
            // 脱敏模式下，纯数值单元格整体替换
            if (options.sanitize && /[\d]/.test(cell) && /^[\s\d.,%％‱+\-−万亿元件单人个]+$/.test(cell)) return '[数值已省略]';
            return cell;
          })).filter(Boolean).join(' | '))
          .filter(Boolean)
      : undefined;
    return {
      title: clean(document.title),
      route: location.origin + location.pathname + location.hash.split('?')[0],
      labels,
      tableHeaders,
      buttons,
      inputs: [...document.querySelectorAll('input,select,textarea')].filter(visible)
        .map(el => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder || '', label: el.getAttribute('aria-label') || '' })),
      charts: document.querySelectorAll('[_echarts_instance_],.chart-canvas').length,
      canvases: document.querySelectorAll('canvas').length,
      detailRowsOmitted: options.withRows ? 0 : document.querySelectorAll('tbody tr,.el-table__row').length,
      ...(rows ? { rows } : {}),
    };
  }, opts);
}

const sanitizeUrl = (url, on) => (on ? String(url).split('?')[0] : String(url));

export async function snapshotPage(page, opts = {}) {
  const frames = [];
  for (const frame of page.frames()) {
    if (!PAGE_URL_RE.test(frame.url())) continue;
    try {
      const data = await snapshotFrame(frame, opts);
      frames.push({ frame: frame.name() || '', frameUrl: sanitizeUrl(frame.url(), opts.sanitize), ...data });
    } catch {
      frames.push({ frameUrl: sanitizeUrl(frame.url(), opts.sanitize), error: '页面框架尚未就绪或已跳转' });
    }
  }
  return {
    pageUrl: sanitizeUrl(page.url(), opts.sanitize),
    title: await page.title().catch(() => ''),
    frameCount: frames.length,
    frames,
  };
}

export function frameByIndex(page, index) {
  if (index === undefined || index === null) return page.mainFrame();
  const frames = page.frames();
  if (!frames[index]) throw new Error(`帧序号不存在: ${index}（当前共 ${frames.length} 帧，可用 webop frames 查看）`);
  return frames[index];
}

export async function pageText(page, body = {}) {
  const maxChars = Number(body.maxChars || 20000);
  const frames = body.all ? page.frames().filter(f => PAGE_URL_RE.test(f.url())) : [frameByIndex(page, body.frame)];
  const results = [];
  for (const frame of frames) {
    try {
      const text = await frame.evaluate(({ selector, cap }) => {
        const root = selector ? document.querySelector(selector) : document.body;
        const value = root ? root.innerText : '';
        return value.replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
      }, { selector: body.selector || null, cap: maxChars });
      results.push({ frame: frame.name() || '', frameUrl: sanitizeUrl(frame.url(), body.sanitize), text });
    } catch (error) {
      results.push({ frameUrl: frame.url(), error: String(error?.message || error) });
    }
  }
  return { pageUrl: sanitizeUrl(page.url(), body.sanitize), frames: results };
}

export async function pageLinks(page, body = {}) {
  const max = Number(body.max || 300);
  const items = [];
  const seen = new Set();
  let truncated = false;
  outer:
  for (const frame of page.frames()) {
    if (!PAGE_URL_RE.test(frame.url())) continue;
    let links = [];
    try {
      links = await frame.evaluate((options) => [...document.querySelectorAll('a[href]')]
        .filter(el => !!(el.getClientRects().length))
        .map(el => {
          const href = options.sanitize ? (el.href || '').split('?')[0] : (el.href || '');
          return { text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120), href: href.slice(0, 500) };
        }), { sanitize: !!body.sanitize });
    } catch {
      continue;
    }
    for (const link of links) {
      if (!link.href || seen.has(link.href)) continue;
      seen.add(link.href);
      items.push({ ...link, frameUrl: sanitizeUrl(frame.url(), body.sanitize) });
      if (items.length >= max) {
        truncated = true;
        break outer;
      }
    }
  }
  return { pageUrl: sanitizeUrl(page.url(), body.sanitize), count: items.length, truncated, links: items };
}

export async function listFrames(page, body = {}) {
  const result = [];
  const all = page.frames();
  for (let index = 0; index < all.length; index++) {
    const frame = all[index];
    result.push({
      index,
      name: frame.name() || '',
      url: sanitizeUrl(frame.url(), body.sanitize),
      title: await frame.title().catch(() => ''),
    });
  }
  return { pageUrl: sanitizeUrl(page.url(), body.sanitize), frames: result };
}

// 跨帧查找可交互元素：主帧优先，找到第一个有可见匹配的帧后在该帧内选择。
export async function locateTarget(page, spec = {}) {
  const all = page.frames();
  const ordered = [page.mainFrame(), ...all.filter(f => f !== page.mainFrame())];
  const matches = [];
  for (const frame of ordered) {
    if (!PAGE_URL_RE.test(frame.url())) continue;
    let locator;
    try {
      if (spec.selector) locator = frame.locator(spec.selector);
      else if (spec.placeholder) locator = frame.getByPlaceholder(spec.placeholder);
      else if (spec.text) locator = frame.getByText(spec.text, { exact: !!spec.exact });
      else continue;
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (await el.isVisible().catch(() => false)) matches.push({ frame, locator: el });
      }
    } catch {
      // 某些帧可能尚未就绪，跳过
    }
    if (matches.length) break;
  }
  if (!matches.length) return null;
  const index = spec.last ? matches.length - 1 : Number(spec.nth || 0);
  if (!matches[index]) throw new Error(`匹配序号超出范围：请求第 ${index} 个，可见匹配共 ${matches.length} 个`);
  const chosen = matches[index];
  return { frameUrl: chosen.frame.url(), visibleCount: matches.length, locator: chosen.locator };
}
