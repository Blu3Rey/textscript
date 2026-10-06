"""Checks that every Python golden file in the repository parses.

Golden files under packages/*/test/golden/ hold expected renderer output.
TextScript promises that exported code is always valid Python, holes
included, so CI parses each golden file with the standard library's ast
module.
"""

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    files = sorted(ROOT.glob("packages/*/test/golden/**/*.py"))
    failures = 0
    for path in files:
        rel = path.relative_to(ROOT)
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(rel))
        except SyntaxError as err:
            failures += 1
            print(f"FAIL {rel}:{err.lineno}:{err.offset}: {err.msg}")
    print(f"Parsed {len(files) - failures}/{len(files)} Python golden files.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
