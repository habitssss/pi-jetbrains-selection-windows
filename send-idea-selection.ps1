param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,

    [string]$SelectionStartLine,
    [string]$SelectionEndLine,
    [string]$LineNumber
)

$ErrorActionPreference = "Stop"

function Get-IdeaRelativePath {
    param(
        [Parameter(Mandatory = $true)] [string]$BaseDir,
        [Parameter(Mandatory = $true)] [string]$TargetPath
    )

    $baseFull = [System.IO.Path]::GetFullPath($BaseDir)
    $targetFull = [System.IO.Path]::GetFullPath($TargetPath)

    if (-not $baseFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $baseFull += [System.IO.Path]::DirectorySeparatorChar
    }

    try {
        $baseUri = [Uri]$baseFull
        $targetUri = [Uri]$targetFull
        $relative = [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString())
    } catch {
        $relative = $targetFull
    }

    return $relative.Replace('\', '/')
}

function Convert-ToNullableInt {
    param([string]$Value)

    if ($Value -match '^\d+$') {
        return [int]$Value
    }

    return $null
}

function Normalize-PathKey {
    param([string]$PathValue)

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return ""
    }

    try {
        $full = [System.IO.Path]::GetFullPath($PathValue)
    } catch {
        $full = $PathValue
    }

    $normalized = $full.Replace('\', '/')
    while ($normalized.Length -gt 1 -and $normalized.EndsWith("/") -and -not ($normalized -match '^[A-Za-z]:/$')) {
        $normalized = $normalized.Substring(0, $normalized.Length - 1)
    }

    return $normalized.ToLowerInvariant()
}

function Get-PiAgentDir {
    $homeDir = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($homeDir)) {
        $homeDir = $HOME
    }

    return Join-Path $homeDir ".pi\agent"
}

