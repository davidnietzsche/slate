# Storyboard · 内容看板

把每一支片从「点子」一路管到「已发布」的看板：脚本卡、阶段、发布日历、备注、提词器，一个网址打开。
A content-pipeline board: script cards, stages, a publish calendar, notes and a teleprompter, on one free Cloudflare Worker.

这是 Learn AI · Claude 内容课用的看板结构（不含任何人的内容）。This is the board structure used in the Learn AI course, with sample cards only.

## 结构 Structure

```
slate/
├─ studio.json        设定：工作区名字、网址、登入方式 settings
├─ scripts/           一张卡 = 一个 .md 文件 one card per file (看板 board)
├─ playbook/          侧边栏的方法页 sidebar guide pages
├─ workspaces/<ws>/   更多工作区（studio.json "verticals"） more workspaces
├─ src/
│  ├─ worker.js       网址、登入、看板状态（Durable Object） routing, login, board state
│  ├─ app.html        看板画面 the board UI
│  ├─ gate.html       通行码页 pass-code page
│  └─ login.html      邮箱登入页 email-login page
├─ local.mjs          在自己电脑跑看板（不用 Cloudflare） run the board locally
├─ deploy.mjs         打包 + 上传到 Cloudflare build + upload
└─ API.md             给 AI 用的 API the API for your AI terminal
```

网址 URLs: `/<workspace>/<project>` 看板 · `/scripts` 全部脚本 · `/calendar` 发布日历 · `/reports` 报告 · `/<name>` 一张卡

## 卡的格式 Card format

- 第一行 `# 标题`。想让新卡从别的阶段开始，加一行 `<!-- stage: idea -->`（idea / writing / ready …）。文件名 `2026-11-24-my-video.md` → 网址 `/my-video`（日期只用来排序）。
- 脚本表格有「口播」（或 Voice / Voiceover / VO）这一栏 → 卡多一个提词器分页；可加「画面」（Picture）、「时间」（Time）。
- 常用段落：`## 参考视频` · `## 开头（hook 卡）` · `## 脚本` · `## 文案`。看 `scripts/` 里的示范卡。
- 阶段 stages: 点子 idea → 写稿中 writing → 可以录 ready → 审过 reviewed → 录好 filmed → 剪好 edited → 已发布 posted（丢掉 binned）。阶段、日期、备注存在 Cloudflare，改文件名也不会丢。

## 最简单：在你自己的电脑上跑（不用 Cloudflare、不用帐号）Easiest: on your own computer

```
git clone https://github.com/davidnietzsche/slate.git ~/slate
cd ~/slate && node local.mjs
```

浏览器会打开看板（http://localhost:4321），**已经帮你登入，不用打通行码**。换一个浏览器才需要码：`open ~/slate/key.txt`（Windows：`notepad %USERPROFILE%\slate\key.txt`）。阶段、日期、备注存在 `~/slate/.slate-local.json`。
新增或改了卡（`scripts/*.md`），关掉再跑一次 `node local.mjs`。只要 Node 18+，什么都不用注册。
It opens the board at http://localhost:4321 already signed in; the pass code (for another browser) is in `key.txt`; stages, dates and notes live in `.slate-local.json`.

或者把这段贴给 Claude Code / Or paste this to Claude Code:

```
帮我把 https://github.com/davidnietzsche/slate 装在我的电脑：clone 到 ~/slate，studio.json 的 workspaceName 改成我的名字，
跑 node local.mjs 打开看板（它会自动登入）。以后我说「打开看板」，你就在 ~/slate 跑 node local.mjs。
```

**备注（留言区）怎么用**：点一张卡，右边「备注」写你要改的地方（例如「开头太慢，第一句直接讲结果」），会显示「待处理」。
然后跟 Claude 说「看看板的备注，照着改」：它用 API 读 `GET /notes`，改好稿，再标「已解决」，变化会出现在右上角的铃铛。
Notes: write what to change in a card's 备注 box; tell Claude "read the board notes and fix them"; it reads `GET /notes`, edits, and resolves.

**本机的 API**：Base `http://localhost:4321/api/ws/<workspace>`，token 一样是 `.slate-secrets.json` 的 `ADMIN_TOKEN`（看 [API.md](API.md)）。
只有你这台电脑开得到；想用手机看、或给团队看，再照下面放上 Cloudflare。

## 放上网（Cloudflare，免费，约 10 分钟）Put it online


最简单：把下面这段贴给你的 Claude Code，它会一步一步带你做。
Easiest: paste this to Claude Code.

```
帮我把 https://github.com/davidnietzsche/slate 装起来：clone 到 ~/slate，改 studio.json 的 workspace / workspaceName 成我的名字，
带我开一个免费 Cloudflare 账号和一个 "Edit Cloudflare Workers" API token（让我自己贴到 terminal，不要印出来），
然后用 CLOUDFLARE_API_TOKEN 跑 node deploy.mjs，最后告诉我看板网址和 key.txt 里的通行码在哪里（不要印出通行码）。
```

自己做 By hand:

1. 需要 Node 18+ 和一个免费 Cloudflare 账号。Node 18+ and a free Cloudflare account.
2. Cloudflare → My Profile → API Tokens → Create Token → 「Edit Cloudflare Workers」。
3. 改 `studio.json`：`workspace`、`workspaceName`、`me`（你的名字，显示在备注历史）。
4. `CLOUDFLARE_API_TOKEN=<token> node deploy.mjs` → 印出看板网址。第一次会做 `key.txt`（通行码）和 `.slate-secrets.json`，两个都不会进 git。
5. 打开网址，输入 `key.txt` 里的通行码。之后改了卡，再跑一次 `node deploy.mjs`。

只想先看看 Just build, no upload: `node deploy.mjs --dry build`

## 进阶 More

- 自己的网域 Custom domain: `studio.json` `"domain": "board.yourdomain.com"`（网域要在同一个 Cloudflare 账号）。
- 团队邮箱登入 Email login for a team: `"auth": "otp"`, `"owners": ["you@…"]`, `"mailFrom": "Storyboard <login@yourdomain.com>"`, 加上 `RESEND_API_KEY`（resend.com）。成员可以是 owner / editor / viewer。
- 多个账号 More workspaces: `"verticals": [{ "workspace": "brand2", "name": "第二个账号", "api": true }]` → 卡放 `workspaces/brand2/scripts/`。
- 让 AI 直接写卡 Let your AI write cards: 看 [API.md](API.md)。

## 安全 Safety

`key.txt` 和 `.slate-secrets.json` 是你的钥匙：不要 commit、不要贴给别人。换掉通行码 = 改 `key.txt` 再 deploy；删掉 `.slate-secrets.json` 再 deploy = 所有人登出、旧 API token 失效。
