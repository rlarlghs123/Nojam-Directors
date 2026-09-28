# Nojam Archive

A private, [are.na](https://www.are.na)-style archive for design references: images, memos, videos, PDFs and links.
Everything lives as ordinary files in **one folder in your own cloud drive**, and **an AI tags every new block for you**
(Claude, or a [free model on your own computer](#auto-tagging-claude-or-free)), so you can search for “red swiss poster”
or “fog long take” without typing tags by hand.

![The archive grid](docs/grid.jpg)

- **Your cloud, your files.** Point it at a folder in iCloud Drive, Google Drive, Dropbox or a NAS share.
  Save something into that folder from your phone and it shows up in the archive a few seconds later, thumbnailed and tagged.
  Nothing is locked in a database: delete the app and your folder is still a normal folder.
- **A calm grid, like are.na.** Thumbnails for every kind of image (HEIC, PSD, TIFF, SVG, RAW, …),
  the first lines of every memo and document (txt, md, rtf, docx, hwp, pdf, …), video frames, link previews and font specimens,
  each titled with its file name and format (`poster.jpg`). Set in Helvetica. Sub-folders work like channels.
- **Search that just works.** Type any part of a word, in any language. It looks at file names, the text inside documents,
  and everything the AI wrote about each block. `#tag` filters by an exact tag.
- **Automatic tags.** For every new block the AI writes a title, 6–12 tags, a one-line summary and hidden search keywords
  (optionally with translations, so English tags can be found in Korean too). You can add or remove tags; your edits always win.
  Use Claude, or tag for free with a model running on your own computer.

<p align="center"><img src="docs/detail.jpg" alt="A block with its tags" width="49%"> <img src="docs/mobile.jpg" alt="On a phone" width="24%"></p>

---

## Quick start

1. Install **Node.js 22 or newer** from [nodejs.org](https://nodejs.org).
2. In a terminal:
   ```sh
   cd archive
   npm install
   cp .env.example .env
   ```
3. Open `.env` and set two things:
   - `ARCHIVE_DIR`: the folder that holds your references (see [where to keep your files](#where-to-keep-your-files)).
   - Who writes the tags: `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com/) for Claude,
     or `TAGGER=ollama` for free tagging on your own computer (see [auto-tagging](#auto-tagging-claude-or-free)).
     Everything else works without tags too.
4. Start it:
   ```sh
   npm start
   ```
   and open **http://localhost:3000**.

The first time, it reads the whole folder and makes thumbnails. With Claude, if more than 50 blocks are waiting for tags,
it asks before sending them and shows a rough cost. (The free options just start.)

Optional, for more previews:
- **ffmpeg** (video thumbnails): a copy is bundled on most computers; if videos show no picture, install it with `brew install ffmpeg` (Mac) or `winget install ffmpeg` (Windows).
- On a **Mac**, the archive also uses the built-in `sips` and Quick Look, which add thumbnails for RAW photos, Keynote, Pages, Sketch, Illustrator and more.

## Where to keep your files

Pick the cloud you already use. The archive only needs the folder to be **on the disk** of the computer running it.

### iCloud Drive (best with an iPhone)

```sh
ARCHIVE_DIR="~/Library/Mobile Documents/com~apple~CloudDocs/Archive"
```

- In Finder, right-click the **Archive** folder in iCloud Drive → **Keep Downloaded**. Otherwise macOS may remove
  local copies to save space, and they have to download again before they can be thumbnailed.
- **From your iPhone:** Share → **Save to Files** → iCloud Drive → Archive. That's it: it appears in the archive with tags.
- If you run the archive in the background (see [keep it running](#keep-it-running-on-a-mac)), give `node` access to
  iCloud Drive in System Settings → Privacy & Security → Full Disk Access (or Files & Folders).

### Google Drive

Install [Google Drive for desktop](https://www.google.com/drive/download/), then:

```sh
# Mac
ARCHIVE_DIR="~/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/Archive"
# Windows (use forward slashes)
ARCHIVE_DIR="G:/My Drive/Archive"
```

- Right-click the folder → **Offline access → Available offline** (or set Drive to *Mirror files*).
- **From your phone:** Google Drive app → + → Upload → Archive.

### Your own server or NAS (Docker)

On a Synology/QNAP/Unraid box, a Raspberry Pi or any Linux machine:

```sh
cd archive
cp .env.example .env          # add ARCHIVE_PASSWORD, and ANTHROPIC_API_KEY or a free TAGGER
# edit docker-compose.yml: point the /library volume at your folder
docker compose up -d
```

To tag for free with Ollama running on the same machine, set `TAGGER=ollama` and
`TAG_API_URL=http://host.docker.internal:11434`, and uncomment the `extra_hosts` line in `docker-compose.yml`.

Keep the folder in sync with your devices using whatever the NAS offers (Synology Drive, Nextcloud, Syncthing,
or Synology Cloud Sync to Google Drive).

> **Two rules for any setup:** keep `DATA_DIR` (the search index and thumbnails, `./data` by default) *outside* the synced
> folder, and run **one** archive server per library folder.

## Open it from your phone, anywhere

The simplest safe way is [Tailscale](https://tailscale.com) (free for personal use): a private network between your own devices.

1. Install Tailscale on the computer running the archive and on your phone, and sign in on both.
2. On the computer: `tailscale serve --bg 3000`
3. Open the `https://<computer-name>.<your-tailnet>.ts.net` address it prints, on your phone. Add it to the home screen.

The archive keeps listening only on the computer itself (`HOST=127.0.0.1`); Tailscale brings it to your devices with HTTPS,
and nobody else can reach it.

Only on your home Wi-Fi instead? Set `HOST=0.0.0.0` **and** `ARCHIVE_PASSWORD=…` in `.env`, then open `http://<computer-ip>:3000`.
Please don't expose the archive to the open internet.

## Keep it running on a Mac

A Mac mini or an old laptop that stays on makes a good archive server. To start it automatically at login, save this as
`~/Library/LaunchAgents/com.nojam.archive.plist` (fix the two paths; `which node` tells you where Node is):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nojam.archive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/Nojam-Directors/archive</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/nojam-archive.log</string>
</dict>
</plist>
```

Then run `launchctl load ~/Library/LaunchAgents/com.nojam.archive.plist`. In System Settings → Energy, allow the Mac
to stay awake when the display is off.

## Using it

- **Add things:** drag files anywhere onto the page, paste (⌘V) a screenshot, an image, a link or some text, or use the
  **+ Add block** square: type a note or paste a link, then ⌘↵. Or just save files into the folder.
- **Links** are saved as small `.url` shortcut files (so they sync too) with a title, description and preview image.
  YouTube and Vimeo play right in the archive. Pasting a link to an image saves the image itself.
- **Memos** are Markdown files. Open one and press **Edit** to change it; it's re-tagged after you save.
- **Search:** any part of any word, any language. Combine words (`red poster`), use `#tag` for an exact tag,
  and narrow down with folders (channels), the type filter and the tag strip. **Shuffle** is good for rediscovering things.
- **Keyboard:** `/` or ⌘K to search, ← → to move between blocks, Esc to close.
- **Delete** moves the file to a `.trash` folder inside your library, so you can always get it back.

## Auto-tagging: Claude or free

Pick who writes the tags with `TAGGER=` in `.env`. You can switch any time: existing tags stay, new blocks use the new
tagger, and **Re-tag** redoes a single block.

| `TAGGER` | Cost | Limits | Where your files go |
| --- | --- | --- | --- |
| `claude` (default) | about $0.03 per block with `claude-opus-5`, about half a cent with `TAG_MODEL=claude-haiku-4-5` | none | a small copy is sent to Anthropic's API |
| **`ollama`** | **free** | none; a few seconds per block on an Apple-silicon Mac | **nowhere, it runs on your computer** |
| `gemini` | free tier | a few hundred to about 1,500 blocks a day, changed by Google without notice; not offered in the EU, UK or Switzerland | Google may use free-tier content to improve its products (people may review it) |
| `openrouter` | free models | 50 requests a day (1,000 a day after a one-time $10 top-up); the free models rotate | depends on the model's host |
| `custom` | depends | depends | any OpenAI-compatible API, e.g. [LM Studio](https://lmstudio.ai) (free, local) |

Claude gives the most precise tags, especially for names, typefaces and styles. For a free archive, **Ollama is the one to use**:
no account, no limits, nothing leaves your computer.

### Free, on your own computer: Ollama

1. Install [Ollama](https://ollama.com) (on a Mac: download the app, or `brew install ollama`) and keep it running.
2. Download a model that can see images:
   ```sh
   ollama pull qwen3-vl:8b-instruct     # needs about 8–9 GB of free memory; good at reading text in posters
   ollama pull qwen3-vl:4b-instruct     # for Macs with 8 GB of memory (about 3.5 GB)
   ollama pull gemma4:e4b               # another good choice, strong in Korean and other languages
   ```
3. In `.env`:
   ```sh
   TAGGER=ollama
   TAG_MODEL=qwen3-vl:8b-instruct       # or the one you downloaded
   ```
4. Restart the archive. A big first import can take a while, so leave it running overnight.

### Free in the cloud: Gemini

1. Get a free API key at [aistudio.google.com](https://aistudio.google.com) (no credit card).
2. In `.env`:
   ```sh
   TAGGER=gemini
   TAG_API_KEY=your-key
   ```
   The default model is `gemini-3.5-flash-lite`: Flash-Lite models get the largest free daily quota (your live limits are shown in AI Studio).
   When the day's quota is used up, the archive waits and carries on by itself.
3. Keep private material off the free tier: Google may use it to improve its products.

`TAGGER=openrouter` works the same way with a key from [openrouter.ai/keys](https://openrouter.ai/keys); its default model
`openrouter/free` picks whichever free model can read images that day.

### What the tagger sees

For each new block, the archive sends:

- a downscaled copy of the picture (at most 1024 px): the image itself, the first page of a PDF, a 4-frame contact
  sheet of a video, the cover of a song, the preview of a design file or the image of a link;
- the file name, folder and, for writings, up to 16,000 characters of text;
- the 150 tags you use most, so it reuses your vocabulary (“poster”, not sometimes “posters” or “poster design”).

It answers with a title, tags, a summary and search keywords, as structured JSON. With Claude, the model is `claude-opus-5`
at low effort, with Claude's server-side refusal fallback (`fallbacks: "default"`) switched on, so a rare policy decline is
retried on another model automatically.

- **Titles:** every block is titled with its file name and format (`IMG_2931.jpg`). The AI's title appears in bold above
  the summary when you open a block, and it's searchable.
- **Your edits win:** tags you add are shown with a dashed border; tags you remove stay removed, even after re-tagging.
- **Tags travel with your files:** they're also saved as small JSON files in `<library>/.archive/meta/`, keyed by the
  file's content. They sync with your drive, so a second computer (or a fresh install) gets every tag back without tagging
  again. Renaming or moving a file keeps its tags.
- **Set `AUTO_TAG=off`** to never send anything anywhere.

## What it can show

| Kind | Formats | Block shows |
| --- | --- | --- |
| Images | JPEG, PNG, GIF (animated), WebP, AVIF, SVG, TIFF, BMP, ICO, HEIC/HEIF, PSD/PSB, RAW (DNG, CR2, CR3, NEF, ARW, RAF, ORF, …) | the image |
| Video | MP4, MOV, M4V, WebM play in the browser; MKV, AVI, WMV, … show frames | a frame, with length |
| Audio | MP3, M4A, WAV, FLAC, OGG, … | cover art |
| Writing | TXT, Markdown, RTF, DOCX, ODT, HWP, HWPX, HTML, SRT/VTT subtitles, Fountain, EPUB, PPTX (and DOC on a Mac) | the first lines |
| PDF | PDF and Illustrator `.ai` | the first page, with its text searchable |
| Design | Keynote, Pages, Numbers, Sketch, Figma `.fig`, XD, InDesign, Affinity, EPS | the embedded preview |
| Fonts | TTF, OTF, WOFF, WOFF2 | a live specimen you can type into |
| Links | `.url`, `.webloc`, `.desktop`, Google Drive shortcuts | title, description and preview image |

Anything else still gets a block with its file type, and is found by name. Plain-text files with unusual extensions are detected
and shown as text. Old Korean (CP949) text files are decoded correctly, and Korean file names from a Mac are handled.

## Settings

All settings go in `archive/.env` (see `.env.example`). Real environment variables override the file.

| Setting | Default | |
| --- | --- | --- |
| `ARCHIVE_DIR` | `./library` | The folder with your files. |
| `DATA_DIR` | `./data` | Search index and thumbnails. Keep it out of the synced folder. |
| `TAGGER` | `claude` | Who writes the tags: `claude`, `ollama`, `gemini`, `openrouter` or `custom`. |
| `ANTHROPIC_API_KEY` | | Claude's API key. |
| `TAG_MODEL` | per tagger | `claude-opus-5`, `qwen3-vl:8b-instruct`, `gemini-3.5-flash-lite`, `openrouter/free`. (`CLAUDE_MODEL` still works too.) |
| `TAG_API_KEY` | | Key for `gemini`, `openrouter` or `custom`. |
| `TAG_API_URL` | | Another address for the tagger, e.g. Ollama on a different computer, or a `custom` API. |
| `ARCHIVE_LANGUAGES` | `en` | Tag language, then extra languages for hidden search keywords, e.g. `en,ko`. |
| `TAG_CONFIRM_OVER` | `50` | With a paid tagger (Claude, `custom`), ask before tagging a backlog larger than this. |
| `TAG_CONCURRENCY` | 2 for Claude, 1 otherwise | Blocks tagged at the same time. |
| `AUTO_TAG` | `on` | `off` to never send anything for tagging. |
| `ARCHIVE_TITLE` | `Archive` | Name shown at the top. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Where the web page is served. |
| `ARCHIVE_PASSWORD` | | Asks for a password (any user name) when set. |
| `RESCAN_MINUTES` | `10` | Full rescan interval. The folder is also watched live. |
| `MAX_UPLOAD_MB` | `4096` | Largest upload through the web page. |
| `FFMPEG_PATH` | | Only if ffmpeg isn't found by itself. |

## For developers

```sh
npm test      # extraction, thumbnails, search, tagging (with stand-ins for Claude, Ollama and Gemini), API, folder watching
npm run dev   # restarts on code changes
```

- `server.js` starts everything; `src/app.js` is the HTTP API.
- `src/library.js` scans and watches the folder, detects moves and renames, and imports uploads, memos and links.
- `src/analyze.js`, `src/extract.js`, `src/thumbs.js`, `src/media.js`, `src/zip.js`, `src/links.js` turn files into thumbnails, previews and text.
- `src/db.js` is the SQLite index (Node's built-in `node:sqlite`) with a trigram full-text index, so substring search works in every language.
- `src/tagger.js` queues blocks for tagging; `src/providers.js` talks to Claude, Ollama or an OpenAI-compatible API;
  `src/sidecar.js` keeps tags next to the files.
- `public/` is the whole web page: plain HTML, CSS and JavaScript, no build step.
