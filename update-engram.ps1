<#
.SYNOPSIS
    Script para la actualizacion segura de engram.exe a la version v1.12.0.
    
.DESCRIPTION
    Realiza un backup del binario actual, detiene procesos activos,
    reemplaza el binario y valida la nueva version. Incluye rollback automatico.

.PARAMETER NewBinaryPath
    Ruta al nuevo binario de engram.exe proporcionado por el usuario.

.PARAMETER TargetVersion
    Version esperada tras la actualizacion (default: 1.12.0).

.EXAMPLE
    .\update-engram.ps1 -NewBinaryPath "C:\Downloads\engram_new.exe"
#>

param (
    [Parameter(Mandatory=$true)]
    [string]$NewBinaryPath,

    [string]$TargetVersion = "1.12.0"
)

$ErrorActionPreference = "Stop"

function Write-Log($Message, $Level = "INFO") {
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$Timestamp] [$Level] $Message"
}

try {
    # 1. Verificar existencia del nuevo binario
    if (-not (Test-Path $NewBinaryPath)) {
        throw "El nuevo binario no existe en la ruta: $NewBinaryPath"
    }

    $BinaryName = "engram.exe"
    $TargetPath = Join-Path (Get-Location) $BinaryName
    $BackupPath = "$TargetPath.old"

    # 2. Reportar version actual
    Write-Log "Iniciando proceso de actualizacion de Engram..."
    if (Test-Path $TargetPath) {
        try {
            $CurrentVersion = & $TargetPath version 2>&1 | Out-String
            Write-Log "Version actual detectada: $($CurrentVersion.Trim())"
        } catch {
            Write-Log "No se pudo obtener la version del binario actual, pero se continuara con el backup." -Level "WARN"
        }
    } else {
        Write-Log "No se encontro un binario previo en $TargetPath. Se procedera con instalacion limpia."
    }

    # 3. Detener procesos engram
    Write-Log "Deteniendo procesos de engram activas..."
    $Processes = Get-Process -Name "engram" -ErrorAction SilentlyContinue
    if ($Processes) {
        $Processes | Stop-Process -Force
        Write-Log "Procesos detenidos correctamente."
    } else {
        Write-Log "No hay procesos de engram en ejecucion."
    }

    # 4. Crear backup
    if (Test-Path $TargetPath) {
        Write-Log "Creando backup del binario actual..."
        if (Test-Path $BackupPath) { Remove-Item $BackupPath -Force }
        Rename-Item -Path $TargetPath -NewName "$BinaryName.old"
        Write-Log "Backup creado en: $BackupPath"
    }

    # 5. Copiar nuevo binario
    Write-Log "Instalando nueva version..."
    Copy-Item -Path $NewBinaryPath -Destination $TargetPath -Force
    Write-Log "Binario reemplazado."

    # 6. Validar version
    Write-Log "Validando nueva version (esperada: $TargetVersion)..."
    $NewVersionOutput = & $TargetPath version 2>&1 | Out-String
    Write-Log "Salida de version: $($NewVersionOutput.Trim())"

    if ($NewVersionOutput -match $TargetVersion) {
        # 8. Exito: Limpieza
        Write-Log "Validacion exitosa. Version $TargetVersion confirmada."
        if (Test-Path $BackupPath) {
            Remove-Item $BackupPath -Force
            Write-Log "Archivo de backup eliminado."
        }
        Write-Log "ACTUALIZACION COMPLETADA CON EXITO."
    } else {
        throw "La validacion de version fallo. Salida obtenida: $NewVersionOutput"
    }

} catch {
    Write-Log "ERROR DETECTADO: $($_.Exception.Message)" -Level "ERROR"
    
    # 7. Rollback automatico
    if (Test-Path $BackupPath) {
        Write-Log "Iniciando ROLLBACK automatico..." -Level "WARN"
        if (Test-Path $TargetPath) { Remove-Item $TargetPath -Force }
        Rename-Item -Path $BackupPath -NewName $BinaryName
        Write-Log "Rollback completado. Se restauro la version anterior." -Level "WARN"
    } else {
        Write-Log "No se pudo realizar rollback porque no existe backup (.old)." -Level "ERROR"
    }
    
    exit 1
}
