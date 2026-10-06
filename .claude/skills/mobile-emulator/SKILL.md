---
name: mobile-emulator
description: Run the Forty-Two mobile app (cloudflare/apps/mobile) in the Android emulator on Windows, sign-in bypassed, and look at or drive its screens - screenshots, taps, swipes, opening routes. Use when changing anything the mobile app shows, to see it working, or when asked to run, screenshot or test the app in the emulator.
---

# Mobile app in the Android emulator

`cloudflare/apps/mobile/scripts/emulator.ps1` does the setup in the right order, skipping
whatever's already done. Run it with the PowerShell tool from `cloudflare/apps/mobile`.

## Start

```powershell
./scripts/emulator.ps1 up
```

This boots the emulator, builds and installs the app if it's missing (5+ minutes; run `up` in
the background the first time), starts Metro for this checkout on a free port, and opens the app.
Give the first bundle about 30 seconds, then take a screenshot.

- **Sign-in is bypassed** by default (`src/dev/devBypass.ts`, `EXPO_PUBLIC_DEV_BYPASS=1`): the
  app acts signed in and the API answers from canned data. The lobby and the profile work, and
  so do the canned matches in `src/dev/devMatches.ts`: `open match/dev-bidding`, `dev-trump`,
  `dev-playing` or `dev-hand-over`. Your moves there go through the real rules, but nobody else
  moves; opening the match again starts it over. Any other match fails with "Not in the dev
  bypass". To show other data, edit the canned data in `devBypass.ts`; Metro reloads it.
- **Timing races:** `devTiming` in `devMatches.ts` sets when a move's reply and its broadcast
  arrive (broadcast first, as on a real table). Swap them to see the screen when the reply wins.
  A flash is too quick for `shot`: record it with `adb -s emulator-5554 shell screenrecord
  --time-limit 4 /sdcard/rec.mp4` while tapping, pull it, and tile frames with ffmpeg
  (`-vf "fps=15,tile=6x6"`). From Git Bash, set `MSYS_NO_PATHCONV=1` first.
- `up -SignIn` runs the real sign-in instead, which needs real Auth0 values in `.env.local`
  and a Worker.
- `up -Rebuild`, or `build`, rebuilds the native app. Only needed after native changes: a new
  native library, `app.json`/`app.config.js`, or Auth0 settings. JavaScript changes reload by
  themselves.

## Look and drive

```powershell
./scripts/emulator.ps1 shot              # prints "<file> (1080x2220)"; then Read the file
./scripts/emulator.ps1 tap 540 315       # full-resolution pixels
./scripts/emulator.ps1 swipe 540 600 540 1400 400   # pull to refresh
./scripts/emulator.ps1 back
./scripts/emulator.ps1 type hello
./scripts/emulator.ps1 open profile      # a route, as fortytwo://profile
./scripts/emulator.ps1 reload            # restart the app
./scripts/emulator.ps1 logs 60           # Metro's log: bundling errors land here
./scripts/emulator.ps1 status
```

- **Coordinates:** the Read tool shows the screenshot scaled down and says by how much
  ("multiply coordinates by 1.11"). Multiply what you see by that factor before tapping.
- **Dev menu:** right after a fresh install the dev client opens a white "developer menu" sheet
  over the app. Close it: tap its Continue button, or the X at the top right of the sheet.
- **The grey gear button** floating over the screen is the dev tools shortcut. It can sit on top
  of what you want to tap, such as the profile avatar. Use `open <route>` instead, or tap
  around it.
- Wait 1-2 seconds after a tap before taking a screenshot, longer for navigation.

## Finish

- Run `./scripts/emulator.ps1 down` when done. It stops this checkout's Metro; `down -Emulator`
  also shuts the emulator. Leave it running if the user wants to look at the app.
- Commit no changes to `devBypass.ts`'s canned data made only to set up a screenshot.

## When something's off

- **"adb ... didn't answer"**: the adb server is stuck, and every adb command hangs. End it
  with `taskkill /F /IM adb.exe`, then retry. That briefly drops other adb users' connections
  (another session's phone, say), so mention it to the user.
- **Never stop a Metro the script didn't start.** Another checkout's Metro often holds 8081,
  so this checkout's Metro gets the next free port. The script tracks its own in
  `.expo/emulator.json`.
- **A phone plugged in** is fine: the script only ever talks to the emulator.
- **`tsc` errors in `_layout.tsx` or `usePushNotifications.ts` about route strings**, once
  Metro has run: they come from the route types Metro generates (`expo-env.d.ts`, `.expo/types`).
  CI doesn't generate those, so they aren't real failures.
- **Native build failures**: the script prints the end of `.expo/build.log`. The README's
  "Building for Android on Windows" covers the machine setup (JDK, SDK, the long-path ninja the
  script checks for). Don't work around path-length errors with `subst`: it breaks autolinking.
