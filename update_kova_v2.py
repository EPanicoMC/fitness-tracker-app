import os
import glob
import re

def rep(filepath, old, new):
    with open(filepath, 'r') as f:
        c = f.read()
    if old in c:
        with open(filepath, 'w') as f:
            f.write(c.replace(old, new))

# 1. Add Remix Icon CDN to all HTML files
html_files = glob.glob('*.html')
for html in html_files:
    with open(html, 'r') as f:
        content = f.read()
    
    if 'remixicon.css' not in content:
        content = content.replace('<link rel="stylesheet" href="css/style.css">', 
                                  '<link href="https://cdn.jsdelivr.net/npm/remixicon@4.2.0/fonts/remixicon.css" rel="stylesheet">\n  <link rel="stylesheet" href="css/style.css">')
    
    # 2. Update Bottom Nav in all HTMLs
    content = content.replace('<span class="ni">🏠</span>', '<i class="ri-home-5-fill ni"></i>')
    content = content.replace('<span class="ni">💪</span>', '<i class="ri-file-list-3-fill ni"></i>')
    content = content.replace('<span class="ni">🥗</span>', '<i class="ri-restaurant-fill ni"></i>')
    content = content.replace('<span class="ni">📅</span>', '<i class="ri-calendar-todo-fill ni"></i>')  
    content = content.replace('<span class="ni">🏋️</span>', '<i class="ri-play-circle-fill ni"></i>')
    content = content.replace('⚙️', '<i class="ri-settings-4-fill"></i>')
    
    with open(html, 'w') as f:
        f.write(content)

# 3. Update Home/Header
with open('index.html', 'r') as f: idx = f.read()

header_regex = r'<div class="top-bar-safe" style="display:flex;justify-content:space-between;align-items:flex-start;padding:24px 0 16px">[\s\S]*?</div>\s*</div>'
new_header = """<div class="top-bar-safe" style="padding:8px 0 24px">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="display:flex;flex-direction:column">
        <h1 style="font-size:26px;font-weight:900;letter-spacing:-1px;color:var(--t1)">KOVA.</h1>
        <p style="font-size:9px;color:var(--accent);font-weight:800;letter-spacing:2px;text-transform:uppercase;margin-top:0px">Costanza. Dati. Risultati.</p>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div id="streak-box"></div>
        <a href="settings.html" class="btn-icon" style="border-radius:12px;background:var(--bg3);border:1px solid var(--border);color:var(--t2);width:38px;height:38px;"><i class="ri-settings-4-fill" style="font-size:18px"></i></a>
      </div>
    </div>
    <div style="margin-top:32px;">
      <p id="welcome-name" style="font-size:18px;color:var(--t1);font-weight:600;letter-spacing:-0.4px">Benvenuto</p>
      <p id="date-label" style="font-size:13px;color:var(--t3);font-weight:500;margin-top:2px;letter-spacing:0.5px"></p>
    </div>
  </div>"""
idx = re.sub(header_regex, new_header, idx)

# Basic HTML Icons inject
idx = idx.replace('🔥 Nutrizione oggi', '<i class="ri-fire-fill" style="color:var(--orange)"></i> Nutrizione oggi')
idx = idx.replace('🥗 Pasti del giorno', '<i class="ri-restaurant-2-line"></i> Pasti del giorno')
idx = idx.replace('✨ Calcolo rapido AI', '<i class="ri-magic-line"></i> Calcolo rapido AI')
idx = idx.replace('🤖 Calcola Macro', '<i class="ri-robot-2-line"></i> Calcola Macro')
idx = idx.replace('💪 Allenamento', '<i class="ri-medal-fill"></i> Allenamento')
idx = idx.replace('👟 Passi', '<i class="ri-footprint-line"></i> Passi')
idx = idx.replace('🔥 Kcal bruciate', '<i class="ri-fire-line"></i> Kcal bruciate')
idx = idx.replace('📝 Nota del giorno', '<i class="ri-sticky-note-line"></i> Nota del giorno')
idx = idx.replace('💾 Salva Giornata', '<i class="ri-save-3-line"></i> Salva Giornata')

with open('index.html', 'w') as f: f.write(idx)

