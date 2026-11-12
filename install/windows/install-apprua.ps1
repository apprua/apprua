<#
  Apprua for Windows: runs Apprua on this PC inside a hidden Linux (WSL2), with no Docker Desktop.
  Run in PowerShell from the Apprua folder:   powershell -ExecutionPolicy Bypass -File install\windows\install-apprua.ps1

  What it does (safe to run again):
    1. checks Windows and WSL; if WSL is missing it installs it (needs administrator rights and one restart)
    2. creates a dedicated Linux called "Apprua" (Ubuntu 24.04) with systemd
    3. keeps it running in the background: .wslconfig (no automatic shutdown) + a task that starts it at sign-in
    4. runs install.sh inside it (Coolify + Apprua) and opens the portal in the browser
  Memory: by default half of the RAM of this PC (between 4 and 16 GB). Choose it with -MemoryGB 12.
  To change it later (Apprua restarts, apps offline about a minute):   install\windows\install-apprua.ps1 -SetMemoryGB 12
  Full copy of Apprua (apps and data) into a file:   install\windows\install-apprua.ps1 -Backup
  Bring everything back from a copy:   install\windows\install-apprua.ps1 -RestoreFrom <file.tar>
  A forgotten password (a new one is printed once):   install\windows\install-apprua.ps1 -ResetPassword [-Email you@example.com]
  Open the apps to the local network, with a name of your network:   install\windows\install-apprua.ps1 -Network lan -Domain apps.office.lan
  ... and with HTTPS, with your certificate for *.apps.office.lan:   add -Cert C:\certs\cert.pem -CertKey C:\certs\key.pem
  To remove everything (asks for confirmation and offers a copy first):   install\windows\install-apprua.ps1 -Uninstall
  WSL itself and other Linux on this PC are never removed.
#>
param(
  [string]$Distro = 'Apprua',
  [int]$MemoryGB = 0,
  [int]$SetMemoryGB = 0,
  [switch]$Backup,
  [string]$RestoreFrom = '',
  [switch]$Uninstall,
  # A forgotten password: a new one for the only administrator, or for -Email
  [switch]$ResetPassword,
  # Keep the window open at the end (Uninstall from Settings > Apps: the window would close before it can be read)
  [switch]$Wait,
  [string]$Email = '',
  # Where the portal and the apps open: 'local' (only this PC) or 'lan' (the local network). Empty: keep the current choice.
  [ValidateSet('', 'local', 'lan')][string]$Network = '',
  # The local network needs a name your network already knows: apprua.<name> and *.<name> pointing to this PC
  # (set up by whoever manages the network: Apprua never does it). Empty: keep the current one.
  [string]$Domain = '',
  # HTTPS on the local network with your own certificate for *.<name> (PEM files). -Https off goes back to plain http.
  [string]$Cert = '',
  [string]$CertKey = '',
  [ValidateSet('', 'off', 'own')][string]$Https = ''
)
$ErrorActionPreference = 'Stop'
# Messages: Say 'English' 'Italiano' (Italian on an Italian Windows)
$It = (Get-UICulture).TwoLetterISOLanguageName -eq 'it'
function Say($t, $it = $null) { if ($It -and $it) { $t = $it }; Write-Host "`n==> $t" -ForegroundColor Cyan }
function Info($t, $it = $null) { if ($It -and $it) { $t = $it }; Write-Host "    $t" }
# Removing Apprua writes what it shows to %TEMP%\apprua-uninstall.log: if it goes wrong, the reason is there
if ($Uninstall) { try { Start-Transcript -Path (Join-Path $env:TEMP 'apprua-uninstall.log') -Force | Out-Null } catch {} }
# With -Wait (Uninstall from Settings > Apps) the window stays open on an error too, so the message can be read
function Pause-IfWaiting { if ($Wait) { [void](Read-Host $(if ((Get-UICulture).TwoLetterISOLanguageName -eq 'it') { '    Premi Invio per chiudere' } else { '    Press Enter to close' })) } }
function Fail($t) { Write-Host "`nERROR: $t" -ForegroundColor Red; Pause-IfWaiting; exit 1 }
trap { Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red; Pause-IfWaiting; exit 1 }
# Started from inside a packaged app of the Microsoft Store kind (for example an AI app that runs commands for you):
# Windows keeps what such an app writes in AppData in a private copy of its own, so the icons, the start at sign-in
# and "Uninstall" in Settings > Apps would point to files nobody else can see (seen on a test PC). Stop and explain.
# The test is what really happens, not who started the script (Windows Terminal is a Store app too, and is fine): a new
# folder in AppData that shows up inside an app's private copy (Packages\<app>\LocalCache\Local) means files are diverted.
function Test-PrivateAppData {
  $probe = 'apprua-probe-' + [guid]::NewGuid().ToString('N')
  $dir = Join-Path $env:LOCALAPPDATA $probe
  try {
    New-Item -ItemType Directory -Force $dir | Out-Null
    $hit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName "LocalCache\Local\$probe") } | Select-Object -First 1
    if ($hit) { return ($hit.Name -replace '_[a-z0-9]{13}$', '') }
  } catch {} finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
  $null
}
$packaged = Test-PrivateAppData
if ($packaged -and -not $env:APPRUA_ALLOW_PACKAGED) {
  $me = $PSCommandPath
  $args1 = ($PSBoundParameters.GetEnumerator() | ForEach-Object { if ($_.Value -is [switch]) { "-$($_.Key)" } else { "-$($_.Key) `"$($_.Value)`"" } }) -join ' '
  Write-Host ''
  if ((Get-UICulture).TwoLetterISOLanguageName -eq 'it') {
    Write-Host "    Questo installer $([char]0xE8) stato avviato da dentro un'app ($packaged)." -ForegroundColor Yellow
    Write-Host "    Windows tiene i file che quell'app scrive in una copia privata: icone, avvio automatico e"
    Write-Host "    'Disinstalla' in Impostazioni non funzionerebbero. Aprilo da una finestra di PowerShell normale:"
  } else {
    Write-Host "    This installer was started from inside an app ($packaged)." -ForegroundColor Yellow
    Write-Host "    Windows keeps the files such an app writes in a private copy: icons, start at sign-in and"
    Write-Host "    'Uninstall' in Settings would not work. Open it from a normal PowerShell window:"
  }
  Write-Host "    powershell -ExecutionPolicy Bypass -File `"$me`" $args1"
  Pause-IfWaiting
  exit 2
}
$TaskName = 'Apprua - start in background'
$WslConfig = Join-Path $env:USERPROFILE '.wslconfig'
$AppDir = Join-Path $env:LOCALAPPDATA 'Apprua'
$Shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Apprua.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Apprua.lnk')
)
$TrayShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Apprua.lnk'   # icon next to the clock, at sign-in
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Apprua'   # Settings > Apps

function Stop-Tray {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*tray-apprua.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function New-Shortcut([string]$path, [string]$script, [string]$description) {
  try {
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\$script`""
    $lnk.IconLocation = "$AppDir\apprua.ico,0"
    $lnk.WindowStyle = 7   # minimized: no window flashes
    $lnk.Description = $description
    $lnk.Save()
  } catch { Write-Host "    Could not create $path ($($_.Exception.Message))" -ForegroundColor Yellow }
}
$PcMemoryGB = [int][math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)

# With $ErrorActionPreference = 'Stop', Windows PowerShell turns any line WSL writes on its error output (a notice
# while WSL starts or updates) into an error that ends the script at once: here that output is simply ignored
function Get-Distros {
  $ErrorActionPreference = 'Continue'
  (wsl.exe -l -q 2>$null) -replace "`0", '' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }
}

# ------------------------------------------------------------------ Local network (see network-apprua.ps1)
# WSL brings the ports of the Linux only to 127.0.0.1 of Windows. To let the other PCs of the network open the apps,
# Windows forwards port 80 of its network address there, and its firewall lets it in (private networks only).
$NetRule = 'Apprua (local network)'
function Get-LanIp {
  # The address on the office or home network: a network card of the PC (cable or Wi-Fi) before a VPN or a virtual
  # adapter, which can also have a gateway but is not where the other PCs of the network find this one
  $up = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway -and $_.IPv4Address })
  $physical = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object { $_.ifIndex })
  $best = @($up | Where-Object { $physical -contains $_.InterfaceIndex }) + @($up | Where-Object { $physical -notcontains $_.InterfaceIndex })
  if (-not $best.Count) { return $null }
  @($best[0].IPv4Address)[0].IPAddress
}
function Get-LanForward([string]$port = '80') {   # the address where Apprua is open to the network on that port, or nothing
  foreach ($l in ((netsh interface portproxy show v4tov4) -split "`r?`n")) {
    $f = $l.Trim() -split '\s+'
    if ($f.Count -eq 4 -and $f[1] -eq $port -and $f[2] -eq '127.0.0.1' -and $f[3] -eq $port) { return $f[0] }
  }
  $null
}
function Set-LanForward([string]$mode, [string]$ip) {
  $log = Join-Path $env:TEMP 'apprua-network.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  Info $(if ($It) { 'Windows chiede il permesso di amministratore: serve per aprire (o chiudere) le porte 80 e 443 alla rete locale.' }
         else { 'Windows asks for administrator permission: it is needed to open (or close) ports 80 and 443 to the local network.' })
  $ok = $false
  # run as administrator from the user's own folder: a folder where the zip was extracted (e.g. right under C:\) may be
  # writable by other people of this PC, who could change the script before it runs with the administrator's rights
  New-Item -ItemType Directory -Force $AppDir | Out-Null
  $script = Join-Path $AppDir 'network-apprua.ps1'
  if ((Resolve-Path $PSScriptRoot).Path -ne (Resolve-Path $AppDir).Path) { Copy-Item (Join-Path $PSScriptRoot 'network-apprua.ps1') $script -Force }
  try {
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"",
      '-Mode', $mode, '-Ip', $(if ($ip) { $ip } else { 'none' }), '-LogFile', "`"$log`"",
      '-StateFile', "`"$(Join-Path $AppDir 'network-forwards.txt')`"")
    $ok = $p.ExitCode -eq 0
  } catch { Info $(if ($It) { 'Permesso non concesso.' } else { 'Permission not given.' }) }
  if (Test-Path $log) { Get-Content $log | ForEach-Object { Info $_ } }
  $ok
}

