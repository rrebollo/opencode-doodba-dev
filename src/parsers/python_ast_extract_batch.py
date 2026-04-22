#!/usr/bin/env python3
"""
Batch Python AST extractor. Reads JSON lines from stdin, writes JSON lines to stdout.

Input (stdin): JSON lines with {"file_path": "...", "content": "...", "module_name": "..."}
Output (stdout): JSON lines with {"file_path": "...", "items": [...], "error": null}
                  or {"file_path": "...", "items": [], "error": "..."}
"""
import ast
import json
import sys
import tempfile
from pathlib import Path

# Import the shared parsing logic
from python_ast_extract import parse_code


def main():
    """Read stdin, parse each file, write stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        file_path = None
        try:
            request = json.loads(line)
            file_path = request.get("file_path")
            content = request.get("content")
            module_name = request.get("module_name", "unknown")

            if not file_path or content is None:
                raise ValueError("Missing 'file_path' or 'content' in request")

            # Parse the code
            items = parse_code(content, file_path, module_name)

            result = {
                "file_path": file_path,
                "items": items,
                "error": None
            }
        except Exception as e:
            result = {
                "file_path": file_path,
                "items": [],
                "error": str(e)
            }

        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
