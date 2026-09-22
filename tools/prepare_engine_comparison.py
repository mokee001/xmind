#!/usr/bin/env python3
"""Prepare isolated, loopback-only upstream applications on the same photo bytes."""
from pathlib import Path
import argparse
import json
import os
import secrets
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import Lab, atomic_json, file_hash
from selection_lab.datasets import paths


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--photoprism-package', action='store_true', help='Use the official binary package with the local Debian runtime')
    args = parser.parse_args()
    lab = Lab(*paths())
    base = ROOT / 'outputs/selection-lab/engine-comparison'
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    originals = base / 'originals'
    originals.mkdir(exist_ok=True, mode=0o700)
    manifest = []
    for p in lab.features:
        source = Path(p['path'])
        target = originals / (p['id'] + source.suffix.lower())
        if not target.exists():
            shutil.copy2(source, target)
            target.chmod(0o600)
        if file_hash(target) != p['sha256']:
            raise RuntimeError('Comparison copy differs from original')
        manifest.append({'id': p['id'], 'sha256': p['sha256'], 'name': target.name})
    if {p.name for p in originals.iterdir()} != {p['name'] for p in manifest}:
        raise RuntimeError('The isolated input directory contains another dataset; use a fresh evaluation directory')
    atomic_json(base / 'manifest.json', {'dataset_id': lab.dataset_id, 'photos': manifest})
    credentials = base / 'credentials.json'
    if not credentials.exists():
        atomic_json(credentials, {'database': secrets.token_urlsafe(24),
                                 'immich': secrets.token_urlsafe(24),
                                 'photoprism': secrets.token_urlsafe(24)})
    creds = json.loads(credentials.read_text())
    service = lambda image, **kw: {'image': image, 'restart': 'no', **kw}
    spec = {'name': 'photo-wall-face-evaluation', 'services': {
        'immich-server': service('ghcr.io/immich-app/immich-server:v3.1.0',
            ports=['127.0.0.1:2283:2283'],
            environment={'DB_HOSTNAME': 'database', 'DB_USERNAME': 'postgres',
                'DB_PASSWORD': creds['database'], 'DB_DATABASE_NAME': 'immich',
                'REDIS_HOSTNAME': 'redis', 'IMMICH_MACHINE_LEARNING_URL': 'http://immich-machine-learning:3003'},
            volumes=[str(base / 'immich-data') + ':/data', str(originals) + ':/comparison:ro'],
            depends_on=['redis', 'database', 'immich-machine-learning']),
        'immich-machine-learning': service('ghcr.io/immich-app/immich-machine-learning:v3.1.0',
            volumes=[str(base / 'immich-models') + ':/cache']),
        'redis': service('ghcr.io/valkey-io/valkey@sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d'),
        'database': service('ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23',
            environment={'POSTGRES_PASSWORD': creds['database'], 'POSTGRES_USER': 'postgres',
                         'POSTGRES_DB': 'immich', 'POSTGRES_INITDB_ARGS': '--data-checksums'},
            volumes=[str(base / 'postgres') + ':/var/lib/postgresql/data'], shm_size='128mb'),
        'photoprism': service('photoprism/photoprism:latest',
            ports=['127.0.0.1:2342:2342'],
            environment={'PHOTOPRISM_ADMIN_USER': 'admin', 'PHOTOPRISM_ADMIN_PASSWORD': creds['photoprism'],
                'PHOTOPRISM_AUTH_MODE': 'password', 'PHOTOPRISM_SITE_URL': 'http://127.0.0.1:2342/',
                'PHOTOPRISM_READONLY': 'true', 'PHOTOPRISM_DATABASE_DRIVER': 'sqlite',
                'PHOTOPRISM_DISABLE_PLACES': 'true', 'PHOTOPRISM_DISABLE_TLS': 'true',
                'PHOTOPRISM_WORKERS': '4'},
            volumes=[str(originals) + ':/photoprism/originals:ro', str(base / 'photoprism-storage') + ':/photoprism/storage']),
    }}
    if args.photoprism_package:
        pp = spec['services']['photoprism']
        pp['image'] = 'photo-wall-photoprism-runtime:20260910'
        pp['volumes'] += [str(base / 'photoprism-package') + ':/opt/photoprism:ro',
                         str(base / 'tensorflow') + ':/opt/tensorflow:ro']
        pp['environment'].update({'PHOTOPRISM_ASSETS_PATH': '/opt/photoprism/assets',
            'PHOTOPRISM_ORIGINALS_PATH': '/photoprism/originals',
            'PHOTOPRISM_IMPORT_PATH': '/photoprism/storage/import',
            'PHOTOPRISM_STORAGE_PATH': '/photoprism/storage',
            'PHOTOPRISM_HTTP_HOST': '0.0.0.0', 'PHOTOPRISM_HTTP_PORT': '2342',
            'PHOTOPRISM_DISABLE_CLASSIFICATION': 'true', 'PHOTOPRISM_DISABLE_WEBDAV': 'true',
            'DO_NOT_TRACK': 'true', 'LD_LIBRARY_PATH': '/opt/photoprism/lib:/opt/tensorflow/lib'})
        (base / 'photoprism-storage/import').mkdir(parents=True, exist_ok=True)
    atomic_json(base / 'compose.json', spec)
    print(f'Prepared {len(manifest)} verified local copies; originals unchanged. {base}')


if __name__ == '__main__':
    main()
