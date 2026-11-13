# Box Girder Studio

Aplikasi HTML mandiri untuk pemodelan penampang box girder dan pemeriksaan
hasil perhitungan. Dikembangkan kembali dari file unggahan
`GIRDER_NX_PSC_DESIGN_PANDUAN_BOX_GIRDER.html` dengan nama **Box Girder Studio**.

## Menjalankan aplikasi

Unduh `index.html`, lalu buka file tersebut dengan Chrome, Chromium, atau Edge
versi terbaru. Aplikasi dapat berjalan offline; tidak memerlukan akun, API key,
server backend, atau instalasi npm. Dependensi, ilustrasi, dan decoder DWG
sudah tertanam dalam HTML.

Untuk pengembangan melalui server lokal:

```sh
cd /workspace/BOX-GIRDER
python3 -m http.server 8000 --bind 127.0.0.1
```

Buka port 8000 pada browser lokal. Hentikan server dengan `Ctrl+C`.

## Fitur

- Editor koordinat penampang luar/rongga, tendon, dan tulangan; paste dari Excel.
- Impor DWG, properti penampang, material, prategang, dan PSC Design.
- Analisis lentur pada dua sumbu, input gaya dalam, serta pemeriksaan geser/torsi.
- Sampai 22 tab kerja dan penyimpanan otomatis pada browser.
- Simpan/buka proyek JSON, ekspor CSV, hitungan manual Excel, dan laporan cetak.

Model bawaan `EL-POT-27-EL45` mempertahankan 62 tendon dan 286 posisi tulangan
dari file sumber. Mesin perhitungan dan data model dipertahankan pada regenerasi
ini. Nama aplikasi diperbarui pada judul, antarmuka, laporan, serta metadata
ekspor JSON dan Excel. Format JSON versi 1 dan kunci penyimpanan lama tetap
kompatibel.

Data otomatis tersimpan pada browser dan origin yang sedang digunakan.
Memindahkan HTML, berganti browser, atau berganti alamat server dapat memakai
penyimpanan yang berbeda. Gunakan **Simpan** untuk mencadangkan proyek JSON dan
**Buka** untuk memulihkannya.

## Pengujian pengembangan

Node.js 20 atau lebih baru dan npm hanya diperlukan untuk pengujian browser, bukan untuk membuka
aplikasi:

```sh
npm ci
npx playwright install chromium
npm test
```

Jika Chromium sistem sudah tersedia, pengunduhan browser tidak diperlukan:

```sh
CHROMIUM_PATH=/usr/bin/chromium npm test
```

Tes browser memeriksa perilaku aplikasi dan regresi hasil model bawaan.
Empat skenario meliputi pembukaan/analisis, navigasi dan bahasa, impor-ekspor
JSON/CSV/Excel, serta penyimpanan koordinat dan pemulihan tab. Impor file DWG
belum diuji dengan berkas nyata karena tidak ada sampel DWG dalam unggahan.
Peringatan serta batas pemeriksaan desain pada aplikasi tetap berlaku;
kelulusan tes perangkat lunak bukan verifikasi kesesuaian desain struktur.

## Dependensi tertanam

HTML mempertahankan pemberitahuan lisensi SheetJS Community Edition
(Apache-2.0) dan `@mlightcad/libredwg-web` 0.8.4 / GNU LibreDWG (GPL-3.0)
dari file sumber. Rujukan sumber dan informasi paket tersedia di dalam HTML.
