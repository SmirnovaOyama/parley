# Changelog

What changed in each version of Parley. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Claude's and OpenAI's keys now go only to api.anthropic.com and api.openai.com: a server that reached them through a relay by setting `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` stops reaching them that way. Add the relay as an "Another service" key instead, if it speaks OpenAI's chat format. Anything that changes something through the API (sending a message, saving a setting) now has to come from the site's pages in a browser, so scripts that called it with a session cookie stop working (see Security).

### Added

- The interface in Chinese. Parley follows the browser's language, or the one picked under Settings → Appearance → Language, and the server's messages and emails come in it too. What the model is told stays in English. `node scripts/i18n-check.ts` lists strings that have no Chinese yet.
- Account is now Settings, with who's signed in at the top, Personas, memory and connected services together under Assistant, and Sign out at the foot. About shows Parley's version and links to its code on GitHub. Old /account addresses still arrive.
- Two-step verification, under Settings: after the password, a six-digit code from an authenticator app (scan a QR code or type the key) or a passkey, and ten one-time recovery codes for a lost phone, shown once. Setting either up or removing it takes the password again. A reset link by email no longer signs in past it. Admins can turn it off for someone locked out, from their page under Admin → People.
- Where you're signed in, under Settings: each browser or program signed in to your account, the address it was last used from and when, and a button to sign out any of them or every other one.
- Admins see the same on each person's page under Admin → People, with how many networks this week's sign-ins came from, and can sign them out of one device or all of them. The People list marks someone signed in on three devices or more, or from a program rather than a browser. Signing someone out is written to the activity log.
- `docker compose --profile tunnel up -d` runs a Cloudflare Tunnel next to Parley, with the tunnel's token in `.env` as `TUNNEL_TOKEN`. The README's "Running it for real" says what else to set for Cloudflare.
- Admins can stop showing people, under Settings, that admins can read their chats (Admin → Settings → Privacy). It's shown unless turned off, and each look at a chat is logged either way.
- Sign-up codes: before an account is made, a code goes to its address and has to be typed in, so nobody signs up with an address that isn't theirs, and accounts can't be made by the dozen. On by default once the site can send email (`SMTP_URL`), and admins turn it on or off under Admin → Settings → Sign-ups. The site's first account needs none. Codes work once, for 10 minutes and 5 tries, and asking is limited by address and by network. An address checked this way that's on a rewarded domain earns the email reward straight away.
- Add to Home Screen: on a phone, or installed from a desktop browser, Parley opens as an app of its own, with its own icon and the site's name. When a page can't be reached it shows a page saying so instead of the browser's; nothing else is kept offline, so a new version shows as soon as it's deployed. The phone's bars take the page's colour in the theme you picked.
- Parley can run on Cloudflare with no server: in a Cloudflare Container on the Workers Paid plan, its database copied to R2 by Litestream and its files kept in R2, in Western North America so Claude and OpenAI answer. A GitHub Actions workflow builds and deploys it. See `cloudflare/README.md`.
- `TRUST_PROXY=1` for a proxy that connects from addresses Parley can't tell apart from the internet's, like the Worker in front of a Cloudflare Container: the last address in `X-Forwarded-For` is then always the visitor's.
- A limit on how many devices one account can be signed in on, under Admin → Settings → Signing in: 5 unless you change it, or empty for none. Signing in on one more signs out the one used longest ago, and a lower number holds as soon as it's saved, except for the admin's own device that saved it.

### Fixed

- Memory no longer keeps the same thing twice. Before the AI keeps a new note, it looks over any that read alike and any kept since the chat began (which some models no longer have in front of them a reply later), and saves only what none of them says, in whatever words or language. A note it already has word for word changes nothing, and notes are written in the person's language.
- A reply's stream sends a keep-alive line every 20 seconds, so Cloudflare and other proxies that cut a silent connection after about 100 seconds no longer cut off a model thinking quietly or running a long tool.

### Security

