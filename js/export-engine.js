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
  try {
    const res = await fetch(url, { mode: 'cors' });
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('Failed to load image for PDF embedding:', url, e);
    return null;
  }
}

/**
 * Generates and downloads a structured PDF report for the given export model.
 */
export async function generatePDF(exportModel) {
  if (!exportModel || !exportModel.meta) throw new Error('Modello esportazione non valido');

  const jsPDFClass = await ensureJsPDFLoaded();
  const doc = new jsPDFClass({ unit: 'pt', format: 'a4' });

  const { meta, metrics, insights, actionPlan, dailyTable, workoutSessions, exerciseProgressions, checks } = exportModel;

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

  // 3. Detailed Workout Logs (OGNI SEDUTA DEL PERIODO)
  checkAddPage(100);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textColor);
  doc.text('3. Registro Dettagliato Sedute di Allenamento', 40, y);
  y += 14;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...mutedColor);
  doc.text(`Sedute completate nel periodo: ${metrics.training.completedCount} su ${metrics.training.plannedCount} pianificate.`, 40, y);
  y += 16;

  if (workoutSessions && workoutSessions.length > 0) {
    workoutSessions.forEach((s, idx) => {
      checkAddPage(100);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...primaryColor);
      doc.text(`Seduta ${idx + 1}: ${s.sessionName} (${s.date})`, 40, y);

      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...mutedColor);
      const metaLine = `Durata: ${s.durationMin ? `${s.durationMin} min` : 'N/D'}  |  Volume Totale: ${s.totalVolumeKg} kg${s.notes ? `  |  Note: ${s.notes}` : ''}`;
      doc.text(metaLine, 40, y + 11);
      y += 22;

      if (s.exercises && s.exercises.length > 0) {
        const exHeaders = [['Esercizio', 'Serie × Ripetizioni / Pesi / RPE', 'Carico Max', 'Volume (kg)']];
        const exRows = s.exercises.map(ex => [
          ex.name,
          ex.setsDetail || '—',
          `${ex.maxKg} kg`,
          `${ex.volume} kg`
        ]);

        if (doc.autoTable) {
          doc.autoTable({
            startY: y,
            head: exHeaders,
            body: exRows,
            theme: 'grid',
            headStyles: { fillColor: darkHeader, textColor: [255, 255, 255] },
            styles: { fontSize: 8 },
            columnStyles: { 0: { cellWidth: 140 }, 1: { cellWidth: 230 } },
            margin: { left: 40, right: 40 }
          });
          y = doc.lastAutoTable.finalY + 16;
        }
      }
    });
  } else {
    doc.setFontSize(9);
    doc.setTextColor(...mutedColor);
    doc.text('Nessuna seduta di allenamento registrata nel periodo selezionato.', 40, y);
    y += 20;
  }

  // 4. Progressioni Carichi per Esercizio
  if (exerciseProgressions && exerciseProgressions.length > 0) {
    checkAddPage(120);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textColor);
    doc.text('4. Progressioni Carichi per Esercizio', 40, y);
    y += 14;

    const progHeaders = [['Esercizio', 'Sedute', 'Carico Iniziale', 'Carico Max / Finale', 'Delta Peso', 'Volume Cumulato']];
    const progRows = exerciseProgressions.map(p => [
      p.name,
      `${p.sessionCount}`,
      `${p.initialLoad} kg`,
      `${p.finalLoad} kg`,
      `${p.deltaKg > 0 ? '+' : ''}${p.deltaKg} kg`,
      `${p.totalVolumeInPeriod} kg`
    ]);

    if (doc.autoTable) {
      doc.autoTable({
        startY: y,
        head: progHeaders,
        body: progRows,
        theme: 'striped',
        headStyles: { fillColor: primaryColor, textColor: [255, 255, 255] },
        styles: { fontSize: 8 },
        margin: { left: 40, right: 40 }
      });
      y = doc.lastAutoTable.finalY + 20;
    }
  }

  // 5. Check Corporei & Misure Antropometriche
  checkAddPage(120);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textColor);
  doc.text('5. Check Corporei e Misure Antropometriche', 40, y);
  y += 14;

  if (checks && checks.length > 0) {
    const checkHeaders = [['Data Check', 'Peso (kg)', 'Delta Peso', '% Massa Grassa', '% Massa Muscolare', 'Misure (cm) / Note']];
    const checkRows = checks.map(c => {
      const ms = c.measurements || {};
      const msParts = [];
      if (ms.chest) msParts.push(`Petto:${ms.chest}`);
      if (ms.waist) msParts.push(`Vita:${ms.waist}`);
      if (ms.bicep) msParts.push(`Braccia:${ms.bicep}`);
      if (ms.thigh) msParts.push(`Gambe:${ms.thigh}`);
      const msStr = msParts.length ? msParts.join(' ') : '—';

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
        margin: { left: 40, right: 40 }
      });
      y = doc.lastAutoTable.finalY + 20;
    }

    // Photo Gallery Section (if photos present)
    const photosToLoad = [];
    checks.forEach(c => {
      if (c.photos && c.photos.length > 0) {
        c.photos.forEach(p => {
          if (p.url) photosToLoad.push({ date: c.date, url: p.url, view: p.view });
        });
      }
    });

    if (photosToLoad.length > 0) {
      checkAddPage(150);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...primaryColor);
      doc.text(`📸 Foto Check Corporei (${photosToLoad.length} foto nel periodo)`, 40, y);
      y += 15;

      let photoX = 40;
      const photoWidth = 100;
      const photoHeight = 100;

      for (const item of photosToLoad) {
        if (photoX + photoWidth > 555) {
          photoX = 40;
          y += photoHeight + 30;
          checkAddPage(photoHeight + 30);
        }

        const dataUrl = await fetchImageAsDataURL(item.url);
        if (dataUrl) {
          try {
            doc.addImage(dataUrl, 'JPEG', photoX, y, photoWidth, photoHeight);
            doc.setFontSize(7.5);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...mutedColor);
            doc.text(`${item.date} (${item.view})`, photoX, y + photoHeight + 10);
          } catch (err) {
            console.warn('Failed to embed image into PDF:', err);
          }
        }
        photoX += photoWidth + 20;
      }
      y += photoHeight + 30;
    }
  } else {
    doc.setFontSize(9);
    doc.setTextColor(...mutedColor);
    doc.text('Nessun check-in registrato nel periodo selezionato.', 40, y);
    y += 20;
  }

  // 6. Dettaglio Giornaliero Completo (Nutrizione e Stato)
  checkAddPage(140);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textColor);
  doc.text('6. Registro Giornaliero Dieta & Allenamento', 40, y);
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
