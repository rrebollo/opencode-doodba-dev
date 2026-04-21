---
description: "AUTO-USE on first plugin use or when user reports setup issues. Validates Docker, Python, uv environment, detects Odoo path, and builds the code indexer. Use when: 'setup', 'install', 'configure', 'indexer not found', 'not working'."
agent: doodba-provisioner
subtask: true
---

Perform complete Doodba environment setup and return final status report.

Run `/doodba-setup` to validate the environment and build the indexer.
