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
};

const elements = {
  rows: document.querySelector('#notification-rows'),
  rowTemplate: document.querySelector('#notification-row-template'),
  pollInterval: document.querySelector('#poll-interval'),
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
};

elements.addRow.addEventListener('click', () => {
  if (!state.config) {
    return;
  }

  state.config.notifications.push({
    id: createClientId(),
    twitchLogin: '',
    discordChannelId: '',
    discordRoleId: '',
    enabled: true,
  });
  renderRows();
  updateDirtyState();
});

elements.saveConfig.addEventListener('click', saveConfig);
elements.checkNow.addEventListener('click', checkNow);
elements.refreshData.addEventListener('click', loadDashboard);
elements.clearErrors.addEventListener('click', clearErrors);
elements.logout.addEventListener('click', logout);
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
    setStatus('Loading dashboard');
    setControlsDisabled(true);
    const [config, channelPayload, rolePayload, status] = await Promise.all([
      apiGet('/api/config'),
      apiGet('/api/discord/channels'),
      apiGet('/api/discord/roles'),
      apiGet('/api/status'),
    ]);

    state.config = config;
    state.lastSavedConfigJson = serializeConfig(config);
    state.channels = channelPayload.channels || [];
    state.roles = rolePayload.roles || [];
    elements.pollInterval.value = config.pollIntervalSeconds;
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
    emptyCell.colSpan = 6;
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
    const login = fragment.querySelector('.row-login');
    const routeStatus = fragment.querySelector('.row-live-status');
    const channel = fragment.querySelector('.row-channel');
    const role = fragment.querySelector('.row-role');
    const channelNote = fragment.querySelector('.channel-note');
    const test = fragment.querySelector('.row-test');
    const remove = fragment.querySelector('.row-remove');
    const accessibleName = notification.twitchLogin || 'new route';

    row.dataset.id = notification.id;
    enabled.setAttribute('aria-label', `Enable notification for ${accessibleName}`);
    login.setAttribute('aria-label', `Twitch username for ${accessibleName}`);
    channel.setAttribute('aria-label', `Discord channel for ${accessibleName}`);
    role.setAttribute('aria-label', `Discord role mention for ${accessibleName}`);
    enabled.checked = notification.enabled;
    login.value = notification.twitchLogin;
    renderRouteStatus(routeStatus, notification.twitchLogin);
    renderChannelOptions(channel, notification.discordChannelId);
    renderRoleOptions(role, notification.discordRoleId, findGuildIdForChannel(notification.discordChannelId));
    updateChannelNote(channelNote, notification.discordChannelId);

    enabled.addEventListener('change', () => {
      notification.enabled = enabled.checked;
      updateDirtyState();
    });

    login.addEventListener('input', () => {
      notification.twitchLogin = login.value;
      renderRouteStatus(routeStatus, notification.twitchLogin);
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

    test.addEventListener('click', async () => {
      if (isDirty()) {
        setStatus('Save changes before sending a test alert.');
        return;
      }

      try {
        setStatus('Sending test alert');
        await apiPost('/api/test-alert', { notificationId: notification.id });
        await loadSecondaryData();
        setStatus('Test alert sent');
      } catch (error) {
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
      renderRouteStatus(cell, notification.twitchLogin);
    }
  }
}

function renderRouteStatus(cell, login) {
  const normalizedLogin = normalizeLogin(login);

  if (!normalizedLogin) {
    cell.innerHTML = '<div class="route-status route-status-muted">No user set</div>';
    return;
  }

  const status = state.liveStatuses.find((item) => item.twitchLogin === normalizedLogin);

  if (!status) {
    cell.innerHTML = `
      <div class="route-status route-status-muted">
        <strong>Unknown</strong>
        <span>Not checked yet</span>
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
      <small>${escapeHtml(status.isLive ? status.title || 'Untitled stream' : status.displayName || normalizedLogin)}</small>
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
    return;
  }

  try {
    setStatus('Saving changes');
    state.config.pollIntervalSeconds = Number.parseInt(elements.pollInterval.value || '60', 10);
    const saved = await apiPut('/api/config', state.config);
    state.config = saved;
    state.lastSavedConfigJson = serializeConfig(saved);
    elements.pollInterval.value = saved.pollIntervalSeconds;
    renderRows();
    await loadSecondaryData();
    setStatus('Saved');
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  }
}

async function checkNow() {
  try {
    setStatus('Checking Twitch');
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

function findGuildIdForChannel(channelId) {
  return state.channels.find((channel) => channel.id === channelId)?.guildId || '';
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
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
  if (item.type === 'stream_offline') {
    return `${item.displayName || item.twitchLogin} went offline`;
  }
  return `Live alert: ${item.displayName || item.twitchLogin}`;
}

function historyDetail(item) {
  if (item.discordChannelName) {
    return `${item.discordGuildName || 'Discord'} / #${item.discordChannelName} via ${item.source}`;
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
    setStatus('Unsaved changes');
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
