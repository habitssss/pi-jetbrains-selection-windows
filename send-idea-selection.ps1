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

function Copy-WithFallbackNotice {
    param([Parameter(Mandatory = $true)] [string]$Text)

    try {
        Set-Clipboard -Value $Text
    } catch {
        # Clipboard fallback is best-effort only.
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.Popup("Pi 未连接，已复制到剪贴板:`n$Text", 3, "Send IDEA Selection to Pi", 64)
    } catch {
        Write-Host "Pi 未连接，已复制到剪贴板: $Text"
    }
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

$port = 17373
if ($env:PI_IDEA_SELECTION_PORT -match '^\d+$') {
    $port = [int]$env:PI_IDEA_SELECTION_PORT
}

$uri = "http://127.0.0.1:$port/idea-selection"
$payload = @{ text = $text } | ConvertTo-Json -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$body = $utf8NoBom.GetBytes($payload)

try {
    Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 2 | Out-Null
} catch {
    Copy-WithFallbackNotice -Text $text
}
