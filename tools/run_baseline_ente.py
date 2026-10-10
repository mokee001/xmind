#!/usr/bin/env python3
"""Initialize image decoders before executing the unchanged frozen Ente script."""
import argparse
from pathlib import Path
import runpy
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    args, forwarded = parser.parse_known_args()
    runtime = args.runtime.resolve()
    script = runtime/'tools/run_ente_lab.py'
    # Parent verifies the frozen Git manifest and models before invoking us.
    sys.path[:0] = [str(runtime), str(runtime/'tools')]
    import pillow_heif
    pillow_heif.register_heif_opener()
    sys.argv = [str(script), *forwarded]
    runpy.run_path(str(script), run_name='__main__')


if __name__ == '__main__':
    main()
