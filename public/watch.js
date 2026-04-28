const channel = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '')
  .trim()
  .toLowerCase()
  .replace(/^@/, '');
const fallback = document.querySelector('#fallback');

if (!/^[a-z0-9_]{3,25}$/.test(channel) || !window.Twitch?.Embed) {
  showFallback(channel);
} else {
  const embed = new Twitch.Embed('twitch-player', {
    width: '100%',
    height: '100%',
    channel,
    parent: [window.location.hostname],
    autoplay: true,
    muted: false,
    layout: 'video',
  });

  const setOnePercentVolume = () => {
    const player = embed.getPlayer();
    player.setMuted(false);
    player.setVolume(0.01);
  };

  embed.addEventListener(Twitch.Embed.VIDEO_READY, () => {
    setOnePercentVolume();
    setTimeout(setOnePercentVolume, 500);
    setTimeout(setOnePercentVolume, 2000);
  });
}

function showFallback(login) {
  const safeLogin = login && /^[a-z0-9_]{3,25}$/.test(login) ? login : 'twitch';
  fallback.hidden = false;
  fallback.innerHTML = `<a href="https://www.twitch.tv/${safeLogin}">Open Twitch channel</a>`;
}
