<#
  Apprua icon next to the clock: shows whether Apprua answers, opens the portal, stops, starts and restarts it.
  Blue = on. Grey = starting or stopped. Click: open the portal. Right click: menu.
  Started at sign-in by a shortcut in the Startup folder (the installer creates it). Only one runs at a time.
  First version, as a PowerShell script: a small signed program will replace it with the graphical installer.
#>
param([string]$Distro = 'Apprua', [string]$Url = 'http://localhost:3000')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# Texts stay ASCII in this file (accents as [char] codes): Windows PowerShell 5.1 reads files without a BOM as ANSI.

$mutex = New-Object System.Threading.Mutex($false, 'Local\AppruaTrayIcon')
if (-not $mutex.WaitOne(0)) { exit 0 }   # already running

$e = [char]0xE8
$T = if ((Get-UICulture).TwoLetterISOLanguageName -eq 'it') {
  @{ open = 'Apri Apprua'; restart = 'Riavvia Apprua'; stop = 'Arresta Apprua'; start = 'Avvia Apprua'; quit = 'Chiudi questa icona'
     on = 'Apprua: in funzione'; starting = 'Apprua: in avvio'; off = 'Apprua: in pausa'
     ready = 'Tutto pronto'; readyText = 'Le tue app sono di nuovo online.'
     stopped = 'Apprua in pausa'; stoppedText = 'Le app sono offline. Per riaccendere: clic sull''icona.'
     confirmRestart = "Riavviare Apprua?`n`nLe app restano offline per circa un minuto."
     confirmStop = "Arrestare Apprua?`n`nLe app vanno offline e la memoria torna a Windows.`nRiparte con un clic sull'icona"
     confirmStopAuto = ', o da solo al prossimo accesso a Windows'
     quitText = "L'icona si chiude, ma Apprua resta com'$e.`nTorna al prossimo accesso a Windows."
     auto = 'Avvia Apprua con Windows'
     autoOnTitle = 'Avvio automatico acceso'; autoOn = "Apprua partir$([char]0xE0) in automatico a ogni accesso a Windows."
     autoOffTitle = 'Avvio automatico spento'; autoOff = "Al prossimo accesso Apprua non parte: si accende con un clic sull'icona."
     autoFail = "Non riesco a cambiare l'avvio automatico:" }
} else {
  @{ open = 'Open Apprua'; restart = 'Restart Apprua'; stop = 'Stop Apprua'; start = 'Start Apprua'; quit = 'Close this icon'
     on = 'Apprua: on'; starting = 'Apprua: starting'; off = 'Apprua: stopped'
     ready = 'Apprua is ready'; readyText = 'Your apps are back online.'
     stopped = 'Apprua is stopped'; stoppedText = 'The apps are offline. To turn it on: click the icon.'
     confirmRestart = "Restart Apprua?`n`nThe apps are offline for about a minute."
     confirmStop = "Stop Apprua?`n`nThe apps go offline and the memory goes back to Windows.`nIt starts again with a click on the icon"
     confirmStopAuto = ', or by itself the next time you sign in to Windows'
     quitText = "The icon closes, but Apprua stays as it is.`nIt comes back the next time you sign in to Windows."
     auto = 'Start Apprua with Windows'
     autoOnTitle = 'Automatic start on'; autoOn = 'Apprua will turn on by itself every time you sign in to Windows.'
     autoOffTitle = 'Automatic start off'; autoOff = 'Next time you sign in Apprua stays off: turn it on with a click on the icon.'
     autoFail = 'Could not change the automatic start:' }
}

