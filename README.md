# Odak

Ekran kaydı, otomatik zoom ve zoom'ları elle düzenleme. **macOS ve Windows'ta aynı şekilde çalışır.**

- Kayıtta sistem imleci gizlenir. İmleç konumu ve tıklamalar ayrıca saklanır; imleç sonradan yeniden çizilir, yumuşatılır ve boyutlandırılır.
- Zoom'lar tıklamalardan otomatik oluşur. Her zoom'un zamanı, miktarı ve odağı (imleci takip / sabit nokta) düzenlenebilir.
- Önizleme ile dışa aktarılan MP4 aynı çizim koduyla üretilir. Görüntü, zamanlama ve ses senkronu aynıdır.
- Sistem sesi ve mikrofon ayrı dosyalara kaydedilir.
- Projeler `.odak` klasörlerinde saklanır: ham medya, imleç verisi ve düzenlemeler. Uygulamayı kapatıp açınca kaldığın yerden devam edersin.

> Kardeş uygulama **Kadraj** yalnızca macOS içindir ve tamamen Swift ile yazılmıştır. İki uygulama aynı proje formatını ve aynı zoom/kamera algoritmasını kullanır. Odak, Kadraj projelerini de açabilir.

## İndir

[Releases](../../releases) sayfasından ya da Actions çıktılarından:

| Sistem | Dosya | Not |
|---|---|---|
| macOS 14+ (Apple Silicon) | `Odak-x.y.z-arm64.dmg` | Uygulama imzalı/notarize değil. İlk açılışta Sistem Ayarları › Gizlilik ve Güvenlik › **Yine de Aç**. |
| Windows 10 (2004+) / 11 | `Odak-Kurulum-x.y.z.exe` | İmzalı değil. SmartScreen uyarısında **Ek bilgi › Yine de çalıştır**. |

macOS'ta ilk kayıtta **Ekran ve Sistem Sesi Kaydı** izni istenir. Mikrofon kullanılacaksa mikrofon izni de istenir. İzinden sonra uygulamayı yeniden başlatmak gerekebilir.

## Kaynaktan çalıştırma

