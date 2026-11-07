# GitHub → Discord relay

A Cloudflare Worker that:

- turns the org-level GitHub webhook into short Discord messages: one summary line, with the
  technical details behind a spoiler that viewers click to reveal;
- shows people by their Discord name, using a GitHub → Discord roster;
- lets new members link their own GitHub account with **Sign in with GitHub**, which gives them a
  **Verified** role that unlocks the server;
- alerts admins when a linked member leaves the Discord server.

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
4. Generate a webhook secret and copy it (works in PowerShell, macOS and Linux):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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

## Show Discord names

Messages show the GitHub username by default. To show people's Discord names instead, keep a
roster of GitHub username → Discord user ID in Cloudflare. Mentions show the person's current
Discord server name and never ping them. Anyone not in the roster shows their GitHub username marked
*(unlinked)*, as a nudge to verify. Bots are never marked.

The roster lives in Cloudflare, not in this repo, because the repo is public.

Once verification is set up (below), members add themselves. The manual commands here still work
for anyone you want to add by hand.

**Roster setup.** The roster already exists, and its id is in `wrangler.toml`. Only if you ever
rebuild it from scratch (for example, on a different Cloudflare account): run
`npx wrangler kv namespace create PEOPLE`, put the new id in `wrangler.toml`, and run
`npx wrangler deploy`.

**Get someone's Discord user ID**

1. In Discord, go to **User Settings → Advanced** and turn on **Developer Mode**.
2. Right-click the person's name and click **Copy User ID**.

**Add or update a person.** Use their GitHub username in lowercase, then their Discord ID. Anything
after the ID is a note for your own reference, like their name:

```bash
npx wrangler kv key put --binding PEOPLE --remote "octocat" "123456789012345678 Warren"
```

**See who's in the roster**

```bash
npx wrangler kv key list --binding PEOPLE --remote
```

You can also browse and edit it in the Cloudflare dashboard: **Storage & Databases → KV → PEOPLE**.

**Remove a person**

```bash
npx wrangler kv key delete --binding PEOPLE --remote "octocat"
```

Roster changes take effect within about a minute. You don't need to redeploy.

## Verify members with GitHub

New members land in a **#verify** channel, click **Verify GitHub**, and sign in on GitHub's own
page. The Worker gets their GitHub username (never their password), adds them to the roster, gives
them the **Verified** role, and posts a note in a private admin channel. It then revokes the GitHub
authorization, so no token is kept.

Every 15 minutes it also checks the Discord member list. If a linked member has left or been
removed, it alerts the admin channel with a link to review their GitHub org access. It never
removes anyone from GitHub itself.

The roster must be connected first (see "Show Discord names"). In Discord, turn on **User Settings → Advanced →
Developer Mode** so you can copy IDs.

**1. Create the Discord bot**

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it
   (for example, "Daedalus").
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On **Bot**, click **Reset Token** and copy the token. Under **Privileged Gateway Intents**, turn
   on **Server Members Intent** and save.
4. On **OAuth2 → URL Generator**, tick **bot** and **applications.commands**. Under bot
   permissions, tick **Manage Roles**, **View Channels** and **Send Messages**. Open the URL it
   generates and add the bot to your server.

**2. Set up the server**

1. **Server Settings → Roles:** create a role named **Verified**. Drag the bot's role **above**
   Verified, or the bot can't assign it. Right-click Verified and **Copy Role ID**.
2. Create a **#verify** text channel. Right-click it and **Copy Channel ID**.
3. Create a private admin channel. In its settings, go to **Integrations → Webhooks → New Webhook**
   and **Copy Webhook URL**.
4. Right-click the server icon and **Copy Server ID**.

Don't lock the other channels yet. That comes last, after everyone has verified.

**3. Create the GitHub sign-in app**

1. Go to **GitHub → Org Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Application name:** Daedalus Discord Verify. **Homepage URL:** `https://daedalusdatalabs.com`.
   **Authorization callback URL:** `https://<your-worker-url>/auth/callback`.
3. Click **Register application** and copy the **Client ID**. Click **Generate a new client secret**
   and copy it.

**4. Save the values on the Worker.** Run each command and paste the value when asked:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
```
```bash
npx wrangler secret put DISCORD_BOT_TOKEN
```
```bash
npx wrangler secret put DISCORD_GUILD_ID
```
```bash
npx wrangler secret put DISCORD_VERIFIED_ROLE_ID
```
```bash
npx wrangler secret put DISCORD_ADMIN_WEBHOOK_URL
```
```bash
npx wrangler secret put GITHUB_CLIENT_ID
```
```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Then deploy:

```bash
npx wrangler deploy
```

**5. Connect Discord to the Worker**

1. In the Discord Developer Portal, on **General Information**, set **Interactions Endpoint URL** to
   `https://<your-worker-url>/discord` and save. Discord tests it straight away. If it won't save,
   check `DISCORD_PUBLIC_KEY`.
2. Register `/verify` and post the Verify panel in #verify (it asks for the Application ID, bot
   token, server ID and #verify channel ID):
   ```bash
   node scripts/setup-discord.mjs
   ```

**6. Test it, then lock the server**

1. Click **Verify GitHub** in #verify and finish the sign-in. You should get the Verified role, and
   a ✅ note should appear in the admin channel.
2. Ask existing members to verify too.
3. Once they have, lock the server:
   - **Server Settings → Roles → @everyone:** turn off **View Channels**.
   - **Verified role:** turn on **View Channels**.
   - **#verify → Edit Channel → Permissions:** for @everyone, allow **View Channel** and deny
     **Send Messages**.

Members who leave Discord lose the Verified role automatically. Someone who returns clicks
**Verify GitHub** again.

## Changing the relay

To change the formatting later, edit `src/index.js`, run `npm test`, then `npx wrangler deploy` again.

## Notes

- Requests without a valid GitHub or Discord signature are rejected, so the public Worker URL can't be used to post to Discord.
- Verify links are signed, are tied to the Discord account that clicked, and expire after 10 minutes.
- This folder sits in the website repo, so the static host will serve these files publicly. They hold no secrets.
