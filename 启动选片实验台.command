#!/bin/zsh
cd "${0:A:h}" || exit 1
python3 -u tools/selection_lab.py --open
