# start-infra.ps1 — starts local infrastructure (per-user, no services; ADR-011)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File start-infra.ps1
$ErrorActionPreference = 'Continue'
$infra = Split-Path -Parent $PSScriptRoot   # ...\Infrastructure\local-development

function Wait-Port($port, $seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

# --- PostgreSQL ---
# Note: pg_ctl.exe "start" hangs in this host environment (observed 2026-10-16),
# so we launch postgres.exe directly and poll readiness instead.
if (-not (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "$infra\bin\pg\bin\postgres.exe" `
        -ArgumentList "-D","$infra\data\pg","-p","5432","-c","listen_addresses=127.0.0.1" `
        -RedirectStandardOutput "$infra\logs\postgres-out.log" `
        -RedirectStandardError "$infra\logs\postgres-err.log" `
        -WindowStyle Hidden | Out-Null
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        & "$infra\bin\pg\bin\pg_isready.exe" -h 127.0.0.1 -p 5432 -t 2 | Out-Null
        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        Start-Sleep -Seconds 1
    }
    if ($ok) { "[OK] PostgreSQL 17.6 on 127.0.0.1:5432" } else { "[FAIL] PostgreSQL not ready - check logs\postgres-err.log" }
} else { "[OK] PostgreSQL already listening" }

# --- Redis ---
if (-not (Wait-Port 6379 2)) {
    Start-Process -FilePath "$infra\bin\redis\redis-server.exe" `
        -ArgumentList "--port","6379","--bind","127.0.0.1","--dir","$infra\data\redis","--appendonly","yes","--appendfilename","appendonly.aof" `
        -RedirectStandardOutput "$infra\logs\redis.log" -WindowStyle Hidden | Out-Null
    if (Wait-Port 6379 10) { "[OK] Redis on 127.0.0.1:6379 (AOF on)" } else { "[FAIL] Redis - logs\redis.log" }
} else { "[OK] Redis already listening" }

# --- Mailpit (local SMTP catcher) ---
if (-not (Wait-Port 8025 2)) {
    Start-Process -FilePath "$infra\bin\mailpit\mailpit.exe" `
        -ArgumentList "--smtp","127.0.0.1:1025","--listen","127.0.0.1:8025","--database","$infra\data\mailpit\mailpit.db" `
        -RedirectStandardOutput "$infra\logs\mailpit.log" -WindowStyle Hidden | Out-Null
    if (Wait-Port 8025 10) { "[OK] Mailpit SMTP 1025 / UI 8025" } else { "[FAIL] Mailpit - logs\mailpit.log" }
} else { "[OK] Mailpit already listening" }

# --- SeaweedFS (S3-compatible object storage; MinIO substitute, D-15) ---
if (-not (Wait-Port 9000 2)) {
    # Generate s3.config (git-ignored) from .env credentials if missing - no secrets in tracked files
    if (-not (Test-Path "$infra\scripts\s3.config")) {
        $envLines = @{}
        Get-Content (Join-Path (Split-Path -Parent (Split-Path -Parent $infra)) ".env") -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^[A-Z0-9_]+=' } |
            ForEach-Object { $kv = $_ -split '=', 2; $envLines[$kv[0].Trim()] = $kv[1].Trim() }
        $ak = $envLines['S3_ACCESS_KEY']; $sk = $envLines['S3_SECRET_KEY']
        if (-not $ak -or -not $sk) {
            # generate local S3 credentials into .env - never hardcode secrets
            # in tracked files (they would land in git history)
            $envPath = Join-Path (Split-Path -Parent (Split-Path -Parent $infra)) ".env"
            $pool = (97..122) + (48..57)
            $r = -join ($pool | Get-Random -Count 36 | ForEach-Object { [char]$_ })
            $r = $r + (-join ($pool | Get-Random -Count 36 | ForEach-Object { [char]$_ }))
            $ak = 'aicsp' + $r.Substring(0, 10)
            $sk = $r.Substring(10, 40)
            if (Test-Path $envPath) {
                # appended lines win: the .env parser reads keys in order
                Add-Content -Path $envPath -Value "S3_ACCESS_KEY=$ak"
                Add-Content -Path $envPath -Value "S3_SECRET_KEY=$sk"
            }
            $envLines['S3_ACCESS_KEY'] = $ak; $envLines['S3_SECRET_KEY'] = $sk
        }
        $cfg = "{`n  `"identities`": [`n    {`n      `"name`": `"aicsp-local`",`n      `"credentials`": [`n        {`n          `"accessKey`": `"$ak`",`n          `"secretKey`": `"$sk`"`n        }`n      ],`n      `"actions`": [`"Admin`", `"Read`", `"List`", `"Tagging`", `"Write`"]`n    }`n  ]`n}`n"
        Set-Content -Path "$infra\scripts\s3.config" -Value $cfg -Encoding ascii
        "[OK] s3.config generated from .env"
    }
    Start-Process -FilePath "$infra\bin\seaweedfs\weed.exe" `
        -ArgumentList "server","-dir=$infra\data\seaweed","-ip=127.0.0.1","-master.port=9333","-volume.port=8080","-filer.port=8888","-s3","-s3.port=9000","-s3.config=$infra\scripts\s3.config","-master.telemetry=false","-s3.port.iceberg=0" `
        -RedirectStandardOutput "$infra\logs\seaweed.log" -RedirectStandardError "$infra\logs\seaweed.err" -WindowStyle Hidden | Out-Null
    # S3 gateway starts after filer/IAM init (~25s)
    $s3ok = $false
    for ($i = 0; $i -lt 45; $i++) {
        if (Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue) { $s3ok = $true; break }
        Start-Sleep -Seconds 1
    }
    if ($s3ok) { "[OK] SeaweedFS S3 9000 / master 9333 / filer 8888" } else { "[FAIL] SeaweedFS - logs\seaweed.err" }
} else { "[OK] SeaweedFS already listening" }

"[DONE] start-infra complete"
