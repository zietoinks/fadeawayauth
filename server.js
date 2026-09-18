require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DISCORD_FOUNDER_ROLE_ID,
  FRONTEND_URL,
  SESSION_SECRET,
  MONGODB_URI,
  MONGODB_DB = 'fadeaway',
  PORT = 3000,
} = process.env;

const ALLOWED_ORIGINS = (FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .map(s => s.replace(/\/+$/, ''))
  .filter(Boolean);
const isVercelOrigin = origin =>
  /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/i.test(String(origin || ''));
const isLocalOrigin = origin =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || ''));

const REQUIRED_ENV = [
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI',
  'DISCORD_GUILD_ID', 'DISCORD_FOUNDER_ROLE_ID', 'FRONTEND_URL',
  'SESSION_SECRET', 'MONGODB_URI',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// MongoDB Atlas. Profile records live in the `profiles` collection and the
// binary media lives in GridFS, so nothing depends on the server filesystem.
// ---------------------------------------------------------------------------
const mongo = new MongoClient(MONGODB_URI, {
  maxPoolSize: 10,
  retryWrites: true,
});

let profiles;   // collection
let bucket;     // GridFSBucket

async function connectMongo() {
  await mongo.connect();
  const database = mongo.db(MONGODB_DB);
  profiles = database.collection('profiles');
  bucket = new GridFSBucket(database, { bucketName: 'media' });

  await Promise.all([
    profiles.createIndex({ discordId: 1 }, { unique: true }),
    profiles.createIndex({ username: 1 }, { unique: true }),
    profiles.createIndex({ handle: 1 }, { unique: true }),
    profiles.createIndex({ role: 1 }),
  ]);
  console.log(`Connected to MongoDB database: ${MONGODB_DB}`);
}

const isDuplicateKey = err => err && (err.code === 11000 || err.code === 11001);

// Driver v5 wraps findOneAndUpdate results in `{ value }`; v6 returns the
// document directly. This keeps the code correct on either version.
const unwrap = result => (result && result.value !== undefined ? result.value : result);

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || isVercelOrigin(origin) || isLocalOrigin(origin)) {
      return cb(null, true);
    }
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

// The frontend only ever treats `id` as an opaque string, so the Mongo
// ObjectId is exposed as its hex string and no frontend change is needed.
function profileFromDoc(doc) {
  if (!doc) return null;
  const { _id, createdAt, updatedAt, ...data } = doc;
  return {
    ...data,
    id: String(_id),
    email: `${doc.username}@fadeaway.local`,
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

async function insertProfile(profile) {
  const now = new Date().toISOString();
  const doc = { ...profile, media: {}, createdAt: now, updatedAt: now };
  const result = await profiles.insertOne(doc);
  return profileFromDoc({ ...doc, _id: result.insertedId });
}

// `$set` touches only the payload keys, so the stored media map survives edits.
async function updateProfile(id, profile) {
  const now = new Date().toISOString();
  // `views` is only ever changed by the /view endpoint ($inc), so an edit
  // can never overwrite the live counter with a stale value.
  const { views: _views, ...editable } = profile;
  const updated = await profiles.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...editable, updatedAt: now } },
    { returnDocument: 'after' },
  );
  return profileFromDoc(unwrap(updated));
}

async function getProfile(id) {
  const raw = String(id || '');
  if (!ObjectId.isValid(raw)) return null;
  return profiles.findOne({ _id: new ObjectId(raw) });
}

