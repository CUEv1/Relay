const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.addEventListener('pointerdown', (event) => {
  if (reduceMotion) return;
  const target = event.target.closest('.button, .icon-button');
  if (!target || target.disabled) return;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.1;
  const wave = document.createElement('span');
  wave.className = 'ripple-wave';
  wave.style.width = wave.style.height = `${size}px`;
  wave.style.left = `${(event.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2}px`;
  wave.style.top = `${(event.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2}px`;
  target.appendChild(wave);
  wave.addEventListener('animationend', () => wave.remove(), { once: true });
});

const state = {
  config: null,
  channels: [],
  roles: [],
  liveStatuses: [],
  history: [],
  errors: [],
  lastSavedConfigJson: '',
  secondaryLoadInFlight: false,
  secondaryLoadSequence: 0,
  autoSaveTimer: null,
  saveInFlight: false,
  saveAgain: false,
};

const AUTO_SAVE_DELAY_MS = 800;

const elements = {
  rows: document.querySelector('#notification-rows'),
  rowTemplate: document.querySelector('#notification-row-template'),
  pollInterval: document.querySelector('#poll-interval'),
  twitchDefaultColor: document.querySelector('#twitch-default-color'),
  youtubeDefaultColor: document.querySelector('#youtube-default-color'),
  addRow: document.querySelector('#add-row'),
  checkNow: document.querySelector('#check-now'),
  refreshData: document.querySelector('#refresh-data'),
  saveConfig: document.querySelector('#save-config'),
  clearErrors: document.querySelector('#clear-errors'),
  logout: document.querySelector('#logout'),
  saveState: document.querySelector('#save-state'),
  tabButtons: [...document.querySelectorAll('.tab-button')],
  tabPanels: [...document.querySelectorAll('[data-tab-panel]')],
  botStatus: document.querySelector('#bot-status'),
  eventSubStatus: document.querySelector('#eventsub-status'),
  notificationCount: document.querySelector('#notification-count'),
  pollRate: document.querySelector('#poll-rate'),
  historyList: document.querySelector('#history-list'),
  errorList: document.querySelector('#error-list'),
  previewModal: document.querySelector('#preview-modal'),
  previewClose: document.querySelector('#preview-close'),
  previewContent: document.querySelector('#preview-content'),
  previewEmbed: document.querySelector('#preview-embed'),
  previewEmbedTitle: document.querySelector('#preview-embed-title'),
  previewEmbedDescription: document.querySelector('#preview-embed-description'),
  previewEmbedFields: document.querySelector('#preview-embed-fields'),
  previewEmbedThumbnail: document.querySelector('#preview-embed-thumbnail'),
  previewEmbedImage: document.querySelector('#preview-embed-image'),
  previewEmbedFooter: document.querySelector('#preview-embed-footer'),
};

elements.addRow.addEventListener('click', () => {
  if (!state.config) {
    return;
  }

  state.config.notifications.push({
    id: createClientId(),
    provider: 'twitch',
    twitchLogin: '',
    youtubeChannelId: '',
    discordChannelId: '',
    discordRoleId: '',
    openBrowserOnLive: false,
    enabled: true,
  });
  renderRows();
  updateDirtyState();
});

elements.saveConfig.addEventListener('click', saveConfig);
elements.pollInterval.addEventListener('input', () => {
  if (!state.config) {
    return;
  }

  state.config.pollIntervalSeconds = Number.parseInt(elements.pollInterval.value || '60', 10);
  updateDirtyState();
});
for (const [provider, colorInput] of [
  ['twitch', elements.twitchDefaultColor],
  ['youtube', elements.youtubeDefaultColor],
]) {
  colorInput.addEventListener('input', () => {
    if (!state.config) return;
    ensureEmbedDefaults();
    state.config.embedDefaults[provider].color = normalizeHexColor(colorInput.value);
    renderRows();
    updateDirtyState();
  });
}
elements.checkNow.addEventListener('click', checkNow);
elements.refreshData.addEventListener('click', loadDashboard);
elements.clearErrors.addEventListener('click', clearErrors);
elements.logout.addEventListener('click', logout);
elements.previewClose.addEventListener('click', closePreview);
elements.previewModal.addEventListener('click', (event) => {
  if (event.target === elements.previewModal) {
    closePreview();
  }
});
elements.tabButtons.forEach((button) => {
  button.addEventListener('click', () => activateTab(button.dataset.tab));
  button.addEventListener('keydown', handleTabKeydown);
});

