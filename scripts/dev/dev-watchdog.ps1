# Сторож dev-середовища STO ERP: тримає живими Docker-стек, API :3000 і web :3001 — після
# перезавантаження ПК, падіння процесу чи «зависання» під навантаженням людині нічого не треба
# піднімати вручну.
#
#   powershell -File scripts/dev/dev-watchdog.ps1            # цикл (так його запускає задача)
#   powershell -File scripts/dev/dev-watchdog.ps1 -Once      # один прохід і вихід
#   powershell -File scripts/dev/dev-watchdog.ps1 -DryRun    # лише показати, що зробив би
#
# Встановлення задачі планувальника — scripts/dev/setup-dev-autostart.ps1.
# Пауза (свідомо зупинили сервери й не хочете, щоб сторож їх повертав): створити файл
#   %LOCALAPPDATA%\sto-erp\dev-watchdog\paused        (прибрати — сторож продовжить)
#
# Що робить кожні -IntervalSec секунд:
#  1. Docker у WSL не відповідає → запускає задачу «STO WSL Docker» (scripts/wsl/); Postgres :5432
#     чи Redis :6379 не слухають, а Docker живий → `docker compose up -d` dev-стеку.
#  2. API / web: порт не слухає -DownLimit перевірок поспіль (≈1 хв — перезапуск `nest --watch` після
#     зміни коду не рахується) → прибирає залишки старого запуску (спостерігач без порту) і запускає
#     `pnpm --filter … dev` без вікна (лог — у теці нижче).
#     API — лише коли вже слухають Postgres і Redis: без бази Nest падає на старті, а `nest --watch`
#     лишається жити без порту.
#  3. Порт слухає, але health-адреса дає 5xx чи мовчить -FailLimit перевірок поспіль → зупиняє
#     дерево процесів сервера (від кореневого pnpm/nest/next, не лише власника порту) і запускає
#     заново. Так лікується, зокрема, «усі сторінки 500» після зіпсованого кешу Tailwind (GOTCHAS
#     2026-10-30) і завислий після сну процес.
#  4. Після запуску сервер має -GraceSec секунд на першу компіляцію — у цей час його не чіпають.
#
# Межі: чіпає ЛИШЕ порти 3000 і 3001. :3002 (Playwright), :3010/:3012 (агенти) — ніколи.
param(
  [int]$IntervalSec = 20,
  [int]$FailLimit = 3,
  [int]$DownLimit = 3,
  [int]$GraceSec = 240,
  [switch]$Once,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stateDir = Join-Path $env:LOCALAPPDATA 'sto-erp\dev-watchdog'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$logFile = Join-Path $stateDir 'watchdog.log'
$pauseFile = Join-Path $stateDir 'paused'
$distro = 'Ubuntu'

$services = @(
  # Signature — командний рядок саме dev-процесу цього сервера (спостерігач `nest --watch`,
  # `next dev -p 3001`, обгортка pnpm): за ним знаходяться залишки, що пережили свій порт.
  # Агенти піднімають свої сервери інакше (`node dist-*/main`, інший -p), тож їх це не зачіпає.
  @{ Name = 'api'; Port = 3000; Health = 'http://127.0.0.1:3000/api/health/live'; Filter = '@sto/api'; NeedsDb = $true
     Signature = 'nest\.js"?\s+start\s+--watch\s*$|--filter @sto/api dev' },
  @{ Name = 'web'; Port = 3001; Health = 'http://127.0.0.1:3001/login/'; Filter = '@sto/web'; NeedsDb = $false
     Signature = 'next"?\s+dev\b.*-p 3001|--filter @sto/web dev' }
)
$state = @{}
foreach ($s in $services) { $state[$s.Name] = @{ Fails = 0; Down = 0; StartedAt = [datetime]::MinValue; RootPid = 0 } }

function Write-Log([string]$msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
  Write-Host $line
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) {
      Move-Item -Force $logFile "$logFile.1"
    }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch {}
}

# Один сторож на користувача: задача з повтором щохвилини плюс ручний запуск не мають змагатись.
$mutex = New-Object System.Threading.Mutex($false, 'Local\STO-ERP-dev-watchdog')
if (-not $DryRun -and -not $mutex.WaitOne(0)) {
  Write-Host 'Сторож уже працює — вихід.'
  exit 0
}

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

# 200–4xx — сервер живий (401/404 теж відповідь); 5xx і тайм-аут — ні.
function Test-Health([string]$url) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Timeout = 60000
    $req.AllowAutoRedirect = $true
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return $code -lt 500
  } catch [System.Net.WebException] {
    $r = $_.Exception.Response
    if ($r) { $code = [int]$r.StatusCode; $r.Close(); return $code -lt 500 }
    return $false
  } catch { return $false }
}

function Test-Docker {
  cmd /c "wsl.exe -d $distro -e docker info >nul 2>&1"
  return $LASTEXITCODE -eq 0
}

