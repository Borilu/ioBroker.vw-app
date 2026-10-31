$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$jdk = Join-Path $env:TEMP 'vwandroid-build-cache\jdk-17.0.20.1+1'
$classes = Join-Path $root 'build\protocol-tests'
$app = Join-Path $root 'app\src\main\java\de\borilu\wirelessguardian'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
$sources = @('PortProtocol.java','PortHostPolicy.java','PortCandidatePolicy.java','RecoveryPolicy.java','RetryPolicy.java','VersionPolicy.java') | ForEach-Object { Join-Path $app $_ }
$sources += @('PortProtocolTest.java','PortHostPolicyTest.java','PortCandidatePolicyTest.java','RecoveryPolicyTest.java','RetryPolicyTest.java','VersionPolicyTest.java','PortInteropServer.java') | ForEach-Object { Join-Path $PSScriptRoot $_ }
& (Join-Path $jdk 'bin\javac.exe') -encoding UTF-8 -d $classes $sources
if ($LASTEXITCODE -ne 0) { throw 'Test compile failed' }
foreach ($name in @('PortProtocolTest','PortHostPolicyTest','PortCandidatePolicyTest','RecoveryPolicyTest','RetryPolicyTest','VersionPolicyTest')) {
    & (Join-Path $jdk 'bin\java.exe') -cp $classes "de.borilu.wirelessguardian.$name"
    if ($LASTEXITCODE -ne 0) { throw "Test failed: $name" }
}
& node (Join-Path $PSScriptRoot 'interop-check.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Java/Node interoperability test failed' }
