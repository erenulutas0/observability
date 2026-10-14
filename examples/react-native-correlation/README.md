# React Native correlation demo

Shows how a mobile client and an Express server running express-observe can describe the **same request** from both sides, so that "the app feels slow" can be split into what the server measured and what it did not.

It does not diagnose mobile performance. It gives you request IDs and two sets of timings that line up, and it says plainly which part cannot be attributed.

## What lines up

```
user taps ───────────────────────────────────────────────────────────── first frame after React commit
│◄──────────────────────────── operationMs (app, proxy) ─────────────────────────────────────────────►│
   attempt 1 (X-Request-Id A)                 attempt 2 (X-Request-Id B)
   │◄──── clientAttemptMs (client) ────►│      │◄──── clientAttemptMs ────►│
        │◄─ durationMs (server log) ─►│             │◄─ durationMs ─►│
        │◄ app;dur ►│  (Server-Timing: until headers)
```

| Name | Measured by | Meaning |
|---|---|---|
| `operationMs` | the app | tap until the first frame after React committed the result. A proxy for "visible", not pixels on screen |
| `clientAttemptMs` | `correlation.js` | one HTTP attempt: request start until the body was parsed |
| `responseMs` | `correlation.js` | request start until `fetch()` resolved. React Native's `fetch` is built on XMLHttpRequest and may resolve only after the whole body |
| `app;dur` | server, via `Server-Timing` | middleware entry until headers were sent; visible to the client without any log access |
| `durationMs`, `headerDurationMs` | server, via access log | middleware entry until finish or disconnect, and until headers |
| not measured by server | `join.js` | `clientAttemptMs − durationMs`. **Not network time**: it mixes connection setup, queueing, transfer, kernel buffers and client parsing, and the clocks start and stop at different points |

Each physical attempt sends its own `X-Request-Id`. A retry is one operation with several request IDs.

## Run it without a phone

```bash
npm run simulate --workspace examples/react-native-correlation
```

Starts the example API in-process and plays the five scenarios with the **same** `correlation.js` the app uses, over real HTTP on loopback, then prints the joined view. This checks the correlation logic; it is not evidence about mobile behaviour (no radio network, no Hermes, no device CPU, no rendering).

## Run it with the Expo app

1. Start the API and keep its log:

   ```bash
   node examples/react-native-correlation/server.js > access.jsonl
   ```

2. Install and start the app (Expo SDK 57, React Native 0.86, react-native-safe-area-context 5.7). The app folder is deliberately outside the npm workspace, so the root install does not download Expo:

   ```bash
   cd examples/react-native-correlation/app
   npm install
   npx expo start
   ```

   An Android emulator needs several GB (system image about 3.5 GB unpacked, data partition up to about 7 GB). To keep that off the system drive, set the user environment variable `ANDROID_AVD_HOME` to a folder on another drive before creating the AVD; the system image folder can be moved there too and replaced by a directory junction (Windows) or symlink.

3. Open it in an Android emulator (the default base URL `http://10.0.2.2:4000` reaches your computer), the iOS simulator (`http://127.0.0.1:4000`), or Expo Go on a phone. A phone needs your computer's LAN address in the app and the server started with `HOST=0.0.0.0`; only do that on a trusted network.
4. Tap the scenarios. Each attempt is printed to the Metro console as a `client-attempt {...}` line.
5. Copy the console output to a file, for example `client.log`, and join it with the server log:

   ```bash
   node examples/react-native-correlation/join-cli.js client.log access.jsonl
   ```

## Scenarios

| Button | Server | What to look for |
|---|---|---|
| list (small) | 20 items at once | almost everything inside the server's time on loopback; on a phone, connection setup and transfer appear outside it |
| list (large) | 2000 items | larger `clientAttemptMs` from transfer and JSON parsing, while the server time stays small |
| slow list | waits 300 ms before headers, timed as `wait` | the client sees the cause in `Server-Timing` without reading any log |
| flaky, with retry | every other request answers 503 | one operation, two attempts, two request IDs, both in the server log |
| stall, client gives up | answers after 2 s; the client times out at 800 ms | the client has no response, but the server log has an `interrupted` record with the client's ID |

## Why the server trusts client IDs here

The last scenario only joins because the server accepts the client's `X-Request-Id` (`requestId.trustIncoming: true` in `server.js`). Without it, a request the client gave up on has no ID the client knows, and the join reports "unknown". The tests cover both settings.

Accepted IDs are correlation data, not identity: any client can choose them, records mark them with `requestIdSource: "client"`, and express-observe still validates their format. Decide per deployment whether that trade is worth it, for example by trusting only requests that come through your own gateway.

## Verified and not verified

- The correlation and join logic: 16 Jest tests against the real example API, including retries, client timeouts, unreachable servers, both trust settings and the join CLI.
- The app: the JavaScript bundle is built with `npx expo export --platform android` (Hermes bytecode) and `npx expo install --check` reports matching dependency versions.
- The app on an **Android emulator** (Android 15, Expo Go 57): all five scenarios ran and all six attempts joined with the server log. Results, screenshot and limits: [results/2026-10-14-android-emulator.md](results/2026-10-14-android-emulator.md).
- **Not verified yet:** a physical phone on a real network, and iOS.

## What this does not show

Rendering cost, image decoding, device CPU or memory, radio conditions, or anything the app does without HTTP. Those need platform tools (Android Studio profilers, Perfetto, Xcode Instruments) and a real device.
