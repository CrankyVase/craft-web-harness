// Injected into every app page by the harness. The Craft apps open files through a hidden
// <input type=file> and save by clicking a blob: download link. This hooks both so files
// go to and come from the server, and adds a small menu back to the launcher.
(() => {
  const APP = document.currentScript.dataset.app;
  const API = `/api/files/${APP}`;
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem('craft.' + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('craft.' + k, JSON.stringify(v)); } catch {} },
  };

  // Remember the Blob behind every blob: URL the app makes, so a download click can read it.
  const blobs = new Map();
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj) => { const u = origCreate(obj); if (obj instanceof Blob) blobs.set(u, obj); return u; };
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u) => { setTimeout(() => blobs.delete(u), 30000); origRevoke(u); };

  // ---- UI (shadow DOM so app CSS can't touch it) ----
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;left:0;bottom:0;width:0;height:0';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}
    .tab{position:fixed;left:0;bottom:12px;width:26px;height:34px;border:0;border-radius:0 8px 8px 0;background:#1c1c1f;color:#e8e8ea;opacity:.55;cursor:pointer;font-size:15px;padding:0}
    .tab:hover,.tab:focus-visible{opacity:1}
    .menu{position:fixed;left:30px;bottom:12px;min-width:210px;background:#1c1c1f;color:#e8e8ea;border:1px solid #3a3a3f;border-radius:8px;padding:6px;display:none}
    .menu.on{display:block}
    .menu button,.menu a{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;padding:8px 10px;border-radius:5px;cursor:pointer;text-decoration:none}
    .menu button:hover,.menu a:hover{background:#2c2c31}
    .menu label{display:flex;gap:8px;align-items:center;padding:8px 10px;cursor:pointer}
    .veil{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
    .veil.on{display:flex}
    .dlg{width:min(520px,92vw);max-height:80vh;display:flex;flex-direction:column;background:#1c1c1f;color:#e8e8ea;border:1px solid #3a3a3f;border-radius:10px}
    .dlg h2{margin:0;padding:14px 16px;font-size:15px;border-bottom:1px solid #3a3a3f}
    .list{overflow:auto;padding:6px;flex:1}
    .row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer}
    .row:hover,.row.sel{background:#2c2c31}
    .row .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .row .m{color:#9a9aa2;font-size:12px}
    .row .x{background:none;border:0;color:#9a9aa2;cursor:pointer;padding:2px 6px;border-radius:4px}
    .row .x:hover{color:#ff7b7b;background:#3a2326}
    .empty{padding:24px;text-align:center;color:#9a9aa2}
    .foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid #3a3a3f}
    .foot button{background:#2c2c31;color:#e8e8ea;border:1px solid #3a3a3f;border-radius:6px;padding:7px 12px;cursor:pointer}
    .foot button.pri{background:#3e63dd;border-color:#3e63dd;color:#fff}
    .toast{position:fixed;left:40px;bottom:60px;background:#1c1c1f;color:#e8e8ea;border:1px solid #3a3a3f;border-radius:8px;padding:9px 14px;display:none;max-width:70vw}
    .toast.on{display:block}.toast.err{border-color:#e5484d}
  </style>
  <button class="tab" title="Craft menu" aria-label="Craft menu">&#8962;</button>
  <div class="menu" role="menu">
    <a href="/">All apps</a>
    <button data-act="files">Server files&hellip;</button>
    <label><input type="checkbox" data-opt="copy"> Also download a copy on save</label>
  </div>
  <div class="veil"><div class="dlg" role="dialog" aria-modal="true"><h2></h2><div class="list"></div><div class="foot"></div></div></div>
  <div class="toast" role="status"></div>`;
  const $ = (s) => root.querySelector(s);
  const mount = () => document.documentElement.appendChild(host);
  document.documentElement ? mount() : addEventListener('DOMContentLoaded', mount);

  const menu = $('.menu'), veil = $('.veil'), toastEl = $('.toast');
  const copyBox = $('[data-opt=copy]');
  copyBox.checked = store.get('alsoDownload', false);
  copyBox.onchange = () => store.set('alsoDownload', copyBox.checked);
  $('.tab').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('on'); };
  addEventListener('pointerdown', (e) => { if (!e.composedPath().includes(host)) menu.classList.remove('on'); }, true);
  menu.querySelector('[data-act=files]').onclick = () => { menu.classList.remove('on'); showFiles(null); };

  let toastTimer;
  function toast(msg, err) {
    toastEl.textContent = msg; toastEl.className = 'toast on' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.className = 'toast'), 4000);
  }
  const fmt = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  async function listFiles() {
    const r = await fetch(API, { cache: 'no-store' });
    if (!r.ok) throw new Error('could not list files');
    return r.json();
  }

  // Shows the server's files. With an `input`, picking one loads it into the app.
  function showFiles(input) {
    const h2 = $('.dlg h2'), list = $('.list'), foot = $('.foot');
    h2.textContent = input ? 'Open from server' : 'Saved on server';
    foot.replaceChildren();
    list.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));
    veil.classList.add('on');
    const close = () => veil.classList.remove('on');
    veil.onclick = (e) => { if (e.target === veil) close(); };
    foot.append(el('button', { textContent: input ? 'Cancel' : 'Close', onclick: close }));
    if (input) foot.append(el('button', { className: 'pri', textContent: 'Browse this device…', onclick: () => { close(); input.__craftBypass = true; input.click(); } }));

    const accept = input && input.accept ? input.accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    const matches = (name) => !accept.length || accept.some((a) => a.startsWith('.') ? name.toLowerCase().endsWith(a) : true);
    const chosen = new Set();
    const render = (files) => {
      const shown = files.filter((f) => !input || matches(f.name));
      if (!shown.length) return list.replaceChildren(el('div', { className: 'empty' }, input ? 'No matching files saved yet.' : 'Nothing saved yet.'));
      list.replaceChildren(...shown.map((f) => {
        const row = el('div', { className: 'row', tabIndex: 0 },
          el('span', { className: 'n', textContent: f.name, title: f.name }),
          el('span', { className: 'm', textContent: fmt(f.size) + ' · ' + new Date(f.modified).toLocaleString() }));
        const del = el('button', { className: 'x', title: 'Delete from server', textContent: '✕', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete ${f.name} from the server?`)) return;
          await fetch(`${API}/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
          render((await listFiles()));
        } });
        row.append(del);
        const pick = async () => {
          if (!input) { location.href = `${API}/${encodeURIComponent(f.name)}`; return; }
          if (input.multiple) { row.classList.toggle('sel'); chosen.has(f.name) ? chosen.delete(f.name) : chosen.add(f.name); return; }
          await load(input, [f.name]); close();
        };
        row.onclick = pick; row.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
        return row;
      }));
    };
    if (input && input.multiple) foot.append(el('button', { className: 'pri', textContent: 'Open selected', onclick: async () => { if (chosen.size) { await load(input, [...chosen]); close(); } } }));
    listFiles().then(render, (e) => list.replaceChildren(el('div', { className: 'empty' }, e.message)));
  }

  async function load(input, names) {
    try {
      const dt = new DataTransfer();
      for (const n of names) {
        const r = await fetch(`${API}/${encodeURIComponent(n)}`);
        if (!r.ok) throw new Error('could not read ' + n);
        dt.items.add(new File([await r.blob()], n));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { toast(e.message, true); }
  }

  // Open: intercept programmatic clicks on file inputs.
  const origInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && !this.__craftBypass && !this.webkitdirectory) { showFiles(this); return; }
    this.__craftBypass = false;
    return origInputClick.call(this);
  };

  // Save: intercept clicks on <a download href="blob:...">.
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = this.hasAttribute('download') && blobs.get(this.href);
    if (!blob) return origAnchorClick.call(this);
    const name = (this.download || 'untitled').replace(/[\/\\]/g, '_').replace(/^\.+/, '') || 'untitled';
    fetch(`${API}/${encodeURIComponent(name)}`, { method: 'PUT', body: blob })
      .then((r) => { if (!r.ok) throw new Error('server returned ' + r.status); toast(`Saved to server: ${name}`); })
      .catch((e) => { toast(`Server save failed (${e.message}); downloading instead`, true); origAnchorClick.call(this); });
    if (store.get('alsoDownload', false)) origAnchorClick.call(this);
  };
})();
