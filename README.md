# Stream Notifications Discord Bot Dashboard

A Node.js Discord bot with a local web dashboard for managing Twitch live notifications and YouTube upload notifications.

## Features

- Route each Twitch live alert or YouTube upload alert to a different Discord channel.
- Pick Discord channels grouped by server, with unusable channels hidden or warned.
- Pick Discord role mentions from a dropdown.
- Log in to the dashboard with a username and password.
- Use Twitch EventSub WebSocket for near real-time Twitch online/offline events when using a Twitch user access token.
- Keep polling as a fallback and for periodic status refreshes.
- Show live/offline status for configured Twitch users and latest-video status for YouTube channels.
- Optionally open selected Twitch channels or YouTube videos in Chrome when notifications fire, with new Twitch alerts opened in the background when another Twitch tab is active.
- Store notification history.
- Show an error panel for Twitch, Discord, permission, dashboard, and EventSub failures.
- Send test alerts that match the real live notification format.
- Use `/purge count:<number>` to delete 1-100 recent messages from a channel.

## Setup

1. Install Node.js 18 or newer.
2. Install dependencies:

   ```powershell
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in the required values.
4. Invite the Discord bot to your server with `bot` and `applications.commands` scopes. Give it permission to view channels, send messages, embed links, read message history, manage messages, and mention the roles you choose.
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

Twitch credentials are only required if you enable Twitch routes. YouTube upload notifications use the channel RSS feed and do not require a YouTube API key.

Twitch users and YouTube channels do not need to be set in `.env`. Add and edit them from the dashboard. YouTube routes accept channel URLs such as `https://www.youtube.com/@handle`, `/channel/UC...` URLs, or a channel ID such as `UC...`; the bot resolves URLs to channel IDs when you save.

## Dashboard Environment Variables

`DASHBOARD_HOST` defaults to `127.0.0.1`.

`DASHBOARD_PORT` defaults to `3000`.

`DASHBOARD_USERNAME` defaults to `admin`.

`DASHBOARD_PASSWORD` enables the dashboard login page. Set this before running the dashboard anywhere other than your own computer.

`SESSION_SECRET` signs dashboard session cookies. Use a long random value.

`EVENTSUB_ENABLED` defaults to `true`. Set it to `false` to use polling only.

`BROWSER_REMOTE_DEBUGGING_PORT` defaults to `9222`. Set it to `0` to disable Chrome background-tab control for Twitch browser opens.

If Chrome was already running without remote debugging, restart Chrome once after enabling browser opens so the bot can create background tabs.

If `DASHBOARD_HOST` is changed away from `127.0.0.1`, keep `DASHBOARD_PASSWORD` set. The app refuses to start on a non-local dashboard host without a password.

Do not store real tokens in `TOKENS.txt` or source files. Use `.env`, and rotate any token or client secret that was pasted into chat or saved in plain text.

## Optional First-Run Seed Values

These are only used when `data/dashboard-config.json` does not exist yet:

```env
DISCORD_CHANNEL_ID=your_discord_channel_id
TWITCH_USER_LOGINS=shroud,pokimane,twitchdev
YOUTUBE_CHANNEL_IDS=UC_x5XG1OV2P6uZZ5FSM9Ttw
DISCORD_ROLE_ID=
POLL_INTERVAL_SECONDS=10
```

After the first run, use the dashboard. The bot saves notification settings to `data/dashboard-config.json`. You can leave seed values blank and add routes from the website instead.

## Files

`src/index.js` runs the Discord bot, Twitch polling, YouTube feed polling, EventSub WebSocket client, dashboard API, session login, and static dashboard server.

`public/` contains the dashboard and login page HTML, CSS, and browser JavaScript.

`data/dashboard-config.json` stores notification routes.

`data/live-state.json` stores stream or video IDs that have already been announced.

`data/live-status.json` stores current live/offline dashboard status.

`data/history.json` stores recent alerts and stream events.

`data/errors.json` stores recent operational errors.

## Commands

```powershell
npm start
npm run check
```

## Start Automatically On Windows Login

Run this from the project root:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\installer\enable-startup.ps1
```

This creates a Windows Scheduled Task named `Twitch Live Discord Bot` that starts the bot when the current Windows user logs in. Startup output is written to `logs\startup.log`.

To remove the startup task:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\installer\disable-startup.ps1
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
- YouTube channel feeds: `https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID`
- discord.js gateway intents: https://discordjs.guide/popular-topics/intents.html
