(async function initLogin() {
  const form = document.querySelector('#login-form');
  const username = document.querySelector('#username');
  const password = document.querySelector('#password');
  const button = document.querySelector('#login-button');
  const status = document.querySelector('#login-status');

  try {
    const session = await request('/api/session', { method: 'GET' });
    if (session.authenticated || !session.authRequired) {
      window.location.href = '/';
      return;
    }
  } catch {
    status.textContent = 'Unable to check session status.';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    button.disabled = true;
    button.textContent = 'Signing in';

    try {
      await request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.value,
          password: password.value,
        }),
      });
      window.location.href = '/';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}());

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(Array.isArray(payload.errors) ? payload.errors.join(' ') : 'Request failed.');
  }

  return payload;
}
