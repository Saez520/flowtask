# Version Watcher - Engram Infrastructure Monitoring
# CA-005 Implementation

param (
    [string]$SnapshotPath = ".flowtask/.temp/engram-signature.json",
    [switch]$Update
)

function Get-EngramSignature {
    try {
        # Ejecutar engram help y capturar comandos
        $helpOutput = engram help
        
        # Extraer comandos (buscando líneas con indentación y luego el nombre del comando)
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
        Write-Error "Error al obtener firma de Engram: $($_.Exception.Message)"
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
    Write-Host "Snapshot actualizado en $SnapshotPath"
    exit 0
}

$savedSignatureJson = Get-Content -Path $SnapshotPath -Raw
$savedSignature = $savedSignatureJson | ConvertFrom-Json

# Comparar comandos
$newCommands = Compare-Object -ReferenceObject $savedSignature.commands -DifferenceObject $currentSignature.commands | Where-Object { $_.SideIndicator -eq "=>" } | ForEach-Object { $_.InputObject }
$obsoleteCommands = Compare-Object -ReferenceObject $savedSignature.commands -DifferenceObject $currentSignature.commands | Where-Object { $_.SideIndicator -eq "<=" } | ForEach-Object { $_.InputObject }

if ($newCommands -or $obsoleteCommands) {
    Write-Host "[WATCHER: HIGH SEVERITY] Se han detectado cambios en la infraestructura de Engram!"
    if ($newCommands) {
        Write-Host ("  Nuevos comandos: " + ($newCommands -join ', '))
    }
    if ($obsoleteCommands) {
        Write-Host ("  Comandos eliminados/obsoletos: " + ($obsoleteCommands -join ', '))
    }
    Write-Host ("  Hash/Count previo: " + $savedSignature.count + " | Actual: " + $currentSignature.count)
    exit 2 # Código de salida para indicar cambios
} else {
    Write-Host "Verificando infraestructura de Engram... OK"
    exit 0
}
