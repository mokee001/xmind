"""Render saved selected photos into existing templates, without selecting again."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selection_lab.core import Lab
from selection_lab.datasets import paths
from selection_lab.wall_demo import build
if __name__ == '__main__':
    value = build(Lab(*paths()))
    print(f"Rendered {len(value['walls'])} whole-wall previews. Open http://127.0.0.1:8766/wall-demo")
