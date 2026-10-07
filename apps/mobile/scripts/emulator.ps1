<#
.SYNOPSIS
Runs the mobile app in the Android emulator on Windows and drives it from the command line.

.DESCRIPTION
`up` gets from nothing to the app on screen, in order, skipping whatever is already done:
boots the emulator, builds and installs the app if it isn't installed, starts Metro for this
checkout on a free port, and opens the app against it. Building needs the setup in "Building for
Android on Windows" in the root README.md.

By default the app runs with the dev bypass (src/dev/devBypass.ts): signed in, with canned
lobby and profile data and no Worker. -SignIn runs it for real, signing in with Auth0 from
.env.local.

Commands:
  up [-Rebuild] [-SignIn] [-Avd <name>]   Start everything, then open the app.
  build                                   Regenerate android\, rebuild and reinstall the app.
  reload                                  Restart the app against the running Metro.
  shot [<file>]                           Screenshot at full resolution; prints the file's path.
  tap <x> <y>                             Tap, in full-resolution screen pixels.
  swipe <x1> <y1> <x2> <y2> [<ms>]        Swipe (a pull-to-refresh is a downward swipe).
  back                                    Press Back.
  type <text>                             Type into the focused field.
  open <route>                            Open a screen by its route, e.g. `open profile`.
  logs [<lines>]                          The end of Metro's log.
  status                                  What's running.
  down [-Emulator]                        Stop this checkout's Metro (and the emulator).

.EXAMPLE
pwsh scripts/emulator.ps1 up
pwsh scripts/emulator.ps1 shot
pwsh scripts/emulator.ps1 tap 540 315
#>
param(
  [Parameter(Position = 0)][string]$Command = 'status',
  [Parameter(Position = 1, ValueFromRemainingArguments)][string[]]$Arguments = @(),
  [switch]$Rebuild,
  [switch]$SignIn,
  [switch]$Emulator,
  [string]$Avd
)

$ErrorActionPreference = 'Stop'
$Package = 'com.waterfausett.fortytwo'
$MobileDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StateFile = Join-Path $MobileDir '.expo\emulator.json'
$MetroLog = Join-Path $MobileDir '.expo\metro.log'
$BuildLog = Join-Path $MobileDir '.expo\build.log'
$ShotDir = Join-Path $env:TEMP 'fortytwo-emulator'

# --- Tools --------------------------------------------------------------------------------

$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$env:ANDROID_HOME = $Sdk
# Gradle needs Java 17 or later; Android Studio's own JDK is, whatever JAVA_HOME says.
$Jbr = 'C:\Program Files\Android\Android Studio\jbr'
if (Test-Path $Jbr) { $env:JAVA_HOME = $Jbr }
$AdbExe = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $AdbExe) { $AdbExe = Join-Path $Sdk 'platform-tools\adb.exe' }
$EmulatorExe = Join-Path $Sdk 'emulator\emulator.exe'

function Step($message) { Write-Host "> $message" -ForegroundColor Cyan }

# Runs a build step, its output appended to the build log; a failure shows the log's end.
function Invoke-Checked([string]$exe, [string[]]$arguments) {
  "`n> $exe $($arguments -join ' ')" | Add-Content $BuildLog
  & $exe @arguments *>> $BuildLog
  if ($LASTEXITCODE -ne 0) {
    Get-Content $BuildLog -Tail 40 | Write-Host
    throw "$exe $($arguments -join ' ') exited with $LASTEXITCODE. The whole log: $BuildLog"
  }
}

# --- State --------------------------------------------------------------------------------

function Get-State {
  if (Test-Path $StateFile) { return Get-Content $StateFile -Raw | ConvertFrom-Json }
  return $null
}

function Save-State($state) {
  New-Item -ItemType Directory -Force (Split-Path $StateFile) | Out-Null
  $state | ConvertTo-Json | Set-Content $StateFile
}

# --- Emulator -----------------------------------------------------------------------------

# Runs adb and returns its output lines, with a time limit: a wedged adb server otherwise hangs
# every call, `adb devices` and `adb kill-server` included.
function Invoke-Adb([string[]]$arguments, [int]$timeoutSeconds = 30) {
  $info = [Diagnostics.ProcessStartInfo]::new($AdbExe)
  foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.UseShellExecute = $false
  $process = [Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
    $process.Kill()
    throw "adb $($arguments -join ' ') didn't answer in $timeoutSeconds s. The adb server is probably stuck: end adb.exe (taskkill /F /IM adb.exe), then try again."
  }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "adb $($arguments -join ' ') failed: $($stderr.Result.Trim())" }
  return $stdout.Result -split "\r?\n" | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ }
}

# Always an emulator, never a phone that happens to be plugged in.
function Get-EmulatorSerial {
  $line = Invoke-Adb @('devices') | Where-Object { $_ -match '^(emulator-\d+)\s+device$' } | Select-Object -First 1
  if ($line -match '^(emulator-\d+)') { return $Matches[1] }
  return $null
}

