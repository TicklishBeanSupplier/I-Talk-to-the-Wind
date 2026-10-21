# Conduit

A desktop studio for creators. Post to **Instagram, Facebook and YouTube**,
answer **comments and DMs**, and see your **own** numbers — without a feed.
There is nothing to scroll: the app only shows your work and the people
talking to you.

Runs on **Windows and macOS** (built with [Tauri](https://tauri.app)).

| Screen | What it does |
|---|---|
| **Studio** | Exports from Premiere, Lightroom or Photoshop land in your Outbox folder and become drafts. Pick platforms and formats, write one caption (or tweak it per platform), post now or schedule. |
| **Inbox** | Comments and DMs from all three platforms in one list, gathered at set times. Reply, reply privately, hide, or mark done. Optional session timer. |
| **Work** | Your posts with likes, comments, saves, shares and views; who commented; who reacted (Facebook); send a post to someone by DM. |
| **Person** | Anyone who engaged with you: profile card, your history together, message them, follow/subscribe, and their latest posts (no endless scroll). |
| **Settings** | Connect accounts, choose the Outbox folder, inbox times, season theme (winter snow / summer skate), tag sets. |

## Try it in a browser (sample data)

```bash
npm install
npm run dev          # open http://127.0.0.1:1420
```

Outside the desktop app Conduit runs in **preview mode**: a sample world,
nothing is posted, no logins. `npm run preview:build` produces a single
self-contained `dist-preview/index.html`.

## Run the desktop app

One-time tools:

- **Windows:** [Node.js 20+](https://nodejs.org), [Rust](https://rustup.rs),
  and [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (“Desktop development with C++”). WebView2 is already on Windows 11.
- **macOS:** `xcode-select --install`, [Node.js 20+](https://nodejs.org), [Rust](https://rustup.rs).

Then, in the project folder:

```bash
npm install
npm install-scripts approve esbuild   # newer npm blocks esbuild's setup until approved
npm install
npm run app          # run it
npm run app:build    # build an installer (src-tauri/target/release/bundle/)
```

If `npm run app` says it can't find `cargo`, Rust isn't installed or the
terminal was opened before installing it: install Rust, then open a new terminal.

Closing the window keeps Conduit in the tray (Windows) / menu bar (macOS) so
scheduled posts go out on time. Use **Quit** from the tray icon to stop it.

Connecting your accounts takes about 30–45 minutes once:
**[docs/SETUP.md](docs/SETUP.md)** walks through every click.

## What the platforms allow

Conduit only uses the official APIs, so it can only do what they allow:

| | Instagram | Facebook Page | YouTube |
|---|---|---|---|
| Post (photo, carousel, Reel/video, Story) | ✅ | ✅ | ✅ video |
| Schedule on the platform itself | ❌ (Conduit sends it on time) | ✅ | ✅ |
| Comments: read, reply, hide | ✅ | ✅ | ✅ |
| DMs | ✅ within 24 h of their last message | ✅ same | — no DMs |
| One private reply to a commenter | ✅ within 7 days | ✅ | — |
| Who liked | count only | ✅ names | count only |
| Story viewers | ❌ | — | — |
| Someone's posts | creator/business accounts | ❌ | ✅ |
| Follow from the app | ❌ (opens their profile) | ❌ | ✅ subscribe |

## How it's built

```
src/
  core/        Pure logic: drafts, checks, captions, scheduling, inbox, people, work. Fully tested.
  platforms/   Instagram, Facebook, YouTube adapters; Meta/Google logins; Supabase photo hand-off; preview mocks.
  runtime/     The bridge to the computer: desktop (Tauri) and browser preview.
  app/         The store (state, saving, every action) and adapter wiring.
  ui/          Screens and the "Rime" visual system.
src-tauri/     Rust shell: keychain, file access, login listener, tray, single instance.
```

- Logins and keys live in the **system keychain** (macOS Keychain / Windows
  Credential Manager). Drafts, inbox and settings are a JSON file in the app's
  data folder.
- Large videos upload in **8 MB chunks** and resume after network hiccups.
- Only one copy of the app can run, so a scheduled post is never sent twice.

```bash
npm test             # 46 tests: core logic + every platform request against a scripted network
npm run typecheck
cd src-tauri && cargo clippy
```
