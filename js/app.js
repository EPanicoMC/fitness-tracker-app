export function getTodayString() {
  return new Date().toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).split('/').reverse().join('-');
}

export function getYesterdayString() {
  const now = new Date();
  const italyNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  italyNow.setDate(italyNow.getDate() - 1);
  return italyNow.toISOString().split('T')[0];
}

export function getDayOfWeek(dateStr) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  if (dateStr) {
    const [y,m,d] = dateStr.split('-').map(Number);
    return days[new Date(y, m-1, d).getDay()];
  }
  const italyDate = new Date().toLocaleDateString('en-US', {
    timeZone: 'Europe/Rome', weekday: 'long'
  }).toLowerCase();
  const map = {
    monday:'monday', tuesday:'tuesday', wednesday:'wednesday',
    thursday:'thursday', friday:'friday', saturday:'saturday', sunday:'sunday'
  };
  return map[italyDate] || days[new Date().getDay()];
}
export function formatDateIT(str) {
  const [y,m,d] = str.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
}
export function formatDateShort(str) {
  const [y,m,d] = str.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString('it-IT',{weekday:'short',day:'numeric',month:'short'});
}
export function addDays(str, n) {
  const [y,m,d] = str.split('-').map(Number);
  const dt = new Date(y,m-1,d); dt.setDate(dt.getDate()+n);
  return dt.toISOString().split('T')[0];
}
export function showToast(msg, type='ok') {
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t=document.createElement('div'); t.className=`toast toast-${type}`; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),3000);
}
export function showModal(opts) {
  const bg=document.createElement('div'); bg.className='modal-bg';
  bg.innerHTML=`<div class="modal"><div class="modal-handle"></div><h3>${opts.title}</h3>${opts.text?`<p>${opts.text}</p>`:''}<div class="modal-btns"><button class="btn btn-flat btn-cancel">${opts.cancelLabel||'Annulla'}</button><button class="btn ${opts.confirmClass||'btn-r'} btn-ok">${opts.confirmLabel||'Conferma'}</button></div></div>`;
  document.body.appendChild(bg);
  bg.querySelector('.btn-cancel').onclick=()=>{bg.remove();opts.onCancel?.()};
  bg.querySelector('.btn-ok').onclick=()=>{bg.remove();opts.onConfirm?.()};
  bg.onclick=e=>{if(e.target===bg){bg.remove();opts.onCancel?.()}};
}
export function setW(id,pct){const e=document.getElementById(id);if(e)e.style.width=Math.min(Math.max(pct,0),100)+'%'}
export function setT(id,v){const e=document.getElementById(id);if(e)e.textContent=v}
export function fmtTimer(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
export const DAYS_IT={monday:'Lunedì',tuesday:'Martedì',wednesday:'Mercoledì',thursday:'Giovedì',friday:'Venerdì',saturday:'Sabato',sunday:'Domenica'};
export const DAY_ORDER=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

export async function cleanOldLogs(db, USER_ID, monthsToKeep=12) {
  try {
    const { collection, getDocs, deleteDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const snap = await getDocs(collection(db, 'users', USER_ID, 'daily_logs'));
    const toDelete = snap.docs.filter(d => d.id < cutoffStr);
    await Promise.all(toDelete.map(d => deleteDoc(doc(db, 'users', USER_ID, 'daily_logs', d.id))));
    if (toDelete.length) console.log(`cleanOldLogs: deleted ${toDelete.length} logs older than ${cutoffStr}`);
  } catch(e) {
    console.warn('cleanOldLogs error:', e);
  }
}