function Adb([string[]]$arguments, [int]$timeoutSeconds = 30) {
  $serial = Get-EmulatorSerial
  if (-not $serial) { throw 'No emulator is running. Start one with: emulator.ps1 up' }
  Invoke-Adb (@('-s', $serial) + $arguments) $timeoutSeconds
}

function Start-Emulator {
  $serial = Get-EmulatorSerial
  if ($serial) { return $serial }
  $name = $Avd
  if (-not $name) { $name = & $EmulatorExe -list-avds | Where-Object { $_ } | Select-Object -First 1 }
  if (-not $name) { throw 'No Android virtual device. Create one in Android Studio (Device Manager).' }
  Step "Booting emulator $name"
  Start-Process -FilePath $EmulatorExe -ArgumentList '-avd', $name, '-no-snapshot-save' -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $serial = Get-EmulatorSerial
    try {
      if ($serial -and (Invoke-Adb @('-s', $serial, 'shell', 'getprop', 'sys.boot_completed')) -eq '1') { return $serial }
    } catch {}
  }
  throw 'The emulator did not finish booting within 3 minutes.'
}

# --- Native build -------------------------------------------------------------------------

function Test-Installed {
  return [bool](Adb @('shell', 'pm', 'list', 'packages', $Package) | Where-Object { $_ -eq "package:$Package" })
}

# The native build writes files at paths past Windows' old 260-character limit, which only a
# long-path-aware ninja (1.12 or later) can handle; the SDK's CMake ships an older one. Checked
# up front, as otherwise the build fails minutes in ("Filename longer than 260 characters").
function Assert-LongPathNinja {
  foreach ($cmake in Get-ChildItem (Join-Path $Sdk 'cmake') -Directory -ErrorAction SilentlyContinue) {
    $ninja = Join-Path $cmake.FullName 'bin\ninja.exe'
    if (-not (Test-Path $ninja)) { continue }
    $version = [version]((& $ninja --version) -replace '[^\d.].*$', '')
    if ($version -lt [version]'1.12') {
      throw "$ninja is ninja $version, which can't handle long paths. Replace it with ninja 1.12 or later (see 'Building for Android on Windows' in the root README.md)."
    }
  }
}

# -Clean regenerates android\ from app.json and the config plugins first; otherwise it's only
# generated when it's missing.
function Build-App([switch]$Clean) {
  Assert-LongPathNinja
  # The Auth0 config plugin needs a domain at build time, even with the dev bypass.
  if (-not (Test-Path (Join-Path $MobileDir '.env.local')) -and -not $env:EXPO_PUBLIC_AUTH0_DOMAIN) {
    throw "No .env.local. Copy .env.example to .env.local and fill it in; for the dev bypass alone, placeholder Auth0 values (any domain, e.g. dev.example.auth0.com) will do."
  }
  $serial = Start-Emulator
  # Expo names a running emulator by its virtual device, which also stops it asking which
  # device to use when a phone is plugged in too.
  $avdName = Invoke-Adb @('-s', $serial, 'emu', 'avd', 'name') | Select-Object -First 1
  Step "Building the app for $avdName. Log: $BuildLog"
  New-Item -ItemType Directory -Force (Split-Path $BuildLog) | Out-Null
  Set-Content $BuildLog ''
  $env:EXPO_PUBLIC_DEV_BYPASS = $null
  $env:CI = '1'
  Push-Location $MobileDir
  try {
    if ($Clean -or -not (Test-Path 'android')) {
      Invoke-Checked npx (@('expo', 'prebuild', '--platform', 'android', '--no-install') + $(if ($Clean) { '--clean' }))
    }
    # Builds for the emulator's ABI, and installs.
    Invoke-Checked npx @('expo', 'run:android', '--no-bundler', '--device', $avdName)
  } finally {
    Remove-Item Env:CI -ErrorAction SilentlyContinue
    Pop-Location
  }
}

# --- Metro --------------------------------------------------------------------------------

