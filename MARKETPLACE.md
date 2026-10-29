# 发布到 VS Code Marketplace

整个流程只做一次，之后每次更新只要一条命令。下面每一步都可以在 Windows 上完成。

---

## 0. 需要准备的东西

| 东西 | 作用 | 地址 |
| --- | --- | --- |
| Microsoft 账号 | 登录发布后台 | 任意 outlook/hotmail 账号即可 |
| Publisher ID | 扩展的「作者标识」，形如 `your-name` | https://marketplace.visualstudio.com/manage |
| Personal Access Token (PAT) | 发布时的凭证 | https://dev.azure.com → User settings → Personal access tokens |
| GitHub 仓库（可选） | Marketplace 页面的仓库链接、issue 入口 | 建议建，代码托管也方便 |

> Publisher ID 决定了扩展的唯一标识：`<publisher>.<name>`，本插件是 `vjudge-helper`，所以最终 itemName 是
> `<你的 publisher>.vjudge-helper`，装完之后别人搜到的也就是这个名字。

---

## 1. 创建 Publisher

1. 打开 https://marketplace.visualstudio.com/manage
2. 用 Microsoft 账号登录 → **Create publisher**
3. 填：
   - **ID**：只能字母/数字/连字符，例如 `ylxxl402`（发布后**不能改**）
   - **Name**：显示名，可以随时改
4. 记下这个 ID

## 2. 创建 PAT

1. 打开 https://dev.azure.com ，登录同一个账号（没有组织就随便建一个）
2. 右上角头像 → **User settings** → **Personal access tokens** → **New Token**
3. 设置：
   - **Scopes**：不要选 Full access，选 **Custom defined** → 勾 **Marketplace → Manage**
   - **Expiration**：90 天（到期重新生成即可）
4. 生成后**立刻复制** token（只显示一次）

## 3. 把 publisher 写进项目

```bash
cd ~/Desktop/vjudge-helper

# 只改 publisher
npm run publisher -- ylxxl402

# 同时补上 GitHub 仓库（README 里的链接、Marketplace 的 Repository 卡片都靠它）
npm run publisher -- ylxxl402 https://github.com/ylxxl402/vjudge-helper
```

脚本会改写 `package.json` 的 `publisher` / `repository` / `homepage` / `bugs` 字段。

---

## 4. 本地预检

```bash
npm run check      # 语法检查
npm run package    # 打包成 vsix，确认没有报错
npx --yes @vscode/vsce ls --no-dependencies   # 看最终会传哪些文件
```

`vsce ls` 里**不应该**出现 `test/`、`scripts/`、`.vscode/`、`*.vsix`（已在 `.vscodeignore` 排除）。
必须出现 `extension.js`、`src/`、`media/`、`README.md`、`CHANGELOG.md`、`LICENSE`、`media/icon.png`。

## 5. 发布

```bash
# 方式一：环境变量（推荐，token 不会留在命令历史里）
VSCE_PAT=你的token npm run publish

# 方式二：直接传参
npm run publish -- --pat 你的token

# 第一次发版之后就顺手升版本
npm run publish -- patch          # 1.1.0 -> 1.1.1
npm run publish -- minor          # 1.1.0 -> 1.2.0
```

发布成功后脚本会打印扩展主页和管理页地址：

```
✓ 发布成功
  扩展主页: https://marketplace.visualstudio.com/items?itemName=ylxxl402.vjudge-helper
  管理页面: https://marketplace.visualstudio.com/manage/publishers/ylxxl402
```

新扩展一般 5~10 分钟后才能在 Marketplace 搜到，用扩展主页链接可以立刻访问。
别人安装：

```
ext install ylxxl402.vjudge-helper
```

或者 VS Code 扩展面板搜 **VJudge Helper**。

---

## 6. 日常更新节奏

```bash
# 1. 改代码
npm run check && npm run live        # 自检 + 联网联调

# 2. 更新 CHANGELOG.md 和 README（Marketplace 页面直接读 README）

# 3. 升版本并发布
npm run publish -- patch
```

不想发到商店、只想给自己装时用 `npm run package`，然后
`code --install-extension vjudge-helper-x.y.z.vsix --force`。

---

## 7. 常见报错

| 报错 | 原因 | 解决 |
| --- | --- | --- |
| `ERROR The Personal Access Token verification has failed` | PAT 过期或权限不对 | 重新生成，Scope 只勾 **Marketplace → Manage**（不是 Code） |
| `ERROR Access Denied: The requested publisher does not exist` | `package.json` 的 `publisher` 在商店不存在 | `npm run publisher -- <你在 manage 页面看到的 ID>` |
| `ERROR Version 1.1.0 already exists` | 版本号重复 | `npm run publish -- patch` |
| `WARNING repository field is missing` | 没填仓库 | `npm run publisher -- <id> <repo-url>`，脚本会自动加 `--allow-missing-repository` 兜底 |
| `ERROR Extension entrypoint(s) missing` | 打包时漏了文件 | 检查 `.vscodeignore`，确保没有 `**` 之类误伤 `src/` |
| `ERROR Make sure to edit the README.md file before you publish` | README 还是模板 | 本仓库 README 已写好，不会触发 |
| 图标不显示 | 不是 PNG / 尺寸太小 | `npm run icon` 重新生成 128×128 PNG（需要 `pip install pillow`） |
| 上传卡住 / 超时 | 网络到 marketplace 不稳定 | 重试；或 `vsce publish --packagePath xxx.vsix` |

---

## 8. 下架 / 删除

```bash
npx --yes @vscode/vsce unpublish <publisher>.vjudge-helper
```

也可以直接在 https://marketplace.visualstudio.com/manage 里把扩展 **Unpublish**（保留数据）或 **Delete**。

---

## 9. 发布前检查清单

- [ ] `npm run publisher -- <id>` 已执行，`package.json` 的 publisher 是自己的
- [ ] `README.md` 里没有写死的临时路径 / 个人隐私信息
- [ ] `CHANGELOG.md` 有当前版本的条目（Marketplace 的 Changelog 标签页会显示）
- [ ] `media/icon.png` 是 128×128 以上 PNG
- [ ] `npm run check`、`npm run live` 通过
- [ ] 提交功能没坏：`npm run test:flow`（不联网）通过；`npm run test:submit` 的匿名探测部分通过
- [ ] 榜单/比赛面板没坏：`npm run test:standings`、`npm run test:contest` 通过
- [ ] PAT 没被提交到任何文件里（`.gitignore` 已忽略 `.env`）
