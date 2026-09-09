#!/bin/zsh
cd "$(dirname "$0")" || exit 1
python3 tools/selection_lab.py --port 8768 --view recollections --open
