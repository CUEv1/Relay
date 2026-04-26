import 'dotenv/config';
import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';
const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const EVENTSUB_SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_HISTORY_ITEMS = 100;
const MAX_ERROR_ITEMS = 100;
const SESSION_COOKIE = 'dashboard_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const TWITCH_LOGIN_CHUNK_SIZE = 100;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const SENDABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildAnnouncement,
  ChannelType.GuildText,
]);

const env = loadEnv();
const sessions = new Map();
const loginAttempts = new Map();
const twitchUsersByLogin = new Map();
const eventMessageIds = new Set();
const eventMessageIdQueue = [];
const pendingAnnouncements = new Set();
const writeQueues = new Map();

let dashboardConfig = null;
let twitchToken = null;
let twitchTokenExpiresAt = 0;
let twitchTokenInfo = null;
let liveState = {};
let liveStatus = {};
let history = [];
let errorLog = [];
let isChecking = false;
let isShuttingDown = false;
let pollTimer = null;
let eventSubSocket = null;
let eventSubReconnectTimer = null;
let eventSubKeepAliveTimer = null;
let eventSubKeepAliveTimeoutMs = 45_000;
let eventSubSessionId = null;
let eventSubSubscriptions = new Map();
let eventSubStatus = {
  enabled: false,
  connected: false,
  mode: 'polling',
  sessionId: null,
  subscriptions: 0,
  lastMessageAt: null,
  lastSubscribedAt: null,
  error: null,
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initializeTwitchAuth();
  dashboardConfig = await loadDashboardConfig();
  liveState = await readJsonFile(env.stateFile, {});
  liveStatus = await readJsonFile(env.statusFile, {});
  history = await readJsonFile(env.historyFile, []);
  errorLog = await readJsonFile(env.errorFile, []);
  startPolling();
  startDashboardServer();
  await checkStreams('startup');
  startEventSub();
});

client.on('error', (error) => {
  void recordError('discord', 'Discord client error.', { error: error.message });
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  void recordError('process', 'Unhandled promise rejection.', { error: message });
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await client.login(env.discordToken);

function loadEnv() {
  const missing = ['DISCORD_TOKEN'].filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const twitchAccessToken = process.env.TWITCH_ACCESS_TOKEN?.trim() || '';
  const twitchClientId = process.env.TWITCH_CLIENT_ID?.trim() || '';
  const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET?.trim() || '';
  const hasClientCredentials = Boolean(twitchClientId && twitchClientSecret);

  if (!twitchAccessToken && !hasClientCredentials) {
    throw new Error(
      'Set TWITCH_ACCESS_TOKEN, or set both TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.',
    );
  }

  const dashboardPassword = process.env.DASHBOARD_PASSWORD?.trim() || '';
  const sessionSecret = process.env.SESSION_SECRET?.trim() ||
    dashboardPassword ||
    randomBytes(32).toString('hex');
  const dashboardHost = process.env.DASHBOARD_HOST?.trim() || '127.0.0.1';

  if (!dashboardPassword && !isLocalDashboardHost(dashboardHost)) {
    throw new Error('Set DASHBOARD_PASSWORD before binding the dashboard to a non-local host.');
  }

  return {
    discordToken: process.env.DISCORD_TOKEN.trim(),
    twitchAccessToken,
    twitchClientId,
    twitchClientSecret,
    eventSubEnabled: process.env.EVENTSUB_ENABLED?.trim() !== 'false',
    dashboardHost,
    dashboardPort: Number.parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    dashboardUsername: process.env.DASHBOARD_USERNAME?.trim() || 'admin',
    dashboardPassword,
    sessionSecret,
    configFile: resolveProjectPath(
      process.env.CONFIG_FILE?.trim() || './data/dashboard-config.json',
    ),
    stateFile: resolveProjectPath(
      process.env.STATE_FILE?.trim() || './data/live-state.json',
    ),
    statusFile: resolveProjectPath(
      process.env.STATUS_FILE?.trim() || './data/live-status.json',
    ),
    historyFile: resolveProjectPath(
      process.env.HISTORY_FILE?.trim() || './data/history.json',
    ),
    errorFile: resolveProjectPath(
      process.env.ERROR_FILE?.trim() || './data/errors.json',
    ),
  };
}

async function initializeTwitchAuth() {
  if (!env.twitchAccessToken) {
    return;
  }

  twitchToken = env.twitchAccessToken;
  const validation = await validateTwitchAccessToken(twitchToken);
  twitchTokenInfo = validation;

  if (!env.twitchClientId) {
    env.twitchClientId = validation.client_id;
  }

  twitchTokenExpiresAt = Date.now() + validation.expires_in * 1000;
  console.log(
    `Using provided Twitch access token for client ${env.twitchClientId}; expires in ${validation.expires_in} seconds.`,
  );
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function isLocalDashboardHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

async function loadDashboardConfig() {
  const fallback = createConfigFromEnv();
  const loaded = await readJsonFile(env.configFile, fallback);
  const normalized = normalizeConfig(loaded);
  await writeJsonFile(env.configFile, normalized);
  return normalized;
}

function createConfigFromEnv() {
  const loginsRaw = process.env.TWITCH_USER_LOGINS || process.env.TWITCH_USER_LOGIN || '';
  const twitchLogins = loginsRaw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  const seededLogins = twitchLogins.length > 0 || !twitchTokenInfo?.login
    ? twitchLogins
    : [twitchTokenInfo.login];

  const defaultChannelId = process.env.DISCORD_CHANNEL_ID?.trim() || '';
  const defaultRoleId = process.env.DISCORD_ROLE_ID?.trim() || '';
  const notifications = [...new Set(seededLogins)].map((login) => ({
    id: createNotificationId(),
    twitchLogin: login,
    discordChannelId: defaultChannelId,
    discordRoleId: defaultRoleId,
    enabled: Boolean(defaultChannelId),
  }));

  return {
    pollIntervalSeconds: parsePollInterval(process.env.POLL_INTERVAL_SECONDS || '60'),
    notifications,
  };
}

function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const pollIntervalSeconds = parsePollInterval(source.pollIntervalSeconds);
  const seenIds = new Set();
  const notifications = Array.isArray(source.notifications)
    ? source.notifications.map((item) => normalizeNotification(item, seenIds))
    : [];

  return { pollIntervalSeconds, notifications };
}

function normalizeNotification(item, seenIds = new Set()) {
  const source = item && typeof item === 'object' ? item : {};
  let id = sanitizeId(source.id);

  if (!id || seenIds.has(id)) {
    id = createNotificationId();
  }

  seenIds.add(id);

  return {
    id,
    twitchLogin: normalizeTwitchLogin(source.twitchLogin),
    discordChannelId: String(source.discordChannelId || '').trim(),
    discordRoleId: String(source.discordRoleId || '').trim(),
    enabled: Boolean(source.enabled),
  };
}

function parsePollInterval(value) {
  const parsed = Number.parseInt(value || '60', 10);
  if (Number.isNaN(parsed)) {
    return 60;
  }
  return Math.max(MIN_POLL_INTERVAL_SECONDS, parsed);
}

function normalizeTwitchLogin(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
}

function sanitizeId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9-]{6,64}$/i.test(id) ? id : '';
}

function createNotificationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    void checkStreams('polling');
  }, dashboardConfig.pollIntervalSeconds * 1000);
  console.log(`Polling Twitch every ${dashboardConfig.pollIntervalSeconds} seconds.`);
}

async function checkStreams(source = 'polling') {
  if (isChecking || !dashboardConfig) {
    return false;
  }

  isChecking = true;

  try {
    const notifications = getActiveNotifications();
    const logins = [...new Set(notifications.map((notification) => notification.twitchLogin))];
    const liveStreams = await getLiveStreams(logins);
    const previousLiveStatus = structuredClone(liveStatus);
    await updateLiveStatusesFromStreams(logins, liveStreams, source);
    const liveByLogin = new Map(
      liveStreams.map((stream) => [stream.user_login.toLowerCase(), stream]),
    );

    for (const notification of notifications) {
      const stream = liveByLogin.get(notification.twitchLogin);

      if (!stream) {
        if (clearLiveState(notification)) {
          await writeJsonFile(env.stateFile, liveState);
        }
        continue;
      }

      if (hasLiveStateForStream(notification, stream)) {
        continue;
      }

      if (source === 'startup' && wasAlreadyLiveBeforeRestart(previousLiveStatus, notification, stream)) {
        setLiveState(notification, stream, source);
        await writeJsonFile(env.stateFile, liveState);
        continue;
      }

      await announceForNotification(stream, notification, source);
    }
  } catch (error) {
    await recordError('twitch', 'Live check failed.', { error: error.message });
  } finally {
    isChecking = false;
  }

  return true;
}

function getActiveNotifications() {
  return dashboardConfig.notifications.filter((notification) => (
    notification.enabled &&
    notification.twitchLogin &&
    notification.discordChannelId
  ));
}

async function getLiveStreams(userLogins) {
  if (userLogins.length === 0) {
    return [];
  }

  const token = await getTwitchAccessToken();
  const streams = [];

  for (const loginChunk of chunkArray(userLogins, TWITCH_LOGIN_CHUNK_SIZE)) {
    const params = new URLSearchParams();

    for (const login of loginChunk) {
      params.append('user_login', login);
    }

    const response = await fetch(`${TWITCH_STREAMS_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': env.twitchClientId,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Twitch streams request failed: ${response.status} ${body}`);
    }

    const payload = await response.json();
    streams.push(...(Array.isArray(payload.data) ? payload.data : []));
  }

  return streams;
}