Gerekenler:
- Her iki sistem: **Node.js 22**.
- **macOS:** Xcode ya da Command Line Tools (`xcode-select --install`).
- **Windows:** [Rust](https://rustup.rs) ve Visual Studio Build Tools ("C++ ile masaüstü geliştirme").

```bash
npm install
npm run build:helper:mac      # macOS: Swift kayıt yardımcısı
npm run build:helper:win      # Windows: Rust kayıt yardımcısı
npm run dev                   # geliştirme modu
npm run dist:mac              # macOS: .dmg / .zip  → release/
npm run dist:win              # Windows: kurulum .exe / .zip → release/
```

Geliştirme modunda (`npm run dev`) macOS izinleri "Electron" uygulamasına verilir; paketlenmiş uygulamada "Odak"a.

## Kullanım

1. **Kaydı Başlat**. Ekranı ve isteğe bağlı olarak sistem sesi/mikrofonu seç.
2. Durdurmak için üstteki paneli ya da **⌘⇧2 / Ctrl+Shift+2**'yi kullan. Kayıt otomatik zoom'larla düzenleyicide açılır.
3. Zaman çizelgesinde bir zoom'u **sürükle** (taşı) ya da **kenarından** uzat. Tıklayınca sağ panelden miktarını ve odağını değiştirebilirsin.
4. **Zoom Ekle** oynatma çizgisine yeni bir zoom ekler. **Otomatik Zoom** dokunulmamış zoom'ları yeniden üretir; elle düzenlediklerin korunur.
5. **Dışa Aktar**: 1080p / 1440p / 4K, 30/60 fps, H.264 ya da HEVC.

Kısayollar: boşluk (oynat/duraklat), ←/→ (kare kare), Sil (seçili zoom), ⌘/Ctrl+Z ve ⇧⌘/Ctrl+Shift+Z (geri al/yinele), ⌘/Ctrl+E (dışa aktar).

## Mimari

```
┌──────────────── Electron (macOS ve Windows'ta aynı kod) ──────────────────┐
│  UI: React + TypeScript                                                   │
│  core/   proje modeli · otomatik zoom · imleç grupları · yaylı kamera     │
│  render/ tek çizici (Canvas 2D) ──┬── önizleme oynatıcısı (Web Audio saati)│
│                                   └── MP4 dışa aktarma (mediabunny/WebCodecs)│
│  electron/main  dosyalar · proje paketi · menüler · kayıt yönetimi        │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ stdin/stdout JSON satırları (aynı protokol)
     ┌──────────┴──────────┐                ┌─────────────────────────────┐
     │ macOS: Swift         │                │ Windows: Rust                │
     │ ScreenCaptureKit     │                │ Windows Graphics Capture     │
     │ imleç gizli, H.264   │                │ imleç gizli, H.264 (MF)      │
     │ host saati           │                │ QPC saati                    │
     │ sistem sesi + mik.   │                │ WASAPI loopback + mikrofon   │
     └──────────────────────┘                └─────────────────────────────┘
```

- **Neden yerel kayıt yardımcıları?** Electron/Chromium'un ekran yakalayıcısında sistem imlecini gizlemenin güvenilir bir yolu yok. İmleç gizlenmezse imleci yeniden çizmek, yumuşatmak ve boyutlandırmak mümkün olmaz.
- **Senkron:** Her platformda video kareleri, imleç örnekleri ve ses paketleri aynı saatle (macOS'ta host time, Windows'ta QPC) zaman damgalanır. Ses, ilk video karesine hizalanmış 16 bit WAV olarak yazılır. Boşluklara sessizlik eklenir, çakışan kısımlar atılır.
- **Önizleme = dışa aktarma:** İkisi de aynı `drawFrame` fonksiyonunu ve aynı kare seçme kuralını kullanır. Kural şu: kaynakta o andan önce ya da o anda başlayan son kare. Dışa aktarmada AAC kodlayıcının eklediği "priming" gecikmesi ölçülüp telafi edilir.

Proje paketi (`~/Movies/Odak` ya da `~/Videos/Odak`):

```
Kayıt 2026-10-15 10.12.30.odak/
  project.json                 düzenlemeler (klipler, zoom'lar, görünüm, dışa aktarma ayarları)
  media/<id>/screen.mp4        ham ekran videosu (imleçsiz)
  media/<id>/cursor.json       imleç örnekleri ve tıklamalar
  media/<id>/system.wav        sistem sesi (ayrı iz)
  media/<id>/mic.wav           mikrofon (ayrı iz)
```

## Testler

```bash
npm test               # çekirdek: zoom/kamera Kadraj (Swift) ile aynı sonuçları veriyor mu, düzenleme işlemleri
npm run selftest       # uygulama içinde: sentetik kayıt → zoom → kaydet/aç → MP4 → önizleme=dışa aktarma, ses senkronu
npm run uitest -- "examples/Örnek Proje.odak"   # gerçek arayüz: zoom ekle/sürükle/düzenle, geri al, oynat, otomatik kayıt
node scripts/helper-smoke.mjs                  # kayıt yardımcısıyla 3 sn gerçek kayıt (izin gerekir)
cargo test --manifest-path native/win/Cargo.toml   # Windows yardımcısının WAV hizalaması
```

`.github/workflows/build.yml`, bunların hepsini **Windows ve macOS** makinelerinde çalıştırır ve kurulum dosyalarını üretir.

## Bilinen sınırlar

- Uygulamalar Apple/Microsoft sertifikasıyla imzalı değil. İlk açılışta yukarıdaki uyarılar çıkar.
- Mikrofon kaydı macOS'ta 15 ve sonrasında çalışır; macOS 14'te yalnızca sistem sesi kaydedilir.
- 4096×2304'ten büyük ekranlar: macOS'ta kayıt bu boyuta sığdırılır. Windows'ta HEVC kullanılır ve bu kayıtlar ancak HEVC çözebilen bilgisayarlarda düzenlenebilir.
- Linux'ta düzenleme ve dışa aktarma çalışır, kayıt henüz desteklenmiyor.
- Çoklu klip, video içe aktarma ve ses düzeyi arayüzü sonraki aşamada. Veri modeli ve dışa aktarma bunları zaten destekliyor.
