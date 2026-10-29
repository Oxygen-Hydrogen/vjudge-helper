# VJudge Helper

在 VS Code 里刷 VJudge：**一键看题面、一键提交本地代码并跟踪评测结果、打开链接、读文章、逛比赛、看团队（Group）**，不用来回切浏览器。

> 题面数据来自 vjudge.net，需要你自己的 VJudge 账号凭据才能读取（VJudge 本身要求登录后才能看题）。

## 功能

### 1. 一键查看题面

- 侧边栏「最近的比赛」→ 点比赛 → 点题目，题面直接在编辑器旁边打开
- 编辑器里选中一段文本（比如 `CodeForces-1A` 或一个题目链接），按 `Ctrl+Alt+V` 直接开题
- 复制任意题目链接后执行「从剪贴板打开」，插件会自动识别并转换：
  - `https://codeforces.com/problemset/problem/1/A` → `CodeForces-1A`
  - `https://atcoder.jp/contests/abc300/tasks/abc300_a` → `AtCoder-abc300_a`
  - `https://www.luogu.com.cn/problem/P1000` → `洛谷-P1000`
  - `https://vjudge.net/contest/863093#problem/B` → 自动解析出比赛里的 B 题
- 题号也支持中文 OJ 名与常见别名，`洛谷-P1001`、`luogu-P1001`、`洛谷 P1001`、`codeforces-1a` 都能认（统一折成 VJudge 里的写法，比如 `洛谷-P1001`、`CodeForces-1a`）
- 题面面板支持：LaTeX 公式（MathJax）、代码块、表格、图片，以及「提交代码 / 浏览器打开 / 切换题面 / 复制链接 / 收藏 / 刷新」
- **代码块带语法高亮**：C/C++、Java、Python、Pascal 等，注释/字符串/关键字/类型/函数分色，配色跟当前主题（深色/浅色）走；样例输入输出不会被误染，认不出语言就保持原样
- **题面版本切换**：同一道题在 VJudge 上可能有官方英文、中文翻译、用户贡献等多个版本，面板会显示「切换题面（N）」按钮，选一下就换
- **站内私信**：`VJudge: 打开私信` 一个面板看会话列表 + 对话，能发消息、删除、拉黑、加载更早消息（正文按 Markdown 渲染，代码块照样高亮）

### 2. 一键提交本地代码

代码就在 VS Code 里，没必要为了提交再复制粘贴一遍。

- 打开题面面板 → 点「提交代码」（面板右上角第一个按钮），或者代码编辑器里按 `Ctrl+Alt+Enter`
- 插件读取**当前编辑器里的内容**（包括没保存的修改），按文件类型自动挑语言（`.cpp` → C++17、`.py` → Python 3、`.java` → Java…），提交到当前题目
- **记住语言选择**：同一 OJ 第一次选过语言后，以后同类型文件直接一键提交，不再弹选择框
- **从比赛里点进去的题就是比赛题**：面板上会标出「比赛 #863093 · D 题」，按钮变成「提交到比赛 D」，提交投到 `/contest/submit/{比赛}/{题号}`，比赛的排行榜里能正常记录；练习模式走 `/problem/submit/{题号}`
- **比赛结束后照样能补题**：网页上赛后从比赛页点提交照样能交，VJudge 会把这条记在这场比赛下（练习模式，不计入榜单）。插件同样如此——面板按钮仍是「提交到比赛 X」，只是在提示里写明不计入榜单；万一 VJudge 关掉了这场比赛通道（返回「比赛已经结束」），插件会自动改走练习提交 `/problem/submit/{题号}` 并告诉你已经切换了通道。这类提交不会触发榜单刷新
- **自动挑对的提交方式**：VJudge 上有两种交法——「默认账号」（用 VJudge 自己的账号代交源码）和「自己的账号」（用你绑定在该 OJ 上的账号交）。Codeforces 等题只允许后者，以前会报 `submit.error.submit_method.not_allowed`；现在插件读题目自带的 `submitMethods` 自动选择，题面面板会标出「提交方式：用你自己的账号」，并记住你上次用的账号；没绑 / 登录失效会直接弹提示带你到绑定页
- **不用每次告诉它提交到哪**：当前题目会记住（连比赛上下文一起存进 globalState），重开窗口、装新版重载后按快捷键照样直接提交；真要换题也用不着输入题号——列表里选最近打开的题、或从文件名猜（`2275D.cpp` → `-2275D`）
- 提交后状态栏实时显示判题进度，出结果弹通知：`Accepted · 15 ms · 512 kB`，点「打开提交记录」直达 VJudge 记录页
- 状态栏那条结果可以点，也可以随时用 `VJudge: 打开最近一次提交` 回看

