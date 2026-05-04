import React from 'react';
import Select from 'react-select';
import { NavLink, useLocation } from 'react-router-dom';
import { Scrollbars } from 'react-custom-scrollbars-2';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { groupBy } from './utils.js';

const GRAD = 'linear-gradient(90deg, #4facfe 0%, #7367f0 100%)';
const TEXT_MUTED = '#a0aec0';
const TEXT_WHITE = '#ffffff';
const GREEN_GLOW = '#00e676';
const SELECT_MENU_PORTAL_STYLES = {
  menuPortal: (base) => ({ ...base, zIndex: 1400 }),
};

export function Sidebar({ status, errorCount = 0 }) {
  const links = [
    { to: '/', label: 'Dashboard', icon: '⬡' },
    { to: '/settings', label: 'Streamers', icon: '📡' },
    { to: '/history', label: 'History', icon: '◷' },
    { to: '/errors', label: 'Errors', icon: '⚠' },
  ];

  return (
    <Box sx={{
      width: 240,
      flex: '0 0 240px',
      borderRight: '1px solid rgba(255,255,255,0.08)',
      bgcolor: 'rgba(255,255,255,0.03)',
      height: '100vh',
      overflow: 'hidden',
      display: { xs: 'none', md: 'block' },
    }}>
      <Scrollbars autoHide>
        <Box sx={{ py: 3, px: 2, height: '100vh', display: 'flex', flexDirection: 'column' }}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 4, px: 1 }}>
            <Box sx={{
              width: 38,
              height: 38,
              borderRadius: '10px',
              display: 'grid',
              placeItems: 'center',
              background: GRAD,
              color: '#fff',
              fontWeight: 800,
            }}>
              R
            </Box>
            <Box>
              <Typography sx={{ color: TEXT_WHITE, fontWeight: 800, fontSize: 16, lineHeight: 1.2 }}>Relay</Typography>
              <Typography sx={{ color: TEXT_MUTED, fontSize: 11, lineHeight: 1 }}>Notification Bot</Typography>
            </Box>
          </Stack>
          <Stack spacing={0.5} sx={{ flex: 1 }}>
            {links.map((link) => (
              <Button
                key={link.to}
                component={NavLink}
                to={link.to}
                end={link.to === '/'}
                startIcon={<NavGlyph>{link.icon}</NavGlyph>}
                sx={{
                  justifyContent: 'flex-start',
                  px: 1.5,
                  py: 1.1,
                  color: TEXT_MUTED,
                  borderRadius: '10px',
                  '&.active': {
                    color: '#fff',
                    background: GRAD,
                    '&:hover': { background: GRAD },
                  },
                  '&:hover': { background: 'rgba(255,255,255,0.05)' },
                }}
              >
                <Box component="span" sx={{ flex: 1, textAlign: 'left' }}>{link.label}</Box>
                {link.to === '/errors' && errorCount > 0 ? <ErrorBadge>{errorCount}</ErrorBadge> : null}
              </Button>
            ))}
          </Stack>
          <Box sx={{
            mt: 2,
            px: 1.5,
            py: 1.2,
            borderRadius: '10px',
            background: status?.botTag ? 'rgba(0,230,118,0.08)' : 'rgba(252,81,81,0.08)',
            border: status?.botTag ? '1px solid rgba(0,230,118,0.2)' : '1px solid rgba(252,81,81,0.2)',
          }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <LiveDot live={Boolean(status?.botTag)} />
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ color: status?.botTag ? GREEN_GLOW : '#fc9090', fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>
                  {status?.botTag ? 'Bot Online' : 'Bot Offline'}
                </Typography>
                <Typography sx={{ color: TEXT_MUTED, fontSize: 11 }}>
                  Polling · {status?.pollIntervalSeconds ?? '-'}s
                </Typography>
              </Box>
            </Stack>
          </Box>
        </Box>
      </Scrollbars>
    </Box>
  );
}

function NavGlyph({ children }) {
  return (
    <Box component="span" sx={{
      width: 20,
      height: 20,
      display: 'inline-grid',
      placeItems: 'center',
      fontSize: '0.9rem',
      fontWeight: 800,
    }}>
      {children}
    </Box>
  );
}

function ErrorBadge({ children }) {
  return (
    <Box component="span" sx={{
      minWidth: 20,
      height: 20,
      px: 0.8,
      borderRadius: 999,
      display: 'inline-grid',
      placeItems: 'center',
      bgcolor: '#fc5151',
      color: '#fff',
      fontSize: 11,
      fontWeight: 700,
    }}>
      {children}
    </Box>
  );
}

export function LiveDot({ live }) {
  return (
    <Box sx={{
      width: 9,
      height: 9,
      borderRadius: '50%',
      flexShrink: 0,
      background: live ? GREEN_GLOW : 'rgba(255,255,255,0.2)',
      boxShadow: live ? `0 0 6px 2px ${GREEN_GLOW}` : 'none',
    }} />
  );
}

