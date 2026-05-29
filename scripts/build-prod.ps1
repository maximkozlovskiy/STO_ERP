#Requires -Version 5.1
<#
.SYNOPSIS
    Production build: Next.js static export → apps/web/out/ (packed by apps/web/Dockerfile into nginx)
#>
param(
    [string]$ApiUrl = 'http://localhost:3000'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# $PSScriptRoot is empty when the script is dot-sourced in a console; fall back to
# the invoked script path so `pwsh -File ./scripts/build-prod.ps1` and dot-sourcing
# both resolve the repo root correctly.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { throw "Не вдалося визначити шлях скрипта (PSScriptRoot/MyInvocation порожні)" }
$Root = Split-Path $scriptDir -Parent

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

Write-Log "=== Production build STO ERP ==="

# Build Next.js static export. The output stays in apps/web/out/ — that is exactly
# what apps/web/Dockerfile copies into the nginx image (`COPY /app/apps/web/out`).
# The API does NOT serve static assets (no @fastify/static / useStaticAssets), so
# we deliberately do NOT copy into apps/api/public — that path is dead weight and
# would mislead the operator into thinking the API self-hosts the frontend.
Write-Log "Збірка Next.js (static export)..."
Set-Location "$Root\apps\web"
$env:NODE_ENV = 'production'
$env:NEXT_PUBLIC_API_URL = $ApiUrl
& pnpm exec next build
if ($LASTEXITCODE -ne 0) { throw "Next.js build failed" }

$outDir = "$Root\apps\web\out"
if (-not (Test-Path $outDir)) { throw "Static export не створено: $outDir" }

Write-Log "=== Збірка завершена: $outDir (пакується apps/web/Dockerfile → nginx) ==="