async function getTwitchUsers(userLogins) {
  const missingLogins = userLogins
    .map(normalizeTwitchLogin)
    .filter((login) => login && !twitchUsersByLogin.has(login));

  if (missingLogins.length === 0) {
    return new Map(userLogins.map((login) => [login, twitchUsersByLogin.get(login)]));
  }

  const token = await getTwitchAccessToken();
  const params = new URLSearchParams();

  for (const login of [...new Set(missingLogins)]) {
    params.append('login', login);
  }

  const response = await fetch(`${TWITCH_USERS_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': env.twitchClientId,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch users request failed: ${response.status} ${body}`);
  }

  const payload = await response.json();

  for (const user of payload.data || []) {
    twitchUsersByLogin.set(user.login.toLowerCase(), user);
  }

  return new Map(
    userLogins.map((login) => [login, twitchUsersByLogin.get(normalizeTwitchLogin(login))]),
  );
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function getTwitchAccessToken() {
  const now = Date.now();
  if (twitchToken && now < twitchTokenExpiresAt - 60_000) {
    return twitchToken;
  }

  if (!env.twitchClientId || !env.twitchClientSecret) {
    throw new Error(
      'The provided TWITCH_ACCESS_TOKEN has expired or could not be refreshed. Set a new TWITCH_ACCESS_TOKEN or add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.',
    );
  }

  const body = new URLSearchParams({
    client_id: env.twitchClientId,
    client_secret: env.twitchClientSecret,
    grant_type: 'client_credentials',
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Twitch token request failed: ${response.status} ${responseBody}`);
  }

  const payload = await response.json();
  twitchToken = payload.access_token;
  if (twitchTokenInfo?.user_id) {
    stopEventSub('EventSub user token expired. Polling remains active.');
  }
  twitchTokenInfo = null;
  twitchTokenExpiresAt = now + payload.expires_in * 1000;

  return twitchToken;
}

async function validateTwitchAccessToken(token) {
  const response = await fetch(TWITCH_VALIDATE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Authorization: `OAuth ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch access token validation failed: ${response.status} ${body}`);
  }

  const payload = await response.json();

  if (!payload.client_id || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new Error('Twitch access token validation returned an invalid token.');
  }

  return payload;
}

async function announceForNotification(stream, notification, source) {
  const reservationKey = getAnnouncementReservationKey(notification, stream);

  if (pendingAnnouncements.has(reservationKey) || hasLiveStateForStream(notification, stream)) {
    return;
  }

  pendingAnnouncements.add(reservationKey);

  try {
    await announceLive(stream, notification, { source });
    setLiveState(notification, stream, source);
    await writeJsonFile(env.stateFile, liveState);
  } catch (error) {
    await recordError('discord', `Failed to announce ${notification.twitchLogin}.`, {
      channelId: notification.discordChannelId,
      error: error.message,
    });
  } finally {
    pendingAnnouncements.delete(reservationKey);
  }
}

function getAnnouncementReservationKey(notification, stream) {
  return `${getLiveStateKey(notification)}:${stream.id}`;
}

function getLiveStateKey(notification) {
  return [
    normalizeTwitchLogin(notification.twitchLogin),
    notification.discordChannelId,
    notification.discordRoleId || 'none',
  ].join(':');
}

function getLiveStateEntry(notification) {
  return liveState[getLiveStateKey(notification)] || liveState[notification.id] || null;
}

function setLiveState(notification, stream, source) {
  const entry = {
    streamId: stream.id,
    twitchLogin: notification.twitchLogin,
    discordChannelId: notification.discordChannelId,
    discordRoleId: notification.discordRoleId,
    announcedAt: new Date().toISOString(),
    source,
  };

  liveState[getLiveStateKey(notification)] = entry;

  if (liveState[notification.id]) {
    delete liveState[notification.id];
  }
}

function clearLiveState(notification) {
  const keys = [getLiveStateKey(notification), notification.id];
  let changed = false;

  for (const key of keys) {
    if (liveState[key]) {
      delete liveState[key];
      changed = true;
    }
  }

  return changed;
}

function hasLiveStateForStream(notification, stream) {
  const entry = getLiveStateEntry(notification);
  return Boolean(
    entry?.streamId === stream.id &&
    entry?.discordChannelId === notification.discordChannelId &&
    entry?.discordRoleId === notification.discordRoleId
  );
}

function wasAlreadyLiveBeforeRestart(statusSnapshot, notification, stream) {
  const status = statusSnapshot[normalizeTwitchLogin(notification.twitchLogin)];

  if (!status?.isLive || !status.lastAnnouncedAt) {
    return false;
  }

  if (status.startedAt && stream.started_at) {
    return new Date(status.startedAt).getTime() === new Date(stream.started_at).getTime();
  }

  return status.streamUrl === `https://www.twitch.tv/${stream.user_login}`;
}

async function announceLive(stream, notification, options = {}) {
  const channel = await client.channels.fetch(notification.discordChannelId);

  if (!channel || !channel.isTextBased() || channel.type === ChannelType.DM) {
    throw new Error(`Discord channel ${notification.discordChannelId} is not a server text channel.`);
  }

  const streamUrl = `https://www.twitch.tv/${stream.user_login}`;
  const thumbnailUrl = stream.thumbnail_url
    ?.replace('{width}', '1280')
    .replace('{height}', '720');
  const cacheBustedThumbnail = thumbnailUrl
    ? `${thumbnailUrl}?t=${encodeURIComponent(stream.started_at || Date.now())}`
    : null;

  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setTitle(`${stream.user_name} is live on Twitch`)
    .setURL(streamUrl)
    .setDescription(stream.title || 'Untitled stream')
    .addFields(
      { name: 'Category', value: stream.game_name || 'No category', inline: true },
      { name: 'Viewers', value: String(stream.viewer_count ?? 0), inline: true },
    )
    .setTimestamp(new Date(stream.started_at || Date.now()))
    .setFooter({ text: 'Twitch live alert' });

  if (cacheBustedThumbnail) {
    embed.setImage(cacheBustedThumbnail);
  }

  const content = notification.discordRoleId
    ? `<@&${notification.discordRoleId}> ${stream.user_name} is live: ${streamUrl}`
    : `${stream.user_name} is live: ${streamUrl}`;

  await channel.send({
    content,
    embeds: [embed],
    allowedMentions: notification.discordRoleId
      ? { roles: [notification.discordRoleId] }
      : { parse: [] },
  });

  await appendHistory({
    type: options.test ? 'test_alert' : 'live_alert',
    source: options.source || 'unknown',
    twitchLogin: stream.user_login,
    displayName: stream.user_name,
    discordChannelId: notification.discordChannelId,
    discordChannelName: channel.name,
    discordGuildName: channel.guild?.name || '',
    title: stream.title || 'Untitled stream',
    gameName: stream.game_name || 'No category',
    viewerCount: stream.viewer_count ?? 0,
    streamUrl,
    sentAt: new Date().toISOString(),
  });

  const login = stream.user_login.toLowerCase();
  liveStatus[login] = {
    ...(liveStatus[login] || {}),
    twitchLogin: login,
    displayName: stream.user_name,
    isLive: true,
    title: stream.title || 'Untitled stream',
    gameName: stream.game_name || 'No category',
    viewerCount: stream.viewer_count ?? 0,
    startedAt: stream.started_at || null,
    lastAnnouncedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    source: options.source || 'unknown',
    streamUrl,
  };
  await writeJsonFile(env.statusFile, liveStatus);

  console.log(`Announced live stream for ${stream.user_login} (${stream.id}).`);
}

async function updateLiveStatusesFromStreams(logins, streams, source) {
  const checkedAt = new Date().toISOString();
  const streamByLogin = new Map(
    streams.map((stream) => [stream.user_login.toLowerCase(), stream]),
  );

  for (const login of logins) {
    const stream = streamByLogin.get(login);

    if (!stream) {
      liveStatus[login] = {
        ...(liveStatus[login] || {}),
        twitchLogin: login,
        displayName: liveStatus[login]?.displayName || login,
        isLive: false,
        title: '',
        gameName: '',
        viewerCount: 0,
        startedAt: null,
        lastCheckedAt: checkedAt,
        source,
        streamUrl: `https://www.twitch.tv/${login}`,
      };
      continue;
    }

    liveStatus[login] = {
      ...(liveStatus[login] || {}),
      twitchLogin: login,
      displayName: stream.user_name,
      isLive: true,
      title: stream.title || 'Untitled stream',
      gameName: stream.game_name || 'No category',
      viewerCount: stream.viewer_count ?? 0,
      startedAt: stream.started_at || null,
      lastCheckedAt: checkedAt,
      source,
      streamUrl: `https://www.twitch.tv/${login}`,
    };
  }

  await writeJsonFile(env.statusFile, liveStatus);
}

function startEventSub() {
  if (!env.eventSubEnabled) {
    eventSubStatus = { ...eventSubStatus, enabled: false, mode: 'disabled' };
    return;
  }

  if (getActiveNotifications().length === 0) {
    eventSubStatus = {
      ...eventSubStatus,
      enabled: false,
      connected: false,
      mode: 'polling',
      error: 'EventSub waits until at least one active notification route exists.',
    };
    return;
  }

  if (!twitchTokenInfo?.user_id) {
    eventSubStatus = {
      ...eventSubStatus,
      enabled: false,
      mode: 'polling',
      error: 'EventSub WebSocket requires a Twitch user access token. Polling remains active.',
    };
    void recordError('eventsub', eventSubStatus.error);
    return;
  }

  eventSubStatus = { ...eventSubStatus, enabled: true, mode: 'websocket', error: null };
  connectEventSub(EVENTSUB_WS_URL);
}

function connectEventSub(url, oldSocket = null) {
  if (isShuttingDown) {
    return;
  }

  if (!oldSocket && eventSubSocket) {
    eventSubSocket.removeAllListeners();
    eventSubSocket.close();
  }

  clearEventSubKeepAliveTimer();

  const socket = new WebSocket(url);
  eventSubSocket = socket;

  socket.on('open', () => {
    eventSubStatus = { ...eventSubStatus, connected: true, error: null };
  });

  socket.on('message', (data) => {
    void handleEventSubMessage(socket, data, oldSocket);
  });

  socket.on('error', (error) => {
    eventSubStatus = { ...eventSubStatus, error: error.message };
    void recordError('eventsub', 'EventSub socket error.', { error: error.message });
  });

  socket.on('close', (code, reason) => {
    if (socket !== eventSubSocket || isShuttingDown) {
      return;
    }

    eventSubStatus = {
      ...eventSubStatus,
      connected: false,
      sessionId: null,
      subscriptions: 0,
      error: `Socket closed: ${code} ${reason.toString()}`,
    };
    eventSubSessionId = null;
    eventSubSubscriptions = new Map();
    clearEventSubKeepAliveTimer();

    if (getActiveNotifications().length > 0) {
      scheduleEventSubReconnect();
    }
  });
}

async function handleEventSubMessage(socket, data, oldSocket) {
  let message;

  try {
    message = JSON.parse(data.toString());
  } catch (error) {
    await recordError('eventsub', 'Invalid EventSub message.', { error: error.message });
    return;
  }

  const messageType = message.metadata?.message_type;
  eventSubStatus = {
    ...eventSubStatus,
    connected: true,
    lastMessageAt: new Date().toISOString(),
  };
  resetEventSubKeepAliveTimer();

  if (messageType === 'session_welcome') {
    eventSubSessionId = message.payload.session.id;
    eventSubKeepAliveTimeoutMs =
      (message.payload.session.keepalive_timeout_seconds || 30) * 1000 + 5_000;
    eventSubStatus = {
      ...eventSubStatus,
      sessionId: eventSubSessionId,
      connected: true,
      error: null,
    };

    if (oldSocket && oldSocket.readyState === WebSocket.OPEN) {
      oldSocket.close(1000, 'Reconnected');
    }

    await refreshEventSubSubscriptions();
    return;
  }

  if (messageType === 'session_reconnect') {
    const reconnectUrl = message.payload.session.reconnect_url;
    connectEventSub(reconnectUrl, socket);
    return;
  }

  if (messageType === 'notification') {
    await handleEventSubNotification(message);
    return;
  }

  if (messageType === 'revocation') {
    await recordError('eventsub', 'EventSub subscription was revoked.', {
      status: message.payload?.subscription?.status,
      type: message.payload?.subscription?.type,
    });
  }
}

function scheduleEventSubReconnect() {
  if (eventSubReconnectTimer || !env.eventSubEnabled || isShuttingDown) {
    return;
  }

  eventSubReconnectTimer = setTimeout(() => {
    eventSubReconnectTimer = null;
    connectEventSub(EVENTSUB_WS_URL);
  }, 10_000);
}

function restartEventSub() {
  stopEventSub('EventSub restarting after config change.');
  startEventSub();
}

function pruneLiveStateForConfig(config) {
  const validKeys = new Set(
    config.notifications.flatMap((notification) => [
      notification.id,
      getLiveStateKey(notification),
    ]),
  );

  for (const [id, entry] of Object.entries(liveState)) {
    const notification = config.notifications.find((item) => (
      item.id === id || getLiveStateKey(item) === id
    ));
    if (
      !validKeys.has(id) ||
      !notification ||
      normalizeTwitchLogin(entry.twitchLogin) !== normalizeTwitchLogin(notification.twitchLogin) ||
      entry.discordChannelId !== notification.discordChannelId ||
      entry.discordRoleId !== notification.discordRoleId
    ) {
      delete liveState[id];
    }
  }
}

async function refreshEventSubSubscriptions() {
  if (!eventSubSessionId || !twitchTokenInfo?.user_id) {
    return;
  }

  const logins = [...new Set(getActiveNotifications().map((notification) => notification.twitchLogin))];

  if (logins.length === 0) {
    stopEventSub('No active notification routes.');
    return;
  }

  const users = await getTwitchUsers(logins);
  const desiredKeys = new Set();

  for (const [login, user] of users) {
    if (!user?.id) {
      await recordError('eventsub', `Twitch user not found: ${login}`);
      continue;
    }

    desiredKeys.add(`stream.online:${user.id}`);
    desiredKeys.add(`stream.offline:${user.id}`);
    await createEventSubSubscription('stream.online', user.id, login);
    await createEventSubSubscription('stream.offline', user.id, login);
  }

  for (const key of [...eventSubSubscriptions.keys()]) {
    if (!desiredKeys.has(key)) {
      eventSubSubscriptions.delete(key);
    }
  }

  eventSubStatus = {
    ...eventSubStatus,
    subscriptions: eventSubSubscriptions.size,
    lastSubscribedAt: new Date().toISOString(),
  };
}

async function createEventSubSubscription(type, broadcasterUserId, login) {
  const key = `${type}:${broadcasterUserId}`;

  if (eventSubSubscriptions.has(key)) {
    return;
  }

  const token = await getEventSubAccessToken();
  const response = await fetch(EVENTSUB_SUBSCRIPTIONS_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': env.twitchClientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type,
      version: '1',
      condition: {
        broadcaster_user_id: broadcasterUserId,
      },
      transport: {
        method: 'websocket',
        session_id: eventSubSessionId,
      },
    }),
  });

  if (!response.ok && response.status !== 409) {
    const body = await response.text();
    await recordError('eventsub', `Failed to create ${type} subscription for ${login}.`, {
      status: response.status,
      body,
    });
    return;
  }

  const payload = response.status === 409 ? { data: [{ id: 'existing' }] } : await response.json();
  eventSubSubscriptions.set(key, {
    id: payload.data?.[0]?.id || 'unknown',
    type,
    broadcasterUserId,
    login,
  });
}

