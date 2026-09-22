"""Public upstream fixtures only; never reads or uploads the user's library.

Desktop: download checksum-pinned fixtures and run real Apple Vision.
Server: --server builds an isolated worker input from those same fixture bytes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

FIXTURES = {
    'astronaut.png':'2418889d0d83962d51facc3832b55cf1849690018a1e873d1c551146555cd02f',
    'people.jpeg':'2fdb1c7c7ae8007662b5c9e9ddcec7677b0090884ca8b8a5da3d1020f153a8f5',
    'singapore.jpg':'cfc5b98ec69a65f04b0e4bb7c06009ad6d43362773a5b546c19a48e467a8bf95',
}
BASE = 'https://raw.githubusercontent.com/ente/test-fixtures/13c7cf83717140be20b32e6fbb178d5f15ea09ea/ml/indexing/v1/files/'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory',type=Path)
    parser.add_argument('--server',action='store_true')
    args = parser.parse_args()
    root = args.directory.resolve()
    photos = root/'photos'
    photos.mkdir(parents=True,exist_ok=True)
    items = []
    for name,sha in FIXTURES.items():
        path = photos/(sha+Path(name).suffix)
        if not path.exists():
            if args.server: raise RuntimeError('Public fixture missing')
            path.write_bytes(urllib.request.urlopen(BASE+name,timeout=30).read())
        if hashlib.sha256(path.read_bytes()).hexdigest()!=sha:
            raise RuntimeError('Public fixture checksum mismatch')
        items.append({'id':sha,'path':str(path)})
    observation_path = root/'vision.json'
    if not args.server:
        source = Path(__file__).with_name('album_vision_features.swift')
        result = subprocess.run(['swift',str(source)],input=json.dumps(items),text=True,capture_output=True,check=True,timeout=180)
        values = json.loads(result.stdout)
        if any(item.get('error') for item in values): raise RuntimeError('Real Vision extraction failed')
        observation_path.write_text(json.dumps(values))
    else:
        observations = {p['id']:p for p in json.loads(observation_path.read_text())}
        data = {p['id']:{'path':p['path'],'sha256':p['id'],'local_engine':'apple-vision-local-v1',
                         'vision':{**observations[p['id']],'version':1}} for p in items}
        revision = hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
        library = {'scope':'smoke-public','revision':revision,'photos':data}
        job = root/'jobs'/revision
        job.mkdir(parents=True,exist_ok=True)
        (job/'input.json').write_text(json.dumps(library))
        print(job)


if __name__=='__main__': main()
