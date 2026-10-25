"""Rebuild the adapter's own Android helper; no network or runtime installation.

Requires Python 3.9+, JDK 17 and the pinned official Google R8/D8 JAR.
Only our two implementation classes become DEX inputs. The two Android API
signature placeholders are compile-time classpath entries and never ship in DEX.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile
import zipfile

D8_VERSION = '9.5.28'
D8_SHA256 = '38a9ffaaebbd17d1514e3ecbff5a85b989bb13c551b9e224c7409514eea84ff5'
ROOT = pathlib.Path(__file__).resolve().parent.parent / 'lib' / 'android'
SOURCES = [
    'src/vw/app/bridge/ExtendedUiDumpRunner.java',
    'src/vw/app/bridge/AccessibilityActionRunner.java',
]
STUBS = [
    'compile-only/android/os/Bundle.java',
    'compile-only/com/android/uiautomator/testrunner/UiAutomatorTestRunner.java',
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def zip_entries(destination, entries):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)


def build():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jdk-home', type=pathlib.Path, required=True)
    parser.add_argument('--d8-jar', type=pathlib.Path, required=True)
    args = parser.parse_args()
    jdk = args.jdk_home.resolve()
    d8 = args.d8_jar.resolve()
    if sha(d8.read_bytes()) != D8_SHA256:
        raise RuntimeError('D8 checksum does not match the pinned official artifact.')
    java = jdk / 'bin' / ('java.exe' if (jdk / 'bin' / 'java.exe').exists() else 'java')
    javac = jdk / 'bin' / ('javac.exe' if (jdk / 'bin' / 'javac.exe').exists() else 'javac')
    version = subprocess.run([str(javac), '-version'], capture_output=True, text=True, check=True, timeout=10)
    if not (version.stdout + version.stderr).strip().startswith('javac 17.'):
        raise RuntimeError('This reproducible build requires JDK 17.')
    listed = set(SOURCES + STUBS)
    if {file.relative_to(ROOT).as_posix() for file in ROOT.rglob('*.java')} != listed:
        raise RuntimeError('Unexpected Java source: inspect the source boundary before building.')
    manifest_sources = [{'path': name, 'sha256': sha((ROOT / name).read_bytes())} for name in sorted(listed)]
    with tempfile.TemporaryDirectory(prefix='vw-app-android-build-') as temporary:
        build_dir = pathlib.Path(temporary).resolve()
        if build_dir.parent != pathlib.Path(tempfile.gettempdir()).resolve() or not build_dir.name.startswith('vw-app-android-build-'):
            raise RuntimeError('Unexpected temporary build directory.')
        stubs, classes, dex = [build_dir / name for name in ['stubs', 'classes', 'dex']]
        for folder in [stubs, classes, dex]:
            folder.mkdir()

        def run(command):
            subprocess.run([str(value) for value in command], check=True, timeout=90)

        run([javac, '--release', '8', '-encoding', 'UTF-8', '-g:none', '-d', stubs, *[ROOT / name for name in STUBS]])
        run([javac, '--release', '8', '-encoding', 'UTF-8', '-g:none', '-cp', stubs, '-d', classes, *[ROOT / name for name in SOURCES]])
        class_files = sorted(classes.rglob('*.class'))
        if not class_files or any(not file.relative_to(classes).as_posix().startswith('vw/app/bridge/') for file in class_files):
            raise RuntimeError('Compiler API placeholders must never become DEX inputs.')
        intermediate = build_dir / 'input.jar'
        zip_entries(intermediate, [(file.relative_to(classes).as_posix(), file.read_bytes()) for file in class_files])
        run([java, '-cp', d8, 'com.android.tools.r8.D8', '--release', '--min-api', '30', '--lib', jdk,
             '--classpath', stubs, '--output', dex, intermediate])
        dex_files = list(dex.glob('*.dex'))
        if len(dex_files) != 1 or dex_files[0].name != 'classes.dex':
            raise RuntimeError('Expected exactly one own DEX payload.')
        jar = ROOT / 'vw-ui.jar'
        zip_entries(jar, [('classes.dex', dex_files[0].read_bytes())])
        data = jar.read_bytes()
        manifest = {'format': 'vw-app-android-ui-v1', 'jar': jar.name, 'bytes': len(data), 'sha256': sha(data),
                    'minAndroidApi': 30, 'javaRelease': 8, 'd8Version': D8_VERSION, 'd8Sha256': D8_SHA256,
                    'sources': manifest_sources}
        (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'bytes': len(data), 'sha256': sha(data), 'sources': len(SOURCES), 'compileOnlyExcluded': True}))


if __name__ == '__main__':
    build()