setControlsDisabled(true);

try {
  await ensureSession();
  await loadDashboard();
} catch (error) {
  setStatus(`Dashboard failed to load: ${error.message}`);
}

setInterval(loadSecondaryData, 15_000);

async function ensureSession() {
  const session = await apiGet('/api/session', false);
  if (session.authRequired && !session.authenticated) {
    window.location.href = '/login';
  }
}

async function loadDashboard() {
  try {
    clearAutoSaveTimer();
    setStatus('Loading dashboard');
    setControlsDisabled(true);
    const [config, channelPayload, rolePayload, status] = await Promise.all([
      apiGet('/api/config'),
      apiGet('/api/discord/channels'),
      apiGet('/api/discord/roles'),
      apiGet('/api/status'),
    ]);

    state.config = config;
    ensureEmbedDefaults();
    state.lastSavedConfigJson = serializeConfig(config);
    state.channels = channelPayload.channels || [];
    state.roles = rolePayload.roles || [];
    elements.pollInterval.value = config.pollIntervalSeconds;
    renderEmbedDefaults();
    renderRows();
    renderStatus(status);
    await loadSecondaryData();
    setControlsDisabled(false);
    setStatus('Ready');
  } catch (error) {
    setControlsDisabled(false);
    setStatus(`Load failed: ${error.message}`);
    throw error;
  }
}