function getEventSubAccessToken() {
  if (!twitchTokenInfo?.user_id || !twitchToken || Date.now() >= twitchTokenExpiresAt - 60_000) {
    stopEventSub('EventSub user access token expired. Polling remains active.');
    throw new Error('EventSub requires a valid Twitch user access token.');
  }

  return twitchToken;
}

function stopEventSub(reason) {
  clearEventSubKeepAliveTimer();

  if (eventSubReconnectTimer) {
    clearTimeout(eventSubReconnectTimer);
    eventSubReconnectTimer = null;
  }

  if (eventSubSocket) {
    eventSubSocket.removeAllListeners();
    eventSubSocket.close(1000, reason);
    eventSubSocket = null;
  }

  eventSubSessionId = null;
  eventSubSubscriptions = new Map();
  eventSubStatus = {
    ...eventSubStatus,
    enabled: false,
    connected: false,
    mode: 'polling',
    sessionId: null,
    subscriptions: 0,
    error: reason,
  };
}

function resetEventSubKeepAliveTimer() {
  clearEventSubKeepAliveTimer();
  eventSubKeepAliveTimer = setTimeout(() => {
    void recordError('eventsub', 'EventSub keepalive timed out. Reconnecting.');

    if (eventSubSocket) {
      eventSubSocket.terminate();
    }
  }, eventSubKeepAliveTimeoutMs);
}

