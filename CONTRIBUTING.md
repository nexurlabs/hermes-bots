# Contributing to NexurBots

Thanks for helping. NexurBots is a desktop app that talks to [Hermes Agent](https://github.com/NousResearch/hermes-agent). Please start there if you're new to Hermes.

## Before you start

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- Keep changes focused. One pull request should do one thing.
- Keep the app free of personal data: no real names, emails, IP addresses or account names in code, tests, demo data or screenshots.

## Setup

```sh
npm install
npm run check   # syntax checks for the Electron files
npm test        # Node tests
npx --yes bun@1.4.2 test --isolate ./tests/*.test.ts   # Bun tests (run as CI does)
npm run build   # bundles the app into ./app
```

Run the app with `npm start`. Preview the interface without Hermes by opening `app/renderer/index.html` with `#chat`, `#room` or `#connect` on the end of the address.

## Pull requests

- Add or update tests for behavior you change. CI runs the Node tests, the Bun tests and a TypeScript check, plus a smoke test of the built app.
- Describe what changed and how you tested it.
- Don't commit build output, `.env` files, keys or tokens.

## Security

Don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).