# 4. Update JS renders avoiding textContent bugs
rep('js/home.js', 'lbl.textContent = `💪 Giorno ON`;', 'lbl.innerHTML = `<i class="ri-checkbox-circle-fill" style="color:var(--green)"></i> Giorno ON`;')
rep('js/home.js', 'lbl.textContent = `😴 Giorno OFF — Riposo`;', 'lbl.innerHTML = `<i class="ri-moon-fill" style="color:var(--t3)"></i> Giorno OFF — Riposo`;')
rep('js/home.js', "box.innerHTML = `<div class=\\\"streak\\\">🔥 ${streak} giorni</div>`;", "box.innerHTML = `<div class=\\\"streak\\\"><i class=\\\"ri-fire-fill\\\"></i> ${streak}</div>`;")
rep('js/home.js', '⚡ FitScore oggi', '<i class="ri-flashlight-fill" style="color:var(--orange)"></i> FitScore oggi')
rep('js/home.js', "btn.textContent = '🤖 Calcola Macro'", 'btn.innerHTML = `<i class="ri-robot-2-line"></i> Calcola Macro`')
rep('js/home.js', "btn.textContent = '⏳ Calcolo...'", 'btn.innerHTML = `<i class="ri-loader-4-line ri-spin"></i> Calcolo...`')
rep('js/home.js', "btn.textContent = '✨ Ricalcola con AI'", 'btn.innerHTML = `<i class="ri-magic-line"></i> Ricalcola con AI`')
rep('js/home.js', "btn.textContent = '⏳...'", 'btn.innerHTML = `<i class="ri-loader-4-line ri-spin"></i>...`')
rep('js/home.js', '✏️ Ingredienti', '<i class="ri-edit-2-line"></i> Ingredienti')
rep('js/home.js', '✏️ Inserisci manuale', '<i class="ri-pencil-line"></i> Inserisci manuale')
rep('js/home.js', '➕ Aggiungi come Extra', '<i class="ri-add-circle-fill"></i> Aggiungi come Extra')
rep('js/home.js', '✅ Completato', '<i class="ri-check-line"></i> Completato')

# App.js FitScore cleanups
rep('js/app.js', '🔥 Elite', 'Elite')
rep('js/app.js', '💪 Ottimo', 'Ottimo')
rep('js/app.js', '✅ Buono', 'Buono')
rep('js/app.js', '📊 Sufficiente', 'Sufficiente')
rep('js/app.js', '💡 Da migliorare', 'Da migliorare')

# 5. Massive overriding CSS Append for Premium Feel
css_append = """
/* -----------------------------------
   PREMIUM REDESIGN V2 OVERRIDES
-------------------------------------- */
.card { background: var(--bg2); border-radius: 20px; padding: 24px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.03); box-shadow: 0 10px 40px rgba(0,0,0,0.4); animation: fup .4s ease both;}
.card-dark { background: var(--bg3); box-shadow:none; border: 1px solid rgba(255,255,255,0.03); border-radius:18px; }

/* Typographic & Value Enhancements */
.kcal-big { font-size: 68px; font-weight: 800; letter-spacing: -3.5px; font-family: system-ui, -apple-system, sans-serif; color: var(--t1); margin-bottom: -4px;}
.kcal-sub { font-size: 13px; font-weight: 500; letter-spacing: 0px; color: var(--t2); }
#kcal-delta { background: rgba(255,255,255,0.04); padding: 7px 14px; border-radius: 100px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight:700; margin-top:20px;}

.clabel { font-size: 11px; font-weight: 800; letter-spacing: 1.5px; color: var(--t2); display: flex; align-items: center; gap: 8px; margin-bottom: 20px; opacity: 0.9; }
.clabel i { font-size: 16px; opacity: 1; }

.mchips { gap: 10px; margin-top: 24px; }
.mchip { background: var(--bg); border: 1px solid rgba(255,255,255,0.03); border-radius: 16px; padding: 14px 8px; }
.mchip-v { font-size: 20px; font-family: system-ui, sans-serif; font-weight: 800; letter-spacing:-1px; }

.streak { background: rgba(255,106,0,0.08); border: 1px solid rgba(255,106,0,0.15); padding: 8px 14px; font-size: 14px; font-weight: 800; color: var(--orange); border-radius: 100px; }
.streak i { font-size: 16px; }

.fitscore-card { background: var(--bg2); border-radius: 20px; padding: 24px; border: 1px solid rgba(255,255,255,0.03); box-shadow: 0 10px 40px rgba(0,0,0,0.4); margin-bottom:20px; }
.fitscore-num { font-size: 56px; font-family: system-ui, sans-serif; letter-spacing:-2.5px; margin-bottom: -6px;}

.btn { border-radius: 16px; font-weight: 700; letter-spacing: 0; padding:16px; font-size: 16px;}
.btn-sm { padding:10px 18px; font-size: 14px; border-radius:12px; }

/* Bottom Navigation Polish */
.bnav { background: rgba(18,18,22,0.9); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border-top: 1px solid rgba(255,255,255,0.04); padding: 10px 0 max(10px, env(safe-area-inset-bottom)); border-radius: 28px 28px 0 0; }
.bnav a { text-transform: none; font-size: 11px; font-weight: 500; letter-spacing: 0.3px; color:var(--t3); transition: all .3s cubic-bezier(.34,1.56,.64,1); }
.bnav a .ni { font-size: 24px; margin-bottom: 4px; transition: all .3s cubic-bezier(.34,1.56,.64,1); }
.bnav a.on { color: var(--t1); font-weight: 700; }
.bnav a.on .ni { transform: translateY(-4px); color: var(--accent); }
"""
with open('css/style.css', 'a') as f:
    f.write(css_append)

print("Redesign V2 applied.")
