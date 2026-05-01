const form = document.querySelector('#login-form');
const status = document.querySelector('#login-status');
const username = document.querySelector('#username');
const password = document.querySelector('#password');

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function spawnRipple(target, event) {
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.1;
  const x = (event.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
  const y = (event.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;
  const wave = document.createElement('span');
  wave.className = 'ripple-wave';
  wave.style.width = wave.style.height = `${size}px`;
  wave.style.left = `${x}px`;
  wave.style.top = `${y}px`;
  target.appendChild(wave);
  wave.addEventListener('animationend', () => wave.remove(), { once: true });
}

document.addEventListener('pointerdown', (event) => {
  if (reduceMotion) return;
  const target = event.target.closest('button, .button, .icon-button');
  if (!target || target.disabled) return;
  spawnRipple(target, event);
});

let lastPointer = null;
document.addEventListener('pointerdown', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY };
}, true);

function leaveToApp() {
  if (reduceMotion) {
    window.location.href = '/';
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  const rect = submitButton.getBoundingClientRect();
  const useClick = lastPointer
    && lastPointer.x >= rect.left - 4 && lastPointer.x <= rect.right + 4
    && lastPointer.y >= rect.top - 4 && lastPointer.y <= rect.bottom + 4;
  const wx = useClick ? lastPointer.x : rect.left + rect.width / 2;
  const wy = useClick ? lastPointer.y : rect.top + rect.height / 2;

  const xPct = (wx / window.innerWidth) * 100;
  const yPct = (wy / window.innerHeight) * 100;

  document.body.style.setProperty('--wx', `${xPct}%`);
  document.body.style.setProperty('--wy', `${yPct}%`);

  try {
    sessionStorage.setItem('relay:warp', JSON.stringify({
      x: xPct,
      y: yPct,
      t: Date.now(),
    }));
  } catch {}

  document.body.classList.add('is-warping');
  window.setTimeout(() => {
    window.location.href = '/';
  }, 660);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = '';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
      }),
    });

    if (response.ok) {
      leaveToApp();
      return;
    }

    const payload = await response.json().catch(() => ({}));
    status.textContent = Array.isArray(payload.errors)
      ? payload.errors.join(' ')
      : 'Login failed.';
  } catch (error) {
    status.textContent = `Login failed: ${error.message}`;
  }
});

try {
  const session = await fetch('/api/session').then((response) => response.json());
  if (session.authenticated) {
    leaveToApp();
  }
} catch {
  status.textContent = 'Session check failed. You can still try logging in.';
}
