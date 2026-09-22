#!/usr/bin/env python3
"""Start the local selection lab without importing production server routes."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selection_lab.server import main

if __name__ == "__main__":
    main()