# Memory Apprua may use: at least 4 GB, and always at least 4 GB left to Windows.
function Test-Memory([int]$gb) {
  if ($PcMemoryGB -lt 8) {
    Fail $(if ($It) { "Questo PC ha $PcMemoryGB GB di memoria: Apprua ne usa almeno 4 e ne lascia almeno 4 a Windows, quindi serve un PC con almeno 8 GB." }
           else { "This PC has $PcMemoryGB GB of memory: Apprua uses at least 4 and leaves at least 4 to Windows, so a PC with at least 8 GB is needed." })
  }
  if ($gb -lt 4) { Fail $(if ($It) { 'Apprua ha bisogno di almeno 4 GB di memoria.' } else { 'Apprua needs at least 4 GB of memory.' }) }
  if ($gb -gt $PcMemoryGB - 4) {
    Fail $(if ($It) { "Questo PC ha $PcMemoryGB GB di memoria: dai ad Apprua al massimo $($PcMemoryGB - 4) GB, cos$([char]0xEC) a Windows ne restano almeno 4." }
           else { "This PC has $PcMemoryGB GB of RAM: give Apprua at most $($PcMemoryGB - 4) GB, so Windows keeps at least 4 GB." })
  }
}
# Settings Apprua adds to a .wslconfig that already had its own sections: each added line comes right after this mark
$WslMark = '# apprua: next line added by the Apprua installer (removed with Apprua)'
function Merge-WslConfig([string]$text, [hashtable]$want) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in ($text -split "`r?`n")) { $lines.Add($l) }
  while ($lines.Count -and -not $lines[$lines.Count - 1].Trim()) { $lines.RemoveAt($lines.Count - 1) }
  $kept = @()
  foreach ($sec in 'wsl2', 'general') {
    if (-not $want.Contains($sec)) { continue }
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*\[$sec\]\s*$") { $start = $i; break } }
    if ($start -lt 0) {
      $lines.Add(''); $lines.Add($WslMark); $lines.Add("[$sec]"); $start = $lines.Count - 1
    }
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[') { $end = $i; break } }
    $at = $start + 1
    foreach ($key in $want[$sec].Keys) {
      $have = $null
      for ($i = $start + 1; $i -lt $end; $i++) { if ($lines[$i] -match "^\s*$key\s*=\s*(.*)$") { $have = $Matches[1].Trim() } }
      if ($null -ne $have) { $kept += "$key=$have"; continue }
      $lines.Insert($at, $WslMark); $lines.Insert($at + 1, "$key=$($want[$sec][$key])")
      $at += 2; $end += 2
    }
  }
  @{ Text = (($lines -join "`r`n") + "`r`n"); Kept = $kept }
}
# A value for the shell inside the Linux, in single quotes: a folder like C:\Users\D'Angelo stays one piece
function BashQ([string]$s) { "'" + ($s -replace "'", "'\''") + "'" }

