# Starts the Antigravity desktop app with a PRIVATE debug port that only this PC can reach.
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File .\start-antigravity.ps1
# To turn the bridge off: close Antigravity and start it normally (Start menu). No port is open then.
param(
  [string]$Exe = '',
  [switch]$ForceClose
)
$ErrorActionPreference = 'Stop'

# 1. Find the app
if (-not $Exe) {
  $roots = @("$env:LOCALAPPDATA\Programs\Antigravity", "$env:LOCALAPPDATA\Programs\Antigravity IDE", "$env:ProgramFiles\Antigravity")
  foreach ($r in $roots) {
    if (Test-Path $r) {
      $hit = Get-ChildItem -Path $r -Filter 'Antigravity*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'unins|update|crash' } | Select-Object -First 1
      if ($hit) { $Exe = $hit.FullName; break }
    }
  }
}
if (-not $Exe -or -not (Test-Path $Exe)) { Write-Host 'Could not find Antigravity.exe. Re-run with:  -Exe "C:\full\path\Antigravity.exe"' -ForegroundColor Red; exit 1 }
Write-Host "App: $Exe"

# 2. The debug flag is ignored if the app is already running, so it must be fully closed first.
$running = Get-Process | Where-Object { $_.Path -and $_.Path -eq $Exe }
if ($running) {
  if ($ForceClose) { $running | Stop-Process -Force; Start-Sleep -Seconds 2 }
  else { Write-Host 'Antigravity is already running. Save your work, close it completely (check the tray), or re-run with -ForceClose.' -ForegroundColor Yellow; exit 1 }
}

# 3. Pick a random free port (49152-65000). A new one every launch.
function Test-FreePort($p) { try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); $true } catch { $false } }
$port = 0
foreach ($i in 1..50) { $c = Get-Random -Minimum 49152 -Maximum 65000; if (Test-FreePort $c) { $port = $c; break } }
if (-not $port) { Write-Host 'No free port found.' -ForegroundColor Red; exit 1 }

# 4. Save the port in a file only your Windows user can read.
$dir = Join-Path $env:USERPROFILE '.agy-bridge'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$portFile = Join-Path $dir 'port'
# Repair any earlier lock-out (you own the folder, so you can always reset it), then allow ONLY your account, by its ID (SID).
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $dir /reset /T /C 2>&1 | Out-Null
& icacls $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { & icacls $dir /reset /T /C 2>&1 | Out-Null; Write-Host 'Note: could not tighten folder permissions; left at your default private permissions.' -ForegroundColor Yellow }
try { Set-Content -Path $portFile -Value $port -NoNewline -ErrorAction Stop } catch { Write-Host 'Note: home-folder port file not written (not needed).' -ForegroundColor Yellow }
# The copy that matters: inside the bridge data folder (the Claude-launched bridge reads this one).
$dataDir = if ($env:AGY_BRIDGE_DIR) { $env:AGY_BRIDGE_DIR } else { Join-Path $env:USERPROFILE '.agy-bridge\data' }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content -Path (Join-Path $dataDir 'port') -Value $port -NoNewline -ErrorAction Stop

# 5. Start the app. NOTE: we deliberately do NOT pass --remote-allow-origins, so web pages cannot connect.
Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$port"
Write-Host "Starting on private port $port ..."

# 6. Safety check: the port must be listening on 127.0.0.1 only. If not, shut it down.
$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($conn) {
    $bad = $conn | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }
    if ($bad) {
      Write-Host "DANGER: port $port is open to the network ($($bad.LocalAddress)). Closing the app." -ForegroundColor Red
      Get-Process | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
      Remove-Item $portFile -ErrorAction SilentlyContinue
      exit 2
    }
    $ok = $true; break
  }
}
if ($ok) { Write-Host "OK: debug port $port is local-only (127.0.0.1). The bridge can connect." -ForegroundColor Green }
else { Write-Host 'The app did not open the debug port. Check that no other Antigravity window was already open.' -ForegroundColor Yellow }
