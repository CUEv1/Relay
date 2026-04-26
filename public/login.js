const form = document.querySelector('#login-form');
const status = document.querySelector('#login-status');
const username = document.querySelector('#username');
const password = document.querySelector('#password');

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
      window.location.href = '/';
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
    window.location.href = '/';
  }
} catch {
  status.textContent = 'Session check failed. You can still try logging in.';
}