if ($SetMemoryGB -gt 0) {
  Say "Giving Apprua $SetMemoryGB GB of memory (this PC has $PcMemoryGB GB)"
  Test-Memory $SetMemoryGB
  $cur = if (Test-Path $WslConfig) { Get-Content $WslConfig -Raw } else { '' }
  $marked = "(?m)(^$([regex]::Escape($WslMark))\r?\nmemory=)\d+GB"
  if ($cur -match '(?ms)# >>> apprua.*?# <<< apprua') { $new = [regex]::Replace($cur, '(?ms)(# >>> apprua.*?^memory=)\d+GB', "`${1}${SetMemoryGB}GB") }
  elseif ($cur -match $marked) { $new = [regex]::Replace($cur, $marked, "`${1}${SetMemoryGB}GB") }
  else { Fail "The memory of WSL is set by you in $WslConfig, not by Apprua. Change the line memory= under [wsl2] by hand, then run: wsl --shutdown" }
  [IO.File]::WriteAllText($WslConfig, $new)   # no BOM
  $others = @(Get-Distros | Where-Object { $_ -ne $Distro })
  if ($others.Count) { Info "Note: the other Linux on this PC restart too ($($others -join ', '))" }
  wsl.exe --shutdown
  wsl.exe -d $Distro -u root -- true
  Say "Done: Apprua is starting again, the apps are back online in about a minute"
  exit 0
}

# ------------------------------------------------------------------ Copies: backup and restore
# A copy is the whole Linux "Apprua" (Coolify, Apprua, apps, their data and code) in one .tar file.
# It goes to a folder of the user profile, not to Documents: Documents is often synced by OneDrive.
$BackupDir = Join-Path $env:USERPROFILE 'Apprua-backups'
function Get-LinuxDiskGB {
  # Size of the Linux disk file: a copy is at most this big
  $key = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath).DistributionName -eq $Distro } | Select-Object -First 1
  if (-not $key) { return 0 }
  $vhd = Join-Path ((Get-ItemProperty $key.PSPath).BasePath -replace '^\\\\\?\\', '') 'ext4.vhdx'
  if (Test-Path $vhd) { [math]::Ceiling((Get-Item $vhd).Length / 1GB) } else { 0 }
}
function Save-Backup {
  $ErrorActionPreference = 'Continue'   # a notice of wsl.exe on its error output must not end the copy (see Get-Distros)
  New-Item -ItemType Directory -Force $BackupDir | Out-Null
  $file = Join-Path $BackupDir ('Apprua-{0:yyyy-MM-dd-HHmm}.tar' -f (Get-Date))
  $need = Get-LinuxDiskGB
  $free = [math]::Floor((Get-Item $BackupDir).PSDrive.Free / 1GB)
  Say "Saving a full copy of Apprua (apps and data)" "Salvo una copia completa di Apprua (app e dati)"
  Info "File: $file"
  Info "Up to $need GB ($free GB free). It takes a few minutes; the apps are offline meanwhile." "Fino a $need GB ($free GB liberi). Ci vuole qualche minuto; intanto le app sono spente."
  if ($need -gt 0 -and $need -ge $free) { Fail "Not enough free space for the copy: free some space on the disk, then run this again." }
  wsl.exe --terminate $Distro | Out-Null
  # What wsl.exe prints ("The operation completed successfully", and a harmless note about sockets) must not end up
  # in the value this function gives back: it is the name of the file (seen on a test PC: "Your copy: Operazione completata. C:\...")
  $out = (wsl.exe --export $Distro $file 2>&1 | Out-String) -replace "`0", ''
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $file)) { Write-Host $out; Fail "The copy could not be saved." }
  Info ('Copy saved ({0:N1} GB)' -f ((Get-Item $file).Length / 1GB)) ('Copia salvata ({0:N1} GB)' -f ((Get-Item $file).Length / 1GB))
  # Its fingerprint next to it, as on a server: -RestoreFrom checks it (a copy damaged or changed is refused)
  $hash = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  [IO.File]::WriteAllText("$file.sha256", "$hash  $(Split-Path $file -Leaf)`n")
  Info "Fingerprint: $file.sha256. The copy holds all the data and the secrets of the apps, not encrypted: keep it where only you can read it." "Impronta: $file.sha256. La copia contiene tutti i dati e i segreti delle app, non cifrati: tienila dove solo tu puoi leggerla."
  return $file
}

