/* Buku Tamu Desa Merden — frontend PWA
 * Alur tamu: 1) NIK  2) pilih keperluan  3) simpan.
 * Data disimpan dulu di tablet (antrean), lalu dikirim ke server — tidak ada data hilang saat sinyal putus. */
'use strict';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
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
const conf = () => lokal.get('bt_conf', {});

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
        body: JSON.stringify(Object.assign({ action, kunci: c.kunci, token: S.token, perangkat: c.perangkat }, data)),
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
    try { j = await res.json(); } catch (e) { throw new Error('Jawaban server tidak valid. Periksa URL server.'); }
    if (!j.ok) {
      if (j.pesan === 'SESI_HABIS') { akhiriSesi(); throw new Error('Sesi petugas habis. Silakan masuk lagi.'); }
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

const VIEW_PETUGAS = ['daftar', 'rekap', 'atur'];

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
  if (id === 'daftar') muatDaftar();
  if (id === 'rekap') muatRekap();
  if (id === 'atur') muatPengaturan();
  resetDiam();
}

function aturPeran() {
  $$('[data-peran]').forEach(el => { el.hidden = el.dataset.peran === 'admin' ? !admin() : !petugas(); });
  document.body.classList.toggle('petugas', petugas());
  $('#btn-masuk').textContent = petugas() ? 'Keluar' : 'Petugas';
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
  const perlu = S.view === 'pilih' || S.view === 'form' || (S.view === 'nik' && S.nik);
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
  $('#d-rw').innerHTML = '<option value="">Semua</option>' + m.wilayah.map(w => `<option value="${esc(w.rw)}">RW ${esc(w.rw)} – ${esc(judulKata(w.dusun))}</option>`).join('');
  $('#d-keperluan').innerHTML = '<option value="">Semua</option>' + m.keperluan.map(k => `<option>${esc(k)}</option>`).join('');
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
  if (!b || b.closest('#d-periode')) return;
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

function tekanNik(k) {
  if (k === 'hapus') S.nik = S.nik.slice(0, -1);
  else if (k === 'cari') { if (S.nik.length === 16) cariNik(); return; }
  else if (/^\d$/.test(k) && S.nik.length < 16) S.nik += k;
  pesan($('#nik-pesan'), '');
  renderNik();
  if (S.nik.length === 1) hangatkan();
}

$('#nik-pad').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !b.disabled) tekanNik(b.dataset.k || b.textContent.trim());
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
  const info = [
    ['Jenis kelamin', p.lp === 'P' ? 'Perempuan' : 'Laki-laki'],
    ['Lahir', `${judulKata(p.tempatLahir)}, ${dmyPanjang(p.tanggalLahir)}`],
    ['Alamat', `RT ${p.rt} / RW ${p.rw}, Dusun ${judulKata(p.dusun)}`],
    ['Pekerjaan', judulKata(p.pekerjaan)]
  ];
  $('#p-info').innerHTML = info.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join('');
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

/* ================= ISI MANUAL / UBAH ================= */

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
  $('#form-simpan').textContent = S.mode === 'ubah' ? 'Simpan Perubahan' : 'Simpan';
  if (!d) return;
  $('#f-nama').value = d.nama || '';
  $('#f-nik').value = d.nik || '';
  pilihChip('#c-lp', d.lp || '');
  $('#f-tempat').value = d.tempatLahir || '';
  $('#f-tgllahir').value = dmyKeIso(d.tanggalLahir);
  pilihChip('#c-agama', d.agama || '');
  pilihChip('#c-status', d.status || '');
  $('#f-pekerjaan').value = d.pekerjaan || '';
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
    tanggalLahir: isoKeDmy($('#f-tgllahir').value),
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

function validasiForm(d) {
  const salah = {};
  if (d.nama.length < 3) salah.nama = 'Nama minimal 3 huruf';
  if (d.nik && d.nik.length !== 16) salah.nik = 'NIK harus 16 angka, atau kosongkan';
  if (!d.lp) salah.lp = 'Pilih jenis kelamin';
  if (!d.tempatLahir) salah.tempatLahir = 'Tempat lahir wajib diisi';
  if (!d.tanggalLahir) salah.tanggalLahir = 'Tanggal lahir wajib diisi';
  else if (dmyKeIso(d.tanggalLahir) > isoHariIni()) salah.tanggalLahir = 'Tanggal lahir tidak boleh setelah hari ini';
  if (!d.agama) salah.agama = 'Pilih agama';
  if (!d.status) salah.status = 'Pilih status perkawinan';
  if (!d.pekerjaan) salah.pekerjaan = 'Pekerjaan wajib diisi';
  if (d.rw !== '-') { if (!d.rw) salah.rw = 'Pilih RW'; else if (!d.rt) salah.rt = 'Pilih RT'; }
  if (!d.keterangan) salah.keperluan = 'Pilih keperluan atau tulis keterangan';
  else if (d.keperluan === 'LAINNYA' && d.keterangan === 'LAINNYA') salah.keterangan = 'Tulis keperluan Anda';
  $$('#form-tamu [data-f]').forEach(bersihSalah);
  Object.keys(salah).forEach(k => {
    const el = $(`#form-tamu [data-f="${k}"]`);
    if (el) { el.classList.add('salah'); $('small', el).textContent = salah[k]; }
  });
  const pertama = $('#form-tamu .salah');
  if (pertama) pertama.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return !pertama;
}

$('#f-luar').addEventListener('change', e => { $('#alamat-desa').hidden = e.target.checked; });
$('#batal-btn').addEventListener('click', () => tampil(S.mode === 'ubah' ? 'daftar' : 'nik'));
$('#form-tamu').addEventListener('input', e => bersihSalah(e.target.closest('[data-f]')));

$('#form-tamu').addEventListener('submit', e => {
  e.preventDefault();
  const d = bacaForm();
  if (!validasiForm(d)) return;
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
    const r = await api('simpan', { data: item.data }, { timeout: 30000 });
    await Antrean.hapus(item.id);
    return r.no;
  } catch (e) {
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
  let no = null;
  if (navigator.onLine) {
    no = await Promise.race([kirimSatu(item).catch(() => null), tunggu(TUNGGU_NOMOR_MS).then(() => null)]);
  }
  perbaruiAntrean();
  layarTerima(d, no, navigator.onLine);
}

function layarTerima(d, no, online) {
  const depan = judulKata(String(d.nama).split(' ')[0]);
  $('#terima-judul').textContent = `Terima kasih, ${depan}`;
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
      <div class="kartu-hasil"><span><b>${esc(i.data.nama)}</b><span class="muted">${esc(i.data.tanggal)} · ${esc(i.galat)}</span></span>
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
    if (!confirm('Keluar dari mode petugas?')) return;
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
    toast(`Masuk sebagai ${r.peran}.`);
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

/* ================= DAFTAR ================= */

function aturPeriode(p) {
  const now = new Date();
  let dari = new Date(now);
  if (p === 'minggu') dari.setDate(now.getDate() - 6);
  if (p === 'bulan') dari = new Date(now.getFullYear(), now.getMonth(), 1);
  if (p === 'tahun') dari = new Date(now.getFullYear(), 0, 1);
  $('#d-dari').value = isoHariIni(dari);
  $('#d-sampai').value = isoHariIni(now);
  $$('#d-periode button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
}
$('#d-periode').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) { aturPeriode(b.dataset.p); muatDaftar(); }
});
['#d-dari', '#d-sampai'].forEach(s => $(s).addEventListener('change', () => $$('#d-periode button').forEach(b => b.classList.remove('on'))));
$('#d-rw').addEventListener('change', () => {
  const w = (S.master.wilayah || []).find(x => x.rw === $('#d-rw').value);
  let h = '<option value="">Semua</option>';
  if (w) for (let i = 1; i <= w.jumlahRt; i++) h += `<option value="${i}">RT ${i}</option>`;
  $('#d-rt').innerHTML = h;
});
$('#d-tampil').addEventListener('click', () => muatDaftar());
$('#d-q').addEventListener('keydown', e => { if (e.key === 'Enter') muatDaftar(); });

const filterDaftar = () => ({
  dari: $('#d-dari').value, sampai: $('#d-sampai').value, q: $('#d-q').value.trim(),
  rw: $('#d-rw').value, rt: $('#d-rt').value, lp: $('#d-lp').value, keperluan: $('#d-keperluan').value
});
const KOLOM_L = ['NO', 'TANGGAL', 'NAMA', 'L/P', 'TEMPAT LAHIR', 'TANGGAL LAHIR', 'AGAMA', 'STATUS PERKAWINAN', 'PEKERJAAN', 'RT', 'RW', 'KETERANGAN'];

async function muatDaftar() {
  if (!$('#d-dari').value) aturPeriode('hari');
  const tb = $('#d-tabel tbody');
  tb.innerHTML = '<tr><td colspan="13" class="kosong">Memuat…</td></tr>';
  await sibuk($('#d-tampil'), async () => {
    try {
      const r = await api('daftar', { filter: filterDaftar() }, { ulang: 1 });
      S.daftar = r.data;
      $('#d-ringkas').textContent = `${r.total} tamu · Laki-laki ${r.L} · Perempuan ${r.P}`;
      tb.innerHTML = r.data.length ? r.data.map((t, i) => {
        const v = [t.no, t.tanggal, t.nama, t.lp, t.tempatLahir, t.tanggalLahir, t.agama, t.status, t.pekerjaan, t.rt, t.rw, t.keterangan];
        return `<tr>${v.map((x, j) => `<td data-l="${KOLOM_L[j]}">${esc(x)}</td>`).join('')}
          <td class="aksi"><button class="btn btn-ghost btn-sm" data-ubah="${i}">Ubah</button><button class="btn btn-danger btn-sm" data-hapus="${i}">Hapus</button></td></tr>`;
      }).join('') : '<tr><td colspan="13" class="kosong">Belum ada tamu pada periode ini.</td></tr>';
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="13" class="kosong">${esc(e.message)}</td></tr>`;
    }
  });
}

$('#d-tabel').addEventListener('click', async e => {
  const u = e.target.closest('[data-ubah]'), h = e.target.closest('[data-hapus]');
  if (u) {
    const t = S.daftar[Number(u.dataset.ubah)];
    S.mode = 'ubah'; S.editData = t; S.terisi = null;
    tampil('form');
    siapkanForm(t);
  }
  if (h) {
    const t = S.daftar[Number(h.dataset.hapus)];
    const alasan = prompt(`Hapus data ${t.nama} (No. ${t.no})?\nTulis alasan penghapusan:`);
    if (alasan === null) return;
    try { await api('hapus', { id: t.id, alasan }); toast('Data dihapus.'); muatDaftar(); } catch (err) { toast(err.message, true); }
  }
});

/* ---------- Excel & cetak ---------- */

function muatSkrip(url) {
  return new Promise((ok, gagal) => {
    if (window.XLSX) return ok();
    const s = document.createElement('script');
    s.src = url; s.onload = ok; s.onerror = () => gagal(new Error('Gagal memuat pustaka Excel. Periksa internet.'));
    document.head.appendChild(s);
  });
}
const barisCetak = t => [t.no, t.tanggal, t.nama, t.lp, t.tempatLahir, t.tanggalLahir, t.agama, t.status, t.pekerjaan, t.rt, t.rw, t.keterangan];
function labelPeriode() {
  const f = filterDaftar();
  const a = isoKeDmy(f.dari), b = isoKeDmy(f.sampai);
  return a && b ? (a === b ? a : `${a} s.d. ${b}`) : 'Semua tanggal';
}

$('#d-excel').addEventListener('click', () => sibuk($('#d-excel'), async () => {
  if (!S.daftar.length) { toast('Tidak ada data untuk diunduh.', true); return; }
  try {
    await muatSkrip(XLSX_URL);
    const aoa = [['BUKU TAMU DESA ' + (S.master.desa.nama || 'MERDEN').toUpperCase()], ['Periode: ' + labelPeriode()], [], KOLOM_L]
      .concat(S.daftar.slice().reverse().map(barisCetak));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [6, 12, 28, 5, 16, 14, 12, 18, 24, 5, 5, 40].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Buku Tamu');
    XLSX.writeFile(wb, `Buku_Tamu_${labelPeriode().replace(/[^\w-]+/g, '_')}.xlsx`);
  } catch (e) { toast(e.message, true); }
}));

$('#d-cetak').addEventListener('click', () => {
  if (!S.daftar.length) { toast('Tidak ada data untuk dicetak.', true); return; }
  const d = S.master.desa;
  const now = new Date();
  $('#cetak').innerHTML = `
    <div class="kop">
      <div>PEMERINTAH KABUPATEN ${esc((d.kabupaten || '').toUpperCase())}</div>
      <div>KECAMATAN ${esc((d.kecamatan || '').toUpperCase())}</div>
      <div class="besar">DESA ${esc((d.nama || 'MERDEN').toUpperCase())}</div>
    </div>
    <h3>BUKU TAMU</h3>
    <p style="text-align:center;margin:0 0 8px">Periode: ${esc(labelPeriode())}</p>
    <table><thead><tr>${KOLOM_L.map(k => `<th>${k}</th>`).join('')}</tr></thead>
    <tbody>${S.daftar.slice().reverse().map(t => `<tr>${barisCetak(t).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <div class="ttd">
      <div>${esc(d.nama || 'Merden')}, ${now.getDate()} ${BULAN[now.getMonth()]} ${now.getFullYear()}</div>
      <div>Kepala Desa ${esc(d.nama || 'Merden')}</div>
      <div class="nama">${esc(d.kades || '....................................')}</div>
    </div>`;
  window.print();
});

/* ================= REKAP ================= */

(function () {
  const y = new Date().getFullYear();
  $('#r-tahun').innerHTML = [0, 1, 2, 3, 4].map(i => `<option>${y - i}</option>`).join('');
  $('#r-bulan').value = String(new Date().getMonth() + 1);
})();
['#r-tahun', '#r-bulan'].forEach(s => $(s).addEventListener('change', muatRekap));

function tabelMini(judul, obj) {
  const rows = Object.keys(obj).filter(k => obj[k] > 0).sort((a, b) => obj[b] - obj[a]);
  return `<div class="card"><h2>${judul}</h2><table class="mini">${rows.length ? rows.map(k => `<tr><td>${esc(judulKata(k))}</td><td>${obj[k]}</td></tr>`).join('') : '<tr><td class="muted">Belum ada data</td><td></td></tr>'}</table></div>`;
}

async function muatRekap() {
  const isi = $('#r-isi');
  isi.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const r = await api('rekap', { tahun: $('#r-tahun').value, bulan: $('#r-bulan').value }, { ulang: 1 });
    const per = r.perPeriode;
    const maks = Math.max(1, ...Object.values(per));
    const label = k => r.bulan ? String(Number(k)) : BULAN[Number(k) - 1].slice(0, 3);
    isi.innerHTML = `
      <div class="kpi">
        <div><b>${r.hariIni}</b><span>Tamu hari ini</span></div>
        <div><b>${r.total}</b><span>Total ${r.bulan ? BULAN[Number(r.bulan) - 1] + ' ' : ''}${r.tahun}</span></div>
        <div><b>${r.L}</b><span>Laki-laki</span></div>
        <div><b>${r.P}</b><span>Perempuan</span></div>
      </div>
      <div class="card"><h2>Tamu per ${r.bulan ? 'hari' : 'bulan'}</h2>
        <div class="bars">${Object.keys(per).map(k => `<div class="bar"><em>${per[k] || ''}</em><i style="height:${per[k] / maks * 100}%"></i>${label(k)}</div>`).join('')}</div>
      </div>
      <div class="dua-kolom">
        ${tabelMini('Keperluan', r.keperluan)}
        ${tabelMini('Dusun', r.dusun)}
        ${tabelMini('RW', r.rw)}
        ${tabelMini('Kelompok umur', r.umur)}
        ${tabelMini('Sumber data', r.sumber)}
      </div>`;
  } catch (e) {
    isi.innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
  }
}

/* ================= PENGATURAN ================= */

async function muatPengaturan() {
  perbaruiAntrean();
  const c = conf();
  $('#a-koneksi').textContent = `Perangkat: ${c.perangkat || '-'}`;
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
    await api('gantiPin', { untuk: $('#a-pin-untuk').value, pinBaru: pin });
    $('#a-pin').value = '';
    pesan($('#a-pin-pesan'), 'PIN berhasil diganti.', 'ok');
  } catch (e) { pesan($('#a-pin-pesan'), e.message, 'err'); }
}));

$('#a-ubah-koneksi').addEventListener('click', () => { isiSetup(); $$('main > .view').forEach(v => { v.hidden = v.id !== 'v-setup'; }); S.view = 'setup'; });

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

/* ================= PENGATURAN AWAL ================= */

function isiSetup() {
  const c = conf();
  $('#s-url').value = c.url || '';
  $('#s-kunci').value = c.kunci || '';
  $('#s-perangkat').value = c.perangkat || '';
}

$('#s-simpan').addEventListener('click', () => sibuk($('#s-simpan'), async () => {
  const msg = $('#s-pesan');
  const url = $('#s-url').value.trim();
  const kunci = $('#s-kunci').value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) { pesan(msg, 'URL harus berbentuk https://script.google.com/macros/s/.../exec', 'err'); return; }
  if (!kunci) { pesan(msg, 'Kunci API wajib diisi.', 'err'); return; }
  const lama = conf();
  const perangkat = $('#s-perangkat').value.trim() || lama.perangkat || 'TABLET-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  lokal.set('bt_conf', { url, kunci, perangkat });
  pesan(msg, 'Menguji koneksi…');
  try {
    await api('ping', {}, { ulang: 1 });
    await muatMaster();
    pesan(msg, 'Koneksi berhasil.', 'ok');
    tampil('nik');
  } catch (e) { pesan(msg, 'Gagal: ' + e.message, 'err'); }
}));

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
  if (!conf().url) {
    isiSetup();
    $$('main > .view').forEach(v => { v.hidden = v.id !== 'v-setup'; });
    S.view = 'setup';
    return;
  }
  aturNet();
  perbaruiAntrean();
  muatMaster();
  tampil('nik');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* abaikan */ }));
}

mulai();
