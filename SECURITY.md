# Security

Parley stores other people's API keys and chats, so security reports matter a lot.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: [report a vulnerability](https://github.com/SmirnovaOyama/parley/security/advisories/new) (the repository's **Security** tab). Say what you found, how to reproduce it, and what someone could do with it. You'll get a reply within a week, and credit in the fix if you'd like it.

Supported versions: the latest commit on `main`.

## Things worth knowing when you deploy

- `KEY_ENCRYPTION_SECRET` encrypts every stored API key. Keep it out of the repository and out of backups stored in the same place as the database.
- Run Parley behind HTTPS. Session cookies are `Secure` and `HttpOnly` in production.
- The first account to sign up becomes the admin. Sign up as soon as the site is up, and turn off sign-ups if it's public.
- Admins can make the server connect to any address (keys for "another service"), and can read every chat. Only give the admin role to people you trust with both.
- An MCP server is called with the headers an admin enters, for everyone allowed to use it, so they all act with those credentials. Give it a token with only the rights all of them should have. Each person gets an MCP session of their own. Turn on "Tell it who's asking" for a server that should tell people apart: every request then carries the person's email in an `X-Parley-User` header, which the server can trust only as far as it trusts Parley's token.
- Tools bring in text other people wrote: web pages, search results, shared knowledge, MCP results. Any of it can carry instructions aimed at the model. Parley fences it off as outside content, and asks the person on a line in the chat before it reads a page whose address the model didn't get from their messages or a search, keeps a memory note once the chat has taken in a page, file or tool result, or runs an MCP tool that may change things. Under Admin → Tools, every tool an admin lets run without asking is one an injected instruction can run, so keep that to tools that only read and don't reach other services.
- What an MCP server says about its tools goes to the model as written, so a server that's been taken over can still steer the chats that use it.