if ($Backup) {
  if ((Get-Distros) -notcontains $Distro) { Fail "There is no Linux '$Distro' on this PC." }
  $file = Save-Backup
  wsl.exe -d $Distro -u root -- true   # Apprua starts again
  Say "Done: Apprua is starting again. To bring everything back from this copy one day:"
  Info "install\windows\install-apprua.ps1 -RestoreFrom `"$file`""
  exit 0
}

if ($ResetPassword) {
  # a forgotten password, when Apprua cannot send emails: a new random one, printed once
  if ((Get-Distros) -notcontains $Distro) { Fail "There is no Linux '$Distro' on this PC." }
  $who = if ($Email) { $Email } else { '' }
  wsl.exe -d $Distro -u root -- docker exec apprua node dist/src/cli/admin.js new-password $who
  exit $LASTEXITCODE
}

if ($Uninstall) {
  Say "Removing Apprua from this PC" "Tolgo Apprua da questo PC"
  $file = $null
  if ((Get-Distros) -contains $Distro) {
    $o = [char]0xF2
    Write-Host ''
    Write-Host $(if ($It) { "    ATTENZIONE: si cancella il Linux '$Distro' con TUTTE le tue app e i loro dati. Non si pu$o annullare." }
                 else { "    WARNING: this deletes the Linux '$Distro' with ALL your apps and their data. It cannot be undone." }) -ForegroundColor Yellow
    $q = Read-Host $(if ($It) { '    Salvo prima una copia completa, da cui potrai ripristinare tutto? [S/n]' } else { '    Save a full copy first, to bring everything back one day? [Y/n]' })
    if ($q.Trim() -notmatch '^(n|no)$') { $file = Save-Backup }
    $word = if ($It) { 'ELIMINA' } else { 'DELETE' }
    $typed = Read-Host $(if ($It) { "    Per cancellare Apprua scrivi $word" } else { "    To remove Apprua type $word" })
    if ($typed.Trim().ToUpper() -ne $word) {
      wsl.exe -d $Distro -u root -- true   # on again (the copy had stopped it)
      Say $(if ($It) { 'Non ho cancellato nulla: Apprua resta in funzione.' } else { 'Nothing removed: Apprua stays on.' })
      if ($Wait) { [void](Read-Host $(if ($It) { '    Premi Invio per chiudere' } else { '    Press Enter to close' })) }
      exit 0
    }
  }
  if ((Get-LanForward) -or (Get-LanForward '443')) { if (Set-LanForward 'local' '') { Info 'Ports 80 and 443 closed to the local network again' } }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Stop-Tray
  foreach ($s in $Shortcuts + $TrayShortcut) { Remove-Item $s -ErrorAction SilentlyContinue }
  Info "Apprua icons removed" "Icone di Apprua tolte"
  if ((Get-Distros) -contains $Distro) { wsl.exe --unregister $Distro | Out-Null; Info "Linux '$Distro' removed (apps and data included)" "Linux '$Distro' cancellato (con le app e i loro dati)" }
  Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $UninstallKey -Recurse -ErrorAction SilentlyContinue   # the entry in Settings > Apps
  if (Test-Path $WslConfig) {
    $old = Get-Content $WslConfig -Raw
    $c = [regex]::Replace($old, '(?ms)^# >>> apprua.*?# <<< apprua\r?\n?', '')
    $c = [regex]::Replace($c, "(?m)^$([regex]::Escape($WslMark))\r?\n[^\r\n]*(\r?\n)?", '')   # lines added to the person's own sections
    if ($c -ne $old) {
      if ($c.Trim()) { [IO.File]::WriteAllText($WslConfig, $c) } else { Remove-Item $WslConfig }
      Info ".wslconfig restored" ".wslconfig rimesso com'era"
    }
  }
  Say "Done. WSL and any other Linux on this PC are still there." "Fatto. WSL e gli altri Linux di questo PC restano dove sono."
  if ($file) {
    Info "Your copy: $file" "La tua copia: $file"
    Info "To bring everything back: install\windows\install-apprua.ps1 -RestoreFrom `"$file`"" "Per rimettere tutto com'era, dalla cartella di Apprua: install\windows\install-apprua.ps1 -RestoreFrom `"$file`""
  }
  if ($Wait) { [void](Read-Host $(if ($It) { '    Premi Invio per chiudere' } else { '    Press Enter to close' })) }
  exit 0
}

# ------------------------------------------------------------------ 1. Windows and WSL
Say "Step 1 of 5: checking Windows" "Passo 1 di 5: controllo Windows"
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19041) { Fail "Windows 10 version 2004 (build 19041) or newer is needed; this PC has build $build." }
$cs = Get-CimInstance Win32_ComputerSystem
if (-not $cs.HypervisorPresent) {
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  if (-not $cpu.VirtualizationFirmwareEnabled) { Fail "Virtualization is turned off in the BIOS/UEFI of this PC. Turn it on (Intel VT-x / AMD-V), then run this again." }
}
$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB)
if ($freeGB -lt 15) { Fail "Only $freeGB GB free on C: (at least 15 GB are needed)." }
Info "Windows build $build, $freeGB GB free" "Windows build $build, $freeGB GB liberi"
# The memory is checked here, before anything is downloaded (a PC with too little memory used to stop only after
# creating the Linux)
if ($MemoryGB -le 0) { $MemoryGB = [math]::Max(4, [math]::Min(16, [int][math]::Floor($PcMemoryGB / 2))) }
Test-Memory $MemoryGB

$wslOk = $true
try { wsl.exe --status *> $null; if ($LASTEXITCODE -ne 0) { $wslOk = $false } } catch { $wslOk = $false }
if (-not $wslOk) {
  Say "Installing WSL (Windows Subsystem for Linux)" "Installo WSL (il sottosistema Linux di Windows)"
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Fail $(if ($It) { "WSL non $([char]0xE8) installato. Apri il terminale come amministratore (tasto destro sul menu Start, Terminale (amministratore)) e rilancia questo comando." }
           else { "WSL is not installed. Open the terminal as administrator (right click on the Start menu, Terminal (Admin)) and run this again." })
  }
  $features = 'Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform'
  $featuresOn = -not @($features | Where-Object { (Get-WindowsOptionalFeature -Online -FeatureName $_ -ErrorAction SilentlyContinue).State -ne 'Enabled' }).Count
  if (-not $featuresOn) {
    # 1. The usual way. On some PCs it does nothing and says "run wsl.exe --install" (seen on Windows 11 25H2 over
    #    SSH): then the two Windows features are turned on directly, which is what it would do
    wsl.exe --install --no-distribution
    if ($LASTEXITCODE -ne 0) {
      Info "wsl --install did not work here: turning on the Windows features for WSL directly" "wsl --install qui non ha funzionato: accendo direttamente le funzioni di Windows per WSL"
      foreach ($f in $features) {
        try { Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart -WarningAction SilentlyContinue -ErrorAction Stop | Out-Null }
        catch { Fail "Could not turn on the Windows feature $f ($($_.Exception.Message))." }
      }
    }
    Write-Host $(if ($It) { "`n    Fatto. RIAVVIA il PC, poi rilancia questo comando." } else { "`n    Done. RESTART the PC, then run this again." }) -ForegroundColor Yellow
    if ($Wait) { [void](Read-Host $(if ($It) { '    Premi Invio per chiudere' } else { '    Press Enter to close' })) }
    exit 0
  }
  # 2. After the restart the features are on but the WSL program can still be missing (Windows takes it from the
  #    Store, which can be blocked or need a person signed in): install the official package of Microsoft from GitHub
  Info "The Windows features are on; installing the WSL program" "Le funzioni di Windows sono accese; installo il programma WSL"
  # wsl.exe answering with an error must not stop this script ($ErrorActionPreference is Stop): only its exit code counts
  function Test-Wsl([string]$arg) { $ErrorActionPreference = 'Continue'; & wsl.exe $arg *> $null; return $LASTEXITCODE }
  [void](Test-Wsl '--update')
  if ((Test-Wsl '--status') -ne 0) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $msi = Join-Path $env:TEMP "wsl.$arch.msi"
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $rel = Invoke-RestMethod 'https://api.github.com/repos/microsoft/WSL/releases/latest' -Headers @{ 'User-Agent' = 'apprua-installer' }
      $asset = $rel.assets | Where-Object { $_.name -match "^wsl\..*\.$arch\.msi$" } | Select-Object -First 1
      if (-not $asset) { throw 'no package for this PC in the latest release' }
      $ProgressPreference = 'SilentlyContinue'
      $got = $false
      foreach ($try in 1..4) {   # GitHub sometimes answers 504 on the usual link for a while: the API link too
        foreach ($way in 'api', 'link') {
          try {
            if ($way -eq 'api') { Invoke-WebRequest $asset.url -OutFile $msi -UseBasicParsing -Headers @{ 'Accept' = 'application/octet-stream'; 'User-Agent' = 'apprua-installer' } -ErrorAction Stop }
            else { Invoke-WebRequest $asset.browser_download_url -OutFile $msi -UseBasicParsing -ErrorAction Stop }
            $got = $true; break
          } catch { }
        }
        if ($got) { break }
        Start-Sleep -Seconds 15
      }
      if (-not $got) { throw 'download failed' }
      $sig = Get-AuthenticodeSignature $msi
      if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'the package is not signed by Microsoft' }
      $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
      if ($p.ExitCode -notin 0, 3010) { throw "msiexec exit $($p.ExitCode)" }
    } catch {
      Fail $(if ($It) { "Non sono riuscito a installare il programma WSL ($($_.Exception.Message)). Scaricalo da https://github.com/microsoft/WSL/releases/latest (file wsl...$arch.msi), installalo e rilancia questo comando." }
             else { "Could not install the WSL program ($($_.Exception.Message)). Download it from https://github.com/microsoft/WSL/releases/latest (file wsl...$arch.msi), install it and run this again." })
    } finally { Remove-Item $msi -ErrorAction SilentlyContinue }
    if ((Test-Wsl '--status') -ne 0) { Fail $(if ($It) { "WSL ancora non risponde: riavvia il PC e rilancia questo comando." } else { 'WSL still does not answer: restart the PC and run this again.' }) }
  }
  Info "WSL ready" "WSL pronto"
}