async function loadSecondaryData() {
  if (state.secondaryLoadInFlight) {
    return;
  }

  state.secondaryLoadInFlight = true;
  state.secondaryLoadSequence += 1;
  const sequence = state.secondaryLoadSequence;

  try {
    const [livePayload, historyPayload, errorPayload, status] = await Promise.all([
      apiGet('/api/live-status'),
      apiGet('/api/history'),
      apiGet('/api/errors'),
      apiGet('/api/status'),
    ]);

    if (sequence !== state.secondaryLoadSequence) {
      return;
    }

    state.liveStatuses = livePayload.statuses || [];
    state.history = historyPayload.history || [];
    state.errors = errorPayload.errors || [];
    updateRouteStatuses();
    renderHistory();
    renderErrors();
    renderStatus(status);
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`);
  } finally {
    state.secondaryLoadInFlight = false;
  }
}

function renderRows() {
  elements.rows.replaceChildren();

  if (!state.config || state.config.notifications.length === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 7;
    emptyCell.textContent = 'No notifications configured.';
    emptyCell.className = 'empty-cell';
    emptyRow.append(emptyCell);
    elements.rows.append(emptyRow);
    return;
  }

  for (const notification of state.config.notifications) {
    const fragment = elements.rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector('tr');
    const enabled = fragment.querySelector('.row-enabled');
    const provider = fragment.querySelector('.row-provider');
    const identity = fragment.querySelector('.row-identity');
    const embedColor = fragment.querySelector('.row-embed-color');
    const routeStatus = fragment.querySelector('.row-live-status');
    const channel = fragment.querySelector('.row-channel');
    const role = fragment.querySelector('.row-role');
    const openBrowser = fragment.querySelector('.row-open-browser');
    const channelNote = fragment.querySelector('.channel-note');
    const preview = fragment.querySelector('.row-preview');
    const test = fragment.querySelector('.row-test');
    const remove = fragment.querySelector('.row-remove');
    const accessibleName = getNotificationIdentity(notification) || 'new route';
    const currentProvider = getNotificationProvider(notification);

    row.dataset.id = notification.id;
    enabled.setAttribute('aria-label', `Enable notification for ${accessibleName}`);
    provider.setAttribute('aria-label', `Notification source for ${accessibleName}`);
    identity.setAttribute('aria-label', `${currentProvider === 'youtube' ? 'YouTube channel URL or ID' : 'Twitch username'} for ${accessibleName}`);
    embedColor.setAttribute('aria-label', `Embed color for ${accessibleName}`);
    channel.setAttribute('aria-label', `Discord channel for ${accessibleName}`);
    role.setAttribute('aria-label', `Discord role mention for ${accessibleName}`);
    openBrowser.setAttribute('aria-label', `Open notification URL in browser for ${accessibleName}`);
    enabled.checked = notification.enabled;
    openBrowser.checked = Boolean(notification.openBrowserOnLive);
    provider.value = currentProvider;
    identity.value = getNotificationIdentity(notification);
    identity.placeholder = currentProvider === 'youtube' ? 'https://www.youtube.com/@handle' : 'twitchuser';
    embedColor.value = getEffectiveEmbedColor(notification);
    renderRouteStatus(routeStatus, notification);
    renderChannelOptions(channel, notification.discordChannelId);
    renderRoleOptions(role, notification.discordRoleId, findGuildIdForChannel(notification.discordChannelId));
    updateChannelNote(channelNote, notification.discordChannelId);

    enabled.addEventListener('change', () => {
      notification.enabled = enabled.checked;
      updateDirtyState();
    });

    openBrowser.addEventListener('change', () => {
      notification.openBrowserOnLive = openBrowser.checked;
      updateDirtyState();
    });

    provider.addEventListener('change', () => {
      notification.provider = provider.value;
      identity.value = getNotificationIdentity(notification);
      identity.placeholder = provider.value === 'youtube' ? 'https://www.youtube.com/@handle' : 'twitchuser';
      embedColor.value = getEffectiveEmbedColor(notification);
      renderRouteStatus(routeStatus, notification);
      updateDirtyState();
    });

    identity.addEventListener('input', () => {
      setNotificationIdentity(notification, identity.value);
      renderRouteStatus(routeStatus, notification);
      updateDirtyState();
    });

    embedColor.addEventListener('input', () => {
      notification.embedColor = normalizeHexColor(embedColor.value);
      updateDirtyState();
    });

    channel.addEventListener('change', () => {
      notification.discordChannelId = channel.value;
      const guildId = findGuildIdForChannel(channel.value);
      const selectedRoleStillValid = state.roles.some((item) => (
        item.id === notification.discordRoleId && item.guildId === guildId && item.canMention
      ));
      if (!selectedRoleStillValid) {
        notification.discordRoleId = '';
      }
      renderRoleOptions(role, notification.discordRoleId, guildId);
      updateChannelNote(channelNote, channel.value);
      updateDirtyState();
    });

    role.addEventListener('change', () => {
      notification.discordRoleId = role.value;
      updateDirtyState();
    });

    preview.addEventListener('click', async () => {
      try {
        if (isDirty()) {
          setStatus('Saving changes before preview');
          const saved = await saveConfig();
          if (!saved) {
            return;
          }
        }

        setStatus('Building preview');
        const payload = await apiPost('/api/test-alert-preview', { notificationId: notification.id });
        renderPreview(payload.preview);
        setStatus('Preview ready');
      } catch (error) {
        setStatus(`Preview failed: ${error.message}`);
      }
    });

    test.addEventListener('click', async () => {
      try {
        if (isDirty()) {
          setStatus('Saving changes before test alert');
          const saved = await saveConfig();
          if (!saved) {
            return;
          }
        }

        setStatus('Sending test alert');
        await apiPost('/api/test-alert', { notificationId: notification.id });
        await loadSecondaryData();
        setStatus('Test alert sent');
      } catch (error) {
        await loadSecondaryData();
        setStatus(`Test failed: ${error.message}`);
      }
    });

    remove.addEventListener('click', () => {
      state.config.notifications = state.config.notifications.filter(
        (item) => item.id !== notification.id,
      );
      renderRows();
      updateDirtyState();
    });

    elements.rows.append(fragment);
  }
}

function activateTab(tab) {
  for (const button of elements.tabButtons) {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    button.setAttribute('tabindex', isActive ? '0' : '-1');
  }

  for (const panel of elements.tabPanels) {
    const isActive = panel.dataset.tabPanel === tab;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  }
}

function handleTabKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const currentIndex = elements.tabButtons.indexOf(event.currentTarget);
  let nextIndex = currentIndex;

  if (event.key === 'ArrowLeft') {
    nextIndex = currentIndex === 0 ? elements.tabButtons.length - 1 : currentIndex - 1;
  } else if (event.key === 'ArrowRight') {
    nextIndex = currentIndex === elements.tabButtons.length - 1 ? 0 : currentIndex + 1;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = elements.tabButtons.length - 1;
  }

  elements.tabButtons[nextIndex].focus();
  activateTab(elements.tabButtons[nextIndex].dataset.tab);
}

function renderChannelOptions(select, selectedId) {
  select.replaceChildren();
  select.append(new Option('Choose a channel', ''));

  for (const [guildName, channels] of groupBy(state.channels, 'guildName')) {
    const group = document.createElement('optgroup');
    group.label = guildName;

    for (const channel of channels) {
      if (!channel.canSend && channel.id !== selectedId) {
        continue;
      }

      const option = new Option(`#${channel.name}${channel.canSend ? '' : ' (missing permission)'}`, channel.id);
      option.disabled = !channel.canSend;
      option.selected = channel.id === selectedId;
      group.append(option);
    }

    if (group.children.length > 0) {
      select.append(group);
    }
  }
}

