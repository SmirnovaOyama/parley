# Parley

[English](README.md)

一个可以自己部署的 AI 聊天网站，适合团队、班级或家人一起用。管理员填入 Claude、OpenAI、Gemini、Grok、DeepSeek 或任何兼容 OpenAI 聊天格式的服务的 API key，决定谁能用哪些模型、每月能花多少；其他人登录后直接聊天。API key 只存在服务器上，不会发到浏览器。

前端用 Vite + React，后端用 Node 上的 Hono，数据存在 SQLite（Node 自带的 `node:sqlite`）里。一个进程，一个数据文件夹。

## 能做什么

**聊天的人**
- 在管理员开放的模型里选模型和思考强度，每个聊天单独设置。
- 上传图片、PDF 和文本文件。每个模型能读什么就读什么，读不了时输入框下方会提示。
- 对公开推理过程的模型，回复上方可以展开看它的思考。
- 管理员开启后，Claude 和 OpenAI 的模型可以联网搜索并标出来源，也可以运行代码生成文件供下载。
- 编辑已发的消息或重新生成回复，之前的版本不会丢。
- 给所有聊天或单个聊天设置说明（关于你、希望怎么回答）。
- 分享聊天的只读链接。

**管理员**
- API key：加密保存，保存前会先向提供商验证；可以设备用 key，主 key 出错时自动顶上。
- 用户：谁能用哪些 key，每月的 token 和花费上限，账号启用或停用。
- 所有聊天：只读、可搜索。所有人都会被告知管理员能看聊天，管理员每次查看都有记录。
- 集中查看 AI 拒绝回答的消息。
- 按人、按 key、按天统计用量和估算费用。
- 站点设置：系统提示词、开放注册、分享方式，以及可选的邮箱奖励（用指定域名邮箱验证的人，比如学校邮箱，可以多得额度）。

## 支持的 AI 提供商

| 提供商 | 模型 | 能读的文件 | 其他 |
|---|---|---|---|
| Claude | Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 | 图片、PDF、文本 | 联网搜索、生成文件、提示词缓存、拒绝时自动换模型 |
| OpenAI | GPT-6.1 Sol、GPT-6 Luna、GPT-6 Astra | 图片、PDF、文本 | 联网搜索、生成文件、推理摘要 |
| DeepSeek | Flash、V4 Pro | 文本 | |
| Gemini | 3.8 Flash、3.1 Pro、3.5 Flash-Lite | 图片、文本 | |
| Grok | 4.7、4.3 | 图片（JPEG、PNG）、文本 | 4.7 有推理摘要 |
| 其他服务 | 你填写的任意模型名 | 文本，开启后也能读图片 | 预设了 OpenRouter、Groq、Mistral、通义千问、Kimi、GLM 和 Ollama，千问、Kimi、GLM 都有国内地址 |

费用估算用的价格在 [`server/providers/catalog.ts`](server/providers/catalog.ts)。其他服务可以在 key 上填价格，不填就按免费计算。

## 运行

### 用 Docker

```bash
git clone https://github.com/SmirnovaOyama/parley.git && cd parley
cp .env.example .env
```

在 `.env` 里把 `KEY_ENCRYPTION_SECRET` 设成至少 32 个字符的随机字符串（比如 `openssl rand -base64 48` 的输出），然后：

```bash
docker compose up -d
```

打开 http://localhost:8787。**第一个注册的账号会成为管理员**，所以部署好请马上注册，然后去「Admin → API keys」添加 key。

Parley 保存的所有东西（数据库、上传的文件、AI 生成的文件）都在 `parley-data` 这个数据卷里。

### 用 Node

需要 Node 24 或更新版本。

```bash
npm install
npm run setup
npm run dev
```

`npm run setup` 会在 `.env` 里写一个随机的 `KEY_ENCRYPTION_SECRET`。然后打开 http://localhost:5173。

不用 Docker 的正式部署：

```bash
npm run build
npm start
```

API（端口 8787）会同时提供 `dist/` 里构建好的网页。

## 配置

写在 `.env` 里（参考 [`.env.example`](.env.example)）：

| 配置 | 作用 |
|---|---|
| `KEY_ENCRYPTION_SECRET` | 必填。用来加密数据库里的 API key。请妥善保管，设定后不要再改，否则已保存的 key 无法解密。 |
| `VITE_APP_NAME` | 网站名称，显示在侧边栏和浏览器标签上。Docker 部署时它会编译进网页，改了要重新构建。 |
| `DATABASE_PATH` | SQLite 数据库的位置（默认 `data/chat.db`），文件存在它旁边。 |
| `PORT` | API 端口（默认 8787）。 |
| `SMTP_URL`、`MAIL_FROM` | 发信设置，邮箱奖励功能要用。 |

## 正式使用时

- **HTTPS**：请放在 HTTPS 后面。正式环境的登录 cookie 带 `Secure` 标记，只有 HTTPS（或 localhost）下才能登录。用 [Caddy](https://caddyserver.com) 只要两行：

  ```
  chat.example.com {
    reverse_proxy localhost:8787
  }
  ```
- **备份**：备份数据文件夹或数据卷，并把 `KEY_ENCRYPTION_SECRET` 一起保存好。没有这个密钥，备份里的 key 谁也解不开。运行中要复制数据库，可以用 `sqlite3 chat.db ".backup backup.db"`。
- **升级**：`git pull` 后运行 `docker compose up -d --build`（或 `npm install && npm run build` 再重启）。数据库会在启动时自动升级。

## 安全说明

- 第一个注册的账号会成为管理员。部署后马上注册；不想让陌生人加入的话，在「Admin → Settings」里关闭注册。
- 管理员可以给「其他服务」的 key 填任意地址，服务器会去连接它。只把你信任的人设为管理员。
- 管理员能看所有聊天，Parley 会在输入框下方告诉每个用户。
- 发现安全漏洞，请看 [SECURITY.md](SECURITY.md)。

## 开发

项目结构和技术细节见[英文 README](README.md#how-it-works)。`npm run typecheck` 会同时检查前端和后端，`npm test` 运行测试（不联网，也不需要 API 密钥）。参与开发请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[GNU Affero 通用公共许可证 v3.0](LICENSE)。你可以自由使用、修改和分享 Parley；如果把修改过的版本作为服务提供给别人，也要向他们提供修改后的源代码。
