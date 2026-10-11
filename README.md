# Parley

[中文说明](README.zh-CN.md)

A self-hosted AI chat site for a team, a class or a family. Admins add API keys for Claude, OpenAI, Gemini, Grok, DeepSeek or any service in OpenAI's chat format, and decide who can use which models and how much they can spend. People sign in and chat. Keys never reach a browser.

Vite + React on the front, Hono on Node behind it, SQLite (Node's built-in `node:sqlite`) for storage. One process, one data folder.

## Screenshots

<p align="center">
  <img src="docs/screenshots/chat-light.webp" width="76%" alt="A chat in Parley: a question about debouncing a React search box, answered with a JSX code block, and the model picker open on Claude, OpenAI, Gemini and OpenRouter models">
  <img src="docs/screenshots/chat-phone.webp" width="22%" alt="Parley on a phone: a reply about the latest Node.js release, with numbered web search citations">
</p>
<p align="center">
  <img src="docs/screenshots/chat-files.webp" width="49%" alt="A reply that made files: a redrawn sign-ups chart and a CSV of the numbers, as cards to download">
  <img src="docs/screenshots/chat-thinking.webp" width="49%" alt="A reply with the model's thinking unfolded above it, working out whether 2^100 or 3^63 is bigger">
</p>
<p align="center">
  <img src="docs/screenshots/chat-dark.webp" width="49%" alt="The React chat from the first screenshot, in dark mode">
  <img src="docs/screenshots/admin-overview.webp" width="49%" alt="The admin overview: this month's spend, active people, what prompt caching saved, token volume, and a card for each key's models">
</p>
<p align="center">
  <img src="docs/screenshots/admin-key-form.webp" width="49%" alt="Adding an API key: the providers to pick from, each ticked with what it can do, like images, PDFs, text files, web search and making files">
  <img src="docs/screenshots/admin-usage.webp" width="49%" alt="The usage page: cost and tokens over the last 30 days, charts by day, and spend by person">
</p>

## What it does

**For people**
- Chat with any model their admins allow, and pick the model and how hard it thinks, chat by chat.
- Attach images, PDFs and text files. Each model opens what it can, and the composer says when one can't.
- See the model's reasoning, folded above the reply, for models that share it.
- Let Claude and OpenAI models search the web with cited sources, or run code to make files to download (when an admin turns it on). Other models search and read pages through a search service the admin picks.
- Edit a message or regenerate a reply without losing the earlier version.
- Set instructions for every chat (about you, how to answer) or for one chat.
- Keep chats in projects: folders with their own instructions and knowledge that every chat in them shares.
- Add PDFs, Word documents and text files to knowledge bases, connect them to a chat or a project, and every model looks things up in them.
- Memory: the AI keeps short notes about you between chats, which you can read, edit, add to or turn off.
- Connect your own account on services whose tools act as each person, by signing in on the service's own page or adding a token, under Account in Connected services.
- See how full the model's context is above the message box, with a nudge to start afresh when it's nearly full.
- Preview HTML pages, SVG, React components, Mermaid diagrams and JavaScript from a reply, run in a sandbox.
- Pin chats, and find the rest grouped by when they were last active.
- Search your own chats by title and by what was said in them, Chinese and Japanese included, with the line that matched.
- Export everything as one file, and import chats from Parley, ChatGPT or Claude exports.
- Share a read-only link to a chat.
- Reset a forgotten password with a link by email, when the site can send email, or ask an admin to set a new one.
- See where you're signed in, and sign out any device.
- Add it to your phone's home screen, or install it from a desktop browser, and it opens as an app of its own.

**For admins**
- API keys: stored encrypted, checked with the provider before they're saved, with a backup key for when one fails.
- People: who can use which keys, monthly token and spending limits, accounts on or off, a new password for someone who can't sign in, and where each person is signed in, with a way to sign them out.
- Groups, like a class or a team, that open keys and MCP servers to their members and can give them a spending limit of their own.
- MCP servers (Streamable HTTP or SSE): their tools work with every model, for everyone or for chosen groups. Each tool can be on or off, and can run straight away or ask the person first. When a server's tools change, the new ones wait for an admin to look over. A server acts with one shared account, or with each person's own: they sign in on its sign-in page (MCP's OAuth flow) or add a token of theirs. Admins see who has connected, never what with.
- Knowledge bases shared with everyone, and the search service for models without their own web search (Tavily, Brave, Bocha, Jina or your own SearXNG).
- Every chat, read-only and searchable. People are told admins can read chats, and every look is logged.
- Replies the AI declined, gathered for review.
- Usage and estimated cost by person, key and day.
- Site settings: the system prompt, sign-ups, how many devices an account can be signed in on, sharing, memory, how long chats are kept (including chats people deleted), and optional email rewards (extra allowance for verified addresses on domains you choose, like a school's).

## AI providers

| Provider | Models | Reads | Extras |
|---|---|---|---|
| Claude | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 | Images, PDFs, text | Web search, making files, prompt caching, refusal fallbacks |
| OpenAI | GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra | Images, PDFs, text | Web search, making files, reasoning summaries |
| DeepSeek | Flash, V4 Pro | Text | |
| Gemini | 3.8 Flash, 3.1 Pro, 3.5 Flash-Lite | Images, text | |
| Grok | 4.7, 4.6, 4.3 | Images (JPEG, PNG), text | Reasoning summaries on 4.7 |
| Another service | Any model names you type | Text, and images if you say so | Presets for OpenRouter, Groq, Mistral, Qwen, Kimi, GLM and Ollama |

Prices for the cost estimates live in [`server/providers/catalog.ts`](server/providers/catalog.ts). For another service you can enter its prices on the key; models without prices count as free.

## Run it

### With Docker

Each release is published as an image for x86 and ARM machines (linux/amd64 and linux/arm64), so it runs on a server, a NAS or a Raspberry Pi with a 64-bit system:

```bash
docker pull ghcr.io/smirnovaoyama/parley:latest
```

Parley needs a random secret of at least 32 characters. Make one and keep it somewhere safe: it has to be the same every time Parley starts, and a backup is no use without it.

```bash
openssl rand -base64 48
```

Then start Parley, with your secret in place of `your-secret`:

```bash
docker run -d --name parley -p 8787:8787 -v parley-data:/data -e KEY_ENCRYPTION_SECRET='your-secret' --restart unless-stopped ghcr.io/smirnovaoyama/parley:latest
```

Open http://localhost:8787. **The first account to sign up becomes the admin**, so sign up straight away. Its next stop is Admin → API keys.

Everything Parley keeps (the database, attached files, files the AI made) is in the `parley-data` volume. Other settings (see [Configuration](#configuration)) go in as more `-e` options, like `-e VITE_APP_NAME='Our chat'` to give the site another name.

#### With Docker Compose

[`docker-compose.yml`](docker-compose.yml) runs the same image and reads its settings from a `.env` file next to it. In an empty folder:

```bash
curl -fsSLO https://raw.githubusercontent.com/SmirnovaOyama/parley/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/SmirnovaOyama/parley/main/.env.example
```

Put your secret in `.env` as `KEY_ENCRYPTION_SECRET`, then:

```bash
docker compose up -d
```

#### Versions and updates

`latest` is always the newest release. To stay on one, use its version in place of `latest`: `0.2.0` stays exactly there, and `0.2` takes that version's bug-fix releases too. [Releases](https://github.com/SmirnovaOyama/parley/releases) lists them, and [CHANGELOG.md](CHANGELOG.md) says what changed in each.

To update with Compose:

```bash
docker compose pull && docker compose up -d
```

With `docker run`, pull the new image, remove the container (`docker rm -f parley`) and run the same `docker run` command again. Your data stays in the volume, and the database updates itself on start.

#### Building the image yourself

To run changes of your own, clone the repository and, in `docker-compose.yml`, swap the `image:` line for `build: .` (it's there, commented out). Then run `docker compose up -d --build`.

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
| `VITE_APP_NAME` | The site's name, in the sidebar and the browser tab. It's read when Parley starts, so a restart picks up a change. |
| `DATABASE_PATH` | Where the SQLite database lives (default `data/chat.db`). Files sit next to it. |
| `PORT` | The API's port (default 8787). |
| `SMTP_URL`, `MAIL_FROM` | Outgoing email, for password reset links and the optional email rewards. |
| `PUBLIC_URL` | The address people reach Parley at, like `https://chat.example.com`. Password reset emails link to it, so resetting a password by email works only once it's set. MCP servers people sign in to send them back here afterwards; for those, Parley otherwise uses the address in the browser, which is right unless a proxy in front changes it. |
| `TRUST_PROXY` | Set to `1` only when every request reaches Parley through a proxy that sets `X-Forwarded-For` itself, from whatever address it connects (as on Cloudflare Containers, which sets it for you). Parley then reads where people connect from in the header's last address. Without it, the header counts only from a proxy on the same machine or a private network. |
| `TUNNEL_TOKEN` | Only for `docker-compose.yml`'s Cloudflare Tunnel (see [Running it for real](#running-it-for-real)): the tunnel's token. Parley itself doesn't read it. |
| `ALLOW_FAKE_IP` | Set to `1` only if the server reaches the internet through a proxy that answers every name with a 198.18.x.x stand-in address (Clash, Surge, sing-box and the like in fake-IP mode). Off by default: the page reader for other models' web search refuses those addresses, because behind such a proxy it can't check where a name really leads, and a name that points inside the network would be read. |

## Running it for real

- **HTTPS.** Put Parley behind HTTPS. In production, session cookies are marked `Secure`, so sign-in works only over HTTPS (or on localhost). With [Caddy](https://caddyserver.com) that's two lines:

  ```
  chat.example.com {
    reverse_proxy localhost:8787
  }
  ```
- **Cloudflare.** A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) puts Parley online with no port open and HTTPS from Cloudflare. With Docker Compose, make a tunnel in Cloudflare's dashboard (Zero Trust, Networks, Tunnels), give its public hostname the service `http://parley:8787`, put its token in `.env` as `TUNNEL_TOKEN`, and run `docker compose --profile tunnel up -d`. Then:
  - Set `PUBLIC_URL` to the tunnel's address, like `https://chat.example.com`.
  - Change `docker-compose.yml`'s ports line to `"127.0.0.1:8787:8787"` (or `docker run -p 127.0.0.1:8787:8787`), so nobody reaches the site around Cloudflare.
  - Let cloudflared reach Parley directly, with no other proxy between them. Parley reads where each visitor connects from in the last entry of `X-Forwarded-For`, which Cloudflare adds, from a proxy on the same machine or network; another proxy in between would put its own address there.
  - Leave Rocket Loader off (Speed, Optimization). It rewrites the page's scripts, which the site's Content-Security-Policy then refuses, and the page stays blank. Other features that add scripts to the page, like Web Analytics' automatic setup, are refused the same way.
  - On the Free and Pro plans Cloudflare takes uploads up to 100 MB, so an export bigger than that can't be imported through it. Import the `conversations.json` inside it instead, or on the server's own address.
  - Replies stream through it as they do anywhere. A reply's stream sends a keep-alive line every 20 seconds, so a model thinking quietly isn't cut off by Cloudflare's 100-second limit.
- **On Cloudflare, with no server.** Parley can also run in a Cloudflare Container on the Workers Paid plan, with its database and files kept in R2 and a GitHub Actions workflow to deploy it. See [cloudflare/README.md](cloudflare/README.md).
- **Backups.** Back up the data folder or volume, and keep `KEY_ENCRYPTION_SECRET` with them: a backup without the secret has keys nobody can read. To copy the database while it runs, use `sqlite3 chat.db ".backup backup.db"`.
- **Updating.** With Docker, see [Versions and updates](#versions-and-updates). From source, `git pull`, then `npm install && npm run build` and a restart. The database updates itself on start.

## Security notes

- The first account becomes the admin. Sign up right after you deploy, then turn off sign-ups in Admin → Settings if you don't want strangers joining.
- Admins can point an "Another service" key at any address, and the server will connect to it. Only make people admins you trust with that.
- Every other key goes only to its provider's own address. Claude's and OpenAI's ignore `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and the other settings those libraries would read from the environment, so nothing set there can send keys somewhere else.
- People can't easily turn their account into a relay for the site's keys (a reverse proxy that other apps or people use through their sign-in). Anything that changes something through the API has to come from the site's pages in a browser, by its `Origin` header and `Sec-Fetch-Site` where the browser sends it. Each person can have three replies written at once and send 20 messages a minute and 200 an hour. Each account can be signed in on 5 devices unless you change it under Admin → Settings, and signing in on another signs out the one used longest ago. A determined script can pretend to be a browser, so admins also see, on each person's page, every device they're signed in on: the browser or program, the address it was last used from, and when. Many devices, many networks, or "Not a browser" is worth a look, and a spending limit caps what any of it can cost.
- Admins can see the address and browser each of a person's sign-ins was last used from, and people are told so where they see their own. They're deleted with the sign-in: when it's signed out, or runs out after 30 days unused.
- Admins can read every chat. Parley tells everyone so on their account page.
- Admins can set a new password for anyone but themselves, other admins included. It signs that person out everywhere and is written to the activity log, with who did it.
- Password reset links are random, work once for 30 minutes, and only their hash is stored. Asking for one gets the same answer whether or not an account uses the address, and is limited by address and by network; behind a reverse proxy on the same machine or a private network, the network is read from the last address in `X-Forwarded-For`. Links always start with `PUBLIC_URL`, never with the address a request names. A turned-off account can't be reset.
- MCP servers are reached from the server. Each one acts with one of two kinds of account. On a shared account, every request carries the headers the admin gives it, so everyone who can use the server acts with those credentials: give it a token that has only the rights everyone using it should have. On each person's own account, people sign in on the server's own sign-in page or add a token of theirs, under Account in Connected services; each person's requests carry only their own, never the admin's headers, and someone who hasn't connected can't use its tools. People's tokens are encrypted like API keys, refreshed when they run out, and forgotten when the person disconnects, loses access, is turned off, or the server's address or way of signing in changes. Each person gets an MCP session of their own, and a server can be told who's asking (an `X-Parley-User` header with their email, off by default).
- Pages, search results, shared documents and MCP results can carry instructions aimed at the model (prompt injection). Parley marks them as coming from outside, and asks the person on a line in the chat before it reads a page whose address didn't come from their messages or a search (an address can carry the chat's contents away), keeps a memory note once the chat has taken in a page, file or tool result, or runs an MCP tool that may change things. MCP tools the server calls read-only run without asking, unless it says they reach services beyond it; admins can change that for each tool. This lowers the risk but doesn't remove it, so read what a question says before allowing it.
- What an MCP server says about its tools (their descriptions, their inputs, and whether they only read) goes to the model in every new chat that has them. It's taken as written when an admin adds the server. After that, whenever the server is asked for its tools again or its address or headers change, tools that are new or read differently wait under Admin → Tools, each shown beside what it said before, until an admin uses them or keeps the old ones. Chats already started keep the tools they started with. So a server that's been taken over can't change what chats are told without an admin seeing it, but read the new words for instructions before you use them.
- The page reader behind web search for other models refuses addresses inside the server's own network.
- Code previews run on a page of their own (`/api/preview`) that the browser sandboxes by its Content-Security-Policy, so the code can't act as the site. It may load scripts from a few public CDNs (jsDelivr, unpkg, esm.sh, cdnjs).
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## How it works

- **Chat.** `POST /api/chat` streams the reply as server-sent events. If the browser leaves, the reply keeps going and is saved; coming back shows it. Stop ends it early.
- **Claude.** `@anthropic-ai/sdk`, with prompt caching and server-side refusal fallbacks. Earlier replies go back exactly as they came, as the newest models require.
- **OpenAI and Grok.** The Responses API through the `openai` package, with nothing stored at the provider. Reasoning summaries show where the model gives them.
- **Gemini, DeepSeek and other services.** OpenAI's chat-completions format ([`server/providers/compat.ts`](server/providers/compat.ts)), one dialect per service. Reasoning shows whether it comes as its own field or in `<think>` tags.
- **Tools.** Memory, knowledge search, MCP servers' tools and (for models without their own) web search are functions every provider can call ([`server/tools.ts`](server/tools.ts)); each provider runs the loop its own way. A chat's tool list is settled when it starts, because Claude ties its reasoning to it. A call that needs the person's OK waits for it ([`server/asks.ts`](server/asks.ts)), asked on a line in the reply.
- **Knowledge.** Documents are cut into overlapping parts in an SQLite FTS5 index with the trigram tokenizer, so Chinese and Japanese match without word breaks. No embeddings, no extra service.
- **Attachments.** Each file uploads as it's added and is kept next to the database. Claude gets files through its Files API, uploaded once per account; other models get images and PDFs inline, and text files go in as text. Photos are scaled down in the browser; files can be up to 30 MB (images 5 MB).
- **MCP accounts.** A server on each person's own account gets each request with that person's token or sign-in ([`server/mcp-auth.ts`](server/mcp-auth.ts)). Signing in is MCP's OAuth flow: Parley finds the server's sign-in service, registers itself there when the service allows it, and sends the person to its page with PKCE. Sign-ins are refreshed once at a time, however many calls need them.
- **Keys.** API keys and people's own MCP tokens are encrypted with AES-256-GCM under `KEY_ENCRYPTION_SECRET`.

## Development

```
server/            Hono API
  routes/          auth, chat, admin, shared links, projects, knowledge, your data (memory, export, import), your MCP accounts
  providers/       Claude, the Responses API (OpenAI, Grok), the chat-completions dialects, model catalog and prices
src/               React app
  components/      the pieces (no pop-ups: forms are pages, confirms are inline)
  icons/           hand-drawn icon set and doodles
  styles/          tokens.css (design tokens), oyama.css, app.css
scripts/           setup and the dev API runner
cloudflare/        running it on Cloudflare Containers: the Worker, the image's additions, and the guide
test/              tests: providers against mock APIs, keys and prices, the API end to end, database upgrades
```

`npm run typecheck` checks both the app and the server, and `npm test` runs the tests, which need no network or API keys. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0](LICENSE). You can use, change and share Parley freely. If you run a changed version as a service for others, you have to offer them its source code too.