function clearEventSubKeepAliveTimer() {
  if (eventSubKeepAliveTimer) {
    clearTimeout(eventSubKeepAliveTimer);
    eventSubKeepAliveTimer = null;
  }
}

async function handleEventSubNotification(message) {
  const messageId = message.metadata?.message_id;

  if (messageId && eventMessageIds.has(messageId)) {
    return;
  }

  if (messageId) {
    eventMessageIds.add(messageId);
    eventMessageIdQueue.push(messageId);
    while (eventMessageIdQueue.length > 500) {
      eventMessageIds.delete(eventMessageIdQueue.shift());
    }
  }

  const type = message.payload?.subscription?.type;
  const event = message.payload?.event;

  if (!event) {
    return;
  }

  if (type === 'stream.online') {
    await handleStreamOnlineEvent(event);
    return;
  }

  if (type === 'stream.offline') {
    await handleStreamOfflineEvent(event);
  }
}

async function handleStreamOnlineEvent(event) {
  const login = event.broadcaster_user_login.toLowerCase();
  const liveStreams = await getLiveStreams([login]);
  const stream = liveStreams[0] || {
    id: event.id,
    user_login: login,
    user_name: event.broadcaster_user_name,
    title: 'Untitled stream',
    game_name: 'No category',
    viewer_count: 0,
    started_at: event.started_at,
    thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_twitch-{width}x{height}.jpg',
  };

  await updateLiveStatusesFromStreams([login], [stream], 'eventsub');

  for (const notification of getActiveNotifications().filter((item) => item.twitchLogin === login)) {
    if (hasLiveStateForStream(notification, stream)) {
      continue;
    }
    await announceForNotification(stream, notification, 'eventsub');
  }
}

