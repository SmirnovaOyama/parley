# Changelog

What changed in each version of Parley. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Search your own chats from the Chats page and the sidebar, by title and by what was said in them. Each word matches anywhere in the text, so Chinese and Japanese need no spaces, and each result shows the line that matched.

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

[Unreleased]: https://github.com/SmirnovaOyama/parley/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/SmirnovaOyama/parley/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/SmirnovaOyama/parley/releases/tag/v0.1.0
