---
name: phone-build
description: Build a real, sign-in-able Android preview APK of a Forty-Two branch on this machine (eas build --local in WSL) and install it on the user's phone over adb. Use when asked to put a build or a branch on the phone, for a version they can sign in on, or to test a change on the real device against the deployed Worker.
---

# Preview build on the phone

`apps/mobile/scripts/phone-build.ps1` does it all. Run it with the PowerShell tool from the
repository root, **in the background**. It takes about 10 minutes with Gradle's cache warm and
about 45 the first time.

```powershell
./apps/mobile/scripts/phone-build.ps1                       # this checkout's branch
./apps/mobile/scripts/phone-build.ps1 -Branch <branch>      # another local branch
./apps/mobile/scripts/phone-build.ps1 -Device <ip:port>     # connect to the phone first
./apps/mobile/scripts/phone-build.ps1 -BuildOnly            # just the APK
./apps/mobile/scripts/phone-build.ps1 -Apk <path>           # install an APK built earlier
```

Here is what it does:

1. It checks that the phone is in `adb devices`, before the long build.
2. It builds the branch's last commit in the WSL clone `~/fortytwo` (`wsl-apk.sh`).
3. It copies the APK to `%TEMP%\fortytwo-phone-build\` and runs `adb install -r` with it.

The script prints each step's time and the new versionCode.

## Before running it

- **Commit first.** Only what's committed on the branch is built. The script warns about
  uncommitted changes in this checkout.
- **The phone.** If no phone is connected, the script stops before building. Ask the user to
  turn on Wireless debugging (Settings > System > Developer options) and for the IP:port it
  shows, then pass it as `-Device`. The port changes each time Wireless debugging is turned on.
  Don't guess it from an earlier session. While you wait for the address, you can start the build
  with `-BuildOnly`, then install with `-Apk <path it printed> -Device <ip:port>`.
- **What it talks to.** The app uses the deployed Worker and real Auth0, from the EAS
  `preview` environment. A change that needs a new Worker endpoint won't work on the phone until
  that Worker is deployed. Say so rather than calling the build checked.

## Not this skill

- **Cloud builds** (`eas build` without `--local`, or the release workflow) use up the
  Free plan's monthly Android builds. Ask the user before starting one.
- **The emulator with the dev bypass** is quicker for looking at screens. Use the
  `mobile-emulator` skill for that.

## When something's off

- **"no output for Ns, stopping it" then a retry** is the watchdog. A lost connection leaves
  npm or EAS waiting for good, and a retry gets past it. Each build attempt that gets
  as far as signing raises the remote versionCode, so a retried build can skip a number. That's
  harmless.
- **Every attempt stalls**: first check that `%USERPROFILE%\.wslconfig` still has
  `networkingMode=mirrored`. Under WSL's default NAT mode about 1 in 4 connections to Expo's
  API were lost, which hangs EAS at startup. Then look at the logs in `~/.fortytwo-build/` in
  WSL (`npm-ci.log`, `eas-build.log`, and `*.stalled-N` for each stalled attempt). `ss -tnp` in
  WSL shows a stuck connection as a non-zero Send-Q. To compare WSL with Windows, run
  `curl -s -o /dev/null https://api.expo.dev/` about 20 times in each.
- **The install fails** with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` or `VERSION_DOWNGRADE`: the
  installed app has to be uninstalled first, which signs the user out. Ask before doing that.
- **"has uncommitted changes" for `~/fortytwo`**: someone edited the WSL clone. Ask before
  discarding anything there.
- **Missing toolchain** (`No ~/.buildenv`, `eas: command not found`): follow the README's
  "Phone builds from WSL" setup.
