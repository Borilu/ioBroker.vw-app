$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$jdk = Join-Path $env:TEMP 'vwandroid-build-cache\jdk-17.0.20.1+1'
$classes = Join-Path $root 'build\pairing-tests'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = @(Get-ChildItem (Join-Path $PSScriptRoot 'java') -Recurse -Filter '*.java' | ForEach-Object FullName)
$app = Join-Path $root 'app\src\main\java\de\borilu\wirelessguardian'
$sources += @('PairWindow.java','PairWindowStatus.java','PairDeadline.java','PairPayload.java','PortHostPolicy.java') | ForEach-Object { Join-Path $app $_ }
& (Join-Path $jdk 'bin\javac.exe') -encoding UTF-8 -d $classes $sources
if ($LASTEXITCODE -ne 0) { throw 'Test compile failed' }
& (Join-Path $jdk 'bin\java.exe') -cp $classes de.borilu.wirelessguardian.PairWindowTest
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