# ------------------------------------------------------------------ The right Windows account
# Apprua belongs to the person signed in to this PC (their folder, icons, start at sign-in). A terminal opened "as
# administrator" with ANOTHER account (common where people have no administrator rights) would put it in that
# account instead. WSL itself is installed above even then; from here on it must be the person's own window.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$atScreen = try { (Get-CimInstance Win32_ComputerSystem).UserName } catch { $null }
if ($atScreen -and $atScreen -ne $me) {
  Fail $(if ($It) { "Questa finestra $([char]0xE8) dell'account $me, ma sul PC $([char]0xE8) aperta la sessione di ${atScreen}: Apprua finirebbe nell'account sbagliato. Chiudi questa finestra e rilancia il comando da una finestra di PowerShell normale (non come amministratore) di $atScreen." }
         else { "This window belongs to the account $me, but $atScreen is signed in to this PC: Apprua would end up in the wrong account. Close this window and run the command again from a normal PowerShell window (not as administrator) of $atScreen." })
}

# ------------------------------------------------------------------ Another Docker on this PC
# All the Linux of WSL share one network: another Docker (Docker Desktop, or Docker inside another Linux) can clash with
# the one of Apprua (same addresses, network rules removed when it stops), and the apps stop answering. Only a warning:
# Apprua is installed anyway, and running this script again repairs the network (see install.sh).
$others = @(Get-Distros | Where-Object { $_ -ne $Distro })
$ErrorActionPreference = 'Continue'   # only a check: a notice of wsl.exe must not stop the installation
$running = @((wsl.exe -l --running -q 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $others -contains $_ })
$clash = @()
if (@($others | Where-Object { $_ -like 'docker-desktop*' }).Count) { $clash += 'Docker Desktop' }
foreach ($d in ($running | Where-Object { $_ -notlike 'docker-desktop*' })) {
  wsl.exe -d $d -u root -- sh -c 'pgrep -x dockerd >/dev/null' 2>$null   # already running: checking does not start anything
  if ($LASTEXITCODE -eq 0) { $clash += "Linux '$d'" }
}
$ErrorActionPreference = 'Stop'
$quiet = @($others | Where-Object { $_ -notlike 'docker-desktop*' -and $running -notcontains $_ })
if ($clash.Count) {
  if ($It) {
    $ce = "c'$([char]0xE8) gi$([char]0xE0)"   # "c'e gia" with accents, keeping this file plain ASCII for Windows PowerShell
    Write-Host "`n    Attenzione: su questo PC $ce un altro Docker ($($clash -join ', '))." -ForegroundColor Yellow
    Write-Host "    I Linux di WSL condividono la stessa rete: due Docker insieme possono togliersi la rete a vicenda" -ForegroundColor Yellow
    Write-Host "    e le app di Apprua smettono di rispondere. Meglio tenere spento l'altro Docker mentre usi Apprua." -ForegroundColor Yellow
    Write-Host "    Se succede, rilancia questo installer: ripara la rete e tiene app e dati." -ForegroundColor Yellow
  } else {
    Write-Host "`n    Warning: this PC already runs another Docker ($($clash -join ', '))." -ForegroundColor Yellow
    Write-Host "    All the Linux of WSL share one network: two Docker engines can break each other's network," -ForegroundColor Yellow
    Write-Host "    and the Apprua apps stop answering. Better keep the other Docker off while you use Apprua." -ForegroundColor Yellow
    Write-Host "    If it happens, run this installer again: it repairs the network and keeps apps and data." -ForegroundColor Yellow
  }
}
if ($quiet.Count) {
  Info $(if ($It) { "Altri Linux su questo PC (spenti): $($quiet -join ', '). Se dentro usano Docker, non accenderli insieme ad Apprua." }
         else { "Other Linux on this PC (off): $($quiet -join ', '). If they use Docker, do not run them together with Apprua." })
}

