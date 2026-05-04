export async function apiGet(url, redirectOnAuth = true) {
  return api(url, { method: 'GET' }, redirectOnAuth);
}

export async function apiPut(url, body, redirectOnAuth = true) {
  return api(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, redirectOnAuth);
}

export async function apiPost(url, body = {}, redirectOnAuth = true) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, redirectOnAuth);
}

export async function apiDelete(url, redirectOnAuth = true) {
  return api(url, { method: 'DELETE' }, redirectOnAuth);
}

export async function api(url, options, redirectOnAuth = true) {
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
    throw new Error(message);
  }

  return payload;
}
