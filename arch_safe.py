import re
import os
import shutil

shutil.copy('js/home.js', 'js/daily_state.js')

with open('js/daily_state.js', 'r') as f:
    js = f.read()

# Null checks injection
js = js.replace("document.getElementById('date-label').textContent", "const dlabel = document.getElementById('date-label'); if(dlabel) dlabel.textContent")
js = js.replace("const box = document.getElementById('streak-box');\n  box.innerHTML", "const box = document.getElementById('streak-box');\n  if(box) box.innerHTML")
js = js.replace(
    "const lbl = document.getElementById('dtype-label');\n  const sub = document.getElementById('dtype-sub');\n  const tgl = document.getElementById('override-tgl');", 
    "const lbl = document.getElementById('dtype-label');\n  const sub = document.getElementById('dtype-sub');\n  const tgl = document.getElementById('override-tgl');\n  if(!lbl || !sub || !tgl) return;"
)
js = js.replace("cring.innerHTML = `", "if(cring) cring.innerHTML = `")
js = js.replace(
    "const deltaEl = document.getElementById('kcal-delta');\n  if (rem >= 0) {", 
    "const deltaEl = document.getElementById('kcal-delta');\n  if(deltaEl) { if (rem >= 0) {"
)
js = js.replace(
    "deltaEl.style.color = 'var(--orange)';\n    deltaEl.textContent = `⚠️ +${Math.round(-rem)} kcal in eccesso`;\n  }", 
    "deltaEl.style.color = 'var(--orange)';\n    deltaEl.textContent = `⚠️ +${Math.round(-rem)} kcal in eccesso`;\n  } }"
)
js = js.replace("const el = document.getElementById('meals-list');\n  if (!meals.length) {", "const el = document.getElementById('meals-list');\n  if (!el) return;\n  if (!meals.length) {")
js = js.replace("document.getElementById('steps-in').value", "document.getElementById('steps-in')?.value")
js = js.replace("document.getElementById('burned-in').value", "document.getElementById('burned-in')?.value")
js = js.replace("document.getElementById('note-in').value", "document.getElementById('note-in')?.value")

# Assignment protections
js = js.replace("document.getElementById('steps-in').value =", "const sf = document.getElementById('steps-in'); if(sf) sf.value =")
js = js.replace("document.getElementById('burned-in').value =", "const kf = document.getElementById('burned-in'); if(kf) kf.value =")
js = js.replace("document.getElementById('note-in').value =", "const nf = document.getElementById('note-in'); if(nf) nf.value =")

js = js.replace("const wrap = document.getElementById('workout-content');", "const wrap = document.getElementById('workout-content');\n  if(!wrap) return;")
js = js.replace("const wrap = document.getElementById('workout-box');", "const wrap = document.getElementById('workout-box');\n  if(!wrap) return;")

# Fix Cring again for sure
js = re.sub(r'const cring = document\.getElementById\(\'cring-box\'\);[^<]*cring\.innerHTML =', "const cring = document.getElementById('cring-box');\n  if(cring) cring.innerHTML =", js)

# Avoid crash in appSettings loop
# "const name = appSettings?.profile?.name" is already safe.

with open('js/daily_state.js', 'w') as f:
    f.write(js)

print("Safe JS generation applied.")
