#!/usr/bin/env python3
"""Fetch a public GHCR ARM64 image, verify every blob, and load it locally.

Bounded parallel ranges help on this lab's slow single-connection download path.
Only anonymous pull tokens are used. No user credentials or photo data are sent.
"""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request


def main():
    p = argparse.ArgumentParser()
    p.add_argument('repository')
    p.add_argument('tag')
    args = p.parse_args()
    if args.repository not in {'immich-app/immich-machine-learning', 'immich-app/immich-server', 'immich-app/postgres'}:
        raise SystemExit('Only explicit public evaluation repositories are supported')
    base = Path(__file__).resolve().parents[1] / 'outputs/selection-lab/engine-comparison/image-downloads' / args.repository.split('/')[-1]
    base.mkdir(parents=True, exist_ok=True)
    host = 'https://ghcr.io'
    token = json.load(urllib.request.urlopen(host + '/token?service=ghcr.io&scope=repository:' + args.repository + ':pull', timeout=30))['token']
    def request(path):
        req = urllib.request.Request(host + '/v2/' + args.repository + '/' + path,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json'})
        return urllib.request.urlopen(req, timeout=120)
    with request('manifests/' + args.tag) as r:
        raw = r.read()
        manifest = json.loads(raw)
    if 'manifests' in manifest:
        platform = next(m for m in manifest['manifests'] if m.get('platform') == {'architecture': 'arm64', 'os': 'linux'}
                        or (m.get('platform', {}).get('architecture') == 'arm64' and m.get('platform', {}).get('os') == 'linux'))
        with request('manifests/' + platform['digest']) as r:
            raw = r.read()
            if hashlib.sha256(raw).hexdigest() != platform['digest'].split(':')[1]:
                raise RuntimeError('Platform manifest digest mismatch')
            manifest = json.loads(raw)
    (base/'upstream-manifest.json').write_bytes(raw)
    jobs = []
    blobs = [manifest['config'], *manifest['layers']]
    step = 8*1024*1024
    for blob in blobs:
        digest, size = blob['digest'], blob['size']
        out = base / digest.split(':')[1]
        if out.exists() and out.stat().st_size == size and hashlib.sha256(out.read_bytes()).hexdigest() == out.name:
            continue
        cached = out.with_name(out.name + '.cached')
        with cached.open('wb') as dst:
            found = subprocess.run(['colima', 'ssh', '--profile', 'photo-wall-eval', '--',
                'sudo', 'ctr', '-n', 'moby', 'content', 'get', digest],
                stdout=dst, stderr=subprocess.DEVNULL)
        if found.returncode == 0 and cached.stat().st_size == size and hashlib.sha256(cached.read_bytes()).hexdigest() == out.name:
            cached.replace(out)
            continue
        cached.unlink()
        # Resolve to the provider's signed blob URL without printing or persisting it.
        with request('blobs/' + digest) as r:
            url = r.geturl()
            if size < step:
                data = r.read()
                if len(data) != size or hashlib.sha256(data).hexdigest() != out.name:
                    raise RuntimeError('Small blob digest mismatch')
                out.write_bytes(data)
                continue
        for start in range(0, size, step):
            jobs.append((out, url, start, min(size-1, start+step-1), size))
    def fetch(job):
        out, url, start, end, size = job
        path = out.with_name(out.name + '.' + str(start))
        if path.exists() and path.stat().st_size == end-start+1:
            return
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
                with urllib.request.urlopen(req, timeout=300) as r:
                    if r.status != 206 or r.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                        raise RuntimeError('Blob range mismatch')
                    with path.open('wb') as f:
                        shutil.copyfileobj(r, f)
                if path.stat().st_size != end-start+1:
                    raise RuntimeError('Blob part length mismatch')
                print(args.repository.split('/')[-1], 'part', start//step, 'complete', flush=True)
                return
            except Exception:
                if attempt == 2:
                    raise
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(fetch, jobs))
    for blob in blobs:
        out = base / blob['digest'].split(':')[1]
        if not out.exists():
            with out.open('wb') as dst:
                for start in range(0, blob['size'], step):
                    with out.with_name(out.name + '.' + str(start)).open('rb') as src:
                        shutil.copyfileobj(src, dst)
        if out.stat().st_size != blob['size'] or hashlib.sha256(out.read_bytes()).hexdigest() != out.name:
            raise RuntimeError('Final blob digest mismatch')
    layer_names = []
    config = manifest['config']['digest'].split(':')[1]
    config_data = json.loads((base/config).read_text())
    for index, blob in enumerate(manifest['layers']):
        source = base/blob['digest'].split(':')[1]
        target = base/(source.name + '.tar')
        if not target.exists():
            with gzip.open(source, 'rb') as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)
        if 'sha256:' + hashlib.sha256(target.read_bytes()).hexdigest() != config_data['rootfs']['diff_ids'][index]:
            raise RuntimeError('Uncompressed layer digest mismatch')
        layer_names.append(target.name)
    tag = 'ghcr.io/' + args.repository + ':' + args.tag
    (base/'manifest.json').write_text(json.dumps([{'Config': config, 'RepoTags': [tag], 'Layers': layer_names}]))
    archive = base/'image.tar'
    with tarfile.open(archive, 'w') as t:
        for name in ['manifest.json', config, *layer_names]:
            t.add(base/name, arcname=name)
    subprocess.run(['docker', '--context', 'colima-photo-wall-eval', 'load', '-i', str(archive)], check=True)
    print(tag, 'verified and loaded', flush=True)


if __name__ == '__main__':
    main()
