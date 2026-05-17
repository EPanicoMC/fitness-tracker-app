import re

files_to_patch = {
    'js/checks.js': 'loadChecks()',
    'js/daily_state.js': 'init()',
    'js/diary.js': 'init()',
    'js/diet.js': 'loadDiets()',
    'js/programs.js': 'loadPrograms()',
    'js/session.js': 'loadSessionSelect()',
    'js/settings.js': 'loadSettings()'
}

for filepath, fn in files_to_patch.items():
    with open(filepath, 'r') as f:
        content = f.read()

    # Add import at the top
    if 'requireAuth' not in content:
        content = "import { requireAuth } from './app.js';\n" + content

    # Replace the call at the bottom
    pattern = rf"^{fn};\s*$"
    replacement = f"(async function() {{\n  await requireAuth();\n  {fn};\n}})();"
    
    new_content = re.sub(pattern, replacement, content, flags=re.MULTILINE)
    
    with open(filepath, 'w') as f:
        f.write(new_content)
    
    print(f"Patched {filepath}")

