import os
import re

css_path = 'css/style.css'
with open(css_path, 'r') as f:
    css = f.read()

# 1. Update css variables
new_vars = """:root {
  --bg:#111111; --bg2:#1b1b1d; --bg3:#242427; --bg4:#2a2a2e;
  --accent:#ff6a00; --accent2:#ff8a33;
  --green:#1ce370; --orange:#ff6a00; --red:#ff453a;
  --blue:#3a86ff; --yellow:#ffc300; --purple:#b5179e;
  --t1:#f5f5f2; --t2:#a7a7ad; --t3:#6e6e73;
  --border:#2f2f33; --border2:rgba(255,106,0,0.25);
  --r:14px; --rs:10px; --rl:26px;
  --shadow:0 8px 30px rgba(0,0,0,0.4);
  --glow:0 0 25px rgba(255,106,0,0.15);
}"""
css = re.sub(r':root\s*\{[^}]+\}', new_vars, css)

# 2. Update cards and clean gradients
css = re.sub(r'\.card\{([^}]+)\}', r'.card{background:var(--bg3);border-radius:var(--r);padding:24px 20px;margin-bottom:16px;border:1px solid var(--border);box-shadow:var(--shadow);animation:fup .3s ease both}', css)
css = re.sub(r'\.card-glow\{[^}]+\}', r'.card-glow{border-color:var(--border2);box-shadow:var(--shadow)}', css)
css = re.sub(r'\.card-glow::before\{[^}]+\}', r'', css)
css = re.sub(r'\.card-g\{[^}]+\}', r'.card-g{border-color:rgba(28,227,112,0.3);box-shadow:var(--shadow)}', css)
css = re.sub(r'\.card-o\{[^}]+\}', r'.card-o{border-color:rgba(255,106,0,0.3);box-shadow:var(--shadow)}', css)

# 3. Kcal Big text - remove gradient, make it intense white
css = re.sub(r'\.kcal-big\{([^}]+)\}', r'.kcal-big{font-size:56px;font-weight:900;letter-spacing:-3px;line-height:1;color:var(--t1)}', css)

# 4. Progress bar gradients
css = re.sub(r'\.pb-v\{[^}]+\}', r'.pb-v{background:var(--accent)}', css)
css = re.sub(r'\.pb-g\{[^}]+\}', r'.pb-g{background:var(--green)}', css)
css = re.sub(r'\.pb-pro\{[^}]+\}', r'.pb-pro{background:var(--blue)}', css)
css = re.sub(r'\.pb-carb\{[^}]+\}', r'.pb-carb{background:var(--yellow)}', css)
css = re.sub(r'\.pb-fat\{[^}]+\}', r'.pb-fat{background:var(--purple)}', css)

# 5. Buttons flat design
css = re.sub(r'\.btn-v\{[^}]+\}', r'.btn-v{background:var(--accent);color:#fff;box-shadow:none}', css)
css = re.sub(r'\.btn-g\{[^}]+\}', r'.btn-g{background:var(--green);color:#000;box-shadow:none}', css)
css = re.sub(r'\.btn-o\{[^}]+\}', r'.btn-o{background:var(--orange);color:#fff;box-shadow:none}', css)

# 6. Adjust bnav colors
css = re.sub(r'\.bnav a\.on\{[^}]+\}', r'.bnav a.on{color:var(--t1)}', css)
css = re.sub(r'\.bnav a\.on \.ni\{[^}]+\}', r'.bnav a.on .ni{filter:none;transform:scale(1.1);color:var(--accent)}', css)
css = css.replace('.bnav a.on-o{color:var(--orange)}', '.bnav a.on-o{color:var(--t1)}')
css = css.replace('.bnav a.on-o .ni{filter:drop-shadow(0 0 8px var(--orange));transform:scale(1.1)}', '.bnav a.on-o .ni{filter:none;transform:scale(1.1);color:var(--accent)}')

# 7. Fitscore card cleanup
css = re.sub(r'\.fitscore-card\{[^}]+\}', r'.fitscore-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:24px 20px;margin-bottom:16px;box-shadow:var(--shadow)}', css)

# Fix empty generated before
css = css.replace(".card-glow::before{}", "")

with open(css_path, 'w') as f:
    f.write(css)

# Updates to HTML
html_files = [f for f in os.listdir('.') if f.endswith('.html')]
for file in html_files:
    with open(file, 'r') as f:
        content = f.read()
    content = content.replace('<title>FitTracker</title>', '<title>KOVA.</title>')
    if file == 'index.html':
        old_header = """    <div>
      <p id="welcome-name" style="font-size:11px;color:var(--t2);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Benvenuto</p>
      <h1 style="font-size:28px;font-weight:900;letter-spacing:-1px">FitTracker 🏋️</h1>
      <p id="date-label" style="font-size:13px;color:var(--t2);margin-top:4px"></p>
    </div>"""
        new_header = """    <div>
      <h1 style="font-size:32px;font-weight:900;letter-spacing:-1px;color:var(--t1)">KOVA.</h1>
      <p style="font-size:12px;color:var(--accent);font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-top:2px">Costanza. Dati. Risultati.</p>
      <p id="welcome-name" style="font-size:14px;color:var(--t2);font-weight:600;margin-top:16px">Benvenuto</p>
      <p id="date-label" style="font-size:12px;color:var(--t3);margin-top:2px;font-weight:700"></p>
    </div>"""
        content = content.replace(old_header, new_header)
        # Fix manifest/theme color
        content = content.replace('<meta name="theme-color" content="#7c6fff">', '<meta name="theme-color" content="#111111">')
    if file == 'settings.html':
        content = content.replace('FitTracker v2.0', 'KOVA. v3.0')
        content = content.replace('<meta name="theme-color" content="#7c6fff">', '<meta name="theme-color" content="#111111">')
    with open(file, 'w') as f:
        f.write(content)

print("Redesign script completed.")
