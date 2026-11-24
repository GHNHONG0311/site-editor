# Installs or updates Site Editor (local version) on Windows.
# Run in PowerShell:  irm https://raw.githubusercontent.com/GHNHONG0311/site-editor/site-editor/apps/local/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$base = 'https://raw.githubusercontent.com/GHNHONG0311/site-editor/site-editor/apps/local'
$dir = Join-Path $env:USERPROFILE 'site-editor-app'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is not installed. Please install the LTS version from https://nodejs.org , then run this again.' -ForegroundColor Red
    Start-Process 'https://nodejs.org'
    return
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'Git is not installed. Opening folders works without it, but downloading from GitHub needs it: https://git-scm.com/download/win' -ForegroundColor Yellow
}

$files = @('server.js', 'package.json', 'start.bat', 'lib/source-edit.js', 'lib/site-runner.js',
           'lib/locate.js', 'lib/markup.js', 'lib/target.js', 'lib/data-lists.js', 'lib/css-vars.js',
           'public/index.html', 'public/app.js', 'public/style.css', 'public/inject.js')
foreach ($f in $files) {
    $target = Join-Path $dir $f
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$f" -OutFile $target
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Site Editor.lnk'))
$link.TargetPath = Join-Path $dir 'start.bat'
$link.WorkingDirectory = $dir
$link.Save()

New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE 'site-editor-sites') | Out-Null
Write-Host 'Done. Double-click "Site Editor" on your desktop to start.' -ForegroundColor Green