第一次提交会问你用哪门语言（列表按文件类型排序，推荐项排第一）；想每次都确认题目和语言，把 `vjudgeHelper.submitConfirm` 打开即可。

### 3. 打开 VJudge 链接

命令面板里所有入口都在 `VJudge:` 分类下，可以直接把链接丢进去。

### 4. 读文章 / 题单

- 输入文章 ID 或链接（如 `https://vjudge.net/article/1`）即可在面板里阅读
- 文章里的 `[problem:POJ-1000]` 会被渲染成可点击链接，点一下直接看题
- 题单类文章会额外列出全部题目和 AC/提交数

### 5. 逛比赛

- 侧边栏实时显示「进行中 / 即将开始」和「最近的比赛」
- 比赛详情面板显示时间、状态、比赛类型、当前权限、题目列表（公开比赛未登录也能看；私有比赛需要登录且已报名）
- **比赛里就能看榜，不用切浏览器**：面板自带榜单表格（名次 / 参赛者 / 过题数 / 罚时 / 每题通过时间与罚次），默认每 5 秒自动刷新，只更新表格本身不动滚动位置；自己那一行高亮并显示「你当前第 N 名」
  - 封榜（freeze）期间按 VJudge 的规则处理：封榜后的提交一律显示为「未通过」，并在顶部提示解冻时间
  - 支持部分分（partialScore）赛制，按分数排序
  - 比赛倒计时在面板里每秒本地走秒；比赛结束后刷新自动降到 60 秒一次
  - **「仅赛时 / 含赛后补题」开关**：默认只算比赛时间内的提交；切到「含赛后补题」后，赛后补上的题也算进排名，单元格标 **†** 并提示「排名会因此比仅赛时好看」。换比赛自动回到「仅赛时」
- **比赛讨论区**：面板底部直接读这场比赛的讨论帖（按回复关系嵌套），能回复、能发新帖、能删自己的帖；刷新只换帖子列表，不会把写了一半的内容清掉
- 从比赛题目进入题面后，面板上有「返回比赛」按钮，回去继续看榜

### 6. 看团队（Group）

- 侧边栏新增 **「我的团队」** 和 **「发现团队」**：加入的团队、收到的邀请、公开团队都会列出来
- `VJudge: 打开团队…` 支持三种输入：团队链接 `https://vjudge.net/group/sfera-pg`、团队短名 `sfera-pg`、甚至团队中文/英文名（会自动走搜索）
- `VJudge: 搜索团队…` 按关键词搜索后，从列表里挑一个打开
- 团队面板里能看到：团队简介（Markdown 渲染）、成员列表与角色（队长/管理员/成员）、团队比赛（点一下直接开比赛面板）、团队文章（点一下直接看文章）

### 7. 随机来一道题（可选 OJ / 难度 / 标签）

`VJudge: 随机来一道题（可选 OJ / 难度 / 标签）` 会先问范围，再抽一道打开：

- **不限 OJ**：Codeforces / 洛谷 各一半
- **Codeforces**：可按 rating 区间挑（800-1000 到 2500+，也能自己填 `1600-1900`），再挑算法标签
- **洛谷**：可按难度挑（红 → 橙 → 黄 → 绿 → 青 → 蓝 → 紫 → 黑，共 8 档），再挑算法标签；难度、标签都能一次勾好几个
- **VJudge 全站随机**：不挑 OJ，从 VJudge 的题库里抽（需要登录）
- **其他 OJ…**：从 VJudge 收录的 60 多个 OJ 里挑一个（需要登录，这个 OJ 没有难度数据）

