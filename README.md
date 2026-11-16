# Lectern Reader

A read-aloud book reader that runs entirely in the browser. It reads EPUB, PDF, Word, text, Markdown and HTML
files aloud with Google's Gemini speech models (Flash-Lite by default) or Chirp 3 HD voices, highlights the sentence and word being spoken, and can be installed
as an app on a phone or computer.

There is no server and no build step: the folder is a static site.

## Run it

Any static host works (Cloudflare Pages, Netlify, GitHub Pages, your own server): upload this folder as it is.
It must be served over `https://` (or `http://localhost`) for offline support and installation.

To try it on your own computer:

    cd lectern
    python3 -m http.server 8000
    # then open http://localhost:8000

## Turn on natural voices

Without a key the app uses the device's built-in voice. For Google's voices:

1. Open https://aistudio.google.com/apikey, sign in with a Google account and create an API key.
2. In the app, open Settings, paste the key and press Save.

The app asks Google which speech models the key offers and picks the cheapest (Gemini Flash-Lite when it is
offered). The same key reads scanned PDFs and page photos. If the Cloud Text-to-Speech API is also enabled in
the key's Google Cloud project, Chirp 3 HD appears as a second voice engine.

The key is stored only in the browser and is sent only to Google. Usage beyond Google's free allowance is
billed to the key's project.

## Sync across devices (Google Drive)

Books, chapters and reading positions can follow you to every device through your own Google Drive. They are
kept in Drive's hidden app data folder (scope `drive.appdata`), which only this app can open; nothing goes to
any other server. Saved audio, the API key and display settings stay on each device.

One-time setup, on a computer:

1. Open https://console.cloud.google.com/projectcreate and create a project (for example "Lectern").
2. In APIs & Services › Library, enable **Google Drive API**.
3. Open **Google Auth Platform**, press Get started: app name, your email as support and contact email,
   Audience **External**. Under Audience, add your own Gmail as a test user.
4. Under **Clients**, create a **Web application** client. Authorized JavaScript origins: the site's origin
   (for example `https://osifu003.github.io`). Authorized redirect URIs: the app's address
   (for example `https://osifu003.github.io/lectern-reader/`), used when the app runs from the home screen.
5. Copy the client ID. Either paste it in Settings › Sync on each device, or put it in `DRIVE_CLIENT_ID` at the
   top of the sync section in `app.js` so every device has it.

Then press **Sign in with Google** in Settings on each device. A Google sign-in lasts about an hour; after that
the app shows a Reconnect bar, and opening the Library reconnects by itself in a browser tab. Changes made while
disconnected or offline are kept and sent on the next sync.

How sync decides: a book added on one device is uploaded and appears on the others; a book changed later (more
scanned pages read) replaces the older copy; a book removed on one device is removed everywhere (kept for 180
days as a deletion record); for each book the most recent reading position wins.

Tests for the merge rules: `node --test tests/sync.test.js`

## How it works

- `index.html`, `app.css`, `app.js`: the whole app.
- `sync.js`: Google Drive sync (merge rules and a small Drive client); `tests/` covers it.
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installation.
- `vendor/`: pdf.js 3.11.174 and JSZip 3.10.1, used to open PDF, EPUB and Word files.

Speech is requested a passage at a time, a few passages ahead of the listener,
and played back to back. Every passage is saved in the browser after it is first heard, so replaying costs
nothing and saved chapters play offline. Playback speed is applied by the browser, so changing speed never
re-requests audio.

Books, reading positions and saved audio live in the browser's storage on each device. Drive sync, or "Save a
backup file" in the Library, moves a library to another device.
