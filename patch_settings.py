import re

filepath = 'js/settings.js'
with open(filepath, 'r') as f:
    content = f.read()

# 1. Add imports at the top
if 'requireAuth' not in content:
    content = "import { requireAuth } from './app.js';\n" + content
if 'auth, signOut' not in content:
    content = content.replace("import { db, USER_ID, doc, getDoc, setDoc } from './firebase-config.js';", 
                              "import { db, USER_ID, doc, getDoc, setDoc, auth, signOut } from './firebase-config.js';")

# 2. Add logout listener code
logout_code = """
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await signOut(auth);
        window.location.href = 'auth.html';
      } catch (error) {
        showToast('Errore durante il logout', 'err');
      }
    });
  }
"""
if 'logoutBtn' not in content:
    # insert before loadSettings(); at the end
    content = content.replace("loadSettings();", logout_code + "\nloadSettings();")

# 3. Replace loadSettings(); with IIFE
pattern = r"^loadSettings\(\);\s*$"
replacement = "(async function() {\n  await requireAuth();\n  loadSettings();\n})();"
content = re.sub(pattern, replacement, content, flags=re.MULTILINE)

with open(filepath, 'w') as f:
    f.write(content)
