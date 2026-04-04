# YouTube Live Translate Extension

Chrome extension for live English-to-Russian subtitle translation on YouTube.

## Load In Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder or the repository root

## Requirements

- the local translate server must be running
- the server listens on `http://127.0.0.1:32123`
- YouTube captions must already exist on the page

## Behavior

- original English subtitle stays on top
- Russian translation is rendered below it
- translation color is light green
- fullscreen is supported
