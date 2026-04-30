import 'dotenv/config';
import express from 'express';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { XMLParser } from 'fast-xml-parser';
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
const YOUTUBE_FEED_URL = 'https://www.youtube.com/feeds/videos.xml';
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_HISTORY_ITEMS = 100;
const MAX_ERROR_ITEMS = 100;
const SESSION_COOKIE = 'dashboard_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRY_DELAY_MS = 750;
const FETCH_ATTEMPTS = 2;
const TWITCH_LOGIN_CHUNK_SIZE = 100;
const YOUTUBE_FEED_CONCURRENCY = 4;
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
const openedBrowserStreams = new Set();
const writeQueues = new Map();
const youtubeParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
});

let dashboardConfig = null;
let twitchToken = null;
let twitchTokenExpiresAt = 0;
let twitchTokenInfo = null;
let twitchAuthInitialized = false;
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
let eventSubTokenWarningLogged = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  dashboardConfig = await loadDashboardConfig();
  await ensureTwitchAuthForActiveRoutes();
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
    twitchAuthInitialized = true;
    return;
  }

  twitchToken = env.twitchAccessToken;
  const validation = await validateTwitchAccessToken(twitchToken);
  twitchAuthInitialized = true;
  twitchTokenInfo = validation;

  if (!env.twitchClientId) {
    env.twitchClientId = validation.client_id;
  }

  twitchTokenExpiresAt = Date.now() + validation.expires_in * 1000;
  const tokenType = validation.user_id ? 'user' : 'app';
  console.log(
    `Using provided Twitch ${tokenType} access token for client ${env.twitchClientId}; expires in ${validation.expires_in} seconds.`,
  );
}

async function ensureTwitchAuthForActiveRoutes() {
  if (twitchAuthInitialized || getActiveTwitchNotifications().length === 0) {
    return;
  }

  if (!env.twitchAccessToken && (!env.twitchClientId || !env.twitchClientSecret)) {
    throw new Error(
      'Set TWITCH_ACCESS_TOKEN, or set both TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, before enabling Twitch routes.',
    );
  }

  await initializeTwitchAuth();
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
  const resolutionErrors = await resolveYoutubeChannelsInConfig(normalized);
  for (const error of resolutionErrors) {
    console.warn(error);
  }
  await writeJsonFile(env.configFile, normalized);
  return normalized;
}

function createConfigFromEnv() {
  const loginsRaw = process.env.TWITCH_USER_LOGINS || process.env.TWITCH_USER_LOGIN || '';
  const twitchLogins = loginsRaw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  const youtubeChannelIds = (process.env.YOUTUBE_CHANNEL_IDS || process.env.YOUTUBE_CHANNEL_ID || '')
    .split(',')
    .map(normalizeYoutubeChannelId)
    .filter(Boolean);
  const seededLogins = twitchLogins.length > 0 || !twitchTokenInfo?.login
    ? twitchLogins
    : [twitchTokenInfo.login];

  const defaultChannelId = process.env.DISCORD_CHANNEL_ID?.trim() || '';
  const defaultRoleId = process.env.DISCORD_ROLE_ID?.trim() || '';
  const twitchNotifications = [...new Set(seededLogins)].map((login) => ({
    id: createNotificationId(),
    provider: 'twitch',
    twitchLogin: login,
    youtubeChannelId: '',
    discordChannelId: defaultChannelId,
    discordRoleId: defaultRoleId,
    openBrowserOnLive: false,
    enabled: Boolean(defaultChannelId),
  }));
  const youtubeNotifications = [...new Set(youtubeChannelIds)].map((channelId) => ({
    id: createNotificationId(),
    provider: 'youtube',
    twitchLogin: '',
    youtubeChannelId: channelId,
    discordChannelId: defaultChannelId,
    discordRoleId: defaultRoleId,
    openBrowserOnLive: false,
    enabled: Boolean(defaultChannelId),
  }));

  return {
    pollIntervalSeconds: parsePollInterval(process.env.POLL_INTERVAL_SECONDS || '10'),
    notifications: [...twitchNotifications, ...youtubeNotifications],
  };
}

