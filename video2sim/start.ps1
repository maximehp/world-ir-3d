# Launch both Video2Sim 3D backend (FastAPI) and frontend (Vite)
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting Video2Sim 3D Backend on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
$backend = Start-Process -FilePath "$Root\backend\.venv\Scripts\uvicorn.exe" `
    -ArgumentList "main:app", "--host", "127.0.0.1", "--port", "8000", "--reload" `
    -WorkingDirectory "$Root\backend" `
    -PassThru

Write-Host "Starting Video2Sim 3D Frontend on http://localhost:5173 ..." -ForegroundColor Green
Write-Host "Open http://localhost:5173 in your browser. Press Ctrl+C to stop." -ForegroundColor Yellow

try {
    Push-Location "$Root\frontend"
    npm run dev
} finally {
    Pop-Location
    if ($backend -and -not $backend.HasExited) {
        Stop-Process -Id $backend.Id -Force
    }
}
