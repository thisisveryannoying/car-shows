# Serves the Car Shows app to phones on your home Wi-Fi, for testing with touch.
# Open the address it prints on a phone joined to the same Wi-Fi. Press Ctrl+C (or close the window) to stop.
# Same rules as serve.ps1: only the files listed in $routes are ever served, and nothing is logged.
# It uses a plain TCP listener, so it needs no administrator setup. Windows may ask once whether to let
# PowerShell accept connections on private networks; allow it for "Private networks" only.
# Over plain http on a phone, "Use my location" is unavailable (browsers only allow it on https or localhost);
# typing a postcode works.
$port = 5176
$root = $PSScriptRoot
$routes = @{
  '/'            = @('index.html', 'text/html; charset=utf-8')
  '/privacy'     = @('index.html', 'text/html; charset=utf-8')
  '/terms'       = @('index.html', 'text/html; charset=utf-8')
  '/privacy.md'  = @('PRIVACY.md', 'text/markdown; charset=utf-8')
  '/terms.md'    = @('TERMS.md', 'text/markdown; charset=utf-8')
  '/fonts/inter-latin-wght-normal.woff2' = @('fonts\inter-latin-wght-normal.woff2', 'font/woff2')
  '/vendor/maplibre-gl.js'  = @('vendor\maplibre-gl.js', 'text/javascript; charset=utf-8')
  '/vendor/maplibre-gl.css' = @('vendor\maplibre-gl.css', 'text/css; charset=utf-8')
}
Get-ChildItem (Join-Path $root 'img\events') -Filter *.jpg -File -ErrorAction SilentlyContinue | ForEach-Object {
  $routes['/img/events/' + $_.Name] = @(('img\events\' + $_.Name), 'image/jpeg')
}
Get-ChildItem (Join-Path $root 'img\events\sm') -Filter *.jpg -File -ErrorAction SilentlyContinue | ForEach-Object {
  $routes['/img/events/sm/' + $_.Name] = @(('img\events\sm\' + $_.Name), 'image/jpeg')
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
$listener.Start()
Write-Host "Car Shows for your phone: http://${ip}:$port   (same Wi-Fi only; Ctrl+C to stop)"

function Send([System.Net.Sockets.NetworkStream]$s, [int]$code, [string]$text, [string]$type, [byte[]]$body, [string]$cache = 'no-store') {
  $head = "HTTP/1.1 $code $text`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: $cache`r`n" +
          "X-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`nConnection: close`r`n`r`n"
  $h = [Text.Encoding]::ASCII.GetBytes($head)
  $s.Write($h, 0, $h.Length); if ($body.Length) { $s.Write($body, 0, $body.Length) }
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 5000; $client.SendTimeout = 15000
    $s = $client.GetStream()
    $reader = New-Object IO.StreamReader($s, [Text.Encoding]::ASCII, $false, 8192, $true)
    $line = $reader.ReadLine()
    while ($true) { $h = $reader.ReadLine(); if ($null -eq $h -or $h -eq '') { break } }   # skip the headers
    $parts = "$line" -split ' '
    if ($parts.Count -lt 2 -or $parts[0] -ne 'GET') { Send $s 405 'Method Not Allowed' 'text/plain' ([byte[]]@()); continue }
    $p = [Uri]::UnescapeDataString(($parts[1] -split '\?')[0])
    if ($p.Length -gt 1) { $p = $p.TrimEnd('/') }
    # No /__version here on purpose: the phone keeps the version it loaded until you refresh it yourself,
    # so you can keep testing while new changes are being made. (The PC link still reloads itself.)
    if ($routes.ContainsKey($p)) {
      $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root $routes[$p][0]))
      # Photos, the font and the map library never change between edits, so the phone keeps them; the page itself is always fresh
      Send $s 200 'OK' $routes[$p][1] $bytes $(if ($p -match '^/(img|fonts|vendor)/') { 'public, max-age=604800' } else { 'no-store' })
    } else {
      Send $s 404 'Not Found' 'text/plain' ([byte[]]@())
    }
  } catch {
    # a dropped or slow connection: nothing to do
  } finally {
    $client.Close()
  }
}
