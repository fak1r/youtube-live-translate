# YouTube Live Translate

Standalone local Node service and Chrome extension for live English-to-Russian subtitle translation on YouTube.

## Platform Support

- Windows
- macOS
- Linux

Default run mode does not require `.env`.

## Requirements

- Node.js 22+
- npm
- Google Chrome or another Chromium-based browser

## Quick Start

1. Install dependencies:
   `npm install`
2. Build:
   `npm run build`
3. Start the local server:
   `npm run start`
4. Load the extension in Chrome
5. Open a YouTube stream or video with captions enabled

The extension talks to the local HTTP API on `http://127.0.0.1:32123`.

## Windows With Full-Tunnel VPN

No `.env` is needed.

Run:

```powershell
npm install
npm run build
npm run start
```

In this mode the app makes direct connections and your VPN handles routing outside the app.

## Optional `.env`

Create `.env` only if you want to set an upstream proxy URL or change log level.

Pick the command for your shell:

- PowerShell:
  `Copy-Item .env.example .env`
- Command Prompt:
  `copy .env.example .env`
- Bash:
  `cp .env.example .env`

Supported fields:

- `PROXY=...`
  If set, the app starts the built-in `xray` sidecar and routes YouTube requests through this proxy URL. Supports `vless://...` and `ss://...`.
- `LOG_LEVEL=debug`
  Optional log verbosity override.

Examples:

No proxy, direct mode:

```dotenv
# empty .env is fine too
```

Proxy enabled:

```dotenv
PROXY=vless://...
```

## How Proxy Selection Works

- `PROXY` exists and is not empty:
  use the built-in proxy sidecar
- `.env` is missing, empty, or `PROXY` is empty:
  connect directly

This matches the Windows full-tunnel VPN case: by default the app does not add its own proxy layer.

If you use `PROXY` on Windows, `xray.exe` must be available in `PATH`.

## Chrome Extension

Load the repository root as an unpacked extension, or load `chrome/youtube-live-translate`.

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the repository root or `chrome/youtube-live-translate`

Requirements:

- the local translate server must be running
- the server listens on `http://127.0.0.1:32123`
- YouTube captions must already exist on the page

## Useful Commands

- `npm run dev`
- `npm run check`
- `npm run build`
- `npm run start`

## Linux `systemd` Service

`systemd` is optional and Linux-only.

The install scripts generate a machine-specific unit with your current:

- repository path
- user name
- Node.js binary path

Install or refresh the service:

- `./scripts/service-install.sh`
- `./scripts/service-start.sh`

Stop the service:

- `./scripts/service-stop.sh`

Show status:

- `./scripts/service-status.sh`

If you want to stop using the service and return to foreground run:

- `sudo systemctl disable --now youtube-live-translate`

## Notes

- If extension changes do not apply immediately, reload the unpacked extension in `chrome://extensions`.
- If server-side changes do not apply immediately, stop the current process and run `npm run start` again.
