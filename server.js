require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DISCORD_FOUNDER_ROLE_ID,
  FRONTEND_URL,
  SESSION_SECRET,
  DB_PATH = './data/fadeaway.sqlite',
  PORT = 3000,
} = process.env;

const ALLOWED_ORIGINS = (FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const REQUIRED_ENV = [
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI',
  'DISCORD_GUILD_ID', 'DISCORD_FOUNDER_ROLE_ID', 'FRONTEND_URL',
  'SESSION_SECRET',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const dbFile = path.resolve(DB_PATH);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('FOUNDER', 'OG')),
    profile_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
`);

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

const COOKIE_NAME = 'fa_session';
// Render does not always populate NODE_ENV. Since the frontend and backend
// normally live on different HTTPS domains, derive the cookie mode from the
// configured frontend URL instead of relying only on NODE_ENV.
const usesHttpsFrontend = ALLOWED_ORIGINS.some(origin => origin.startsWith('https://'));
const crossSiteCookie = usesHttpsFrontend || process.env.NODE_ENV === 'production';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: crossSiteCookie,
  sameSite: crossSiteCookie ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

function normalizeDiscordId(value) {
  let id = String(value || '').trim();
  const urlMatch = id.match(/discord(?:app)?\.com\/users\/(\d{15,20})/i);
  if (urlMatch) id = urlMatch[1];
  return /^\d{15,20}$/.test(id) ? id : '';
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeLinks(value) {
  const source = safeObject(value);
  return ['tiktok', 'spotify', 'youtube', 'steam'].reduce((out, key) => {
    out[key] = cleanText(source[key], 500);
    return out;
  }, {});
}

function safeLinkHandles(value) {
  const source = safeObject(value);
  return ['tiktok', 'spotify', 'youtube', 'steam'].reduce((out, key) => {
    out[key] = cleanText(source[key], 100);
    return out;
  }, {});
}

function safeGames(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(game => {
    if (typeof game === 'string') return { title: cleanText(game, 80) };
    const source = safeObject(game);
    const result = { title: cleanText(source.title, 80) };
    Object.keys(source).slice(0, 12).forEach(key => {
      if (key !== 'title') result[key] = cleanText(source[key], 160);
    });
    return result;
  }).filter(game => game.title);
}

function profileFromRow(row) {
  const data = JSON.parse(row.profile_json || '{}');
  return {
    ...data,
    id: row.id,
    discordId: row.discord_id,
    username: row.username,
    email: `${row.username}@fadeaway.local`,
    name: row.name,
    handle: row.handle,
    role: row.role,
  };
}

function profilePayload(body, existing = {}) {
  const username = cleanText(body.username ?? existing.username, 32)
    .replace(/^@+/, '');
  const name = cleanText(body.name ?? existing.name, 64);
  let handle = cleanText(body.handle ?? existing.handle ?? `@${username}`, 40);
  if (handle && !handle.startsWith('@')) handle = `@${handle}`;
  const role = String(body.role ?? existing.role ?? 'OG').toUpperCase() === 'FOUNDER'
    ? 'FOUNDER' : 'OG';
  return {
    username,
    name,
    handle,
    role,
    discordId: normalizeDiscordId(body.discordId ?? existing.discordId),
    bio: cleanText(body.bio ?? existing.bio, 240),
    since: cleanText(body.since ?? existing.since, 10) || new Date().getFullYear().toString(),
    views: Number.isFinite(Number(existing.views)) ? Number(existing.views) : 0,
    profileCompleted: true,
    profileSetupComplete: true,
    links: safeLinks(body.links ?? existing.links),
    linkHandles: safeLinkHandles(body.linkHandles ?? existing.linkHandles),
    games: safeGames(body.games ?? existing.games),
    specs: safeObject(body.specs ?? existing.specs),
    musicName: cleanText(body.musicName ?? existing.musicName, 160),
  };
}

function insertProfile(profile) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO profiles
      (discord_id, username, name, handle, role, profile_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.discordId, profile.username, profile.name, profile.handle,
    profile.role, JSON.stringify(profile), now, now,
  );
  return profileFromRow(db.prepare('SELECT * FROM profiles WHERE id = ?').get(result.lastInsertRowid));
}

function updateProfile(id, profile) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE profiles
    SET username = ?, name = ?, handle = ?, role = ?, profile_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    profile.username, profile.name, profile.handle, profile.role,
    JSON.stringify(profile), now, id,
  );
  return profileFromRow(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}

function getProfile(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) return null;
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(numericId);
}

function getSessionPayload(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discord OAuth2
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

app.get('/auth/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  const frontend = ALLOWED_ORIGINS[0] || '/';
  if (error || !code) return res.redirect(`${frontend}?auth=error`);

  try {
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

    const userResp = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userResp.ok) {
      console.error('Fetching user failed', await userResp.text());
      return res.redirect(`${frontend}?auth=error`);
    }
    const discordUser = await userResp.json();

    const memberResp = await fetch(
      `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    let isFounder = false;
    let inGuild = false;
    if (memberResp.ok) {
      inGuild = true;
      const member = await memberResp.json();
      isFounder = (member.roles || []).includes(DISCORD_FOUNDER_ROLE_ID);
    } else if (memberResp.status !== 404) {
      console.error('Fetching guild member failed', await memberResp.text());
    }

    const sessionToken = jwt.sign({
      discordId: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name,
      avatar: discordUser.avatar,
      inGuild,
      isFounder,
    }, SESSION_SECRET, { expiresIn: '7d' });

    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
    return res.redirect(`${frontend}?auth=success`);
  } catch (err) {
    console.error(err);
    return res.redirect(`${frontend}?auth=error`);
  }
});

