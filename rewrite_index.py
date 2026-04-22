import re

html_content = """<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>KOVA.</title>
  <link href="https://cdn.jsdelivr.net/npm/remixicon@4.2.0/fonts/remixicon.css" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
  <link rel="manifest" href="manifest.json">
  <meta name="theme-color" content="#111111">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icon.svg">
</head>
<body class="minimal-dark">
<div class="wrap" style="padding-top:20px; padding-bottom:100px;">

  <!-- HEADER DOGMA STYLE -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;">
    <h1 style="font-size:18px;font-weight:900;letter-spacing:1px;color:var(--t1)">KOVA.</h1>
    <div style="display:flex;align-items:center;gap:16px">
      <div id="streak-box"></div>
      <a href="settings.html" style="color:var(--t2);font-size:20px"><i class="ri-notification-3-line"></i></a>
    </div>
  </div>

  <div style="margin-top:40px;">
    <p id="welcome-name" style="font-size:10px;color:var(--t3);font-weight:800;letter-spacing:2px;text-transform:uppercase">BENVENUTO</p>
    <h2 style="font-size:38px;font-weight:500;letter-spacing:-1.5px;line-height:1.05;margin-top:8px;color:#fff">
      Sei più forte<br>di quanto pensi.
    </h2>
    <div id="date-label" style="display:none"></div>
  </div>

  <!-- THE BIG RING (KCAL COMPLETION) -->
  <div style="display:flex;justify-content:center;margin:50px 0 60px;">
    <div id="cring-box" class="cring-giant"></div>
  </div>

  <!-- OVERVIEW / PANORAMICA TITLE -->
  <div style="font-size:10px;font-weight:800;color:var(--t3);letter-spacing:2px;margin-bottom:16px">PANORAMICA</div>
  
  <div class="pano-list">
    <!-- DAY TYPE -->
    <div class="pano-card tgl-row">
      <div class="pano-icon"><i class="ri-calendar-event-fill"></i></div>
      <div class="pano-info" style="flex:1">
        <div class="pano-label" id="dtype-label">GIORNO</div>
        <div class="pano-val" id="dtype-sub" style="font-size:10px;color:var(--t3);margin-top:2px;text-transform:none"></div>
      </div>
      <label class="tgl"><input type="checkbox" id="override-tgl"><span class="tgl-s"></span></label>
    </div>

    <!-- ALLENAMENTI -->
    <div class="pano-card" onclick="location.href='programs.html'">
      <div class="pano-icon"><i class="ri-line-chart-line"></i></div>
      <div class="pano-info">
        <div class="pano-label">ALLENAMENTO</div>
        <div class="pano-val">Vedi Scheda Attiva</div>
      </div>
      <i class="ri-arrow-right-s-line pano-arrow"></i>
    </div>

    <!-- CALORIE -->
    <div class="pano-card" onclick="location.href='diet.html'">
      <div class="pano-icon"><i class="ri-drop-line"></i></div>
      <div class="pano-info">
        <div class="pano-label">CALORIE</div>
        <div class="pano-val"><span id="kcal-now" style="color:#fff;font-weight:700">0</span> <span style="font-size:11px;color:var(--t3)">/ <span id="kcal-tgt">0</span></span></div>
      </div>
      <i class="ri-arrow-right-s-line pano-arrow"></i>
    </div>

    <!-- PASSI -->
    <div class="pano-card" onclick="location.href='programs.html'">
      <div class="pano-icon"><i class="ri-time-line"></i></div>
      <div class="pano-info">
        <div class="pano-label">PASSI ATTIVI</div>
        <div class="pano-val" style="display:flex;align-items:center">
          <input type="number" id="steps-in" readonly style="background:transparent;border:0;color:#fff;font-size:14px;font-weight:700;width:50px;text-align:right" placeholder="0">
        </div>
      </div>
      <i class="ri-arrow-right-s-line pano-arrow"></i>
    </div>
  </div>

  <div style="font-size:10px;font-weight:800;color:var(--t3);letter-spacing:2px;margin-top:30px;margin-bottom:16px">MACRONUTRIENTI</div>
  <div class="mchips-dogma" style="display:flex;gap:12px;margin-bottom:30px">
    <div class="mchip mchip-min">
      <div class="mdot" style="background:#fff"></div>
      <div>
        <div class="mchip-l">Proteine</div>
        <div class="mchip-v" id="mc-pro">0g</div>
      </div>
    </div>
    <div class="mchip mchip-min">
      <div class="mdot" style="background:var(--t2)"></div>
      <div>
        <div class="mchip-l">Carbo</div>
        <div class="mchip-v" id="mc-carb">0g</div>
      </div>
    </div>
    <div class="mchip mchip-min">
      <div class="mdot" style="background:var(--t3)"></div>
      <div>
        <div class="mchip-l">Grassi</div>
        <div class="mchip-v" id="mc-fat">0g</div>
      </div>
    </div>
  </div>

  <!-- Hidden elements needed by daily_state.js to avoid crash/state loss -->
  <div style="display:none">
    <div id="kcal-delta"></div>
    <div id="pb-kcal"></div>
    <input type="number" id="burned-in">
    <textarea id="note-in"></textarea>
    <div id="fitscore-box"></div>
  </div>

</div>

<nav class="bnav">
  <a href="index.html" class="on"><i class="ri-home-5-fill ni"></i><span>Home</span></a>
  <a href="programs.html"><i class="ri-file-list-3-fill ni"></i><span>Schede</span></a>
  <a href="diet.html"><i class="ri-restaurant-fill ni"></i><span>Dieta</span></a>
  <!-- Aggiungo il tasto centrale Salva per staccarlo in stile dogma -->
  <div class="save-fab" onclick="saveDay()">
    <i class="ri-check-line"></i>
  </div>
  <a href="diary.html"><i class="ri-calendar-todo-fill ni"></i><span>Diario</span></a>
  <a href="session.html"><i class="ri-play-circle-fill ni"></i><span>Allenati</span></a>
</nav>

<script type="module" src="js/daily_state.js"></script>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/fitness-tracker-app/sw.js')</script>
</body>
</html>
"""

