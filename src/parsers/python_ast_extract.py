#!/usr/bin/env python3
"""
Extract Odoo items from a Python file using the ast module.
Usage: python3 python_ast_extract.py <file_path> <module_name>
Outputs JSON array of items to stdout.
"""
import ast
import json
import sys
from pathlib import Path


FIELD_TYPES = {
    'Char', 'Text', 'Integer', 'Float', 'Boolean', 'Date', 'Datetime',
    'Many2one', 'One2many', 'Many2many', 'Selection', 'Binary', 'Html',
    'Monetary', 'Reference', 'Json',
}
RELATIONAL = {'Many2one', 'One2many', 'Many2many'}
ODOO_BASES = {
    'models.Model', 'models.TransientModel', 'models.AbstractModel',
    'Model', 'TransientModel', 'AbstractModel',
}
# Cross-referenced with TypeScript version in src/parsers/python-ast.ts
SKIP_METHODS = {'__init__', 'create', 'write', 'unlink'}


def ast_dotted_name(node):
    """Extract dotted name from ast.Name or ast.Attribute node."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        v = ast_dotted_name(node.value)
        return f"{v}.{node.attr}" if v else node.attr
    return ''


def coerce_ast_value(node):
    """Coerce an ast node to a Python value."""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [coerce_ast_value(e) for e in node.elts]
    if isinstance(node, ast.Tuple):
        return [coerce_ast_value(e) for e in node.elts]
    if isinstance(node, ast.Dict):
        return {coerce_ast_value(k): coerce_ast_value(v) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.Name):
        return {'True': True, 'False': False, 'None': None}.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        return ast_dotted_name(node)
    return None


def is_odoo_model(node):
    for base in node.bases:
        if ast_dotted_name(base) in ODOO_BASES:
            return True
    return False


def get_field_type(call_node):
    if isinstance(call_node.func, ast.Attribute):
        if isinstance(call_node.func.value, ast.Name) and call_node.func.value.id == 'fields':
            return call_node.func.attr
    if isinstance(call_node.func, ast.Name) and call_node.func.id in FIELD_TYPES:
        return call_node.func.id
    return None


def _extract_model_metadata(node):
    """Extract _name, _inherit, and _description from a class node."""
    model_name = None
    inherit = None
    description = None

    for stmt in node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        for target in stmt.targets:
            if not isinstance(target, ast.Name):
                continue
            val = coerce_ast_value(stmt.value)
            if target.id == '_name':
                model_name = val
            elif target.id == '_inherit':
                inherit = val
            elif target.id == '_description':
                description = val

    return model_name, inherit, description


def _extract_model_item(node, file_path, module_name):
    """Extract model item(s) from a class node.
    
    CRITICAL FIX: When _inherit is a list (multi-model inheritance),
    emit one model item per inherited model to ensure all relationships are indexed.
    """
    model_name, inherit, description = _extract_model_metadata(node)

    items = []

    # Normalize inherit to list for consistent processing
    inherit_list = []
    if inherit:
        if isinstance(inherit, list):
            inherit_list = inherit
        else:
            inherit_list = [inherit]

    # Case 1: Extension (pure inheritance, no _name or _name == _inherit)
    if inherit_list and (model_name is None or model_name == inherit_list[0]):
        # Emit one item per inherited model
        for inherited_model in inherit_list:
            ref_type = 'inheritance'
            model_refs = [{
                'filePath': file_path,
                'lineNumber': node.lineno,
                'referenceType': ref_type,
                'context': node.name,
            }]
            items.append({
                'itemType': 'model',
                'name': inherited_model,
                'parentName': None,
                'module': module_name,
                'attributes': {
                    'class_name': node.name,
                    '_inherit': inherit,
                    '_description': description,
                    'file_path': file_path,
                },
                'references': model_refs,
            })
    # Case 2: Definition with possible inheritance
    elif model_name:
        is_extension = inherit is not None
        ref_type = 'inheritance' if is_extension else 'definition'
        model_refs = [{
            'filePath': file_path,
            'lineNumber': node.lineno,
            'referenceType': ref_type,
            'context': node.name,
        }]
        # If model has both _name and _inherit and they differ, also add refs for each inherited model
        if inherit_list:
            for inherited_model in inherit_list:
                model_refs.append({
                    'filePath': file_path,
                    'lineNumber': node.lineno,
                    'referenceType': 'inheritance',
                    'context': f"{model_name} _inherit {inherited_model}",
                })

        items.append({
            'itemType': 'model',
            'name': model_name,
            'parentName': None,
            'module': module_name,
            'attributes': {
                'class_name': node.name,
                '_inherit': inherit,
                '_description': description,
                'file_path': file_path,
            },
            'references': model_refs,
        })

    return items


def _extract_field_items(node, effective_name, file_path, module_name):
    """Extract all field items from a class node."""
    items = []
    for stmt in node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        for target in stmt.targets:
            if not isinstance(target, ast.Name):
                continue
            if not isinstance(stmt.value, ast.Call):
                continue
            field_type = get_field_type(stmt.value)
            if not field_type:
                continue
            field_name = target.id

            kwargs = {kw.arg: coerce_ast_value(kw.value) for kw in stmt.value.keywords if kw.arg}
            comodel = None
            if field_type in RELATIONAL:
                if stmt.value.args:
                    comodel = coerce_ast_value(stmt.value.args[0])
                elif 'comodel_name' in kwargs:
                    comodel = kwargs['comodel_name']

            field_refs = [{
                'filePath': file_path,
                'lineNumber': stmt.lineno,
                'referenceType': 'definition',
                'context': f"{field_name} = fields.{field_type}(...)",
            }]
            if comodel:
                field_refs.append({
                    'filePath': file_path,
                    'lineNumber': stmt.lineno,
                    'referenceType': field_type.lower(),
                    'context': f"{field_name} \u2192 {comodel}",
                })

            items.append({
                'itemType': 'field',
                'name': field_name,
                'parentName': effective_name,
                'module': module_name,
                'attributes': {
                    'field_type': field_type,
                    'string': kwargs.get('string'),
                    'compute': kwargs.get('compute'),
                    'required': kwargs.get('required', False),
                    'file_path': file_path,
                },
                'references': field_refs,
            })

    return items


def _extract_method_items(node, effective_name, file_path, module_name):
    """Extract all method items from a class node."""
    items = []
    for stmt in node.body:
        if not isinstance(stmt, ast.FunctionDef):
            continue
        if stmt.name in SKIP_METHODS:
            continue
        decorators = []
        for d in stmt.decorator_list:
            dec_name = ast_dotted_name(d) if not isinstance(d, ast.Call) else ast_dotted_name(d.func)
            if dec_name:
                decorators.append(dec_name)
        attrs = {'file_path': file_path}
        if decorators:
            attrs['decorators'] = decorators
        items.append({
            'itemType': 'method',
            'name': stmt.name,
            'parentName': effective_name,
            'module': module_name,
            'attributes': attrs,
            'references': [{
                'filePath': file_path,
                'lineNumber': stmt.lineno,
                'referenceType': 'definition',
                'context': stmt.name,
            }],
        })

    return items


def parse_code(code, file_path, module_name):
    """Parse Python code and extract Odoo items (shared between CLI and batch processor).
    
    Args:
        code: Python source code as string
        file_path: Path to file (used in metadata, doesn't need to exist)
        module_name: Odoo module name
    
    Returns:
        List of item dicts
    
    Raises:
        ValueError: If code cannot be parsed
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


def parse_file(file_path, module_name):
    """Read file from disk and parse (backward compatibility wrapper for CLI).
    
    Args:
        file_path: Path to Python file
        module_name: Odoo module name
    
    Returns:
        List of item dicts (empty list on error)
    """
    try:
        source = Path(file_path).read_text(encoding='utf-8')
        return parse_code(source, file_path, module_name)
    except Exception as e:
        print(f"[python_ast_extract] Error parsing {file_path}: {e}", file=sys.stderr)
        return []


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps([]))
        sys.exit(0)
    result = parse_file(sys.argv[1], sys.argv[2])
    print(json.dumps(result))
