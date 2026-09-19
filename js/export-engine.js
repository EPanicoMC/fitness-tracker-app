/**
 * Client-Side Read-Only Export Engine (PDF & CSV)
 * Lazy-loads jsPDF for clean client-side PDF document generation.
 */

// Helper to inject jsPDF script dynamically if not present
async function ensureJsPDFLoaded() {
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script.onload = () => {
      const autotableScript = document.createElement('script');
      autotableScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js';
      autotableScript.onload = () => resolve(window.jspdf.jsPDF);
      autotableScript.onerror = () => resolve(window.jspdf.jsPDF); // continue even if autotable fails
      document.head.appendChild(autotableScript);
    };
    script.onerror = () => reject(new Error('Impossibile caricare la libreria PDF'));
    document.head.appendChild(script);
  });
}

/**
 * Helper to fetch image URL and convert to DataURL (base64) for jsPDF embedding
 */
async function fetchImageAsDataURL(url) {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 300;
        canvas.height = img.naturalHeight || img.height || 300;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataURL = canvas.toDataURL('image/jpeg', 0.85);
        resolve(dataURL);
      } catch (e) {
        console.warn('Canvas toDataURL failed (CORS taint):', e);
        fetchBlob(url, resolve);
      }
    };
    img.onerror = () => fetchBlob(url, resolve);
    img.src = url;
  });
}

function fetchBlob(url, resolve) {
  fetch(url)
    .then(r => r.blob())
    .then(blob => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    })
    .catch(err => {
      console.warn('Blob fetch failed:', err);
      resolve(null);
    });
}

/**
 * Generates and downloads a structured PDF report for the given export model.
 */
