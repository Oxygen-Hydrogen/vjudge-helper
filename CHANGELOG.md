# Changelog

## 1.8.3

### 修：样例其实写进去了，但 CPH-NG 里看不见

现象：`用当前文件` 发出去，CPH-NG 侧边栏还是那道旧题、样例空空，状态栏却提示成功。

原因是 CPH-NG 的导入流程：先 `problemService.save(新题)` 写记录文件，再
`repo.loadByPath(源文件)` 去取这道题的活对象——而它**先在内存里按 `src.path` 找**
（`getByPath` → `problem.isRelated()`），命中就直接返回内存里那道旧题，磁盘上刚写的
新题根本不读。旧题正是「当前打开的这个文件」那道，所以必然命中。结果 `.cph-ng/<文件>.bin`
里样例是齐的，界面却还是旧题（日志里能对上：`Saved problem …` 之后推给 webview 的仍是旧
`problemId`）。

修法：发之前先**让 CPH-NG 把旧题从内存里卸掉**——切一下活动文本编辑器会触发它的
`onActiveEditorChanged()`（先 `persist(旧题)` 存盘，再从 `backgroundProblems` 删除）。
切换后会盯着记录文件的 mtime 变化确认真的存了（最多 1.2 秒），再发导入，它这次就会从磁盘
读到新记录。发送完 CPH-NG 会自己打开目标文件，用户回到原来的地方（没有别的标签页时会临时开
一个空白文档，发完关掉）。

- 只在「目标文件已有 CPH-NG 题目记录、而且就是它当前这份」时才做这套切换，别的情况下照旧直接发
- 选择框里会提示「CPH-NG 里已有这道题，样例会被换成题面里的」，避免悄悄换掉手工加的样例
- 顺带把 CPH-NG 记录路径的推算抽成 `cph.recordPathFor()`（`<工作区>/.cph-ng/<相对路径>.bin`），
  自检里覆盖根目录、子目录、不在工作区三种情况

## 1.8.2

### 修：「用当前文件」认的就是 `Ctrl+Alt+Enter` 提交的那份

1.8.1 取「当前文件」用的是 `window.activeTextEditor`，可是**题面面板一拿到焦点它就成了
`undefined`**——而「传送样例」这个按钮正好长在面板上。于是你写 `solution.cpp`、打开面板、
点按钮，选择框里根本没有「用当前文件」这一项，只剩「新建」和「让 CPH-NG 自己决定」。
现在和提交走同一个解析：活动编辑器 → 最近编辑过的文档（`currentCodeDocument()`），
也就是 `Ctrl+Alt+Enter` 会提交的那个文件。

- 「用当前文件」排到选择框**第一项**，回车就挂上去；标题里写明「就是 Ctrl+Alt+Enter
  提交的那个文件」，不用再猜是哪一个
- 新建源文件的落点也改成这份代码所在的目录（面板拿焦点时不会掉到工作区根目录去）
- 未命名缓冲区（`untitled:`）、`git:` / `output:` 这类虚拟文档、已经关掉的文档一律不算
  「当前文件」——CPH-NG 要的是磁盘上真实存在的路径，判断抽到了
  `cph.filePathOfDocument()`，自检里有覆盖

## 1.8.1

### 修：传送样例前先问「建新文件还是用当前文件」

1.8.0 是直接把题丢给 CPH-NG，文件放哪、什么语言全由它决定：CPH-NG 的默认路径脚本
写死 `<工作区>/<题名>.cpp`，于是「我自己写的是 `solution.py`」或者「我文件已经开着了」这两种
最常见的情况都很别扭——它总会另起一个 `.cpp`。现在点按钮先弹一个选择框：

- **新建一个源文件** —— 接着选语言（C++ / C / Python / Java / Rust / JavaScript），
  文件建在当前文件旁边（没有打开的文件就放工作区根目录）。语言会记住，下次排第一个。
- **用当前文件：`xxx.cpp`** —— 样例直接挂到正在编辑的文件上，**不会覆盖内容**，
  CPH-NG 里打开它就能看到样例、直接跑。
- **让 CPH-NG 自己决定** —— 1.8.0 的老行为，按它的默认脚本建 `.cpp`。

不想每次都被问，可以用新设置 `vjudgeHelper.cphFileMode`（`ask` / `new` / `current` / `auto`）
和 `vjudgeHelper.cphLanguage`（`ask` 或直接指定 `cpp` `c` `py` `java` `rs` `js`）。

### 怎么做到的（没碰它们的内部存储）

CPH-NG 的路由器只认 Competitive Companion 的报文，但它在导入前会执行
`cph-ng.companion.customPathScript` 决定源文件放在哪，而且**目标文件已存在时它不覆盖、
只把样例挂上去**。所以：

- 新文件 `res/cph-ng-path.js`：一份给小沙箱用的路径脚本，从题目 URL 片段里的
  `#__vjudge_file=<绝对路径>` 取出目标文件（顺手把标记从 URL 上抹掉，题目信息里不会留垃圾）；
  没有标记时退回默认脚本的老行为（Codeforces / 洛谷 / QOJ / AtCoder 的短文件名，多个工作区会问一个），
  所以浏览器里的 Competitive Companion 照样能用。
- 第一次选「新建 / 当前文件」时会把这个设置指过去；**只在它还是默认值时才自动改**，
  你自己写过路径脚本的话会先弹窗问一句，不同意就退回「让 CPH-NG 自己决定」，绝不动你的配置。
- 发完会等最多 4 秒看文件到底有没有落地；没有就提示去检查这个设置（而不是假装成功）。

### 测试

- 新增 `test/cph-path-check.js`：语言表（`.cc/.cxx` 也算 C++、不认识的扩展名返回 null）、
  文件名与 URL 标记（中文 / 空格 / 反斜杠往返、丢掉原有 `#片段`、不改原对象），
  以及**真的把路径脚本丢进 `vm` 沙箱跑一遍**（复刻 CPH-NG 的包装与上下文：只给
  problems / workspaceFolders / ui / utils / logger / path / fs.existsSync），
  覆盖标记命中、认不出 URL 的兜底、多工作区询问、零工作区返回 null、一次多道题。
- 实测两种模式都对着本机运行中的 CPH-NG 走过一遍：新建 `传送 测试_A.py` 成功落盘
  （中文、空格、工程路径里的不可见字符都没问题），对一个已有内容的文件再发一次，
  文件内容原样保留、样例挂上去。

## 1.8.0

### 新增：样例一键传送至 CPH / CPH-NG

