# Parley

A self-hosted AI chat site. Admins add API keys (Claude, OpenAI, Gemini, Grok, DeepSeek, or any service in OpenAI's chat format) and bind them to people; people chat; admins can read every conversation, and each time they open one it's logged.

Vite + React on the front, Hono on Node behind it, SQLite (Node's built-in `node:sqlite`) for storage. Styled with the Oyama design system.

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run setup
npm run dev
```

Open http://localhost:5173. The first account you create becomes the admin, and it goes straight to **Admin → API keys** to add a key.

`npm run setup` writes a random `KEY_ENCRYPTION_SECRET` to `.env`. Keep that file; if the secret changes, saved keys can't be decrypted. See `.env.example` for the other settings (`VITE_APP_NAME` sets the site name).

## Production

```bash
npm run build
npm start
```

The API server (port 8787 by default) serves the built site from `dist/` too. Put it behind HTTPS: session cookies are marked `Secure` in production.

## How it works

- **Keys.** Stored encrypted (AES-256-GCM) and checked with the provider before they're saved. They never reach a browser. A person uses the key bound to them, or the default key.
- **Chat.** `POST /api/chat` streams the reply as server-sent events. If the browser leaves, the reply keeps going and is saved; coming back shows it. Stop ends it early.
- **Claude.** `@anthropic-ai/sdk`, default model `claude-opus-5-5`, with prompt caching and server-side refusal fallbacks. Earlier replies go back exactly as they came, as the newest models require.
- **Attachments.** Add files with the plus button, by dropping them on the chat, or by pasting a screenshot. Each one uploads as it's added (`PUT /api/uploads`) and is kept next to the database; the message carries their ids. Claude reads images, PDFs and text files, and opens other files in its sandbox in chats where it can run code. Claude gets each file through its Files API, uploaded once per account, so a long chat never sends the same bytes twice. Other services get text files inlined and pictures (and PDFs where they read them) in the message; each picture goes after a line with its file name. The message box holds back a file the picked model can't open. Photos are scaled to 2576px on the long edge in the browser; files can be up to 30 MB (images 5 MB). Uploads that are never sent are cleared after a day. Editing a message keeps its files unless you take them off.
- **OpenAI and Grok.** The Responses API through the `openai` package (GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra; Grok 4.7 and 4.3 at `https://api.x.ai/v1`), with nothing stored at the provider. Reasoning summaries show where the model gives them; if OpenAI wants the organisation verified first, the reply goes again without them. OpenAI reads images and PDFs; Grok reads JPEG and PNG pictures.
- **Gemini, DeepSeek and other services.** OpenAI's chat-completions format (`server/providers/compat.ts`), one dialect per service. Gemini goes through Google's OpenAI-compatible endpoint and reads images. DeepSeek reads text. *Another service* takes any address that speaks the format (OpenRouter, Groq, Mistral, Qwen, Kimi, GLM, a local Ollama): the admin types the model names and, if they want costs counted, their prices; reasoning shows whether it comes as its own field or in `<think>` tags. Text files go to every model inlined in the message.
- **Models and prices.** `server/providers/catalog.ts`. Costs are estimates from list prices and feed the spending limits.
- **Admin.** Keys, people (role, bound key, monthly token limit, on/off), every chat (read-only, searchable), usage with estimated cost, the system prompt, sign-up switch and an activity log.
- **Email rewards.** Optional. Admins list domains (say `example.edu`) in Settings, with extra monthly tokens and/or models to unlock. Anyone who proves they own an address there, with a 6-digit code emailed to it, gets the reward while the domain stays listed; people who sign up with such an address are offered it straight away. Codes are sent through `SMTP_URL` (see `.env.example`); without it, development prints them in the server log. The domain list lives in the database, not in the code.
- **Privacy.** People are told that admins can read chats. Deleting a chat hides it from its owner; admins can still see it, and can delete it for good.

## Layout

```
server/            Hono API
  routes/          auth, chat, admin
  providers/       Claude, the Responses API (OpenAI, Grok), the chat-completions dialects (Gemini, DeepSeek, other services), model catalog and prices
src/               React app
  components/      Oyama-styled pieces (no pop-ups: forms are pages, confirms are inline)
  icons/           hand-drawn icon set and doodles
  styles/          tokens.css (from the design system), oyama.css, app.css
scripts/           setup and the dev API runner
```
