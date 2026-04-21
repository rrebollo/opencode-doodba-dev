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
SKIP_METHODS = {'__init__', 'create', 'write', 'unlink'}


def get_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        v = get_name(node.value)
        return f"{v}.{node.attr}" if v else node.attr
    return ''


def get_value(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [get_value(e) for e in node.elts]
    if isinstance(node, ast.Tuple):
        return [get_value(e) for e in node.elts]
    if isinstance(node, ast.Dict):
        return {get_value(k): get_value(v) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.Name):
        return {'True': True, 'False': False, 'None': None}.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        return get_name(node)
    return None


def is_odoo_model(node):
    for base in node.bases:
        if get_name(base) in ODOO_BASES:
            return True
    return False


def get_field_type(call_node):
    if isinstance(call_node.func, ast.Attribute):
        if isinstance(call_node.func.value, ast.Name) and call_node.func.value.id == 'fields':
            return call_node.func.attr
    if isinstance(call_node.func, ast.Name) and call_node.func.id in FIELD_TYPES:
        return call_node.func.id
    return None


def parse_file(file_path, module_name):
    items = []
    try:
        source = Path(file_path).read_text(encoding='utf-8')
        tree = ast.parse(source, filename=file_path)
    except Exception:
        return []

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        if not is_odoo_model(node):
            continue

        model_name = None
        inherit = None
        description = None

        for stmt in node.body:
            if not isinstance(stmt, ast.Assign):
                continue
            for target in stmt.targets:
                if not isinstance(target, ast.Name):
                    continue
                val = get_value(stmt.value)
                if target.id == '_name':
                    model_name = val
                elif target.id == '_inherit':
                    inherit = val[0] if isinstance(val, list) and val else val
                elif target.id == '_description':
                    description = val

        is_extension = inherit and (model_name is None or model_name == inherit)
        effective_name = inherit if is_extension else model_name
        if not effective_name:
            continue

        ref_type = 'inheritance' if is_extension else 'definition'
        model_refs = [{
            'filePath': file_path,
            'lineNumber': node.lineno,
            'referenceType': ref_type,
            'context': node.name,
        }]
        # If model has both _name and _inherit and they differ, also add inheritance ref
        if inherit and model_name and model_name != inherit:
            model_refs.append({
                'filePath': file_path,
                'lineNumber': node.lineno,
                'referenceType': 'inheritance',
                'context': f"{model_name} _inherit {inherit}",
            })

        items.append({
            'itemType': 'model',
            'name': effective_name,
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

        # Fields
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

                kw = {kw.arg: get_value(kw.value) for kw in stmt.value.keywords if kw.arg}
                comodel = None
                if field_type in RELATIONAL:
                    if stmt.value.args:
                        comodel = get_value(stmt.value.args[0])
                    elif 'comodel_name' in kw:
                        comodel = kw['comodel_name']

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
                        'string': kw.get('string'),
                        'compute': kw.get('compute'),
                        'required': kw.get('required', False),
                        'file_path': file_path,
                    },
                    'references': field_refs,
                })

        # Methods
        for stmt in node.body:
            if not isinstance(stmt, ast.FunctionDef):
                continue
            if stmt.name in SKIP_METHODS:
                continue
            decorators = []
            for d in stmt.decorator_list:
                dec_name = get_name(d) if not isinstance(d, ast.Call) else get_name(d.func)
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


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps([]))
        sys.exit(0)
    result = parse_file(sys.argv[1], sys.argv[2])
    print(json.dumps(result))
