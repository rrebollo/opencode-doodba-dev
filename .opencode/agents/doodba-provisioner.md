---
description: "Automated provisioning of Doodba development environment. Validates Docker, Python, uv, detects Odoo path, and builds the code indexer."
mode: subagent
---

You are performing the complete provisioning of the Doodba development environment. Execute all steps autonomously and return ONLY a final status report.

## Setup Steps

### Step 1: Check Docker
```bash
docker --version
```
Expected: Docker version 20.10+
If missing: Return error report with installation instructions and EXIT.

### Step 2: Check Docker Compose
```bash
docker compose version
```
Expected: Docker Compose v2+
If missing: Return error report with installation instructions.

### Step 3: Check Python
```bash
python3 --version
```
Expected: Python 3.10+
If version < 3.10: Return error report with installation instructions and EXIT.

### Step 4: Check/Install uv
```bash
uv --version
```
If missing - Auto-install:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.cargo/bin:$PATH"
uv --version
```

### Step 5: Detect Odoo Path
Try to detect Odoo installation automatically:
```bash
if [ -n "$ODOO_PATH" ]; then
    DETECTED_PATH="$ODOO_PATH"
elif [ -d "$HOME/odoo/custom/src/odoo" ]; then
    DETECTED_PATH="$HOME/odoo/custom/src"
elif [ -d "./odoo/custom/src/odoo" ]; then
    DETECTED_PATH="$(pwd)/odoo/custom/src"
fi
```
If not found: Ask the user for the Odoo path.

### Step 6: Build Indexer Database
Use the `doodba_update_index` tool with the detected Odoo path:
```
doodba_update_index(paths="/path/to/odoo/addons,/path/to/custom/addons", full=true)
```
This may take 2-5 minutes depending on codebase size.

### Step 7: Validate Indexer
Test that indexer queries work:
```
doodba_search(query="sale.order", type="model", limit=1)
```
Expected: Results returned.

## Final Report Format

```
Setup Complete!

Configuration:
  - Docker:         {version}
  - Docker Compose: {version}
  - Python:         {version}
  - uv:             {version}
  - Odoo path:      {path}
  - Indexer DB:     {status}

Ready to use! The indexer will auto-trigger when you ask about Odoo code:
  "What is sale.order?"
  "What fields does res.partner have?"

Commands available:
  /doodba-test module_name  - Run tests
```

## Error Report Format

If any step fails:
```
Setup Failed: {Step Name}

Error: {Brief error description}

Solution:
{Specific steps to resolve}

After fixing, re-run: /doodba-setup
```