async function handleStreamOfflineEvent(event) {
  const login = event.broadcaster_user_login.toLowerCase();

  if (!dashboardConfig.notifications.some((item) => item.twitchLogin === login)) {
    return;
  }

  liveStatus[login] = {
    ...(liveStatus[login] || {}),
    twitchLogin: login,
    displayName: event.broadcaster_user_name,
    isLive: false,
    title: '',
    gameName: '',
    viewerCount: 0,
    startedAt: null,
    lastEventAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    source: 'eventsub',
    streamUrl: `https://www.twitch.tv/${login}`,
  };

  for (const notification of dashboardConfig.notifications.filter((item) => item.twitchLogin === login)) {
    clearLiveState(notification);
  }

  await writeJsonFile(env.statusFile, liveStatus);
  await writeJsonFile(env.stateFile, liveState);
  await appendHistory({
    type: 'stream_offline',
    source: 'eventsub',
    twitchLogin: login,
    displayName: event.broadcaster_user_name,
    sentAt: new Date().toISOString(),
  });
}

function startDashboardServer() {
  const app = express();
  const publicDir = path.join(PROJECT_ROOT, 'public');

  app.use(express.json({ limit: '256kb' }));
  app.use(requireTrustedOrigin);

  app.get('/login', (request, response) => {
    response.sendFile(path.join(publicDir, 'login.html'));
  });
  app.get('/login.html', (request, response) => {
    response.sendFile(path.join(publicDir, 'login.html'));
  });
  app.get('/login.css', (request, response) => {
    response.sendFile(path.join(publicDir, 'login.css'));
  });
  app.get('/login.js', (request, response) => {
    response.sendFile(path.join(publicDir, 'login.js'));
  });

  app.get('/api/session', (request, response) => {
    const session = getSession(request);
    response.json({
      authenticated: Boolean(session) || !env.dashboardPassword,
      username: session?.username || null,
      authRequired: Boolean(env.dashboardPassword),
    });
  });

  app.post('/api/login', (request, response) => {
    if (!env.dashboardPassword) {
      response.json({ ok: true });
      return;
    }

    const clientKey = getClientKey(request);
    const attempt = getLoginAttempt(clientKey);
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      response.status(429).json({ errors: ['Too many login attempts. Try again later.'] });
      return;
    }

    const username = String(request.body?.username || '');
    const password = String(request.body?.password || '');

    if (
      username !== env.dashboardUsername ||
      !safeStringEqual(password, env.dashboardPassword)
    ) {
      recordLoginFailure(clientKey);
      response.status(401).json({ errors: ['Invalid username or password.'] });
      return;
    }

    loginAttempts.delete(clientKey);
    pruneSessions();
    const sessionId = randomBytes(32).toString('hex');
    sessions.set(sessionId, {
      username,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    response.setHeader('Set-Cookie', createSessionCookie(sessionId));
    response.json({ ok: true });
  });

  app.use(requireDashboardSession);

  app.post('/api/logout', (request, response) => {
    const sessionId = getSignedSessionId(request);
    if (sessionId) {
      sessions.delete(sessionId);
    }
    response.setHeader('Set-Cookie', clearSessionCookie());
    response.json({ ok: true });
  });

  app.get('/api/status', (request, response) => {
    response.json({
      botTag: client.user?.tag || null,
      guildCount: client.guilds.cache.size,
      activeNotifications: getActiveNotifications().length,
      pollIntervalSeconds: dashboardConfig.pollIntervalSeconds,
      checkingNow: isChecking,
      dashboardProtected: Boolean(env.dashboardPassword),
      eventSub: eventSubStatus,
    });
  });

  app.get('/api/config', (request, response) => {
    response.json(dashboardConfig);
  });

  app.put('/api/config', async (request, response) => {
    try {
      const nextConfig = normalizeConfig(request.body);
      const errors = await validateConfig(nextConfig);

      if (errors.length > 0) {
        response.status(400).json({ errors });
        return;
      }

      dashboardConfig = nextConfig;
      pruneLiveStateForConfig(dashboardConfig);
      await writeJsonFile(env.configFile, dashboardConfig);
      await writeJsonFile(env.stateFile, liveState);
      startPolling();
      restartEventSub();
      response.json(dashboardConfig);
    } catch (error) {
      await recordError('dashboard', 'Failed to save config.', { error: error.message });
      response.status(500).json({ errors: ['Failed to save config.'] });
    }
  });

  app.get('/api/discord/channels', async (request, response) => {
    response.json({ channels: await getDiscordChannels() });
  });

  app.get('/api/discord/roles', async (request, response) => {
    response.json({ roles: await getDiscordRoles() });
  });

  app.get('/api/live-status', (request, response) => {
    response.json({ statuses: getDashboardLiveStatuses() });
  });

  app.get('/api/history', (request, response) => {
    response.json({ history });
  });

  app.get('/api/errors', (request, response) => {
    response.json({ errors: errorLog });
  });

  app.delete('/api/errors', async (request, response) => {
    errorLog = [];
    await writeJsonFile(env.errorFile, errorLog);
    response.json({ ok: true });
  });

  app.post('/api/check-now', async (request, response) => {
    const ran = await checkStreams('manual');
    response.json({ ok: true, ran });
  });

  app.post('/api/test-alert', async (request, response) => {
    try {
      const notification = dashboardConfig.notifications.find(
        (item) => item.id === request.body?.notificationId,
      );

      if (!notification) {
        response.status(404).json({ errors: ['Notification was not found.'] });
        return;
      }

      if (!notification.discordChannelId) {
        response.status(400).json({ errors: ['Choose a Discord channel first.'] });
        return;
      }

      await sendTestAlert(notification);
      response.json({ ok: true });
    } catch (error) {
      await recordError('dashboard', 'Failed to send test alert.', { error: error.message });
      response.status(500).json({ errors: ['Failed to send test alert.'] });
    }
  });

  app.use(express.static(publicDir));

  app.listen(env.dashboardPort, env.dashboardHost, () => {
    const protection = env.dashboardPassword ? 'login protected' : 'not password protected';
    console.log(
      `Dashboard running at http://${env.dashboardHost}:${env.dashboardPort} (${protection}).`,
    );
  });
}

function requireDashboardSession(request, response, next) {
  if (!env.dashboardPassword) {
    next();
    return;
  }

  if (getSession(request)) {
    next();
    return;
  }

  if (request.path.startsWith('/api/')) {
    response.status(401).json({ errors: ['Login required.'] });
    return;
  }

  response.redirect('/login');
}

function requireTrustedOrigin(request, response, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    next();
    return;
  }

  const origin = request.headers.origin;
  if (!origin) {
    next();
    return;
  }

  try {
    const originUrl = new URL(origin);
    if (originUrl.host === request.headers.host) {
      next();
      return;
    }
  } catch {
    response.status(403).json({ errors: ['Invalid request origin.'] });
    return;
  }

  response.status(403).json({ errors: ['Invalid request origin.'] });
}