- Keys go only to their provider. The Anthropic and OpenAI libraries read `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` from the environment, so whatever set one there could have every admin's key sent to an address of its choosing, or other credentials sent along with it. Parley now gives every provider its address and credentials itself, and only an "Another service" key goes where an admin points it.
- Harder to turn an account into a relay that passes the site's keys on to other apps or people (a reverse proxy on someone's sign-in). A change through the API must carry the site's own `Origin`, and `Sec-Fetch-Site: same-origin` where the browser sends it, which every browser does for the site's own pages and a plain script doesn't. A script can still pretend, so each person can now have three replies being written at once and send 200 messages an hour, on top of 20 a minute as before, and admins can see where each person is signed in.
- Sign-ins that ran out are deleted every hour, and with them the addresses and browsers they were used from.

## [0.2.0] - 2026-10-10

A database from 0.1.x is brought up to date when the server starts. MCP servers added before this release ask the person before running any of their tools, until an admin asks the server for its tools again and looks over what it says about them (see Security).

### Added

- Search your own chats from the Chats page and the sidebar, by title and by what was said in them. Each word matches anywhere in the text, so Chinese and Japanese need no spaces, and each result shows the line that matched.
- Forgotten passwords can be reset by email. "Forgot your password?" on the sign-in page sends a link that works once, for 30 minutes, and a newer link replaces the last. Setting the new password signs out every other device and signs in this one. Asking gets the same answer whether or not an account uses the address, and is limited by address and by network. It needs `SMTP_URL` and `PUBLIC_URL`; without them, the sign-in page says to ask an admin.
- Admins can set a new password for someone who can't sign in, from that person's page under Admin → People. It signs them out everywhere, stops any reset link they asked for, and is written to the activity log. An admin's own password is still changed under Account.
- "Tell it who's asking" for an MCP server: every request carries the person's email in an `X-Parley-User` header, so the server can tell people apart. Off by default.
- MCP servers can act with each person's own account instead of one shared one. Under Admin → Tools, "Whose account it uses" offers one shared account (as before, and still the default), each person signing in on the server's own sign-in page (MCP's OAuth flow, with Parley registering itself where the service allows it, or a client an admin registered), or each person adding a token of their own. People connect under Account, in Connected services. Their requests carry only their own account, never the admin's headers, and a tool used before they've connected says so on a line in the reply, with a link to connect it. Sign-ins refresh as they run out, and accounts are forgotten when the person disconnects, loses access, is turned off, or the server's address or way of signing in changes. The server's page lists who has connected, and can disconnect everyone.
- `PUBLIC_URL`, the address people reach Parley at, for sign-in pages to send them back to when a proxy in front changes it.

### Security

- Reading a page now asks the person first, on a line in the chat, when its address didn't come from their messages or a search. Text on a page or in a tool's result could otherwise have had the model read an address it made up, with what the chat holds in it.
- Keeping a memory note asks the person first once the chat has taken in a page, a file, search results, knowledge passages or a tool's result, so someone else's words can't plant notes that steer later chats.
- MCP tools that may change things ask the person first, showing what they'd send. Tools the server calls read-only run straight away, unless it says they reach services beyond it, and admins choose for each tool under Admin → Tools. Servers added before this release ask for every tool until an admin asks the server for its tools again and uses what it says about each one (shown as changes to look over), or ticks them under "Run without asking".
- Each person gets their own MCP connection and session, so a server that keeps state between calls no longer shares it between people.
- What pages, searches, knowledge bases and MCP servers return reaches the model marked as coming from outside the chat, with a reminder not to follow instructions in it.
- The page reader refuses addresses with a name or password in them.
- When an MCP server's tools are listed again (by asking it for them, by changing its address, headers or token, or by an admin signing in to it again), tools that are new or describe themselves differently no longer reach new chats straight away. A server that had been taken over could otherwise have slipped instructions into every chat that uses it. The server's page under Admin → Tools shows each change beside what the tool said before (its title, description, input and what it says it does), and an admin picks "Use the new ones" or "Keep the old ones". New tools stay off until then. Chats already started keep the tools they started with, and servers being added are taken as they are (for one that people sign in to, at the admin's first sign-in, which finishes adding it).

## [0.1.1] - 2026-10-10

### Fixed

- The sharing and export parts of a chat's settings were missing for people whose ad blocker uses a social filter list (AdGuard Social, Fanboy's Social), which hides anything named `share-panel` or `share-text` on every site.
- After the server turned away a request as too big, the next request on the same connection could fail with "other side closed".

## [0.1.0] - 2026-10-10

The first public release.

### Added

- Chat with Claude (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1), OpenAI (GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra), DeepSeek (Flash, V4 Pro), Gemini (3.8 Flash, 3.1 Pro, 3.5 Flash-Lite) and Grok (4.7, 4.6, 4.3).
- Any other service in OpenAI's chat format, with its own address, model names and optional prices. There are presets for OpenRouter, Groq, Mistral, Qwen, Kimi, GLM and Ollama.
- The model and how hard it thinks are picked chat by chat, starting from the key's choice. Reasoning shows folded above the reply for models that share it.
- Replies stream, and keep going and get saved if the browser leaves. Stop ends one early.
- Attachments: images, PDFs and text files, up to 30 MB (images 5 MB). Each model reads what it can, and the composer says when one can't.
- Web search with cited sources, and running code to make files to download, for Claude and OpenAI models when an admin turns them on. Other models search and read pages through a search service the admin picks: Tavily, Brave, Bocha, Jina or a SearXNG of your own.
- Editing a message or regenerating a reply keeps the earlier versions.
- Personas: up to five sets of what the AI should know about you and how it should answer, one of them for new chats. A chat can have instructions of its own too.
- Projects: folders of chats with their own instructions and knowledge, shared by every chat in them.
- Knowledge bases of PDFs, Word documents and text files, connected to a chat or a project, that every model can look things up in. Admins can share one with everyone.
- Memory: the AI keeps short notes about you between chats, which you can read, edit, add to or turn off.
- How full the model's context is, shown over the message box, with a nudge to start a new chat when it's nearly full.
- Previews of HTML pages, SVG, React components, Mermaid diagrams and JavaScript from a reply, run in a sandbox.
- Pinned chats, and the rest grouped by when they were last active.
- Exporting everything as one file, and importing chats from Parley, ChatGPT and Claude exports.
- Read-only links to share a chat.
- API keys stored encrypted (AES-256-GCM), checked with the provider before they're saved, with a backup key for when one fails. Keys never reach a browser.
- Limits: who can use which keys, monthly token and spending limits per person, and accounts on or off.
- Groups, like a class or a team, that open keys and MCP servers to their members and can have a spending limit of their own.
- MCP servers over Streamable HTTP or SSE, whose tools work with every model, for everyone or for chosen groups, each tool on or off.
- Usage and estimated cost by person, key and day.
- Admins can read every chat, read-only and searchable. Everyone is told on their account page, and every look is logged.
- Replies the AI declined, gathered for admins to review. Claude falls back to another model when it declines.
- Email rewards: extra allowance for people who verify an address on domains the admin chooses, like a school's.
- Site settings for the system prompt, sign-ups, sharing, memory, and how long chats are kept, including chats people deleted.
- A Docker image for linux/amd64 and linux/arm64 at `ghcr.io/smirnovaoyama/parley`, and a `docker-compose.yml` that uses it.
- The site's name (`VITE_APP_NAME`) is read when the server starts, so the published image works under any name.
- `GET /api/health` for uptime checks, which the Docker image uses as its health check.

[Unreleased]: https://github.com/SmirnovaOyama/parley/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SmirnovaOyama/parley/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/SmirnovaOyama/parley/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/SmirnovaOyama/parley/releases/tag/v0.1.0
