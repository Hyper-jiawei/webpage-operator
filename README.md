# 网页操作工具（webpage-operator）

用 Playwright 驱动**本机已安装的 Chrome**，打开、点击、读取任意网页，并输出结构化的页面信息（可选脱敏）。
配套 Qoder 技能 `webpage-operator`，让智能体可以直接按你的指示访问和读取指定网址。

本工具由「驾驶舱功能架构梳理」的采集脚本沉淀而来：当时用同一套方法（打开菜单 → 逐层点击 → 提取页面标签/表头/图表容器 → 脱敏）完整读出了一个公司内网系统的功能结构。

## 特性

- **常驻浏览器**：守护进程保持一个 Chrome 窗口，你手动登录一次，登录状态就保存在本机 `~/.webop/profile`，后续指令直接复用。
- **跨帧读取**：自动遍历页面内所有 iframe（企业系统常见的「载体页 + 内容帧」结构），逐个输出结构信息。
- **结构化提取**：页面标题、路由、可见标签、表头、按钮、输入框、图表容器、行数统计；`--with-rows` 可显式提取明细行。
- **脱敏模式**：`--sanitize` 会把业务数值（如「操作成本0.087」）替换为「[数值已省略]」、屏蔽 JWT 令牌串、去掉 URL 查询串，适合把结果留档或写进报告。
- **智能体友好**：所有命令输出 JSON（stdout），错误也以 JSON 输出（stderr），退出码 0/1。
- **仅本机**：HTTP 接口只监听 `127.0.0.1`；不读取 Cookie、localStorage 或网络请求体；截图与登录数据都在仓库之外。

## 环境要求

- macOS（已在 macOS 27 + Node 26 验证）
- 已安装 Google Chrome
- Node.js ≥ 20
- 首次安装：`npm install`

## 快速开始

```bash
cd ~/Documents/网页操作工具

# 1. 打开一个页面（首次会自动拉起守护进程并弹出 Chrome 窗口）
node bin/webop.mjs open https://example.com

# 2. 读取当前页面结构（企业内网系统建议加 --sanitize）
node bin/webop.mjs read --sanitize

# 3. 点击某个按钮或菜单（跨帧自动查找）
node bin/webop.mjs click --text "中心管理"
node bin/webop.mjs read --sanitize

# 4. 截图 / 查看链接
node bin/webop.mjs screenshot --full
node bin/webop.mjs links --sanitize

# 5. 结束时关闭浏览器
node bin/webop.mjs stop
```

全局安装后可直接用 `webop` 命令（`npm link` 或 `sudo npm link`）。

## 命令一览

| 命令 | 说明 |
|---|---|
| `start [--headless] [--viewport 390x844]` | 启动守护进程（可模拟手机宽度读取移动页） |
| `stop` / `status` | 关闭 / 查看守护进程（status 不自动启动） |
| `open <url> [--new]` | 当前标签页或新标签页打开网址 |
| `read [--sanitize] [--with-rows]` | 结构化读取：标题/路由/标签/表头/按钮/输入框/图表，覆盖所有帧 |
| `text [--selector CSS] [--frame N] [--all]` | 可见文本 |
| `links [--sanitize]` / `frames [--sanitize]` | 链接列表 / 帧列表 |
| `click --text "文本" [--exact] [--nth N\|--last]` | 点击（文本或 `--selector`；新开窗口自动接管） |
| `fill --selector CSS <值>` / `--placeholder "文本"` | 填写输入框（`--press-enter` 提交回车） |
| `press <键名>` / `wait --text\|--selector\|--ms` | 按键 / 等待条件出现 |
| `screenshot [--full] [--selector CSS] [--out 路径]` | 截图（默认存 `~/.webop/screenshots/`） |
| `eval "<表达式>"` | 高级：在页面求值（建议只读用途） |
| `use <序号>` / `close-tab <序号>` | 切换 / 关闭标签页 |

任何指令若发现守护进程未运行，会自动拉起；环境变量 `WEBOP_PORT` 可换端口（默认 17321）。

## 读取结果说明（read）

```jsonc
{
  "pageUrl": "https://…",          // 当前页面（--sanitize 时去掉查询串）
  "title": "页面标题",
  "frameCount": 2,
  "frames": [
    {
      "frame": "content",          // iframe name
      "frameUrl": "https://…",
      "title": "帧标题",
      "route": "origin + path + #/hash（不含查询串）",
      "labels": ["界面可见文字（≤250 条）"],
      "tableHeaders": ["表头"],
      "buttons": ["按钮文字"],
      "inputs": [{ "tag": "INPUT", "type": "text", "placeholder": "输入组织" }],
      "charts": 2, "canvases": 2,
      "detailRowsOmitted": 21      // 被有意省略的明细行数；--with-rows 时改输出 rows
    }
  ]
}
```

## 登录与状态

- 守护进程启动后，在弹出的 Chrome 窗口中手动登录目标系统即可；**不要在终端粘贴令牌**。
- 登录状态保存在 `~/.webop/profile`（本机、仓库之外）；系统会话未过期时下次不用再登录。
- 手动关闭 Chrome 窗口 = 结束守护进程；桌面残留的 `state.json` 会自动清理。
- 想彻底重置：`webop stop && rm -rf ~/.webop`。

## 安全边界

- 服务只监听 `127.0.0.1`，仅本机可用；不采集 Cookie / 存储 / 请求头，也不写入任何报告文件。
- `--sanitize` 为「证据留档」场景设计：剔除业务数值与令牌串，只保留界面结构与文字。
- `click` / `fill` / `press` / `eval` 具备写操作能力，工具默认只答复指令；使用技能时智能体默认只做只读浏览，除非你明确要求执行操作。
- 请勿用本工具执行：提交审批、删除数据、触发对外发送等不可逆动作（除非你确认并明确指示）。

## 搭配 Qoder 技能

仓库内 `skills/webpage-operator/SKILL.md` 是配套技能源码，安装方式二选一：

```bash
node scripts/install-skill.mjs          # 符号链接到 ~/.qoder/skills（推荐，跟随仓库更新）
```

或使用 Qoder 内置 `skill_manage` 安装。技能安装后，直接对智能体说「打开/读取某个网址」即可自动走本工具。

## 故障排查

| 现象 | 处理 |
|---|---|
| 端口被占用 / 换端口 | `WEBOP_PORT=18000 node bin/webop.mjs start` |
| 启动超时 | 查看 `~/.webop/daemon.log` |
| Chrome 未找到 | 安装 Google Chrome，或改 `channel` 配置 |
| 页面为空 / 帧未就绪 | 先 `webop wait --selector iframe` 或 `webop wait --ms 2000` 再 `read` |
| 登录失效 | 在浏览器窗口重新登录即可，无需重启工具 |
