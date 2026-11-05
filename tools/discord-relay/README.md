# GitHub → Discord relay

A Cloudflare Worker that turns the org-level GitHub webhook into short Discord messages:
one summary line, with the technical details behind a spoiler that viewers click to reveal.

```
🔀 **warren** merged PR #12 into `main` · *daedalusdatalabs.com*
||**Fix nav spacing on mobile** · `fix/nav` → `main` · 3 commits · +42 / −17 · 4 files · View PR||
```

## Events

| GitHub event | Posted when |
|---|---|
| Pushes | Commits are pushed. Pushes created by merging a PR in GitHub's UI are skipped, since the merge message covers them. |
| Pull requests | Opened, marked ready for review, reopened, merged, or closed without merging |
| Pull request reviews | A review is submitted (approved, changes requested, commented) |
| Issues | Opened, closed, reopened |
| Issue comments | A comment is added to an issue or PR |
| Branch or tag creation / deletion | Always |
| Releases | A release is published |
| Repositories | A repo is created |

Anything else is ignored. Messages never ping anyone and never show GitHub link previews.

## Deploy

You need Node.js 18 or newer and a free Cloudflare account.

1. Go to this folder:
   ```bash
   cd tools/discord-relay
   ```
2. Log in to Cloudflare (opens a browser):
   ```bash
   npx wrangler login
   ```
3. Deploy. Copy the `https://github-discord-relay.<name>.workers.dev` URL it prints:
   ```bash
   npx wrangler deploy
   ```
4. Generate a webhook secret and copy it:
   ```bash
   openssl rand -hex 32
   ```
5. Store the secret on the Worker (paste it when asked):
   ```bash
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   ```
6. Store the Discord webhook URL on the Worker. Paste it **without** `/github` on the end:
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```
7. In GitHub, go to **Org Settings → Webhooks**, click **Edit** on the existing webhook, and set:
   - **Payload URL:** the Worker URL from step 3
   - **Content type:** `application/json`
   - **Secret:** the value from step 4
   - Click **Update webhook**.
8. Check **Recent Deliveries**. Redeliver the latest event: it should return `200` (posted) or `202` (ignored).

To change the formatting later, edit `src/index.js`, run `npm test`, then `npx wrangler deploy` again.

## Notes

- Requests without a valid GitHub signature are rejected, so the public Worker URL can't be used to post to Discord.
- This folder sits in the website repo, so the static host will serve these files publicly. They hold no secrets.