标签（算法标签）只有 Codeforces 和洛谷给得出数据：CF 用的是官方题库里的英文标签（`dp` / `graphs`，
菜单里配了中文说明），洛谷用的是它自己的中文标签（`动态规划 DP`、`图论`…，一共 262 个）。
两类标签都是**多选，命中任一即可**（洛谷的 `tag=3,6` 本身就是并集语义）。
「VJudge 全站」「其他 OJ」没有标签数据，所以这两条不问你标签。

抽过一次之后，再执行这个命令时第一项就是 **「再来一道」**——回车即抽，难度和标签都沿用上次的。

选题这一步：Codeforces / 洛谷 走的是 **各自站点的公开接口**（CF 官方 API 带 rating 和标签，洛谷题目列表带难度、`tag=` 过滤），
不占用 VJudge 的请求；**打开题面仍然需要登录**，没登录时会先提示你去登录。

### 8. 提交记录（自己的源码 / 别人的图片）

`VJudge: 我的提交记录（看源码）` 打开一个提交记录面板：

- **我的**：按 `un=<你的用户名>` 拉，点任意一行直接在面板里看源码，带语法高亮和「复制代码」；
  正文是 VJudge 返回的文本（`showCode=true` → `code`），不是网页截图
- **全部**：切一下就是全站提交，可以再按「用户名」「题目」筛，
  从题目面板点「提交记录」进来则只列这道题
- **只看通过**：结果筛选，服务端做（`res=AC`）
- **加载更多**：每次 20 条；VJudge 的 `recordsTotal` 是假的 `9999999`，所以「还有没有下一页」
  只能按「本页是否满 20 条」判断

**别人的代码 VJudge 不给文本，只给一张图片**（防抄）：接口返回 `codeImgUrl`，插件把它下载下来转成
data URI 直接显示在面板里（webview 不依赖跨站 Cookie，也不受 CSP 影响），图上右键可以另存。
快照有时要等几秒，拿不到会提示「重新获取」，最多重试 6 次（站点前端是 10 次 × 1 秒）。

看到 `codeAccessInfo` 就是没权限（没登录 / 作者关掉了），面板会直接说原因。

### 9. 顺手的小功能

- 收藏题目 / 文章，最近浏览历史
- 状态栏常驻入口，点一下弹出快捷菜单
- 自动记住上次打开的题目、缓存 5 分钟减少请求

## 安装

### 方式 A：从 Marketplace 安装

在 VS Code 扩展面板搜索 **VJudge Helper**，或直接打开：
`vscode:extension/<你的 publisher>.vjudge-helper`

### 方式 B：打包成 VSIX 安装

```bash
npm install -g @vscode/vsce
# 在插件目录下
vsce package
# 生成 vjudge-helper-1.1.0.vsix
code --install-extension vjudge-helper-1.1.0.vsix
```

或者在 VS Code 里：扩展面板 → 右上角 `...` → **从 VSIX 安装**。

### 方式 C：源码调试（改代码时用）

```bash
git clone <this-repo> vjudge-helper
cd vjudge-helper
code .
```

按 `F5` 会打开一个「扩展开发宿主」窗口，插件已经在里面生效。

> 本插件**没有 npm 运行时依赖**，只用 Node 内置模块，所以不用 `npm install` 也能跑。

## 登录（重要）

VJudge 的题目描述必须登录后才能访问，所以第一次用需要配置凭据。有两种方式：

### 方式 1：粘 Cookie（最稳，推荐）

