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

## How it works

- `index.html`, `app.css`, `app.js`: the whole app.
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installation.
- `vendor/`: pdf.js 3.11.174 and JSZip 3.10.1, used to open PDF, EPUB and Word files.

Speech is requested a passage at a time, a few passages ahead of the listener,
and played back to back. Every passage is saved in the browser after it is first heard, so replaying costs
nothing and saved chapters play offline. Playback speed is applied by the browser, so changing speed never
re-requests audio.

Books, reading positions and saved audio live in the browser's storage on each device. "Save a backup file" in
the Library moves a library to another device.
