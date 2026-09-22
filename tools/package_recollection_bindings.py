"""Archive already-generated portable Dart bindings from the pinned checkout.

No model, algorithm, photo, cache, secret or platform binary is in this archive.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

COMMIT='7dc875ce12c781733b289cd27bbb0f3a99675aa2'
DIRECTORIES=('mobile/apps/photos/lib/src/rust','mobile/packages/frb/lib','mobile/packages/strings/lib/l10n')

def main():
    p=argparse.ArgumentParser();p.add_argument('upstream',type=Path);p.add_argument('output',type=Path)
    a=p.parse_args();root=a.upstream.resolve()
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()!=COMMIT:
        raise RuntimeError('Source revision mismatch')
    entries=[]
    for directory in DIRECTORIES:
        for file in sorted((root/directory).rglob('*.dart')):
            if not any(mark in file.read_text()[:350] for mark in ('automatically generated','GENERATED CODE','DO NOT MODIFY BY HAND')) and 'strings/lib/l10n/' not in str(file):
                # Generator forwarding shims have an explicit export only.
                if not file.read_text().lstrip().startswith('export '):
                    raise RuntimeError('Unexpected non-generated source: '+str(file))
            entries.append(file)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    with tarfile.open(a.output,'w:gz') as archive:
        for file in entries:archive.add(file,arcname=str(file.relative_to(root)))
    a.output.with_suffix('.manifest.json').write_text(json.dumps({'commit':COMMIT,
        'sha256':hashlib.sha256(a.output.read_bytes()).hexdigest(),
        'files':{str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in entries}},indent=2))
    print(f'{len(entries)} portable generated Dart files archived')

if __name__=='__main__':main()
