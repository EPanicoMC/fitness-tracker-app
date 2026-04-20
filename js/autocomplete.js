import { db as defaultDb, USER_ID as defaultUID, getDocs, collection } from './firebase-config.js';
import { doc, setDoc } from './firebase-config.js';

export class Autocomplete {
  constructor({ inputEl, collection: colName, db, USER_ID, onSelect, onCustom }) {
    this.inputEl   = inputEl;
    this.colName   = colName;
    this.db        = db || defaultDb;
    this.USER_ID   = USER_ID || defaultUID;
    this.onSelect  = onSelect;
    this.onCustom  = onCustom;
    this.dropdown  = null;
    this._destroyed = false;
    this.init();
  }

  init() {
    this.dropdown = document.createElement('div');
    this.dropdown.className = 'ac-dropdown';
    this.dropdown.style.cssText =
      'position:absolute;z-index:200;width:100%;background:#1c1c35;' +
      'border:1px solid rgba(124,111,255,.3);border-radius:12px;' +
      'max-height:200px;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.5);' +
      'display:none;margin-top:4px;';

    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    this.inputEl.parentNode.insertBefore(wrap, this.inputEl);
    wrap.appendChild(this.inputEl);
    wrap.appendChild(this.dropdown);

    this._onInput = () => this.search();
    this._onBlur  = () => setTimeout(() => { if (!this._destroyed) this.hide(); }, 200);
    this.inputEl.addEventListener('input', this._onInput);
    this.inputEl.addEventListener('blur',  this._onBlur);
  }

  async search() {
    const q = this.inputEl.value.trim().toLowerCase();
    if (q.length < 1) { this.hide(); return; }

    try {
      const snap = await getDocs(collection(this.db, 'users', this.USER_ID, this.colName));
      const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const filtered = all.filter(item => item.name?.toLowerCase().includes(q));
      this.show(filtered, q);
    } catch(e) {
      console.warn('Autocomplete search error:', e);
    }
  }

  show(items, query) {
    this.dropdown.innerHTML = '';

    items.slice(0, 8).forEach(item => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:11px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px;font-weight:600;color:#eeeeff;';
      div.textContent = item.name;
      if (item.kcal_per_100g != null) {
        const sub = document.createElement('span');
        sub.style.cssText = 'display:block;font-size:11px;color:#7878a0;font-weight:400;margin-top:2px;';
        sub.textContent = `${item.kcal_per_100g} kcal/100g · P:${item.protein_per_100g}g C:${item.carbs_per_100g}g F:${item.fats_per_100g}g`;
        div.appendChild(sub);
      }
      div.addEventListener('mousedown', () => {
        this.inputEl.value = item.name;
        this.onSelect?.(item);
        this.hide();
      });
      this.dropdown.appendChild(div);
    });

    if (query) {
      const custom = document.createElement('div');
      custom.style.cssText = 'padding:11px 16px;cursor:pointer;font-size:13px;color:#7c6fff;font-weight:700;';
      custom.textContent = `+ Aggiungi "${this.inputEl.value}" come nuovo`;
      custom.addEventListener('mousedown', () => {
        this.onCustom?.(this.inputEl.value);
        this.hide();
      });
      this.dropdown.appendChild(custom);
    }

    this.dropdown.style.display = (items.length > 0 || query) ? 'block' : 'none';
  }

  hide() { if (this.dropdown) this.dropdown.style.display = 'none'; }

  destroy() {
    this._destroyed = true;
    this.inputEl.removeEventListener('input', this._onInput);
    this.inputEl.removeEventListener('blur',  this._onBlur);
    this.dropdown?.remove();
  }
}

export async function saveToLibrary(db, USER_ID, collectionName, item) {
  const id = item.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  await setDoc(
    doc(db, 'users', USER_ID, collectionName, id),
    { ...item, last_used: new Date().toISOString().split('T')[0] },
    { merge: true }
  );
  return id;
}
