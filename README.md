# Command Center

Personal dashboard as a standalone PWA on Cloudflare Workers: Canvas coursework with submission
status, Google Calendar, Gmail, a countdown dial, swipe pages on phone, and a voice/text comms link.

**Setup and everything else: see `CLAUDE.md`** (written as a runbook you can hand to Claude Code).

```bash
npm install && npx wrangler login && npx wrangler kv namespace create STATE   # paste id into wrangler.toml
npx wrangler secret put PIN; npx wrangler secret put SESSION_SECRET; npx wrangler secret put CANVAS_TOKEN
npx wrangler deploy
```
Then connect Google from inside the app (CLAUDE.md §4).