# The check uses 127.0.0.1: "localhost" may try IPv6 first, which WSL does not forward.
$health = ($Url -replace '://localhost', '://127.0.0.1') + '/healthz'
function Test-Portal {
  try {
    $req = [System.Net.WebRequest]::Create($health); $req.Timeout = 2000
    $res = $req.GetResponse(); $ok = [int]$res.StatusCode -eq 200; $res.Close(); $ok
  } catch { $false }
}
function Get-RunningLinux { @((wsl.exe -l --running -q 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Invoke-Wsl([string[]]$arguments, [switch]$Wait) {
  Start-Process -FilePath 'wsl.exe' -ArgumentList $arguments -WindowStyle Hidden -Wait:$Wait
}

# Icons: the lighthouse tells the state with its light. On: light on. Starting: light still off. Stopped: all grey.
$size = [System.Windows.Forms.SystemInformation]::SmallIconSize
function Get-Icon([string]$name) {
  $p = Join-Path $PSScriptRoot "$name.ico"
  if (Test-Path $p) { New-Object System.Drawing.Icon $p, $size.Width, $size.Height } else { $null }
}
$iconOn = Get-Icon 'apprua'
function New-GreyIcon([System.Drawing.Icon]$icon) {
  $src = $icon.ToBitmap()
  $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height
  [single[][]]$rows = @(@(.3, .3, .3, 0, 0), @(.59, .59, .59, 0, 0), @(.11, .11, .11, 0, 0), @(0, 0, 0, .85, 0), @(.12, .12, .12, 0, 1))
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetColorMatrix((New-Object System.Drawing.Imaging.ColorMatrix -ArgumentList (, $rows)))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $src.Width, $src.Height), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconOff = Get-Icon 'apprua-off'; if (-not $iconOff) { $iconOff = New-GreyIcon $iconOn }   # older installs: grey made here
$iconStarting = Get-Icon 'apprua-starting'; if (-not $iconStarting) { $iconStarting = $iconOff }

[System.Windows.Forms.Application]::EnableVisualStyles()
$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add($T.open)
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miRestart = $menu.Items.Add($T.restart)
$miPower = $menu.Items.Add($T.stop)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miAuto = $menu.Items.Add($T.auto)
$miQuit = $menu.Items.Add($T.quit)

# "Start Apprua with Windows": the task the installer created to start the Linux at sign-in.
# Turned off, Apprua stays off at sign-in; this icon still starts (grey), so it can be turned on with a click.
$TaskName = 'Apprua - start in background'
function Get-AutoStart {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { $task.State -ne 'Disabled' } else { $null }   # $null: no task (installed by hand)
}
$script:auto = Get-AutoStart
$tray.ContextMenuStrip = $menu

$script:state = ''          # on | starting | off
$script:announce = $false   # say "ready" when it comes back after a start or restart from this icon
$timer = New-Object System.Windows.Forms.Timer

function Set-State([string]$s) {
  $script:state = $s
  $tray.Icon = switch ($s) { 'on' { $iconOn } 'starting' { $iconStarting } default { $iconOff } }
  $tray.Text = $T[$s]
  $timer.Interval = if ($s -eq 'starting') { 5000 } else { 30000 }   # check more often while it starts
}
function Update-State {
  $s = if (Test-Portal) { 'on' } elseif ((Get-RunningLinux) -contains $Distro) { 'starting' } else { 'off' }
  if ($s -ne $script:state) {
    Set-State $s
    if ($s -eq 'on' -and $script:announce) { $script:announce = $false; $tray.ShowBalloonTip(5000, $T.ready, $T.readyText, [System.Windows.Forms.ToolTipIcon]::Info) }
  }
}
function Open-Apprua {
  if ($script:state -ne 'on') { $script:announce = $true; Set-State 'starting' }
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSScriptRoot\open-apprua.ps1`"", '-Distro', $Distro, '-Url', $Url)
}
function Start-Apprua {
  $script:announce = $true
  Set-State 'starting'
  Invoke-Wsl @('-d', $Distro, '-u', 'root', '--', 'true')
}
function Stop-Apprua {
  Invoke-Wsl @('--terminate', $Distro) -Wait
  # With no other Linux on, WSL can stop too: then all its memory goes back to Windows
  if (-not (Get-RunningLinux)) { Invoke-Wsl @('--shutdown') -Wait }
  Set-State 'off'
  $tray.ShowBalloonTip(5000, $T.stopped, $T.stoppedText, [System.Windows.Forms.ToolTipIcon]::Info)
}
function Get-Consent([string]$text) {
  [System.Windows.Forms.MessageBox]::Show($text, 'Apprua', 'OKCancel', 'Question') -eq [System.Windows.Forms.DialogResult]::OK
}

# The menu follows the state: "Stop" while it is on or starting, "Start" while it is stopped
$menu.add_Opening({
  $off = $script:state -eq 'off'
  $miPower.Text = if ($off) { $T.start } else { $T.stop }
  $miRestart.Visible = -not $off
  $miAuto.Visible = $null -ne $script:auto
  $miAuto.Checked = [bool]$script:auto
})
$miAuto.add_Click({
  try {
    if ($script:auto) { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
    else { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
    $script:auto = Get-AutoStart
    if ($script:auto) { $tray.ShowBalloonTip(5000, $T.autoOnTitle, $T.autoOn, [System.Windows.Forms.ToolTipIcon]::Info) }
    else { $tray.ShowBalloonTip(5000, $T.autoOffTitle, $T.autoOff, [System.Windows.Forms.ToolTipIcon]::Info) }
  } catch {
    [void][System.Windows.Forms.MessageBox]::Show("$($T.autoFail)`n$($_.Exception.Message)", 'Apprua', 'OK', 'Warning')
  }
})
$tray.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Apprua } })
$miOpen.add_Click({ Open-Apprua })
$miRestart.add_Click({
  if (-not (Get-Consent $T.confirmRestart)) { return }
  Invoke-Wsl @('--terminate', $Distro) -Wait
  Start-Apprua
})
$miPower.add_Click({
  if ($script:state -eq 'off') { Start-Apprua }
  elseif (Get-Consent ($T.confirmStop + $(if ($script:auto) { $T.confirmStopAuto } else { '' }) + '.')) { Stop-Apprua }
})
$miQuit.add_Click({
  [void][System.Windows.Forms.MessageBox]::Show($T.quitText, 'Apprua', 'OK', 'Information')
  $timer.Stop(); $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$timer.add_Tick({ Update-State })

Set-State 'starting'
$tray.Visible = $true
Update-State
$timer.Start()
try { [System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext)) }
finally { $tray.Dispose(); $mutex.ReleaseMutex() }
