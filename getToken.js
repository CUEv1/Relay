import 'dotenv/config';

const clientId = process.env.TWITCH_CLIENT_ID?.trim();
const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  throw new Error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env first.');
}

const res = await fetch("https://id.twitch.tv/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  }),
});

const data = await res.json();
if (!res.ok) {
  throw new Error(`Token request failed: ${res.status} ${JSON.stringify(data)}`);
}

console.log(data.access_token);
