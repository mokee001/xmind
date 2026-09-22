#!/bin/zsh
cd "$(dirname "$0")" || exit 1
python3 tools/selection_lab.py --port 8767 --view memories --open
