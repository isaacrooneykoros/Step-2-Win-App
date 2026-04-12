param(
  [switch]$SkipBuild,
  [switch]$SkipCapRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = 'C:\Users\Admin\PycharmProjects\Final Steps'
$webDir = Join-Path $repoRoot 'step2win-web'
$backendDir = Join-Path $repoRoot 'backend'

Write-Host '=== Step2Win Android Debug Checklist Runner ===' -ForegroundColor Cyan
Write-Host "Repo: $repoRoot"

Set-Location $repoRoot
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
  Write-Warning "Current branch is '$branch' (expected 'main'). Continuing anyway."
} else {
  Write-Host 'Branch check: main' -ForegroundColor Green
}

Write-Host '1) Backend health check' -ForegroundColor Yellow
$healthOk = $false
try {
  $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:8000/api/health/' -TimeoutSec 5
  if ($health.status -eq 'ok') {
    Write-Host '   Backend reachable at http://127.0.0.1:8000/api/health/' -ForegroundColor Green
    $healthOk = $true
  }
} catch {
  Write-Warning '   Backend health endpoint not reachable on localhost:8000. If using remote backend, ensure VITE_API_BASE_URL is set.'
}

Write-Host '2) Web app build + Capacitor sync' -ForegroundColor Yellow
Set-Location $webDir
if (-not $SkipBuild) {
  npm run build
} else {
  Write-Host '   Skipping build (--SkipBuild).' -ForegroundColor DarkYellow
}
npx cap sync android

Write-Host '3) Android debug run' -ForegroundColor Yellow
if (-not $SkipCapRun) {
  npx cap run android
} else {
  Write-Host '   Skipping npx cap run android (--SkipCapRun).' -ForegroundColor DarkYellow
  Write-Host '   Open Android Studio manually with: npx cap open android'
}

Write-Host ''
Write-Host '=== Completed ===' -ForegroundColor Cyan
if (-not $healthOk) {
  Write-Host 'Reminder: Backend health was not confirmed on localhost. Verify your backend URL before login tests.' -ForegroundColor Yellow
}
