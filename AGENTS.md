# Chart-App (Temporary Chats)

WhatsApp-style ephemeral chat app: single-file web app (`index.html`) + Express/ws server (`server.js`), wrapped as an Android APK via Capacitor.

## Commands
- `npm start` — run dev server on :8080 (PC browser + phone via `adb reverse tcp:8080 tcp:8080`)
- `node server.js` in background for testing; server log at `/tmp/opencode/chart-server.log`

## MANDATORY after every web update (user request: always deploy + open APK)
1. `cp index.html www/index.html`
2. `npx cap sync android`  ← REQUIRED; Gradle builds from `android/app/src/main/assets/public/`, NOT from `www/`
3. `cd android && ./gradlew assembleDebug`
4. `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
5. `adb shell am force-stop com.chartapp.temporarychats && adb shell monkey -p com.chartapp.temporarychats -c android.intent.category.LAUNCHER 1`

## Architecture notes
- APK WebView reports hostname `localhost`; `wsUrl()` detects native (`window.Capacitor`) and uses production Render WSS (`chart-app-lenp.onrender.com`). Local/LAN browsers use same-host WS.
- Server: rooms keyed by code, messages TTL 3 min, max 6 users/room. Message types: join/message/edit_message/delete_message/reaction/seen/typing.
- Permissions requested at launch in `MainActivity.java` (RECORD_AUDIO, CAMERA, READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE).
- WebView remote debugging enabled; inspect via `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + CDP.
- Never `pkill -f "node server.js"` — it kills the wrapping shell session; use the PID from `pgrep -a node`.