function renderRoleOptions(select, selectedId, guildId) {
  select.replaceChildren();
  select.append(new Option('No role mention', ''));

  if (!guildId) {
    return;
  }

  const roles = state.roles.filter((role) => role.guildId === guildId);

  for (const role of roles) {
    if (!role.canMention && role.id !== selectedId) {
      continue;
    }

    const option = new Option(`@${role.name}${role.canMention ? '' : ' (cannot mention)'}`, role.id);
    option.disabled = !role.canMention;
    option.selected = role.id === selectedId;
    select.append(option);
  }
}

function updateChannelNote(node, channelId) {
  const channel = state.channels.find((item) => item.id === channelId);
  node.textContent = channel && !channel.canSend
    ? 'Bot cannot send embeds in this channel.'
    : '';
}

function renderStatus(status) {
  elements.botStatus.textContent = status.botTag ? `Online as ${status.botTag}` : 'Offline';
  elements.notificationCount.textContent = `${status.activeNotifications} active`;
  elements.pollRate.textContent = `${status.pollIntervalSeconds}s poll`;

  const eventSub = status.eventSub || {};
  if (eventSub.mode === 'websocket') {
    elements.eventSubStatus.textContent = eventSub.connected
      ? `EventSub live (${eventSub.subscriptions})`
      : 'EventSub reconnecting';
  } else if (eventSub.mode === 'disabled') {
    elements.eventSubStatus.textContent = 'EventSub disabled';
  } else {
    elements.eventSubStatus.textContent = 'Polling fallback';
  }
}

function updateRouteStatuses() {
  if (!state.config) {
    return;
  }

  for (const row of elements.rows.querySelectorAll('tr[data-id]')) {
    const notification = state.config.notifications.find((item) => item.id === row.dataset.id);
    const cell = row.querySelector('.row-live-status');
    if (notification && cell) {
      renderRouteStatus(cell, notification);
    }
  }
}

