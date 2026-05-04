import { v4 as uuidv4 } from 'uuid';

export const defaultEmbedDefaults = {
  twitch: { color: '#9146ff' },
  youtube: { color: '#ff0000' },
};

export function createNotification() {
  return {
    id: uuidv4(),
    provider: 'twitch',
    twitchLogin: '',
    youtubeChannelId: '',
    discordChannelId: '',
    discordRoleId: '',
    embedColor: '',
    openBrowserOnLive: false,
    enabled: true,
  };
}

export function normalizeConfig(config) {
  return {
    pollIntervalSeconds: Number.parseInt(config?.pollIntervalSeconds || '60', 10),
    embedDefaults: {
      twitch: {
        color: normalizeHexColor(config?.embedDefaults?.twitch?.color || defaultEmbedDefaults.twitch.color),
      },
      youtube: {
        color: normalizeHexColor(config?.embedDefaults?.youtube?.color || defaultEmbedDefaults.youtube.color),
      },
    },
    notifications: Array.isArray(config?.notifications)
      ? config.notifications.map((item) => ({
        id: item.id || uuidv4(),
        provider: getProvider(item),
        twitchLogin: normalizeLogin(item.twitchLogin),
        youtubeChannelId: normalizeYoutubeInput(item.youtubeChannelId),
        discordChannelId: String(item.discordChannelId || '').trim(),
        discordRoleId: String(item.discordRoleId || '').trim(),
        embedColor: normalizeOptionalHexColor(item.embedColor),
        openBrowserOnLive: Boolean(item.openBrowserOnLive),
        enabled: Boolean(item.enabled),
      }))
      : [],
  };
}

export function getProvider(notification) {
  return String(notification?.provider || '').trim().toLowerCase() === 'youtube'
    ? 'youtube'
    : 'twitch';
}

export function getIdentity(notification) {
  return getProvider(notification) === 'youtube'
    ? normalizeYoutubeInput(notification.youtubeChannelId)
    : normalizeLogin(notification.twitchLogin);
}

export function setIdentity(notification, value) {
  if (getProvider(notification) === 'youtube') {
    return { ...notification, youtubeChannelId: normalizeYoutubeInput(value) };
  }
  return { ...notification, twitchLogin: normalizeLogin(value) };
}

export function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

export function normalizeYoutubeInput(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:^|\/)(UC[a-zA-Z0-9_-]{22})(?:[/?#]|$)/);
  return match ? match[1] : raw;
}

export function normalizeOptionalHexColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return normalizeHexColor(raw);
}

export function normalizeHexColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const color = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/.test(color) ? color : '#5865f2';
}

export function getEffectiveEmbedColor(config, notification) {
  const provider = getProvider(notification);
  return normalizeHexColor(notification.embedColor || config?.embedDefaults?.[provider]?.color || '#5865f2');
}

export function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function groupBy(items, key) {
  const groups = new Map();
  for (const item of items || []) {
    const value = item[key] || 'Unknown';
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
}

export function historyTitle(item) {
  if (item.type === 'test_alert') return `Test alert: ${item.displayName || item.twitchLogin || item.youtubeChannelId || 'unknown'}`;
  if (item.type === 'youtube_video') return `YouTube alert: ${item.displayName || item.youtubeChannelId}`;
  if (item.type === 'stream_offline') return `${item.displayName || item.twitchLogin} went offline`;
  return `Live alert: ${item.displayName || item.twitchLogin}`;
}

export function historyDetail(item) {
  if (item.discordChannelName) {
    const platform = item.platform ? `${item.platform} ` : '';
    return `${item.discordGuildName || 'Discord'} / #${item.discordChannelName} via ${platform}${item.source}`;
  }
  return `Source: ${item.source || 'unknown'}`;
}

export function formatDetails(details) {
  if (!details || Object.keys(details).length === 0) return '';
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' | ');
}

export function statusLabel(status) {
  const eventSub = status?.eventSub || {};
  if (eventSub.mode === 'websocket') {
    return eventSub.connected
      ? `EventSub live (${eventSub.subscriptions})`
      : 'EventSub reconnecting';
  }
  if (eventSub.mode === 'disabled') return 'EventSub disabled';
  return 'Polling fallback';
}
