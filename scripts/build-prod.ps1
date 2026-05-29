#Requires -Version 5.1
<#
.SYNOPSIS
    Production build: Next.js static export → apps/api/public/
#>
param(
    [string]$ApiUrl = 'http://localhost:3000'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent

function Write-Log { param([string]$msg) Write-Host "[$(Get-Date -f 'HH:mm:ss')] $msg" }

Write-Log "=== Production build STO ERP ==="

# 1. Build Next.js static export
Write-Log "Збірка Next.js (static export)..."
Set-Location "$Root\apps\web"
$env:NODE_ENV = 'production'
$env:NEXT_PUBLIC_API_URL = $ApiUrl
& pnpm exec next build
if ($LASTEXITCODE -ne 0) { throw "Next.js build failed" }

# 2. Copy out/ → apps/api/public/
$outDir    = "$Root\apps\web\out"
$publicDir = "$Root\apps\api\public"

Write-Log "Копіювання static export → apps/api/public/..."
if (Test-Path $publicDir) { Remove-Item $publicDir -Recurse -Force }
Copy-Item $outDir $publicDir -Recurse

Write-Log "=== Збірка завершена: $publicDir ==="