function renderRouteStatus(cell, notification) {
  const provider = getNotificationProvider(notification);
  const identity = getNotificationIdentity(notification);

  if (!identity) {
    cell.innerHTML = `<div class="route-status route-status-muted">No ${provider === 'youtube' ? 'channel' : 'user'} set</div>`;
    return;
  }

  const statusKey = `${provider}:${identity}`;
  const status = state.liveStatuses.find((item) => (
    item.statusKey === statusKey ||
    (provider === 'twitch' && item.twitchLogin === identity) ||
    (provider === 'youtube' && item.youtubeChannelId === identity)
  ));

  if (!status) {
    cell.innerHTML = `
      <div class="route-status route-status-muted">
        <strong>Unknown</strong>
        <span>Not checked yet</span>
      </div>
    `;
    return;
  }

  if (provider === 'youtube') {
    const label = status.hasLatestVideo ? 'LATEST' : 'NO VIDEOS';
    const detail = status.hasLatestVideo
      ? `Published ${formatDate(status.publishedAt || status.startedAt)}`
      : `Last check ${formatDate(status.lastCheckedAt)}`;
    cell.innerHTML = `
      <div class="route-status route-status-youtube">
        <strong>${label}</strong>
        <span>${escapeHtml(detail)}</span>
        <small>${escapeHtml(status.hasLatestVideo ? status.title || 'Untitled video' : status.displayName || identity)}</small>
      </div>
    `;
    return;
  }

  const statusClass = status.isLive ? 'route-status-live' : 'route-status-offline';
  const label = status.isLive ? 'LIVE' : 'OFFLINE';
  const detail = status.isLive
    ? `${status.gameName || 'No category'} - ${status.viewerCount ?? 0} viewers`
    : `Last check ${formatDate(status.lastCheckedAt)}`;

  cell.innerHTML = `
    <div class="route-status ${statusClass}">
      <strong>${label}</strong>
      <span>${escapeHtml(detail)}</span>
      <small>${escapeHtml(status.isLive ? status.title || 'Untitled stream' : status.displayName || identity)}</small>
    </div>
  `;
}

function renderHistory() {
  elements.historyList.replaceChildren();

  if (state.history.length === 0) {
    elements.historyList.append(emptyBlock('No notification history yet.'));
    return;
  }

  for (const item of state.history.slice(0, 25)) {
    const row = document.createElement('article');
    row.className = 'log-item';
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(historyTitle(item))}</strong>
        <p>${escapeHtml(historyDetail(item))}</p>
      </div>
      <time>${formatDate(item.sentAt || item.createdAt)}</time>
    `;
    elements.historyList.append(row);
  }
}

function renderErrors() {
  elements.errorList.replaceChildren();

  if (state.errors.length === 0) {
    elements.errorList.append(emptyBlock('No errors logged.'));
    return;
  }

  for (const item of state.errors.slice(0, 25)) {
    const row = document.createElement('article');
    row.className = 'log-item error-item';
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(item.source)}: ${escapeHtml(item.message)}</strong>
        <p>${escapeHtml(formatDetails(item.details))}</p>
      </div>
      <time>${formatDate(item.createdAt)}</time>
    `;
    elements.errorList.append(row);
  }
}

async function saveConfig() {
  if (!state.config) {
    return false;
  }

  clearAutoSaveTimer();

  if (state.saveInFlight) {
    state.saveAgain = true;
    setStatus('Saving changes');
    return true;
  }

  state.saveInFlight = true;
  let savedSuccessfully = false;

  try {
    setStatus('Saving changes');
    ensureEmbedDefaults();
    state.config.pollIntervalSeconds = Number.parseInt(elements.pollInterval.value || '60', 10);
    const requestJson = serializeConfig(state.config);
    const saved = await apiPut('/api/config', state.config);
    const savedJson = serializeConfig(saved);
    const hasLocalChangesSinceRequest = serializeConfig(state.config) !== requestJson;

    state.lastSavedConfigJson = savedJson;

    if (!hasLocalChangesSinceRequest) {
      state.config = saved;
      ensureEmbedDefaults();
      elements.pollInterval.value = saved.pollIntervalSeconds;
      renderEmbedDefaults();
      renderRows();
    }

    await loadSecondaryData();
    setStatus(hasLocalChangesSinceRequest ? 'Auto-saving changes' : 'Saved');
    savedSuccessfully = true;
    return true;
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
    return false;
  } finally {
    state.saveInFlight = false;
    if (state.saveAgain || (savedSuccessfully && isDirty())) {
      state.saveAgain = false;
      scheduleAutoSave(0);
    }
  }
}