app.get('/api/session', (req, res) => {
  const payload = getSessionPayload(req);
  if (!payload) return res.json({ loggedIn: false });
  return res.json({
    loggedIn: true,
    discordId: payload.discordId,
    username: payload.username,
    globalName: payload.globalName,
    avatar: payload.avatar,
    inGuild: payload.inGuild,
    isFounder: payload.isFounder,
  });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

function requireSession(req, res, next) {
  const payload = getSessionPayload(req);
  if (!payload) return res.status(401).json({ error: 'Sign in with Discord first.' });
  req.discordUser = payload;
  next();
}

function requireFounder(req, res, next) {
  return requireSession(req, res, () => {
    if (!req.discordUser.isFounder) {
      return res.status(403).json({ error: 'Founder Discord role required.' });
    }
    next();
  });
}

function requireProfileOwner(req, res, next) {
  return requireSession(req, res, () => {
    const row = getProfile(req.params.id);
    if (!row) return res.status(404).json({ error: 'Profile not found.' });
    if (row.discord_id !== req.discordUser.discordId) {
      return res.status(403).json({ error: 'Only the profile owner can edit this profile.' });
    }
    req.profileRow = row;
    next();
  });
}

// Public profile data. Secrets and Discord OAuth tokens are never stored here.
app.get('/api/profiles', (req, res) => {
  const rows = db.prepare('SELECT * FROM profiles ORDER BY role = \'FOUNDER\' DESC, id ASC').all();
  res.json({ profiles: rows.map(profileFromRow) });
});

// Only a verified Discord Founder may create profiles. On an empty database,
// the first profile is forced to be the currently signed-in Founder.
app.post('/api/profiles', requireFounder, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count;
  const profile = profilePayload(req.body || {});
  if (count === 0) {
    profile.role = 'FOUNDER';
    profile.discordId = req.discordUser.discordId;
  }
  if (!profile.discordId) {
    return res.status(400).json({ error: 'A Discord User ID is required so the owner can sign in and edit.' });
  }
  if (!profile.username || !/^[a-zA-Z0-9._-]{3,32}$/.test(profile.username)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, dot, dash, or underscore.' });
  }
  if (!profile.name) return res.status(400).json({ error: 'Display name is required.' });
  if (!profile.handle) return res.status(400).json({ error: 'Handle is required.' });
  if (profile.role === 'FOUNDER' && profile.discordId !== req.discordUser.discordId) {
    return res.status(403).json({ error: 'A Founder profile must use the Discord ID of the signed-in Founder.' });
  }
  try {
    const created = insertProfile(profile);
    return res.status(201).json({ profile: created });
  } catch (err) {
    if (String(err.code).includes('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That Discord ID, username, or handle is already in use.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Could not create profile.' });
  }
});

// One-time migration helper for profiles that were previously in localStorage.
app.post('/api/profiles/import', requireFounder, (req, res) => {
  const source = Array.isArray(req.body?.profiles) ? req.body.profiles.slice(0, 500) : [];
  let imported = 0;
  const insertMany = db.transaction(() => {
    for (const item of source) {
      const profile = profilePayload(item || {});
      if (!profile.discordId || !profile.username || !profile.name) continue;
      if (profile.role === 'FOUNDER' && profile.discordId !== req.discordUser.discordId) continue;
      try {
        insertProfile(profile);
        imported += 1;
      } catch (err) {
        if (!String(err.code).includes('SQLITE_CONSTRAINT')) throw err;
      }
    }
  });
  try {
    insertMany();
    res.json({ ok: true, imported });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not import profiles.' });
  }
});

app.put('/api/profiles/:id', requireProfileOwner, (req, res) => {
  const existing = profileFromRow(req.profileRow);
  const profile = profilePayload(req.body || {}, existing);
  profile.username = existing.username;
  profile.discordId = existing.discordId;
  profile.role = existing.role;
  if (!profile.name || !profile.handle) {
    return res.status(400).json({ error: 'Display name and handle are required.' });
  }
  try {
    const updated = updateProfile(req.profileRow.id, profile);
    res.json({ profile: updated });
  } catch (err) {
    if (String(err.code).includes('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That handle is already in use.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
});

app.delete('/api/profiles/:id', requireFounder, (req, res) => {
  const row = getProfile(req.params.id);
  if (!row) return res.status(404).json({ error: 'Profile not found.' });
  if (row.role === 'FOUNDER') {
    return res.status(403).json({ error: 'The Founder profile cannot be removed.' });
  }
  db.prepare('DELETE FROM profiles WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Fadeaway Discord auth + profile database backend is running.'));

app.listen(PORT, () => console.log(`Listening on port ${PORT}; database: ${dbFile}`));