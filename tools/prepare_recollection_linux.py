#!/usr/bin/env python3
"""Prepare an isolated Linux runtime for the pinned recollection engine.

No photos, live service configuration, or selection rules are changed here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import runpy

def run(args, **kw):
    subprocess.run(args, check=True, **kw)

def download(url, path, expected=None):
    if not path.exists():
        run(['curl', '-fL', '--retry', '2', '--connect-timeout', '20', '-o', str(path), url])
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected and actual != expected:
        raise RuntimeError(f'Hash mismatch: {path.name}')
    return actual

def main():
    p = argparse.ArgumentParser()
    p.add_argument('root', type=Path)
    p.add_argument('--bindings', type=Path, help='Verified portable generator output from the same pinned source')
    args = p.parse_args()
    root = args.root.resolve()
    sys.path.insert(0, str(root))
    verify = runpy.run_path(str(Path(__file__).with_name('verify_recollection_baseline.py')))['verify']
    report = verify(root)
    if not report['ok']:
        raise RuntimeError(json.dumps(report))
    state = root / 'outputs/selection-lab'
    engine = state / 'engines'
    engine.mkdir(parents=True, exist_ok=True)
    upstream = engine / 'ente-upstream'
    commit = '7dc875ce12c781733b289cd27bbb0f3a99675aa2'
    if not upstream.exists():
        run(['git', 'init', str(upstream)])
        run(['git', 'fetch', '--depth', '1', 'https://github.com/ente-io/ente.git', commit], cwd=upstream)
        run(['git', 'checkout', '--detach', 'FETCH_HEAD'], cwd=upstream)
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=upstream, text=True).strip() != commit:
        raise RuntimeError('Ente revision mismatch')
    assets = json.loads((upstream / 'infra/ml/test/ml_indexing/assets.json').read_text())
    directory = state / 'ente/assets'
    directory.mkdir(parents=True, exist_ok=True)
    models = {}
    for key, spec in assets['models'].items():
        path = directory / spec['file_name']
        download(spec['url'], path, spec['sha256'])
        models[key] = str(path)
    ort = assets['onnx_runtime']['archives']['x86_64-unknown-linux-gnu']
    archive = directory / 'onnxruntime-linux.tar.gz'
    download(ort['url'], archive, ort['sha256'])
    lib = directory / Path(ort['library_path']).name
    with tarfile.open(archive) as tar:
        member = tar.getmember(ort['library_path'])
        if not member.isfile():
            raise RuntimeError('ORT library is not a regular file')
        lib.write_bytes(tar.extractfile(member).read())
    if hashlib.sha256(lib.read_bytes()).hexdigest() != ort['library_sha256']:
        raise RuntimeError('ORT library hash mismatch')
    runtime = dict(commit=commit, models=models, model_sha256={k:s['sha256'] for k,s in assets['models'].items()},
                   ort_library=str(lib), ort_sha256=ort['library_sha256'])
    for key, name, sha in [('cities', 'cities.bin', '898dca892a71fd601ae8e75e5c55fd6d4591e4c98de335d9b33e7f076aa668f5'),
                           ('urban', 'urban-centres.bin', 'e981b0383e6502ede56b52d5be96cda66f53d7352492e677d8978467c106dab0')]:
        path = directory / name
        download('https://assets.ente.com/location/v2/' + name, path, sha)
        runtime[key] = str(path)
    (state / 'ente/runtime.json').write_text(json.dumps(runtime, indent=2))
    if not verify(root, models=True)['ok']:
        raise RuntimeError('Baseline/models verification failed')
    env = {**os.environ, 'CARGO_HOME':str(engine/'cargo'), 'RUSTUP_HOME':str(engine/'rustup'),
           'CARGO_BUILD_JOBS':'1', 'CARGO_PROFILE_DEV_DEBUG':'0',
           'PUB_CACHE':str(engine/'pub-cache'), 'CI':'true', 'FLUTTER_SUPPRESS_ANALYTICS':'true'}
    env['PATH'] = str(engine/'cargo/bin') + ':' + env['PATH']
    if not (engine/'cargo/bin/cargo').exists():
        installer = engine/'rustup-init.sh'
        download('https://sh.rustup.rs', installer)
        run(['sh', str(installer), '-y', '--profile', 'minimal', '--no-modify-path'], env=env)
    example = upstream/'rust/crates/ml/examples/photo_wall_lab.rs'
    example.parent.mkdir(exist_ok=True)
    example.write_bytes((root/'tools/ente_ml_probe.rs').read_bytes())
    manifest = upstream/'rust/crates/ml/Cargo.toml'
    source = manifest.read_text()
    if 'ente-location.workspace = true' not in source:
        manifest.write_text(source.replace('[dev-dependencies]', '[dev-dependencies]\nente-location.workspace = true'))
    run(['cargo', 'build', '-p', 'ente-ml', '--example', 'photo_wall_lab'], cwd=upstream/'rust', env=env)
    flutter = engine/'flutter-sdk'
    if not flutter.exists():
        run(['git', 'clone', '--depth', '1', '--branch', '3.47.2', 'https://github.com/flutter/flutter.git', str(flutter)])
    env['PATH'] = str(flutter/'bin') + ':' + env['PATH']
    if args.bindings:
        bundle = args.bindings.resolve()
        manifest = json.loads(bundle.with_suffix('.manifest.json').read_text())
        if manifest['commit'] != commit or hashlib.sha256(bundle.read_bytes()).hexdigest()!=manifest['sha256']:
            raise RuntimeError('Generated bindings provenance mismatch')
        with tarfile.open(bundle) as archive:
            for member in archive:
                path = (upstream/member.name).resolve()
                if not member.isfile() or upstream.resolve() not in path.parents or member.name not in manifest['files']:
                    raise RuntimeError('Invalid generated bindings archive')
                data = archive.extractfile(member).read()
                if hashlib.sha256(data).hexdigest()!=manifest['files'][member.name]:
                    raise RuntimeError('Generated binding checksum mismatch')
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(data)
        # Same Pub solver and lockfile; avoid Flutter's redundant workspace
        # post-generation when portable generator outputs are already verified.
        env['FLUTTER_ROOT']=str(flutter)
        run([str(flutter/'bin/cache/dart-sdk/bin/dart'), 'pub', 'get', '--enforce-lockfile'], cwd=upstream/'mobile', env=env, timeout=180)
    else:
        run([str(flutter/'bin/flutter'), 'pub', 'get', '--enforce-lockfile'], cwd=upstream/'mobile', env=env, timeout=600)
        run(['rustup', 'component', 'add', 'rustfmt'], env=env)
        run(['cargo', 'build', '-p', 'codegen'], cwd=upstream/'rust', env=env)
        run(['cargo', 'codegen', 'frb', 'photos'], cwd=upstream/'rust', env=env)
        run([str(flutter/'bin/flutter'), 'gen-l10n'], cwd=upstream/'mobile/packages/strings', env=env)
    print('Pinned Linux runtime prepared; inference smoke test still required.', flush=True)

if __name__ == '__main__':
    main()