async function checkNow() {
  try {
    setStatus('Checking notifications');
    await apiPost('/api/check-now', {});
    await loadSecondaryData();
    setStatus('Check complete');
  } catch (error) {
    setStatus(`Check failed: ${error.message}`);
  }
}

async function clearErrors() {
  try {
    await apiDelete('/api/errors');
    await loadSecondaryData();
    setStatus('Errors cleared');
  } catch (error) {
    setStatus(`Clear failed: ${error.message}`);
  }
}

async function logout() {
  await apiPost('/api/logout', {});
  window.location.href = '/login';
}

function ensureEmbedDefaults() {
  if (!state.config) {
    return;
  }

  state.config.embedDefaults = state.config.embedDefaults && typeof state.config.embedDefaults === 'object'
    ? state.config.embedDefaults
    : {};
  state.config.embedDefaults.twitch = {
    color: normalizeHexColor(state.config.embedDefaults.twitch?.color || '#9146ff'),
  };
  state.config.embedDefaults.youtube = {
    color: normalizeHexColor(state.config.embedDefaults.youtube?.color || '#ff0000'),
  };
}

function renderEmbedDefaults() {
  ensureEmbedDefaults();
  elements.twitchDefaultColor.value = state.config.embedDefaults.twitch.color;
  elements.youtubeDefaultColor.value = state.config.embedDefaults.youtube.color;
}

function getEffectiveEmbedColor(notification) {
  const provider = getNotificationProvider(notification);
  return normalizeHexColor(notification.embedColor || state.config.embedDefaults?.[provider]?.color || '#5865f2');
}

function normalizeHexColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const color = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/.test(color) ? color : '#5865f2';
}

function renderPreview(preview) {
  const payload = preview?.payload || {};
  const embed = payload.embeds?.[0] || {};
  const color = Number.isFinite(embed.color) ? `#${embed.color.toString(16).padStart(6, '0')}` : '#5865f2';
  const thumbnailUrl = embed.thumbnail?.url || '';
  const imageUrl = embed.image?.url || '';

  elements.previewContent.textContent = payload.content || '';
  elements.previewEmbed.style.setProperty('--preview-color', color);
  elements.previewEmbedTitle.textContent = embed.title || '';
  elements.previewEmbedTitle.href = embed.url || '#';
  elements.previewEmbedDescription.textContent = embed.description || '';
  elements.previewEmbedFields.replaceChildren();

  for (const field of embed.fields || []) {
    const node = document.createElement('div');
    node.className = 'preview-field';
    node.innerHTML = `
      <strong>${escapeHtml(field.name || '')}</strong>
      <span>${escapeHtml(field.value || '')}</span>
    `;
    elements.previewEmbedFields.append(node);
  }

  elements.previewEmbedThumbnail.hidden = !thumbnailUrl;
  elements.previewEmbedThumbnail.src = thumbnailUrl || '';
  elements.previewEmbedImage.hidden = !imageUrl;
  elements.previewEmbedImage.src = imageUrl || '';
  elements.previewEmbedFooter.textContent = [
    embed.footer?.text || '',
    embed.timestamp ? formatDate(embed.timestamp) : '',
  ].filter(Boolean).join(' - ');
  elements.previewModal.hidden = false;
}

