<#
.SYNOPSIS
Builds a preview APK of a branch in WSL and installs it on a phone over adb.

.DESCRIPTION
A preview build is the real app: it signs in with Auth0 and talks to the deployed Worker, as set
in the EAS "preview" environment. It's built on this machine with `eas build --local` inside WSL
(wsl-apk.sh), so it uses none of the EAS plan's cloud builds, but it is signed with the EAS
keystore and raises the remote versionCode, so it installs over a cloud-built app, keeping its
sign-in. Needs the one-time setup in the root README.md, "Phone builds from WSL".

The branch is built as it is in git: commit first, as uncommitted changes aren't included. The
build runs from a clone in WSL, which fetches the branch from the Windows checkout.

.PARAMETER Branch
The branch to build. Defaults to this checkout's current branch.

.PARAMETER Device
The phone's adb address from Android's Wireless debugging screen, e.g. 100.81.159.48:39595.
Only needed when the phone isn't already in `adb devices`. The port changes each time
Wireless debugging is turned on.

.PARAMETER BuildOnly
Build the APK and copy it to Windows, but don't install it.

.PARAMETER Apk
Install this APK, from an earlier run, instead of building one.

.EXAMPLE
pwsh apps/mobile/scripts/phone-build.ps1
pwsh apps/mobile/scripts/phone-build.ps1 -Branch waterfausett/some-feature -Device 100.81.159.48:39595
pwsh apps/mobile/scripts/phone-build.ps1 -Apk $env:TEMPortytwo-phone-buildortytwo-<branch>-<commit>.apk
#>
param(
  [string]$Branch,
  [string]$Device,
  [switch]$BuildOnly,
  [string]$Apk,
  [string]$Distro = 'Ubuntu',
  # Seconds without new output before a step counts as stuck and is restarted. Gradle can go
  # quiet for a few minutes on its own, so the build gets longer.
  [int]$NpmStallSeconds = 180,
  [int]$BuildStallSeconds = 420,
  [int]$Attempts = 3
)

$ErrorActionPreference = 'Stop'
$Package = 'com.waterfausett.fortytwo'
$MobileDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$OutDir = Join-Path $env:TEMP 'fortytwo-phone-build'

$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$AdbExe = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $AdbExe) { $AdbExe = Join-Path $Sdk 'platform-tools\adb.exe' }

function Step($message) { Write-Host "> $message" -ForegroundColor Cyan }

# The phone: an adb device in the "device" state that isn't an emulator.
function Get-Phone {
  & $AdbExe devices | Select-Object -Skip 1 |
    Where-Object { $_ -match '^(\S+)\s+device$' -and $Matches[1] -notlike 'emulator-*' } |
    ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1
}

# --- Which commit ---------------------------------------------------------------------------

if ($Apk) {
  if (-not (Test-Path $Apk)) { throw "No APK at $Apk." }
} else {
  if (-not $Branch) { $Branch = (git -C $MobileDir branch --show-current).Trim() }
  if (-not $Branch) { throw 'This checkout has no branch checked out; pass -Branch.' }
  $Commit = (git -C $MobileDir rev-parse "refs/heads/$Branch").Trim()
  if ($LASTEXITCODE -ne 0) { throw "No local branch $Branch." }
  $current = (git -C $MobileDir branch --show-current).Trim()
  if ($current -eq $Branch -and (git -C $MobileDir status --porcelain --untracked-files=no)) {
    Write-Warning 'This checkout has uncommitted changes. The build only includes what is committed.'
  }
}

# Checked before the long build, so a missing phone doesn't waste it.
if (-not $BuildOnly) {
  if ($Device) {
    & $AdbExe connect $Device | Out-Null
  }
  if (-not (Get-Phone)) {
    throw "No phone in 'adb devices'. Turn on Wireless debugging on the phone and pass its IP:port with -Device, or pass -BuildOnly."
  }
}

# --- Build in WSL ---------------------------------------------------------------------------

# Builds the branch in WSL and copies the APK to $OutDir; returns its path.
function Build-Apk {
  $script = Join-Path $PSScriptRoot 'wsl-apk.sh'
  $wslScript = (& wsl.exe -d $Distro -- wslpath -a ($script -replace '\\', '/')).Trim()
  if ($LASTEXITCODE -ne 0) { throw "WSL distro '$Distro' isn't available (wsl -l -v lists them)." }

  Step "Building $Branch ($($Commit.Substring(0, 7))) in WSL"
  $apkLine = $null
  # Run from a copy: bash reads a script as it goes, so editing the checkout's copy during a build
  # would change what the running build does next. --exec, not --, so no shell re-splits it.
  & wsl.exe -d $Distro --cd '~' --exec bash -c 'cp "$0" /tmp/wsl-apk.sh && exec bash /tmp/wsl-apk.sh "$@"' `
    $wslScript $Branch $Commit $NpmStallSeconds $BuildStallSeconds $Attempts |
    ForEach-Object {
      if ($_ -like 'APK=*') { $apkLine = $_ } else { Write-Host $_ }
    }
  if ($LASTEXITCODE -ne 0 -or -not $apkLine) { throw 'The build failed; see above.' }

  $wslApk = $apkLine.Substring(4)
  New-Item -ItemType Directory -Force $OutDir | Out-Null
  $safeName = $Branch -replace '[^\w.-]', '-'
  $apk = Join-Path $OutDir "fortytwo-$safeName-$($Commit.Substring(0, 7)).apk"
  Copy-Item ((& wsl.exe -d $Distro -- wslpath -w $wslApk).Trim()) $apk -Force
  Step "APK: $apk"
  return $apk
}

if (-not $Apk) { $Apk = Build-Apk }
if ($BuildOnly) { return }

# --- Install --------------------------------------------------------------------------------

$phone = Get-Phone
if (-not $phone) { throw "The phone left 'adb devices' during the build. Reconnect it, then install with -Apk $Apk" }
Step "Installing on $phone"
$result = & $AdbExe -s $phone install -r $Apk 2>&1 | Out-String
if ($result -notmatch 'Success') {
  # Not uninstalled automatically: that loses the app's sign-in and data on the phone.
  Write-Host $result
  throw "The install failed. INSTALL_FAILED_UPDATE_INCOMPATIBLE or VERSION_DOWNGRADE means the installed app has to be uninstalled first, which signs it out."
}
$version = & $AdbExe -s $phone shell dumpsys package $Package | Select-String 'versionCode=\d+' | Select-Object -First 1
Step "Installed: $($version.Matches[0].Value)"