const MEDIA_TYPES = {
  avatar: { maxSize: 12 * 1024 * 1024, allowed: /^image\// },
  banner: { maxSize: 40 * 1024 * 1024, allowed: /^(image|video)\// },
  background: { maxSize: 40 * 1024 * 1024, allowed: /^(image|video)\// },
  music: { maxSize: 12 * 1024 * 1024, allowed: /^audio\// },
};

function getMediaMeta(doc, type) {
  return safeObject(safeObject(doc?.media)[type]);
}

async function removeMediaFile(fileId) {
  if (!fileId || !ObjectId.isValid(String(fileId))) return;
  try {
    await bucket.delete(new ObjectId(String(fileId)));
  } catch (error) {
    // A missing file is fine; anything else is worth a warning only.
    if (!/FileNotFound/i.test(String(error && error.message))) {
      console.warn('Could not remove old media:', error.message);
    }
  }
}

function storeMediaFile(file, profileId, type) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(`${profileId}-${type}-${Date.now()}`, {
      contentType: file.mimetype,
      metadata: { profileId: String(profileId), type },
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(file.buffer);
  });
}

// Files are buffered in memory and handed straight to GridFS, so the server
// never writes to its own (ephemeral) disk.
const mediaStorage = multer.memoryStorage();

function mediaUpload(req, res, next) {
  const config = MEDIA_TYPES[String(req.params.type || '')];
  if (!config) return res.status(400).json({ error: 'Unsupported media type.' });
  const upload = multer({
    storage: mediaStorage,
    limits: { fileSize: config.maxSize },
    fileFilter: (_req, file, cb) => cb(null, config.allowed.test(file.mimetype || '')),
  }).single('file');
  return upload(req, res, error => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'That media file is too large.' });
      }
      return res.status(400).json({ error: 'Only a supported image, video, or audio file can be uploaded.' });
    }
    next();
  });
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
  return requireSession(req, res, async () => {
    try {
      const doc = await getProfile(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Profile not found.' });
      if (doc.discordId !== req.discordUser.discordId) {
        return res.status(403).json({ error: 'Only the profile owner can edit this profile.' });
      }
      req.profileDoc = doc;
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load that profile.' });
    }
  });
}