function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const pollIntervalSeconds = parsePollInterval(source.pollIntervalSeconds);
  const seenIds = new Set();
  const migratedOpenBrowserDefault = source.openBrowserOnLive === true;
  const notifications = Array.isArray(source.notifications)
    ? source.notifications.map((item) => (
      normalizeNotification(item, seenIds, migratedOpenBrowserDefault)
    ))
    : [];

  return {
    pollIntervalSeconds,
    notifications,
  };
}

function normalizeNotification(item, seenIds = new Set(), openBrowserDefault = false) {
  const source = item && typeof item === 'object' ? item : {};
  let id = sanitizeId(source.id);

  if (!id || seenIds.has(id)) {
    id = createNotificationId();
  }

  seenIds.add(id);

  return {
    id,
    provider: normalizeProvider(source.provider),
    twitchLogin: normalizeTwitchLogin(source.twitchLogin),
    youtubeChannelId: normalizeYoutubeChannelId(source.youtubeChannelId),
    discordChannelId: String(source.discordChannelId || '').trim(),
    discordRoleId: String(source.discordRoleId || '').trim(),
    openBrowserOnLive: source.openBrowserOnLive === undefined
      ? openBrowserDefault
      : Boolean(source.openBrowserOnLive),
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

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'youtube' ? 'youtube' : 'twitch';
}

function normalizeYoutubeChannelId(value) {
  const raw = String(value || '').trim();
  const match = extractYoutubeChannelId(raw);
  return match ? match[1] : raw;
}

function isYoutubeChannelId(value) {
  return /^UC[a-zA-Z0-9_-]{22}$/.test(String(value || ''));
}

function extractYoutubeChannelId(value) {
  const text = String(value || '');
  return text.match(/(?:^|[/"'=?:,; &])((?:UC)[a-zA-Z0-9_-]{22})(?:[/?#"'=,; &]|$)/);
}

async function resolveYoutubeChannelsInConfig(config) {
  const errors = [];
  const cache = new Map();

  for (const notification of config.notifications) {
    if (!isYoutubeNotification(notification) || !notification.youtubeChannelId) {
      continue;
    }

    const input = normalizeYoutubeChannelId(notification.youtubeChannelId);
    if (isYoutubeChannelId(input)) {
      notification.youtubeChannelId = input;
      continue;
    }

    if (!cache.has(input)) {
      cache.set(input, resolveYoutubeChannelInput(input).catch((error) => ({ error })));
    }

    const resolved = await cache.get(input);
    if (typeof resolved === 'string' && isYoutubeChannelId(resolved)) {
      notification.youtubeChannelId = resolved;
      continue;
    }

    const message = resolved?.error?.message || `Could not find a YouTube channel ID in ${input}.`;
    errors.push(`Could not resolve YouTube channel "${input}": ${message}`);
  }

  return errors;
}

async function resolveYoutubeChannelInput(input) {
  const normalized = normalizeYoutubeChannelId(input);
  if (isYoutubeChannelId(normalized)) {
    return normalized;
  }

  const lookupUrl = createYoutubeLookupUrl(normalized);
  if (!lookupUrl) {
    return '';
  }

  const response = await fetchWithRetry(lookupUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 DiscordBot YouTube channel resolver',
    },
  }, 'YouTube channel page request');

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube channel page request failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const html = await response.text();
  return extractYoutubeChannelId(response.url)?.[1] ||
    extractYoutubeChannelId(html)?.[1] ||
    '';
}

function createYoutubeLookupUrl(input) {
  const value = String(input || '').trim();
  if (!value) {
    return '';
  }

  if (value.startsWith('@')) {
    return `https://www.youtube.com/${encodeURI(value)}`;
  }

  if (value.startsWith('/')) {
    return `https://www.youtube.com${value}`;
  }

  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(withScheme);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
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
  console.log(`Polling notifications every ${dashboardConfig.pollIntervalSeconds} seconds.`);
}

async function checkStreams(source = 'polling') {
  if (isChecking || !dashboardConfig) {
    return false;
  }

  isChecking = true;

  try {
    const notifications = getActiveNotifications();
    await checkTwitchNotifications(notifications.filter(isTwitchNotification), source);
    await checkYoutubeNotifications(notifications.filter(isYoutubeNotification), source);
  } catch (error) {
    await recordError('notifications', 'Notification check failed.', getErrorDetails(error));
  } finally {
    isChecking = false;
  }

  return true;
}

function getActiveNotifications() {
  return dashboardConfig.notifications.filter((notification) => (
    notification.enabled &&
    getNotificationIdentity(notification) &&
    notification.discordChannelId
  ));
}

function getActiveTwitchNotifications() {
  return getActiveNotifications().filter(isTwitchNotification);
}

function isTwitchNotification(notification) {
  return getNotificationProvider(notification) === 'twitch';
}

function isYoutubeNotification(notification) {
  return getNotificationProvider(notification) === 'youtube';
}

function getNotificationProvider(notification) {
  return normalizeProvider(notification?.provider);
}

function getNotificationIdentity(notification) {
  if (isYoutubeNotification(notification)) {
    return normalizeYoutubeChannelId(notification.youtubeChannelId);
  }

  return normalizeTwitchLogin(notification.twitchLogin);
}

function getNotificationLabel(notification) {
  const identity = getNotificationIdentity(notification);
  return isYoutubeNotification(notification)
    ? `YouTube channel ${identity || 'unknown'}`
    : `Twitch user ${identity || 'unknown'}`;
}

async function checkTwitchNotifications(notifications, source) {
  if (notifications.length === 0) {
    return;
  }

  try {
    await ensureTwitchAuthForActiveRoutes();
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
    await recordError('twitch', 'Twitch live check failed.', getErrorDetails(error));
  }
}

async function checkYoutubeNotifications(notifications, source) {
  if (notifications.length === 0) {
    return;
  }

  try {
    const channelIds = [...new Set(notifications.map(getNotificationIdentity))];
    const previousLiveStatus = structuredClone(liveStatus);
    const latestVideos = await getLatestYoutubeVideos(channelIds);
    await updateYoutubeStatusesFromVideos(channelIds, latestVideos, source);

    for (const notification of notifications) {
      const video = latestVideos.get(getNotificationIdentity(notification));

      if (!video) {
        continue;
      }

      if (hasLiveStateForStream(notification, video)) {
        continue;
      }

      const previousStatus = getYoutubeStatusSnapshot(previousLiveStatus, notification);
      if (!previousStatus || wasYoutubeVideoAlreadySeen(previousLiveStatus, notification, video)) {
        setLiveState(notification, video, source);
        await writeJsonFile(env.stateFile, liveState);
        continue;
      }

      await announceForNotification(video, notification, source);
    }
  } catch (error) {
    await recordError('youtube', 'YouTube notification check failed.', getErrorDetails(error));
  }
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

    const response = await fetchWithRetry(`${TWITCH_STREAMS_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': env.twitchClientId,
      },
    }, 'Twitch streams request');

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

  const response = await fetchWithRetry(`${TWITCH_USERS_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': env.twitchClientId,
    },
  }, 'Twitch users request');

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

async function getLatestYoutubeVideos(channelIds) {
  const videos = new Map();

  await mapWithConcurrency(channelIds, YOUTUBE_FEED_CONCURRENCY, async (channelId) => {
    const params = new URLSearchParams({ channel_id: channelId });
    const response = await fetchWithRetry(`${YOUTUBE_FEED_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
      },
    }, 'YouTube feed request');

    if (response.status === 404) {
      videos.set(channelId, null);
      return;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YouTube feed request failed for ${channelId}: ${response.status} ${body}`);
    }

    const feed = youtubeParser.parse(await response.text())?.feed;
    const entries = Array.isArray(feed?.entry)
      ? feed.entry
      : feed?.entry
        ? [feed.entry]
        : [];
    const latestEntry = entries[0];

    if (!latestEntry) {
      videos.set(channelId, null);
      return;
    }

    videos.set(channelId, normalizeYoutubeVideo(latestEntry, feed, channelId));
  });

  return videos;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        await worker(item);
      }
    },
  );

  await Promise.all(workers);
}