# ------------------------------------------------------------------ 2. Dedicated Linux
if ($RestoreFrom) {
  # From a copy made with -Backup or -Uninstall: same apps and data; the steps below set up the rest again
  if (-not (Test-Path $RestoreFrom)) { Fail "File not found: $RestoreFrom" }
  if ((Get-Distros) -contains $Distro) { Fail "There is already a Linux '$Distro' on this PC. Remove it first with -Uninstall." }
  Say "Bringing Apprua back from $RestoreFrom (a few minutes)" "Rimetto Apprua com'era dalla copia $RestoreFrom (qualche minuto)"
  # The fingerprint written next to the copy when it was made: a copy damaged or changed since is refused
  $hash = (Get-FileHash -Algorithm SHA256 $RestoreFrom).Hash.ToLower()
  $sumFile = "$((Resolve-Path $RestoreFrom).Path).sha256"
  if (Test-Path $sumFile) {
    $want = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0].ToLower()
    if ($want -ne $hash) { Fail $(if ($It) { "La copia non corrisponde alla sua impronta ($sumFile): $([char]0xE8) danneggiata o cambiata. Non la uso." } else { "The copy does not match its fingerprint ($sumFile): it is damaged or was changed. Not using it." }) }
    Info "The copy matches its fingerprint" "La copia corrisponde alla sua impronta"
  } else {
    Write-Host $(if ($It) { "    Accanto alla copia non c'$([char]0xE8) il file .sha256: non posso controllare che sia integra. Impronta della copia: $hash" }
                 else { "    There is no .sha256 file next to the copy: it cannot be checked. Fingerprint of the copy: $hash" }) -ForegroundColor Yellow
  }
  $linuxDir = Join-Path $AppDir 'linux'
  New-Item -ItemType Directory -Force $linuxDir | Out-Null
  wsl.exe --import $Distro $linuxDir (Resolve-Path $RestoreFrom).Path --version 2
  if ($LASTEXITCODE -ne 0) { Fail "Could not bring back the copy (is it a file made by Apprua?)." }
  Info "Apps and data are back" "App e dati sono tornati"
}
if ((Get-Distros) -notcontains $Distro) {
  Say "Step 2 of 5: creating the Linux '$Distro' (Ubuntu 24.04). It downloads about 400 MB." "Passo 2 di 5: creo il Linux '$Distro' (Ubuntu 24.04), scarica circa 400 MB"
  wsl.exe --install -d Ubuntu-24.04 --name $Distro --no-launch
  if ($LASTEXITCODE -ne 0) { Fail "Could not create the Linux '$Distro' (an older WSL? update it with: wsl --update)" }
  wsl.exe -d $Distro -u root -- true
}
Say "Step 2 of 5: configuring '$Distro'" "Passo 2 di 5: preparo il Linux '$Distro'"
# appendWindowsPath=false: the programs of Windows stay out of this Linux. Otherwise, with Docker Desktop on the PC,
# "docker" inside Linux is the Docker Desktop one, and the engine installer skips installing its own Docker (tried on
# a PC with Docker Desktop: the installation failed at "Pulling images")
$wslConf = "[boot]`nsystemd=true`n`n[user]`ndefault=root`n`n[interop]`nappendWindowsPath=false`n"
wsl.exe -d $Distro -u root -- sh -c "grep -q 'appendWindowsPath=false' /etc/wsl.conf 2>/dev/null || printf '$($wslConf -replace "`n", '\n')' > /etc/wsl.conf"

# ------------------------------------------------------------------ 3. Keep it running
# Without this, Windows stops WSL about 90 seconds after the last terminal closes, and the apps go offline.
$block ="# >>> apprua (added by the Apprua installer; remove this block to undo)`n" +
         "[wsl2]`nmemory=${MemoryGB}GB`nvmIdleTimeout=-1`n`n[general]`ninstanceIdleTimeout=-1`n# <<< apprua`n"
$current = if (Test-Path $WslConfig) { Get-Content $WslConfig -Raw } else { '' }
if ($current -notmatch '# >>> apprua' -and $current -notmatch "(?m)^$([regex]::Escape($WslMark))") {
  if ($current -match '(?m)^\s*\[(wsl2|general)\]') {
    # A .wslconfig of the person with its own [wsl2] or [general]: only the missing settings are added, each under a
    # line that marks it (removed with Apprua); what the person already set stays as it is
    $r = Merge-WslConfig $current @{ 'wsl2' = [ordered]@{ memory = "${MemoryGB}GB"; vmIdleTimeout = '-1' }; 'general' = [ordered]@{ instanceIdleTimeout = '-1' } }
    [IO.File]::WriteAllText($WslConfig, $r.Text)   # no BOM
    Info ".wslconfig updated: only the missing settings were added" ".wslconfig aggiornato: aggiunte solo le impostazioni che mancavano"
    foreach ($k in $r.Kept) {
      Info "Your .wslconfig already sets $k`: left as it is" "Il tuo .wslconfig imposta gi$([char]0xE0) $k`: lasciato com'$([char]0xE8)"
      if ($k -match '^(vmIdleTimeout|instanceIdleTimeout)=(?!-1\s*$)') {
        Write-Host $(if ($It) { "    Attenzione: con $k Windows spegne Apprua quando non lo usi, e le app si fermano. Per tenerle accese metti -1." }
                     else { "    Note: with $k Windows stops Apprua when you do not use it, and the apps go offline. To keep them on, set it to -1." }) -ForegroundColor Yellow
      }
    }
  } else {
    [IO.File]::WriteAllText($WslConfig, ($current + "`n" + $block).TrimStart())   # no BOM
    Info ".wslconfig updated (no automatic shutdown, Apprua can use up to $MemoryGB of the $PcMemoryGB GB of this PC)" ".wslconfig aggiornato (niente spegnimento automatico, Apprua pu$([char]0xF2) usare fino a $MemoryGB dei $PcMemoryGB GB di questo PC)"
  }
}
wsl.exe --terminate $Distro | Out-Null   # apply wsl.conf (systemd)

$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root -- true"
# The account as Windows knows it (PC\name, DOMAIN\name): $env:USERDOMAIN can be WORKGROUP (for example over SSH)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the Apprua Linux in the background at sign-in, so your apps are online.' -Force | Out-Null
  Info "Starts by itself when you sign in to Windows" "Si avvia quando accedi a Windows"
} catch {
  Write-Host "    Could not create the start-up task ($($_.Exception.Message)). After a restart, open Apprua once from the Start menu or run: wsl -d $Distro -- true" -ForegroundColor Yellow
}

# ------------------------------------------------------------------ 4. Coolify + Apprua inside Linux
Say "Step 3 of 5: installing Apprua inside '$Distro' (5-10 minutes the first time)" "Passo 3 di 5: installo Apprua dentro '$Distro' (5-10 minuti la prima volta, puoi lasciarlo lavorare)"
$src = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# wslpath runs without the Linux shell in between (-e): a folder like C:\Users\D'Angelo would otherwise break it
$wslSrc = ((wsl.exe -d $Distro -u root -e wslpath -a ($src -replace '\\', '/')) -replace "`0", '').Trim()
# Empty folder on the drive that holds the Linux disk: Apprua reads only its free space (Settings page)
$diskDir = Join-Path $env:LOCALAPPDATA 'Apprua\disk-space'
New-Item -ItemType Directory -Force $diskDir | Out-Null
$wslDisk = ((wsl.exe -d $Distro -u root -e wslpath -a ($diskDir -replace '\\', '/')) -replace "`0", '').Trim()
# The DNS servers of this PC (on a company network, the company ones): install.sh tries them when the DNS bridge of WSL does not answer
$hostDns = (@(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway } |
  ForEach-Object { $_.DNSServer.ServerAddresses }) | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -Unique) -join ','