export function TopBar({ status, onLogout, liveCount = 0 }) {
  const location = useLocation();
  const page = location.pathname === '/settings'
    ? 'Streamers'
    : location.pathname === '/history'
      ? 'Alert History'
      : location.pathname === '/errors'
        ? 'Error Log'
        : 'Dashboard';
  const subtitle = page === 'Dashboard'
    ? `Relay · Twitch & YouTube to Discord · ${liveCount} live now`
    : page === 'Streamers'
      ? 'Manage notification routes'
      : page === 'Alert History'
        ? 'Recent alert activity'
        : 'Logged bot errors';
  const eventSub = status?.eventSub || {};
  const eventSubText = eventSub.mode === 'websocket'
    ? eventSub.connected ? `EventSub live (${eventSub.subscriptions})` : 'EventSub reconnecting'
    : eventSub.mode === 'disabled' ? 'EventSub disabled' : 'Polling fallback';

  return (
    <Stack direction={{ xs: 'column', lg: 'row' }} justifyContent="space-between" spacing={1.5} sx={{ mb: 3 }}>
      <Box>
        <Typography sx={{ color: TEXT_WHITE, fontWeight: 800, fontSize: 22 }}>{page}</Typography>
        <Typography sx={{ color: TEXT_MUTED, fontSize: 13, mt: 0.2 }}>{subtitle}</Typography>
      </Box>
      <Stack direction="row" flexWrap="wrap" gap={1} alignItems="center">
        <Chip label={status?.botTag ? `● Online as ${status.botTag}` : 'Offline'} color="primary" variant="outlined" />
        <Chip label={eventSubText} color="secondary" variant="outlined" />
        <Chip label={`${status?.activeNotifications ?? 0} active`} variant="outlined" />
        <Button variant="outlined" color="inherit" onClick={onLogout}>Log out</Button>
      </Stack>
    </Stack>
  );
}

export function StatusStrip({ status }) {
  const eventSub = status?.eventSub || {};
  const eventSubText = eventSub.mode === 'websocket'
    ? eventSub.connected ? `EventSub live (${eventSub.subscriptions})` : 'EventSub reconnecting'
    : eventSub.mode === 'disabled' ? 'EventSub disabled' : 'Polling fallback';

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} justifyContent="space-between" spacing={1.5}>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            <Chip label={status?.botTag ? `Online as ${status.botTag}` : 'Offline'} color="primary" variant="outlined" />
            <Chip label={eventSubText} color="secondary" variant="outlined" />
            <Chip label={`${status?.activeNotifications ?? 0} active`} variant="outlined" />
            <Chip label={`${status?.pollIntervalSeconds ?? '-'}s poll`} variant="outlined" />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function PageCard({ title, action, children }) {
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h2">{title}</Typography>
          {action}
        </Stack>
        {children}
      </CardContent>
    </Card>
  );
}

export function EmptyState({ children }) {
  return (
    <Box sx={{
      py: 5,
      textAlign: 'center',
      color: 'text.secondary',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 4,
      background: 'rgba(255,255,255,0.03)',
    }}>
      <Typography>{children}</Typography>
    </Box>
  );
}

export function ChannelSelect({ channels, selectedId, onChange }) {
  const options = [...groupBy(channels, 'guildName')].map(([guildName, items]) => ({
    label: guildName,
    options: items
      .filter((channel) => channel.canSend || channel.id === selectedId)
      .map((channel) => ({
        value: channel.id,
        label: `#${channel.name}${channel.canSend ? '' : ' (missing permission)'}`,
        isDisabled: !channel.canSend,
      })),
  })).filter((group) => group.options.length > 0);

  return (
    <Select
      classNamePrefix="select"
      options={options}
      value={options.flatMap((group) => group.options).find((option) => option.value === selectedId) || null}
      onChange={(option) => onChange(option?.value || '')}
      placeholder="Choose a channel"
      isClearable
      menuPortalTarget={document.body}
      menuPosition="fixed"
      styles={SELECT_MENU_PORTAL_STYLES}
    />
  );
}

export function RoleSelect({ roles, guildId, selectedId, onChange }) {
  const options = [
    { value: '', label: 'No role mention' },
    ...roles
      .filter((role) => role.guildId === guildId)
      .filter((role) => role.canMention || role.id === selectedId)
      .map((role) => ({
        value: role.id,
        label: `@${role.name}${role.canMention ? '' : ' (cannot mention)'}`,
        isDisabled: !role.canMention,
      })),
  ];

  return (
    <Select
      classNamePrefix="select"
      options={options}
      value={options.find((option) => option.value === selectedId) || options[0]}
      onChange={(option) => onChange(option?.value || '')}
      placeholder="No role mention"
      menuPortalTarget={document.body}
      menuPosition="fixed"
      styles={SELECT_MENU_PORTAL_STYLES}
    />
  );
}

export function SectionDivider() {
  return <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', my: 2 }} />;
}