function normalizeYoutubeVideo(entry, feed, channelId) {
  const videoId = String(entry.videoId || '').trim() ||
    String(entry.id || '').replace(/^yt:video:/, '').trim();
  const title = getXmlText(entry.title) ||
    getXmlText(entry.group?.title) ||
    'Untitled video';
  const channelTitle = getXmlText(entry.author?.name) ||
    getXmlText(feed?.author?.name) ||
    channelId;
  const videoUrl = getXmlLink(entry.link) ||
    (videoId ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/channel/${channelId}`);
  const thumbnailUrl = getXmlAttribute(entry.group?.thumbnail, 'url') ||
    (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');

  return {
    id: videoId || videoUrl,
    channelId: String(entry.channelId || channelId).trim(),
    channelTitle,
    title,
    publishedAt: String(entry.published || '').trim() || null,
    updatedAt: String(entry.updated || '').trim() || null,
    videoUrl,
    thumbnailUrl,
  };
}

function getXmlText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return String(value['#text'] || value.text || '').trim();
  }

  return String(value).trim();
}

function getXmlAttribute(value, attributeName) {
  if (Array.isArray(value)) {
    return getXmlAttribute(value[0], attributeName);
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  return String(value[attributeName] || '').trim();
}

function getXmlLink(value) {
  if (Array.isArray(value)) {
    const alternate = value.find((item) => item?.rel === 'alternate') || value[0];
    return getXmlAttribute(alternate, 'href');
  }

  return getXmlAttribute(value, 'href');
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
      'Set TWITCH_ACCESS_TOKEN, or set both TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, before enabling Twitch routes.',
    );
  }

  const body = new URLSearchParams({
    client_id: env.twitchClientId,
    client_secret: env.twitchClientSecret,
    grant_type: 'client_credentials',
  });

  const response = await fetchWithRetry(TWITCH_TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 'Twitch token request');

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
  const response = await fetchWithRetry(TWITCH_VALIDATE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Authorization: `OAuth ${token}` },
  }, 'Twitch token validation');

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

async function fetchWithRetry(url, options, label, attempts = FETCH_ATTEMPTS) {
  let lastError = null;
  const { signal: _signal, ...baseOptions } = options || {};

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...baseOptions,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (attempt < attempts && isRetriableHttpStatus(response.status)) {
        await response.body?.cancel().catch(() => {});
        await delay(FETCH_RETRY_DELAY_MS * attempt);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await delay(FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(`${label} fetch failed: ${describeFetchError(lastError)}`, {
    cause: lastError,
  });
}

function isRetriableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function describeFetchError(error) {
  const parts = [error?.message || 'unknown error'];
  const cause = error?.cause;

  if (cause?.code) {
    parts.push(`code=${cause.code}`);
  }

  if (cause?.message && cause.message !== error?.message) {
    parts.push(`cause=${cause.message}`);
  }

  return parts.join(' ');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function announceForNotification(stream, notification, source) {
  const reservationKey = getAnnouncementReservationKey(notification, stream);

  if (pendingAnnouncements.has(reservationKey) || hasLiveStateForStream(notification, stream)) {
    return;
  }

  pendingAnnouncements.add(reservationKey);

  try {
    await announceNotificationItem(stream, notification, { source });
    setLiveState(notification, stream, source);
    await writeJsonFile(env.stateFile, liveState);
  } catch (error) {
    await recordError('discord', `Failed to announce ${getNotificationLabel(notification)}.`, {
      channelId: notification.discordChannelId,
      error: error.message,
    });
  } finally {
    pendingAnnouncements.delete(reservationKey);
  }
}

async function announceNotificationItem(item, notification, options = {}) {
  if (isYoutubeNotification(notification)) {
    await announceYoutubeVideo(item, notification, options);
    return;
  }

  await announceLive(item, notification, options);
}

function getAnnouncementReservationKey(notification, stream) {
  return `${getLiveStateKey(notification)}:${stream.id}`;
}

function getLiveStateKey(notification) {
  if (isYoutubeNotification(notification)) {
    return [
      'youtube',
      normalizeYoutubeChannelId(notification.youtubeChannelId),
      notification.discordChannelId,
      notification.discordRoleId || 'none',
    ].join(':');
  }

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
    provider: getNotificationProvider(notification),
    twitchLogin: normalizeTwitchLogin(notification.twitchLogin),
    youtubeChannelId: normalizeYoutubeChannelId(notification.youtubeChannelId),
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
  const status = getStatusSnapshotEntry(
    statusSnapshot,
    getStatusKey('twitch', normalizeTwitchLogin(notification.twitchLogin)),
    normalizeTwitchLogin(notification.twitchLogin),
  );

  if (!status?.isLive || !status.lastAnnouncedAt) {
    return false;
  }

  if (status.startedAt && stream.started_at) {
    return new Date(status.startedAt).getTime() === new Date(stream.started_at).getTime();
  }

  return status.streamUrl === `https://www.twitch.tv/${stream.user_login}`;
}

function wasYoutubeVideoAlreadySeen(statusSnapshot, notification, video) {
  const status = getYoutubeStatusSnapshot(statusSnapshot, notification);

  return Boolean(status?.latestVideoId === video.id || status?.videoUrl === video.videoUrl);
}

function getYoutubeStatusSnapshot(statusSnapshot, notification) {
  const channelId = normalizeYoutubeChannelId(notification.youtubeChannelId);
  return getStatusSnapshotEntry(
    statusSnapshot,
    getStatusKey('youtube', channelId),
    channelId,
  );
}

function getStatusSnapshotEntry(snapshot, key, legacyKey) {
  return snapshot[key] || snapshot[legacyKey] || null;
}

function getStatusKey(provider, identity) {
  return `${provider}:${identity}`;
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

  await maybeOpenUrlInBrowser(stream, streamUrl, {
    ...options,
    provider: 'twitch',
    identity: stream.user_login,
    label: `Twitch channel for ${stream.user_login}`,
    openBrowserOnLive: notification.openBrowserOnLive,
  });

  const login = stream.user_login.toLowerCase();
  const statusKey = getStatusKey('twitch', login);
  liveStatus[statusKey] = {
    ...(liveStatus[statusKey] || liveStatus[login] || {}),
    platform: 'twitch',
    statusKey,
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

async function announceYoutubeVideo(video, notification, options = {}) {
  const channel = await client.channels.fetch(notification.discordChannelId);

  if (!channel || !channel.isTextBased() || channel.type === ChannelType.DM) {
    throw new Error(`Discord channel ${notification.discordChannelId} is not a server text channel.`);
  }

  const publishedAt = parseDateOrNow(video.publishedAt);
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle(`${video.channelTitle} posted on YouTube`)
    .setURL(video.videoUrl)
    .setDescription(video.title || 'Untitled video')
    .addFields({ name: 'Published', value: formatDiscordTimestamp(publishedAt), inline: true })
    .setTimestamp(publishedAt)
    .setFooter({ text: 'YouTube notification' });

  if (video.thumbnailUrl) {
    embed.setImage(video.thumbnailUrl);
  }

  const content = notification.discordRoleId
    ? `<@&${notification.discordRoleId}> ${video.channelTitle} posted: ${video.videoUrl}`
    : `${video.channelTitle} posted: ${video.videoUrl}`;

  await channel.send({
    content,
    embeds: [embed],
    allowedMentions: notification.discordRoleId
      ? { roles: [notification.discordRoleId] }
      : { parse: [] },
  });

  await appendHistory({
    type: options.test ? 'test_alert' : 'youtube_video',
    platform: 'youtube',
    source: options.source || 'unknown',
    youtubeChannelId: video.channelId,
    videoId: video.id,
    displayName: video.channelTitle,
    discordChannelId: notification.discordChannelId,
    discordChannelName: channel.name,
    discordGuildName: channel.guild?.name || '',
    title: video.title || 'Untitled video',
    videoUrl: video.videoUrl,
    streamUrl: video.videoUrl,
    sentAt: new Date().toISOString(),
  });

  await maybeOpenUrlInBrowser(video, video.videoUrl, {
    ...options,
    provider: 'youtube',
    identity: video.channelId,
    label: `YouTube video for ${video.channelTitle}`,
    openBrowserOnLive: notification.openBrowserOnLive,
  });

  const statusKey = getStatusKey('youtube', video.channelId);
  liveStatus[statusKey] = {
    ...(liveStatus[statusKey] || {}),
    platform: 'youtube',
    statusKey,
    youtubeChannelId: video.channelId,
    displayName: video.channelTitle,
    isLive: false,
    hasLatestVideo: true,
    latestVideoId: video.id,
    title: video.title || 'Untitled video',
    gameName: 'YouTube',
    viewerCount: null,
    startedAt: video.publishedAt || null,
    publishedAt: video.publishedAt || null,
    lastAnnouncedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    source: options.source || 'unknown',
    streamUrl: video.videoUrl,
    videoUrl: video.videoUrl,
  };
  await writeJsonFile(env.statusFile, liveStatus);

  console.log(`Announced YouTube video for ${video.channelId} (${video.id}).`);
}

function formatDiscordTimestamp(date) {
  const timestamp = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function parseDateOrNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function maybeOpenUrlInBrowser(item, streamUrl, options = {}) {
  if (!options.openBrowserOnLive) {
    return;
  }

  const identity = String(options.identity || item.user_login || item.channelId || '').toLowerCase();
  const browserKey = `${options.provider || 'unknown'}:${identity}:${item.id}`;
  if (openedBrowserStreams.has(browserKey)) {
    return;
  }

  openedBrowserStreams.add(browserKey);
  while (openedBrowserStreams.size > 500) {
    openedBrowserStreams.delete(openedBrowserStreams.values().next().value);
  }

  try {
    await openUrlInBrowser(streamUrl);
    console.log(`Opened browser tab for ${options.label || streamUrl} (${item.id}).`);
  } catch (error) {
    openedBrowserStreams.delete(browserKey);
    await recordError('browser', `Failed to open ${options.label || 'notification URL'}.`, {
      streamUrl,
      error: error.message,
    });
  }
}

function openUrlInBrowser(url) {
  const launch = getBrowserLaunch(url);

  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function getBrowserLaunch(url) {
  if (process.platform === 'win32') {
    const chromePath = getWindowsChromePath();
    if (chromePath) {
      return { command: chromePath, args: [url] };
    }

    return { command: 'cmd.exe', args: ['/c', 'start', '', url] };
  }

  if (process.platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Google Chrome', url] };
  }

  return { command: 'google-chrome', args: [url] };
}

function getWindowsChromePath() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || '';
}

async function updateLiveStatusesFromStreams(logins, streams, source) {
  const checkedAt = new Date().toISOString();
  const streamByLogin = new Map(
    streams.map((stream) => [stream.user_login.toLowerCase(), stream]),
  );

  for (const login of logins) {
    const stream = streamByLogin.get(login);
    const statusKey = getStatusKey('twitch', login);

    if (!stream) {
      liveStatus[statusKey] = {
        ...(liveStatus[statusKey] || liveStatus[login] || {}),
        platform: 'twitch',
        statusKey,
        twitchLogin: login,
        displayName: liveStatus[statusKey]?.displayName || liveStatus[login]?.displayName || login,
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

    liveStatus[statusKey] = {
      ...(liveStatus[statusKey] || liveStatus[login] || {}),
      platform: 'twitch',
      statusKey,
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

async function updateYoutubeStatusesFromVideos(channelIds, videosByChannelId, source) {
  const checkedAt = new Date().toISOString();

  for (const channelId of channelIds) {
    const statusKey = getStatusKey('youtube', channelId);
    const video = videosByChannelId.get(channelId);

    if (!video) {
      liveStatus[statusKey] = {
        ...(liveStatus[statusKey] || {}),
        platform: 'youtube',
        statusKey,
        youtubeChannelId: channelId,
        displayName: liveStatus[statusKey]?.displayName || channelId,
        isLive: false,
        hasLatestVideo: false,
        latestVideoId: null,
        title: '',
        gameName: 'YouTube',
        viewerCount: null,
        startedAt: null,
        publishedAt: null,
        lastCheckedAt: checkedAt,
        source,
        streamUrl: `https://www.youtube.com/channel/${channelId}`,
        videoUrl: '',
      };
      continue;
    }

    liveStatus[statusKey] = {
      ...(liveStatus[statusKey] || {}),
      platform: 'youtube',
      statusKey,
      youtubeChannelId: channelId,
      displayName: video.channelTitle,
      isLive: false,
      hasLatestVideo: true,
      latestVideoId: video.id,
      title: video.title || 'Untitled video',
      gameName: 'YouTube',
      viewerCount: null,
      startedAt: video.publishedAt || null,
      publishedAt: video.publishedAt || null,
      lastCheckedAt: checkedAt,
      source,
      streamUrl: video.videoUrl,
      videoUrl: video.videoUrl,
    };
  }

  await writeJsonFile(env.statusFile, liveStatus);
}

function startEventSub() {
  if (!env.eventSubEnabled) {
    eventSubStatus = { ...eventSubStatus, enabled: false, mode: 'disabled' };
    return;
  }

  if (getActiveTwitchNotifications().length === 0) {
    eventSubStatus = {
      ...eventSubStatus,
      enabled: false,
      connected: false,
      mode: 'polling',
      error: 'EventSub waits until at least one active Twitch route exists.',
    };
    return;
  }

  if (!twitchTokenInfo?.user_id) {
    eventSubStatus = {
      ...eventSubStatus,
      enabled: false,
      mode: 'polling',
      error: 'EventSub WebSocket requires a Twitch user access token. The configured token is an app token, so polling remains active.',
    };
    if (!eventSubTokenWarningLogged) {
      eventSubTokenWarningLogged = true;
      void recordError('eventsub', eventSubStatus.error);
    }
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
      normalizeProvider(entry.provider) !== getNotificationProvider(notification) ||
      getNotificationIdentity(entry) !== getNotificationIdentity(notification) ||
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

  const logins = [...new Set(getActiveTwitchNotifications().map((notification) => notification.twitchLogin))];

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
  const response = await fetchWithRetry(EVENTSUB_SUBSCRIPTIONS_URL, {
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
  }, 'EventSub subscription request');

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

  for (const notification of getActiveTwitchNotifications().filter((item) => item.twitchLogin === login)) {
    if (hasLiveStateForStream(notification, stream)) {
      continue;
    }
    await announceForNotification(stream, notification, 'eventsub');
  }
}

async function handleStreamOfflineEvent(event) {
  const login = event.broadcaster_user_login.toLowerCase();

  if (!dashboardConfig.notifications.some((item) => isTwitchNotification(item) && item.twitchLogin === login)) {
    return;
  }

  const statusKey = getStatusKey('twitch', login);
  liveStatus[statusKey] = {
    ...(liveStatus[statusKey] || liveStatus[login] || {}),
    platform: 'twitch',
    statusKey,
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

  for (const notification of dashboardConfig.notifications.filter((item) => (
    isTwitchNotification(item) && item.twitchLogin === login
  ))) {
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
      const youtubeResolutionErrors = await resolveYoutubeChannelsInConfig(nextConfig);
      const errors = [
        ...youtubeResolutionErrors,
        ...(await validateConfig(nextConfig)),
      ];

      if (errors.length > 0) {
        response.status(400).json({ errors });
        return;
      }

      dashboardConfig = nextConfig;
      await ensureTwitchAuthForActiveRoutes();
      pruneLiveStateForConfig(dashboardConfig);
      await writeJsonFile(env.configFile, dashboardConfig);
      await writeJsonFile(env.stateFile, liveState);
      startPolling();
      restartEventSub();
      void checkStreams('config');
      response.json(dashboardConfig);
    } catch (error) {
      await recordError('dashboard', 'Failed to save config.', getErrorDetails(error));
      response.status(500).json({
        errors: [`Failed to save config: ${error?.message || String(error)}`],
      });
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
      const details = {
        ...getErrorDetails(error),
        notificationId: request.body?.notificationId || null,
      };
      const notification = dashboardConfig.notifications.find(
        (item) => item.id === request.body?.notificationId,
      );

      if (notification) {
        details.provider = getNotificationProvider(notification);
        details.identity = getNotificationIdentity(notification);
        details.discordChannelId = notification.discordChannelId;
        details.discordRoleId = notification.discordRoleId || '';
      }

      await recordError('dashboard', 'Failed to send test alert.', details);
      response.status(500).json({
        errors: [`Failed to send test alert: ${error?.message || String(error)}`],
      });
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
    const provider = getNotificationProvider(notification);
    const label = getNotificationLabel(notification);

    if (provider === 'twitch' && !notification.twitchLogin) {
      errors.push('Each Twitch notification needs a login.');
    }

    if (provider === 'twitch' && notification.twitchLogin && !/^[a-z0-9_]{3,25}$/.test(notification.twitchLogin)) {
      errors.push(`${notification.twitchLogin} is not a valid Twitch login.`);
    }

    if (provider === 'youtube' && !notification.youtubeChannelId) {
      errors.push('Each YouTube notification needs a channel URL or channel ID.');
    }

    if (provider === 'youtube' && notification.youtubeChannelId && !isYoutubeChannelId(notification.youtubeChannelId)) {
      errors.push(`${notification.youtubeChannelId} is not a valid YouTube channel URL or channel ID.`);
    }

    if (!notification.discordChannelId) {
      errors.push(`${label} needs a Discord channel.`);
      continue;
    }

    if (!isDiscordSnowflake(notification.discordChannelId)) {
      errors.push(`${label} has an invalid Discord channel ID.`);
      continue;
    }

    const channel = await resolveDiscordChannel(notification.discordChannelId);
    if (!channel || !SENDABLE_CHANNEL_TYPES.has(channel.type)) {
      errors.push(`${label} uses a channel the bot cannot find.`);
      continue;
    }

    const permissions = channel.permissionsFor(client.user);
    if (!hasAlertChannelPermissions(permissions)) {
      errors.push(`${label} uses a channel missing view, send, or embed permissions.`);
    }

    if (notification.discordRoleId) {
      if (!isDiscordSnowflake(notification.discordRoleId)) {
        errors.push(`${label} has an invalid Discord role ID.`);
        continue;
      }

      const role = await resolveDiscordRole(channel.guild, notification.discordRoleId);
      if (!role) {
        errors.push(`${label} uses a role the bot cannot find.`);
        continue;
      }

      if (role.guild.id !== channel.guild.id) {
        errors.push(`${label} uses a role from a different server.`);
      }

      if (!canMentionRole(channel.guild, role)) {
        errors.push(`${label} uses a role the bot cannot mention.`);
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
  const configuredRoutes = new Map(
    dashboardConfig.notifications
      .map((notification) => {
        const provider = getNotificationProvider(notification);
        const identity = getNotificationIdentity(notification);
        return identity ? [getStatusKey(provider, identity), { provider, identity }] : null;
      })
      .filter(Boolean),
  );

  for (const [statusKey, route] of configuredRoutes) {
    if (!liveStatus[statusKey]) {
      liveStatus[statusKey] = route.provider === 'youtube'
        ? {
          platform: 'youtube',
          statusKey,
          youtubeChannelId: route.identity,
          displayName: route.identity,
          isLive: false,
          hasLatestVideo: false,
          latestVideoId: null,
          title: '',
          gameName: 'YouTube',
          viewerCount: null,
          startedAt: null,
          publishedAt: null,
          lastCheckedAt: null,
          streamUrl: `https://www.youtube.com/channel/${route.identity}`,
          videoUrl: '',
        }
        : {
          platform: 'twitch',
          statusKey,
          twitchLogin: route.identity,
          displayName: route.identity,
          isLive: false,
          title: '',
          gameName: '',
          viewerCount: 0,
          startedAt: null,
          lastCheckedAt: null,
          streamUrl: `https://www.twitch.tv/${route.identity}`,
        };
    }
  }

  return [...configuredRoutes.keys()]
    .map((statusKey) => liveStatus[statusKey])
    .sort((a, b) => (a.statusKey || '').localeCompare(b.statusKey || ''));
}

async function sendTestAlert(notification) {
  if (isYoutubeNotification(notification)) {
    const channelId = normalizeYoutubeChannelId(notification.youtubeChannelId);
    let video = null;

    if (channelId) {
      const latestVideos = await getLatestYoutubeVideos([channelId]);
      video = latestVideos.get(channelId);
    }

    await announceYoutubeVideo(video || createYoutubeTestVideo(channelId), notification, {
      source: 'dashboard',
      test: true,
    });
    return;
  }

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

function createYoutubeTestVideo(channelId) {
  const videoId = 'aqz-KE-bpKQ';

  return {
    id: `dashboard-test-${Date.now()}`,
    channelId: channelId || 'UC0000000000000000000000',
    channelTitle: 'YouTube Channel',
    title: 'Dashboard notification preview',
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
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

function getErrorDetails(error) {
  return {
    error: error?.message || String(error),
    name: error?.name || null,
    code: error?.code || null,
    status: error?.status || null,
    method: error?.method || null,
    url: error?.url || null,
    rawError: error?.rawError || null,
    stack: error?.stack || null,
    causeName: error?.cause?.name || null,
    causeCode: error?.cause?.code || null,
    causeMessage: error?.cause?.message || null,
  };
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
