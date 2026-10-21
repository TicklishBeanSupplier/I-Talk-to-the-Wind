# Setting up Conduit

About 30–45 minutes, once. You create your **own** Meta app and Google
project; because they're yours and you're their admin, they work with your
accounts right away — no app review needed.

> Meta and Google rename menu items often. If a label below doesn't match
> exactly, look for the closest equivalent.

---

## 1. Instagram and Facebook

### 1a. Your accounts

1. Instagram must be a **Creator** or **Business** account
   (Instagram → Settings → Account type and tools).
2. It must be **linked to a Facebook Page** you manage
   (Instagram → Settings → Accounts Center → or from the Page's settings → Linked accounts).
3. To let Conduit read and answer DMs:
   Instagram → Settings → **Messages and story replies** → **Message controls** →
   **Connected tools** → turn on **Allow access to messages**.

### 1b. Create the Meta app

1. Go to **https://developers.facebook.com/apps** → **Create app**.
2. Choose the use case for managing a **Page / Instagram / Messenger**
   (or “Other” → app type **Business**). Name it e.g. “Conduit (personal)”.
3. In the app dashboard, add these products/use cases:
   - **Facebook Login for Business** (or Facebook Login)
   - **Instagram** (Instagram API with Facebook Login)
   - **Messenger** (for Page messages)
4. **Facebook Login → Settings → Valid OAuth Redirect URIs**, add exactly:
   ```
   http://localhost:47823/callback
   ```
5. **App settings → Basic**: copy the **App ID** and **App Secret**.
6. Leave the app in **Development** mode. As the app's admin, all
   permissions work for your own Page and Instagram.

### 1c. Connect in Conduit

Settings → **Instagram and Facebook** → paste App ID and App Secret →
**Connect with Facebook**. Your browser opens; log in and allow everything
it asks for (Pages, Instagram, messages, insights). If you manage several
Pages, Conduit asks which one to use.

*Fallback:* if the browser login gives you trouble, open Meta's
**Graph API Explorer**, pick your app, request the same permissions, select
your **Page** in “User or Page”, copy that token, and use
**Use a Page token instead**.

---

## 2. YouTube

1. Go to **https://console.cloud.google.com** → create a project (“Conduit”).
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, fill in the app name and your email.
   - Add your Google account under **Test users**.
   - **Important:** set **Publishing status** to **In production**.
     In “Testing”, Google expires your login every 7 days. You don't need
     verification for personal use — when you log in, Google shows
     “Google hasn't verified this app”: click **Advanced → Go to Conduit**.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**.
   Copy the **Client ID** and **Client Secret**.
5. In Conduit: Settings → **YouTube** → paste both → **Connect YouTube**.

**Uploads stay private until Google audits your project.** Conduit tells you
when that happened; make the video public in YouTube Studio. To lift this,
submit Google's **YouTube API Services audit form** for your project (free).

Daily allowance: about six uploads a day, plenty for one channel.

---

## 3. Photo hand-off (Instagram photos only)

Instagram only accepts photos from a web link. Conduit parks each photo in
your private storage for a few minutes, gives Instagram a link that expires,
then deletes it. Videos upload directly and don't need this.

1. Create a free project at **https://supabase.com**.
2. **Storage → New bucket** → name `conduit-staging` → keep it **Private**.
3. **Project Settings → API**: copy the **Project URL** and a **secret key**
   (`sb_secret_…`, or the legacy `service_role` key).
4. In Conduit: Settings → **Photo hand-off** → paste them → **Save and test**.

Use a Supabase project just for Conduit: the secret key can manage that
whole project.

---

## 4. Outbox folder

Settings → **Outbox folder** → **Choose folder**. Make a folder like
`Conduit Outbox` and point your Adobe exports there:

- **Premiere Pro:** Export → Location.
- **Lightroom Classic:** File → Export → Export To: Specific folder (JPEG).
- **Photoshop:** File → Export → Export As.

Files already in the folder are left alone; each new export becomes a draft
once it has finished writing.

---

## Moving to another computer

Logins and keys live in each computer's keychain, and drafts/inbox in its
app-data folder, so a new computer starts fresh: clone the repo, run
`npm install` and `npm run app`, then reconnect in Settings (your Meta app
and Google project stay the same — just paste the same IDs and secrets).

## Where things are stored

| What | Where |
|---|---|
| Logins, App Secret, Client Secret, Supabase key | macOS Keychain / Windows Credential Manager, service `studio.conduit.app` |
| Drafts, inbox, settings | `conduit-data.json` in the app data folder (`~/Library/Application Support/studio.conduit.app` on macOS, `%APPDATA%\studio.conduit.app` on Windows) |
| Your media | Stays where you exported it. Conduit only reads it. |
