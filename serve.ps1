# Serves the Car Shows app at http://localhost:5175 (localhost is required for browser geolocation).
# Only the files listed in $routes are ever served, so nothing else on disk can be requested.
# Nothing is logged: no IP addresses, no URLs, no request details.
$port = 5175
$root = $PSScriptRoot
$routes = @{
  '/'            = @('index.html', 'text/html; charset=utf-8')
  '/privacy'     = @('index.html', 'text/html; charset=utf-8')   # public privacy policy page
  '/terms'       = @('index.html', 'text/html; charset=utf-8')   # public terms page
  '/privacy.md'  = @('PRIVACY.md', 'text/markdown; charset=utf-8')
  '/terms.md'    = @('TERMS.md', 'text/markdown; charset=utf-8')
  '/fonts/inter-latin-wght-normal.woff2' = @('fonts\inter-latin-wght-normal.woff2', 'font/woff2')
  '/vendor/maplibre-gl.js'  = @('vendor\maplibre-gl.js', 'text/javascript; charset=utf-8')
  '/vendor/maplibre-gl.css' = @('vendor\maplibre-gl.css', 'text/css; charset=utf-8')
  '/events.json'  = @('events.json', 'application/json; charset=utf-8')   # real events, written by the updater (pull it in GitHub Desktop)
}
# Event photos: each .jpg directly inside img\events gets a route, and nothing else in that folder does
Get-ChildItem (Join-Path $root 'img\events') -Filter *.jpg -File -ErrorAction SilentlyContinue | ForEach-Object {
  $routes['/img/events/' + $_.Name] = @(('img\events\' + $_.Name), 'image/jpeg')
}
# Smaller copies of the same photos, for the cards
Get-ChildItem (Join-Path $root 'img\events\sm') -Filter *.jpg -File -ErrorAction SilentlyContinue | ForEach-Object {
  $routes['/img/events/sm/' + $_.Name] = @(('img\events\sm\' + $_.Name), 'image/jpeg')
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Car Shows running at http://localhost:$port  (Ctrl+C to stop)"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $p = $ctx.Request.Url.AbsolutePath
    if ($p.Length -gt 1) { $p = $p.TrimEnd('/') }
    if ($p -eq '/__version') {
      # Development only: when index.html was last saved, so open pages can reload themselves after a change
      $bytes = [Text.Encoding]::ASCII.GetBytes([string](Get-Item (Join-Path $root 'index.html')).LastWriteTimeUtc.Ticks)
      $ctx.Response.ContentType = 'text/plain'; $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.ContentLength64 = $bytes.Length; $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } elseif ($routes.ContainsKey($p)) {
      $file = Join-Path $root $routes[$p][0]
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ctx.Response.ContentType = $routes[$p][1]
      # Photos, the font and the map library never change between edits, so the browser keeps them; the page itself is always fresh
      $ctx.Response.Headers.Add('Cache-Control', $(if ($p -match '^/(img|fonts|vendor)/') { 'public, max-age=604800' } else { 'no-store' }))
      $ctx.Response.Headers.Add('X-Content-Type-Options', 'nosniff')
      $ctx.Response.Headers.Add('Referrer-Policy', 'no-referrer')
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
