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