# Корінь дерева dev-сервера: від власника порту вгору, поки предок — node/cmd із pnpm, nest чи next
# у командному рядку. Термінал VS Code (bash, powershell) не чіпаємо.
function Get-ServerRoot([int]$procId) {
  $all = @{}
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
    ForEach-Object { $all[[int]$_.ProcessId] = $_ }
  $root = $procId
  $cur = $all[$procId]
  while ($cur) {
    $parent = $all[[int]$cur.ParentProcessId]
    if (-not $parent) { break }
    if ($parent.CommandLine -notmatch 'pnpm|nest|next') { break }
    $root = [int]$parent.ProcessId
    $cur = $parent
  }
  return $root
}

function Stop-Server($svc) {
  $st = $state[$svc.Name]
  $pids = @()
  Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { $pids += (Get-ServerRoot ([int]$_.OwningProcess)) }
  if ($st.RootPid -gt 0) { $pids += $st.RootPid }
  # Залишки без порту: впав лише дочірній сервер, а спостерігач `nest --watch` чи обгортка pnpm живі.
  # Без цього новий запуск змагався б зі старим спостерігачем за порт на першій же зміні коду.
  $repoRe = [regex]::Escape($repo)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match $svc.Signature -and ($_.CommandLine -match $repoRe -or $_.CommandLine -match 'pnpm') } |
    ForEach-Object { $pids += (Get-ServerRoot ([int]$_.ProcessId)) }
  foreach ($p in ($pids | Select-Object -Unique)) {
    if ($DryRun) { Write-Log "[$($svc.Name)] зупинив би дерево PID $p"; continue }
    cmd /c "taskkill /T /F /PID $p >nul 2>&1"
    Write-Log "[$($svc.Name)] зупинено дерево PID $p"
  }
  $st.RootPid = 0
}

function Start-Server($svc) {
  $st = $state[$svc.Name]
  if ($DryRun) { Write-Log "[$($svc.Name)] запустив би pnpm --filter $($svc.Filter) dev"; return }
  $out = Join-Path $stateDir "$($svc.Name).log"
  if (Test-Path $out) { Move-Item -Force $out "$out.prev" -ErrorAction SilentlyContinue }
  $p = Start-Process -FilePath 'cmd.exe' -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
    -ArgumentList "/c pnpm --filter $($svc.Filter) dev > `"$out`" 2>&1"
  $st.RootPid = $p.Id
  $st.StartedAt = Get-Date
  $st.Fails = 0
  Write-Log "[$($svc.Name)] запущено (PID $($p.Id)), лог: $out"
}

function Invoke-Pass {
  if (Test-Path $pauseFile) { return }

  $dbUp = (Test-Port 5432) -and (Test-Port 6379)
  if (-not $dbUp) {
    if (-not (Test-Docker)) {
      Write-Log 'Docker у WSL не відповідає — запускаю задачу «STO WSL Docker»'
      if (-not $DryRun) { Start-ScheduledTask -TaskName 'STO WSL Docker' -ErrorAction SilentlyContinue }
    } else {
      Write-Log 'Postgres / Redis не слухають — docker compose up -d'
      if (-not $DryRun) {
        $wslRepo = (& wsl.exe -d $distro -e wslpath -a ($repo -replace '\\', '/')).Trim()
        cmd /c "wsl.exe -d $distro --cd `"$wslRepo`" -e docker compose -f docker-compose.dev.yml up -d >nul 2>&1"
      }
    }
  }

  foreach ($svc in $services) {
    $st = $state[$svc.Name]
    $inGrace = ((Get-Date) - $st.StartedAt).TotalSeconds -lt $GraceSec

    if (-not (Test-Port $svc.Port)) {
      if ($inGrace) { continue }
      if ($svc.NeedsDb -and -not $dbUp) { continue }
      # `nest --watch` після зміни коду перезбирає й перезапускає сервер — порт зникає на 10–30 с.
      # Діємо лише тоді, коли порт мовчить кілька перевірок поспіль.
      $st.Down++
      if ($st.Down -lt $DownLimit) { continue }
      $st.Down = 0
      Write-Log "[$($svc.Name)] порт $($svc.Port) не слухає"
      Stop-Server $svc   # залишки попереднього запуску (nest --watch без порту)
      Start-Server $svc
      continue
    }

    $st.Down = 0
    if (Test-Health $svc.Health) {
      if ($st.Fails -gt 0) { Write-Log "[$($svc.Name)] знову відповідає" }
      $st.Fails = 0
      continue
    }
    if ($inGrace) { continue }
    $st.Fails++
    Write-Log "[$($svc.Name)] health $($svc.Health) — збій $($st.Fails) з $FailLimit"
    if ($st.Fails -ge $FailLimit) {
      Stop-Server $svc
      Start-Sleep -Seconds 2
      Start-Server $svc
    }
  }
}

Write-Log "Сторож стартував (repo: $repo, інтервал $IntervalSec с$(if ($DryRun) { ', DryRun' }))"
do {
  try { Invoke-Pass } catch { Write-Log "Помилка проходу: $($_.Exception.Message)" }
  if ($Once -or $DryRun) { break }
  Start-Sleep -Seconds $IntervalSec
} while ($true)
