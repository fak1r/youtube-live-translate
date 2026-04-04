# YouTube Live Translate

Standalone local Node service and Chrome extension for live English-to-Russian subtitle translation on YouTube.

## Run

1. Install dependencies:
   `npm install`
2. Create `.env` from `.env.example`
3. Build:
   `npm run build`
4. Run in foreground:
   `npm run start`

Useful commands:

- `npm run dev`
- `npm run check`

## Chrome Extension

Load the repository root as an unpacked extension, or load [chrome/youtube-live-translate](/home/rezax/Dev/youtube-live-translate/chrome/youtube-live-translate).

The extension talks to the local HTTP API on `http://127.0.0.1:32123`.

## Environment

Primary variables:

- `YOUTUBE_LIVE_TRANSLATE_*`
- `UPSTREAM_PROXY_*`
- `HTTP_PROXY` / `HTTPS_PROXY`
- `LOG_LEVEL`
- `NODE_ENV`

Use `UPSTREAM_PROXY_URL` or `UPSTREAM_PROXY_SS_URL` when the service itself must tunnel outbound traffic through xray. If upstream proxying is not needed, leave them empty and rely on direct access or standard `HTTP_PROXY` / `HTTPS_PROXY`.

## Foreground Run

The expected mode is a normal terminal process:

- `npm run start`
- `npm run dev`

If `youtube-live-translate.service` was installed earlier, stop and disable it manually:

- `sudo systemctl disable --now youtube-live-translate`