function requireOwnerOrFounder(req, res, next) {
  return requireSession(req, res, async () => {
    try {
      const doc = await getProfile(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Profile not found.' });
      const isOwner = doc.discordId === req.discordUser.discordId;
      if (!isOwner && !req.discordUser.isFounder) {
        return res.status(403).json({ error: 'Only the profile owner or a verified Founder can edit this profile.' });
      }
      req.profileDoc = doc;
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not load that profile.' });
    }
  });
}

// Public profile data. Secrets and Discord OAuth tokens are never stored here.
app.get('/api/profiles', async (req, res) => {
  try {
    // Founders first, then oldest profile first — same order as before.
    const docs = await profiles.find({}).sort({ _id: 1 }).toArray();
    docs.sort((a, b) => (b.role === 'FOUNDER') - (a.role === 'FOUNDER'));
    res.json({ profiles: docs.map(profileFromDoc) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load profiles.' });
  }
});

// Public view counter: every profile open adds one view. Atomic $inc, so
// simultaneous visitors never overwrite each other's count.
app.post('/api/profiles/:id/view', async (req, res) => {
  const raw = String(req.params.id || '');
  if (!ObjectId.isValid(raw)) return res.status(404).json({ error: 'Profile not found.' });
  try {
    const updated = await profiles.findOneAndUpdate(
      { _id: new ObjectId(raw) },
      { $inc: { views: 1 } },
      { returnDocument: 'after', projection: { views: 1 } },
    );
    const doc = unwrap(updated);
    if (!doc) return res.status(404).json({ error: 'Profile not found.' });
    res.json({ views: Number(doc.views) || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record the view.' });
  }
});

// Public profile media, streamed straight out of GridFS.
app.get('/api/profiles/:id/media/:type', async (req, res) => {
  const type = String(req.params.type || '');
  if (!MEDIA_TYPES[type]) return res.status(400).json({ error: 'Unsupported media type.' });
  try {
    const doc = await getProfile(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Profile not found.' });
    const meta = getMediaMeta(doc, type);
    if (!meta.fileId || !ObjectId.isValid(String(meta.fileId))) {
      return res.status(404).json({ error: 'Media not found.' });
    }
    if (meta.mimeType) res.type(meta.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    const stream = bucket.openDownloadStream(new ObjectId(String(meta.fileId)));
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Media not found.' });
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load profile media.' });
  }
});

// Only the profile owner can replace their shared avatar/banner/background/music.
app.put('/api/profiles/:id/media/:type', requireProfileOwner, mediaUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a supported media file first.' });
  const type = String(req.params.type || '');
  const doc = req.profileDoc;
  const previous = getMediaMeta(doc, type);
  const now = new Date().toISOString();
  let fileId;
  try {
    fileId = await storeMediaFile(req.file, doc._id, type);
    const entry = {
      fileId: String(fileId),
      mimeType: req.file.mimetype,
      originalName: cleanText(req.file.originalname, 160),
      updatedAt: now,
    };
    const updated = await profiles.findOneAndUpdate(
      { _id: doc._id },
      { $set: { [`media.${type}`]: entry, updatedAt: now } },
      { returnDocument: 'after' },
    );
    await removeMediaFile(previous.fileId);
    return res.json({ media: entry, profile: profileFromDoc(unwrap(updated)) });
  } catch (error) {
    await removeMediaFile(fileId);
    console.error(error);
    return res.status(500).json({ error: 'Could not save profile media.' });
  }
});

// Only a verified Discord Founder may create profiles. On an empty database,
// the first profile is forced to be the currently signed-in Founder.
app.post('/api/profiles', requireFounder, async (req, res) => {
  try {
    const count = await profiles.estimatedDocumentCount();
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
    // Any verified Discord Founder may create a profile for someone else and
    // set their role to FOUNDER — it no longer has to be the signed-in
    // Founder's own Discord ID.
    const created = await insertProfile(profile);
    return res.status(201).json({ profile: created });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return res.status(409).json({ error: 'That Discord ID, username, or handle is already in use.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Could not create profile.' });
  }
});

// One-time migration helper for profiles that were previously in localStorage.
app.post('/api/profiles/import', requireFounder, async (req, res) => {
  const source = Array.isArray(req.body?.profiles) ? req.body.profiles.slice(0, 500) : [];
  let imported = 0;
  try {
    for (const item of source) {
      const profile = profilePayload(item || {});
      if (!profile.discordId || !profile.username || !profile.name) continue;
      try {
        await insertProfile(profile);
        imported += 1;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    res.json({ ok: true, imported });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not import profiles.' });
  }
});

app.put('/api/profiles/:id', requireOwnerOrFounder, async (req, res) => {
  const existing = profileFromDoc(req.profileDoc);
  const profile = profilePayload(req.body || {}, existing);
  profile.username = existing.username;
  profile.discordId = existing.discordId;
  // Only a verified Discord Founder may promote/demote a profile's role.
  // A member editing their own profile can never self-promote.
  if (!req.discordUser.isFounder) profile.role = existing.role;
  if (!profile.name || !profile.handle) {
    return res.status(400).json({ error: 'Display name and handle are required.' });
  }
  try {
    const updated = await updateProfile(req.profileDoc._id, profile);
    res.json({ profile: updated });
  } catch (err) {
    if (isDuplicateKey(err)) {
      return res.status(409).json({ error: 'That handle is already in use.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
});

app.delete('/api/profiles/:id', requireFounder, async (req, res) => {
  try {
    const doc = await getProfile(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Profile not found.' });
    // Any verified Founder may remove any profile, other Founders included.
    // Only their own profile is protected so they can't delete themselves by accident.
    if (doc.discordId === req.discordUser.discordId) {
      return res.status(403).json({ error: 'You cannot remove your own profile.' });
    }
    const media = safeObject(doc.media);
    for (const item of Object.values(media)) {
      await removeMediaFile(safeObject(item).fileId);
    }
    await profiles.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete profile.' });
  }
});

app.get('/', (req, res) => res.send('Fadeaway Discord auth + profile database backend is running.'));

// Requests are only accepted once Mongo is reachable, so a cold start never
// answers with an empty profile list.
connectMongo()
  .then(() => {
    app.listen(PORT, () => console.log(`Listening on port ${PORT}; MongoDB database: ${MONGODB_DB}`));
  })
  .catch(err => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });

process.on('SIGTERM', async () => {
  await mongo.close().catch(() => {});
  process.exit(0);
});