function Get-FallbackPort {
    $port = 17373
    if ($env:PI_IDEA_SELECTION_PORT -match '^\d+$') {
        $port = [int]$env:PI_IDEA_SELECTION_PORT
    }
    return $port
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)] [string]$Path)

    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            return $null
        }

        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-JsonProperty {
    param(
        [Parameter(Mandatory = $true)] $Object,
        [Parameter(Mandatory = $true)] [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Copy-WithFallbackNotice {
    param(
        [Parameter(Mandatory = $true)] [string]$Text,
        [string]$Reason = "Pi is not connected"
    )

    try {
        Set-Clipboard -Value $Text
    } catch {
        # Clipboard fallback is best-effort only.
    }

    $message = "${Reason}; copied to clipboard:`n$Text"

    try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.Popup($message, 4, "Send IDEA Selection to Pi", 64)
    } catch {
        Write-Host $message
    }
}

function Test-PiSelectionEndpoint {
    param([Parameter(Mandatory = $true)] [int]$Port)

    try {
        Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Send-ToPiPort {
    param(
        [Parameter(Mandatory = $true)] [int]$Port,
        [Parameter(Mandatory = $true)] [string]$Text
    )

    $uri = "http://127.0.0.1:$Port/idea-selection"
    $payload = @{ text = $Text } | ConvertTo-Json -Compress
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $body = $utf8NoBom.GetBytes($payload)

    try {
        Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-HealthyPiInstances {
    param([Parameter(Mandatory = $true)] [string]$InstancesDir)

    $instances = @()
    if (-not (Test-Path -LiteralPath $InstancesDir)) {
        return $instances
    }

    foreach ($file in @(Get-ChildItem -LiteralPath $InstancesDir -Filter "*.json" -File -ErrorAction SilentlyContinue)) {
        $json = Read-JsonFile -Path $file.FullName
        if ($null -eq $json) {
            continue
        }

        $portValue = Get-JsonProperty -Object $json -Name "port"
        if ($null -eq $portValue) {
            continue
        }

        try {
            $port = [int]$portValue
        } catch {
            continue
        }

        if ($port -le 0 -or $port -ge 65536) {
            continue
        }

        if (-not (Test-PiSelectionEndpoint -Port $port)) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            continue
        }

        $cwdValue = Get-JsonProperty -Object $json -Name "cwd"
        $cwd = if ($null -eq $cwdValue) { "" } else { [string]$cwdValue }
        $cwdKeyValue = Get-JsonProperty -Object $json -Name "cwdKey"
        $cwdKey = if (-not [string]::IsNullOrWhiteSpace($cwd)) {
            Normalize-PathKey -PathValue $cwd
        } elseif ($null -ne $cwdKeyValue -and -not [string]::IsNullOrWhiteSpace([string]$cwdKeyValue)) {
            ([string]$cwdKeyValue).ToLowerInvariant()
        } else {
            ""
        }

        $instanceIdValue = Get-JsonProperty -Object $json -Name "instanceId"
        $instanceId = if ($null -eq $instanceIdValue) { "" } else { [string]$instanceIdValue }
        if ([string]::IsNullOrWhiteSpace($instanceId)) {
            $pidValue = Get-JsonProperty -Object $json -Name "pid"
            if ($null -ne $pidValue) {
                $instanceId = [string]$pidValue
            }
        }

        if ([string]::IsNullOrWhiteSpace($instanceId) -or [string]::IsNullOrWhiteSpace($cwdKey)) {
            continue
        }

        $instances += [pscustomobject]@{
            InstanceId = $instanceId
            Port = $port
            Cwd = $cwd
            CwdKey = $cwdKey
            File = $file.FullName
        }
    }

    return $instances
}

function Get-ActiveTargetInstanceId {
    param(
        [Parameter(Mandatory = $true)] [string]$ActiveTargetsPath,
        [Parameter(Mandatory = $true)] [string]$ProjectKey
    )

    $json = Read-JsonFile -Path $ActiveTargetsPath
    if ($null -eq $json) {
        return $null
    }

    $targets = Get-JsonProperty -Object $json -Name "targets"
    if ($null -eq $targets) {
        return $null
    }

    $targetProperty = $targets.PSObject.Properties[$ProjectKey]
    $target = if ($null -eq $targetProperty) { $null } else { $targetProperty.Value }

    if ($null -eq $target) {
        foreach ($property in $targets.PSObject.Properties) {
            $candidate = $property.Value
            if ($candidate -is [string]) {
                continue
            }

            $candidateCwd = Get-JsonProperty -Object $candidate -Name "cwd"
            if ($null -ne $candidateCwd -and (Normalize-PathKey -PathValue ([string]$candidateCwd)) -eq $ProjectKey) {
                $target = $candidate
                break
            }
        }
    }

    if ($null -eq $target) {
        return $null
    }

    if ($target -is [string]) {
        return [string]$target
    }

    $instanceId = Get-JsonProperty -Object $target -Name "instanceId"
    if ($null -eq $instanceId) {
        return $null
    }

    return [string]$instanceId
}

$relativePath = Get-IdeaRelativePath -BaseDir $ProjectDir -TargetPath $FilePath
$start = Convert-ToNullableInt $SelectionStartLine
$end = Convert-ToNullableInt $SelectionEndLine
$current = Convert-ToNullableInt $LineNumber

if ($null -eq $start -or $null -eq $end) {
    $start = $current
    $end = $current
}

if ($null -ne $start -and $null -ne $end -and $end -lt $start) {
    $tmp = $start
    $start = $end
    $end = $tmp
}

if ($null -eq $start) {
    $text = $relativePath
} elseif ($start -eq $end) {
    $text = "${relativePath}:$start"
} else {
    $text = "${relativePath}:$start-$end"
}

$piAgentDir = Get-PiAgentDir
$registryDir = Join-Path $piAgentDir "idea-selection"
$instancesDir = Join-Path $registryDir "instances"
$activeTargetsPath = Join-Path $registryDir "active-targets.json"
$projectKey = Normalize-PathKey -PathValue $ProjectDir

$healthyInstances = @(Get-HealthyPiInstances -InstancesDir $instancesDir)
$matchingInstances = @($healthyInstances | Where-Object { $_.CwdKey -eq $projectKey })

if ($matchingInstances.Count -eq 1) {
    if (Send-ToPiPort -Port $matchingInstances[0].Port -Text $text) {
        exit 0
    }

    Copy-WithFallbackNotice -Text $text -Reason "The Pi matching the current project is temporarily unavailable"
    exit 0
}

if ($matchingInstances.Count -gt 1) {
    $activeInstanceId = Get-ActiveTargetInstanceId -ActiveTargetsPath $activeTargetsPath -ProjectKey $projectKey
    $activeInstance = $null
    if (-not [string]::IsNullOrWhiteSpace($activeInstanceId)) {
        $activeInstance = $matchingInstances | Where-Object { $_.InstanceId -eq $activeInstanceId } | Select-Object -First 1
    }

    if ($null -ne $activeInstance) {
        if (Send-ToPiPort -Port $activeInstance.Port -Text $text) {
            exit 0
        }

        Copy-WithFallbackNotice -Text $text -Reason "The current project's IDEA selection active target is temporarily unavailable"
        exit 0
    }

    Copy-WithFallbackNotice -Text $text -Reason "Multiple Pi instances match this project; run /idea-target in the target Pi and retry"
    exit 0
}

if ($healthyInstances.Count -gt 0) {
    Copy-WithFallbackNotice -Text $text -Reason "No Pi instance matches the current project"
    exit 0
}

if (Send-ToPiPort -Port (Get-FallbackPort) -Text $text) {
    exit 0
}

Copy-WithFallbackNotice -Text $text
