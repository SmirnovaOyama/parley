# Contributing to Parley

Thanks for helping. Bug reports, ideas and pull requests are all welcome; issues and pull requests can be in English or Chinese.

## Getting set up

```bash
npm install
npm run setup
npm run dev
```

The site runs on http://localhost:5173 and the API on 8787; the API restarts by itself when a file under `server/` changes. The first account you create is the admin. To try AI replies you need a key for at least one provider; "Another service" pointed at a local [Ollama](https://ollama.com) (`http://localhost:11434/v1`) works without one.

## Before you open a pull request

- `npm run typecheck`, `npm test` and `npm run build` pass.
- The change works in the browser, in light and dark mode, and at phone width if it touches the interface.
- Keep pull requests to one change. For anything big, open an issue first so we can agree on the approach.

## How the code is written

- Match the code around your change: its naming, its comments (they say why, in full sentences) and its patterns.
- Database changes go through the `addColumn` pattern in `server/db.ts`, so existing databases update themselves on start.
- A new provider or model goes in `server/providers/catalog.ts`; a new OpenAI-style service is usually just a dialect for `server/providers/compat.ts`.
- Tests go in `test/` and run on Node's own test runner. They never reach the network: a provider is tested against a mock server the test starts (`test/helpers/mock-server.ts`), and the API runs on a temporary database. A change to how a provider reads its stream, or to the database, comes with a test.

## How the interface is written

Parley has a quiet, hand-drawn look and a few firm rules:

- No pop-ups: no modal dialogs, sheets or dropdown menus. Forms are their own pages with a back link, choices are plain lists with a tick, confirmations are an inline line.
- Text fields are lines, not boxes, with no glow or coloured focus ring.
- Copy is in sentence case, written as plain sentences. No full stop on titles, and no "·" between facts.
- Icons and illustrations are original hand-drawn line art (`src/icons/`), never a company's logo.
- Every string people read goes through `t()`, `tn()` or `tx()` (`src/lib/i18n.ts` in the page, `server/i18n.ts` on the server), keyed by its English as a whole sentence, so it can be translated without splicing fragments. `node scripts/i18n-check.ts` lists the ones `locales/zh.json` has no Chinese for; leave those for a translator rather than guessing.

## License of contributions

Parley is licensed under the [AGPL-3.0](LICENSE). By sending a pull request you agree that your contribution is licensed under it too.
