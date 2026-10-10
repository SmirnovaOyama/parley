# Changelog

What changed in each version of Parley. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-09

The first public release.

### Added

- Chat with Claude (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1), OpenAI (GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra), DeepSeek (Flash, V4 Pro), Gemini (3.8 Flash, 3.1 Pro, 3.5 Flash-Lite) and Grok (4.7, 4.3).
- Any other service in OpenAI's chat format, with its own address, model names and optional prices. There are presets for OpenRouter, Groq, Mistral, Qwen, Kimi, GLM and Ollama.
- The model and how hard it thinks are picked chat by chat, starting from the key's choice. Reasoning shows folded above the reply for models that share it.
- Replies stream, and keep going and get saved if the browser leaves. Stop ends one early.
- Attachments: images, PDFs and text files, up to 30 MB (images 5 MB). Each model reads what it can, and the composer says when one can't.
- Web search with cited sources, and running code to make files to download, for Claude and OpenAI models when an admin turns them on.
- Editing a message or regenerating a reply keeps the earlier versions.
- Instructions for every chat (about you, how to answer) or for one chat.
- Read-only links to share a chat.
- API keys stored encrypted (AES-256-GCM), checked with the provider before they're saved, with a backup key for when one fails. Keys never reach a browser.
- Limits: who can use which keys, monthly token and spending limits per person, and accounts on or off.
- Usage and estimated cost by person, key and day.
- Admins can read every chat, read-only and searchable. Everyone is told, under the message box, and every look is logged.
- Replies the AI declined, gathered for admins to review. Claude falls back to another model when it declines.
- Email rewards: extra allowance for people who verify an address on domains the admin chooses, like a school's.
- Site settings for the system prompt, sign-ups and sharing.
- A Docker image for linux/amd64 and linux/arm64 at `ghcr.io/smirnovaoyama/parley`, and a `docker-compose.yml` that uses it.
- The site's name (`VITE_APP_NAME`) is read when the server starts, so the published image works under any name.

[Unreleased]: https://github.com/SmirnovaOyama/parley/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SmirnovaOyama/parley/releases/tag/v0.1.0
