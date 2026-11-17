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
any other server. Your Google API key and voice settings (voice engine, voice, language, narration style and
speed, Skip text) travel the same way, so a new device has them as soon as you sign in. Saved audio and display settings
(font, size, theme, highlight options) stay on each device.

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
days as a deletion record); for each book the most recent reading position wins. For the key and each voice setting, the most recent change
made by hand on any device wins (kept in `prefs.json`). In Settings, "Remove from this device" clears the key here
only (this device then stops taking it from Drive until you save a key here again); "Remove from all devices" clears
it everywhere on their next sync. Signing out keeps the key on that device.

## Word highlight

Google's voices send audio only, with no word positions, so the word highlight is timed from the audio itself
(`align.js`): it finds where speech starts and ends and where the voice pauses, matches those pauses to the
passage's punctuation and paragraph breaks, and spreads the words between pauses by an estimate of how long each
takes to say. It follows the audio's own clock, so pausing and speed changes stay in step. It is still an estimate
within each stretch between pauses, usually within a word of the voice.

## Skip text

Settings › Skip text has six switches for text that is shown on the page but not read aloud: round, square and curly
brackets, web addresses, superscripts and subscripts, and vertical text. Skipped text stays visible, dimmed, and the word
highlight moves only over what is spoken. The choices travel with the voice settings through Drive sync.

How each is found (`skip.js`):

- Brackets: matched pairs, nested or not. A closing bracket with no opener (a list's "a)") is ignored, and a bracket
  that never closes is ignored, so a stray "(" never silences the rest of a paragraph.
- Web addresses: anything starting with http://, https://, ftp:// or www., a DOI, or a domain followed by a path
  (example.org/page). A bare name such as Amazon.com is read, since in prose it is usually a word.
- Superscripts and subscripts: in PDFs, from each piece of text's size and baseline compared with the full-size text
  beside it; in EPUB and HTML, from sup and sub tags and note links; in Word files, from raised and lowered runs; in
  scanned pages read by Gemini, from tags the model is asked to add; and ¹²³ typed as characters anywhere. Note and
  citation numbers are skipped; exponents and formulas (x², m³, H₂O) and ordinals (21st) are still read.
- Vertical text: PDFs only, text turned across the page's main direction (margin stamps, rotated side labels).

Superscripts and vertical text are recorded when a book is added, so books added before this feature need adding again
for those two; brackets and addresses work on every book.

Tests: `node --test tests/sync.test.js tests/align.test.js tests/skip.test.js`

## How it works

- `index.html`, `app.css`, `app.js`: the whole app.
- `sync.js`: Google Drive sync (merge rules and a small Drive client); `tests/` covers it.
- `skip.js`: Skip text (what is left out of narration, and sentence splitting); `tests/skip.test.js` covers it.
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installation.
- `vendor/`: pdf.js 3.11.174 and JSZip 3.10.1, used to open PDF, EPUB and Word files.

Speech is requested a passage at a time, a few passages ahead of the listener,
and played back to back. Every passage is saved in the browser after it is first heard, so replaying costs
nothing and saved chapters play offline. Playback speed is applied by the browser, so changing speed never
re-requests audio.

Books, reading positions and saved audio live in the browser's storage on each device. Drive sync, or "Save a
backup file" in the Library, moves a library to another device.
