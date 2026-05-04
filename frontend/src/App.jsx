import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'react-apexcharts';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ThemeProvider,
  Typography,
} from '@mui/material';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { apiDelete, apiGet, apiPost, apiPut } from './api.js';
import { ChannelSelect, EmptyState, LiveDot, RoleSelect, SectionDivider, Sidebar, TopBar } from './components.jsx';
import { theme } from './theme.js';
import {
  createNotification,
  formatDate,
  formatDetails,
  getEffectiveEmbedColor,
  getIdentity,
  getProvider,
  historyDetail,
  historyTitle,
  normalizeConfig,
  normalizeHexColor,
  normalizeLogin,
  normalizeOptionalHexColor,
  normalizeYoutubeInput,
  setIdentity,
} from './utils.js';
import './styles.css';

const SETTINGS_CARD_CONTENT_SX = { p: 1.5, '&:last-child': { pb: 1.5 } };
const COMPACT_FIELD_LABEL_SX = { display: 'block', mb: 0.4, lineHeight: 1.2 };
const COMPACT_SWITCH_LABEL_SX = { fontSize: 13 };

export default function App() {
  const [config, setConfig] = useState(null);
  const [channels, setChannels] = useState([]);
  const [roles, setRoles] = useState([]);
  const [status, setStatus] = useState(null);
  const [liveStatuses, setLiveStatuses] = useState([]);
  const [history, setHistory] = useState([]);
  const [errors, setErrors] = useState([]);
  const [saveState, setSaveState] = useState('Loading');
  const [preview, setPreview] = useState(null);
  const [bootError, setBootError] = useState('');
  const [lastSavedJson, setLastSavedJson] = useState('');
  const saveTimer = useRef(null);
  const saveInFlight = useRef(false);
  const pendingSave = useRef(null);

  const loadSecondaryData = useCallback(async () => {
    const [livePayload, historyPayload, errorPayload, statusPayload] = await Promise.all([
      apiGet('/api/live-status'),
      apiGet('/api/history'),
      apiGet('/api/errors'),
      apiGet('/api/status'),
    ]);
    setLiveStatuses(livePayload.statuses || []);
    setHistory(historyPayload.history || []);
    setErrors(errorPayload.errors || []);
    setStatus(statusPayload);
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const session = await apiGet('/api/session');
      if (!session.authenticated && session.authRequired) {
        window.location.href = '/login';
        return;
      }

      const [configPayload, channelPayload, rolePayload, statusPayload] = await Promise.all([
        apiGet('/api/config'),
        apiGet('/api/discord/channels'),
        apiGet('/api/discord/roles'),
        apiGet('/api/status'),
      ]);
      const normalized = normalizeConfig(configPayload);
      setConfig(normalized);
      setLastSavedJson(JSON.stringify(normalized));
      setChannels(channelPayload.channels || []);
      setRoles(rolePayload.roles || []);
      setStatus(statusPayload);
      setSaveState('Loaded');
      await loadSecondaryData();
    } catch (error) {
      setBootError(error.message);
      setSaveState(`Load failed: ${error.message}`);
    }
  }, [loadSecondaryData]);

  useEffect(() => {
    loadDashboard();
    const refresh = window.setInterval(() => {
      loadSecondaryData().catch((error) => setSaveState(`Refresh failed: ${error.message}`));
    }, 15000);
    return () => window.clearInterval(refresh);
  }, [loadDashboard, loadSecondaryData]);

  const saveConfig = useCallback(async (nextConfig = config) => {
    if (!nextConfig) return false;
    window.clearTimeout(saveTimer.current);
    const requestConfig = normalizeConfig(nextConfig);
    const draftErrors = getConfigDraftErrors(requestConfig);

    if (draftErrors.length > 0) {
      setSaveState(draftErrors[0]);
      return false;
    }

    if (saveInFlight.current) {
      pendingSave.current = requestConfig;
      setSaveState('Saving changes');
      return true;
    }

    saveInFlight.current = true;
    const requestJson = JSON.stringify(requestConfig);

    try {
      setSaveState('Saving changes');
      const saved = normalizeConfig(await apiPut('/api/config', requestConfig));
      const savedJson = JSON.stringify(saved);
      setLastSavedJson(savedJson);
      setConfig((current) => (JSON.stringify(normalizeConfig(current)) === requestJson ? saved : current));
      await loadSecondaryData();
      setSaveState('Saved');
      return true;
    } catch (error) {
      setSaveState(`Save failed: ${error.message}`);
      return false;
    } finally {
      saveInFlight.current = false;
      if (pendingSave.current) {
        const nextPendingSave = pendingSave.current;
        pendingSave.current = null;
        window.setTimeout(() => saveConfig(nextPendingSave), 0);
      }
    }
  }, [config, loadSecondaryData]);

  const scheduleSave = useCallback((nextConfig) => {
    setSaveState('Auto-saving changes');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveConfig(nextConfig);
    }, 800);
  }, [saveConfig]);

  const updateConfig = useCallback((updater) => {
    setConfig((current) => {
      const next = normalizeConfig(typeof updater === 'function' ? updater(current) : updater);
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const updateNotification = useCallback((id, updater) => {
    updateConfig((current) => ({
      ...current,
      notifications: current.notifications.map((notification) => {
        if (notification.id !== id) return notification;
        return normalizeNotification(typeof updater === 'function' ? updater(notification) : { ...notification, ...updater });
      }),
    }));
  }, [updateConfig]);

  const addNotification = useCallback(() => {
    updateConfig((current) => ({
      ...current,
      notifications: [...current.notifications, createNotification()],
    }));
  }, [updateConfig]);

  const removeNotification = useCallback((id) => {
    updateConfig((current) => ({
      ...current,
      notifications: current.notifications.filter((notification) => notification.id !== id),
    }));
  }, [updateConfig]);

  const checkNow = useCallback(async () => {
    try {
      setSaveState('Checking notifications');
      await apiPost('/api/check-now', {});
      await loadSecondaryData();
      setSaveState('Check complete');
    } catch (error) {
      setSaveState(`Check failed: ${error.message}`);
    }
  }, [loadSecondaryData]);

  const clearErrors = useCallback(async () => {
    try {
      await apiDelete('/api/errors');
      await loadSecondaryData();
      setSaveState('Errors cleared');
    } catch (error) {
      setSaveState(`Clear failed: ${error.message}`);
    }
  }, [loadSecondaryData]);

  const logout = useCallback(async () => {
    await apiPost('/api/logout', {});
    window.location.href = '/login';
  }, []);

  const ensureSaved = useCallback(async () => {
    if (!config) return false;
    if (JSON.stringify(normalizeConfig(config)) === lastSavedJson) return true;
    return saveConfig(config);
  }, [config, lastSavedJson, saveConfig]);

  const previewAlert = useCallback(async (notificationId) => {
    if (!(await ensureSaved())) return;
    try {
      const payload = await apiPost('/api/test-alert-preview', { notificationId });
      setPreview(payload.preview);
      setSaveState('Preview loaded');
    } catch (error) {
      setSaveState(`Preview failed: ${error.message}`);
    }
  }, [ensureSaved]);

  const sendTestAlert = useCallback(async (notificationId) => {
    if (!(await ensureSaved())) return;
    try {
      setSaveState('Sending test alert');
      await apiPost('/api/test-alert', { notificationId });
      await loadSecondaryData();
      setSaveState('Test alert sent');
    } catch (error) {
      setSaveState(`Test failed: ${error.message}`);
    }
  }, [ensureSaved, loadSecondaryData]);

  const pageProps = useMemo(() => ({
    config,
    channels,
    roles,
    liveStatuses,
    history,
    errors,
    saveState,
    onAdd: addNotification,
    onCheckNow: checkNow,
    onClearErrors: clearErrors,
    onRefresh: loadDashboard,
    onRemove: removeNotification,
    onSendTest: sendTestAlert,
    onUpdateConfig: updateConfig,
    onUpdateNotification: updateNotification,
    onPreview: previewAlert,
  }), [
    addNotification,
    channels,
    checkNow,
    clearErrors,
    config,
    errors,
    history,
    liveStatuses,
    loadDashboard,
    previewAlert,
    removeNotification,
    roles,
    saveState,
    sendTestAlert,
    updateConfig,
    updateNotification,
  ]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <HashRouter>
        <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
          <Sidebar status={status} errorCount={errors.length} />
          <Box
            component="main"
            sx={{
              flex: 1,
              height: '100vh',
              p: { xs: 2, md: 3 },
              minWidth: 0,
              overflowX: 'hidden',
              overflowY: 'auto',
            }}
          >
            <TopBar
              status={status}
              onLogout={logout}
              liveCount={liveStatuses.filter((item) => item.isLive).length}
            />
            {bootError ? <Alert severity="error" sx={{ mb: 2 }}>{bootError}</Alert> : null}
            <Routes>
              <Route path="/" element={<DashboardPage {...pageProps} />} />
              <Route path="/settings" element={<SettingsPage {...pageProps} />} />
              <Route path="/history" element={<HistoryPage {...pageProps} />} />
              <Route path="/errors" element={<ErrorsPage {...pageProps} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Box>
        </Box>
        <PreviewDialog preview={preview} onClose={() => setPreview(null)} />
      </HashRouter>
    </ThemeProvider>
  );
}

function DashboardPage({ config, liveStatuses, history, errors, onAdd, onCheckNow, onRefresh }) {
  const notifications = config?.notifications || [];
  const liveCount = liveStatuses.filter((item) => item.isLive).length;
  const liveNotifications = notifications.filter((notification) => findRouteStatus(notification, liveStatuses)?.isLive);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const alertsToday = history.filter((item) => new Date(item.sentAt || item.createdAt) >= todayStart).length;
  const series = [
    notifications.filter((item) => getProvider(item) === 'twitch').length,
    notifications.filter((item) => getProvider(item) === 'youtube').length,
    liveCount,
  ];

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
        <Typography color="text.secondary">{notifications.length} notification routes configured</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={onRefresh}>Refresh</Button>
          <Button variant="outlined" onClick={onCheckNow}>Check now</Button>
          <Button variant="contained" onClick={onAdd}>Add streamer</Button>
        </Stack>
      </Stack>

      <Grid container spacing={2}>
        <StatCard
          label="Total Streamers"
          value={notifications.length}
          icon="📡"
          iconColor="#4facfe"
          trend={`${notifications.filter((item) => getProvider(item) === 'twitch').length} Twitch · ${notifications.filter((item) => getProvider(item) === 'youtube').length} YouTube`}
        />
        <StatCard
          label="Live Now"
          value={liveCount}
          icon="●"
          iconColor="#00e676"
          trend={liveNotifications.length ? liveNotifications.map(getIdentity).slice(0, 2).join(', ') : 'All offline'}
        />
        <StatCard label="Alerts Today" value={alertsToday} icon="🔔" iconColor="#7367f0" trend="Since local midnight" />
        <StatCard label="Errors" value={errors.length} icon="⚠" iconColor={errors.length ? '#fc5151' : '#4facfe'} trend={errors.length ? 'Needs attention' : 'All clear'} />
      </Grid>

      {liveNotifications.length > 0 ? (
        <Box>
          <Typography sx={{ color: '#fff', fontWeight: 700, fontSize: 15, mb: 1.5 }}>● Live Now</Typography>
          <Grid container spacing={2}>
            {liveNotifications.map((notification) => (
              <Grid item xs={12} lg={4} key={notification.id}>
                <StreamerCard notification={notification} liveStatuses={liveStatuses} recentHistory={history} compact />
              </Grid>
            ))}
          </Grid>
        </Box>
      ) : null}

      <Grid container spacing={2}>
        <Grid item xs={12} lg={8}>
          <Card sx={{ overflow: 'hidden' }}>
            <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2.5, py: 2 }}>
                <Typography sx={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>All Streamers</Typography>
                <Button size="small" variant="contained" onClick={onAdd}>Add Streamer</Button>
              </Stack>
              {notifications.length === 0 ? <Box sx={{ p: 2 }}><EmptyState>No notifications configured.</EmptyState></Box> : (
                <Box>
                  {notifications.map((notification, index) => (
                    <StreamerTableRow
                      key={notification.id}
                      notification={notification}
                      liveStatuses={liveStatuses}
                      recentHistory={history}
                      last={index === notifications.length - 1}
                    />
                  ))}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} lg={4}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h2" sx={{ mb: 1.5 }}>Route mix</Typography>
              <Chart
                type="donut"
                height={240}
                series={series}
                options={{
                  chart: { foreColor: '#a0aec0', toolbar: { show: false } },
                  labels: ['Twitch', 'YouTube', 'Live'],
                  colors: ['#9146ff', '#ff6b6b', '#00e676'],
                  legend: { position: 'bottom' },
                  dataLabels: { enabled: false },
                  stroke: { colors: ['#0f1535'] },
                }}
              />
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Stack>
  );
}

function StatCard({ label, value, icon, iconColor, trend }) {
  return (
    <Grid item xs={12} sm={6} lg={3}>
      <Card>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Box>
              <Typography sx={{ color: '#a0aec0', fontSize: 13, fontWeight: 500, mb: 0.8, letterSpacing: '0.02em' }}>
                {label}
              </Typography>
              <Typography sx={{ color: '#fff', fontSize: 36, fontWeight: 800, lineHeight: 1 }}>
                {value}
              </Typography>
              <Typography sx={{ color: '#a0aec0', fontSize: 12, mt: 0.7 }}>{trend}</Typography>
            </Box>
            <Box sx={{
              width: 42,
              height: 42,
              borderRadius: '12px',
              background: `${iconColor}22`,
              border: `1px solid ${iconColor}44`,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}>
              <Typography sx={{ color: iconColor, fontSize: 18, fontWeight: 800 }}>{icon}</Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Grid>
  );
}

function StreamerCard({ notification, liveStatuses, recentHistory, compact = false }) {
  const provider = getProvider(notification);
  const identity = getIdentity(notification);
  const status = findRouteStatus(notification, liveStatuses);
  const latest = recentHistory.find((item) => item.notificationId === notification.id);
  const label = routeStatusLabel(provider, status, identity);

  return (
    <Card>
      <CardContent sx={{ p: compact ? 2 : 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Box sx={{ mt: 0.3 }}>
            <LiveDot live={Boolean(status?.isLive)} />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Typography sx={{ color: '#fff', fontWeight: 700, fontSize: 14 }} noWrap>{identity || `New ${provider} route`}</Typography>
              <ProviderBadge provider={provider} />
            </Stack>
            <Typography color="text.secondary" sx={{ mt: 0.5 }} noWrap>{label.detail}</Typography>
            <Typography color="text.secondary" sx={{ fontSize: 12, mt: 0.5 }}>Last alert: {latest ? formatDate(latest.sentAt || latest.createdAt) : 'Never'}</Typography>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function StreamerTableRow({ notification, liveStatuses, recentHistory, last }) {
  const provider = getProvider(notification);
  const identity = getIdentity(notification);
  const status = findRouteStatus(notification, liveStatuses);
  const latest = recentHistory.find((item) => item.notificationId === notification.id);
  const isLive = Boolean(status?.isLive);

  return (
    <Box sx={{
      display: 'flex',
      alignItems: 'center',
      px: 2.5,
      py: 1.6,
      gap: 2,
      borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.06)',
      transition: 'background 0.15s',
      '&:hover': { background: 'rgba(255,255,255,0.03)' },
    }}>
      <LiveDot live={isLive} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography sx={{ color: '#fff', fontWeight: 700, fontSize: 14 }} noWrap>{identity || `New ${provider} route`}</Typography>
          <ProviderBadge provider={provider} />
          {isLive ? <LiveBadge /> : null}
        </Stack>
        {isLive ? (
          <Typography sx={{ color: '#a0aec0', fontSize: 12, mt: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }}>
            {status.title || 'Live now'}
          </Typography>
        ) : (
          <Typography sx={{ color: 'rgba(160,174,192,0.5)', fontSize: 12, mt: 0.3 }}>
            Last alert: {latest ? formatDate(latest.sentAt || latest.createdAt) : 'Never'}
          </Typography>
        )}
      </Box>
      {isLive ? (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0, mr: 1, display: { xs: 'none', md: 'flex' } }}>
          <Typography sx={{ color: '#4facfe', fontSize: 12, fontWeight: 600 }}>{status.gameName || 'No category'}</Typography>
          <Box sx={{ background: 'rgba(0,230,118,0.1)', borderRadius: 999, px: 1, py: 0.2 }}>
            <Typography sx={{ color: '#00e676', fontSize: 11, fontWeight: 700 }}>{formatViewers(status.viewerCount)}</Typography>
          </Box>
        </Stack>
      ) : null}
      <Button size="small" variant="outlined" href="#/settings">Edit</Button>
    </Box>
  );
}

function ProviderBadge({ provider }) {
  const isTwitch = provider === 'twitch';
  return (
    <Box sx={{
      background: isTwitch ? 'rgba(145,70,255,0.15)' : 'rgba(255,0,0,0.12)',
      borderRadius: 999,
      px: 0.9,
      py: 0.15,
      flexShrink: 0,
    }}>
      <Typography sx={{ color: isTwitch ? '#b97aff' : '#ff6b6b', fontSize: 10, fontWeight: 700 }}>
        {provider.toUpperCase()}
      </Typography>
    </Box>
  );
}

function LiveBadge() {
  return (
    <Box sx={{ background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 999, px: 1, py: 0.15 }}>
      <Typography sx={{ color: '#00e676', fontSize: 10, fontWeight: 700 }}>LIVE</Typography>
    </Box>
  );
}

function SettingsPage(props) {
  const {
    config,
    channels,
    roles,
    saveState,
    onAdd,
    onRemove,
    onSendTest,
    onUpdateConfig,
    onUpdateNotification,
    onPreview,
  } = props;

  if (!config) return <EmptyState>Loading settings.</EmptyState>;

  return (
    <Stack spacing={1.25}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ sm: 'center' }}>
        <Box>
          <Typography variant="h1">Streamer settings</Typography>
          <Typography color="text.secondary" sx={{ fontSize: 13 }}>{saveState}</Typography>
        </Box>
        <Button size="small" variant="contained" onClick={onAdd}>Add streamer</Button>
      </Stack>

      <Card>
        <CardContent sx={SETTINGS_CARD_CONTENT_SX}>
          <Grid container spacing={1.25}>
            <Grid item xs={12} md={4}>
              <TextField
                size="small"
                fullWidth
                type="number"
                label="Poll interval seconds"
                value={config.pollIntervalSeconds}
                onChange={(event) => onUpdateConfig({
                  ...config,
                  pollIntervalSeconds: Number.parseInt(event.target.value || '60', 10),
                })}
                inputProps={{ min: 10 }}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                size="small"
                fullWidth
                label="Twitch default embed color"
                value={config.embedDefaults.twitch.color}
                onChange={(event) => onUpdateConfig({
                  ...config,
                  embedDefaults: {
                    ...config.embedDefaults,
                    twitch: { color: normalizeHexColor(event.target.value) },
                  },
                })}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                size="small"
                fullWidth
                label="YouTube default embed color"
                value={config.embedDefaults.youtube.color}
                onChange={(event) => onUpdateConfig({
                  ...config,
                  embedDefaults: {
                    ...config.embedDefaults,
                    youtube: { color: normalizeHexColor(event.target.value) },
                  },
                })}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {config.notifications.length === 0 ? <EmptyState>No notifications configured.</EmptyState> : config.notifications.map((notification) => (
        <RouteSettingsCard
          key={notification.id}
          config={config}
          notification={notification}
          channels={channels}
          roles={roles}
          onRemove={() => onRemove(notification.id)}
          onPreview={() => onPreview(notification.id)}
          onSendTest={() => onSendTest(notification.id)}
          onUpdate={(updater) => onUpdateNotification(notification.id, updater)}
        />
      ))}
    </Stack>
  );
}

function RouteSettingsCard({
  config,
  notification,
  channels,
  roles,
  onRemove,
  onPreview,
  onSendTest,
  onUpdate,
}) {
  const provider = getProvider(notification);
  const identity = getIdentity(notification);
  const selectedChannel = channels.find((channel) => channel.id === notification.discordChannelId);
  const guildId = selectedChannel?.guildId || '';
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  const confirmRemove = () => {
    setConfirmRemoveOpen(false);
    onRemove();
  };

  return (
    <Card>
      <CardContent sx={SETTINGS_CARD_CONTENT_SX}>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1} justifyContent="space-between" sx={{ mb: 1.25 }}>
          <Box>
            <Typography variant="h2">{identity || 'New streamer route'}</Typography>
            <Typography color="text.secondary" sx={{ fontSize: 12, lineHeight: 1.3 }}>
              {provider === 'youtube' ? 'YouTube settings' : 'Twitch settings'}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            <Button size="small" variant="outlined" onClick={onPreview}>Preview</Button>
            <Button size="small" variant="outlined" onClick={onSendTest}>Send test</Button>
            <Button size="small" variant="outlined" color="error" onClick={() => setConfirmRemoveOpen(true)}>Remove</Button>
          </Stack>
        </Stack>

        <Grid container spacing={1.25} alignItems="flex-start">
          <Grid item xs={12} sm={6} md={2}>
            <TextField
              size="small"
              select
              fullWidth
              SelectProps={{
                MenuProps: {
                  PaperProps: {
                    sx: {
                      backgroundColor: '#171d3f',
                      backgroundImage: 'none',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: '#ffffff',
                      '& .MuiMenuItem-root.Mui-selected': {
                        backgroundColor: 'rgba(79,172,254,0.22)',
                      },
                      '& .MuiMenuItem-root.Mui-selected:hover, & .MuiMenuItem-root:hover': {
                        backgroundColor: 'rgba(79,172,254,0.14)',
                      },
                    },
                  },
                },
              }}
              label="Platform"
              value={provider}
              onChange={(event) => onUpdate({
                ...notification,
                provider: event.target.value,
                twitchLogin: event.target.value === 'twitch' ? normalizeLogin(notification.twitchLogin) : '',
                youtubeChannelId: event.target.value === 'youtube' ? normalizeYoutubeInput(notification.youtubeChannelId) : '',
              })}
            >
              <MenuItem value="twitch">Twitch</MenuItem>
              <MenuItem value="youtube">YouTube</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <TextField
              size="small"
              fullWidth
              label={provider === 'youtube' ? 'YouTube channel URL or ID' : 'Twitch username'}
              value={getIdentity(notification)}
              onChange={(event) => onUpdate(setIdentity(notification, event.target.value))}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <TextField
              size="small"
              fullWidth
              label="Embed color"
              value={notification.embedColor || getEffectiveEmbedColor(config, notification)}
              onChange={(event) => onUpdate({
                ...notification,
                embedColor: normalizeOptionalHexColor(event.target.value),
              })}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={2}>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: 40 }}>
              <Switch
                size="small"
                checked={notification.enabled}
                onChange={(event) => onUpdate({ ...notification, enabled: event.target.checked })}
              />
              <Typography sx={COMPACT_SWITCH_LABEL_SX}>Enabled</Typography>
            </Stack>
          </Grid>
          <Grid item xs={12} md={6}>
            <Typography variant="caption" color="text.secondary" sx={COMPACT_FIELD_LABEL_SX}>Discord channel</Typography>
            <ChannelSelect
              channels={channels}
              selectedId={notification.discordChannelId}
              onChange={(channelId) => onUpdate(clearInvalidRole({ ...notification, discordChannelId: channelId }, channels, roles))}
            />
            {selectedChannel && !selectedChannel.canSend ? (
              <Typography variant="caption" color="error">Bot cannot send embeds in this channel.</Typography>
            ) : null}
          </Grid>
          <Grid item xs={12} md={6}>
            <Typography variant="caption" color="text.secondary" sx={COMPACT_FIELD_LABEL_SX}>Discord role mention</Typography>
            <RoleSelect
              roles={roles}
              guildId={guildId}
              selectedId={notification.discordRoleId}
              onChange={(roleId) => onUpdate({ ...notification, discordRoleId: roleId })}
            />
          </Grid>
          {provider === 'twitch' ? (
            <Grid item xs={12} sm={6} md={3}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: 40 }}>
                <Switch
                  size="small"
                  checked={notification.openBrowserOnLive}
                  onChange={(event) => onUpdate({ ...notification, openBrowserOnLive: event.target.checked })}
                />
                <Typography sx={COMPACT_SWITCH_LABEL_SX}>Open browser on live</Typography>
              </Stack>
            </Grid>
          ) : null}
        </Grid>
      </CardContent>
      <Dialog
        open={confirmRemoveOpen}
        onClose={() => setConfirmRemoveOpen(false)}
        maxWidth="xs"
        fullWidth
        PaperProps={{
          sx: {
            backgroundColor: '#171d3f',
            backgroundImage: 'none',
            border: '1px solid rgba(255,255,255,0.12)',
          },
        }}
      >
        <DialogTitle>Remove route?</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            This will remove {identity || 'this streamer route'} from the notification list.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" color="inherit" onClick={() => setConfirmRemoveOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={confirmRemove}>Remove</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function HistoryPage({ history, onRefresh }) {
  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography variant="h1">Alert history</Typography>
          <Typography color="text.secondary">{history.length} recent records</Typography>
        </Box>
        <Button variant="outlined" onClick={onRefresh}>Refresh</Button>
      </Stack>
      {history.length === 0 ? <EmptyState>No notification history yet.</EmptyState> : history.slice(0, 50).map((item, index) => (
        <Card key={`${item.createdAt || item.sentAt || index}-${index}`}>
          <CardContent>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
              <Box>
                <Typography variant="h2">{historyTitle(item)}</Typography>
                <Typography color="text.secondary">{historyDetail(item)}</Typography>
              </Box>
              <Typography color="text.secondary">{formatDate(item.sentAt || item.createdAt)}</Typography>
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

function ErrorsPage({ errors, onClearErrors, onRefresh }) {
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
        <Box>
          <Typography variant="h1">Error panel</Typography>
          <Typography color="text.secondary">{errors.length} logged errors</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={onRefresh}>Refresh</Button>
          <Button variant="outlined" color="error" onClick={onClearErrors}>Clear</Button>
        </Stack>
      </Stack>
      {errors.length === 0 ? <EmptyState>No errors logged.</EmptyState> : errors.slice(0, 50).map((item, index) => (
        <Card key={`${item.createdAt || index}-${index}`}>
          <CardContent>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
              <Box>
                <Typography variant="h2">{item.source}: {item.message}</Typography>
                <Typography color="text.secondary">{formatDetails(item.details)}</Typography>
              </Box>
              <Typography color="text.secondary">{formatDate(item.createdAt)}</Typography>
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

function PreviewDialog({ preview, onClose }) {
  const payload = preview?.payload || {};
  const embed = payload.embeds?.[0] || {};

  return (
    <Dialog open={Boolean(preview)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Discord embed preview</DialogTitle>
      <DialogContent>
        {payload.content ? <Alert severity="info" sx={{ mb: 2 }}>{payload.content}</Alert> : null}
        <Box sx={{ borderLeft: `4px solid ${embed.color ? `#${Number(embed.color).toString(16).padStart(6, '0')}` : '#5865f2'}`, pl: 2 }}>
          <Typography variant="h2">{embed.title || 'Untitled alert'}</Typography>
          {embed.url ? <Typography color="secondary">{embed.url}</Typography> : null}
          <Typography sx={{ my: 1 }}>{embed.description}</Typography>
          {embed.image?.url ? <Box component="img" src={embed.image.url} alt="" sx={{ width: '100%', borderRadius: 1, mt: 1 }} /> : null}
          {embed.thumbnail?.url ? <Box component="img" src={embed.thumbnail.url} alt="" sx={{ width: 72, height: 72, borderRadius: 1, mt: 1 }} /> : null}
          {embed.footer?.text ? <Typography color="text.secondary">{embed.footer.text}</Typography> : null}
        </Box>
      </DialogContent>
    </Dialog>
  );
}

function normalizeNotification(notification) {
  return normalizeConfig({ notifications: [notification] }).notifications[0];
}

function getConfigDraftErrors(config) {
  if (!Number.isFinite(config.pollIntervalSeconds) || config.pollIntervalSeconds < 10) {
    return ['Polling must be at least 10 seconds.'];
  }

  for (const notification of config.notifications) {
    const provider = getProvider(notification);
    const identity = getIdentity(notification);
    if (!identity || !notification.discordChannelId) {
      return [`Complete ${provider === 'youtube' ? 'YouTube channel' : 'Twitch username'} and Discord channel before saving.`];
    }
  }

  return [];
}

function clearInvalidRole(notification, channels, roles) {
  const channel = channels.find((item) => item.id === notification.discordChannelId);
  if (!channel || !notification.discordRoleId) return { ...notification, discordRoleId: '' };
  const role = roles.find((item) => (
    item.id === notification.discordRoleId &&
    item.guildId === channel.guildId &&
    item.canMention
  ));
  return role ? notification : { ...notification, discordRoleId: '' };
}

function findRouteStatus(notification, liveStatuses) {
  const provider = getProvider(notification);
  const identity = getIdentity(notification);
  const statusKey = `${provider}:${identity}`;
  return liveStatuses.find((item) => (
    item.statusKey === statusKey ||
    (provider === 'twitch' && item.twitchLogin === identity) ||
    (provider === 'youtube' && item.youtubeChannelId === identity)
  ));
}

function routeStatusLabel(provider, status, identity) {
  if (!identity) {
    return { label: 'No user', detail: 'Set an account before saving.', color: 'default', variant: 'outlined' };
  }
  if (!status) {
    return { label: 'Unknown', detail: 'Not checked yet.', color: 'default', variant: 'outlined' };
  }
  if (provider === 'youtube') {
    return {
      label: status.hasLatestVideo ? 'Latest' : 'No videos',
      detail: status.hasLatestVideo ? status.title || 'Latest video found.' : `Last check ${formatDate(status.lastCheckedAt)}`,
      color: status.hasLatestVideo ? 'secondary' : 'default',
      variant: 'outlined',
    };
  }
  return {
    label: status.isLive ? 'Live' : 'Offline',
    detail: status.isLive
      ? `${status.gameName || 'No category'} - ${status.viewerCount ?? 0} viewers`
      : `Last check ${formatDate(status.lastCheckedAt)}`,
    color: status.isLive ? 'primary' : 'default',
    variant: status.isLive ? 'filled' : 'outlined',
  };
}

function formatViewers(value) {
  const numberValue = Number(value || 0);
  if (numberValue >= 1000) return `${(numberValue / 1000).toFixed(1)}K`;
  return String(numberValue);
}
