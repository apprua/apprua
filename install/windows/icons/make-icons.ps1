<#
  Rebuilds the Windows icons of Apprua from the lighthouse "A" mark (run by hand when the mark changes):
    apprua.ico           light on (desktop, Start menu, icon next to the clock when Apprua answers)
    apprua-starting.ico  light still off on blue (starting)
    apprua-off.ico       all grey (stopped)
    packages\mcp\icon.png the icon of the Claude Desktop extension (256 px)
  Each .ico holds 16, 20, 24, 32, 40, 48, 64 and 256 px, drawn by Chrome straight from the vector mark
  (crisp at every size), so it needs Google Chrome or Microsoft Edge on this PC.
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Split-Path $here
$browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge is needed to draw the icons.' }

# The mark, same shapes and inks as LOGO in packages/server/src/views.ts (viewBox 0 0 120 120):
# electric blue tile, bone tower (the A), black band, lamp-yellow light
function Mark([string]$tile, [string]$tower, [string]$band, [string]$lamp) {
  # the tower is the letter A of Lilita One (TOWER_A in views.ts)
  $a = 'M520 -2Q433 -2 426 26L393 155L234 155L205 31Q199 0 109 0Q61 0 38 5.5Q15 11 15 14L192 691Q192 699 329 699Q466 699 466 691L639 13Q639 6 593 2Q547 -2 520 -2ZM259 282L364 282L319 489L313 489Z'
  "<rect width='120' height='120' rx='27' fill='$tile'/><path transform='translate(24.68 108) scale(.108 -.108)' d='$a' fill='$tower'/>" +
  "<rect x='42.2' y='27.5' width='35.6' height='5' rx='2.5' fill='$band'/><rect x='46' y='7.5' width='28' height='20' rx='5' fill='$lamp'/>"
}
$variants = @{
  'apprua'          = (Mark '#2234EE' '#F1E9DA' '#121212' '#FFC94D')
  'apprua-starting' = (Mark '#2234EE' '#F1E9DA' '#121212' '#8C8778')
  'apprua-off'      = (Mark '#6E6A62' '#D9D2C4' '#4A463F' '#A39C8E')
}
$sizes = 16, 20, 24, 32, 40, 48, 64, 256
Add-Type -AssemblyName System.Drawing
$tmp = Join-Path $env:TEMP "apprua-icons-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
foreach ($name in $variants.Keys) {
  # one row of all sizes side by side, on a transparent page, then cut out
  $x = 0; $imgs = ''
  foreach ($s in $sizes) { $imgs += "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120' width='$s' height='$s' style='position:absolute;left:${x}px;top:0'>$($variants[$name])</svg>"; $x += $s + 4 }
  $html = Join-Path $tmp "$name.html"
  [IO.File]::WriteAllText($html, "<!doctype html><html><body style='margin:0;background:transparent'>$imgs</body></html>")
  $png = Join-Path $tmp "$name.png"
  Start-Process -FilePath $browser -Wait -ArgumentList @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', "--window-size=$x,256", "--screenshot=$png", "file:///$($html -replace '\\','/')")
  $sheet = [System.Drawing.Image]::FromFile($png)
  $parts = @(); $x = 0
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($sheet, (New-Object System.Drawing.Rectangle 0, 0, $s, $s), (New-Object System.Drawing.Rectangle $x, 0, $s, $s), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    if ($s -ge 256) {
      # 256 px as PNG (the usual way: smaller file)
      $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $parts += , $ms.ToArray()
      # the same image is the icon of the Claude Desktop extension (.mcpb)
      if ($name -eq 'apprua') { [IO.File]::WriteAllBytes((Join-Path (Split-Path (Split-Path $out)) 'packages\mcp\icon.png'), $ms.ToArray()) }
    } else {
      # smaller sizes as classic 32-bit bitmaps: every program can read them (some cannot read PNG frames)
      $ms = New-Object System.IO.MemoryStream; $bw = New-Object System.IO.BinaryWriter $ms
      $maskRow = [int]([math]::Ceiling($s / 32) * 4)
      $bw.Write([uint32]40); $bw.Write([int32]$s); $bw.Write([int32]($s * 2)); $bw.Write([uint16]1); $bw.Write([uint16]32)
      $bw.Write([uint32]0); $bw.Write([uint32]($s * $s * 4 + $maskRow * $s)); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
      for ($py = $s - 1; $py -ge 0; $py--) { for ($px = 0; $px -lt $s; $px++) { $c = $bmp.GetPixel($px, $py); $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A) } }
      $bw.Write((New-Object byte[] ($maskRow * $s)))   # the transparency is in the alpha channel; the mask stays empty
      $bw.Flush(); $parts += , $ms.ToArray()
    }
    $bmp.Dispose(); $x += $s + 4
  }
  $sheet.Dispose()
  # .ico = header + one directory entry per size + the PNG images
  $ico = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter $ico
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $b = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$parts[$i].Length); $w.Write([uint32]$offset); $offset += $parts[$i].Length
  }
  foreach ($p in $parts) { $w.Write($p) }
  $w.Flush(); [IO.File]::WriteAllBytes((Join-Path $out "$name.ico"), $ico.ToArray())
  "$name.ico ($([math]::Round($ico.Length / 1KB)) KB)"
}
Remove-Item $tmp -Recurse -Force
