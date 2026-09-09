require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DISCORD_FOUNDER_ROLE_ID,
  FRONTEND_URL,
  SESSION_SECRET,
  PORT = 3000,
} = process.env;

// Support multiple frontend origins (comma-separated), e.g. custom domain + Netlify preview URL.
const ALLOWED_ORIGINS = (FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);

const REQUIRED_ENV = [
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI',
  'DISCORD_GUILD_ID', 'DISCORD_FOUNDER_ROLE_ID', 'FRONTEND_URL', 'SESSION_SECRET',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for secure cookies to work.

app.use(cookieParser());
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin/non-browser requests (no Origin header) and any allowed frontend origin.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

const COOKIE_NAME = 'fa_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,       // required for SameSite=None; Render serves HTTPS by default.
  sameSite: 'none',    // frontend (Netlify/Vercel) and backend (Render) are different domains.
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
};

// ---------------------------------------------------------------------------
// Step 1: Kick off Discord OAuth
// ---------------------------------------------------------------------------
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    prompt: 'consent',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ---------------------------------------------------------------------------
// Step 2: Discord redirects back here with a ?code=
// ---------------------------------------------------------------------------
app.get('/auth/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  const frontend = ALLOWED_ORIGINS[0] || '/';

  if (error || !code) {
    return res.redirect(`${frontend}?auth=error`);
  }

  try {
    // Exchange the code for an access token.
    const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenResp.ok) {
      console.error('Token exchange failed', await tokenResp.text());
      return res.redirect(`${frontend}?auth=error`);
    }
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    // Get basic Discord identity.
    const userResp = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userResp.ok) {
      console.error('Fetching user failed', await userResp.text());
      return res.redirect(`${frontend}?auth=error`);
    }
    const discordUser = await userResp.json();

    // Get this user's member object (and roles) for OUR specific guild.
    // Requires the guilds.members.read scope — no bot token needed.
    const memberResp = await fetch(
      `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    let isFounder = false;
    let inGuild = false;

    if (memberResp.ok) {
      inGuild = true;
      const member = await memberResp.json();
      const roles = member.roles || [];
      isFounder = roles.includes(DISCORD_FOUNDER_ROLE_ID);
    } else if (memberResp.status === 404) {
      // User authorized the app but isn't actually a member of the guild.
      inGuild = false;
    } else {
      console.error('Fetching guild member failed', await memberResp.text());
    }

    const sessionToken = jwt.sign(
      {
        discordId: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
        inGuild,
        isFounder,
      },
      SESSION_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
    return res.redirect(`${frontend}?auth=success`);
  } catch (err) {
    console.error(err);
    return res.redirect(`${frontend}?auth=error`);
  }
});

// ---------------------------------------------------------------------------
// Step 3: Frontend asks "who am I / am I a verified Founder?"
// ---------------------------------------------------------------------------
app.get('/api/session', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.json({ loggedIn: false });

  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    return res.json({
      loggedIn: true,
      discordId: payload.discordId,
      username: payload.username,
      avatar: payload.avatar,
      inGuild: payload.inGuild,
      isFounder: payload.isFounder,
    });
  } catch (e) {
    return res.json({ loggedIn: false });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Middleware you can reuse to protect any future "create profile" API route.
// The frontend hiding the button is a UX nicety — THIS is the real enforcement.
// ---------------------------------------------------------------------------
function requireFounder(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in with Discord.' });
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (!payload.isFounder) {
      return res.status(403).json({ error: 'Founder role required.' });
    }
    req.discordUser = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please sign in again.' });
  }
}

// Example placeholder — wire your real profile-save logic here later.
// Currently profiles are stored client-side (localStorage) in fwy.html, so this
// endpoint isn't called yet, but it shows the pattern for when you move profile
// storage server-side.
app.post('/api/profile', requireFounder, express.json(), (req, res) => {
  // TODO: persist req.body to a real database, keyed by req.discordUser.discordId
  res.json({ ok: true, discordId: req.discordUser.discordId });
});

app.get('/', (req, res) => res.send('Fadeaway Discord auth backend is running.'));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
