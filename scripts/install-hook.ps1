[CmdletBinding()]
param(
    [string]$RepoPath = (Get-Location).Path,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $RepoPath)) {
    throw "Path does not exist: $RepoPath"
}

$absRepo = (Resolve-Path $RepoPath).Path
Push-Location $absRepo
try {
    $gitDirRel = (& git rev-parse --git-dir 2>$null | Out-String).Trim()
} finally {
    Pop-Location
}
if (-not $gitDirRel) {
    throw "Not a git repository: $absRepo"
}

if ([System.IO.Path]::IsPathRooted($gitDirRel)) {
    $gitDir = $gitDirRel
} else {
    $gitDir = Join-Path -Path $absRepo -ChildPath $gitDirRel
}
$hooksDir = Join-Path -Path $gitDir -ChildPath "hooks"
$hookDest = Join-Path -Path $hooksDir -ChildPath "pre-commit"

if ($Uninstall) {
    if (Test-Path $hookDest) {
        Remove-Item $hookDest -Force
        Write-Host "Removed $hookDest"
    } else {
        Write-Host "No hook to remove at $hookDest"
    }
    return
}

if (-not (Test-Path $hooksDir)) {
    New-Item -ItemType Directory -Path $hooksDir -Force | Out-Null
}

$hookSrc = Join-Path -Path $PSScriptRoot -ChildPath ".."
$hookSrc = Join-Path -Path $hookSrc -ChildPath "hooks"
$hookSrc = Join-Path -Path $hookSrc -ChildPath "pre-commit"
$hookSrc = (Resolve-Path $hookSrc).Path

if (Test-Path $hookDest) {
    Write-Warning "Overwriting existing hook at $hookDest"
}

Copy-Item -Path $hookSrc -Destination $hookDest -Force

Write-Host "Installed Cursor pre-commit hook:"
Write-Host "  repo: $RepoPath"
Write-Host "  hook: $hookDest"
Write-Host ""
Write-Host "Bypass for one commit:  git commit --no-verify"
Write-Host "Uninstall:              $PSCommandPath -RepoPath '$RepoPath' -Uninstall"
