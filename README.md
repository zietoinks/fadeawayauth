# Fadeaway — Discord Founder Verification + Profile Database

Ito ang backend na nag-ve-verify kung Founder nga sa Discord bago pumayag gumawa
ng profile sa Fadeaway. Naka-save na ang profile data sa SQLite database, hindi
na sa localStorage. Walang bot kailangan — gumagamit ito ng Discord OAuth2 scope
na `guilds.members.read`.

- **Guild ID:** `1492526666784837702`
- **Founder Role ID:** `1494050942004236408`

---

## 1. Discord Developer Portal

1. Pumunta sa https://discord.com/developers/applications → **New Application**.
2. Sa tab na **OAuth2 → General**:
   - Kopyahin ang **Client ID** at **Client Secret**.
   - Sa **Redirects**, idagdag ang URL na ganito ang hugis:
     `https://YOUR-BACKEND.onrender.com/auth/discord/callback`
     (i-update ito pagkatapos mong makuha ang tunay na Render URL sa Step 2.)

Wala kang kailangang gawing bot dito — hindi ito ginagamit bilang bot, OAuth
app lang.

## 2. I-deploy ang backend sa Render

1. I-push ang folder na ito (`fadeaway-discord-auth/`) sa isang GitHub repo.
2. Sa Render: **New → Web Service** → ikonekta yung repo.
   - Build command: `npm install`
   - Start command: `npm start`
    - Runtime: Node 22 (kasama na ang `.node-version`; puwede ring ilagay ang
      `NODE_VERSION=22` sa Environment).
3. Sa **Environment** tab ng Render service, ilagay ang mga variables
   (gabay sa `.env.example`):

   | Key | Value |
   |---|---|
   | `DISCORD_CLIENT_ID` | mula sa Discord app |
   | `DISCORD_CLIENT_SECRET` | mula sa Discord app |
   | `DISCORD_REDIRECT_URI` | `https://YOUR-BACKEND.onrender.com/auth/discord/callback` |
   | `DISCORD_GUILD_ID` | `1492526666784837702` |
   | `DISCORD_FOUNDER_ROLE_ID` | `1494050942004236408` |
   | `FRONTEND_URL` | `https://your-site.netlify.app` (o Vercel URL mo) |
   | `SESSION_SECRET` | random string — pwede gawin sa terminal: `openssl rand -hex 32` |

4. Deploy. Kunin ang final URL, hal. `https://fadeaway-auth.onrender.com`.
5. Bumalik sa Discord Developer Portal → i-update yung Redirect URI para
   match talaga sa final Render URL (kailangan EXACT match).

### Kung nagfa-fail ang build sa `better-sqlite3`

Ang backend ay gumagamit ng native SQLite module. Ang lumang dependency range
(`better-sqlite3` 11.x) ay madalas nagti-trigger ng `node-gyp` compilation error
kapag Node 24 ang default runtime ng hosting provider. Ang package na ito ay
gumagamit ng `better-sqlite3` 13.x at Node 22 para gumamit ng compatible
prebuilt binary.

Kung may lumang `package-lock.json` sa repository, burahin ito isang beses at
gumawa ulit ng lockfile gamit ang Node 22 bago i-push:

```bash
rm -rf node_modules package-lock.json
npm install
```

### Kung nagfa-flicker ang `Sign in` pagkatapos ng Discord auth

Gamitin ang kasamang updated `index.html`. May dalawang dating problema sa
lumang frontend: maraming legacy timers ang sabay-sabay nagse-set ng nav label,
at gumagawa ito ng pangalawang `Sign in with Discord` link. Inalis ng updated
version ang duplicate link at iisang session state na lang ang ginagamit.

Naayos din sa `server.js` ang session cookie mode. Sa Render, hindi laging
nakaset ang `NODE_ENV`, kaya awtomatikong gumagamit na ito ng
`SameSite=None; Secure` kapag HTTPS ang `FRONTEND_URL`. Kailangan eksaktong
tama ang `FRONTEND_URL`; tinatanggal na rin ng server ang trailing slash
automatic para hindi ma-reject ng CORS ang frontend.

Hindi kailangan ng Discord bot para sa implementation na ito. OAuth2 ang
ginagamit, kasama ang `identify` at `guilds.members.read`; ang signed-in user
ang kailangang nasa guild at may eksaktong Founder role ID. Ang `+ CREATE
PROFILE` button ay ipinapakita lang kapag ang backend session mismo ay
nagbalik ng `isFounder: true`, hindi dahil lang may lumang local profile sa
browser.

## 3. I-wire sa frontend (Netlify/Vercel)

1. Gamitin ang updated `fwy.html` na kasama ng backend package.
2. Kung iba ang backend URL mo, palitan ang `FADEAWAY_API_BASE` sa
   `fwy.html` ng tunay na Render URL.
3. I-deploy/push gaya ng dati sa Netlify o Vercel.

## 4. I-test

1. Buksan yung live site — dapat "Sign in with Discord" ang makita.
2. I-click yun → mag-lo-login sa Discord → babalik sa site.
3. Kung member ka ng server at may Founder role ka, lalabas ang
   "Create profile". Ang bawat profile ay kailangang may Discord ID.
4. Kapag mag-e-edit ng profile, kailangan naka-sign in sa Discord ang owner at
   dapat eksaktong tumugma ang Discord ID sa profile.
5. Ang server ang nag-e-enforce ng Founder-only create, owner-only edit, at
   Founder-only delete; hindi sapat ang pagtatago ng buttons sa frontend.

## Mahalagang paalala

- **Palitan ang `FOUNDER_ROLE_ID`/`GUILD_ID` lang dito sa backend `.env`**,
  hindi sa frontend — para hindi ito ma-edit ng kahit sino sa devtools.
- Ang SQLite file ay nasa `DB_PATH`. Sa Render, gumamit ng persistent disk
  (hal. `/var/data/fadeaway.sqlite`) para hindi mawala ang data sa redeploy.
- Ang one-time migration ng lumang `fa_users` localStorage data ay ginagawa
  ng updated frontend kapag naka-sign in ang Founder. Kailangang may valid
  Discord ID ang mga profile na imi-migrate.
- Ang uploaded avatar/banner/background/music ay nananatiling browser-local sa
  version na ito; ang profile records mismo (name, links, games, Discord ID,
  role) ay nasa SQLite database na.