function closePreview() {
  elements.previewModal.hidden = true;
}

function findGuildIdForChannel(channelId) {
  return state.channels.find((channel) => channel.id === channelId)?.guildId || '';
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

function getNotificationProvider(notification) {
  return String(notification?.provider || '').trim().toLowerCase() === 'youtube' ? 'youtube' : 'twitch';
}

function getNotificationIdentity(notification) {
  if (getNotificationProvider(notification) === 'youtube') {
    return normalizeYoutubeChannelId(notification.youtubeChannelId);
  }

  return normalizeLogin(notification.twitchLogin);
}

function setNotificationIdentity(notification, value) {
  if (getNotificationProvider(notification) === 'youtube') {
    notification.youtubeChannelId = normalizeYoutubeChannelId(value);
    return;
  }

  notification.twitchLogin = normalizeLogin(value);
}

function normalizeYoutubeChannelId(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:^|\/)(UC[a-zA-Z0-9_-]{22})(?:[/?#]|$)/);
  return match ? match[1] : raw;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = item[key] || 'Unknown';
    if (!groups.has(value)) {
      groups.set(value, []);
    }
    groups.get(value).push(item);
  }
  return groups;
}

function historyTitle(item) {
  if (item.type === 'test_alert') {
    return `Test alert: ${item.displayName || item.twitchLogin}`;
  }
  if (item.type === 'youtube_video') {
    return `YouTube alert: ${item.displayName || item.youtubeChannelId}`;
  }
  if (item.type === 'stream_offline') {
    return `${item.displayName || item.twitchLogin} went offline`;
  }
  return `Live alert: ${item.displayName || item.twitchLogin}`;
}

function historyDetail(item) {
  if (item.discordChannelName) {
    const platform = item.platform ? `${item.platform} ` : '';
    return `${item.discordGuildName || 'Discord'} / #${item.discordChannelName} via ${platform}${item.source}`;
  }
  return `Source: ${item.source || 'unknown'}`;
}

function formatDetails(details) {
  if (!details || Object.keys(details).length === 0) {
    return '';
  }
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' | ');
}

function emptyBlock(message) {
  const node = document.createElement('div');
  node.className = 'empty-block';
  node.textContent = message;
  return node;
}

async function apiGet(url, redirectOnAuth = true) {
  return api(url, { method: 'GET' }, redirectOnAuth);
}

async function apiPut(url, body) {
  return api(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiPost(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiDelete(url) {
  return api(url, { method: 'DELETE' });
}

async function api(url, options, redirectOnAuth = true) {
  const response = await fetch(url, options);

  if (response.status === 401 && redirectOnAuth) {
    window.location.href = '/login';
    return {};
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = Array.isArray(payload.errors)
      ? payload.errors.join(' ')
      : 'Request failed.';
    setStatus(message);
    throw new Error(message);
  }

  return payload;
}

function setStatus(message) {
  elements.saveState.textContent = message;
}

function setControlsDisabled(disabled) {
  for (const control of [
    elements.addRow,
    elements.checkNow,
    elements.refreshData,
    elements.saveConfig,
    elements.clearErrors,
  ]) {
    control.disabled = disabled;
  }
}

function serializeConfig(config) {
  return JSON.stringify(config);
}

function isDirty() {
  return Boolean(state.config && serializeConfig(state.config) !== state.lastSavedConfigJson);
}

function updateDirtyState() {
  if (isDirty()) {
    setStatus('Auto-saving changes');
    scheduleAutoSave();
  }
}

function scheduleAutoSave(delay = AUTO_SAVE_DELAY_MS) {
  clearAutoSaveTimer();
  state.autoSaveTimer = setTimeout(() => {
    state.autoSaveTimer = null;
    void saveConfig();
  }, delay);
}

function clearAutoSaveTimer() {
  if (state.autoSaveTimer) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
  }
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function createClientId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