# Where it opens: the choice given now, otherwise the one remembered inside the Linux, otherwise only this PC
function Get-Stored([string]$name) {   # a choice remembered inside the Linux
  ((wsl.exe -d $Distro -u root -- sh -c "grep -E '^$name=' /root/.apprua/apprua.env 2>/dev/null | tail -1 | cut -d= -f2") -replace "`0", '' | Out-String).Trim()
}
$stored = Get-Stored 'APPRUA_NETWORK'
$net = if ($Network) { $Network } elseif ($stored -eq 'lan') { 'lan' } else { 'local' }
$lanIp = Get-LanIp
if ($net -eq 'lan' -and -not $lanIp) { Fail "This PC has no network address (is it connected to a network?): the apps cannot open on the local network." }
# The local network needs a name the network already knows (Apprua no longer uses sslip.io): ask for it before starting
$storedDomain = Get-Stored 'APPRUA_DOMAIN'
if ($net -eq 'lan' -and -not $Domain -and (-not $storedDomain -or $storedDomain -eq 'localhost' -or $storedDomain -like '*.sslip.io')) {
  Write-Host $(if ($It) { "`n    Per aprire le app alla rete locale serve un nome che la tua rete conosce gi$([char]0xE0), per esempio app.tuaazienda.it." }
               else { "`n    To open the apps to the local network you need a name your network already knows, for example apps.example.com." }) -ForegroundColor Yellow
  Write-Host $(if ($It) { "    Chi gestisce la rete crea nel DNS apprua.<nome> e *.<nome> verso l'indirizzo di questo PC ($lanIp). Poi rilancia:" }
               else { "    Whoever manages the network points apprua.<name> and *.<name> to the address of this PC ($lanIp) in the DNS. Then run:" }) -ForegroundColor Yellow
  Write-Host "      powershell -ExecutionPolicy Bypass -File install\windows\install-apprua.ps1 -Network lan -Domain app.tuaazienda.it"
  if ($storedDomain -like '*.sslip.io') {
    Write-Host $(if ($It) { "    (Apprua non usa pi$([char]0xF9) sslip.io. Per tornare a solo questo PC: -Network local)" } else { '    (Apprua no longer uses sslip.io. To go back to this PC only: -Network local)' }) -ForegroundColor Yellow
  }
  if ($Wait) { [void](Read-Host $(if ($It) { '    Premi Invio per chiudere' } else { '    Press Enter to close' })) }
  exit 1
}
if ($Domain -and $net -ne 'lan') { Fail $(if ($It) { '-Domain vale solo con -Network lan.' } else { '-Domain goes with -Network lan.' }) }
if (($Cert -or $CertKey -or $Https) -and $net -ne 'lan') { Fail $(if ($It) { "L'HTTPS con il tuo certificato vale solo con -Network lan." } else { 'HTTPS with your certificate goes with -Network lan.' }) }
$netVars = "APPRUA_NETWORK=$net" + $(if ($lanIp) { " APPRUA_LAN_IP=$lanIp" } else { '' })
if ($Domain) {
  $d = $Domain.Trim().ToLower()
  if ($d -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { Fail $(if ($It) { "'$Domain' non $([char]0xE8) un nome valido: per esempio app.tuaazienda.it" } else { "'$Domain' is not a valid name: for example apps.example.com" }) }
  $netVars += " APPRUA_DOMAIN=$d"
}
if ($Https) { $netVars += " APPRUA_HTTPS=$Https" }
if ($Cert -or $CertKey) {
  # the certificate files, as the Linux sees them (install.sh checks them and keeps a copy)
  foreach ($f in @($Cert, $CertKey)) { if (-not $f -or -not (Test-Path $f -PathType Leaf)) { Fail "Certificate file not found: '$f' (-Cert and -CertKey are both needed)" } }
  $toWsl = { param($p) ((wsl.exe -d $Distro -u root -e wslpath -a (((Resolve-Path $p).Path) -replace '\\', '/')) -replace "`0", '').Trim() }
  $netVars += " APPRUA_CERT=$(BashQ (& $toWsl $Cert)) APPRUA_CERT_KEY=$(BashQ (& $toWsl $CertKey))"
}
wsl.exe -d $Distro -u root -- bash -c "rm -rf /opt/apprua-src && mkdir -p /opt/apprua-src && cd $(BashQ $wslSrc) && tar --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C /opt/apprua-src && APPRUA_WINDOWS=1 APPRUA_LANG=$(if ($It) { 'it' } else { 'en' }) APPRUA_SRC=/opt/apprua-src HOST_MEMORY_GB=$PcMemoryGB HOST_DISK_DIR=$(BashQ $wslDisk) HOST_DNS='$hostDns' $netVars bash /opt/apprua-src/install/install.sh"
if ($LASTEXITCODE -ne 0) { Fail "The installation inside Linux stopped: read the messages above." }

# ------------------------------------------------------------------ 4b. Local network: Windows side
$fwd = Get-LanForward
$fwd443 = Get-LanForward '443'
$ruleOk = [bool](Get-NetFirewallRule -DisplayName $NetRule -ErrorAction SilentlyContinue)
if ($net -eq 'lan') {
  if ($fwd -ne $lanIp -or $fwd443 -ne $lanIp -or -not $ruleOk) {
    Say $(if ($It) { 'Apro Apprua alla rete locale' } else { 'Opening Apprua to the local network' })
    if (-not (Set-LanForward 'lan' $lanIp)) {
      Write-Host $(if ($It) { "    Dentro il Linux la rete locale $([char]0xE8) attiva, ma Windows non ha aperto la porta: gli altri PC non arrivano alle app. Rilancia questo comando e accetta la richiesta di Windows." }
                   else { "    Apprua is set for the local network, but Windows did not open the port: the other PCs cannot reach it. Run this again and accept the Windows request." }) -ForegroundColor Yellow
    }
  }
  $prof = (Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | Select-Object -First 1).NetworkCategory
  if ("$prof" -eq 'Public') {
    Write-Host $(if ($It) { "    Attenzione: Windows considera questa rete 'Pubblica', e su una rete pubblica la porta resta chiusa. Se $([char]0xE8) la rete dell'ufficio o di casa, impostala come 'Privata' (Impostazioni > Rete e Internet)." }
                 else { "    Note: Windows treats this network as 'Public', and on a public network the port stays closed. If it is your office or home network, set it to 'Private' (Settings > Network & Internet)." }) -ForegroundColor Yellow
  }
} elseif ($fwd -or $fwd443 -or $ruleOk) {
  Say $(if ($It) { 'Chiudo Apprua alla rete locale: si apre solo da questo PC' } else { 'Closing Apprua to the local network: it opens only on this PC' })
  [void](Set-LanForward 'local' '')
}

# ------------------------------------------------------------------ 5. Icons: Start menu, desktop, next to the clock
# "Apprua" opens the portal (if the Linux is stopped it starts it first). The icon next to the clock shows
# whether Apprua answers, and starts at every sign-in (it can be turned off in Task Manager > Startup apps).
Say "Step 4 of 5: icons, start with Windows, entry in Settings > Apps" "Passo 4 di 5: icone, avvio con Windows, voce in Impostazioni > App"
Stop-Tray   # an older icon is replaced by the new one
# install-apprua.ps1 and network-apprua.ps1 too: "Uninstall" in Settings > Apps runs this copy, even if the folder
# Apprua was installed from has been deleted since
Copy-Item (Join-Path $PSScriptRoot 'open-apprua.ps1'), (Join-Path $PSScriptRoot 'tray-apprua.ps1'), (Join-Path $PSScriptRoot 'apprua*.ico'),
  (Join-Path $PSScriptRoot 'install-apprua.ps1'), (Join-Path $PSScriptRoot 'network-apprua.ps1') $AppDir -Force
# Settings > Apps: "Apprua", with Uninstall (the same safe removal: it offers a copy first and asks to type a word)
try {
  $ver = try { (Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version } catch { '' }
  New-Item -Path $UninstallKey -Force | Out-Null
  $props = @{
    DisplayName = 'Apprua'; DisplayVersion = $ver; Publisher = 'Apprua'; DisplayIcon = "$AppDir\apprua.ico"
    InstallLocation = $AppDir; URLInfoAbout = 'https://github.com/apprua/apprua'; HelpLink = 'https://github.com/apprua/apprua/blob/main/docs/guida/README.md'
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\install-apprua.ps1`" -Uninstall -Wait"
  }
  foreach ($k in $props.Keys) { New-ItemProperty -Path $UninstallKey -Name $k -Value $props[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $UninstallKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
} catch { Info "Could not add Apprua to Settings > Apps ($($_.Exception.Message))" }
foreach ($s in $Shortcuts) { New-Shortcut $s 'open-apprua.ps1' 'Open Apprua: publish your AI apps' }
New-Shortcut $TrayShortcut 'tray-apprua.ps1' 'Apprua icon next to the clock'
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$AppDir\tray-apprua.ps1`"")
Info "Icon 'Apprua' added to the Start menu, the desktop and next to the clock" "Icona 'Apprua' aggiunta al menu Start, al desktop e vicino all'orologio"

Say "Step 5 of 5: Apprua is ready" "Passo 5 di 5: tutto pronto, Apprua $([char]0xE8) in funzione"
if ($net -eq 'lan') {
  $lanName = Get-Stored 'APPRUA_DOMAIN'
  $scheme = if ((Get-Stored 'APPRUA_HTTPS') -eq 'own') { 'https' } else { 'http' }
  Info "Portal: $scheme`://apprua.$lanName (from every PC of the local network; on this PC also http://localhost:3000)" "Portale: $scheme`://apprua.$lanName (da ogni PC della rete locale; su questo PC anche http://localhost:3000)"
  Info "Apps: $scheme`://<name>.$lanName" "App: $scheme`://<nome>.$lanName"
  Info "In the DNS of the network apprua.$lanName and *.$lanName must point to this PC ($lanIp). To check: Settings > Where the apps open > Check" "Nel DNS della rete apprua.$lanName e *.$lanName devono portare a questo PC ($lanIp). Per controllare: Impostazioni > Da dove si aprono le app > Verifica"
  Info "Better give this PC a fixed address: an IT administrator can do it." "Meglio dare a questo PC un indirizzo fisso: chi gestisce la rete pu$([char]0xF2) farlo."
} else {
  Info "Portal: http://localhost:3000   Apps: http://<name>.localhost (only this PC)" "Portale: http://localhost:3000   App: http://<nome>.localhost (solo da questo PC)"
  Info "To let the other PCs of the network open them (with a name of your network): install\windows\install-apprua.ps1 -Network lan -Domain <name>" "Per aprirle anche agli altri PC della rete (con un nome della tua rete): install\windows\install-apprua.ps1 -Network lan -Domain <nome>"
}
Info "Next time, open it from the 'Apprua' icon on the desktop or in the Start menu" "La prossima volta aprilo dall'icona 'Apprua' sul desktop o nel menu Start"

# What a person who is not an expert should know (also in the guide: docs/guida/pc.md, "Da sapere")
Write-Host ''
Write-Host $(if ($It) { '    DA SAPERE' } else { '    GOOD TO KNOW' }) -ForegroundColor Yellow
$know = if ($It) { @(
  "Le tue app vivono in un Linux nascosto di Windows chiamato '$Distro' (WSL). Se togli WSL da Windows, o cancelli quel Linux, si cancellano anche tutte le app e i loro dati.",
  'A PC spento le app sono spente: si riaccendono da sole quando accedi a Windows.',
  'Ogni tanto fai una copia di sicurezza, dalla cartella di Apprua: install\windows\install-apprua.ps1 -Backup',
  'Per togliere Apprua: Impostazioni > App > Apprua > Disinstalla (prima ti propone una copia).',
  'Guida e aiuto: https://github.com/apprua/apprua/blob/main/docs/guida/README.md'
) } else { @(
  "Your apps live in a hidden Linux of Windows called '$Distro' (WSL). If you remove WSL from Windows, or delete that Linux, all the apps and their data are deleted too.",
  'When the PC is off, the apps are off: they start again by themselves when you sign in to Windows.',
  'Make a copy now and then, from the Apprua folder: install\windows\install-apprua.ps1 -Backup',
  'To remove Apprua: Settings > Apps > Apprua > Uninstall (it offers a copy first).',
  'Guide and help: https://github.com/apprua/apprua/blob/main/docs/guide/README.md'
) }
foreach ($k in $know) { Write-Host "    - $k" -ForegroundColor Yellow }
Write-Host ''
Info 'The first-run setup opens in your browser now. If you close it, open the Apprua icon: it starts again where you left it.' "Ora si apre nel browser la prima configurazione. Se la chiudi, apri l'icona Apprua: riparte dal punto in cui eri."
# No browser to open (for example over SSH): Apprua is ready anyway, the address is written above
try { Start-Process 'http://localhost:3000' } catch { Info 'Open http://localhost:3000 in the browser.' 'Apri http://localhost:3000 nel browser.' }
