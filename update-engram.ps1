<#
.SYNOPSIS
    Script para la actualizacion automatizada y segura de engram.exe.
    
.DESCRIPTION
    Detecta actualizaciones mediante la salida de 'engram version' y la API de GitHub,
    descarga el binario correcto, realiza un backup, detiene procesos activos,
    reemplaza el binario y valida la nueva version. Incluye rollback automatico.

.PARAMETER CheckOnly
    Si se especifica, solo comprueba si hay actualizaciones disponibles y sale.

.PARAMETER TargetVersion
    Version especifica a la que se desea actualizar. Si no se provee, se detecta automaticamente.

.EXAMPLE
    .\update-engram.ps1 -CheckOnly
    .\update-engram.ps1
#>

param (
    [switch]$CheckOnly,
    [string]$TargetVersion
)

$ErrorActionPreference = "Stop"

function Write-Log($Message, $Level = "INFO") {
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$Timestamp] [$Level] $Message"
}

function Get-LatestRelease {
    $RepoUrl = "https://api.github.com/repos/Gentleman-Programming/engram/releases/latest"
    Write-Log "Consultando ultima version en GitHub..."
    try {
        $Release = Invoke-RestMethod -Uri $RepoUrl -Method Get
        return $Release
    } catch {
        throw "Error al consultar la API de GitHub: $($_.Exception.Message)"
    }
}

try {
    $BinaryName = "engram.exe"
    $TargetPath = (Get-Command $BinaryName).Source
    $BackupPath = "$TargetPath.old"
    $TempDir = Join-Path $env:TEMP "engram_update"

    if (-not (Test-Path $TargetPath)) {
        throw "No se encontro el binario de Engram en $TargetPath. Asegurese de ejecutar el script en el directorio raiz del proyecto."
    }

    # 1. Detectar actualizacion disponible
    Write-Log "Comprobando version local..."
    $VersionOutput = ""
    $ErrorActionPreference = "Continue" # Temporalmente para capturar la salida aunque sea error
    $VersionOutput = & $TargetPath version 2>&1 | Out-String
    $ErrorActionPreference = "Stop"
    
    Write-Log "Salida de version actual: $($VersionOutput.Trim())"
    
    # El formato observado es: "Update available: 1.10.4 → 1.12.0" o "Update available: 1.10.4 -> 1.12.0"
    if ($VersionOutput -match 'Update available: ([\d\.]+) .* ([\d\.]+)') {
        $CurrentDetected = $Matches[1]
        $LatestDetected = $Matches[2]
        $HasUpdate = $true
    } else {
        $HasUpdate = $false
    }
    
    if (-not $HasUpdate) {
        Write-Log "Engram ya esta actualizado a la ultima version."
        return
    }

    if ($null -eq $TargetVersion -or $TargetVersion -eq "") {
        $TargetVersion = $LatestDetected
    }

    Write-Log "Actualizacion disponible: $CurrentDetected -> $TargetVersion"

    if ($CheckOnly) {
        Write-Log "Modo -CheckOnly activo. Saliendo."
        return
    }

    # 2. Descargar nueva version
    Write-Log "Iniciando descarga de version $TargetVersion..."
    $Release = Get-LatestRelease
    
    if ($Release.tag_name -notmatch $TargetVersion) {
        Write-Log "Aviso: La version detectada ($TargetVersion) no coincide exactamente con el tag de GitHub ($($Release.tag_name)). Se usara el release mas reciente." -Level "WARN"
    }

    # Filtrar asset para Windows amd64
    $Asset = $Release.assets | Where-Object { $_.name -match "windows_amd64\.zip$" } | Select-Object -First 1
    if (-not $Asset) {
        throw "No se encontro un asset compatible (windows_amd64.zip) en el release $($Release.tag_name)"
    }

    if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
    
    $ZipPath = Join-Path $TempDir "engram.zip"
    Write-Log "Descargando desde: $($Asset.browser_download_url)"
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $ZipPath
    
    Write-Log "Extrayendo archivos..."
    Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force
    
    $NewBinaryPath = Join-Path $TempDir "engram.exe"
    if (-not (Test-Path $NewBinaryPath)) {
        # A veces el binario esta dentro de una carpeta en el zip, buscamos recursivamente
        $FoundBinary = Get-ChildItem -Path $TempDir -Filter "engram.exe" -Recurse | Select-Object -First 1
        if ($FoundBinary) {
            $NewBinaryPath = $FoundBinary.FullName
        } else {
            throw "No se encontro engram.exe dentro del archivo descargado."
        }
    }

    # 3. Detener procesos engram
    Write-Log "Deteniendo procesos de engram activos..."
    $Processes = Get-Process -Name "engram" -ErrorAction SilentlyContinue
    if ($Processes) {
        $Processes | Stop-Process -Force
        Write-Log "Procesos detenidos correctamente."
    }

    # 4. Crear backup
    Write-Log "Creando backup del binario actual..."
    if (Test-Path $BackupPath) { Remove-Item $BackupPath -Force }
    Rename-Item -Path $TargetPath -NewName "$BinaryName.old"
    Write-Log "Backup creado en: $BackupPath"

    # 5. Instalar nuevo binario
    Write-Log "Instalando nueva version..."
    Copy-Item -Path $NewBinaryPath -Destination $TargetPath -Force
    Write-Log "Binario reemplazado."

    # 6. Validar version
    Write-Log "Validando nueva version..."
    $NewVersionOutput = & $TargetPath version 2>&1 | Out-String
    Write-Log "Salida de version: $($NewVersionOutput.Trim())"

    # La validacion es exitosa si ya no muestra "Update available" para la version instalada
    # o si la salida contiene el TargetVersion
    if ($NewVersionOutput -match [regex]::Escape($TargetVersion)) {
        Write-Log "Validacion exitosa. Version $TargetVersion confirmada."
        
        # 7. Limpieza
        if (Test-Path $BackupPath) {
            Remove-Item $BackupPath -Force
            Write-Log "Archivo de backup eliminado."
        }
        if (Test-Path $TempDir) {
            Remove-Item $TempDir -Recurse -Force
            Write-Log "Archivos temporales eliminados."
        }
        
        Write-Log "ACTUALIZACION COMPLETADA CON EXITO."
    } else {
        throw "La validacion de version fallo. La salida no contiene la version esperada $TargetVersion."
    }

} catch {
    Write-Log "ERROR DETECTADO: $($_.Exception.Message)" -Level "ERROR"
    
    # 8. Rollback automatico
    if (Test-Path $BackupPath) {
        Write-Log "Iniciando ROLLBACK automatico..." -Level "WARN"
        if (Test-Path $TargetPath) { Remove-Item $TargetPath -Force }
        Rename-Item -Path $BackupPath -NewName $BinaryName
        Write-Log "Rollback completado. Se restauro la version anterior." -Level "WARN"
    }
    
    if (Test-Path $TempDir) {
        Remove-Item $TempDir -Recurse -Force
    }
    
    exit 1
}
