---
description: "AUTO-USE when user wants to test: 'run tests', 'test module', 'execute tests', 'check tests', 'verify tests'. Runs Odoo tests using Doodba's invoke test command."
---

Run tests for Odoo modules using Doodba's `invoke test` task.

Ask which module(s) to test (can be comma-separated) and test scope:

- Specific module(s)
- All core/extra/enterprise modules
- With or without debug mode

Execute tests using invoke tasks:

```bash
invoke test --modules=module_name
invoke test --modules=module1,module2
invoke test --modules=module_name -v
```

Parse and present test results clearly.

If tests fail, offer to help debug.
