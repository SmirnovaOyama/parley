# Parley on Cloudflare

[中文](README.zh-CN.md)

Parley can run entirely on Cloudflare, with no server of your own: a Worker on your domain hands every request to one [Cloudflare Container](https://developers.cloudflare.com/containers/) running Parley's usual Docker image. It needs the Workers Paid plan.

A container's disk starts empty every time it starts, so Parley's data is kept in two R2 buckets:

- **The database** is copied to `parley-db` by [Litestream](https://litestream.io) as it changes, at most 10 seconds behind, and copied back when the container starts.
- **Files** (uploads, files replies made, knowledge documents) live in `parley-files`, mounted where Parley keeps them with [tigrisfs](https://github.com/tigrisdata/tigrisfs).

The container runs in Western North America, where Claude and OpenAI take requests. It goes to sleep after an hour without visitors, when it costs nothing, and the first visit after that waits a few seconds while it starts.

Scheduled tasks cannot wake a sleeping container and only run while it is awake
After a visitor wakes it, each task catches up at most one missed run
For tasks that must run at the selected time, use a server that stays online

## What it costs

Roughly, at [Cloudflare's prices](https://developers.cloudflare.com/containers/pricing/) in October 2026:

- Workers Paid: $5 a month.
- The container (1 GiB of memory, 4 GB of disk), billed while it's awake: about $7 a month awake around the clock, less the more it sleeps. CPU is billed only as it's used, and a chat site uses little.
- R2: free up to 10 GB stored and a million writes a month, which a team or class stays under.

## What to know first

- If the container is lost without warning (a machine failing), up to the last 10 seconds of changes can be lost. When it stops normally (going to sleep, a deploy), it copies everything first.
- A deploy replaces the container: replies being written stop. Deploy when the site is quiet.
- One container serves everyone. That's plenty for a team, a class or a family, not for thousands of people at once.
- Through Cloudflare, uploads can be up to 100 MB on the Free and Pro plans, so an export bigger than that can't be imported. Import the `conversations.json` inside it instead.
- This sets up a new site. To move an existing Parley database here, ask in an issue.

## Setting it up

You need a domain on Cloudflare, the Workers Paid plan, and a GitHub copy of Parley (a fork, or your own repository). The images are built by GitHub Actions, so you don't need Docker.

### 1. Two R2 buckets and a key for them

1. In the Cloudflare dashboard, open **R2 Object Storage** and create two buckets: `parley-db` and `parley-files`. Their location can stay automatic.
2. Under **R2 Object Storage**, open **Manage API tokens** (API, Manage API tokens) and create an API token with **Object Read & Write** permission, applied to those two buckets only.
3. Copy its **Access Key ID** and **Secret Access Key**. The secret is shown only once.

### 2. A Cloudflare API token for deploys

1. Open **My Profile**, **API Tokens**, **Create Token**, and start from the **Edit Cloudflare Workers** template.
2. Add **Account**, **Containers**, **Edit** (and **Cloudchamber**, **Edit** if it's listed).
3. Under **Account Resources** pick your account, and under **Zone Resources** your domain.
4. Create it and copy the token. If a deploy later says a permission is missing, it names it: edit the token and add it.

You'll also need your **Account ID**, shown on the right of your account's home page and in **Workers & Pages**.

### 3. The secret that encrypts API keys

Make one on any computer:

```bash
openssl rand -hex 32
```

Keep a copy somewhere safe, like a password manager. GitHub won't show it again, and without it the API keys saved in Parley can't be read.

### 4. Settings in GitHub

In your repository, open **Settings**, **Secrets and variables**, **Actions**.

On the **Variables** tab:

| Name | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID |
| `PARLEY_DOMAIN` | The address for the site, like `chat.example.com`. Pick a name nothing else uses: the deploy creates it. |
| `VITE_APP_NAME` | Optional. The site's name (Parley AI unless set). |
| `MAIL_FROM` | Optional. The sender of password reset emails, like `Chat <no-reply@example.com>`. |

On the **Secrets** tab:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `KEY_ENCRYPTION_SECRET` | The secret from step 3 |
| `R2_ACCESS_KEY_ID` | The Access Key ID from step 1 |
| `R2_SECRET_ACCESS_KEY` | The Secret Access Key from step 1 |
| `SMTP_URL` | Optional. Outgoing email for password resets, like `smtps://user:password@smtp.example.com:465`. |

### 5. Deploy

Open **Actions**, **Deploy to Cloudflare**, **Run workflow**, and pick the branch or release tag to deploy. The first run takes about ten minutes, building the images; later ones are quicker.

### 6. Sign up straight away

Open `https://` and your domain. The first visit wakes the container, which takes a little longer the first time. **The first account to sign up becomes the admin**, so sign up right away, then go on to Admin, API keys. Turn off sign-ups in Admin, Settings if strangers shouldn't join.

## Afterwards

- **Updating:** run the workflow again with the newer branch or tag, at a quiet time.
- **What it's doing:** **Workers & Pages**, `parley`: the container's output is under its logs, and its state under **Containers**. Within 10 seconds of the first sign-up, `parley-db` holds `chat.db`.
- **Backups:** R2 keeps the database and Litestream its recent history, but they're still one copy. To keep one of your own, install Litestream on your computer and, in this folder, with the R2 key from step 1 and your account ID filled in, run:

  ```bash
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... R2_ACCOUNT_ID=... DB_BUCKET=parley-db litestream restore -config litestream.yml -o parley-backup.db /data/chat.db
  ```

  Files are in `parley-files`, which any S3 tool can copy. Keep `KEY_ENCRYPTION_SECRET` with your backups.

## If something's wrong

- **The site doesn't answer, and the logs say something "isn't set":** a secret or variable from step 4 is missing. Add it and deploy again.
- **"The files bucket couldn't be mounted":** check the bucket names and that the R2 token from step 1 can read and write both.
- **Claude or OpenAI say requests from your region aren't allowed:** the container is outside Western North America. Check `constraints` in `wrangler.jsonc`.
- **The deploy fails on a permission:** add the one it names to the token from step 2.

## How it fits together

- [`src/index.ts`](src/index.ts): the Worker, and the container's settings (sleeping after an hour, its environment). A deploy swaps the container's image but keeps the settings it started with, so after each deploy or change of secret, the first request stops the container (Litestream making its last copy) and starts it again with the new settings. The Worker tells Parley the visitor's address in `X-Forwarded-For`, replacing anything the visitor sent, and Parley trusts it (`TRUST_PROXY`).
- [`wrangler.jsonc`](wrangler.jsonc): the container's size and region, and the bucket names.
- [`Dockerfile`](Dockerfile) and [`start.sh`](start.sh): Parley's image with Litestream and tigrisfs. At start the files bucket is mounted, the database comes back, and Litestream runs Parley. Told to stop, Parley stops, Litestream makes its last copy, and the files bucket is unmounted.
- [`litestream.yml`](litestream.yml): how the database is copied, every 10 seconds.
- [`../.github/workflows/cloudflare.yml`](../.github/workflows/cloudflare.yml): the deploy.
