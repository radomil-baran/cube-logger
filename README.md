# cube-logger

A one-page web app that records everything a Bluetooth smart cube sends, so that people can
record sessions for the [rubiks-move-recognition](https://github.com/radomil-baran/rubiks-move-recognition)
dataset without installing anything. It runs entirely in the browser (Web Bluetooth); nothing is
uploaded, the log is downloaded as a file.

Supported cubes are those of [smartcube-web-bluetooth](https://github.com/poliva/smartcube-web-bluetooth):
GAN (Gen1-4, also MoYu AI 2023), MoYu WRM / MHC, QiYi and XMD Tornado V4, Giiker, GoCube.

## Browsers

| Device | Works |
|---|---|
| Windows, macOS, ChromeOS: Chrome or Edge | yes |
| Android: Chrome | yes |
| Linux: Chrome | after enabling `chrome://flags` → Experimental Web Platform features |
| iPhone / iPad | only in the Bluefy browser (untested) |
| Firefox, Safari | no |

Some cubes (GAN, MoYu WRM, QiYi) encrypt with a key derived from their MAC address, which Web
Bluetooth hides. The library reads it from advertisements or tries candidates from the device
name; if that fails, the page asks for it (from `chrome://bluetooth-internals`). The MAC is cached
per cube in the browser after the first success.

## Run it

- **Locally (for testing):** `python -m http.server 8000` in this folder, then open
  <http://localhost:8000>. Web Bluetooth needs a secure context, and `localhost` counts as one.
- **Published:** GitHub Pages (Settings → Pages → Deploy from a branch → `main`, `/ (root)`).
  The page is then at `https://<user>.github.io/cube-logger/`.

## Log format (`cube-logger/1`)

JSON Lines, one object per line. The first line is `META`, the others are in arrival order.
Times: `host_wall_ms` is the host wall clock (Unix ms, µs resolution), `host_mono_ms` the
monotonic clock since the page loaded. Both include the Bluetooth delay (up to a few hundred ms),
so move timing must come from the cube's own clock, decoded from the raw bytes.

| `type` | Fields | Meaning |
|---|---|---|
| `META` | `format`, `logger_version`, `library` (repo@commit), `raw_capture`, `user_agent`, `time_origin_ms`, `connections` (list of `device`, `mac`, `protocol`, `capabilities`, host times), `saved_wall_ms` | Header. |
| `GATT` | `op` (`notify`, `write`, `read`), `service`, `char` (UUIDs), `raw` (hex), host times | Every byte in or out, before the library sees it. Includes the handshake and, while the library searches for the MAC, traffic from wrong attempts. |
| `EVENT` | `event` (the library's decoded event without its `timestamp`), `lib_timestamp`, host times | `MOVE`, `FACELETS`, `BATTERY`, `HARDWARE`, `DISCONNECT`. Gyro events are only in `GATT`. |
| `MARK` | `what` (`connected`, `disconnected`, `user_says_solved`, `reset_to_solved`), host times | What the user or the page did. |

The library's `MOVE.cubeTimestamp` is not used as ground truth: some drivers re-anchor it to the
host clock. The offline decoder reads cube time from `GATT` bytes.

## Files

- `index.html`, `logger.js`: the page.
- `vendor/smartcube-web-bluetooth.js`: the library bundled into one ES module (MIT,
  `vendor/smartcube-web-bluetooth.LICENSE.txt`). Built from commit `2077416d` with:

  ```bash
  git clone https://github.com/poliva/smartcube-web-bluetooth && cd smartcube-web-bluetooth
  git checkout 2077416d6c828ec926dee424cf1bbfe4c0f25a47
  npm ci --ignore-scripts
  npx esbuild@0.25.10 src/index.ts --bundle --format=esm --target=es2020 --legal-comments=inline \
      --outfile=smartcube-web-bluetooth.js
  ```

  Without a Node install: prefix `npm` / `npx` with `uvx --from nodejs-wheel`.
