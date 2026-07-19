#!/usr/bin/env python3
"""
diagnose_folder_name.py

Run this once, directly, to see the EXACT name of every folder inside
backend/ (using repr() so trailing spaces / hidden characters become
visible). Paste the output back if the kill-switch in combine_codebase.py
still isn't catching bhashasetu_env.
"""
from pathlib import Path

BACKEND_DIR = Path(r"D:\Desktop Final\BhashaSetu major project\BhashaSetu\backend")

if not BACKEND_DIR.exists():
    print(f"Does not exist: {BACKEND_DIR}")
else:
    print(f"Contents of {BACKEND_DIR}:\n")
    for entry in sorted(BACKEND_DIR.iterdir(), key=lambda p: p.name.lower()):
        kind = "DIR " if entry.is_dir() else "FILE"
        print(f"  [{kind}] repr={entry.name!r}  len={len(entry.name)}")