export async function generatePDF(exportModel) {
  if (!exportModel || !exportModel.meta) throw new Error('Modello esportazione non valido');

  const jsPDFClass = await ensureJsPDFLoaded();
  const doc = new jsPDFClass({ unit: 'pt', format: 'a4' });

  const { meta, metrics, insights, actionPlan, dailyTable, checks } = exportModel;

  const primaryColor = [255, 106, 0];   // #ff6a00 (Accent Orange)
  const darkHeader = [35, 42, 47];      // #232a2f
  const textColor = [35, 42, 47];
  const mutedColor = [92, 105, 112];

  let y = 40;

  const checkAddPage = (neededSpace = 60) => {
    if (y + neededSpace > 780) {
      doc.addPage();
      y = 40;
    }
  };

  // Title & Header
  doc.setFontSize(20);
  doc.setTextColor(...primaryColor);
  doc.setFont('helvetica', 'bold');
  doc.text('KOVA. — Report Tecnico Fitness & Coach', 40, y);

  y += 18;
  doc.setFontSize(9);
  doc.setTextColor(...mutedColor);
  doc.setFont('helvetica', 'normal');
  doc.text(`Periodo: ${meta.dateFrom} – ${meta.dateTo}  |  Generato il: ${meta.generatedAt}`, 40, y);
  doc.text(`Giorni registrati: ${meta.daysLogged} su ${meta.totalDays}`, 40, y + 12);

  y += 28;
  doc.setDrawColor(220, 224, 226);
  doc.line(40, y, 555, y);

  // 1. Executive Summary & AI Insights
  y += 20;
  doc.setFontSize(13);
  doc.setTextColor(...textColor);
  doc.setFont('helvetica', 'bold');
  doc.text('1. Sintesi Analitica del Periodo', 40, y);

  y += 16;
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');

  const primaryInsightText = insights?.primary
    ? `📌 ${insights.primary.title}: ${insights.primary.evidence} → ${insights.primary.recommendedAction}`
    : 'Alimentazione ed allenamenti in linea con gli obiettivi previsti nel periodo.';

  const splitSummary = doc.splitTextToSize(primaryInsightText, 515);
  doc.text(splitSummary, 40, y);
  y += (splitSummary.length * 13) + 12;

  // 2. Energy & Macros Table
  checkAddPage(120);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('2. Calorie e Macronutrienti (Medie Giornaliere)', 40, y);
  y += 12;

  const nutHeaders = [['Metrica', 'Effettivo Medio', 'Target Dietetico', 'Scostamento Giornaliero']];
  const nutRows = [
    ['Calorie', `${metrics.calories.averageActual} kcal`, `${metrics.calories.averageTarget} kcal`, `${metrics.calories.averageDelta > 0 ? '+' : ''}${metrics.calories.averageDelta} kcal`],
    ['Proteine', `${metrics.protein.avgActual} g`, `${metrics.protein.avgTarget} g`, `${metrics.protein.avgDelta > 0 ? '+' : ''}${metrics.protein.avgDelta} g`],
    ['Grassi', `${metrics.fat.avgActual} g`, `${metrics.fat.avgTarget} g`, `${metrics.fat.avgDelta > 0 ? '+' : ''}${metrics.fat.avgDelta} g`],
    ['Carboidrati', `${metrics.carbs.avgActual} g`, `${metrics.carbs.avgTarget} g`, `${metrics.carbs.avgDelta > 0 ? '+' : ''}${metrics.carbs.avgDelta} g`],
  ];

  if (doc.autoTable) {
    doc.autoTable({
      startY: y,
      head: nutHeaders,
      body: nutRows,
      theme: 'striped',
      headStyles: { fillColor: primaryColor, textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 8.5 },
      margin: { left: 40, right: 40 }
    });
    y = doc.lastAutoTable.finalY + 20;
  }

  // 3. Check Corporei & Misure Antropometriche (con Foto)
  checkAddPage(140);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textColor);
  doc.text('3. Check Corporei e Misure Antropometriche', 40, y);
  y += 14;

  if (checks && checks.length > 0) {
    const POSE_SHORT_LABELS = {
      'frontale': 'Frontale',
      'laterale': 'Laterale',
      'schiena': 'Posteriore',
      'frontale_contratto': 'Front. contr.',
      'schiena_contratto': 'Post. contr.'
    };

    const checkHeaders = [['Data Check', 'Peso (kg)', 'Delta Peso', '% Grasso', '% Muscolo', 'Misure Antropometriche (cm) / Note']];
    const checkRows = checks.map(c => {
      const ms = c.measurements || {};
      const msParts = [];
      if (ms.waist_navel != null) msParts.push(`Vita omb:${ms.waist_navel}`);
      if (ms.neck != null) msParts.push(`Collo:${ms.neck}`);
      if (ms.chest != null) msParts.push(`Torace:${ms.chest}`);
      if (ms.shoulders != null) msParts.push(`Spalle:${ms.shoulders}`);
      if (ms.hips != null) msParts.push(`Fianchi:${ms.hips}`);
      if (ms.bicep_r_flex != null) msParts.push(`Braccio dx:${ms.bicep_r_flex}`);
      if (ms.thigh_r != null) msParts.push(`Coscia dx:${ms.thigh_r}`);
      const msStr = msParts.length ? msParts.join(' | ') : '—';

      return [
        c.date,
        c.weight ? `${c.weight} kg` : '—',
        c.weightDelta !== null ? `${c.weightDelta > 0 ? '+' : ''}${c.weightDelta} kg` : '—',
        c.bodyFat ? `${c.bodyFat}%` : '—',
        c.muscleMass ? `${c.muscleMass}%` : '—',
        `${msStr}${c.notes ? ` (${c.notes})` : ''}`
      ];
    });

    if (doc.autoTable) {
      doc.autoTable({
        startY: y,
        head: checkHeaders,
        body: checkRows,
        theme: 'grid',
        headStyles: { fillColor: darkHeader, textColor: [255, 255, 255] },
        styles: { fontSize: 8 },
        columnStyles: { 5: { cellWidth: 220 } },
        margin: { left: 40, right: 40 }
      });
      y = doc.lastAutoTable.finalY + 20;
    }

    // Photo Gallery Section (if photos present)
    const photosToLoad = [];
    checks.forEach(c => {
      if (c.photos && c.photos.length > 0) {
        c.photos.forEach(p => {
          if (p.url) photosToLoad.push({ date: c.date, url: p.url, view: p.view || 'frontale' });
        });
      }
    });

    if (photosToLoad.length > 0) {
      checkAddPage(160);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...primaryColor);
      doc.text(`📸 Foto Check Corporei (${photosToLoad.length} foto disponibili)`, 40, y);
      y += 15;

      let photoX = 40;
      const photoWidth = 110;
      const photoHeight = 110;

      for (const item of photosToLoad) {
        if (photoX + photoWidth > 555) {
          photoX = 40;
          y += photoHeight + 35;
          checkAddPage(photoHeight + 35);
        }

        const dataUrl = await fetchImageAsDataURL(item.url);
        const poseLabel = POSE_SHORT_LABELS[item.view] || item.view;
        if (dataUrl) {
          try {
            doc.addImage(dataUrl, 'JPEG', photoX, y, photoWidth, photoHeight);
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...mutedColor);
            doc.text(`${item.date} (${poseLabel})`, photoX, y + photoHeight + 12);
          } catch (err) {
            console.warn('Failed to embed image into PDF:', err);
          }
        } else {
          doc.setDrawColor(200, 200, 200);
          doc.setFillColor(245, 245, 245);
          doc.rect(photoX, y, photoWidth, photoHeight, 'FD');
          doc.setFontSize(8);
          doc.setTextColor(...mutedColor);
          doc.text(`📸 ${item.date}`, photoX + 10, y + 50);
          doc.text(`(${poseLabel})`, photoX + 10, y + 65);
        }
        photoX += photoWidth + 20;
      }
      y += photoHeight + 35;
    }
  } else {
    doc.setFontSize(9);
    doc.setTextColor(...mutedColor);
    doc.text('Nessun check-in registrato nel periodo selezionato.', 40, y);
    y += 20;
  }

  // 4. Registro Giornaliero Dieta & Allenamento
  checkAddPage(140);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textColor);
  doc.text('4. Registro Giornaliero Dieta & Allenamento', 40, y);
  y += 14;

  const dailyHeaders = [['Data', 'Stato', 'Calorie (Eff/Tgt)', 'Proteine', 'Grassi', 'Carbo', 'Workout']];
  const dailyRows = dailyTable.map(d => [
    d.date,
    d.status,
    `${d.kcalActual} / ${d.kcalTarget}`,
    `${d.proteinActual}g`,
    `${d.fatActual}g`,
    `${d.carbsActual}g`,
    d.workout
  ]);

  if (doc.autoTable) {
    doc.autoTable({
      startY: y,
      head: dailyHeaders,
      body: dailyRows,
      theme: 'grid',
      headStyles: { fillColor: darkHeader, textColor: [255, 255, 255] },
      styles: { fontSize: 8 },
      margin: { left: 40, right: 40 }
    });
    y = doc.lastAutoTable.finalY + 20;
  }

  // Save PDF
  const filename = `report-coach_${meta.dateFrom}_${meta.dateTo}.pdf`;
  doc.save(filename);
  return filename;
}

/**
 * Generates and downloads a CSV export file.
 */
export function generateCSV(exportModel) {
  if (!exportModel || !exportModel.dailyTable) throw new Error('Modello esportazione non valido');

  const headers = ['Data', 'Stato', 'Calorie_Actual', 'Calorie_Target', 'Calorie_Delta', 'Proteine_g', 'Grassi_g', 'Carboidrati_g', 'Workout'];
  const rows = exportModel.dailyTable.map(d => [
    d.date,
    d.status,
    d.kcalActual,
    d.kcalTarget,
    d.kcalDelta,
    d.proteinActual,
    d.fatActual,
    d.carbsActual,
    `"${d.workout.replace(/"/g, '""')}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const filename = `andamento-fitness_${exportModel.meta.dateFrom}_${exportModel.meta.dateTo}.csv`;

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return filename;
}
