<#
  Opens the Apprua portal (used by the "Apprua" icon in the Start menu and on the desktop).
  If the hidden Linux is stopped it starts it first, then waits until the portal answers (up to 2 minutes).
  The installer copies this file to %LOCALAPPDATA%\Apprua\.
#>
param([string]$Distro = 'Apprua', [string]$Url = 'http://localhost:3000')

# The check uses 127.0.0.1: "localhost" may try IPv6 first, which WSL does not forward, and time out.
$Health = ($Url -replace '://localhost', '://127.0.0.1') + '/healthz'
function Test-Portal {
  try { (Invoke-WebRequest $Health -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
}

if (-not (Test-Portal)) {
  Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'true') -WindowStyle Hidden -Wait
  for ($i = 0; $i -lt 60 -and -not (Test-Portal); $i++) { Start-Sleep -Seconds 2 }
}
if (Test-Portal) {
  Start-Process $Url
} else {
  $msg = if ((Get-UICulture).TwoLetterISOLanguageName -eq 'it') {
    "Apprua non risponde ancora. Aspetta un minuto e riprova.`n`nSe succede ancora, riavvia il PC: Apprua parte in automatico quando accedi."
  } else {
    "Apprua is not answering yet. Wait a minute and open it again.`n`nIf it keeps happening, restart the PC: Apprua starts by itself when you sign in."
  }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($msg, 'Apprua', 'OK', 'Warning') | Out-Null
}
