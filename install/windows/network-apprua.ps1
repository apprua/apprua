<#
  Opens Apprua to the local network, or closes it again. Run by install-apprua.ps1 with administrator rights
  (Windows asks for permission), because it changes two Windows settings:
    - port forwardings: <address of this PC>:80 -> 127.0.0.1:80 and :443 -> 127.0.0.1:443 (https, with your own
      certificate), where WSL already brings the apps of the Linux "Apprua"
    - a firewall rule "Apprua (local network)" that lets the PCs of the local network reach ports 80 and 443: only
      from its own subnet and the private address ranges (offices often have several subnets), and only on private
      and domain networks (never on a public Wi-Fi)
  -Mode local removes both. Only the forwardings Apprua added are removed: their addresses are written in -StateFile
  (network-forwards.txt in the Apprua folder of the user). Plain ASCII on purpose (Windows PowerShell 5.1 reads files as ANSI).
#>
param(
  [Parameter(Mandatory)][ValidateSet('lan', 'local')][string]$Mode,
  [string]$Ip = '',
  [string]$LogFile = '',
  [string]$StateFile = ''
)
$ErrorActionPreference = 'Stop'
$Rule = 'Apprua (local network)'
function Log($t) { if ($LogFile) { Add-Content -Path $LogFile -Value $t -Encoding UTF8 } }

try {
  # The addresses where Apprua added its forwardings. A list written by an older version does not exist: then, once,
  # the forwardings that look like Apprua's (port 80 or 443 of an address of this PC to the same port of 127.0.0.1)
  $ours = @()
  $known = $StateFile -and (Test-Path $StateFile)
  if ($known) { $ours = @(Get-Content $StateFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }) }
  else { $ours = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress }) }
  $lines = (netsh interface portproxy show v4tov4) -split "`r?`n"
  foreach ($l in $lines) {
    $f = ($l.Trim() -split '\s+')
    if ($f.Count -eq 4 -and ($f[1] -eq '80' -or $f[1] -eq '443') -and $f[2] -eq '127.0.0.1' -and $f[3] -eq $f[1] -and $ours -contains $f[0]) {
      netsh interface portproxy delete v4tov4 listenaddress=$($f[0]) listenport=$($f[1]) | Out-Null
      Log "removed forwarding $($f[0]):$($f[1])"
    }
  }
  Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  if ($StateFile) { Remove-Item $StateFile -ErrorAction SilentlyContinue }

  if ($Mode -eq 'lan') {
    if ($Ip -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "not a valid address: '$Ip'" }
    foreach ($port in 80, 443) {
      netsh interface portproxy add v4tov4 listenaddress=$Ip listenport=$port connectaddress=127.0.0.1 connectport=$port | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "could not add the port forwarding for $port" }
    }
    if ($StateFile) { Set-Content -Path $StateFile -Value $Ip -Encoding ASCII }
    New-NetFirewallRule -DisplayName $Rule -Description 'Lets the PCs of the local network open the Apprua apps (added by the Apprua installer).' `
      -Direction Inbound -Protocol TCP -LocalPort 80, 443 -LocalAddress $Ip -RemoteAddress LocalSubnet, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 -Profile Domain, Private -Action Allow | Out-Null
    Log "forwarding $($Ip):80 and :443 -> 127.0.0.1 and firewall rule added (private addresses only)"
  }
  exit 0
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
