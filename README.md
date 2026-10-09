# Parley

[中文说明](README.zh-CN.md)

A self-hosted AI chat site for a team, a class or a family. Admins add API keys for Claude, OpenAI, Gemini, Grok, DeepSeek or any service in OpenAI's chat format, and decide who can use which models and how much they can spend. People sign in and chat. Keys never reach a browser.

Vite + React on the front, Hono on Node behind it, SQLite (Node's built-in `node:sqlite`) for storage. One process, one data folder.

## What it does

**For people**
- Chat with any model their admins allow, and pick the model and how hard it thinks, chat by chat.
- Attach images, PDFs and text files. Each model opens what it can, and the composer says when one can't.
- See the model's reasoning, folded above the reply, for models that share it.
- Let Claude and OpenAI models search the web with cited sources, or run code to make files to download (when an admin turns it on).
- Edit a message or regenerate a reply without losing the earlier version.
- Set instructions for every chat (about you, how to answer) or for one chat.
- Share a read-only link to a chat.

**For admins**
- API keys: stored encrypted, checked with the provider before they're saved, with a backup key for when one fails.
- People: who can use which keys, monthly token and spending limits, accounts on or off.
- Every chat, read-only and searchable. People are told admins can read chats, and every look is logged.
- Replies the AI declined, gathered for review.
- Usage and estimated cost by person, key and day.
- Site settings: the system prompt, sign-ups, sharing, and optional email rewards (extra allowance for verified addresses on domains you choose, like a school's).

## AI providers

| Provider | Models | Reads | Extras |
|---|---|---|---|
| Claude | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 | Images, PDFs, text | Web search, making files, prompt caching, refusal fallbacks |
| OpenAI | GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra | Images, PDFs, text | Web search, making files, reasoning summaries |
| DeepSeek | Flash, V4 Pro | Text | |
| Gemini | 3.8 Flash, 3.1 Pro, 3.5 Flash-Lite | Images, text | |
| Grok | 4.7, 4.3 | Images (JPEG, PNG), text | Reasoning summaries on 4.7 |
| Another service | Any model names you type | Text, and images if you say so | Presets for OpenRouter, Groq, Mistral, Qwen, Kimi, GLM and Ollama |

Prices for the cost estimates live in [`server/providers/catalog.ts`](server/providers/catalog.ts). For another service you can enter its prices on the key; models without prices count as free.

## Run it

### With Docker

```bash
git clone https://github.com/SmirnovaOyama/parley.git && cd parley
cp .env.example .env
```

Put a random secret of at least 32 characters in `.env` as `KEY_ENCRYPTION_SECRET` (for example the output of `openssl rand -base64 48`), then:

```bash
docker compose up -d
```

Open http://localhost:8787. **The first account to sign up becomes the admin**, so sign up straight away. Its next stop is Admin → API keys.

Everything Parley keeps (the database, attached files, files the AI made) is in the `parley-data` volume.

### With Node

Needs Node 24 or newer.

```bash
npm install
npm run setup
npm run dev
```

`npm run setup` writes a random `KEY_ENCRYPTION_SECRET` to `.env`. Open http://localhost:5173.

For production without Docker:

```bash
npm run build
npm start
```

The API (port 8787) serves the built site from `dist/` too.

## Configuration

Set in `.env` (see [`.env.example`](.env.example)):

| Setting | What it does |
|---|---|
| `KEY_ENCRYPTION_SECRET` | Required. Encrypts the API keys in the database. Keep it safe and never change it, or saved keys can't be read. |
| `VITE_APP_NAME` | The site's name, in the sidebar and the browser tab. With Docker it's built in, so rebuild after changing it. |
| `DATABASE_PATH` | Where the SQLite database lives (default `data/chat.db`). Files sit next to it. |
| `PORT` | The API's port (default 8787). |
| `SMTP_URL`, `MAIL_FROM` | Outgoing email for the optional email rewards. |

## Running it for real

- **HTTPS.** Put Parley behind HTTPS. In production, session cookies are marked `Secure`, so sign-in works only over HTTPS (or on localhost). With [Caddy](https://caddyserver.com) that's two lines:

  ```
  chat.example.com {
    reverse_proxy localhost:8787
  }
  ```
- **Backups.** Back up the data folder or volume, and keep `KEY_ENCRYPTION_SECRET` with them: a backup without the secret has keys nobody can read. To copy the database while it runs, use `sqlite3 chat.db ".backup backup.db"`.
- **Updating.** `git pull`, then `docker compose up -d --build` (or `npm install && npm run build` and a restart). The database updates itself on start.

## Security notes

- The first account becomes the admin. Sign up right after you deploy, then turn off sign-ups in Admin → Settings if you don't want strangers joining.
- Admins can point an "Another service" key at any address, and the server will connect to it. Only make people admins you trust with that.
- Admins can read every chat. Parley says so to everyone, under the message box.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## How it works

- **Chat.** `POST /api/chat` streams the reply as server-sent events. If the browser leaves, the reply keeps going and is saved; coming back shows it. Stop ends it early.
- **Claude.** `@anthropic-ai/sdk`, with prompt caching and server-side refusal fallbacks. Earlier replies go back exactly as they came, as the newest models require.
- **OpenAI and Grok.** The Responses API through the `openai` package, with nothing stored at the provider. Reasoning summaries show where the model gives them.
- **Gemini, DeepSeek and other services.** OpenAI's chat-completions format ([`server/providers/compat.ts`](server/providers/compat.ts)), one dialect per service. Reasoning shows whether it comes as its own field or in `<think>` tags.
- **Attachments.** Each file uploads as it's added and is kept next to the database. Claude gets files through its Files API, uploaded once per account; other models get images and PDFs inline, and text files go in as text. Photos are scaled down in the browser; files can be up to 30 MB (images 5 MB).
- **Keys.** Encrypted with AES-256-GCM under `KEY_ENCRYPTION_SECRET`.

## Development

```
server/            Hono API
  routes/          auth, chat, admin, shared links
  providers/       Claude, the Responses API (OpenAI, Grok), the chat-completions dialects, model catalog and prices
src/               React app
  components/      the pieces (no pop-ups: forms are pages, confirms are inline)
  icons/           hand-drawn icon set and doodles
  styles/          tokens.css (design tokens), oyama.css, app.css
scripts/           setup and the dev API runner
test/              tests: providers against mock APIs, keys and prices, the API end to end, database upgrades
```

`npm run typecheck` checks both the app and the server, and `npm test` runs the tests, which need no network or API keys. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0](LICENSE). You can use, change and share Parley freely. If you run a changed version as a service for others, you have to offer them its source code too.
