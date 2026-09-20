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
 * Converts an image URL or Base64 string to a clean DataURL for jsPDF embedding.
 * Handles:
 * - Direct Base64 Data URLs (data:image/...)
 * - Firebase Storage URLs via fetch + blob + FileReader
 * - Format conversion to JPEG/PNG for jsPDF compatibility
 * - Canvas fallback for CORS / non-standard images
 */
async function fetchImageAsDataURL(url) {
  if (!url) return null;

  // Case 1: Already a Base64 Data URL
  if (typeof url === 'string' && url.startsWith('data:')) {
    if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg') || url.startsWith('data:image/png')) {
      return url;
    }
    return convertToJpegDataURL(url);
  }

  // Case 2: HTTP / Firebase Storage URL - Strategy A (fetch blob)
  try {
    const res = await fetch(url);
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 0) {
        const dataURL = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        if (dataURL && (dataURL.startsWith('data:image/jpeg') || dataURL.startsWith('data:image/jpg') || dataURL.startsWith('data:image/png'))) {
          return dataURL;
        }
        if (dataURL && dataURL.startsWith('data:image/')) {
          return await convertToJpegDataURL(dataURL);
        }
      }
    }
  } catch (e) {
    console.warn('[PDF Export] Fetch blob failed for', url, e);
  }

  // Case 3: Strategy B (Image + Canvas fallback)
  return await convertToJpegDataURL(url);
}

function convertToJpegDataURL(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 400;
        canvas.height = img.naturalHeight || 400;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        console.warn('[PDF Export] Canvas conversion failed:', err);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 8000);
    img.src = src;
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

    const checkHeaders = [['Data Check', 'Peso (kg)', 'Delta Peso', '% Grasso', '% Muscolo', 'Misure Antropometriche & Note Coach']];
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
      const msStr = msParts.length ? msParts.join(' | ') : '';

      const noteLines = [];
      if (msStr) noteLines.push(msStr);
      if (c.notes) noteLines.push(`📝 Note: ${c.notes}`);
      if (c.aiAnalysis) {
        const coachText = typeof c.aiAnalysis === 'string'
          ? c.aiAnalysis
          : (c.aiAnalysis.analisi?.valutazione || c.aiAnalysis.sintesi || JSON.stringify(c.aiAnalysis));
        noteLines.push(`🤖 Note Coach: ${coachText}`);
      }

      return [
        c.date,
        c.weight ? `${c.weight} kg` : '—',
        c.weightDelta !== null ? `${c.weightDelta > 0 ? '+' : ''}${c.weightDelta} kg` : '—',
        c.bodyFat ? `${c.bodyFat}%` : '—',
        c.muscleMass ? `${c.muscleMass}%` : '—',
        noteLines.join('\n') || '—'
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
          // Support both old format (plain string URL) and new format ({url, view} object)
          const photoUrl = typeof p === 'string' ? p : p?.url;
          const photoView = typeof p === 'string' ? 'frontale' : (p?.view || 'frontale');
          if (photoUrl) photosToLoad.push({ date: c.date, url: photoUrl, view: photoView });
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
      let embedCount = 0;

      console.log(`[PDF Export] Starting photo embed: ${photosToLoad.length} photos to process`);

      for (let i = 0; i < photosToLoad.length; i++) {
        const item = photosToLoad[i];
        if (photoX + photoWidth > 555) {
          photoX = 40;
          y += photoHeight + 35;
          checkAddPage(photoHeight + 35);
        }

        console.log(`[PDF Export] Loading photo ${i + 1}/${photosToLoad.length}: ${item.date} (${item.view})`);
        const dataUrl = await fetchImageAsDataURL(item.url);
        const poseLabel = POSE_SHORT_LABELS[item.view] || item.view;

        if (dataUrl) {
          try {
            const imgFormat = dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
            doc.addImage(dataUrl, imgFormat, photoX, y, photoWidth, photoHeight);
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...mutedColor);
            doc.text(`${item.date} (${poseLabel})`, photoX, y + photoHeight + 12);
            embedCount++;
            console.log(`[PDF Export] ✅ Photo ${i + 1} embedded successfully`);
          } catch (err) {
            console.warn(`[PDF Export] ❌ addImage failed for photo ${i + 1}:`, err);
            doc.setDrawColor(200, 200, 200);
            doc.setFillColor(245, 245, 245);
            doc.rect(photoX, y, photoWidth, photoHeight, 'FD');
            doc.setFontSize(8);
            doc.setTextColor(...mutedColor);
            doc.text(`📸 ${item.date}`, photoX + 10, y + 50);
            doc.text(`(${poseLabel})`, photoX + 10, y + 65);
          }
        } else {
          console.warn(`[PDF Export] ❌ fetchImageAsDataURL returned null for photo ${i + 1}: ${item.url.substring(0, 80)}...`);
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
      console.log(`[PDF Export] Photo embedding complete: ${embedCount}/${photosToLoad.length} successful`);
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

  const dailyHeaders = [['Data', 'Stato', 'Peso', 'Passi', 'Calorie (Eff/Tgt)', 'Proteine', 'Grassi', 'Carbo', 'Workout']];
  const dailyRows = dailyTable.map(d => [
    d.date,
    d.status,
    d.weightKg ? `${d.weightKg} kg` : '—',
    d.steps ? `${d.steps.toLocaleString('it-IT')}` : '—',
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
      styles: { fontSize: 7.5 },
      margin: { left: 40, right: 40 }
    });
    y = doc.lastAutoTable.finalY + 20;
  }
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
