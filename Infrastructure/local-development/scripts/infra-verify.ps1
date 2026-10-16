# infra-verify.ps1 — full verification matrix for local infrastructure
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File infra-verify.ps1
$ErrorActionPreference = 'Continue'
$root = "E:\AIknotsit-Office-Work\AI-Customer-Support-Platform"
$infra = "$root\Infrastructure\local-development"
$r = @()

# DB password from .env (values never printed)
$envLine = (Get-Content "$root\.env" -Raw) -split "`n" | Where-Object { $_ -match '^DATABASE_URL=' }
$dbPass = ($envLine -replace '.*aicsp:([^@]+)@.*','$1').Trim()
$env:PGPASSWORD = $dbPass

# --- 1. PostgreSQL ---
$ready = & "$infra\bin\pg\bin\pg_isready.exe" -h 127.0.0.1 -p 5432 -t 5 2>&1
$r += "[PG] ready: $ready"
$ver = (& "$infra\bin\pg\bin\psql.exe" -U postgres -h 127.0.0.1 -p 5432 -tAc 'SELECT version();' 2>&1)
$r += "[PG] version: $($ver.Trim())"
$uuid = 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' | & "$infra\bin\pg\bin\psql.exe" -U postgres -h 127.0.0.1 -p 5432 -d ai_csp -v ON_ERROR_STOP=1 2>&1
$r += "[PG] uuid-ossp: $(($uuid | Select-Object -Last 1))"
$vec = 'CREATE EXTENSION IF NOT EXISTS vector;' | & "$infra\bin\pg\bin\psql.exe" -U postgres -h 127.0.0.1 -p 5432 -d ai_csp 2>&1
$r += "[PG] pgvector: $(($vec | Select-Object -First 1))  <-- expected FAIL until Phase 3 (see docs)"
$login = & "$infra\bin\pg\bin\psql.exe" -U aicsp -h 127.0.0.1 -p 5432 -d ai_csp -tAc 'SELECT current_user || ''@'' || current_database();' 2>&1
$r += "[PG] app-role login: $($login.Trim())"
& "$infra\bin\pg\bin\pg_dump.exe" -U postgres -h 127.0.0.1 -p 5432 -Fc -f "$infra\backups\ai_csp_verify.dump" ai_csp 2>&1 | Out-Null
$bk = Get-Item "$infra\backups\ai_csp_verify.dump" -ErrorAction SilentlyContinue
$r += "[PG] backup (pg_dump): $(if ($bk) { 'OK, ' + [math]::Round($bk.Length/1KB,1) + ' KB' } else { 'FAIL' })"

# --- 2. Redis (+ persistence across restart) ---
$pong = & "$infra\bin\redis\redis-cli.exe" ping 2>&1
$r += "[Redis] PING: $pong"
& "$infra\bin\redis\redis-cli.exe" set "infra:verify" "persist-ok" | Out-Null
$oldPid = (Get-Process redis-server -ErrorAction SilentlyContinue).Id
taskkill /F /IM redis-server.exe 2>$null | Out-Null
Start-Sleep -Seconds 2
Start-Process -FilePath "$infra\bin\redis\redis-server.exe" -ArgumentList "--port","6379","--bind","127.0.0.1","--dir","$infra\data\redis","--appendonly","yes","--appendfilename","appendonly.aof" -RedirectStandardOutput "$infra\logs\redis.log" -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3
$persist = & "$infra\bin\redis\redis-cli.exe" get "infra:verify" 2>&1
$r += "[Redis] persistence after restart (AOF): $persist"
$r += "[Redis] exit test: $(& "$infra\bin\redis\redis-cli.exe" --scan --pattern 'infra:*' 2>&1)"

# --- 3. Mailpit (SMTP send + API) ---
try {
    $smtp = New-Object System.Net.Mail.SmtpClient('127.0.0.1',1025)
    $msg = New-Object System.Net.Mail.MailMessage('verify@localhost','check@localhost','Infra verify','final verification message')
    $smtp.Send($msg)
    Start-Sleep -Seconds 2
    $api = (Invoke-WebRequest -Uri 'http://127.0.0.1:8025/api/v1/messages?limit=1' -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
    $r += "[Mailpit] SMTP send OK; API 200; messages stored: $($api.total)"
} catch { $r += "[Mailpit] FAIL: $($_.Exception.Message)" }

# --- 4. SeaweedFS (master + S3 auth + bucket) ---
try {
    $m = (Invoke-WebRequest -Uri 'http://127.0.0.1:9333/cluster/status' -UseBasicParsing -TimeoutSec 10).StatusCode
    $r += "[Seaweed] master: $m"
} catch { $r += "[Seaweed] master FAIL: $($_.Exception.Message)" }
$s3code = (curl.exe -s -o NUL -w "%{http_code}" --max-time 8 "http://127.0.0.1:9000/")
$r += "[Seaweed] S3 anonymous GET /: HTTP $s3code (403 = auth enabled, expected)"
# Signed end-to-end test (bucket create / list / put / get / anon-denied) via SigV4
$s3out = & python "$infra\scripts\s3-verify.py" 2>&1
$r += $s3out | ForEach-Object { "[Seaweed] $_" }

# --- 5. Process/port summary ---
$procs = (Get-Process postgres,redis-server,mailpit,weed -ErrorAction SilentlyContinue | ForEach-Object ProcessName) -join ', '
$r += "[PROC] running: $procs"
foreach ($p in @(5432,6379,1025,8025,9000,9333)) {
    $l = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    $r += "[PORT] ${p}: $(if ($l) { 'LISTENING' } else { 'DOWN' })"
}

# --- 6. Results ---
$r | ForEach-Object { $_ }
$fail = ($r | Where-Object { $_ -match 'FAIL' -and $_ -notmatch 'expected FAIL|until Phase 3' }).Count
"`n=== VERIFY RESULT: $(if ($fail -eq 0) { 'ALL CHECKS PASSED' } else { "$fail FAILURE(S) - see above" }) ==="
