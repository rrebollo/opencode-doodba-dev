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

# Import the existing extraction logic
from python_ast_extract import (
    is_odoo_model,
    _extract_model_item,
    _extract_model_metadata,
    _extract_field_items,
    _extract_method_items,
)


def parse_code(code, file_path, module_name):
    """Parse Python code and extract Odoo items (extracted from parse_file for reusability).
    
    Args:
        code: Python source code as string
        file_path: Path to file (used in metadata, doesn't need to exist)
        module_name: Odoo module name
    
    Returns:
        List of item dicts
    """
    items = []
    try:
        tree = ast.parse(code, filename=file_path)
    except Exception as e:
        raise ValueError(f"Error parsing {file_path}: {e}")

    # Only process top-level classes to avoid false positives from nested classes
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if not is_odoo_model(node):
            continue

        # Extract model items (handles multi-inherit critical fix)
        model_items = _extract_model_item(node, file_path, module_name)
        items.extend(model_items)

        # Use first inherited model (or _name if no inheritance) as effective_name for fields/methods
        model_name, inherit, _ = _extract_model_metadata(node)
        inherit_list = []
        if inherit:
            if isinstance(inherit, list):
                inherit_list = inherit
            else:
                inherit_list = [inherit]

        is_extension = inherit_list and (model_name is None or model_name == inherit_list[0])
        effective_name = inherit_list[0] if is_extension else model_name
        if not effective_name:
            continue

        # Extract field and method items
        field_items = _extract_field_items(node, effective_name, file_path, module_name)
        items.extend(field_items)

        method_items = _extract_method_items(node, effective_name, file_path, module_name)
        items.extend(method_items)

    return items


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
