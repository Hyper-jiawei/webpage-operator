---
name: webpage-operator
description: 通过本机「网页操作工具」（webop CLI）用 Chrome 打开、点击、填写并读取任意网页，产出结构化信息（标题/路由/标签/表头/按钮/输入框/图表，可选脱敏），支持截图与多标签页。当用户给出网址并要求打开网页、读取页面功能或内容、逐层点击浏览、登录后读取公司内网系统、提取网页结构、网页截图时使用。Use when the user asks to open a URL, read or extract information from a web page, click through pages, log in and read an intranet/system page, or capture screenshots via the local webop tool.
---

# 网页操作工具（webpage-operator）

## 概述

用本机「网页操作工具」控制桌面 Chrome：打开网址 → 按需点击 → 读取页面结构（跨 iframe、可选脱敏）。默认只读，所有输出为 JSON。

## 前置与调用方式

- 工具目录：`/Users/hyper/Documents/网页操作工具`
- 调用：`node /Users/hyper/Documents/网页操作工具/bin/webop.mjs <子命令> [参数]`（若 `webop` 已在 PATH 可直接用）
- 依赖本机 Google Chrome；任何命令会自动连上守护进程，未运行时会自动拉起并在桌面打开 Chrome 窗口
- 先用 `status` 确认运行状态（它不会自动启动）；端口默认 17321，可用 `WEBOP_PORT=18000` 更换
- 完整用法见 `node bin/webop.mjs --help` 与工具目录下 `README.md`

## 标准流程

1. `open <url>` 打开目标网址（返回最终 URL 与标题）。
2. 若页面出现「登录/密码/验证码/扫码」且内容很少 → 走「登录交接」。
3. `read --sanitize`（公司内网/敏感系统）或 `read` 读取页面结构。
4. 需要进入下一层：`click --text "菜单或按钮文字"`，然后再次 `read`；重复可逐层深入。
5. 用 `links` / `frames` / `text` 补充信息；用户要留档时可 `screenshot`。
6. 把 JSON 结果整理成用户要的结论（功能结构、信息摘要、路径清单），附上页面标题与路由。
7. 收尾：不必关闭浏览器（登录状态会保留）；用户明确要求时再 `stop`。

## 登录交接（重要交互模式）

- 检测到登录页时，对用户说：**「已打开 Chrome 窗口（或已在窗口内切到登录页），请在窗口中完成登录，完成后回复我继续。」**
- 等用户确认后再重新 `read`；不要轮询敲打登录页。
- 绝不让用户把令牌/密码粘贴到终端；不读取、不输出 Cookie 或 localStorage。

## 命令速查

| 目的 | 命令 |
|---|---|
| 打开 | `open <url> [--new]` |
| 读取结构 | `read [--sanitize] [--with-rows] [--max-rows N]` |
| 页面文字 | `text [--selector CSS] [--all] [--max N]` |
| 链接/帧 | `links [--sanitize]` / `frames` |
| 点击 | `click --text "文字" [--exact] [--nth N｜--last] [--wait-after MS]` |
| 填写 | `fill --selector CSS <值>` / `--placeholder "文本" [--press-enter]` |
| 等待 | `wait --text "文字" ｜ --selector CSS ｜ --ms 1000` |
| 截图 | `screenshot [--full] [--out 路径]` |
| 高级 | `eval "<只读表达式>"` |
| 标签页 | `status` / `use <序号>` / `close-tab <序号>` |

## 读取要点

- `read` 覆盖页面内**所有 iframe**（企业系统常见「壳页 + 内容帧」）；逐帧看 `frameUrl` 定位内容。
- 异步渲染：内容未出现先 `wait --text/--selector` 再 `read`；慢系统可 `wait --ms 1500`。
- 明细行默认**省略**（仅记数 `detailRowsOmitted`）；确需行数据用 `--with-rows`（默认最多 30 行，`--max-rows` 调整）。
- 公司系统（圆通内网等）一律加 `--sanitize`：业务数值→`[数值已省略]`、JWT→`[令牌已省略]`、URL 去查询串。写入聊天/报告的引用同样保持脱敏。
- 页面文字很长时用 `text --selector` 限定区域，避免灌满上下文。
- 重复菜单名（同名多处）点击时用 `--last` 或 `--nth N` 指定。

## 操作安全

- 默认只读：浏览、点导航、展开、切换标签、截图、读 DOM。
- **不执行不可逆动作**：提交审批、删除、支付、导出、发送、提交表单等，除非用户逐条明确指示。
- `fill` 仅在用户提供内容时使用；`eval` 只用于读取页面状态，不用于触发业务操作。
- 读取结果默认不落盘；用户要求留档时使用 `--sanitize` 输出。
- 点击新窗口会被自动接管；截图默认存 `~/.webop/screenshots/`。

## 故障处理

| 现象 | 处理 |
|---|---|
| 命令超时/连不上 | `status` 查看；日志在 `~/.webop/daemon.log` |
| 端口冲突 | `WEBOP_PORT=18000 node bin/webop.mjs open <url>` |
| 读到的不是目标页 | `status` 看标签页，`use <序号>` 切到目标，或重新 `open` |
| 帧/内容未就绪 | `wait --selector iframe` 或 `wait --ms 2000` 后重试 |
| 登录失效 | 在 Chrome 窗口重新登录即可，无需重启工具 |

## 示例

用户：「帮我看看某某系统的功能菜单」→
`open <url>` → （登录交接）→ `read --sanitize` → 对每个一级菜单 `click --text` + `read --sanitize` → 汇总成菜单树/功能清单。