function getClientKey(request) {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function getLoginAttempt(clientKey) {
  const now = Date.now();
  const attempt = loginAttempts.get(clientKey);

  if (!attempt || attempt.resetAt < now) {
    const nextAttempt = { count: 0, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS };
    loginAttempts.set(clientKey, nextAttempt);
    return nextAttempt;
  }

  return attempt;
}

function recordLoginFailure(clientKey) {
  const attempt = getLoginAttempt(clientKey);
  attempt.count += 1;
}

function pruneSessions() {
  const now = Date.now();

  for (const [sessionId, session] of sessions) {
    if (session.expiresAt < now || sessions.size > 100) {
      sessions.delete(sessionId);
    }
  }
}

function getSession(request) {
  const sessionId = getSignedSessionId(request);
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function getSignedSessionId(request) {
  const rawCookie = parseCookies(request.headers.cookie || '')[SESSION_COOKIE];
  if (!rawCookie) {
    return null;
  }

  const [sessionId, signature] = rawCookie.split('.');
  if (!sessionId || !signature) {
    return null;
  }

  const expected = signValue(sessionId);
  return safeStringEqual(signature, expected) ? sessionId : null;
}

function createSessionCookie(sessionId) {
  const signedValue = `${sessionId}.${signValue(sessionId)}`;
  return `${SESSION_COOKIE}=${signedValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function signValue(value) {
  return createHmac('sha256', env.sessionSecret).update(value).digest('hex');
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (!name) {
      return cookies;
    }
    try {
      cookies[name] = decodeURIComponent(valueParts.join('='));
    } catch {
      cookies[name] = '';
    }
    return cookies;
  }, {});
}

function safeStringEqual(left = '', right = '') {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function validateConfig(config) {
  const errors = [];

  if (config.pollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS) {
    errors.push(`Polling must be at least ${MIN_POLL_INTERVAL_SECONDS} seconds.`);
  }

  for (const notification of config.notifications) {
    if (!notification.twitchLogin) {
      errors.push('Each notification needs a Twitch login.');
    }

    if (notification.twitchLogin && !/^[a-z0-9_]{3,25}$/.test(notification.twitchLogin)) {
      errors.push(`${notification.twitchLogin} is not a valid Twitch login.`);
    }

    if (!notification.discordChannelId) {
      errors.push(`${notification.twitchLogin || 'A notification'} needs a Discord channel.`);
      continue;
    }

    if (!isDiscordSnowflake(notification.discordChannelId)) {
      errors.push(`${notification.twitchLogin || 'A notification'} has an invalid Discord channel ID.`);
      continue;
    }

    const channel = await resolveDiscordChannel(notification.discordChannelId);
    if (!channel || !SENDABLE_CHANNEL_TYPES.has(channel.type)) {
      errors.push(`${notification.twitchLogin || 'A notification'} uses a channel the bot cannot find.`);
      continue;
    }

    const permissions = channel.permissionsFor(client.user);
    if (!hasAlertChannelPermissions(permissions)) {
      errors.push(`${notification.twitchLogin || 'A notification'} uses a channel missing view, send, or embed permissions.`);
    }

    if (notification.discordRoleId) {
      if (!isDiscordSnowflake(notification.discordRoleId)) {
        errors.push(`${notification.twitchLogin || 'A notification'} has an invalid Discord role ID.`);
        continue;
      }

      const role = await resolveDiscordRole(channel.guild, notification.discordRoleId);
      if (!role) {
        errors.push(`${notification.twitchLogin || 'A notification'} uses a role the bot cannot find.`);
        continue;
      }

      if (role.guild.id !== channel.guild.id) {
        errors.push(`${notification.twitchLogin || 'A notification'} uses a role from a different server.`);
      }

      if (!canMentionRole(channel.guild, role)) {
        errors.push(`${notification.twitchLogin || 'A notification'} uses a role the bot cannot mention.`);
      }
    }
  }

  return [...new Set(errors)];
}

function isDiscordSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || ''));
}

async function resolveDiscordChannel(channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

async function resolveDiscordRole(guild, roleId) {
  try {
    await guild.members.fetchMe();
    await guild.roles.fetch();
    return guild.roles.cache.get(roleId) || null;
  } catch {
    return null;
  }
}

function hasAlertChannelPermissions(permissions) {
  return Boolean(permissions?.has([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
  ]));
}

function canMentionRole(guild, role) {
  const member = guild.members.me;
  return Boolean(
    role.mentionable ||
    member?.permissions.has(PermissionsBitField.Flags.MentionEveryone)
  );
}

async function getDiscordChannels() {
  const channels = [];

  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch();

    for (const channel of guild.channels.cache.values()) {
      if (!SENDABLE_CHANNEL_TYPES.has(channel.type)) {
        continue;
      }

      const permissions = channel.permissionsFor(client.user);
      const canSend = hasAlertChannelPermissions(permissions);

      channels.push({
        id: channel.id,
        name: channel.name,
        guildId: guild.id,
        guildName: guild.name,
        canSend: Boolean(canSend),
      });
    }
  }

  return channels.sort((a, b) => (
    `${a.guildName} ${a.name}`.localeCompare(`${b.guildName} ${b.name}`)
  ));
}

async function getDiscordRoles() {
  const roles = [];

  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetchMe();
    await guild.roles.fetch();

    for (const role of guild.roles.cache.values()) {
      if (role.managed || role.name === '@everyone') {
        continue;
      }

      roles.push({
        id: role.id,
        name: role.name,
        guildId: guild.id,
        guildName: guild.name,
        color: role.hexColor,
        mentionable: role.mentionable,
        canMention: canMentionRole(guild, role),
        managed: role.managed,
        position: role.position,
      });
    }
  }

  return roles.sort((a, b) => (
    a.guildName.localeCompare(b.guildName) || b.position - a.position
  ));
}

function getDashboardLiveStatuses() {
  const configuredLogins = new Set(
    dashboardConfig.notifications
      .map((notification) => notification.twitchLogin)
      .filter(Boolean),
  );

  for (const login of configuredLogins) {
    if (!liveStatus[login]) {
      liveStatus[login] = {
        twitchLogin: login,
        displayName: login,
        isLive: false,
        title: '',
        gameName: '',
        viewerCount: 0,
        startedAt: null,
        lastCheckedAt: null,
        streamUrl: `https://www.twitch.tv/${login}`,
      };
    }
  }

  return [...configuredLogins]
    .map((login) => liveStatus[login])
    .sort((a, b) => a.twitchLogin.localeCompare(b.twitchLogin));
}

