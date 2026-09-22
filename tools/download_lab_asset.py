#!/usr/bin/env python3
"""Download a public lab dependency with validated byte ranges and SHA256 record."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request


def main():
    p = argparse.ArgumentParser()
    p.add_argument('url')
    p.add_argument('target', type=Path)
    args = p.parse_args()
    with urllib.request.urlopen(urllib.request.Request(args.url, method='HEAD'), timeout=30) as r:
        size = int(r.headers['Content-Length'])
        etag = r.headers.get('ETag')
    key = hashlib.sha256((args.url + str(size) + str(etag)).encode()).hexdigest()[:16]
    parts = args.target.parent / ('parts-' + key)
    parts.mkdir(parents=True, exist_ok=True)
    chunk = 8*1024*1024
    def fetch(i):
        start, end = i*chunk, min(size-1, (i+1)*chunk-1)
        path = parts / str(i)
        if path.exists() and path.stat().st_size == end-start+1:
            return
        for attempt in range(3):
            try:
                headers = {'Range': f'bytes={start}-{end}'}
                if etag:
                    headers['If-Range'] = etag
                with urllib.request.urlopen(urllib.request.Request(args.url, headers=headers), timeout=300) as r:
                    if r.status != 206 or r.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                        raise RuntimeError('Server did not honor requested range')
                    with path.open('wb') as f:
                        shutil.copyfileobj(r, f)
                if path.stat().st_size != end-start+1:
                    raise RuntimeError('Downloaded length mismatch')
                print(f'{args.target.name}: part {i+1} complete', flush=True)
                return
            except Exception:
                if attempt == 2:
                    raise
    count = (size+chunk-1)//chunk
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch, range(count)))
    temporary = args.target.with_suffix('.assembling')
    sha = hashlib.sha256()
    with temporary.open('wb') as out:
        for i in range(count):
            with (parts / str(i)).open('rb') as f:
                while block := f.read(1024*1024):
                    out.write(block)
                    sha.update(block)
    temporary.replace(args.target)
    args.target.with_suffix(args.target.suffix + '.source.json').write_text(json.dumps({
        'url': args.url, 'etag': etag, 'bytes': size, 'sha256': sha.hexdigest()}, indent=2))
    print(f'{args.target.name}: {size} bytes; SHA256 {sha.hexdigest()}', flush=True)


if __name__ == '__main__':
    main()