function Test-PortListening([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Test-MetroRunning($state) {
  if (-not $state -or -not $state.metroPid) { return $false }
  if (-not (Get-Process -Id $state.metroPid -ErrorAction SilentlyContinue)) { return $false }
  return Test-PortListening $state.port
}

function Stop-Metro {
  $state = Get-State
  if ($state -and $state.metroPid -and (Get-Process -Id $state.metroPid -ErrorAction SilentlyContinue)) {
    Step "Stopping Metro on port $($state.port)"
    # The whole tree: npx's wrapper, and the node process under it that holds the port.
    taskkill /T /F /PID $state.metroPid | Out-Null
  }
  if ($state) { Save-State @{ port = $state.port; bypass = $state.bypass } }
}

function Start-Metro([bool]$bypass) {
  $state = Get-State
  if ((Test-MetroRunning $state) -and [bool]$state.bypass -eq $bypass) { return [int]$state.port }
  Stop-Metro
  # Leaves 8081 to any other checkout's Metro.
  $port = 8081
  while (Test-PortListening $port) { $port++ }
  Step "Starting Metro on port $port$(if ($bypass) { ' with the dev bypass' })"
  $env:EXPO_PUBLIC_DEV_BYPASS = if ($bypass) { '1' } else { $null }
  # --clear: the bypass switch is inlined into the bundle, so a cached one could be stale.
  $process = Start-Process -FilePath 'cmd.exe' -WorkingDirectory $MobileDir -WindowStyle Hidden -PassThru `
    -ArgumentList '/c', "npx expo start --dev-client --clear --port $port > `"$MetroLog`" 2>&1"
  $env:EXPO_PUBLIC_DEV_BYPASS = $null
  Save-State @{ metroPid = $process.Id; port = $port; bypass = $bypass }
  $deadline = (Get-Date).AddMinutes(2)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
      # No content type on the reply, so Invoke-RestMethod rather than Invoke-WebRequest (bytes).
      if ((Invoke-RestMethod "http://localhost:$port/status" -TimeoutSec 2) -match 'running') { return $port }
    } catch {}
    if ($process.HasExited) { throw "Metro exited. Its log: $MetroLog" }
  }
  throw "Metro didn't start within 2 minutes. Its log: $MetroLog"
}

# --- The app ------------------------------------------------------------------------------

function Open-App([int]$port) {
  Adb @('reverse', "tcp:$port", "tcp:$port") | Out-Null
  Adb @('shell', 'am', 'force-stop', $Package) | Out-Null
  $url = [uri]::EscapeDataString("http://localhost:$port")
  Adb @('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "exp+fortytwo://expo-development-client/?url=$url") | Out-Null
  Step "Opened the app against Metro on port $port. The first bundle takes a while; check with: emulator.ps1 shot"
}

function Save-Screenshot([string]$file) {
  if (-not $file) {
    New-Item -ItemType Directory -Force $ShotDir | Out-Null
    $file = Join-Path $ShotDir ("shot-{0:yyyyMMdd-HHmmss}.png" -f (Get-Date))
  }
  Adb @('shell', 'screencap', '-p', '/sdcard/fortytwo-shot.png') | Out-Null
  Adb @('pull', '/sdcard/fortytwo-shot.png', $file) | Out-Null
  $size = (Adb @('shell', 'wm', 'size') | Select-Object -First 1) -replace '.*:\s*', ''
  Write-Output "$file ($size)"
}

switch ($Command) {
  'up' {
    Start-Emulator | Out-Null
    if ($Rebuild) { Build-App -Clean } elseif (-not (Test-Installed)) { Build-App }
    Open-App (Start-Metro (-not $SignIn))
  }
  'build' { Build-App -Clean; $state = Get-State; if (Test-MetroRunning $state) { Open-App $state.port } }
  'reload' {
    $state = Get-State
    if (-not (Test-MetroRunning $state)) { throw 'Metro is not running. Start it with: emulator.ps1 up' }
    Open-App $state.port
  }
  'shot' { Save-Screenshot ($Arguments | Select-Object -First 1) }
  'tap' { Adb (@('shell', 'input', 'tap') + $Arguments[0..1]) }
  'swipe' { Adb (@('shell', 'input', 'swipe') + $Arguments) }
  'back' { Adb @('shell', 'input', 'keyevent', 'KEYCODE_BACK') }
  'type' { Adb @('shell', 'input', 'text', (($Arguments -join ' ') -replace ' ', '%s')) }
  'open' {
    $route = ($Arguments | Select-Object -First 1).TrimStart('/')
    Adb @('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "fortytwo://$route", $Package) | Out-Null
  }
  'logs' {
    $lines = if ($Arguments) { [int]$Arguments[0] } else { 40 }
    Get-Content $MetroLog -Tail $lines
  }
  'status' {
    $state = Get-State
    $serial = Get-EmulatorSerial
    Write-Output "Emulator:  $(if ($serial) { $serial } else { 'not running' })"
    Write-Output "App:       $(if ($serial) { if (Test-Installed) { 'installed' } else { 'not installed' } } else { '-' })"
    $metro = if (Test-MetroRunning $state) {
      "port $($state.port)$(if ($state.bypass) { ', dev bypass' } else { ', signing in' })"
    } else { 'not running' }
    Write-Output "Metro:     $metro"
  }
  'down' {
    Stop-Metro
    if ($Emulator -and (Get-EmulatorSerial)) { Step 'Stopping the emulator'; Adb @('emu', 'kill') | Out-Null }
  }
  default { throw "Unknown command '$Command'. See: Get-Help $PSCommandPath" }
}
