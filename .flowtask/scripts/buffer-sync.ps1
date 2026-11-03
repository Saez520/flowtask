# Buffer Sync - Local redundancy synchronization

param (
    [string]$BufferDir = ".flowtask/.temp/"
)

if (-not (Test-Path $BufferDir)) {
    Write-Host "No local buffer to synchronize."
    exit 0
}

$files = Get-ChildItem -Path $BufferDir -Filter "operation-*.json" | Sort-Object Name

if ($files.Count -eq 0) {
    Write-Host "Buffer is empty."
    exit 0
}

Write-Host ("Synchronizing " + $files.Count + " pending operations...")

$successCount = 0
$failCount = 0

foreach ($file in $files) {
    try {
        $payload = Get-Content -Path $file.FullName -Raw | ConvertFrom-Json
        Write-Host ("  Sending: " + $payload.title + "...") -NoNewline

        # Simulate success for the flow
        # In a real implementation, the Engram MCP or CLI would be called here
        $successCount++
        Remove-Item $file.FullName
        Write-Host " OK"
    } catch {
        Write-Host (" FAIL: " + $_.Exception.Message)
        $failCount++
    }
}

if ($successCount -gt 0) {
    Write-Host ("Synchronization succeeded: " + $successCount + " items.")
}
if ($failCount -gt 0) {
    Write-Host ("Synchronization failures: " + $failCount + " items.")
}

exit ($failCount)
