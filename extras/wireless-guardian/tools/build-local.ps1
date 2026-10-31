param(
    [string]$SdkRoot = "$env:TEMP\vwandroid-build-cache\sdk",
    [string]$JavaHome = "$env:TEMP\vwandroid-build-cache\jdk-17.0.20.1+1",
    [string]$SigningRoot = "$env:LOCALAPPDATA\vw-wireless-guardian-signing"
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$gradle = Get-Content (Join-Path $project 'app\build.gradle') -Raw
function Read-Setting([string]$pattern, [string]$name) {
    $m = [regex]::Match($gradle, $pattern)
    if (-not $m.Success) { throw "Cannot read $name from app/build.gradle" }
    return $m.Groups[1].Value
}
$namespace = Read-Setting "namespace\s+'([^']+)'" 'namespace'
$appId = Read-Setting "applicationId\s+'([^']+)'" 'applicationId'
if ($namespace -ne $appId) { throw 'This minimal builder requires namespace and applicationId to match.' }
$compile = Read-Setting 'compileSdk\s+(\d+)' 'compileSdk'
$minimum = Read-Setting 'minSdk\s+(\d+)' 'minSdk'
$target = Read-Setting 'targetSdk\s+(\d+)' 'targetSdk'
$versionCode = Read-Setting 'versionCode\s+(\d+)' 'versionCode'
$versionName = Read-Setting "versionName\s+'([^']+)'" 'versionName'
if ($versionName -notmatch '^[0-9A-Za-z.-]+$') { throw 'Unsafe version name.' }
$androidJar = Join-Path $SdkRoot "platforms\android-$compile\android.jar"
$tools = Join-Path $SdkRoot 'build-tools\35.0.0'
$env:JAVA_HOME = $JavaHome
$env:PATH = "$(Join-Path $JavaHome 'bin');$env:PATH"
foreach ($file in @($androidJar, "$tools\aapt2.exe", "$tools\d8.bat", "$tools\zipalign.exe", "$tools\apksigner.bat", "$JavaHome\bin\javac.exe", "$JavaHome\bin\keytool.exe")) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build tool: $file" }
}
function Check-Exit([string]$what) { if ($LASTEXITCODE -ne 0) { throw "$what failed with exit code $LASTEXITCODE" } }

# Android's Gradle plugin normally inserts package and version information in the manifest.
# This local dependency-free builder creates a temporary copy and leaves the source untouched.
$buildRoot = Join-Path $project 'build\local-apk'
$build = Join-Path $buildRoot ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path "$build\classes", "$build\dex", "$build\generated" | Out-Null
[xml]$manifest = Get-Content (Join-Path $project 'app\src\main\AndroidManifest.xml') -Raw
$manifest.manifest.SetAttribute('package', $appId)
$manifest.Save("$build\AndroidManifest.xml")
$aaptArgs = @('link', '-I', $androidJar, '--manifest', "$build\AndroidManifest.xml", '--min-sdk-version', $minimum, '--target-sdk-version', $target, '--version-code', $versionCode, '--version-name', $versionName, '--java', "$build\generated", '-o', "$build\unsigned.apk")
$res = Join-Path $project 'app\src\main\res'
if (Test-Path -LiteralPath $res -PathType Container) {
    & "$tools\aapt2.exe" compile --dir $res -o "$build\resources.zip"
    Check-Exit 'aapt2 compile'
    $aaptArgs += "$build\resources.zip"
}
& "$tools\aapt2.exe" @aaptArgs
Check-Exit 'aapt2 link'
$sources = @(Get-ChildItem (Join-Path $project 'app\src\main\java') -Filter '*.java' -Recurse -File | ForEach-Object { $_.FullName }) + @(Get-ChildItem "$build\generated" -Filter '*.java' -Recurse -File | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw 'No Java sources found.' }
& "$JavaHome\bin\javac.exe" -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d "$build\classes" $sources
Check-Exit 'javac'
$classes = @(Get-ChildItem "$build\classes" -Filter '*.class' -Recurse -File | ForEach-Object { $_.FullName })
& "$tools\d8.bat" --lib $androidJar --min-api $minimum --output "$build\dex" $classes
Check-Exit 'd8'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$build\unsigned.apk", [System.IO.Compression.ZipArchiveMode]::Update)
try {
    Get-ChildItem "$build\dex" -Filter 'classes*.dex' -File | ForEach-Object {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $_.Name) | Out-Null
    }
} finally { $zip.Dispose() }
& "$tools\zipalign.exe" -f 4 "$build\unsigned.apk" "$build\aligned.apk"
Check-Exit 'zipalign'

# Keep the signing key outside the source tree. The password file is encrypted using
# Windows DPAPI for this Windows account, and is never written to command arguments.
if (-not (Test-Path -LiteralPath $SigningRoot -PathType Container)) { throw 'Original signing directory missing; refusing to create a different identity.' }
$key = Join-Path $SigningRoot 'release.jks'
$secret = Join-Path $SigningRoot 'password.dpapi'
$keyExists = Test-Path -LiteralPath $key
$secretExists = Test-Path -LiteralPath $secret
if ($keyExists -ne $secretExists) { throw 'Signing key/password mismatch; recover the missing file from backup.' }
Add-Type -AssemblyName System.Security
if (-not $keyExists) { throw 'Original signing key missing; refusing to create a different identity.' }
$protected = [IO.File]::ReadAllBytes($secret)
$env:VW_GUARDIAN_KEY_PASSWORD = [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
try {
    $apk = Join-Path $buildRoot "wireless-guardian-$versionName.apk"
    & "$tools\apksigner.bat" sign --ks $key --ks-key-alias guardian --ks-pass env:VW_GUARDIAN_KEY_PASSWORD --out $apk "$build\aligned.apk"
    Check-Exit 'signing'
    & "$tools\apksigner.bat" verify --verbose $apk
    Check-Exit 'signature verification'
    & "$tools\aapt.exe" dump badging $apk
    Check-Exit 'manifest verification'
    Get-FileHash -Algorithm SHA256 $apk | Format-List Path, Hash
} finally {
    Remove-Item Env:VW_GUARDIAN_KEY_PASSWORD -ErrorAction SilentlyContinue
}