with open('index.html', 'w') as f:
    f.write(html_content)

css_append = """
/* =========================================
   DOGMA STYLE RESPONSIVE
   ========================================= */
body.minimal-dark {
  background: #111111;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

/* BIG RING */
.cring-giant {
  width: 180px; 
  height: 180px; 
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cring-giant .cring { width: 100%; height: 100%; }
.cring-giant .cring svg {
  width: 100%; height: 100%;
  filter: drop-shadow(0 0 10px rgba(200,255,0,0.5)); /* Lime or Orange */
  transform: rotate(-90deg);
}
.cring-giant .cring circle:nth-child(2) {
  stroke: var(--orange); /* Use orange per user request */
  filter: drop-shadow(0 0 8px rgba(255, 106, 0, 0.4));
}
.cring-giant .cring-n {
  position: absolute;
  top: 45%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 42px !important;
  font-weight: 700;
  letter-spacing: -2px;
}
.cring-giant .cring::after {
  content: 'OBIETTIVO';
  position: absolute;
  top: 68%; left: 50%;
  transform: translateX(-50%);
  font-size: 8px;
  letter-spacing: 2px;
  color: var(--t3);
  font-weight: 800;
  opacity: 0.8;
}

/* PANORAMICA LIST */
.pano-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pano-card {
  display: flex;
  align-items: center;
  background: #1c1c1e;
  border-radius: 16px;
  padding: 16px 20px;
  cursor: pointer;
  transition: transform 0.1s ease;
}
.pano-card:active { transform: scale(0.98); }
.pano-icon {
  width: 32px;
  font-size: 20px;
  color: var(--t3);
}
.pano-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pano-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--t2);
  text-transform: uppercase;
}
.pano-val {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}
.pano-arrow {
  color: var(--t3);
  font-size: 20px;
}
.tgl-row { cursor: default; }
.tgl-row:active { transform: none; }

/* DOGMA STYLE MACRO CHIPS */
.mchip-min {
  background: transparent !important;
  border: none !important;
  padding: 0 !important;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
  justify-content: flex-start;
}
.mchip-min .mdot {
  width: 6px; height: 6px; border-radius: 50%;
  margin-top: 5px;
}
.mchip-min .mchip-l {
  font-size: 9px !important;
  color: var(--t3) !important;
  font-weight: 800 !important;
  text-transform: uppercase;
  order: 2;
  margin-bottom: 0;
}
.mchip-min .mchip-v {
  font-size: 14px !important;
  font-weight: 700 !important;
  color: #fff !important;
  order: 1;
}

/* SAVE FAB (Floating action button minimal in nav) */
.save-fab {
  background: var(--orange);
  color: #111;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 24px;
  margin-top: -24px;
  box-shadow: 0 4px 12px rgba(255, 106, 0, 0.4);
  cursor: pointer;
}
.save-fab:active { transform: scale(0.95); }
.bnav a { flex: 1; }
"""

with open('css/style.css', 'a') as f:
    f.write(css_append)

print("Home minimal-dogma applied.")
