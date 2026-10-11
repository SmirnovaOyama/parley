# 在 Cloudflare 上运行 Parley

[English](README.md)

Parley 可以完全跑在 Cloudflare 上，不需要自己的服务器：你域名上的一个 Worker 把所有请求交给一个 [Cloudflare Container](https://developers.cloudflare.com/containers/)，容器里运行的就是 Parley 平常的 Docker 镜像。需要 Workers Paid 套餐。

容器每次启动时磁盘都是空的，所以 Parley 的数据放在两个 R2 存储桶里：

- **数据库**：由 [Litestream](https://litestream.io) 在每次变化后复制到 `parley-db`，最多落后 10 秒；容器启动时再复制回来。
- **文件**（上传的文件、回复生成的文件、知识库文档）：放在 `parley-files` 里，用 [tigrisfs](https://github.com/tigrisdata/tigrisfs) 挂载到 Parley 存文件的位置。

容器运行在北美西部，Claude 和 OpenAI 在那里接受请求。一小时没人访问它就会休眠，休眠时不收费；之后第一次访问要等几秒，等它启动。

## 费用

按 2026 年 10 月 [Cloudflare 的价格](https://developers.cloudflare.com/containers/pricing/) 粗略估算：

- Workers Paid：每月 5 美元。
- 容器（1 GiB 内存、4 GB 磁盘）按醒着的时间计费：一直醒着大约每月 7 美元，休眠得越多越便宜。CPU 只按实际用量计费，聊天网站用得很少。
- R2：存储 10 GB 以内、每月一百万次写入以内免费，一个团队或一个班用不完。

## 先了解这些

- 如果容器毫无预警地丢失（比如机器故障），最多会丢掉最后 10 秒的改动。正常停止（休眠、部署）时会先把所有内容复制完。
- 部署会替换容器，正在生成的回复会中断。请在网站没人用的时候部署。
- 所有人共用一个容器。一个团队、一个班或一家人绰绰有余，但撑不住成千上万人同时使用。
- 经过 Cloudflare 上传，Free 和 Pro 套餐最大 100 MB，更大的导出文件没法导入。可以改为导入压缩包里的 `conversations.json`。
- 这里讲的是搭一个新站点。想把已有的 Parley 数据库搬过来，请开一个 issue 问。

## 搭建步骤

你需要：一个已经在 Cloudflare 上的域名、Workers Paid 套餐，以及 Parley 在 GitHub 上的一份副本（fork 或你自己的仓库）。镜像由 GitHub Actions 构建，所以不需要 Docker。

### 1. 两个 R2 存储桶和访问它们的密钥

1. 在 Cloudflare 后台打开 **R2 Object Storage**，创建两个存储桶：`parley-db` 和 `parley-files`。位置保持自动即可。
2. 在 **R2 Object Storage** 里打开 **Manage API tokens**（API → Manage API tokens），创建一个权限为 **Object Read & Write** 的 API token，只授权给这两个存储桶。
3. 复制它的 **Access Key ID** 和 **Secret Access Key**。Secret 只显示一次。

### 2. 用于部署的 Cloudflare API token

1. 打开 **My Profile → API Tokens → Create Token**，从 **Edit Cloudflare Workers** 模板开始。
2. 添加 **Account → Containers → Edit**（如果列表里有 **Cloudchamber → Edit**，也加上）。
3. **Account Resources** 选你的账号，**Zone Resources** 选你的域名。
4. 创建并复制 token。以后部署时如果提示缺少某个权限，会写出权限的名字，编辑 token 加上就行。

你还需要 **Account ID**，在账号首页右侧和 **Workers & Pages** 里都能看到。

### 3. 加密 API key 用的密钥

在任意一台电脑上生成：

```bash
openssl rand -hex 32
```

把它保存在安全的地方，比如密码管理器。GitHub 不会再显示它；没有它，Parley 里保存的 API key 就无法解密。

### 4. 在 GitHub 里填写设置

在你的仓库里打开 **Settings → Secrets and variables → Actions**。

**Variables** 标签页：

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID |
| `PARLEY_DOMAIN` | 网站的地址，比如 `chat.example.com`。选一个没被占用的名字，部署时会自动创建。 |
| `VITE_APP_NAME` | 可选。网站名称（不设就叫 Parley）。 |
| `MAIL_FROM` | 可选。重设密码邮件的发件人，比如 `Chat <no-reply@example.com>`。 |

**Secrets** 标签页：

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步的 token |
| `KEY_ENCRYPTION_SECRET` | 第 3 步的密钥 |
| `R2_ACCESS_KEY_ID` | 第 1 步的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 第 1 步的 Secret Access Key |
| `SMTP_URL` | 可选。发重设密码邮件用的发信服务器，比如 `smtps://user:password@smtp.example.com:465`。 |

### 5. 部署

打开 **Actions → Deploy to Cloudflare → Run workflow**，选择要部署的分支或版本 tag。第一次要构建镜像，大约十分钟；之后会快一些。

### 6. 马上注册

打开 `https://` 加你的域名。第一次访问会唤醒容器，第一次会稍慢一点。**第一个注册的账号会成为管理员**，所以马上注册，然后去 Admin → API keys 添加 key。不想让陌生人加入的话，在 Admin → Settings 里关闭注册。

## 之后

- **升级**：在没人用的时候，用更新的分支或 tag 再运行一次 workflow。
- **查看运行情况**：**Workers & Pages → parley**。容器的输出在日志里，状态在 **Containers** 里。第一次注册后 10 秒内，`parley-db` 里会出现 `chat.db`。
- **备份**：R2 里存着数据库，Litestream 也保留了最近的历史，但它们仍然只是一份。想自己留一份的话，在电脑上装好 Litestream，在这个文件夹里填上第 1 步的 R2 密钥和你的 Account ID，运行：

  ```bash
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... R2_ACCOUNT_ID=... DB_BUCKET=parley-db litestream restore -config litestream.yml -o parley-backup.db /data/chat.db
  ```

  文件在 `parley-files` 里，任何 S3 工具都能复制。把 `KEY_ENCRYPTION_SECRET` 和备份放在一起保存。

## 出问题时

- **网站打不开，日志里说某项 "isn't set"**：第 4 步的某个 secret 或 variable 没填。补上后重新部署。
- **"The files bucket couldn't be mounted"**：检查存储桶名称，以及第 1 步的 R2 token 能不能读写这两个桶。
- **Claude 或 OpenAI 说你所在的地区不允许请求**：容器不在北美西部。检查 `wrangler.jsonc` 里的 `constraints`。
- **部署因为权限失败**：把提示里写的权限加到第 2 步的 token 上。

## 各部分怎么配合

- [`src/index.ts`](src/index.ts)：Worker，以及容器的设置（一小时后休眠、环境变量）。Worker 用 `X-Forwarded-For` 告诉 Parley 访问者的地址，并覆盖访问者自己发来的同名请求头；Parley 信任这个头（`TRUST_PROXY`）。
- [`wrangler.jsonc`](wrangler.jsonc)：容器的规格和地区，以及存储桶的名称。
- [`Dockerfile`](Dockerfile) 和 [`start.sh`](start.sh)：在 Parley 镜像上加了 Litestream 和 tigrisfs。启动时先挂载文件桶、恢复数据库，再由 Litestream 运行 Parley。收到停止信号时，Parley 先停，Litestream 做最后一次复制，然后卸载文件桶。
- [`litestream.yml`](litestream.yml)：数据库怎么复制，每 10 秒一次。
- [`../.github/workflows/cloudflare.yml`](../.github/workflows/cloudflare.yml)：部署流程。