async function sendTestAlert(notification) {
  const login = notification.twitchLogin || 'twitchuser';
  const displayName = login
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('_') || login;

  await announceLive({
    id: `dashboard-test-${Date.now()}`,
    user_login: login,
    user_name: displayName,
    title: 'Live now - dashboard notification preview',
    game_name: 'Just Chatting',
    viewer_count: 128,
    started_at: new Date().toISOString(),
    thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_twitch-{width}x{height}.jpg',
  }, notification, { source: 'dashboard', test: true });
}

async function appendHistory(entry) {
  history = [
    {
      id: createNotificationId(),
      ...entry,
    },
    ...history,
  ].slice(0, MAX_HISTORY_ITEMS);
  await writeJsonFile(env.historyFile, history);
}

async function recordError(source, message, details = {}) {
  const entry = {
    id: createNotificationId(),
    source,
    message,
    details,
    createdAt: new Date().toISOString(),
  };

  errorLog = [entry, ...errorLog].slice(0, MAX_ERROR_ITEMS);
  console.error(`[${source}] ${message}`, details);

  try {
    await writeJsonFile(env.errorFile, errorLog);
  } catch (error) {
    console.error('Failed to persist error log:', error);
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const contents = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  });

  writeQueues.set(filePath, next.catch(() => {}));
  await next;
}

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  isShuttingDown = true;

  if (pollTimer) {
    clearInterval(pollTimer);
  }

  if (eventSubReconnectTimer) {
    clearTimeout(eventSubReconnectTimer);
  }

  if (eventSubSocket) {
    eventSubSocket.close(1000, 'Shutting down');
  }

  client.destroy();
  process.exit(0);
}
