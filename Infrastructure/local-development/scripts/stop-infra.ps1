# stop-infra.ps1 — stops local infrastructure (per-user processes; data persists on E:)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File stop-infra.ps1
$ErrorActionPreference = 'Continue'
$infra = Split-Path -Parent $PSScriptRoot

# PostgreSQL: clean stop first (fast mode), fallback to process kill
if (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue) {
    & "$infra\bin\pg\bin\pg_ctl.exe" stop -D "$infra\data\pg" -m fast -W 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    if (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue) {
        taskkill /F /IM postgres.exe 2>$null | Out-Null
        "[WARN] PostgreSQL needed force-kill (will recover on next start)"
    } else { "[OK] PostgreSQL stopped" }
} else { "[OK] PostgreSQL not running" }

foreach ($p in @('redis-server','mailpit','weed')) {
    $proc = Get-Process $p -ErrorAction SilentlyContinue
    if ($proc) { taskkill /F /IM "$p.exe" 2>$null | Out-Null; "[OK] $p stopped" } else { "[OK] $p not running" }
}

"[DONE] stop-infra complete (all data retained under data\)"
