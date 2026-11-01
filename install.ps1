# Liquid Agent installer for Windows (PowerShell)
# Run:
#   irm https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = if ($env:LIQUID_AGENT_REPO) { $env:LIQUID_AGENT_REPO } else { "morriszdweck/liquid-agent" }
$Branch = if ($env:LIQUID_AGENT_BRANCH) { $env:LIQUID_AGENT_BRANCH } else { "main" }
$Root = if ($env:LIQUID_AGENT_HOME) { $env:LIQUID_AGENT_HOME } else { Join-Path $env:USERPROFILE ".liquid-agent" }
$Data = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "LiquidAgent" } else { Join-Path $env:USERPROFILE "AppData\Local\LiquidAgent" }
$NodeVersion = "22.11.0"
$Port = if ($env:LIQUID_AGENT_PORT) { $env:LIQUID_AGENT_PORT } else { "8170" }

function Write-Bold([string]$Text) {
  Write-Host $Text -ForegroundColor White
}

function Write-Step([string]$Text) {
  Write-Host "→ $Text" -ForegroundColor Cyan
}

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

$Arch = if ([System.Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -match "ARM") { "arm64" } else { "x64" }
} else {
  Fail "Liquid Agent requires a 64-bit operating system."
}

Write-Bold "Installing Liquid Agent on Windows ($Arch)"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "bin"), (Join-Path $Data "logs") | Out-Null

# ---- Node.js detection or download ----
function Find-Node {
  $privateNode = Join-Path $Root "node\node.exe"
  if (Test-Path $privateNode) { return $privateNode }

  $systemNode = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
  if ($systemNode -and (Test-Path $systemNode)) {
    try {
      $ver = & $systemNode -p 'process.versions.node.split(".")[0]'
      if ([int]$ver -ge 22) { return $systemNode }
    } catch {}
  }
  return $null
}

$Node = Find-Node
if (-not $Node) {
  Write-Step "Getting Node.js $NodeVersion for Windows"
  $zipFile = "node-v$NodeVersion-win-$Arch.zip"
  $url = "https://nodejs.org/dist/v$NodeVersion/$zipFile"
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  $zipPath = Join-Path $tempDir $zipFile

  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  $nodeTarget = Join-Path $Root "node"
  Remove-Item -Recurse -Force $nodeTarget -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $nodeTarget | Out-Null

  # Windows 10/11 includes tar.exe with zip support
  tar.exe -xf $zipPath -C $nodeTarget --strip-components 1
  Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue

  $Node = Join-Path $nodeTarget "node.exe"
  if (-not (Test-Path $Node)) { Fail "Failed to extract Node.js." }
}

$nodeDir = Split-Path $Node -Parent
$env:Path = "$nodeDir;$env:Path"
Write-Step "Using Node.js $(& $Node -v)"

# ---- Stop running copy if any ----
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 -ErrorAction SilentlyContinue
  if ($health.app -eq "liquid-agent") {
    Write-Step "Stopping the running Liquid Agent"
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*server*index.js*" } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
  }
} catch {}

# ---- Download or copy app ----
Write-Step "Downloading Liquid Agent"
$tempAppDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tempAppDir | Out-Null

if ($env:LIQUID_AGENT_BUNDLE) {
  Copy-Item -Path $env:LIQUID_AGENT_BUNDLE -Destination (Join-Path $tempAppDir "app.tar.gz") -Force
} else {
  $latestJsonPath = Join-Path $tempAppDir "latest.json"
  Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest/download/latest.json" -OutFile $latestJsonPath -UseBasicParsing
  $latest = Get-Content $latestJsonPath | ConvertFrom-Json
  $tarPath = Join-Path $tempAppDir "app.tar.gz"
  Invoke-WebRequest -Uri $latest.url -OutFile $tarPath -UseBasicParsing
}

tar.exe -xzf (Join-Path $tempAppDir "app.tar.gz") -C $tempAppDir
$extractedApp = Join-Path $tempAppDir "liquid-agent"
if (-not (Test-Path (Join-Path $extractedApp "server\index.js"))) {
  Fail "Downloaded package does not look like Liquid Agent."
}

$appDir = Join-Path $Root "app"
Remove-Item -Recurse -Force (Join-Path $Root "app.old") -ErrorAction SilentlyContinue
if (Test-Path $appDir) { Move-Item -Path $appDir -Destination (Join-Path $Root "app.old") -Force }
Move-Item -Path $extractedApp -Destination $appDir -Force
Remove-Item -Recurse -Force $tempAppDir, (Join-Path $Root "app.old") -ErrorAction SilentlyContinue

# ---- Command wrapper ----
$cmdScript = @"
@echo off
set "ROOT=$Root"
set "DATA=$Data"
set "PORT=$Port"
set "PATH=$nodeDir;%PATH%"

if "%~1"=="" goto :open
if "%~1"=="open" goto :open
if "%~1"=="stop" goto :stop
if "%~1"=="update" goto :update
if "%~1"=="logs" goto :logs
echo Use: liquid-agent [open^|stop^|update^|logs]
goto :eof

:open
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { if ((Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 1).app -eq 'liquid-agent') { Start-Process 'http://127.0.0.1:%PORT%'; exit 0 } } catch {}; Start-Process -FilePath '$Node' -ArgumentList @('%ROOT%\\app\\server\\index.js', '--open') -WindowStyle Hidden"
goto :eof

:stop
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -like '*server*index.js*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }; Write-Output 'Stopped.'"
goto :eof

:update
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/$Repo/$Branch/install.ps1 | iex"
goto :eof

:logs
powershell.exe -NoProfile -Command "Get-Content '%DATA%\\logs\\server.log' -Tail 80"
goto :eof
"@

Set-Content -Path (Join-Path $Root "bin\liquid-agent.cmd") -Value $cmdScript -Encoding Ascii

# Add to user PATH if missing
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
$binDir = Join-Path $Root "bin"
if ($userPath -notlike "*$binDir*") {
  [System.Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
}

# Create Start Menu shortcut
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
if (Test-Path $startMenuDir) {
  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut((Join-Path $startMenuDir "Liquid Agent.lnk"))
  $shortcut.TargetPath = Join-Path $Root "bin\liquid-agent.cmd"
  $shortcut.Arguments = "open"
  $shortcut.Description = "Liquid Agent"
  $shortcut.Save()
}

Write-Bold "Liquid Agent is installed."
Write-Host "Run 'liquid-agent' from any prompt, or start it from your Start Menu."

if (-not $env:LIQUID_AGENT_NO_OPEN) {
  Write-Step "Opening Liquid Agent"
  & (Join-Path $Root "bin\liquid-agent.cmd") open
}
