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
 * Generates and downloads a structured PDF report for the given export model.
 */
export async function generatePDF(exportModel) {
  if (!exportModel || !exportModel.meta) throw new Error('Modello esportazione non valido');

  const jsPDFClass = await ensureJsPDFLoaded();
  const doc = new jsPDFClass({ unit: 'pt', format: 'a4' });

  const { meta, metrics, insights, actionPlan, dailyTable } = exportModel;

  const primaryColor = [255, 106, 0];   // #ff6a00 (Accent)
  const textColor = [35, 42, 47];      // #232a2f
  const mutedColor = [92, 105, 112];   // #5c6970

  let y = 40;

  // Title & Header
  doc.setFontSize(22);
  doc.setTextColor(...primaryColor);
  doc.setFont('helvetica', 'bold');
  doc.text('KOVA. — Andamento Fitness', 40, y);

  y += 20;
  doc.setFontSize(10);
  doc.setTextColor(...mutedColor);
  doc.setFont('helvetica', 'normal');
  doc.text(`Periodo: ${meta.dateFrom} – ${meta.dateTo}  |  Generato il: ${meta.generatedAt}`, 40, y);
  doc.text(`Giorni registrati: ${meta.daysLogged} su ${meta.totalDays}`, 40, y + 14);

  y += 35;
  doc.setDrawColor(220, 224, 226);
  doc.line(40, y, 555, y);

  // Section 1: Executive Summary
  y += 20;
  doc.setFontSize(14);
  doc.setTextColor(...textColor);
  doc.setFont('helvetica', 'bold');
  doc.text('1. Sintesi del Periodo', 40, y);

  y += 18;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  const primaryInsightText = insights.primary
    ? `${insights.primary.title}: ${insights.primary.evidence}`
    : 'Alimentazione ed allenamenti in linea con gli obiettivi previsti.';

  const splitSummary = doc.splitTextToSize(primaryInsightText, 515);
  doc.text(splitSummary, 40, y);
  y += (splitSummary.length * 14) + 10;

  // Section 2: Energy & Macros Table
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('2. Calorie e Macronutrienti (Medie Giornaliere)', 40, y);
  y += 15;

  const tableHeaders = [['Metrica', 'Effettivo', 'Target', 'Scostamento / Giorno']];
  const tableRows = [
    ['Calorie', `${metrics.calories.averageActual} kcal`, `${metrics.calories.averageTarget} kcal`, `${metrics.calories.averageDelta > 0 ? '+' : ''}${metrics.calories.averageDelta} kcal`],
    ['Proteine', `${metrics.protein.avgActual} g`, `${metrics.protein.avgTarget} g`, `${metrics.protein.avgDelta > 0 ? '+' : ''}${metrics.protein.avgDelta} g`],
    ['Grassi', `${metrics.fat.avgActual} g`, `${metrics.fat.avgTarget} g`, `${metrics.fat.avgDelta > 0 ? '+' : ''}${metrics.fat.avgDelta} g`],
    ['Carboidrati', `${metrics.carbs.avgActual} g`, `${metrics.carbs.avgTarget} g`, `${metrics.carbs.avgDelta > 0 ? '+' : ''}${metrics.carbs.avgDelta} g`],
  ];

  if (doc.autoTable) {
    doc.autoTable({
      startY: y,
      head: tableHeaders,
      body: tableRows,
      theme: 'striped',
      headStyles: { fillColor: primaryColor },
      margin: { left: 40, right: 40 }
    });
    y = doc.lastAutoTable.finalY + 20;
  } else {
    // Fallback if autoTable not available
    tableRows.forEach(row => {
      doc.text(`${row[0]}: ${row[1]} / ${row[2]} (${row[3]})`, 40, y);
      y += 14;
    });
    y += 15;
  }

  // Section 3: Training Summary
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('3. Allenamenti', 40, y);
  y += 18;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Allenamenti completati: ${metrics.training.completedCount} su ${metrics.training.plannedCount} pianificati.`, 40, y);
  y += 25;

  // Section 4: Daily Breakdown Table
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('4. Dettaglio Giornaliero', 40, y);
  y += 15;

  const dailyHeaders = [['Data', 'Stato', 'Kcal', 'Proteine', 'Grassi', 'Carbo', 'Workout']];
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
      headStyles: { fillColor: [50, 60, 70] },
      styles: { fontSize: 8 },
      margin: { left: 40, right: 40 }
    });
  }

  // Save PDF
  const filename = `andamento-fitness_${meta.dateFrom}_${meta.dateTo}.pdf`;
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
