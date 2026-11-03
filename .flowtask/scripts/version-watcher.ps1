# Version Watcher - Engram Infrastructure Monitoring

param (
    [string]$SnapshotPath = ".flowtask/.temp/engram-signature.json",
    [switch]$Update
)

function Get-EngramSignature {
    try {
        # Run engram help and capture commands
        $helpOutput = engram help

        # Extract commands (find indented lines and then the command name)
        $commands = $helpOutput | Where-Object { $_ -match "^\s{2}[a-z][a-z-]+" } | ForEach-Object {
            $line = $_.Trim()
            if ($line -match "^([a-z-]+)") {
                $matches[1]
            }
        } | Sort-Object -Unique

        $signature = @{
            timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            commands = $commands
            count = $commands.Count
        }

        return $signature | ConvertTo-Json
    } catch {
        Write-Error "Error getting Engram signature: $($_.Exception.Message)"
        return $null
    }
}

$currentSignatureJson = Get-EngramSignature
if (-not $currentSignatureJson) { exit 1 }
$currentSignature = $currentSignatureJson | ConvertFrom-Json

if (-not (Test-Path $SnapshotPath) -or $Update) {
    if (-not (Test-Path (Split-Path $SnapshotPath))) {
        New-Item -ItemType Directory -Path (Split-Path $SnapshotPath) -Force | Out-Null
    }
    $currentSignatureJson | Out-File -FilePath $SnapshotPath -Encoding utf8
    Write-Host "Snapshot updated at $SnapshotPath"
    exit 0
}

$savedSignatureJson = Get-Content -Path $SnapshotPath -Raw
$savedSignature = $savedSignatureJson | ConvertFrom-Json

# Compare commands
$newCommands = Compare-Object -ReferenceObject $savedSignature.commands -DifferenceObject $currentSignature.commands | Where-Object { $_.SideIndicator -eq "=>" } | ForEach-Object { $_.InputObject }
$obsoleteCommands = Compare-Object -ReferenceObject $savedSignature.commands -DifferenceObject $currentSignature.commands | Where-Object { $_.SideIndicator -eq "<=" } | ForEach-Object { $_.InputObject }

if ($newCommands -or $obsoleteCommands) {
    Write-Host "[WATCHER: HIGH SEVERITY] Changes have been detected in the Engram infrastructure!"
    if ($newCommands) {
        Write-Host ("  New commands: " + ($newCommands -join ', '))
    }
    if ($obsoleteCommands) {
        Write-Host ("  Removed/obsolete commands: " + ($obsoleteCommands -join ', '))
    }
    Write-Host ("  Previous hash/count: " + $savedSignature.count + " | Current: " + $currentSignature.count)
    exit 2 # Exit code to indicate changes
} else {
    Write-Host "Checking Engram infrastructure... OK"
    exit 0
}
