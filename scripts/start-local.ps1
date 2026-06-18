$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "Indian Algo — starting dev + worker" -ForegroundColor Cyan
Write-Host "Terminal 1: npm run dev  (http://localhost:3000)"
Write-Host "Terminal 2: npm run worker (FastAPI http://127.0.0.1:8000)"
Write-Host ""

$worker = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "worker" -WorkingDirectory $root -PassThru
Start-Sleep -Seconds 3
$dev = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" -WorkingDirectory $root -PassThru

Write-Host "Worker PID: $($worker.Id) | Dev PID: $($dev.Id)" -ForegroundColor Green
Write-Host "Press ENTER to stop both."
Read-Host | Out-Null

Stop-Process -Id $dev.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue
