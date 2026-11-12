/* Buku Tamu Desa Merden — frontend PWA
 * Alur tamu: 1) NIK  2) pilih keperluan  3) simpan.
 * Data disimpan dulu di tablet (antrean), lalu dikirim ke server — tidak ada data hilang saat sinyal putus. */
'use strict';

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BATAS_DIAM_MS = 60000;   // layar tamu kembali ke awal setelah 1 menit tanpa sentuhan
const TUNGGU_NOMOR_MS = 4000;  // berapa lama menunggu nomor urut dari server sebelum layar terima kasih
const LAMA_TERIMA_MS = 6000;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const tunggu = ms => new Promise(r => setTimeout(r, ms));

/* ================= PENYIMPANAN LOKAL ================= */

const lokal = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* penuh/diblokir */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } }
};
// Alamat server (Google Apps Script Web App). Tidak perlu diatur di tablet.
const API_URL = 'https://script.google.com/macros/s/AKfycbzmNbGItSpg2Yyphx7NeGiZslY6jBT6UkepMVsAhpnu-6Mi6BfMsqHqXG8LFxErlRQF/exec';
const conf = () => {
  let perangkat = lokal.get('bt_perangkat');
  if (!perangkat) { perangkat = 'TABLET-' + Math.random().toString(36).slice(2, 7).toUpperCase(); lokal.set('bt_perangkat', perangkat); }
  return { url: API_URL, perangkat };
};

const S = {
  token: null, peran: null,
  master: lokal.get('bt_master', null),
  view: null,
  nik: '',
  terisi: null,          // data penduduk terpilih
  mode: 'manual',        // 'manual' | 'ubah'
  editData: null,
  daftar: [],
  lastApi: 0
};
(function muatSesi() {
  const s = lokal.get('bt_sesi');
  if (s && s.sampai > Date.now()) { S.token = s.token; S.peran = s.peran; }
})();

/* ================= ANTREAN (IndexedDB) ================= */

const Antrean = {
  _db: null,
  buka() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((ok, gagal) => {
      const r = indexedDB.open('bukutamu', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('antrean', { keyPath: 'id' });
      r.onsuccess = () => { this._db = r.result; ok(this._db); };
      r.onerror = () => gagal(r.error);
    });
  },
  async _tx(mode, fn) {
    const db = await this.buka();
    return new Promise((ok, gagal) => {
      const tx = db.transaction('antrean', mode);
      const req = fn(tx.objectStore('antrean'));
      tx.oncomplete = () => ok(req ? req.result : undefined);
      tx.onerror = () => gagal(tx.error);
    });
  },
  tambah(item) { return this._tx('readwrite', s => s.put(item)); },
  semua() { return this._tx('readonly', s => s.getAll()); },
  hapus(id) { return this._tx('readwrite', s => s.delete(id)); }
};

/* ================= API ================= */

async function api(action, data = {}, opsi = {}) {
  const c = conf();
  if (!c.url) throw new Error('URL server belum diatur.');
  const ulang = opsi.ulang || 0;
  for (let coba = 0; ; coba++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), opsi.timeout || 30000);
    let res;
    try {
      res = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: S.token, perangkat: c.perangkat }, data)),
        signal: ctrl.signal,
        redirect: 'follow'
      });
    } catch (e) {
      clearTimeout(to);
      if (coba < ulang) { await tunggu(800); continue; }
      const err = new Error(navigator.onLine ? 'Server lambat atau tidak terjangkau. Coba lagi.' : 'Tidak ada internet.');
      err.jaringan = true;
      throw err;
    }
    clearTimeout(to);
    S.lastApi = Date.now();
    let j;
    try { j = await res.json(); } catch (e) { const err = new Error('Server sedang sibuk. Coba lagi sebentar.'); err.jaringan = true; throw err; }
    if (!j.ok) {
      if (j.pesan === 'SESI_HABIS') { akhiriSesi(); throw new Error('Sesi admin habis. Silakan tekan Admin dan masuk lagi.'); }
      throw new Error(j.pesan || 'Terjadi kesalahan.');
    }
    return j;
  }
}

/** Apps Script "tidur" bila lama tidak dipakai; panggilan ringan ini membangunkannya lebih dulu */
function hangatkan() {
  if (!conf().url || !navigator.onLine || Date.now() - S.lastApi < 180000) return;
  S.lastApi = Date.now();
  api('ping', {}, { timeout: 15000 }).catch(() => { /* abaikan */ });
}

/* ================= UTILITAS ================= */

const pad2 = n => String(n).padStart(2, '0');
const isoHariIni = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const isoKeDmy = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const dmyKeIso = d => { const m = String(d || '').match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const tglPanjang = (d = new Date()) => `${HARI[d.getDay()]}, ${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
const dmyPanjang = s => { const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${Number(m[1])} ${BULAN[Number(m[2]) - 1]} ${m[3]}` : s; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const judulKata = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function toast(teks, err = false) {
  const t = $('#toast');
  t.textContent = teks;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}
function pesan(el, teks, jenis = '') { el.textContent = teks || ''; el.className = 'msg' + (jenis ? ' ' + jenis : ''); }
async function sibuk(btn, fn) {
  if (btn.classList.contains('sibuk')) return;
  btn.classList.add('sibuk');
  btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn.classList.remove('sibuk'); btn.removeAttribute('aria-busy'); }
}
const petugas = () => !!S.token;
const admin = () => S.peran === 'admin';

window.addEventListener('unhandledrejection', e => { console.error(e.reason); toast('Terjadi kesalahan. Silakan coba lagi.', true); });

/* ================= NAVIGASI ================= */

const VIEW_PETUGAS = ['daftar', 'atur'];

function tampil(id) {
  if (id === 'manual') { S.mode = 'manual'; S.terisi = null; S.editData = null; id = 'form'; siapkanForm(null); }
  if (VIEW_PETUGAS.includes(id) && !petugas()) id = 'nik';
  if ((id === 'form' || id === 'pilih') && !S.master) { toast('Data pilihan belum termuat. Periksa internet.', true); muatMaster(); id = 'nik'; }
  $$('main > .view').forEach(v => { v.hidden = v.id !== 'v-' + id; });
  $$('#nav button').forEach(b => b.classList.toggle('aktif', b.dataset.go === id || (id === 'pilih' && b.dataset.go === 'nik')));
  const dari = S.view;
  S.view = id;
  if (dari !== id) window.scrollTo(0, 0);
  if (dari === 'terima' && id !== 'terima') clearTimeout(layarTerima._t);
  if (id === 'nik') resetNik();
  if (id === 'daftar') muatLaporan();
  if (id === 'atur') muatPengaturan();
  if (id === 'nilai') resetNilai();
  resetDiam();
}

function aturPeran() {
  $$('[data-peran]').forEach(el => { el.hidden = el.dataset.peran === 'admin' ? !admin() : !petugas(); });
  document.body.classList.toggle('petugas', petugas());
  $('#btn-masuk-teks').textContent = petugas() ? 'Keluar' : 'Admin';
  $('#btn-masuk').classList.toggle('keluar', petugas());
  $('#btn-masuk').setAttribute('aria-label', petugas() ? 'Keluar dari admin' : 'Masuk admin');
  aturTombolPasang();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) { e.preventDefault(); tampil(b.dataset.go); }
});

/* ================= JAM, ONLINE, DIAM ================= */

function tickJam() {
  const d = new Date();
  $('#jam').textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  $('#sapa-tgl').textContent = tglPanjang(d);
}

function aturNet() {
  const on = navigator.onLine;
  const dot = $('#net');
  dot.classList.toggle('off', !on);
  dot.title = on ? 'Online' : 'Offline — data disimpan di tablet';
  if (on) kirimAntrean();
}

let _diam;
function resetDiam() {
  clearTimeout(_diam);
  if (petugas()) return;
  const perlu = S.view === 'pilih' || S.view === 'form' || S.view === 'nilai' || (S.view === 'nik' && S.nik);
  if (perlu) _diam = setTimeout(() => { if (!$('#dlg-konfirmasi').open) tampil('nik'); }, BATAS_DIAM_MS);
}
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, resetDiam, { passive: true }));

/* ================= MASTER ================= */

async function muatMaster() {
  try {
    const m = await api('master', {}, { ulang: 1 });
    S.master = m;
    lokal.set('bt_master', m);
    terapkanMaster();
  } catch (e) {
    if (!S.master) toast(e.message, true);
  }
}

function terapkanMaster() {
  const m = S.master;
  if (!m) return;
  const desa = m.desa.nama || 'Merden';
  $('#brand-sub').textContent = 'Desa ' + desa;
  $('#sapa-desa').textContent = desa;
  $('#dl-tempat').innerHTML = (m.tempatLahir || []).map(v => `<option value="${esc(v)}">`).join('');
  $('#dl-pekerjaan').innerHTML = (m.pekerjaan || []).map(v => `<option value="${esc(v)}">`).join('');
  buatChips('#c-lp', [['L', 'Laki-laki'], ['P', 'Perempuan']]);
  buatChips('#c-agama', m.agama);
  buatChips('#c-status', m.status);
  const labelPerlu = k => [k, judulKata(k).replace(/\bSktm\b/, 'SKTM').replace(/\bKtp\/Kk\b/i, 'KTP/KK')];
  buatChips('#c-keperluan', m.keperluan.map(labelPerlu));
  buatChips('#p-keperluan', m.keperluan.map(labelPerlu));
  buatChips('#c-rw', m.wilayah.map(w => [w.rw, 'RW ' + w.rw]));
}

/* ================= CHIPS ================= */

function buatChips(sel, daftar) {
  $(sel).innerHTML = (daftar || []).map(v => {
    const [val, label] = Array.isArray(v) ? v : [v, v];
    return `<button type="button" data-v="${esc(val)}" aria-pressed="false">${esc(label)}</button>`;
  }).join('');
}
const nilaiChip = sel => { const b = $(sel + ' button.on'); return b ? b.dataset.v : ''; };
function pilihChip(sel, nilai) {
  const box = $(sel);
  let ada = false;
  $$('button', box).forEach(b => { const on = b.dataset.v === String(nilai); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); ada = ada || on; });
  if (!ada && nilai) box.insertAdjacentHTML('beforeend', `<button type="button" data-v="${esc(nilai)}" class="on" aria-pressed="true">${esc(nilai)}</button>`);
}

document.addEventListener('click', e => {
  const b = e.target.closest('.chips button');
  if (!b || b.closest('#d-periode') || b.closest('#n-catatan')) return;
  const box = b.parentElement;
  const nyala = !b.classList.contains('on') || box.id === 'c-rw';
  $$('button', box).forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
  if (nyala) { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); }
  if (box.id === 'c-rw') isiRt(b.dataset.v);
  if (box.id === 'p-keperluan') pesan($('#p-salah'), '', 'err');
  bersihSalah(box.closest('[data-f]'));
});

function isiRt(rw, pilih) {
  const w = (S.master.wilayah || []).find(x => x.rw === String(rw));
  $('#f-dusun').textContent = w ? '· Dusun ' + judulKata(w.dusun) : '';
  const daftar = [];
  for (let i = 1; i <= (w ? w.jumlahRt : 0); i++) daftar.push([String(i), 'RT ' + i]);
  buatChips('#c-rt', daftar);
  if (pilih) pilihChip('#c-rt', pilih);
}

/* ================= LANGKAH 1: NIK ================= */

function resetNik() {
  S.nik = ''; S.terisi = null;
  renderNik();
  pesan($('#nik-pesan'), navigator.onLine ? '' : 'Sedang offline. Silakan pilih "Isi manual" di bawah.', navigator.onLine ? '' : 'err');
  $('#nama-hasil').innerHTML = '';
  $('#cari-nama').value = '';
  hangatkan();
}

function renderNik() {
  const n = S.nik;
  $('#nik-input').value = n.replace(/(\d{4})(?=\d)/g, '$1 ');
  $('#nik-input').placeholder = '•••• •••• •••• ••••';
  $('#nik-progress').style.width = (n.length / 16 * 100) + '%';
  $('#nik-count').textContent = n.length === 16 ? 'Lengkap — tekan Lanjut' : `${n.length} dari 16 angka`;
  $('#nik-cari').disabled = n.length !== 16;
}

// getaran halus hanya saat layar benar-benar disentuh (Chrome menolak getar tanpa sentuhan pengguna)
function getar() {
  const ua = navigator.userActivation;
  if (navigator.vibrate && (!ua || ua.hasBeenActive)) { try { navigator.vibrate(8); } catch (e) { /* abaikan */ } }
}

function tekanNik(k) {
  if (k === 'hapus') S.nik = S.nik.slice(0, -1);
  else if (k === 'cari') { if (S.nik.length === 16) cariNik(); return; }
  else if (/^\d$/.test(k) && S.nik.length < 16) {
    S.nik += k;
    if (S.nik.length === 16) { renderNik(); cariNik(); return; }
  }
  pesan($('#nik-pesan'), '');
  renderNik();
  if (S.nik.length === 1) hangatkan();
}

$('#nik-pad').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !b.disabled) { if (e.isTrusted) getar(); tekanNik(b.dataset.k || b.textContent.trim()); }
});
// tahan tombol hapus = kosongkan
(function () {
  let t;
  const h = $('#nik-pad [data-k="hapus"]');
  h.addEventListener('pointerdown', () => { t = setTimeout(() => { S.nik = ''; renderNik(); }, 600); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => h.addEventListener(ev, () => clearTimeout(t)));
})();
// keyboard fisik / tempel
document.addEventListener('keydown', e => {
  if (S.view !== 'nik' || e.target.matches('input:not(#nik-input), textarea, select') || document.querySelector('dialog[open]')) return;
  if (/^\d$/.test(e.key)) tekanNik(e.key);
  else if (e.key === 'Backspace') tekanNik('hapus');
  else if (e.key === 'Enter') tekanNik('cari');
  else return;
  e.preventDefault();
});
document.addEventListener('paste', e => {
  if (S.view !== 'nik' || e.target.matches('input:not(#nik-input), textarea')) return;
  const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 16);
  if (d) { S.nik = d; renderNik(); e.preventDefault(); }
});

async function cariNik() {
  const msg = $('#nik-pesan');
  if (!navigator.onLine) { pesan(msg, 'Sedang offline. Silakan pilih "Isi manual".', 'err'); return; }
  await sibuk($('#nik-cari'), async () => {
    try {
      const r = await api('cariNik', { nik: S.nik }, { ulang: 1, timeout: 20000 });
      if (r.data) { S.terisi = r.data; tampilPilih(); }
      else pesan(msg, 'NIK belum ada di data penduduk. Periksa kembali angkanya, atau pilih "Isi manual".', 'err');
    } catch (e) {
      pesan(msg, e.message + ' Anda juga bisa memilih "Isi manual".', 'err');
    }
  });
}

/* ---------- cari nama (petugas) ---------- */

async function cariNama() {
  const q = $('#cari-nama').value.trim();
  const box = $('#nama-hasil');
  if (q.length < 3) { toast('Ketik minimal 3 huruf nama.', true); return; }
  await sibuk($('#cari-nama-btn'), async () => {
    try {
      const r = await api('cariNama', { q }, { ulang: 1 });
      S._hasil = r.data;
      box.innerHTML = r.data.length ? r.data.map((p, i) => `
        <button type="button" class="kartu-hasil" data-pilih="${i}">
          <span><b>${esc(p.nama)}</b>
          <span class="muted">${p.lp === 'P' ? 'P' : 'L'} · ${esc(p.tempatLahir)}, ${esc(p.tanggalLahir)}</span>
          <span class="muted">RT ${esc(p.rt)}/RW ${esc(p.rw)} ${esc(judulKata(p.dusun))} · NIK ${esc(p.nik)}</span></span>
          <span aria-hidden="true">›</span>
        </button>`).join('') : '<p class="muted">Tidak ditemukan.</p>';
    } catch (e) { toast(e.message, true); }
  });
}
$('#cari-nama-btn').addEventListener('click', cariNama);
$('#cari-nama').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); cariNama(); } });
$('#nama-hasil').addEventListener('click', e => {
  const b = e.target.closest('[data-pilih]');
  if (b) { S.terisi = S._hasil[Number(b.dataset.pilih)]; tampilPilih(); }
});

/* ================= LANGKAH 2: KEPERLUAN ================= */

function tampilPilih() {
  const p = S.terisi;
  $('#p-nama').textContent = p.nama;
  const info = p.samar
    ? [['Alamat', `RT ${p.rt} / RW ${p.rw}, Dusun ${judulKata(p.dusun)}`]]
    : [
      ['Jenis kelamin', p.lp === 'P' ? 'Perempuan' : 'Laki-laki'],
      ['Lahir', `${judulKata(p.tempatLahir)}, ${dmyPanjang(p.tanggalLahir)}`],
      ['Alamat', `RT ${p.rt} / RW ${p.rw}, Dusun ${judulKata(p.dusun)}`],
      ['Pekerjaan', judulKata(p.pekerjaan)]
    ];
  $('#p-info').innerHTML = info.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join('');
  $('#p-catatan').hidden = !p.samar;
  pilihChip('#p-keperluan', '');
  $('#p-ket').value = '';
  pesan($('#p-salah'), '', 'err');
  tampil('pilih');
}

$('#p-bukan').addEventListener('click', () => tampil('nik'));
$('#p-koreksi').addEventListener('click', () => {
  const p = S.terisi;
  S.mode = 'manual'; S.editData = null;
  tampil('form');
  siapkanForm(Object.assign({}, p, { keperluan: nilaiChip('#p-keperluan'), keterangan: $('#p-ket').value }));
  S.terisi = p;
});

$('#p-simpan').addEventListener('click', () => {
  const keperluan = nilaiChip('#p-keperluan');
  const ket = $('#p-ket').value.trim();
  if (!keperluan && !ket) { pesan($('#p-salah'), 'Pilih salah satu keperluan.', 'err'); return; }
  if (keperluan === 'LAINNYA' && !ket) { pesan($('#p-salah'), 'Tulis keperluan Anda di kotak keterangan.', 'err'); $('#p-ket').focus(); return; }
  const p = S.terisi;
  const d = {
    tanggal: isoKeDmy(isoHariIni()), nik: p.nik, nama: p.nama, lp: p.lp, tempatLahir: p.tempatLahir,
    tanggalLahir: p.tanggalLahir, agama: p.agama, status: p.status, pekerjaan: p.pekerjaan,
    rt: p.rt, rw: p.rw, dusun: p.dusun, keperluan, keterangan: gabungKet(keperluan, ket)
  };
  sibuk($('#p-simpan'), () => simpanTamu(d));
});

const gabungKet = (keperluan, ket) => keperluan ? (ket ? `${keperluan} - ${ket}` : keperluan) : ket;

/* ================= PENILAIAN KEPUASAN ================= */

const LABEL_NILAI = ['', 'Sangat tidak puas', 'Tidak puas', 'Cukup', 'Puas', 'Sangat puas'];
const CATATAN_BAIK = ['Cepat', 'Ramah', 'Jelas', 'Mudah', 'Tempat nyaman'];
const CATATAN_KURANG = ['Lama menunggu', 'Kurang ramah', 'Kurang jelas', 'Syarat rumit', 'Tempat kurang nyaman'];
S.nilai = { n: 0, catatan: new Set() };

function resetNilai() {
  S.nilai = { n: 0, catatan: new Set() };
  $('#n-saran').value = '';
  gambarBintang();
}
function gambarBintang() {
  const n = S.nilai.n;
  $$('#n-bintang button').forEach(b => {
    const k = Number(b.dataset.n);
    b.classList.toggle('on', k <= n);
    b.setAttribute('aria-checked', String(k === n));
  });
  $('#n-label').textContent = n ? `${LABEL_NILAI[n]} (${n} bintang)` : 'Pilih 1 sampai 5 bintang';
  $('#n-label').classList.toggle('dipilih', !!n);
  $('#n-kirim').disabled = !n;
  $('#n-lanjutan').hidden = !n;
  if (n) {
    $('#n-tanya').textContent = n >= 4 ? 'Apa yang Anda sukai? (boleh pilih lebih dari satu)' : 'Apa yang perlu kami perbaiki? (boleh pilih lebih dari satu)';
    const daftar = n >= 4 ? CATATAN_BAIK : CATATAN_KURANG;
    S.nilai.catatan = new Set([...S.nilai.catatan].filter(c => daftar.includes(c)));
    $('#n-catatan').innerHTML = daftar.map(c => `<button type="button" data-v="${esc(c)}" class="${S.nilai.catatan.has(c) ? 'on' : ''}" aria-pressed="${S.nilai.catatan.has(c)}">${esc(c)}</button>`).join('');
  }
}
$('#n-bintang').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (e.isTrusted) getar();
  S.nilai.n = Number(b.dataset.n);
  gambarBintang();
});
$('#n-catatan').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const c = b.dataset.v;
  if (S.nilai.catatan.has(c)) S.nilai.catatan.delete(c); else S.nilai.catatan.add(c);
  b.classList.toggle('on', S.nilai.catatan.has(c));
  b.setAttribute('aria-pressed', String(S.nilai.catatan.has(c)));
});
$('#n-kirim').addEventListener('click', () => sibuk($('#n-kirim'), async () => {
  if (!S.nilai.n) return;
  const id = uuid();
  const data = { id, nilai: S.nilai.n, catatan: [...S.nilai.catatan], saran: $('#n-saran').value.trim(), tanggal: isoKeDmy(isoHariIni()) };
  const item = { id, aksi: 'nilai', data, dibuat: Date.now() };
  try { await Antrean.tambah(item); } catch (e) { /* tanpa IndexedDB: kirim langsung di bawah */ }
  if (navigator.onLine) await Promise.race([kirimSatu(item).catch(() => null), tunggu(TUNGGU_NOMOR_MS)]);
  perbaruiAntrean();
  $('#terima-judul').textContent = 'Terima kasih atas penilaian Anda';
  $('#terima-pesan').textContent = data.nilai >= 4 ? 'Senang bisa melayani Anda dengan baik.' : 'Masukan Anda membantu kami memperbaiki pelayanan.';
  $('#terima-no').textContent = '★'.repeat(data.nilai) + '☆'.repeat(5 - data.nilai);
  tampil('terima');
  const bar = $('#terima-bar');
  bar.classList.remove('jalan'); void bar.offsetWidth; bar.classList.add('jalan');
  clearTimeout(layarTerima._t);
  layarTerima._t = setTimeout(() => { if (S.view === 'terima') tampil('nik'); }, LAMA_TERIMA_MS);
}));

/* ================= ISI MANUAL / UBAH ================= */

/* --- kenyamanan mengetik --- */
// "05041984" -> "05-04-1984" otomatis saat diketik
function formatTgl(v) {
  const a = String(v).replace(/\D/g, '').slice(0, 8);
  return a.length > 4 ? `${a.slice(0, 2)}-${a.slice(2, 4)}-${a.slice(4)}` : a.length > 2 ? `${a.slice(0, 2)}-${a.slice(2)}` : a;
}
function tglValid(v) {
  const m = String(v || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (d.getUTCDate() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || +m[3] < 1900) return '';
  return v;
}
$('#f-tgllahir').addEventListener('input', e => {
  const el = e.target, f = formatTgl(el.value);
  if (el.value !== f) el.value = f;
});
$('#f-nik').addEventListener('input', e => { const v = e.target.value.replace(/\D/g, ''); if (v !== e.target.value) e.target.value = v; });

// pekerjaan yang paling sering: cukup sekali sentuh
const PEKERJAAN_CEPAT = ['MENGURUS RUMAH TANGGA', 'BELUM/TIDAK BEKERJA', 'PELAJAR/MAHASISWA', 'KARYAWAN SWASTA', 'BURUH HARIAN LEPAS', 'PETANI/PEKEBUN', 'WIRASWASTA', 'PEDAGANG'];
buatChips('#c-pekerjaan-cepat', PEKERJAAN_CEPAT.map(p => [p, judulKata(p)]));
$('#c-pekerjaan-cepat').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) { $('#f-pekerjaan').value = b.dataset.v; bersihSalah($('[data-f="pekerjaan"]')); setTimeout(sorotPekerjaan); }
});
const sorotPekerjaan = () => {
  const v = $('#f-pekerjaan').value.trim().toUpperCase();
  $$('#c-pekerjaan-cepat button').forEach(b => { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
};
$('#f-pekerjaan').addEventListener('input', sorotPekerjaan);

// Enter di keyboard = pindah ke kolom berikutnya (bukan langsung mengirim formulir)
$('#form-tamu').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  const fs = e.target.closest('fieldset');
  const kolom = $$('input:not([type=checkbox]), textarea', fs).filter(x => x.offsetParent && !x.disabled);
  const berikut = kolom[kolom.indexOf(e.target) + 1];
  if (berikut) berikut.focus(); else { e.target.blur(); $('#form-simpan').click(); }
});

// saat keyboard muncul: tombol yang menempel di bawah disembunyikan, kolom digulir ke tengah
const sedangKetik = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type) && !el.readOnly));
document.addEventListener('focusin', e => {
  if (!sedangKetik(e.target)) return;
  document.body.classList.add('mengetik');
  if (window.innerWidth <= 960) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});
document.addEventListener('focusout', () => setTimeout(() => { if (!sedangKetik(document.activeElement)) document.body.classList.remove('mengetik'); }, 120));


function siapkanForm(d) {
  const f = $('#form-tamu');
  f.reset();
  $$('[data-f]', f).forEach(bersihSalah);
  ['#c-lp', '#c-agama', '#c-status', '#c-rw', '#c-keperluan'].forEach(s => pilihChip(s, ''));
  $('#c-rt').innerHTML = '<span class="muted">Pilih RW dulu</span>';
  $('#f-dusun').textContent = '';
  $('#alamat-desa').hidden = false;
  $('#f-tanggal').value = isoHariIni();
  $('#form-judul').textContent = S.mode === 'ubah' ? `Ubah Data No. ${S.editData.no}` : (d ? 'Koreksi Data Tamu' : 'Isi Manual');
  tampilLangkah(1);
  sorotPekerjaan();
  if (!d) return;
  $('#f-nama').value = d.nama || '';
  $('#f-nik').value = d.nik || '';
  pilihChip('#c-lp', d.lp || '');
  $('#f-tempat').value = d.tempatLahir || '';
  $('#f-tgllahir').value = d.tanggalLahir || '';
  pilihChip('#c-agama', d.agama || '');
  pilihChip('#c-status', d.status || '');
  $('#f-pekerjaan').value = d.pekerjaan || '';
  sorotPekerjaan();
  const luar = d.rw === '-' || d.rt === '-';
  $('#f-luar').checked = luar;
  $('#alamat-desa').hidden = luar;
  if (!luar && d.rw) { pilihChip('#c-rw', d.rw); isiRt(d.rw, d.rt); }
  if (d.tanggal) $('#f-tanggal').value = dmyKeIso(d.tanggal);
  pilihChip('#c-keperluan', d.keperluan || '');
  let ket = d.keterangan || '';
  if (d.keperluan && ket.toUpperCase().startsWith(d.keperluan)) ket = ket.slice(d.keperluan.length).replace(/^\s*-\s*/, '');
  $('#f-ket').value = ket;
}

function bacaForm() {
  const luar = $('#f-luar').checked;
  const rw = luar ? '-' : nilaiChip('#c-rw');
  const w = (S.master.wilayah || []).find(x => x.rw === rw);
  const keperluan = nilaiChip('#c-keperluan');
  return {
    tanggal: (petugas() && isoKeDmy($('#f-tanggal').value)) || isoKeDmy(isoHariIni()),
    nik: $('#f-nik').value.replace(/\D/g, ''),
    nama: $('#f-nama').value.trim().toUpperCase(),
    lp: nilaiChip('#c-lp'),
    tempatLahir: $('#f-tempat').value.trim().toUpperCase(),
    tanggalLahir: tglValid($('#f-tgllahir').value),
    agama: nilaiChip('#c-agama'),
    status: nilaiChip('#c-status'),
    pekerjaan: $('#f-pekerjaan').value.trim().toUpperCase(),
    rt: luar ? '-' : nilaiChip('#c-rt'),
    rw,
    dusun: luar ? 'LUAR DESA' : (w ? w.dusun : ''),
    keperluan,
    keterangan: gabungKet(keperluan, $('#f-ket').value.trim())
  };
}

function bersihSalah(el) {
  if (!el) return;
  el.classList.remove('salah');
  const s = $('small', el); if (s) s.textContent = '';
}

function validasiForm(d, hanya) {
  const salah = {};
  if (d.nama.length < 3) salah.nama = 'Nama minimal 3 huruf';
  if (d.nik && d.nik.length !== 16) salah.nik = 'NIK harus 16 angka, atau kosongkan';
  if (!d.lp) salah.lp = 'Pilih jenis kelamin';
  if (!d.tempatLahir) salah.tempatLahir = 'Tempat lahir wajib diisi';
  if (!d.tanggalLahir) salah.tanggalLahir = $('#f-tgllahir').value.trim() ? 'Tanggal tidak benar. Tulis seperti 05-04-1984' : 'Tanggal lahir wajib diisi';
  else if (dmyKeIso(d.tanggalLahir) > isoHariIni()) salah.tanggalLahir = 'Tanggal lahir tidak boleh setelah hari ini';
  if (!d.agama) salah.agama = 'Pilih agama';
  if (!d.status) salah.status = 'Pilih status perkawinan';
  if (!d.pekerjaan) salah.pekerjaan = 'Pekerjaan wajib diisi';
  if (d.rw !== '-') { if (!d.rw) salah.rw = 'Pilih RW'; else if (!d.rt) salah.rt = 'Pilih RT'; }
  if (!d.keterangan) salah.keperluan = 'Pilih keperluan atau tulis keterangan';
  else if (d.keperluan === 'LAINNYA' && d.keterangan === 'LAINNYA') salah.keterangan = 'Tulis keperluan Anda';
  if (hanya) Object.keys(salah).forEach(k => { if (!hanya.includes(k)) delete salah[k]; });
  $$('#form-tamu [data-f]').forEach(el => { if (!hanya || hanya.includes(el.dataset.f)) bersihSalah(el); });
  Object.keys(salah).forEach(k => {
    const el = $(`#form-tamu [data-f="${k}"]`);
    if (el) { el.classList.add('salah'); $('small', el).textContent = salah[k]; }
  });
  const pertama = $('#form-tamu .salah');
  if (pertama) pertama.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return Object.keys(salah);
}

const FIELD_LANGKAH = {
  1: ['nama', 'nik', 'lp', 'tempatLahir', 'tanggalLahir', 'agama', 'status', 'pekerjaan'],
  2: ['rw', 'rt'],
  3: ['keperluan', 'keterangan']
};
function tampilLangkah(n) {
  S.langkah = n;
  $$('#form-tamu fieldset[data-langkah]').forEach(fs => { fs.hidden = Number(fs.dataset.langkah) !== n; });
  $$('#langkah-form li').forEach((li, i) => { li.classList.toggle('on', i + 1 === n); li.classList.toggle('selesai', i + 1 < n); });
  $('#form-simpan').textContent = n < 3 ? 'Lanjut' : (S.mode === 'ubah' ? 'Simpan Perubahan' : 'Simpan');
  $('#batal-btn').textContent = n > 1 ? 'Kembali' : 'Batal';
  window.scrollTo(0, 0);
}

$('#f-luar').addEventListener('change', e => { $('#alamat-desa').hidden = e.target.checked; });
$('#batal-btn').addEventListener('click', () => { if (S.langkah > 1) tampilLangkah(S.langkah - 1); else tampil(S.mode === 'ubah' ? 'daftar' : 'nik'); });
$('#form-tamu').addEventListener('input', e => bersihSalah(e.target.closest('[data-f]')));

$('#form-tamu').addEventListener('submit', e => {
  e.preventDefault();
  const d = bacaForm();
  if (S.langkah < 3) {
    if (!validasiForm(d, FIELD_LANGKAH[S.langkah]).length) tampilLangkah(S.langkah + 1);
    return;
  }
  const salah = validasiForm(d);
  if (salah.length) {
    const ke = [1, 2, 3].find(n => FIELD_LANGKAH[n].some(f => salah.includes(f)));
    if (ke !== 3) { tampilLangkah(ke); validasiForm(d, FIELD_LANGKAH[ke]); }
    return;
  }
  S._kirim = d;
  const baris = [
    ['Tanggal', dmyPanjang(d.tanggal)], ['Nama', d.nama], ['NIK', d.nik || '-'], ['Jenis kelamin', d.lp === 'P' ? 'Perempuan' : 'Laki-laki'],
    ['Tempat, tgl lahir', `${d.tempatLahir}, ${d.tanggalLahir}`], ['Agama', d.agama], ['Status perkawinan', d.status],
    ['Pekerjaan', d.pekerjaan], ['Alamat', d.rw === '-' ? 'Luar Desa Merden' : `RT ${d.rt} / RW ${d.rw}, Dusun ${judulKata(d.dusun)}`],
    ['Keterangan', d.keterangan]
  ];
  $('#k-tabel').innerHTML = baris.map(([a, b]) => `<tr><td>${a}</td><td>${esc(b)}</td></tr>`).join('');
  pesan($('#k-pesan'), '');
  $('#dlg-konfirmasi').showModal();
});

$('#k-ubah').addEventListener('click', () => $('#dlg-konfirmasi').close());
$('#k-simpan').addEventListener('click', () => sibuk($('#k-simpan'), async () => {
  const d = S._kirim;
  if (S.mode === 'ubah') {
    try {
      await api('ubah', { id: S.editData.id, data: d });
      $('#dlg-konfirmasi').close();
      toast('Perubahan tersimpan.');
      tampil('daftar');
    } catch (e) { pesan($('#k-pesan'), e.message, 'err'); }
    return;
  }
  $('#dlg-konfirmasi').close();
  await simpanTamu(d);
}));

/* ================= SIMPAN (antrean dulu, lalu kirim) ================= */

const _sedangKirim = new Set();

async function kirimSatu(item) {
  if (_sedangKirim.has(item.id)) return null;
  _sedangKirim.add(item.id);
  try {
    const r = item.aksi === 'nilai'
      ? await api('nilai', item.data, { timeout: 30000 })
      : await api('simpan', { data: item.data }, { timeout: 30000 });
    await Antrean.hapus(item.id);
    return r.no;
  } catch (e) {
    // COBA_LAGI = server sementara tidak bisa membaca Kartu Pintar: diperlakukan seperti gangguan jaringan
    if (/^COBA_LAGI/.test(e.message)) e.jaringan = true;
    if (!e.jaringan) { item.galat = e.message; await Antrean.tambah(item); }
    throw e;
  } finally {
    _sedangKirim.delete(item.id);
    perbaruiAntrean();
  }
}

async function simpanTamu(d) {
  d.id = uuid();
  const item = { id: d.id, data: d, dibuat: Date.now() };
  try {
    await Antrean.tambah(item);
  } catch (e) {
    // IndexedDB tidak tersedia: kirim langsung
    try { const r = await api('simpan', { data: d }); return layarTerima(d, r.no, true); }
    catch (err) { toast(err.message, true); return; }
  }
  let hasil = { no: null };
  if (navigator.onLine) {
    hasil = await Promise.race([
      kirimSatu(item).then(no => ({ no }), e => ({ no: null, galat: e.jaringan ? null : e.message })),
      tunggu(TUNGGU_NOMOR_MS).then(() => ({ no: null }))
    ]);
  }
  perbaruiAntrean();
  if (hasil.galat) {
    // jangan tampilkan "berhasil" bila server menolak data
    toast('Data belum diterima server: ' + hasil.galat, true);
    if (S.view === 'form') { tampilLangkah(1); return; }
    return;
  }
  layarTerima(d, hasil.no, navigator.onLine);
}

function layarTerima(d, no, online) {
  const depan = d.nama && !d.nama.includes('*') ? judulKata(String(d.nama).split(' ')[0]) : '';
  $('#terima-judul').textContent = depan ? `Terima kasih, ${depan}` : 'Terima kasih';
  $('#terima-pesan').textContent = online || no ? 'Kunjungan Anda sudah tercatat di buku tamu.' : 'Data tersimpan di tablet dan akan terkirim otomatis saat internet tersambung.';
  $('#terima-no').textContent = no ? `Nomor urut ${no}` : '';
  tampil('terima');
  const bar = $('#terima-bar');
  bar.classList.remove('jalan'); void bar.offsetWidth; bar.classList.add('jalan');
  clearTimeout(layarTerima._t);
  layarTerima._t = setTimeout(() => { if (S.view === 'terima') tampil('nik'); }, LAMA_TERIMA_MS);
}

let _mengirim = false;
async function kirimAntrean() {
  if (_mengirim || !navigator.onLine || !conf().url) return;
  _mengirim = true;
  try {
    for (const it of await Antrean.semua()) {
      if (it.galat) continue;
      try { await kirimSatu(it); } catch (e) { if (e.jaringan) break; }
    }
  } catch (e) { /* abaikan */ } finally {
    _mengirim = false;
    perbaruiAntrean();
  }
}

async function perbaruiAntrean() {
  let items = [];
  try { items = await Antrean.semua(); } catch (e) { /* abaikan */ }
  const p = $('#antrean-pill');
  p.hidden = !items.length;
  p.textContent = `${items.length} belum terkirim`;
  if (S.view === 'atur') {
    $('#a-antrean').textContent = items.length ? `${items.length} data belum terkirim ke server.` : 'Semua data sudah terkirim.';
    $('#a-antrean-list').innerHTML = items.filter(i => i.galat).map(i => `
      <div class="kartu-hasil"><span><b>${esc(i.aksi === 'nilai' ? 'Penilaian ' + '★'.repeat(i.data.nilai) : i.data.nama)}</b><span class="muted">${esc(i.data.tanggal)} · ${esc(i.galat)}</span></span>
      <span class="baris-tombol"><button class="btn btn-ghost btn-sm" data-ulang="${esc(i.id)}">Coba lagi</button><button class="btn btn-danger btn-sm" data-buang="${esc(i.id)}">Buang</button></span></div>`).join('');
  }
}

$('#a-kirim').addEventListener('click', () => sibuk($('#a-kirim'), async () => {
  for (const it of await Antrean.semua()) if (it.galat) { delete it.galat; await Antrean.tambah(it); }
  await kirimAntrean();
  toast('Pengiriman selesai.');
}));
$('#a-antrean-list').addEventListener('click', async e => {
  const u = e.target.closest('[data-ulang]'), b = e.target.closest('[data-buang]');
  if (u) { const it = (await Antrean.semua()).find(x => x.id === u.dataset.ulang); if (it) { delete it.galat; await Antrean.tambah(it); kirimAntrean(); } }
  if (b && confirm('Buang data ini? Data tidak akan masuk buku tamu.')) { await Antrean.hapus(b.dataset.buang); perbaruiAntrean(); }
});

/* ================= LOGIN PIN ================= */

let _pin = '';
$('#btn-masuk').addEventListener('click', async () => {
  if (petugas()) {
    if (!confirm('Keluar dari mode admin?')) return;
    api('logout').catch(() => { /* abaikan */ });
    akhiriSesi();
    tampil('nik');
    return;
  }
  _pin = ''; gambarPin(); pesan($('#pin-pesan'), '');
  $('#dlg-pin').showModal();
});
const gambarPin = () => $$('#pin-dots i').forEach((d, i) => d.classList.toggle('on', i < _pin.length));

$('#pin-pad').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b || _pin.length >= 6 && !b.dataset.k) return;
  if (b.dataset.k === 'batal') { $('#dlg-pin').close(); return; }
  if (b.dataset.k === 'hapus') { _pin = _pin.slice(0, -1); gambarPin(); return; }
  _pin += b.textContent.trim();
  gambarPin();
  if (_pin.length < 6) return;
  pesan($('#pin-pesan'), 'Memeriksa…');
  try {
    const r = await api('login', { pin: _pin }, { ulang: 1 });
    S.token = r.token; S.peran = r.peran;
    lokal.set('bt_sesi', { token: r.token, peran: r.peran, sampai: Date.now() + r.berlakuDetik * 1000 - 60000 });
    $('#dlg-pin').close();
    aturPeran();
    toast('Berhasil masuk.');
    tampil('daftar');
  } catch (err) {
    pesan($('#pin-pesan'), err.message, 'err');
    _pin = ''; gambarPin();
  }
});

function akhiriSesi() {
  S.token = null; S.peran = null;
  lokal.del('bt_sesi');
  aturPeran();
  if (VIEW_PETUGAS.includes(S.view)) tampil('nik');
}

/* ================= LAPORAN (satu layar untuk admin) ================= */

const labelKeperluan = k => judulKata(k).replace(/\bSktm\b/, 'SKTM').replace(/\bKtp\/Kk\b/i, 'KTP/KK');
const KOLOM_L = ['NO', 'TANGGAL', 'NAMA', 'L/P', 'TEMPAT LAHIR', 'TANGGAL LAHIR', 'AGAMA', 'STATUS PERKAWINAN', 'PEKERJAAN', 'RT', 'RW', 'KETERANGAN'];
const barisCetak = t => [t.no, t.tanggal, t.nama, t.lp, t.tempatLahir, t.tanggalLahir, t.agama, t.status, t.pekerjaan, t.rt, t.rw, t.keterangan];
const urutKunci = t => dmyKeIso(t.tanggal) + String(t.no).padStart(6, '0');

(function () { const d = new Date(); $('#l-bulan').value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; })();
$('#l-bulan').addEventListener('change', () => muatLaporan());
$('#d-q').addEventListener('input', () => { S.tabel.hal = 1; renderDaftar(); });

function infoBulan() {
  const v = $('#l-bulan').value;
  const m = v.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const tahun = Number(m[1]), bulan = Number(m[2]);
  const akhir = new Date(tahun, bulan, 0).getDate();
  return { v, tahun, bulan, akhir, nama: `${BULAN[bulan - 1]} ${tahun}`, dari: `${v}-01`, sampai: `${v}-${pad2(akhir)}` };
}

function tampilSaran(nl) {
  const box = $('#l-saran');
  if (!nl || !nl.jumlah) { box.hidden = true; return; }
  box.hidden = false;
  const maks = Math.max(1, ...nl.sebaran);
  $('#l-sebaran').innerHTML = [5, 4, 3, 2, 1].map(n => `<div class="sebar"><span>${n} ★</span><i><b style="width:${nl.sebaran[n - 1] / maks * 100}%"></b></i><em>${nl.sebaran[n - 1]}</em></div>`).join('');
  $('#l-saran-list').innerHTML = nl.saran.length
    ? nl.saran.slice(0, 10).map(s => `<li><span class="bintang-isi">${'★'.repeat(s.nilai)}</span> ${esc(s.saran)} <span class="muted">· ${esc(dmyPanjang(s.tanggal))}</span></li>`).join('')
    : '<li class="muted">Belum ada saran tertulis.</li>';
}

/** Hitung ringkasan dari daftar tamu (dipakai layar, Excel, dan cetak) */
function hitungRekap(rows, b) {
  // perHari berupa array (indeks 0 = tanggal 1) agar urutan tanggal selalu benar
  const r = { total: rows.length, L: 0, P: 0, warga: 0, luar: 0, keperluan: {}, dusun: {}, umur: { 'Di bawah 17': 0, '17 - 25': 0, '26 - 40': 0, '41 - 60': 0, 'Di atas 60': 0 }, perHari: new Array(b.akhir).fill(0) };
  rows.forEach(t => {
    if (t.lp === 'L') r.L++; else if (t.lp === 'P') r.P++;
    if (t.rw === '-') r.luar++; else r.warga++;
    const kp = t.keperluan || 'LAINNYA';
    r.keperluan[kp] = (r.keperluan[kp] || 0) + 1;
    const ds = t.rw === '-' ? 'LUAR DESA' : (t.dusun || 'TIDAK DIKETAHUI');
    r.dusun[ds] = (r.dusun[ds] || 0) + 1;
    const hr = Number(String(t.tanggal).slice(0, 2));
    if (hr >= 1 && hr <= b.akhir) r.perHari[hr - 1]++;
    const a = dmyKeIso(t.tanggalLahir), k = dmyKeIso(t.tanggal);
    if (a && k) {
      const u = Math.floor((Number(k.replace(/-/g, '')) - Number(a.replace(/-/g, ''))) / 10000);
      r.umur[u < 17 ? 'Di bawah 17' : u <= 25 ? '17 - 25' : u <= 40 ? '26 - 40' : u <= 60 ? '41 - 60' : 'Di atas 60']++;
    }
  });
  return r;
}

let _muatKe = 0;
async function muatLaporan() {
  const b = infoBulan();
  if (!b) return;
  const ke = ++_muatKe;
  const tb = $('#d-tabel tbody');
  tb.innerHTML = '<tr><td colspan="13" class="kosong">Memuat…</td></tr>';
  $('#l-kpi').innerHTML = '';
  try {
    const [r, nl] = await Promise.all([
      api('daftar', { filter: { dari: b.dari, sampai: b.sampai, batas: 100000 } }, { ulang: 1, timeout: 60000 }),
      api('rekapNilai', { filter: { dari: b.dari, sampai: b.sampai } }, { ulang: 1, timeout: 60000 }).catch(() => null)
    ]);
    if (ke !== _muatKe) return; // sudah ada permintaan bulan lain yang lebih baru
    S.bulan = { info: b, rows: r.data.slice().sort((x, y) => urutKunci(y).localeCompare(urutKunci(x))), nilai: nl };
    const rk = hitungRekap(S.bulan.rows, b);
    const hariIni = isoKeDmy(isoHariIni());
    const jmlHariIni = S.bulan.rows.filter(t => t.tanggal === hariIni).length;
    const kpTeratas = Object.keys(rk.keperluan).sort((x, y) => rk.keperluan[y] - rk.keperluan[x])[0];
    $('#l-kpi').innerHTML = `
      <div><b>${rk.total}</b><span>Tamu ${esc(b.nama)}</span></div>
      <div><b>${rk.L} / ${rk.P}</b><span>Laki-laki / Perempuan</span></div>
      <div><b>${hariIni.endsWith(b.v.slice(0, 4)) && hariIni.slice(3, 5) === b.v.slice(5) ? jmlHariIni : '–'}</b><span>Tamu hari ini</span></div>
      <div class="kpi-nilai"><b>${nl && nl.jumlah ? '★ ' + String(nl.rata).replace('.', ',') : '–'}</b><span>Kepuasan${nl && nl.jumlah ? ` (${nl.jumlah} penilai)` : ''}</span></div>
      <div><b class="kecil">${esc(kpTeratas ? labelKeperluan(kpTeratas) : '-')}</b><span>Keperluan terbanyak</span></div>`;
    tampilSaran(nl);
    S.tabel.hal = 1;
    renderDaftar();
  } catch (e) {
    if (ke !== _muatKe) return;
    S.bulan = null;
    tb.innerHTML = `<tr><td colspan="13" class="kosong">${esc(e.message)}</td></tr>`;
  }
}

/* ---------- tabel: urutkan, jumlah baris per halaman, halaman ---------- */

// kunci tiap kolom: [nama properti, jenis urutan]
const KOLOM_TABEL = [
  ['no', 'angka'], ['tanggal', 'tgl'], ['nama', 'teks'], ['lp', 'teks'], ['tempatLahir', 'teks'], ['tanggalLahir', 'tgl'],
  ['agama', 'teks'], ['status', 'teks'], ['pekerjaan', 'teks'], ['rt', 'angka'], ['rw', 'angka'], ['keterangan', 'teks']
];
S.tabel = { kolom: 1, arah: -1, hal: 1, perHal: Number(lokal.get('bt_perhal', 10)) || 10 };
$('#d-perhal').value = String(S.tabel.perHal);

function nilaiUrut(t, k) {
  const [p, jenis] = KOLOM_TABEL[k];
  const v = t[p];
  if (jenis === 'angka') return /^\d+$/.test(String(v)) ? Number(v) : -1;
  if (jenis === 'tgl') return dmyKeIso(v) || '';
  return String(v || '').toUpperCase();
}

function renderDaftar() {
  const tb = $('#d-tabel tbody');
  if (!S.bulan) return;
  const q = $('#d-q').value.trim().toUpperCase();
  const cocok = S.bulan.rows.filter(t => !q || `${t.nama} ${t.keterangan} ${t.nik} ${t.dusun} ${t.pekerjaan}`.toUpperCase().includes(q));

  // urutkan (kolom kedua: NO, agar tamu di hari yang sama tetap berurutan)
  const { kolom, arah } = S.tabel;
  cocok.sort((a, b) => {
    const x = nilaiUrut(a, kolom), y = nilaiUrut(b, kolom);
    if (x !== y) return (x < y ? -1 : 1) * arah;
    return (Number(a.no) - Number(b.no)) * arah;
  });
  S.daftar = cocok;

  // halaman
  const total = cocok.length, per = S.tabel.perHal;
  const jmlHal = Math.max(1, Math.ceil(total / per));
  S.tabel.hal = Math.min(Math.max(1, S.tabel.hal), jmlHal);
  const awal = (S.tabel.hal - 1) * per;
  const tampilan = cocok.slice(awal, awal + per);

  const pilihanUrut = `${kolom}:${arah}`;
  if ([...$('#d-urut').options].some(o => o.value === pilihanUrut)) $('#d-urut').value = pilihanUrut;

  // judul kolom: tanda panah urutan
  $$('#d-tabel th[data-k]').forEach(th => {
    const k = Number(th.dataset.k), aktif = k === kolom;
    th.classList.toggle('aktif', aktif);
    th.setAttribute('aria-sort', aktif ? (arah > 0 ? 'ascending' : 'descending') : 'none');
    $('.panah', th).textContent = aktif ? (arah > 0 ? '▲' : '▼') : '↕';
  });

  $('#d-ringkas').textContent = q
    ? `${total} dari ${S.bulan.rows.length} tamu cocok dengan "${$('#d-q').value.trim()}"`
    : `Daftar tamu ${S.bulan.info.nama}`;
  $('#d-info').textContent = total ? `Menampilkan ${awal + 1}–${awal + tampilan.length} dari ${total} tamu` : 'Tidak ada data';
  $('#d-halaman').textContent = `Halaman ${S.tabel.hal} dari ${jmlHal}`;
  $('#d-prev').disabled = S.tabel.hal <= 1;
  $('#d-next').disabled = S.tabel.hal >= jmlHal;
  $('#d-pager').hidden = total <= per && S.tabel.hal === 1;

  tb.innerHTML = tampilan.length ? tampilan.map(t => {
    const v = barisCetak(t);
    const sel = v.map((x, j) => {
      let isi = esc(x);
      if (j === 3) isi = `<span class="lencana ${x === 'P' ? 'p' : 'l'}">${esc(x)}</span>`;
      if (j === 11) isi = `<span class="ket">${esc(x)}</span>`;
      return `<td data-l="${KOLOM_L[j]}" class="k${j}">${isi}</td>`;
    }).join('');
    return `<tr>${sel}<td class="aksi">
      <button class="ikon-btn" data-ubah="${esc(t.id)}" title="Ubah data" aria-label="Ubah data ${esc(t.nama)}"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg></button>
      <button class="ikon-btn bahaya" data-hapus="${esc(t.id)}" title="Hapus data" aria-label="Hapus data ${esc(t.nama)}"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
    </td></tr>`;
  }).join('') : `<tr><td colspan="13" class="kosong">${q ? 'Tidak ada yang cocok.' : 'Belum ada tamu pada bulan ini.'}</td></tr>`;
  $('#d-kartu').innerHTML = tampilan.length ? tampilan.map(kartuTamu).join('')
    : `<p class="pos-kosong">${q ? 'Tidak ada yang cocok.' : 'Belum ada tamu pada bulan ini.'}</p>`;
}

// warna lingkaran inisial (tetap sama untuk nama yang sama)
const WARNA_AVATAR = ['#1A6EE8', '#E8541A', '#31A24C', '#8B44D9', '#D92F7F', '#0E9AA7', '#B7791F', '#5B6B8C'];
function avatar(nama) {
  const kata = String(nama || '?').replace(/[^A-Za-z ]/g, '').trim().split(/\s+/);
  const ini = ((kata[0] || '?')[0] + (kata.length > 1 ? kata[kata.length - 1][0] : '')).toUpperCase();
  let h = 0; for (const c of String(nama)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="background:${WARNA_AVATAR[h % WARNA_AVATAR.length]}" aria-hidden="true">${esc(ini)}</span>`;
}
function kartuTamu(t) {
  const ket = t.keperluan && String(t.keterangan).toUpperCase().startsWith(t.keperluan)
    ? String(t.keterangan).slice(t.keperluan.length).replace(/^\s*-\s*/, '') : (t.keperluan ? '' : t.keterangan);
  const alamat = t.rw === '-' ? 'Luar desa' : `RT ${t.rt}/RW ${t.rw}`;
  return `<article class="pos">
    <header class="pos-kepala">${avatar(t.nama)}
      <div><b class="pos-nama">${esc(t.nama)}</b>
      <span class="pos-sub">${esc(dmyPanjang(t.tanggal))} · No. ${esc(t.no)} · ${esc(alamat)}</span></div>
    </header>
    <div class="pos-isi">
      ${t.keperluan ? `<span class="pos-perlu">${esc(labelKeperluan(t.keperluan))}</span>` : ''}${ket ? `<p>${esc(ket)}</p>` : ''}
      <p class="pos-detail">${t.lp === 'P' ? 'Perempuan' : 'Laki-laki'} · ${esc(judulKata(t.tempatLahir))}, ${esc(t.tanggalLahir)} · ${esc(judulKata(t.agama))} · ${esc(judulKata(t.status))} · ${esc(judulKata(t.pekerjaan))}</p>
    </div>
    <footer class="pos-aksi">
      <button data-ubah="${esc(t.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg>Ubah</button>
      <button data-hapus="${esc(t.id)}" class="bahaya"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>Hapus</button>
    </footer>
  </article>`;
}

// klik judul kolom = urutkan; klik lagi = balik arah
$('#d-tabel thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-k]');
  if (!th) return;
  const k = Number(th.dataset.k);
  if (S.tabel.kolom === k) S.tabel.arah *= -1;
  else { S.tabel.kolom = k; S.tabel.arah = KOLOM_TABEL[k][1] === 'teks' ? 1 : -1; }
  S.tabel.hal = 1;
  renderDaftar();
});
$('#d-tabel thead').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('th[data-k]')) { e.preventDefault(); e.target.closest('th[data-k]').click(); }
});
$('#d-urut').addEventListener('change', e => {
  const [k, a] = e.target.value.split(':').map(Number);
  S.tabel.kolom = k; S.tabel.arah = a; S.tabel.hal = 1;
  renderDaftar();
});
$('#d-perhal').addEventListener('change', e => {
  S.tabel.perHal = Number(e.target.value) || 10;
  lokal.set('bt_perhal', S.tabel.perHal);
  S.tabel.hal = 1;
  renderDaftar();
});
const pindahHal = d => { S.tabel.hal += d; renderDaftar(); $('#d-tabel').scrollIntoView({ block: 'start', behavior: 'smooth' }); };
$('#d-prev').addEventListener('click', () => pindahHal(-1));
$('#d-next').addEventListener('click', () => pindahHal(1));

const klikAksiTamu = async e => {
  const u = e.target.closest('[data-ubah]'), h = e.target.closest('[data-hapus]');
  const cari = id => S.daftar.find(t => t.id === id);
  if (u) {
    const t = cari(u.dataset.ubah);
    if (!t) return;
    S.mode = 'ubah'; S.editData = t; S.terisi = null;
    tampil('form');
    siapkanForm(t);
  }
  if (h) {
    const t = cari(h.dataset.hapus);
    if (!t) return;
    const alasan = prompt(`Hapus data ${t.nama} (No. ${t.no})?\nTulis alasan penghapusan:`);
    if (alasan === null) return;
    try { await api('hapus', { id: t.id, alasan }); toast('Data dihapus.'); muatLaporan(); } catch (err) { toast(err.message, true); }
  }
};
$('#d-tabel').addEventListener('click', klikAksiTamu);
$('#d-kartu').addEventListener('click', klikAksiTamu);

/* ---------- Excel lengkap (ExcelJS) ---------- */

const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
function muatSkrip(url, nama) {
  return new Promise((ok, gagal) => {
    if (window[nama]) return ok();
    const s = document.createElement('script');
    s.src = url; s.onload = ok; s.onerror = () => gagal(new Error('Gagal memuat pustaka Excel. Periksa internet.'));
    document.head.appendChild(s);
  });
}
const keTanggal = dmy => { const m = String(dmy || '').match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : (dmy || ''); };
const keAngka = v => /^\d+$/.test(String(v)) ? Number(v) : (v || '');

function tanggalTtd(b) {
  const now = new Date();
  const akhirBulan = new Date(b.tahun, b.bulan - 1, b.akhir);
  const d = now < akhirBulan ? now : akhirBulan;
  return `${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

async function buatExcel(rows, b) {
  await muatSkrip(EXCELJS_URL, 'ExcelJS');
  const desa = S.master.desa;
  const namaDesa = (desa.nama || 'Merden');
  const urut = rows.slice().sort((x, y) => urutKunci(x).localeCompare(urutKunci(y)));
  const rk = hitungRekap(urut, b);
  const HIJAU = 'FF1A6EE8', HIJAU_MUDA = 'FFE7F0FD', ABU = 'FFF4F6F5';
  const tipis = { style: 'thin', color: { argb: 'FF9AA5A0' } };
  const garis = { top: tipis, left: tipis, bottom: tipis, right: tipis };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Buku Tamu Desa ' + namaDesa;
  wb.created = new Date();

  const kop = [
    [`PEMERINTAH KABUPATEN ${(desa.kabupaten || '').toUpperCase()}`, 12, false],
    [`KECAMATAN ${(desa.kecamatan || '').toUpperCase()}`, 12, false],
    [`DESA ${namaDesa.toUpperCase()}`, 15, true]
  ];

  /* ----- Sheet 1: RINGKASAN (dashboard) ----- */
  const nl = (S.bulan && S.bulan.nilai) || { jumlah: 0, rata: 0, sebaran: [0, 0, 0, 0, 0], catatan: {}, saran: [], daftar: [] };
  const persen = (a, n) => n ? Math.round(a / n * 1000) / 10 : 0;
  const koma = x => String(x).replace('.', ',');
  const hariAktif = rk.perHari.filter(n => n > 0).length;
  const rataHari = hariAktif ? Math.round(rk.total / hariAktif * 10) / 10 : 0;
  const hariRamai = rk.perHari.reduce((m, n, i) => (n > m.n ? { n, i } : m), { n: 0, i: -1 });
  const urutAngka = o => Object.keys(o).filter(k => o[k] > 0).sort((x, y) => o[y] - o[x]);
  const kpUrut = urutAngka(rk.keperluan);
  const indeks = nl.jumlah ? Math.round(nl.rata * 20 * 100) / 100 : 0;
  const mutu = !nl.jumlah ? '-' : indeks >= 88.31 ? 'A – Sangat Baik' : indeks >= 76.61 ? 'B – Baik' : indeks >= 65 ? 'C – Kurang Baik' : 'D – Tidak Baik';
  const puas = nl.sebaran[3] + nl.sebaran[4];
  const BIRU = HIJAU, BIRU_MUDA = HIJAU_MUDA, EMAS = 'FFB7791F';

  const wd = wb.addWorksheet('Ringkasan', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: `&L&8Ringkasan Buku Tamu Desa ${namaDesa} - ${b.nama}&R&8Halaman &P dari &N` },
    views: [{ showGridLines: false }]
  });
  wd.columns = Array.from({ length: 8 }, () => ({ width: 13 }));
  let rr = 1;
  const gabung = (baris, k1, k2) => { wd.mergeCells(baris, k1, baris, k2); return wd.getCell(baris, k1); };
  // kop
  kop.forEach(([teks, uk, besar]) => {
    const c = gabung(rr, 1, 8);
    c.value = teks; c.font = { bold: true, size: uk }; c.alignment = { horizontal: 'center' };
    if (besar) for (let k = 1; k <= 8; k++) wd.getCell(rr, k).border = { bottom: { style: 'double' } };
    rr++;
  });
  rr++;
  let c = gabung(rr++, 1, 8);
  c.value = 'RINGKASAN BUKU TAMU & KEPUASAN PELAYANAN'; c.font = { bold: true, size: 14, color: { argb: BIRU } }; c.alignment = { horizontal: 'center' };
  c = gabung(rr++, 1, 8);
  c.value = `Bulan ${b.nama}`; c.font = { size: 11, color: { argb: 'FF65676B' } }; c.alignment = { horizontal: 'center' };
  rr++;

  // kotak angka utama (2 baris x 4 kotak)
  const kotak = (baris, kol, nilai, label, warna) => {
    wd.mergeCells(baris, kol, baris, kol + 1);
    wd.mergeCells(baris + 1, kol, baris + 1, kol + 1);
    const v = wd.getCell(baris, kol), l = wd.getCell(baris + 1, kol);
    v.value = nilai; v.font = { bold: true, size: 18, color: { argb: warna || BIRU } }; v.alignment = { horizontal: 'center', vertical: 'middle' };
    l.value = label; l.font = { size: 9, color: { argb: 'FF65676B' } }; l.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
    for (let k = kol; k <= kol + 1; k++) {
      wd.getCell(baris, k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BIRU_MUDA } };
      wd.getCell(baris + 1, k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BIRU_MUDA } };
      wd.getCell(baris, k).border = { top: { style: 'medium', color: { argb: 'FFFFFFFF' } }, left: { style: 'medium', color: { argb: 'FFFFFFFF' } }, right: { style: 'medium', color: { argb: 'FFFFFFFF' } } };
      wd.getCell(baris + 1, k).border = { bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } }, left: { style: 'medium', color: { argb: 'FFFFFFFF' } }, right: { style: 'medium', color: { argb: 'FFFFFFFF' } } };
    }
    wd.getRow(baris).height = 30; wd.getRow(baris + 1).height = 28;
  };
  kotak(rr, 1, rk.total, 'Total kunjungan');
  kotak(rr, 3, `${rk.L} / ${rk.P}`, 'Laki-laki / Perempuan');
  kotak(rr, 5, `${rk.warga} / ${rk.luar}`, 'Warga desa / Luar desa');
  kotak(rr, 7, koma(rataHari), `Rata-rata tamu per hari layanan (${hariAktif} hari)`);
  rr += 2;
  kotak(rr, 1, nl.jumlah ? `★ ${koma(nl.rata)}` : '-', 'Rata-rata kepuasan (dari 5 bintang)', EMAS);
  kotak(rr, 3, nl.jumlah, `Jumlah penilai (${koma(persen(nl.jumlah, rk.total))}% dari tamu)`, EMAS);
  kotak(rr, 5, nl.jumlah ? `${koma(persen(puas, nl.jumlah))}%` : '-', 'Puas & sangat puas (4–5 bintang)', EMAS);
  kotak(rr, 7, nl.jumlah ? koma(indeks) : '-', `Indeks kepuasan 0–100 (mutu ${mutu})`, EMAS);
  rr += 3;

  // judul bagian
  const bagian = judul => {
    const h = gabung(rr++, 1, 8);
    h.value = judul.toUpperCase(); h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BIRU } }; h.alignment = { vertical: 'middle', indent: 1 };
    wd.getRow(rr - 1).height = 20;
  };

  // kesimpulan otomatis
  bagian('Kesimpulan');
  const kalimat = [];
  kalimat.push(`Selama ${b.nama} tercatat ${rk.total} kunjungan (${rk.L} laki-laki, ${rk.P} perempuan), rata-rata ${koma(rataHari)} tamu per hari layanan dari ${hariAktif} hari yang ada kunjungan.`);
  if (hariRamai.i >= 0) kalimat.push(`Hari paling ramai: ${hariRamai.i + 1} ${b.nama} dengan ${hariRamai.n} tamu.`);
  if (kpUrut.length) kalimat.push(`Keperluan terbanyak: ${labelKeperluan(kpUrut[0])} (${koma(persen(rk.keperluan[kpUrut[0]], rk.total))}%)` + (kpUrut[1] ? `, disusul ${labelKeperluan(kpUrut[1])} (${koma(persen(rk.keperluan[kpUrut[1]], rk.total))}%).` : '.'));
  kalimat.push(`${koma(persen(rk.warga, rk.total))}% pengunjung adalah warga Desa ${namaDesa}; ${rk.luar} orang berasal dari luar desa.`);
  if (nl.jumlah) {
    kalimat.push(`Kepuasan pelayanan rata-rata ${koma(nl.rata)} dari 5 bintang (indeks ${koma(indeks)}, mutu ${mutu}) dari ${nl.jumlah} penilai; ${koma(persen(puas, nl.jumlah))}% menyatakan puas atau sangat puas.`);
    const baik = urutAngka(nl.catatan).filter(k => CATATAN_BAIK.includes(k)), kurang = urutAngka(nl.catatan).filter(k => CATATAN_KURANG.includes(k));
    if (baik.length) kalimat.push(`Hal yang paling dihargai warga: ${baik.slice(0, 2).map(k => `${k} (${nl.catatan[k]})`).join(', ')}.`);
    if (kurang.length) kalimat.push(`Hal yang perlu diperbaiki: ${kurang.slice(0, 2).map(k => `${k} (${nl.catatan[k]})`).join(', ')}.`);
  } else {
    kalimat.push('Belum ada penilaian kepuasan pada bulan ini. Ajak pengunjung menekan "Beri nilai pelayanan" setelah selesai dilayani.');
  }
  kalimat.forEach(k => {
    const s = gabung(rr, 1, 8);
    s.value = '•  ' + k; s.alignment = { wrapText: true, vertical: 'top' }; s.font = { size: 10 };
    wd.getRow(rr).height = k.length > 105 ? 30 : 16;
    rr++;
  });
  rr++;

  // tabel dengan grafik batang dari teks
  const tabelGrafik = (judul, pasangan, penyebut, opsi = {}) => {
    bagian(judul);
    const h = wd.getRow(rr);
    wd.mergeCells(rr, 1, rr, 4); wd.mergeCells(rr, 7, rr, 8);
    h.getCell(1).value = opsi.kolom || 'Uraian'; h.getCell(5).value = 'Jumlah'; h.getCell(6).value = opsi.tanpaPersen ? '' : 'Persen'; h.getCell(7).value = 'Grafik';
    [1, 5, 6, 7].forEach(k => { const x = h.getCell(k); x.font = { bold: true, size: 9, color: { argb: 'FF65676B' } }; x.alignment = { horizontal: k === 1 ? 'left' : 'center' }; });
    for (let k = 1; k <= 8; k++) h.getCell(k).border = { bottom: tipis };
    rr++;
    const maks = Math.max(1, ...pasangan.map(p => p[1]));
    if (!pasangan.length) { const x = gabung(rr++, 1, 8); x.value = 'Belum ada data.'; x.font = { italic: true, color: { argb: 'FF65676B' } }; }
    pasangan.forEach(([k, v], i) => {
      const r = wd.getRow(rr);
      wd.mergeCells(rr, 1, rr, 4); wd.mergeCells(rr, 7, rr, 8);
      r.getCell(1).value = k; r.getCell(5).value = v;
      r.getCell(6).value = opsi.tanpaPersen || !penyebut ? '' : v / penyebut; r.getCell(6).numFmt = '0.0%';
      r.getCell(7).value = '█'.repeat(Math.round(v / maks * 18)) || (v ? '▏' : '');
      r.getCell(7).font = { color: { argb: opsi.warna || BIRU } };
      r.getCell(5).alignment = { horizontal: 'center' }; r.getCell(6).alignment = { horizontal: 'center' };
      if (opsi.warnaLabel) r.getCell(1).font = { color: { argb: opsi.warnaLabel } };
      for (let x = 1; x <= 8; x++) { r.getCell(x).border = { bottom: { style: 'hair', color: { argb: 'FFDADDE1' } } }; if (i % 2) r.getCell(x).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F8FA' } }; }
      rr++;
    });
    rr++;
  };

  // kepuasan dulu (paling penting bagi pimpinan), lalu pengunjung
  tabelGrafik('Kepuasan pelayanan (sebaran bintang)', [5, 4, 3, 2, 1].map(n => [`${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${LABEL_NILAI[n]}`, nl.sebaran[n - 1]]), nl.jumlah, { kolom: 'Penilaian', warna: EMAS, warnaLabel: EMAS });
  const alasan = urutAngka(nl.catatan);
  if (alasan.length) tabelGrafik('Alasan yang dipilih penilai', alasan.map(k => [`${CATATAN_KURANG.includes(k) ? '⚠ ' : '✓ '}${k}`, nl.catatan[k]]), nl.jumlah, { kolom: 'Alasan', tanpaPersen: true });
  if (nl.saran.length) {
    bagian('Saran terbaru dari warga');
    nl.saran.slice(0, 10).forEach(s => {
      const r = wd.getRow(rr);
      r.getCell(1).value = s.tanggal; r.getCell(2).value = '★'.repeat(s.nilai); r.getCell(2).font = { color: { argb: EMAS } };
      wd.mergeCells(rr, 3, rr, 8);
      r.getCell(3).value = s.saran; r.getCell(3).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(1).font = { size: 9, color: { argb: 'FF65676B' } };
      r.height = String(s.saran).length > 70 ? 30 : 16;
      rr++;
    });
    rr++;
  }
  tabelGrafik('Kunjungan per keperluan', kpUrut.map(k => [labelKeperluan(k), rk.keperluan[k]]), rk.total, { kolom: 'Keperluan' });
  tabelGrafik('Kunjungan per dusun', urutAngka(rk.dusun).map(k => [judulKata(k), rk.dusun[k]]), rk.total, { kolom: 'Dusun' });
  tabelGrafik('Kelompok umur pengunjung', Object.keys(rk.umur).map(k => [k + ' tahun', rk.umur[k]]), rk.total, { kolom: 'Umur' });
  const mingguan = [];
  for (let m = 0; m * 7 < b.akhir; m++) {
    const a = m * 7 + 1, z = Math.min(b.akhir, a + 6);
    mingguan.push([`Minggu ${m + 1} (${a}–${z} ${BULAN[b.bulan - 1].slice(0, 3)})`, rk.perHari.slice(a - 1, z).reduce((s, n) => s + n, 0)]);
  }
  tabelGrafik('Tren kunjungan per minggu', mingguan, rk.total, { kolom: 'Minggu' });

  // catatan & tanda tangan
  c = gabung(rr++, 1, 8);
  c.value = 'Catatan: indeks kepuasan = rata-rata bintang × 20 (skala 0–100), kategori mutu mengacu rentang nilai SKM PermenPAN-RB 14/2017 sebagai gambaran umum.';
  c.font = { italic: true, size: 8, color: { argb: 'FF65676B' } }; c.alignment = { wrapText: true }; wd.getRow(rr - 1).height = 24;
  rr++;
  [`${namaDesa}, ${tanggalTtd(b)}`, `Kepala Desa ${namaDesa}`, '', '', '', desa.kades || '( ................................ )'].forEach((teks, i) => {
    const x = gabung(rr++, 5, 8);
    x.value = teks; x.alignment = { horizontal: 'center' };
    if (i === 5) x.font = { bold: true, underline: !!desa.kades };
  });

  /* ----- Sheet 2: Buku Tamu (data kunjungan) ----- */
  const ws = wb.addWorksheet('Buku Tamu', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: `&L&8Buku Tamu Desa ${namaDesa} - ${b.nama}&R&8Halaman &P dari &N` },
    views: [{ state: 'frozen', ySplit: 7 }]
  });
  ws.columns = [5, 12, 30, 5, 17, 13, 12, 21, 26, 5, 5, 42].map(w => ({ width: w }));
  kop.forEach(([teks, uk, besar], i) => {
    ws.mergeCells(i + 1, 1, i + 1, 12);
    const c = ws.getCell(i + 1, 1);
    c.value = teks; c.font = { bold: true, size: uk }; c.alignment = { horizontal: 'center' };
    if (besar) for (let k = 1; k <= 12; k++) ws.getCell(i + 1, k).border = { bottom: { style: 'double' } };
  });
  ws.mergeCells(5, 1, 5, 12);
  Object.assign(ws.getCell(5, 1), { value: `BUKU TAMU BULAN ${b.nama.toUpperCase()}` });
  ws.getCell(5, 1).font = { bold: true, size: 13 }; ws.getCell(5, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(6, 1, 6, 12);
  ws.getCell(6, 1).value = `Jumlah tamu: ${rk.total} orang (Laki-laki ${rk.L}, Perempuan ${rk.P}) — warga desa ${rk.warga}, luar desa ${rk.luar}`;
  ws.getCell(6, 1).font = { italic: true, size: 10 }; ws.getCell(6, 1).alignment = { horizontal: 'center' };

  const kepala = ws.getRow(7);
  kepala.values = KOLOM_L;
  kepala.height = 30;
  kepala.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HIJAU } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = garis;
  });
  urut.forEach((t, i) => {
    const row = ws.addRow([keAngka(t.no), keTanggal(t.tanggal), t.nama, t.lp, t.tempatLahir, keTanggal(t.tanggalLahir),
      t.agama, t.status, t.pekerjaan, keAngka(t.rt), keAngka(t.rw), t.keterangan]);
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.border = garis;
      c.alignment = { vertical: 'top', wrapText: col === 3 || col === 9 || col === 12, horizontal: [1, 2, 4, 6, 10, 11].includes(col) ? 'center' : 'left' };
      if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ABU } };
    });
    row.getCell(2).numFmt = 'dd-mm-yyyy';
    row.getCell(6).numFmt = 'dd-mm-yyyy';
  });
  if (urut.length) ws.autoFilter = { from: { row: 7, column: 1 }, to: { row: 7 + urut.length, column: 12 } };
  ws.pageSetup.printTitlesRow = '7:7';

  // tanda tangan Kepala Desa
  const t0 = 7 + urut.length + 2;
  [`${namaDesa}, ${tanggalTtd(b)}`, `Kepala Desa ${namaDesa}`, '', '', '', desa.kades || '( ................................ )'].forEach((teks, i) => {
    ws.mergeCells(t0 + i, 9, t0 + i, 12);
    const c = ws.getCell(t0 + i, 9);
    c.value = teks; c.alignment = { horizontal: 'center' };
    if (i === 5) c.font = { bold: true, underline: !!desa.kades };
  });

  /* ----- Sheet 3: PENILAIAN (data mentah rating, tanpa nama) ----- */
  const wp = wb.addWorksheet('Penilaian', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 4 }]
  });
  wp.columns = [6, 12, 9, 9, 22, 30, 50].map(w => ({ width: w }));
  wp.mergeCells(1, 1, 1, 7); wp.getCell(1, 1).value = `DATA PENILAIAN KEPUASAN PELAYANAN — DESA ${namaDesa.toUpperCase()}`;
  wp.getCell(1, 1).font = { bold: true, size: 13 }; wp.getCell(1, 1).alignment = { horizontal: 'center' };
  wp.mergeCells(2, 1, 2, 7); wp.getCell(2, 1).value = `Bulan ${b.nama} · ${nl.jumlah} penilaian · rata-rata ${koma(nl.rata)} dari 5 · tanpa nama penilai`;
  wp.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF65676B' } }; wp.getCell(2, 1).alignment = { horizontal: 'center' };
  const kp = wp.getRow(4);
  kp.values = ['NO', 'TANGGAL', 'JAM', 'BINTANG', 'PENILAIAN', 'ALASAN', 'SARAN'];
  kp.height = 22;
  kp.eachCell(x => { x.font = { bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HIJAU } }; x.alignment = { horizontal: 'center', vertical: 'middle' }; x.border = garis; });
  const daftarNilai = (nl.daftar || []).slice().sort((x, y) => String(x.waktu).localeCompare(String(y.waktu)));
  daftarNilai.forEach((d, i) => {
    const jam = String(d.waktu || '').split(' ')[1] || '';
    const r = wp.addRow([i + 1, keTanggal(d.tanggal), jam.slice(0, 5), d.nilai, `${'★'.repeat(d.nilai)}${'☆'.repeat(5 - d.nilai)} ${LABEL_NILAI[d.nilai] || ''}`, d.catatan || '', d.saran || '']);
    r.eachCell({ includeEmpty: true }, (x, col) => {
      x.border = garis;
      x.alignment = { vertical: 'top', wrapText: col >= 6, horizontal: col <= 4 ? 'center' : 'left' };
      if (i % 2 === 1) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ABU } };
    });
    r.getCell(2).numFmt = 'dd-mm-yyyy';
    r.getCell(5).font = { color: { argb: EMAS } };
  });
  if (!daftarNilai.length) { wp.mergeCells(5, 1, 5, 7); wp.getCell(5, 1).value = 'Belum ada penilaian pada bulan ini.'; wp.getCell(5, 1).font = { italic: true }; }
  else wp.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + daftarNilai.length, column: 7 } };
  wp.pageSetup.printTitlesRow = '4:4';

  wb.views = [{ activeTab: 0, firstSheet: 0 }];
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Buku_Tamu_${namaDesa}_${b.nama.replace(' ', '_')}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return rk;
}

$('#l-unduh').addEventListener('click', () => sibuk($('#l-unduh'), async () => {
  const b = infoBulan();
  if (!b) { toast('Pilih bulan dulu.', true); return; }
  try {
    if (!S.bulan || S.bulan.info.v !== b.v) await muatLaporan();
    if (!S.bulan || !S.bulan.rows.length) { toast(`Belum ada tamu pada ${b.nama}.`, true); return; }
    const rk = await buatExcel(S.bulan.rows, b);
    toast(`Excel ${b.nama} diunduh (${rk.total} tamu).`);
  } catch (e) { toast(e.message, true); }
}));

$('#l-cetak').addEventListener('click', () => {
  if (!S.bulan || !S.bulan.rows.length) { toast('Belum ada tamu pada bulan ini.', true); return; }
  const d = S.master.desa, b = S.bulan.info;
  const urut = S.bulan.rows.slice().sort((x, y) => urutKunci(x).localeCompare(urutKunci(y)));
  const rk = hitungRekap(urut, b);
  $('#cetak').innerHTML = `
    <div class="kop">
      <div>PEMERINTAH KABUPATEN ${esc((d.kabupaten || '').toUpperCase())}</div>
      <div>KECAMATAN ${esc((d.kecamatan || '').toUpperCase())}</div>
      <div class="besar">DESA ${esc((d.nama || 'MERDEN').toUpperCase())}</div>
    </div>
    <h3>BUKU TAMU BULAN ${esc(b.nama.toUpperCase())}</h3>
    <p style="text-align:center;margin:0 0 8px">Jumlah tamu: ${rk.total} orang (Laki-laki ${rk.L}, Perempuan ${rk.P})${S.bulan.nilai && S.bulan.nilai.jumlah ? ` · Kepuasan pelayanan: ${String(S.bulan.nilai.rata).replace('.', ',')} dari 5 (${S.bulan.nilai.jumlah} penilai)` : ''}</p>
    <table><thead><tr>${KOLOM_L.map(k => `<th>${k}</th>`).join('')}</tr></thead>
    <tbody>${urut.map(t => `<tr>${barisCetak(t).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <div class="ttd">
      <div>${esc(d.nama || 'Merden')}, ${tanggalTtd(b)}</div>
      <div>Kepala Desa ${esc(d.nama || 'Merden')}</div>
      <div class="nama">${esc(d.kades || '....................................')}</div>
    </div>`;
  window.print();
});

/* ================= PENGATURAN ================= */

async function muatPengaturan() {
  perbaruiAntrean();
  if (!admin()) return;
  try {
    const r = await api('pengaturan', {}, { ulang: 1 });
    ['NAMA_DESA', 'KECAMATAN', 'KABUPATEN', 'NAMA_KADES', 'RESET_NO'].forEach(k => { $('#a-' + k).value = r.data[k] || (k === 'RESET_NO' ? 'TAHUN' : ''); });
    $('#a-SUMBER_PENDUDUK').value = r.data.SUMBER_PENDUDUK || '';
    $('#a-SHEET_PENDUDUK').value = r.data.SHEET_PENDUDUK || 'DATA_KK';
    tampilInfoSumber(r.data);
  } catch (e) { pesan($('#a-desa-pesan'), e.message, 'err'); }
}

$('#a-desa-simpan').addEventListener('click', () => sibuk($('#a-desa-simpan'), async () => {
  const set = {};
  ['NAMA_DESA', 'KECAMATAN', 'KABUPATEN', 'NAMA_KADES', 'RESET_NO'].forEach(k => { set[k] = $('#a-' + k).value; });
  try { await api('pengaturan', { set }); pesan($('#a-desa-pesan'), 'Tersimpan.', 'ok'); muatMaster(); }
  catch (e) { pesan($('#a-desa-pesan'), e.message, 'err'); }
}));

$('#a-pin-simpan').addEventListener('click', () => sibuk($('#a-pin-simpan'), async () => {
  const pin = $('#a-pin').value;
  if (!/^\d{6}$/.test(pin)) { pesan($('#a-pin-pesan'), 'PIN harus 6 angka.', 'err'); return; }
  try {
    await api('gantiPin', { untuk: 'admin', pinBaru: pin });
    $('#a-pin').value = '';
    pesan($('#a-pin-pesan'), 'PIN berhasil diganti.', 'ok');
  } catch (e) { pesan($('#a-pin-pesan'), e.message, 'err'); }
}));


/* ---------- sumber data penduduk (Kartu Pintar) ---------- */

const ringkasSumber = r => `Terhubung ke sheet "${r.sheet}": ${Number(r.jumlah).toLocaleString('id-ID')} penduduk, ${r.jumlahRw} RW, ${r.jumlahPekerjaan} jenis pekerjaan.` +
  (r.nikGanda ? ` NIK ganda: ${r.nikGanda}.` : '') + (r.tanpaNik ? ` Tanpa NIK: ${r.tanpaNik}.` : '') + (r.nikSalah ? ` NIK tidak 16 angka: ${r.nikSalah}.` : '');

$('#a-sumber-simpan').addEventListener('click', () => sibuk($('#a-sumber-simpan'), async () => {
  const msg = $('#a-sumber-pesan');
  const url = $('#a-SUMBER_PENDUDUK').value.trim();
  if (!/docs\.google\.com\/spreadsheets\/d\//.test(url)) { pesan(msg, 'Tempel alamat lengkap spreadsheet Kartu Pintar (https://docs.google.com/spreadsheets/d/...).', 'err'); return; }
  pesan(msg, 'Menghubungkan dan memeriksa data… (bisa sampai 30 detik)');
  try {
    const r = await api('pengaturan', { set: { SUMBER_PENDUDUK: url, SHEET_PENDUDUK: $('#a-SHEET_PENDUDUK').value.trim() || 'DATA_KK' } }, { timeout: 120000 });
    pesan(msg, ringkasSumber(r.cek), 'ok');
    await muatMaster();
    tampilInfoSumber(r.data);
  } catch (e) { pesan(msg, e.message, 'err'); }
}));

$('#a-segarkan').addEventListener('click', () => sibuk($('#a-segarkan'), async () => {
  const msg = $('#a-sumber-pesan');
  try {
    const r = await api('segarkanPenduduk', {}, { timeout: 120000 });
    pesan(msg, ringkasSumber(r), 'ok');
    await muatMaster();
    $('#a-sumber-info').textContent = `Pilihan terakhir disegarkan: ${r.waktu}`;
  } catch (e) { pesan(msg, e.message, 'err'); }
}));

function tampilInfoSumber(d) {
  $('#a-sumber-info').textContent = d.SUMBER_PENDUDUK
    ? `Status: terhubung. Pilihan terakhir disegarkan: ${d.TANGGAL_SEGAR || '-'}`
    : 'Status: BELUM terhubung — pencarian NIK belum bisa dipakai.';
}

/* ================= MULAI ================= */

function mulai() {
  tickJam();
  setInterval(tickJam, 15000);
  aturPeran();
  terapkanMaster();
  window.addEventListener('online', aturNet);
  window.addEventListener('offline', aturNet);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { kirimAntrean(); hangatkan(); } });
  setInterval(kirimAntrean, 60000);
  aturNet();
  perbaruiAntrean();
  muatMaster();
  tampil('nik');
}

/* ================= PASANG APLIKASI (PWA) ================= */

let _promptPasang = null;
const sudahTerpasang = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
function aturTombolPasang() {
  const bisa = !sudahTerpasang();
  $('#btn-pasang').hidden = !(bisa && petugas());
  $('#a-pasang-kartu').hidden = !bisa;
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();            // tahan banner bawaan; pakai tombol "Pasang" sendiri
  _promptPasang = e;
  aturTombolPasang();
});
window.addEventListener('appinstalled', () => {
  _promptPasang = null;
  $('#btn-pasang').hidden = true;
  toast('Aplikasi terpasang. Buka dari ikon Buku Tamu di layar HP.');
});
async function mulaiPasang() {
  if (_promptPasang) {
    _promptPasang.prompt();
    const pilihan = await _promptPasang.userChoice.catch(() => null);
    _promptPasang = null;
    if (pilihan && pilihan.outcome === 'accepted') $('#btn-pasang').hidden = true;
    return;
  }
  // iPhone / browser di dalam aplikasi lain: tampilkan panduan
  const ua = navigator.userAgent;
  const dalamApp = /FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(ua);
  $('#pasang-catatan').textContent = dalamApp
    ? 'Anda membuka dari dalam aplikasi lain. Salin alamat ini lalu buka di Google Chrome agar bisa dipasang.'
    : 'Ikuti langkah sesuai jenis HP Anda:';
  $('#dlg-pasang').showModal();
}
$('#btn-pasang').addEventListener('click', mulaiPasang);
$('#a-pasang').addEventListener('click', mulaiPasang);
$('#pasang-tutup').addEventListener('click', () => $('#dlg-pasang').close());
window.matchMedia('(display-mode: standalone)').addEventListener('change', aturTombolPasang);
aturTombolPasang();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* abaikan */ }));
}

mulai();