1. 浏览器登录 [vjudge.net](https://vjudge.net)
2. `F12` → **Network**（网络）→ 刷新页面 → 点任意一个请求 → 复制请求头里的 `Cookie` 整行
3. VS Code 里执行命令 **`VJudge: 手动粘贴 Cookie`**，粘贴回车
4. 插件会自动校验并保存到系统密钥库（`SecretStorage`，不会写进 settings.json）

关键的两个字段是 `JSESSIONID` 和 `JSESSlONID`（注意 VJudge 故意用小写 `l` 冒充 `I`），其它字段可有可无。

### 方式 2：用户名 + 密码

执行 **`VJudge: 登录 / 更新凭据`** → 选「用用户名和密码登录」。

密码保存在系统密钥库中。如果 VJudge 弹人机验证（Turnstile），这条路会失败，请改用方式 1。

### 检查 / 退出

- `VJudge: 检查登录状态`
- `VJudge: 退出登录（清除凭据）`

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `VJudge: 打开题目…` | 输入题号或链接 |
| `VJudge: 从剪贴板打开题目` | 自动识别剪贴板里的题号/链接 |
| `VJudge: 用选中文本/当前行打开题目` | 快捷键 `Ctrl+Alt+V`（macOS `Cmd+Alt+V`） |
| `VJudge: 打开比赛…` | 输入比赛 ID 或链接 |
| `VJudge: 打开文章…` | 输入文章 ID 或链接 |
| `VJudge: 打开团队…` | 团队链接 / 短名 / 团队名称 |
| `VJudge: 搜索团队…` | 关键词搜索团队后选择打开 |
| `VJudge: 随机来一道题（可选 OJ / 难度 / 标签）` | 先选 OJ（CF / 洛谷 / 全站 / 其他 OJ），CF 与洛谷还能再选难度和算法标签；抽过一次后会多一个「再来一道」 |
| `VJudge: 提交当前文件代码` | 把编辑器里的代码提交到当前题目（比赛题自动投进比赛），快捷键 `Ctrl+Alt+Enter`（macOS `Cmd+Alt+Enter`） |
| `VJudge: 提交到指定题目…` | 强制先选题目再提交，用来交手边没打开的题 |
| `VJudge: 打开最近一次提交` | 打开上一次提交的评测记录页 |
| `VJudge: 我的提交记录（看源码）` | 面板里列自己的提交，点一行看源码（高亮 + 复制），可切「全部」看别人的（VJudge 只给图片） |
| `VJudge: 全站提交记录（可按用户/题目筛）` | 全站提交列表，默认就是「全部」 |
| `VJudge: 查看提交日志（排查提交到哪条通道）` | 每次提交走的通道、服务端原始响应都在这里 |
| `VJudge: 登录 / 更新凭据` | 两种登录方式二选一 |
| `VJudge: 手动粘贴 Cookie` | 直接填 Cookie |
| `VJudge: 检查登录状态` | |
| `VJudge: 退出登录（清除凭据）` | |
| `VJudge: 刷新` | 清缓存并刷新侧边栏 |
| `VJudge: 在浏览器中打开当前页面` | |
| `VJudge: 打开 VJudge 首页` | |
| `VJudge: 清空浏览历史` | |
| `VJudge: 显示菜单` | 状态栏点击时调用 |
| `VJudge: 打开设置` | |

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `vjudgeHelper.openIn` | `panel` | 打开方式：`panel`（编辑器内）/ `browser`（系统浏览器）/ `simpleBrowser`（VS Code 内置浏览器） |
| `vjudgeHelper.baseUrl` | `https://vjudge.net` | 站点地址，可换成镜像 |
| `vjudgeHelper.username` | 空 | 仅用于显示与预填 |
| `vjudgeHelper.cookie` | 空 | 手动 Cookie（不推荐，优先用命令存到密钥库） |
| `vjudgeHelper.enableMathJax` | `true` | 题面公式渲染（需联网加载 CDN） |
| `vjudgeHelper.contestPageSize` | `20` | 比赛列表条数 |
| `vjudgeHelper.showStatusBar` | `true` | 状态栏入口 |
| `vjudgeHelper.requestTimeout` | `20000` | 请求超时（毫秒） |
| `vjudgeHelper.cdnBaseUrl` | 空（自动） | 题面图片 CDN 前缀；留空则用 `/util/cfg` 下发的 `https://cdn.vjudge.net.cn/` |
| `vjudgeHelper.autoRefreshContests` | `false` | 启动时自动拉取比赛 |
| `vjudgeHelper.submitOpen` | `false` | 提交时公开源码（VJudge 提交页的 share / open） |
| `vjudgeHelper.submitConfirm` | `false` | 提交前弹窗确认题目、语言、文件名；默认关，记住语言后一次按键就提交 |
| `vjudgeHelper.judgeTimeout` | `120` | 等评测结果的最长秒数；超时只是不再等，提交本身已生效 |
| `vjudgeHelper.standingsInterval` | `5` | 比赛面板榜单的自动刷新间隔（秒），`0` = 不自动刷新；面板在后台时不发请求，比赛结束后自动降到 60 秒 |

## 发布到 Marketplace

完整步骤见仓库根目录的 `MARKETPLACE.md`，这里只放最短路径：

```bash
npm run publisher -- <你的 publisherId> https://github.com/<你>/vjudge-helper   # 一次性
VSCE_PAT=<Azure DevOps PAT> npm run publish                                    # 发布
npm run publish -- patch                                                       # 之后每次升版本发布
```

PAT 需要在 https://dev.azure.com 生成，Scope 勾 **Marketplace → Manage**；publisher 在
https://marketplace.visualstudio.com/manage 创建。token 不要写进任何文件。

## 目录结构

```
extension.js              插件入口：命令注册、面板编排
src/
  http.js                 极简 HTTP 客户端（Cookie 罐 / 重定向 / gzip / 超时 / 断线重试）
  session.js              凭据管理（SecretStorage）、登录、登录态校验
  vjudge.js               业务层：题面 / 文章 / 比赛 / 团队 / 搜索 / 提交记录 + dataJson 解析 + 提交与评测
  random.js               随机抽题：CF 官方题库 / 洛谷题目列表 / VJudge 题目列表三条通道
  submit.js               提交纯逻辑：语言识别与挑选、源码编码、报错翻译、评测结论
  standings.js            榜单计算：AC / 罚时 / 封榜 / 部分分 / 排名
  markdown.js             迷你 Markdown 渲染器（支持 [problem:xxx]）
  highlight.js            代码块语法高亮（零依赖，C/C++/Java/Python/Pascal…）
  util.js                 输入解析、OJ 链接转换、时间格式化
  store.js                收藏与历史（globalState）
  explorer.js             侧边栏树
  webview/shell.js        Webview 外壳（CSP / 主题 / MathJax）
  webview/renderers.js    题面 / 文章 / 比赛 / 团队 / 私信 / 提交记录六种视图
media/                    样式、前端脚本、活动栏图标
test/                     不启动 VS Code 的联调脚本
```

## 它是怎么工作的

1. 用带 Cookie 的请求访问 `https://vjudge.net/problem/<OJ>-<num>`
2. VJudge 新版页面会把页面数据塞进 `<textarea name="dataJson">…</textarea>`，插件从这里拿题目元信息（标题、OJ、题号、时限、来源）
3. **题面正文单独取**：从 `dataJson.descBriefs`（或页面 `#prob-descs li[data-key][data-version]`）里挑出官方英文版本，请求 `GET /problem/description/{descKey}?{version}`，把返回的 `sections` 拼成带小标题的完整题面。这个接口**不需要登录**也能读
4. 仍然解析不到时依次降级：页面 DOM 里的 `.problem-statement` → `dataJson` 里最长的 HTML / Markdown 字段 → 提示登录 + 诊断信息
5. 内容交给 Webview 渲染，图片补成绝对地址（`CDN_BASE_URL/` 会被替换成 CDN 前缀），公式交给 MathJax

文章同理：`dataJson` 里的 `content` 是 Markdown，`problemsBrief` 是题单题目清单。

榜单同理：网页每 5 秒拉一次 `GET /contest/rank/single/{比赛ID}`，返回 `{participants: {用户ID: {name, nickname}}, submissions: [[用户ID, 题目下标, 状态, 秒数, 得分, 满分]]}`。插件拿它和比赛 `dataJson`（罚时 `penalty`、`sumTime`、`partialScore`、`enableFreeze`/`freezeTime`/`unfreezeTime`、题目 `weight`）在本地算名次——和网页用的是同一份数据，所以 AC 时间、罚次都对得上。

比赛列表来自 `https://vjudge.net/contest/data`（DataTables 接口），比赛详情和题目列表都来自 `/contest/{id}` 的 `dataJson`（`dataJson.problems` 就是题目数组，字段 `oj` / `probNum` / `num` / `title` / `properties`），老接口 `/contest/filterProblem` 只在 `dataJson` 里没有题目时兜底。

团队同理：`/group` 页面里的 `dataJson` 给出「我的团队 / 邀请 / 公开团队」，团队详情来自 `/group/{shortName}` 的 `dataJson`（简介、成员、比赛、文章都在里面），搜索用 `POST /group/search`。注意团队只能用 **shortName** 打开，数字 ID 会被 303 重定向回 `/group`，插件会自动从团队列表或搜索里把 ID/名称换成 shortName。

提交走的是 VJudge 网页提交弹窗用的同一个接口：

- 练习：`POST /problem/submit/{题号}`，比赛内：`POST /contest/submit/{比赛ID}/{题号 A/B/C}`
- 表单：`method=0&language=<语言ID>&open=0|1&source=<代码原文>&captcha=&password=`
  其中 `source` 就是**代码原文**（网页提交弹窗里 `n.data.source = $("#submit-solution").val()`，URL 编码交给表单序列化），**不要自己 base64**
- 比赛提交额外带 `version` 和 `accessCode`：`version` 是**比赛页 `dataJson.version`**（形如 `"b46"` 的比赛快照版本，不是题目版本），`accessCode` 不需要密码时发空串——这两个漏了服务端直接回 HTTP 400。用自己绑定的账号代交时带 `bindingId`
- 返回 `{"runId": 123}` 表示提交成功；失败返回 `{"error":{"i18nKey":"submit.error.xxx"}}`，插件把这些 key 翻成中文（未登录 / 比赛未开始 / 语言不可用 / 需要验证码…）
- 语言列表优先取题目页 `dataJson`（网页提交弹窗也是用它渲染的），拿不到时退回 `/util/cfg` 里 `remoteOJs[<OJ>].languages`
- 评测结果轮询 `POST /solution/data/{runId}`，`processing` 变 `false` 即出结果，`statusType` 为 1 通过 / 2 未通过

## 已知限制

- **题目页本身要登录**：VJudge 对 `/problem/xxx` 未登录直接 303 到登录页，所以插件仍需要你的凭据（题面正文接口本身是匿名的）
- 题面里的图片和公式图片走 VJudge 的 CDN（自动从 `/util/cfg` 取，当前是 `https://cdn.vjudge.net.cn/`），拿不到时可以用 `vjudgeHelper.cdnBaseUrl` 手动指定
- 公式渲染依赖 MathJax（jsDelivr → 360 前端库 → cdnjs 依次回退），三个源都不通时公式会退化成原始 LaTeX
- MathJax 3 默认没有 `\bm`（洛谷/VJudge 中文题面很爱用），插件会把它换成 `\boldsymbol`，并在 MathJax 里预置 `\bm` / `\texttt` / `\textbf` 等宏；真遇到不认识的自定义命令，面板会 toast 点名，公式本身保留原文不再染红
- 公开比赛的题目列表不登录也能看；**私有 / 需要密码的比赛**要「已登录 + 已报名（或输过密码）」，否则面板会提示原因并给出「登录 VJudge」按钮
- 私有比赛可能隐藏原题出处（`oj-题号` 为空），这时题目只能点回 VJudge 网页里的题目锚点
- 内置简易浏览器（`simpleBrowser`）不共享你的浏览器登录态，题面可能显示为未登录，所以默认用插件自己的 `panel`
- MathJax 从 CDN 加载，离线时公式不会渲染（其余内容正常）
- 题面面板每次切换题目会重新渲染（滚动位置回到顶部）
- **提交**：只能用当前编辑器里的单个文件（多文件工程请自己合并）；私有 / 需要密码的比赛仍然要先在网页上报名或输密码，插件不会替你输比赛密码
- **提交验证码**：极少数情况下 VJudge 会要求图形验证码，插件会提示你去网页提交（终端里没法做题图）
- 语言列表来自题目页的 `dataJson`；如果某道题拿不到语言列表，插件会让你手填一次语言 ID（填过会记住）
- **榜单是本地按同一份数据算的**：罚时、AC 时间、名次与网页一致，但并列时的先后、以及管理员手工调整过的历史榜单可能和网页有细微差别；以网页为准的场合点「网页看榜」
- **榜单高亮「你」**需要读一次 `/user/` 拿到你的用户 ID；拿不到（比如凭据失效）就只是不高亮，不影响榜单本身
- 榜单只统计**比赛时间内的提交**：赛后补题（practice）交的题不会进榜，这点和网页默认视图一致；补题的提交记录在 VJudge 的「我的提交」里能查到
- 补题走的是练习题目的通道：如果这道题在比赛结束后没有公开（比如私有比赛的题），VJudge 会拒绝练习提交，这时插件会如实报出原因，只能在网页里看
- **「自己的账号」这种提交方式依赖你在 VJudge 上绑好 OJ 账号**（网页右上角 → Settings → OJ Accounts），凭据过期后 VJudge 会把这条绑定标成不可用，插件会提示你去重新登录；这种情况插件自己修不了
- **随机题目的选题与打开是两件事**：Codeforces / 洛谷 的选题走各自站点的公开接口（不需要登录），但**题面只有登录 VJudge 才能看**；「VJudge 全站随机」和「其他 OJ」连选题都要登录（VJudge 的题目列表对匿名用户返回空数组）
- **其他 OJ 没有难度数据**：VJudge 的题目列表本身不提供难度，所以只有 Codeforces（rating）和洛谷（1-8 级）能按难度随机
- **标签只有 CF / 洛谷有**：VJudge 的题目库没有算法标签，所以「VJudge 全站」「其他 OJ」不能按标签筛；CF 的标签是英文原值（`dp`/`graphs`，菜单里带中文说明），洛谷的标签表来自 `/_lfe/tags`（缓存 6 小时），多选都是「命中任一」
- **洛谷难度档位会变**：2026 年 6 月洛谷把难度改成 8 档，新插入的「提高（青）」是第 5 档，蓝/紫/黑整体后移一位。插件里的对照表是照洛谷自己的 `/_lfe/config`（`ProblemDifficulty`）抄的，怀疑又改了就 `node test/random-check.js --live` 对照一次
- 洛谷的题目列表前面有 WAF（第一次请求会 302 回来种 Cookie），插件会自动重试一次；如果洛谷本身抽风，会提示「可能触发了风控」
- **别人的提交只有图片**：VJudge 不给别人看源码文本，只返回一张 `codeImgUrl` 的图（防抄），所以面板里能看到、能另存，但**选不中文字也复制不出来** —— 这是站点行为，插件绕不过去
- **提交记录翻页靠「满 20 条」判断**：`/status/data` 的 `recordsTotal` 是假的 `9999999`（和 `/problem/data` 一个套路），所以只能按本页是否满页猜还有没有下一页；正好卡在 20 的整数倍时，最后可能多一次空翻页
- **提交记录不能直接按比赛筛**：`/status/data` 的 `contestId` 参数不生效（传了返回空列表），所以从比赛进来只能看到「这道题的全部提交」；榜单里点「比赛」标记会跳到这场比赛
- **「我的」需要用户名**：`un` 只认真实用户名（前端的 `mine` 是它自己换算的），插件为此读一次 `/message` 页拿 `visitor_username`；没登录时会自动退成「全部」并在状态栏说一句

## 排错

**提示「暂时拿不到题面」**

1. 先执行 `VJudge: 检查登录状态`
2. 若无效，重新走一遍「手动粘贴 Cookie」
3. 面板里点开「诊断信息」和「查看页面原始内容」，能看到 `dataJson` 的字段名和页面片段，方便定位是不是站点改版

**随机来一道题报「网络连接被中断」/ `Client network socket disconnected before secure TLS connection was established`**

这是连接被对面（或你本机的代理）单方面掐断，不是题号或账号的问题：

1. 插件现在会**自动重试两次**（400ms / 900ms 退避），并且**不再复用 keep-alive 连接**——
   Node 19 起默认的连接池会把早就被 Cloudflare 掐掉的空闲 socket 再拿出来用，正是这个报错的来源；
2. 如果你挂着代理 / 加速器，确认 `vjudge.net`、`codeforces.com`、`www.luogu.com.cn` 都走直连或都走代理（只走一半最容易断）；
3. 提示里会写明是哪个域名连不上，照着查那个域名的连通性即可。

**随机抽到的题打开后提示「拿不到题面」**

1. 抽题和看题是两回事：Codeforces / 洛谷 的**选题**不需要登录，**题面**需要——先 `VJudge: 检查登录状态`；
2. 「VJudge 全站随机」「其他 OJ」连选题都要登录，未登录会直接提示去登录（VJudge 的题目列表对匿名用户是空列表 + 假总数，插件已识别）；
3. 洛谷题库里个别新题还没被 VJudge 收录，遇到时再抽一次即可。

**比赛列表空白**

先点侧边栏右上角刷新；若仍为空，说明网络到 vjudge.net 不通，或者站点临时故障。

**提交没反应 / 报错**

1. `VJudge: 检查登录状态` —— 提交必须登录（题面接口匿名可读，但 `/problem/submit` 不行）
2. 提示「VJudge 拒绝了这次提交」通常是：没报名这场比赛、比赛已结束、或题目在这场比赛里不可提交
3. 提示「这门语言在这道题上不可用」：换一个语言（命令面板再跑一次，这次选别的）；想改默认语言就清掉 `globalState` 里的记忆（换账号或换 OJ 一般用不着）
4. 卡在「判题中」很久：VJudge 排队慢，`vjudgeHelper.judgeTimeout`（默认 120 秒）到点就停止等待，记录本身已经提交成功，用 `VJudge: 打开最近一次提交` 去看

**提交跑到练习去了 / 想确认交到了哪条通道**

执行 `VJudge: 查看提交日志（排查提交到哪条通道）`。日志里每次提交都有这几项：

- `submit.target`：这次提交认的是哪道题、有没有带上 `contestId` / `problemNum`
- `submit.request`：`channel` 是 `contest` 还是 `problem`，以及实际请求路径、`method`、`bindingId`、语言、是否带 `version` / `accessCode`
- `submit.response` / `submit.error`：服务端 HTTP 状态和原始响应（`i18nKey` 一目了然）
- `submit.fallback_practice`：比赛通道被拒、自动改走练习通道时记下服务端原话

> 只要 `submit.target.contestId` 是空的，就说明这次提交压根没认成比赛题（多半是从侧边栏「最近浏览」或题号直接打开的），此时用 `VJudge: 提交到指定题目…` 粘贴比赛题目链接（`https://vjudge.net/contest/862701#problem/H`）再交，才会走比赛通道。

**开发时跑不启动 VS Code 的检查**

```bash
node test/activate-check.js     # 假 vscode 环境跑 activate()，验证命令/侧边栏/面板
node test/live-check.js         # 真实访问 vjudge.net，验证解析逻辑
node test/submit-flow-check.js  # 用打桩的客户端演练「一键提交」全流程（不联网）
node test/submit-check.js       # 提交逻辑自检 + 匿名接口探测；带 VJ_COOKIE 可真实提交一次
node test/mathjax-check.js      # 把注入面板的 MathJax 配置真正执行一遍（校验宏表与转义，不联网）
node test/highlight-check.js    # 代码高亮：分词、转义、样例不误染、Markdown 围栏（不联网）
node test/message-check.js      # 私信/讨论区接口与渲染 + 榜单「含补题」（打桩，不联网）
node test/random-check.js       # 随机抽题：CF/洛谷/VJudge 三条通道 + 登录页与假总数踩坑（不联网）
node test/random-flow-check.js  # 随机抽题的菜单流程：选 OJ → 选难度 → 选标签 → 记住条件（不联网）
node test/status-check.js         # 提交记录：/status/data 参数、代码/图片/无权限三条分支（不联网）
node test/submissions-flow-check.js # 提交记录面板全流程：切筛选、看源码、看图、加载更多（不联网）
```

真实提交自检（会在 VJudge 上产生一条记录）：

```bash
VJ_COOKIE='JSESSIONID=...; JSESSlONID=...' \
VJ_PROBLEM=CodeForces-1A VJ_FILE=./a.cpp \
node test/submit-check.js
```

## License

MIT