题面面板右上角多了一个「传送样例至 CPH」。前提是窗口里装了
[CPH](https://marketplace.visualstudio.com/items?itemName=DivyanshuAgrawal.competitive-programming-helper)
或 [CPH-NG](https://marketplace.visualstudio.com/items?itemName=langningchen.cph-ng)
（装了哪个就用哪个，CPH-NG 优先）；**一个都没装就不显示这个按钮**，不会出现点了没反应的情况。
命令面板里也有 `VJudge: 把样例传送到 CPH / CPH-NG`，按当前正在看的题目发。

发送走的是 CPH 系公开的接收端，也就是 Competitive Companion 的那套协议：

    POST http://127.0.0.1:27121/
    X-Competitive-Companion: true
    { name, group, url, tests: [{input, output}], batch: {id, size: 1}, timeLimit, memoryLimit … }

- 好处是**不碰它们的内部存储**（`.prob` 文件命名、webview 状态都是私有实现），CPH 换版本也不受影响。
- 端口：默认 27121；装了 CPH-NG 会跟着它的 `cph-ng.companion.listenPort` 走，也可以用新设置
  `vjudgeHelper.cphPort` 覆盖（同一个端口只能被一个窗口占用）。
- 发送的题目带了题名、题号、来源链接、时限、内存；`batch.size = 1` 是 CPH-NG 的路由器「立刻自动导入」的条件。

样例是**从题面里现解析**的（新文件 `src/cph.js`），解析规则对齐 Competitive Companion
自己的 `VirtualJudgeProblemParser`（它用的选择器和「两个一组」的配对方式就是真实题面的形状）：

- 主路径 `.vjudge_sample pre`；没有样例表时依次找 `pre`、`div[style="font-family:Monospace, Courier;"] > b`、
  `span[style='font-family:"Courier New"']`（这三种写法在真实题面里都出现过）。
- 配对：能认出「Input / Output / 样例输入 / 输出 #1」这类标签就按标签配，认不出就两两顺序配——
  但只在「前面提到过样例 / Sample」「块本身带标签」「块在样例表里」三者之一成立时才顺序配，
  免得把「输入格式」「输出格式」里的代码块当成一组样例。
- 文本处理：`<br>` 换行、`&lt;`/`&amp;`/`&quot;` 还原、行尾空白剪掉（不然 CPH 里看着一样、对拍却 WA）；
  `<pre>` 里再套 `<span>`/`<code>`/`<b>` 也能取出原文；「Input」「样例输出」这种纯标签块会被剔掉。
- 多组样例会去重，交互题只有输入也能发；一组都没解析到就明说，不会发一道空题过去。

失败时（端口没人监听 / 超时 / 非 2xx）直接说明原因，并提供「复制诊断信息」把端口、状态码、
服务端响应体复制到剪贴板。

### 测试

- 新增 `test/cph-check.js`：17 项样例抽取（样例表、CF 风格、中文标题、等宽 div、Courier span、
  实体与 `<br>`、多组重复、表头、"输入格式"不误判、交互题、单格挤一组）、报文结构（毫秒 / MB 单位换算、
  文件名非法字符、`batch.size`），以及**真的起一个本地 HTTP 服务收一次 POST**（校验 method / path /
  请求头 / body，外加端口不通与 500 两个失败分支）。
- 实测：向本机运行中的 CPH-NG 路由器投递一次，返回 `200 {"status":"ok"}`，路由器日志显示 `Batch … dispatched`。

## 1.7.2

### 修复：私信连点「发送」会发出去好几条

点一下只是把内容交给扩展，真正发出去要等一次网络往返（几百毫秒到几秒），
这期间按钮一直可点，连点几次就一条一条全发出去了。现在两头都堵住：

- **前端**：点下去立刻把按钮置灰、文案改成「发送中…」，并记 `data-busy`；
  这期间再点（包括按 Ctrl+Enter）都直接忽略。发送结束（成功或失败）由扩展回一条
  `pmSendDone` 把按钮复原，失败时输入框里的内容也还在，不用重打。
- **扩展**：按会话加锁（`pmSending` Set），同一个人同一时刻只允许一条在飞，
  重绘后按钮又变得可点、但上一条还没回来的情况会被挡下，并提示「上一条还在发送，稍等一下」。
- 顺手修了同一个毛病的**讨论区发评论**（`discussSend`）：连点「发表」不会再刷出好几条评论；
  它的按钮不在局部刷新的范围里，所以另有一条 `discussSendDone` 负责复原。
- 空内容在前端就拦住了，不用再往返一次。

### 测试

- 新增 `test/message-send-check.js`：这类 bug 只在真实 DOM 里才复现，所以用
  `renderers` 生成真面板 + 无头 Edge 加载 `panel.js`，脚本里连点 3 次按钮、再补一发
  Ctrl+Enter，断言只发出 1 条、按钮被禁用、`pmSendDone` 后能复原再发。
  机器上没有 Edge / Chrome 时自动跳过。

## 1.7.1

### 修复：私信 / 讨论区里的用户头像显示不出来

之前这两处只画了一个彩色字母方块（代码里写着「站点头像带登录态，webview 加载会掉图」）。
实测那个判断是错的：真实头像在 CDN 上，**匿名就能取**

    https://cdn.vjudge.net.cn/user/avatar/<userId>

（`/user` 页面的 `<img id="user_avatar">` 就是这个地址，不带 Cookie 直接 200 image/png）。
所以现在正常显示头像：

- 私信会话列表（26px）和会话头部（30px）都显示对方头像，数据从 `/message` 页里
  `<li class="contact">` 的 `<img src>` 解析，相对路径按 `/util/cfg` 的 CDN 地址补全。
- 讨论区帖子头像用 `authorId` 直接拼（`/comment/thread` 只给 id，不给地址）。
- 没设置头像的用户 CDN 会 404，这时**自动退回原来那个彩色首字母**（`panel.js` 在捕获阶段
  监听 `img` 的 error，把图摘掉），不会出现破图方块。
- 图片用 `loading="lazy"` + `referrerpolicy="no-referrer"`，不会把本地路径泄露给 CDN。

## 1.7.0

### 新增：本地查看提交记录（自己的源码 / 别人的图片）

- 新命令 `VJudge: 我的提交记录（看源码）` / `VJudge: 全站提交记录（可按用户/题目筛）`，
  侧边栏「顺手的小功能」里也各有一个入口。
- 面板里是提交列表（时间 / 用户 / 题目 / 结果 / 用时 / 内存 / 语言 / 长度），点一行看详情：
  - **自己的提交**：VJudge 给的是文本（`showCode=true` → `code`），面板用内置高亮器染色，
    带「复制代码」；
  - **别人的提交**：站点只给 `codeImgUrl`（一张防抄的图片），插件把图片下回来转 data URI 直接显示，
    右键可另存；快照没生成好会自动重试 6 次（每次 900ms），失败给「重新获取」；
  - 没权限（`codeAccessInfo`）会说清原因，比如「看提交详情要先登录 VJudge」。
- 筛选：我的 / 全部、全部结果 / 只看通过、按用户名、按题目；从题目面板点「提交记录」进来
  自动带着这道题的条件。
- 列表走 `GET /status/data`（DataTables 服务端分页，匿名可读），每次 20 条「加载更多」。
  `recordsTotal` 是假的 `9999999`，所以「还有没有下一页」按本页是否满 20 条判断。
- 「我的」要先知道自己的用户名（`un` 只认真名），为此读一次 `/message` 页的
  `visitor_username` 并缓存；没登录时自动退成「全部」，状态栏说明原因。

### 修复

- `src/http.js` 新增 `binary` 选项（返回 Buffer）。之前所有响应都按 utf8 转字符串，
  把图片转 base64 会先把二进制解坏。
- 面板里没被 `.vj-markdown a` 覆盖到的链接（用户名、比赛标记）在暗色主题下是浏览器的深蓝/紫，
  几乎看不见，现在统一走 `--vj-accent`。

### 测试

- `test/status-check.js`（25 项）：`/status/data` 参数、假总数、满页判断、`code` / `codeImgUrl` /
  `codeAccessInfo` 三条分支、图片重试、用户名探测、渲染。
- `test/submissions-flow-check.js`：面板全流程打桩（切筛选、看源码、看图、加载更多、没登录降级）。

## 1.6.0

### 新增：随机抽题可以按算法标签筛

`随机来一道题` 在选完难度之后多一步「算法标签（可多选）」：

- **Codeforces**：标签来自官方题库接口（`tags: ['dp','graphs',…]`，共 38 个），本地过滤；
  菜单里每个标签配中文说明和题数（`dp · 动态规划 · 2529 题`，只统计真正抽得到的题）。
- **洛谷**：标签来自 `GET /_lfe/tags`（只取 `type === 'Algorithm'`，262 个），列表端点用 `tag=<id>`
  过滤，翻页时也带着标签；标签表内存缓存 6 小时。
- 多选是**命中任一**（洛谷 `tag=3,6` 本身就是并集语义，实测 `tag=3,11` 的 count 正好是两档并集）。
- 标签 + 难度没有交集时**不会偷偷退化成整库**，而是明确告诉你「换标签或放宽难度」。
- 「VJudge 全站」「其他 OJ」不提供标签筛选（VJudge 的题目库没有算法标签）。

标签拿不到（网络问题）时会问一句「要不就不带标签抽」，不会把整次抽题堵死。

### 其它

- 修掉 `luoguListUrl` 的一个隐患：`Number(null) === 0`，脏标签数据会被拼成 `tag=0`，现在显式挡掉 `null` / `undefined`。
- 命令标题改为 `随机来一道题（可选 OJ / 难度 / 标签）`。
- 测试：`random-check` 加 6 项（CF 命中任一 / 标签不退化 / 标签统计 / 洛谷标签解析 / 待 tag 的 URL / 洛谷翻页带标签），
  `random-flow-check` 加 3 项（洛谷标签 → `tags=[3]`、CF 标签 → `tags=['dp']`、不选标签时不传 tags）。

## 1.5.1

### 修复：洛谷难度对照表过期（少了新加的「提高（青）」）

洛谷在 2026 年 6 月调整了难度体系：「提高+/省选−」与「省选/NOI−」两档拆成
**提高（青）/ 提高+/省选−（蓝）/ 省选/NOI−（紫）** 三档，档位从 7 个变成 8 个。
插件里的对照表还停在改版前，后果是：

- 菜单里根本没有「青题」这个选项；
- 抽到改版后编号 5 的题（青）会显示成「提高+/省选−（蓝）」，6/7 同理错位一档；
- 编号 8（黑题）落到兜底的「难度 8」上。

现在对照表照抄洛谷自己的 `GET /_lfe/config` → `ProblemDifficulty`：
`1 入门 · 红 / 2 普及− · 橙 / 3 普及 · 黄 / 4 普及+/提高− · 绿 / 5 提高 · 青 / 6 提高+/省选− · 蓝 / 7 省选/NOI− · 紫 / 8 NOI/NOI+/CTS · 黑`，
并把青/蓝/紫的 CF 参考区间（2000-2400 / 2300-2700 / 2700-3100）写进了菜单说明。

另外 `random-check.js` 新增 3 项离线断言（档位连续、青=5、`/_lfe/config` 解析），
加 `--live` 时会联网把本地表和洛谷线上表对一遍，以后再改版能第一时间发现。

## 1.5.0

### 修复：随机一道题时报 `Client network socket disconnected before secure TLS connection was established`

- 根因是 **连接复用**：Node 19 起 `https.globalAgent` 默认 `keepAlive = true`，连接池里那些早被
  Cloudflare / 前置机单方面关掉的空闲 socket 会被再拿出来用，于是随机报这个错。现在插件每个请求
  单独握手（`keepAlive: false`），多花约 100ms，换掉随机失败。
- 断线类错误（`ECONNRESET` / `EPIPE` / `EPROTO` / `ETIMEDOUT` / `EAI_AGAIN` / 超时）现在判定为
  **可重试**，默认重试两次、退避 400ms → 900ms；重试仍失败才报错，并且把话说成人话
  （点明是哪个域名连不上），不再直接甩 Node 的原始报错。
- 之前判重试只匹配 `err.message`，恰好漏掉了这条 `Client network socket disconnected…`，所以一次都没重试过。

### 修复：随机抽到的题变成「random · random / 拿不到题面」

- 匿名访问 `/problem/random` 时 VJudge 会**直接返回登录页 HTML（HTTP 200）**，URL 还停在
  `/problem/random`；旧代码从 URL 里切出最后一段当题号，于是 `random` 被当成题目打开。
  现在会先确认返回的确实是题目页（有 `dataJson`），并且题号不能是 `random`，否则抛「需要登录」。
- 匿名调 `/problem/data` 会返回**空数组 + 假总数 `recordsTotal = 9999999`**，用它当题目总数会抽出
  不存在的偏移量；现在识别到这个假总数就判成「需要登录」。

### 新增：随机来一道题可以选 OJ、选难度

- 命令面板 / 侧边栏菜单的「随机来一道题」现在先问范围：
  - **不限 OJ**（Codeforces / 洛谷 各一半）
  - **Codeforces**：按 rating 区间（800-1000 … 2500+，也可自定义 `1600-1900`）
  - **洛谷**：按难度（入门红 → NOI 黑），支持一次勾多个难度
  - **VJudge 全站随机**（需要登录）
  - **其他 OJ…**：从 VJudge 收录的 62 个 OJ 里挑一个（需要登录，无难度数据）
- 抽过一次后，命令第一项变成 **「再来一道」**（沿用上次条件，回车即抽），条件存在 `globalState`。
- 三条选题通道：
  | 通道 | 接口 | 是否需要登录 | 难度 |
  | --- | --- | --- | --- |
  | Codeforces | `GET https://codeforces.com/api/problemset.problems`（整库 2 MB，内存缓存 6 小时） | 否 | rating |
  | 洛谷 | `GET https://www.luogu.com.cn/problem/list?difficulty=&page=&type=P`（解析 SSR 的 `lentille-context`） | 否 | 1-7 级 |
  | VJudge | `GET /problem/data`（DataTables，随机 `start` 偏移） | 是 | 无 |
- 洛谷前面有 WAF：第一次请求 302 回来种 `C3VK`，插件自己跟 Cookie 重试（最多 3 次）。
- 没登录就抽到题时，会先提示「题面需要登录后才能看」并给「去登录」按钮，省得打开后又是「拿不到题面」。
- CF 题库会过滤掉 `problemsetName`（acmsguru 之类）、没有 `contestId`、没有 `rating` 的题——
  这些在 VJudge 上打不开。

## 1.4.0

### 新增：私信（站内 PM）

- 侧边栏菜单 / 命令面板新增「打开私信」（`VJudge: 打开私信`），一个面板里左栏会话、右栏对话。
- **会话列表只能解析 HTML**：`/message` 是服务端渲染的，没有 JSON 接口。真正是 AJAX 的只有四个动作，
  都按站点前端源码对齐过：
  | 动作 | 接口 | 参数 |
  | --- | --- | --- |
  | 拉会话 | `POST /message/conversation/{contactId}` | `start`（跳过最近 N 条，每次 20） |
  | 发送 | `POST /message/post` | `contactId`、`content` |
  | 删除 | `POST /message/delete?id=` | id 在 **query** 上，不在 body |
  | 拉黑 | `POST /message/block` | `contactId`、`blocked` |
- 切联系人 / 发消息 / 删除 / 拉黑都只替换右半边，**输入框里的草稿不会被冲掉**。
- 消息正文按 Markdown 渲染（代码块照样语法高亮、公式走 MathJax），自己的消息靠右并换底色。
- `Ctrl+Enter` 发送；被拉黑时会禁用输入框并把按钮切成「解除拉黑」。
- 未登录时 `/message/conversation/*` 回的是**空对象 `{}`**（不是 401），已专门识别成「需要登录」。

### 新增：比赛面板可以切「仅赛时 / 含赛后补题」

- 榜单标题那一行多了个开关，默认「仅赛时」（和网页默认视图一致）。
- 切到「含赛后补题」后，比赛结束后才通过的提交也会算进 AC 与排名，单元格用 **†** 标注，
  横幅会说明「排名会因此比仅赛时好看」。
- 赛时就过了的题不会被误标成补题（只有真正靠赛后提交 AC 的才标）。
- 换一场比赛时开关自动回到「仅赛时」，不会把上一场的状态带过去。

### 新增：比赛讨论区

- 比赛面板底部新增讨论区：帖子按 `parentId` 嵌套（最多三层），自己发的帖子可以删。
- 接口是站点通用的评论系统：`GET /comment/thread?path=contest/{id}&loadAll=1` 读，
  `POST /comment/post`（`path`/`parent`/`content`/`broadcast`）写，`POST /comment/delete/{id}` 删。
- 支持回复（点帖子上的「回复」带 `parent`）、刷新只换帖子列表（不丢草稿）、`Ctrl+Enter` 发表。
- 匿名可读；发表需要登录，错误按 i18nKey 翻成人话（「请先登录 VJudge」「内容过短，别刷屏」等）。

## 1.3.9

### 新增：题面 / 文章里的代码块带语法高亮了

之前 `<pre>` 里的代码是**一片同色**（只有注释、字符串都没区分），看题解时很难扫。

- 新增 `src/highlight.js`：**零依赖**的词法着色器（不引 highlight.js / Prism，也不走 CDN——
  MathJax 已经吃过 jsDelivr 不通的苦，代码高亮必须离线可用）。
  在 Node 侧一次性生成 `<span class="vj-tok-*">`，webview 里不用再跑 JS。
- 支持 C / C++ / Java / JavaScript / Go / Rust（C 系分词器）、Pascal、Python，别名一次抹平：
  `C++` / `cpp` / `cpp17` / `c++17` / `language-cpp` / `brush:cpp;` / `.cpp` / `pas` / `python3` / `java8` 都认。
- 着色范围：注释、字符串（含 `'c'`、三引号、Pascal 的 `''` 转义）、`#include` 指令与头文件、
  数字、关键字、类型、函数名。运算符保持正文色（跟 VS Code 默认一致）。
- **认不出语言就一个字都不染**：样例输入 `1 2` 这种绝不能被当成代码上色。
- **样例区 `<table class="vjudge_sample">` 整块跳过**（那是输入输出数据）。
- **富文本 `<pre>`（里面已经是 MathJax 的 `<span>`）原样放过**，不拆结构；`<br>` 会先换回换行再着色。
- 配色跟 VS Code 的 Dark+ / Light+ 对齐（webview 拿不到主题的 token 色，没有对应 CSS 变量）：
  `:root` 放浅色一套，`body.vscode-dark` 覆盖成深色一套。
- 覆盖到所有出代码的地方：VJudge 题面 HTML 的 `<pre>`（`highlightCodeBlocks`）、
  Markdown 围栏（`renderMarkdown`，带语言用语言的，没写语言的自动识别）。

### 修正

- Markdown 围栏 ````` ```cpp ``` `` 之前会把语言信息整段丢掉（`inCode` 只记行），现在会取到语言。
- `<pre>` 上的 `class` 现在是合并而不是追加第二个 `class` 属性（浏览器只认第一个）。

### 测试

- 新增 `test/highlight-check.js`（21 项）：关键字/字符串/注释/数字分类、`#include` 与头文件分开染、
  字符串里的 `//` 不被当注释、Pascal 大小写不敏感、代码里的 `< > &` 与 `<script>` 必须转义、
  样例表格与富文本 `<pre>` 不动、二次处理幂等、Markdown 围栏（带/不带语言）。
- 真实数据抽查：匿名读 VJudge 文章 #7（LA3357 Pinary 的题解），C++ 代码块 95 个 token 全部正确着色。

## 1.3.8

### 修复：中文题面里的 `\bm` 被渲染成红字（LaTeX 看起来“挂了”）

- **现象**：打开 `洛谷-P1001` 的中文题面，Background 里「请输入整数 **红字 `\bm a`** 和 **红字 `\bm b`**」，
  其余公式（`a,b`、`-10^9\le a\le 10^9`）都是正常的——所以不是 MathJax 没加载，而是**个别命令它不认识**。
- **根因**：`\bm` 是 LaTeX `bm` 宏包的命令，**MathJax 3 默认没有**（只有 `\boldsymbol`）。
  MathJax 的 `noundefined` 包遇到未知命令会原样输出并**染成红色**，观感上就像公式“挂了”。
  洛谷中文题面、VJudge 的中文翻译里 `\bm` 用得挺多。
- **现在**（两道保险）：
  - 渲染前预处理（`src/util.js` 的 `repairLatexCommands`，挂在 `mathTokenToLatex` 的每个出口上）：
    `\bm` → `\boldsymbol`（正则带 `(?![A-Za-z])`，不会误伤 `\bmod`）。
  - MathJax 配置里补一份 `tex.macros`（`MATHJAX_TEX_MACROS`，由 `shell.js` 注入）：
    `bm` / `texttt` / `textsf` / `textrm` / `textnormal` / `textup` / `textbf` / `textit` / `textsl` /
    `degree` / `\R \N \Z \Q \C`，以后遇到同类命令不用再改代码。
  - 面板自检多一档：引擎正常但页面上出现 `mjx-merror` 时，toast 里点名是哪几个命令
    （「有 2 处公式含 MathJax 不认识的命令（\bm），可点「浏览器打开」对照原文」）。
- **验证**：用 `mathjax-full` 3.2 按 CDN 打包版同一套包组合
  （`base, ams, newcommand, noundefined, require, autoload, configmacros`）在本地跑过：
  `\bm a`、`\bm{a}`、`\texttt{int}`、`\textbf{AB}`、`a\bmod b`、`\leqslant`、`\degree`、`\R^2`、
  `\begin{cases}`、`\operatorname`、`\varnothing` 全部 `ok`（无 `mjx-merror`）；
  未加宏时 `\bm` 必定 `Undefined control sequence \bm` —— 与截图一致。
  另外确认了 CDN 的 `tex-mml-chtml.js` 默认 packages 里就有 `configmacros`，
  所以 `tex.macros` 在面板里是生效的，`\boldsymbol` 由 `autoload` 自动加载。

## 1.3.7

### 修复：`洛谷-P1001` 这种中文 OJ 名被判成「无法识别」

- **现象**：输入框里敲 `洛谷-P1001`（其实这是 VJudge 上的**正确**题号），插件报
  「无法识别「洛谷-P1001」，请输入题号（如 CodeForces-1A）或链接」。
- **两个原因叠在一起**：
  1. `parseInput` 判定「短题号」用的是 `/^[A-Za-z][A-Za-z0-9]*-\S+$/`——**只认 ASCII 开头的 OJ 名**，
     `洛` 是中文，直接不匹配；`findProblemKeyInText` 里的兜底正则 `\b([A-Z]…-[A-Za-z0-9_.]+)\b`
     同样要求大写字母开头，所以连「从选中文本里找题号」这条路也过不去。
  2. 更根本的是——**VJudge 给洛谷用的 OJ 名就是中文「洛谷」**（`GET /util/cfg` 的 `remoteOJs`
     键名：`洛谷` / `牛客` / `黑暗爆炸` / `计蒜客` / `代码源` 全是中文），而插件一直按
     `Luogu-` 生成题号（原生链接转换也是 `Luogu-P1000`），也就是说就算识别了，拿到的 key 也打不开。
- **现在**：
  - 新增 `OJ_KEY_ALIASES` / `canonicalOjName()` / `normalizeProblemKey()`（`src/util.js`），
    把用户写的 OJ 名统一折成 VJudge 里的写法：`luogu` / `Luogu` / `洛谷` → `洛谷`，
    `bzoj` → `黑暗爆炸`，`nowcoder` → `牛客`，`cf` → `CodeForces`，`loj` → `LibreOJ`…
  - 题号识别支持中文名、常见别名、空格分隔、全角横线、外面套引号/括号：
    `洛谷-P1001`、`luogu-P1001`、`洛谷 P1001`、`洛谷－P1001`、`「洛谷-P1001」` 都能认，
    空格分隔的写法只对已知 OJ 名生效（`hello world` 不会被当成题号）。
  - `convertOjUrl` 修掉洛谷链接转成 `Luogu-` 的错误；NowCoder 的前缀也按 `remoteOjs` 改成 `牛客`。
  - `showProblem()` 入口统一走一遍规范化，所以从面板链接、命令、内部命令进来的题号也一并受益。
  - 输入框提示、报错文案补上 `洛谷-P1001` 的例子，状态栏改成「已按 VJudge 题号识别为 洛谷-P1001」。
  - `README` 里的 `Luogu-P1000` 也改对了。

## 1.3.6

### 修复：比赛通道一直被服务端回 400，提交全被挤到练习通道

- **日志给出的真相**（1.3.5 加的提交日志）：
  - `POST /contest/submit/863286/E` → **HTTP 400**（HTML 错误页），没有 `runId`
  - 于是触发「比赛通道被拒」分支，改走 `POST /problem/submit/CodeForces-2275E` → 200，拿到 `runId`
  - 也就是说：不是没认成比赛题，是**比赛接口的报 fields 不对**。
- **根因**：比赛提交少了一个必填字段 `version`——**比赛的快照版本**。翻比赛页专属 bundle（`d4d7a2d1…`）里的提交按钮处理：

  ```js
  showSubmitModal({ inContest: !0, contestId: St.id, num: a.num,
                    needAccessCode: ..., version: St.version, ... })
  ```

  `St` 就是比赛页的 `dataJson`，`St.version` 形如 `"b46"`。提交时前端会 `n.data.version = H.version`，
  另外还会固定带上 `n.data.accessCode`（不需要密码时是空串）。插件两个都漏了，服务端直接 400。
- **现在**：
  - `fetchContest()` 暴露 `version`（比赛 `dataJson.version`）。
  - 从比赛面板 / 比赛题目链接进入的题目，把 `contestVersion` 一起带进面板、`globalState` 记忆。
  - 提交前若发现认的是比赛题但手里没有版本号（老记忆里的题目），现场拉一次比赛数据补上。
  - 比赛通道的请求现在带 `version=<比赛版本>` 和 `accessCode=`（空串，和网页一致）。
- **顺手修掉一个坑**：以前 400 的报错文案是插件自己编的「常见原因是没登录、没报名这场比赛，或比赛已经结束」，
  这句话本身会被 `isContestClosedError()` 的正则命中，于是**任何 400 都会被当成「比赛已结束」自动退回练习通道**——
  真实的失败原因就被吞掉了。现在 400 只报事实：`VJudge 拒绝了这次提交（HTTP 400）：<错误页正文>`，
  页面上真写了「比赛已结束」才会回退，别的错误会如实弹给你，并连同错误页正文写进日志（`submit.http400`）。

### 其它

- 测试：`submit-flow-check` [5] 增加「比赛提交必须带 `version` / `accessCode`」两项断言（共 35 项）；其余脚本全过。

## 1.3.5

### 新增：提交日志（这次能看清楚到底走了哪条通道）

- 每次提交都会往 `logs/<会话>/window1/exthost/vjudge-helper.vjudge-helper/vjudge-submit.log` 追加一行 JSON：题目、比赛 ID、题号、实际请求路径（`/contest/submit/...` 还是 `/problem/submit/...`）、`method` / `bindingId` / 语言 / `version` / `accessCode` / `token` 有没有带、源码长度、HTTP 状态码、服务端原始响应（截断 400 字）。
- 新命令 **`VJudge: 查看提交日志（排查提交到哪条通道）`**，直接在工作区打开这个文件；同一份内容也镜像到「输出」面板的 `VJudge Helper` 频道。
- 结果通知里会写明通道：走比赛通道是「比赛 #xxx N 题」，被服务端拒后改走练习通道则写「走了练习通道：<服务端原话>，不计入比赛」。

### 改进：不再默默换通道

- 比赛通道被拒（`contest_ended` 等）自动改练习通道时，状态栏提示从「已改成补题提交」改成「比赛通道被拒（<原因>），已改成练习通道提交」，原因来自服务端原文，不再由插件替它下结论。
- 提交失败时把 `i18nKey` 和服务端响应一起写进日志，不用再靠猜。

### 其它

- `src/log.js`：不依赖 `vscode` 的极简 JSONL 日志，测试环境也能跑；写盘失败不影响提交。
- 测试桩补 `createOutputChannel`；`contest-panel-check` [7] 的断言跟着新文案调整。`check-syntax` 23 个文件、5 个自检脚本全过。

## 1.3.4

### 修复：比赛结束后提交被强行改走练习通道，不进这场比赛

- **原因**：v1.3.1 里「知道比赛已结束就直接按补题（`/problem/submit`）提交」的预判太激进。实际上 VJudge 赛后并不会一刀切关掉比赛通道：从比赛页点提交照样能交，服务端会把它记成这场比赛的练习提交（不算进榜单，但挂在比赛下）。结果插件把本可以挂在比赛下的提交，全丢到练习去了。
- **现在**：只要有 `contestId` + 题号就先走比赛通道；只有服务端明确回「比赛已经结束 / 通道关闭」（`contest_ended` 或 400 提示）时才自动退回 `/problem/submit` 重试，并提示你换了通道。
- 面板措辞跟着改：赛后面板按钮仍是「提交到比赛 X」，说明里写「提交会记在这场比赛下（练习模式），不计入榜单」，不再显示成「补题提交」。
- 赛后提交不再触发榜单刷新（榜单已封存，刷了也白刷）。
- 测试：`submit-flow-check` [5b]、`contest-panel-check` [6] 改成「赛后仍走比赛通道」；[7] 继续覆盖「被服务端拒绝 → 自动改补题」。

## 1.3.3

### 修复：交上去的是 base64 乱码，判题机直接 CE

- **原因**：`source` 字段被错误地写成了 `base64(encodeURIComponent(代码))`（早期按老博客的说法实现）。VJudge 后端根本不解码，判题机拿到的就是一串 base64 文本，于是 `program.cpp:1:1: error: stray '@' in program`，代码长度也变成编码后的长度。
- **现在**：`source` 直接放代码原文。翻 VJudge 前端 bundle（`#submit-form` 的提交处理）确认了这一点：`n.data.source = $("#submit-solution").val()`，也就是 CodeMirror 编辑器里的内容，URL 编码由表单序列化完成。
- 顺手对齐了网页端的字段：比赛提交带 `accessCode`（比赛密码）和 `version`（题目版本）；提交前先拦掉半个 UTF-16 代理对和不可见控制字符（网页端同样会校验 `source_illegal_characters` / `source_not_text`），省得白交一发。
- 测试：`submit-check` 第 3 节改成验证「表单里的 source 就是原文」+「表单编码 → 解码无损」（含中文、换行、`+&=`、emoji）。

## 1.3.2

### 修复：Codeforces 之类的题报 `submit.error.submit_method.not_allowed`

- **原因**：VJudge 的提交方式有三种，题目页 `dataJson.submitMethods` 是个三元素布尔数组 `[默认账号, 自己的账号, 存档]`。Codeforces 的题几乎都是 `[false, true, true]`——**不允许 VJudge 用默认账号代交源码**，必须用「你在 Codeforces 上绑定的账号」交（`method=1` + `bindingId`）。插件之前一律发 `method=0`，于是被服务端拒掉。
- **现在**：提交前先读题目的 `submitMethods`。
  - 允许默认账号 → 和以前一样一键交；
  - 只允许自己的账号 → 自动用你在该 OJ 上绑定的账号交（README 里说清了怎么绑）；题面面板会多一个「提交方式：用你自己的账号（VJudge 不代交这道题）」的标签；
  - 多个绑定时弹一次账号选择，并按 OJ 记住你上次用的那个；
  - 一个能用的都没有（没绑 / 凭据过期）→ 直接弹提示，一键跳到 VJudge 的账号绑定页，而不是发一条注定失败的提交。
- 读不到 `submitMethods`（老数据 / 题目被隐藏）时仍先按默认账号试；服务端一旦回 `submit_method.not_allowed`，自动换成自己的账号再交一次。
- 报错文案补了中文：`submit_method.not_allowed` / `submit_method.not_found`。

### 其它

- 新增 `client.fetchRemoteAccounts(oj)`：`GET /user/remoteAccounts/list?oj=xxx`，真实响应是 `{groups: {CodeForces: {bindings: [...]}}}`，只有 `runtimeStatus === 'READY'` 且非 `INCOMPLETE` 的绑定才可用。
- 测试：`submit-check` 加 4.5 节（解析账号绑定，不联网）+ 提交方式单测；`submit-flow-check` 加 Codeforces 两例（自动用 own account、没有可用绑定时不发提交）。

## 1.3.1

### 修复：比赛结束后没法交题（补题走不通）

- **原因**：VJudge 在比赛一结束就关掉 `/contest/submit/{比赛}/{题号}`，再交会被服务端回 `submit.error.contest_ended`；补题其实要走练习通道 `/problem/submit/{题号}`（网页也是这么做的）。插件之前只会往比赛接口交，所以只能把「比赛已经结束，不能提交」原样甩出来。
- **现在**：知道比赛结束时间时直接按补题走——题面面板的按钮变成「补题提交」，旁边写明「比赛已结束：提交走补题通道，不计入榜单」；提交成功后不再去刷新榜单（反正不会进榜）。
- 结束时间未知时（旧版本存下来的题目、从别处打开的比赛题）仍然先按比赛提交；服务端一旦回「比赛已结束」，插件自动用练习通道重试一次，并把这次提交标记为补题，不用你手动再来一遍。
- 比赛面板的题目列表下方，比赛结束后改成提示「点题号进去还能继续补题」；进行中的提示保持原样。

### 其它

- `test/contest-panel-check.js` 增加两组用例：比赛结束后点题 → 按钮变补题、提交不带比赛上下文；结束时间未知时服务端拒绝 → 自动重试成练习提交。

## 1.3.0

### 修复：明明面板里有题，提交却让你输入题号

- **原因**：提交目标只记在一个内存变量里（`lastOpened`）。它有两个问题——扩展宿主重启 / 装新版重载窗口后是空的；打开比赛、文章、团队面板都会把它覆盖掉。这时按 `Ctrl+Alt+Enter` 就没有目标，只能退回到「请输入题号」的空白输入框。
- **现在**：当前题目单独记录，并持久化到 `globalState`（连比赛上下文一起存），重开窗口仍然有效；打开别的面板不会再把「我要交哪道题」冲掉。
- 确实没有目标时，弹的是**选题目列表**：从文件名推断（`2275D.cpp` → `-2275D`）、当前题目、最近打开的题目、最后才是手动输入题号/链接。
- 新增命令 `VJudge: 提交到指定题目…`，用来交手边没打开的题。

### 新增：比赛面板里的实时榜单

- 比赛面板直接带榜单：名次 / 参赛者 / 过题数 / 罚时 / 每题的通过时间与罚次，默认每 5 秒自动刷新，只替换表格本身（滚动位置、展开状态都不丢）。
- 自己那一行高亮并显示「你当前第 N 名」（需要能读到 `/user/` 里的用户 ID，读不到就只是不高亮）。
- 封榜（freeze）按 VJudge 规则处理：封榜后的提交显示为「未通过」，顶部提示解冻时间；支持 partialScore 赛制按分数排名。
- 面板里有每秒本地走的比赛倒计时；比赛结束后刷新自动降到 60 秒一次；面板切到后台时不发请求。
- 新增设置 `vjudgeHelper.standingsInterval`（默认 5 秒，0 = 关闭）。
- 数据来自 `GET /contest/rank/single/{比赛ID}`（网页前端也是每 5 秒拉这个），名次在本地按比赛 `dataJson` 的 `penalty` / `sumTime` / `partialScore` / `weight` 计算。

### 改进：比赛里的题就按比赛题对待

- 从比赛面板或比赛题目链接（`/contest/863093#problem/D`）进入的题目，面板会标出「比赛 #863093 · D 题」，提交按钮变成「提交到比赛 D」，并多一个「返回比赛」按钮。
- 提交走 `/contest/submit/{比赛}/{题号}`（题号统一转成大写字母），交完顺手刷新一次比赛榜单，不用等下一个刷新周期。
- 以前从比赛题目链接打开会丢掉比赛上下文、当成练习提交，已修复。

### 其它

- 新增测试：`npm run test:standings`（榜单算法：罚时/封榜/部分分/高亮）、`npm run test:contest`（比赛面板 → 点题 → 提交全流程），`npm run test:flow` 也补了「不再问题号」「比赛上下文持久化」的用例。
- 榜单样式沿用 VS Code 主题变量，亮色/暗色都不串色。

## 1.2.0

### 新增

- **一键提交本地代码**：不用再复制粘贴到网页提交框。
  - 命令 `VJudge: 提交当前文件代码`（`Ctrl+Alt+Enter` / macOS `Cmd+Alt+Enter`），题面面板右上角的第一个按钮也是它
  - 读取**当前编辑器里的内容**（含未保存的修改），按文件类型自动匹配语言：`.cpp` → C++17，`.py` → Python 3（避开 2.7），`.java` → Java…
  - **记住上次用过的语言**（按 OJ 存），同类型文件之后按一次快捷键就直接提交，不再弹选择框；想每次确认可以打开 `vjudgeHelper.submitConfirm`
  - 从比赛面板点进去的题目会带上比赛上下文，提交走 `/contest/submit/{比赛ID}/{题号}`，排行榜里能正常记录；练习模式走 `/problem/submit/{题号}`
  - 提交后状态栏实时显示判题进度，出结果弹通知（`Accepted · 15 ms · 512 kB`）并可直接打开提交记录；另有 `VJudge: 打开最近一次提交`
  - VJudge 的 `{"error":{"i18nKey":"submit.error.xxx"}}` 会翻成中文（未登录 / 找不到题目 / 比赛未开始 / 已结束 / 语言不可用 / 要求验证码 / 提交太频繁…）
  - 面板上原来的「去提交」（跳浏览器）换成了「提交代码」，需要网页提交时点「浏览器打开」即可

### 说明

- 提交接口和网页提交弹窗完全一致：`POST /problem/submit/{key}`、`POST /contest/submit/{id}/{num}`，表单 `method=0&language=&open=&source=...&captcha=&password=`（`source` 当时错误地做了 base64，1.3.3 已改回原文）
- 语言列表优先读题目页 `dataJson`，拿不到时退回 `/util/cfg` 的 `remoteOJs[<OJ>].languages`；两者都没有时让你手填一次语言 ID 并记住
- 新增设置：`vjudgeHelper.submitOpen`（公开源码）、`vjudgeHelper.submitConfirm`（提交前确认）、`vjudgeHelper.judgeTimeout`（等待评测的秒数）
- 新增自检：`node test/submit-flow-check.js`（打桩演练全流程，不联网）、`node test/submit-check.js`（逻辑自检 + 匿名接口探测，带 `VJ_COOKIE` 可真实提交一次）

## 1.1.5

### 修复

- **公式变成红色的 `\(n ≤ 200000\)`**：Codeforces 系题面用的是 `$$$n$$$` 三个美元，上一版先按 `$$...$$` 替换再处理单 `$`，`$$$n$$$` 会被吃掉一层变成 `\(\(n\)\)`。MathJax 匹配外层后，里面的 `\(` 被当成未知命令渲染成红色字面量。现在改成「最长定界符优先」一次扫描：
  - `$$$$$$x$$$$$$`（CF 块级）→ `\[x\]`
  - `$$$x$$$`（CF 行内）→ `\(x\)`
  - `$$x$$` → 短的行内 / 长或跨行的 `\[x\]`
  - `$x$` → `\(x\)`
  - 已经是 `\(x\)` 的不再重复包一层（这条就是红的根源）
- **面板标题被按钮压住**：题名很长时（如 `CodeForces-1526C2 · Potions (Hard Version) - CodeForces-1526C2`）会和右上角按钮重叠，现在标题栏和按钮改成同一行 flex，标题自动让位换行；标题尾部重复的题号也会去掉
- **样例区样式**：VJudge 的样例是 `<table class="vjudge_sample">`，之前完全没样式，Input/Output 单元格被 `pre` 的内边距撑成两个空心大盒子；现在表格紧凑、单元格内的 `pre` 不再重复套盒子
- `<pre>` / `<code>` 里的 `$`（样例输入输出）不再被当成公式

## 1.1.4

### 修复

- **`$$n$$` 这类公式原样漏出来**：上一版只对「题面正文接口」做了 `$` 转换，但有些题（尤其用户贡献的中文翻译）走的是 `dataJson` 里的 HTML，完全没经过转换；而 MathJax 又只认 `\(`。现在把公式规范化提到 `fetchProblem` 的出口，**所有来源**的题面统一处理：
  - `$$n$$`（夹在文字里、内容短）→ `\(n\)`
  - `$$...$$`（独占一段 / 跨行 / `\begin{cases}`）→ `\[...\]`
  - `$n$` → `\(n\)`
  - 中文里的 `$5 和 $10` 这种不配对的不动
- 面板加了公式自检：渲染 5 秒后如果全是 `\(` 却没有任何 `mjx-container`，会弹提示区分「MathJax 没加载」和「加载了但没识别到公式」

## 1.1.3

### 修复

- **公式把正文吞掉**：题面里如果出现不成对的 `$`，MathJax 用 `$...$` 配对会从那个 `$` 一路吃到下一个 `$`，把中间的正常文字变成数学模式（表现就是文字粘连、变斜体）。现在 MathJax 只用 `\(...\)` / `\[...\]`，插件在渲染前把 `$...$` 规范成 `\(...\)`，不成对的 `$` 原样保留
- **题面格式没识别 `MD`**：VJudge 的 `format` 实际取值是 `HTML` / `MD`，之前只认 `Markdown`，导致 MD 题面被当成 HTML 直接塞进去（`$n$`、`_i_` 全都裸露）
- **题面图片 / 公式图片全挂**：CDN 地址改为从 `GET /util/cfg` 读取（当前是 `https://cdn.vjudge.net.cn/`），不再用旧的 `vj.csgrandeur.cn`
- MathJax 换成多源依次回退：jsDelivr → 360 前端库 → cdnjs，国内网络下不至于直接白给

### 新增

- **题面版本 / 翻译切换**：题目有多个版本时（官方英文 + 各语言翻译 + 用户贡献），面板上出现「切换题面（N）」按钮，可以下拉选择，切换后立即重新渲染
- 题面顶部显示当前题面的语言（如「题面语言 English」）

## 1.1.2

### 修复

- **题面正文拿不到**：新版 VJudge 的题面不再放在题目页的 `dataJson` 里，而是独立接口 `GET /problem/description/{descKey}?{version}`。插件现在会先从 `dataJson.descBriefs`（或页面 `#prob-descs li[data-key]`）里找题面版本，再取正文，按 `sections` 拼成带小标题的完整题面。该接口**不需要登录**也能读
- 题面里的图片占位 `CDN_BASE_URL/` 会替换成站点 CDN（可由 `vjudgeHelper.cdnBaseUrl` 覆盖）
- 空题面的提示区分「没登录」和「页面读到了但没题面」，诊断信息里加了找到的题面版本数量

## 1.1.1

### 修复

- **比赛题目列表拿不到**：改从比赛页 `dataJson.problems` 读取（新版 VJudge 前端就是这么渲染的），老的 `/contest/filterProblem` 只作为兜底。公开比赛现在**不登录也能看到完整题目列表**
- 题目行现在显示 `OJ-题号`、标题、时限 / 内存，点一下直接开题面
- 私有 / 需要密码 / 未开始的比赛不再只给一句「暂不可见」，而是按原因给出可操作提示，并提供「登录 VJudge」按钮
- 比赛面板新增「比赛类型（公开 / 需要密码 / 私有）」与「当前权限」两栏，方便判断凭据是否生效
- 标题里的 HTML 实体（`&#39;` 等）现在会正确还原

## 1.1.0

### 新增

- **团队（Group）支持**：`VJudge: 打开团队…`（链接 / 短名 / 团队名称）、`VJudge: 搜索团队…`（关键词搜索后选择）
- 侧边栏新增「我的团队」与「发现团队」，显示成员数、比赛数、角色与待审申请
- 团队面板：简介（Markdown）、成员与角色、团队比赛（可点击直接开比赛面板）、团队文章（可点击直接看文章）
- 团队短名自动解析：数字团队 ID 或团队名称会自动通过团队列表 / 搜索换成 shortName
- 面板内链接支持 `vjudge-contest:` / `vjudge-article:` / `vjudge-group:` 协议，正文里的比赛、文章、团队都能点开

### 改进

- 发布准备：新增 128×128 图标、`npm run publisher` / `npm run publish` 脚本与 `MARKETPLACE.md` 发布指南

## 1.0.0

首个版本。

### 新增

- 题面面板：解析 VJudge 的 `dataJson`，在编辑器内渲染题面，支持 MathJax、代码块、表格、图片
- 多入口开题：命令面板输入、剪贴板识别、编辑器选中文本（`Ctrl+Alt+V`）、比赛内题目链接
- 原生 OJ 链接自动转换：Codeforces / AtCoder / 洛谷 / POJ / HDU / CodeChef / SPOJ / NowCoder
- 文章面板：Markdown 渲染，`[problem:xxx]` 转为可点击题目链接，题单文章列出题目清单
- 比赛面板：时间、状态、题目列表
- 侧边栏：进行中/即将开始、最近的比赛、收藏、最近浏览、快捷操作
- 登录：用户名密码（SecretStorage）或手动粘贴 Cookie，支持登录态校验
- 收藏与浏览历史、状态栏入口
- 不依赖网络的纯逻辑测试脚本与假 vscode 环境的激活测试脚本
