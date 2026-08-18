#!/usr/bin/env python3
"""Check every active UTF-8 text file in this Skill against the local budget."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

MAX_OUTER_TOOL_TOKENS = 9_000
BYTES_PER_OUTER_TOOL_TOKEN = 4
IGNORED = {
    ".git", ".pytest_cache", ".ruff_cache", ".venv", "__pycache__",
    "archive", "artifacts", "build", "dist", "node_modules", "output",
    "outputs", "venv",
}
TEXT_ASSET_SUFFIXES = {".csv", ".json", ".md", ".toml", ".tsv", ".txt", ".xml", ".yaml", ".yml"}


@dataclass(frozen=True)
class FileBudget:
    path: Path
    byte_count: int
    estimated_tokens: int


def estimate_outer_tool_tokens(byte_count: int) -> int:
    return (byte_count + BYTES_PER_OUTER_TOOL_TOKEN - 1) // BYTES_PER_OUTER_TOOL_TOKEN


def collect_file_budgets(root: Path) -> list[FileBudget]:
    records: list[FileBudget] = []
    for current, directories, files in os.walk(root):
        directories[:] = sorted(name for name in directories if name not in IGNORED)
        for name in sorted(files):
            path = Path(current) / name
            relative = path.relative_to(root)
            if relative.parts and relative.parts[0] == "assets" and path.suffix.lower() not in TEXT_ASSET_SUFFIXES:
                continue
            data = path.read_bytes()
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                continue
            records.append(FileBudget(relative, len(data), estimate_outer_tool_tokens(len(data))))
    return sorted(records, key=lambda item: item.path.as_posix())


def validate_file_budgets(root: Path) -> list[str]:
    return [
        f"{item.path.as_posix()} exceeds {MAX_OUTER_TOOL_TOKENS} estimated tokens ({item.estimated_tokens})"
        for item in collect_file_budgets(root)
        if item.estimated_tokens > MAX_OUTER_TOOL_TOKENS
    ]


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    records = collect_file_budgets(root)
    for item in sorted(records, key=lambda value: (-value.estimated_tokens, value.path.as_posix())):
        print(f"{item.estimated_tokens:>6} tokens  {item.byte_count:>7} bytes  {item.path.as_posix()}")
    errors = validate_file_budgets(root)
    if errors:
        print("FILE BUDGET FAIL")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"FILE BUDGET PASS {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
