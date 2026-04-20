import { db, USER_ID, getDocs, collection, doc, setDoc } from './firebase-config.js';

export class AutoComplete {
  constructor(inputEl, collName, opts={}) {
    this.input = inputEl;
    this.coll = collName;
    this.opts = opts;
    this.cache = null;

    this.dd = document.createElement('div');
    this.dd.className = 'ac-dd';

    const wrap = document.createElement('div');
    wrap.className = 'ac-wrap';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);
    wrap.appendChild(this.dd);

    inputEl.addEventListener('input', () => this.search());
    inputEl.addEventListener('focus', () => { if (inputEl.value.length >= 1) this.search(); });
    inputEl.addEventListener('blur', () => setTimeout(() => this.dd.style.display = 'none', 200));
  }

  async loadCache() {
    if (this.cache) return this.cache;
    const snap = await getDocs(collection(db, 'users', USER_ID, this.coll));
    this.cache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return this.cache;
  }

  async search() {
    const q = this.input.value.trim().toLowerCase();
    if (q.length < 1) { this.dd.style.display = 'none'; return; }
    const all = await this.loadCache();
    const filtered = all.filter(i => i.name.toLowerCase().includes(q)).slice(0, 8);
    this.render(filtered, q);
  }

  render(items, q) {
    this.dd.innerHTML = '';
    items.forEach(item => {
      const div = document.createElement('div');
      div.innerHTML = `<span>${item.name}</span>` +
        (this.opts.showMacro && item.kcal_per_100g
          ? `<span class="ac-sub">${item.kcal_per_100g} kcal/100g · P:${item.protein_per_100g}g C:${item.carbs_per_100g}g F:${item.fats_per_100g}g</span>`
          : '');
      div.addEventListener('mousedown', () => {
        this.input.value = item.name;
        this.dd.style.display = 'none';
        this.opts.onSelect?.(item);
      });
      this.dd.appendChild(div);
    });

    const add = document.createElement('div');
    add.className = 'ac-add';
    add.textContent = `+ Aggiungi "${this.input.value}"`;
    add.addEventListener('mousedown', () => {
      this.dd.style.display = 'none';
      this.opts.onCustom?.(this.input.value);
    });
    this.dd.appendChild(add);
    this.dd.style.display = 'block';
  }

  invalidateCache() { this.cache = null; }
}

export async function saveToLibrary(collName, data) {
  const id = data.name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_àèéìòù]/g,'');
  await setDoc(doc(db, 'users', USER_ID, collName, id),
    { ...data, last_used: new Date().toISOString().split('T')[0] },
    { merge: true }
  );
}
