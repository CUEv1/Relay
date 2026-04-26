# Twitch Live Discord Bot Dashboard

A Node.js Discord bot with a local web dashboard for managing Twitch live notifications.

## Features

- Route each Twitch live alert to a different Discord channel.
- Pick Discord channels grouped by server, with unusable channels hidden or warned.
- Pick Discord role mentions from a dropdown.
- Log in to the dashboard with a username and password.
- Use Twitch EventSub WebSocket for near real-time online/offline events when using a Twitch user access token.
- Keep polling as a fallback and for periodic status refreshes.
- Show live/offline status for configured Twitch users.
- Store notification history.
- Show an error panel for Twitch, Discord, permission, dashboard, and EventSub failures.
- Send test alerts that match the real live notification format.

## Setup

1. Install Node.js 18 or newer.
2. Install dependencies:

   ```powershell
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in the required values.
4. Invite the Discord bot to your server with permission to view channels, send messages, embed links, and mention the roles you choose.
5. Start the bot and dashboard:

   ```powershell
   npm start
   ```

6. Open the dashboard:

   ```text
   http://127.0.0.1:3000
   ```

## Required Environment Variables

`DISCORD_TOKEN` is the bot token from the Discord Developer Portal.

Set `TWITCH_ACCESS_TOKEN` if you already have a Twitch user access token. This is required for EventSub WebSocket mode.

Alternatively, set both `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` from a Twitch application in the Twitch Developer Console. This supports polling, but EventSub WebSocket subscriptions require a user access token.

Twitch users do not need to be set in `.env`. Add and edit them from the dashboard.

## Dashboard Environment Variables

`DASHBOARD_HOST` defaults to `127.0.0.1`.

`DASHBOARD_PORT` defaults to `3000`.

`DASHBOARD_USERNAME` defaults to `admin`.

`DASHBOARD_PASSWORD` enables the dashboard login page. Set this before running the dashboard anywhere other than your own computer.

`SESSION_SECRET` signs dashboard session cookies. Use a long random value.

`EVENTSUB_ENABLED` defaults to `true`. Set it to `false` to use polling only.

If `DASHBOARD_HOST` is changed away from `127.0.0.1`, keep `DASHBOARD_PASSWORD` set. The app refuses to start on a non-local dashboard host without a password.

Do not store real tokens in `TOKENS.txt` or source files. Use `.env`, and rotate any token or client secret that was pasted into chat or saved in plain text.

## Optional First-Run Seed Values

These are only used when `data/dashboard-config.json` does not exist yet:

```env
DISCORD_CHANNEL_ID=your_discord_channel_id
TWITCH_USER_LOGINS=shroud,pokimane,twitchdev
DISCORD_ROLE_ID=
POLL_INTERVAL_SECONDS=60
```

After the first run, use the dashboard. The bot saves live notification settings to `data/dashboard-config.json`. You can leave `TWITCH_USER_LOGINS` blank and add users from the website instead.

## Files

`src/index.js` runs the Discord bot, Twitch polling, EventSub WebSocket client, dashboard API, session login, and static dashboard server.

`public/` contains the dashboard and login page HTML, CSS, and browser JavaScript.

`data/dashboard-config.json` stores notification routes.

`data/live-state.json` stores stream IDs that have already been announced.

`data/live-status.json` stores current live/offline dashboard status.

`data/history.json` stores recent alerts and stream events.

`data/errors.json` stores recent operational errors.

## Commands

```powershell
npm start
npm run check
```

## Windows Installer

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\installer\install.ps1
```

See `installer/INSTALL.md` for details.

## Official References

- Twitch Get Streams: https://dev.twitch.tv/docs/api/reference/#get-streams
- Twitch EventSub WebSockets: https://dev.twitch.tv/docs/eventsub/handling-websocket-events
- Twitch Create EventSub Subscription: https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription
- Twitch stream.online and stream.offline: https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#stream-online
- discord.js gateway intents: https://discordjs.guide/popular-topics/intents.html
