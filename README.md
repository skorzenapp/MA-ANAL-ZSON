# Maç Analiz (tek klasörlü sürüm)

Futbol istatistik ve tahmin uygulaması. Tüm dosyalar tek klasörde, telefondan GitHub'a yüklemek kolay olsun diye.

## İnternete açmak (telefon veya bilgisayar)
1. GitHub'da yeni bir depo aç, bu klasördeki TÜM dosyaları depoya yükle (klasör yok, hepsi yan yana).
2. render.com → GitHub ile giriş → New + → Blueprint (veya Web Service → Language: Docker → Free) → depoyu seç.
3. Yeşil "Live" yazısı çıkınca verilen adresi aç. Telefonda "Ana ekrana ekle" ile uygulama gibi kur.

## Bilgisayarda çalıştırmak
Node.js 18+ kur, bu klasörde `npm start` yaz, http://localhost:8080 adresini aç.

## Ayarlar (isteğe bağlı ortam değişkenleri)
PORT (8080), DATA_DIR (./data), FG_CONCURRENCY (8), BG_CONCURRENCY (6), WARM (0 yaparsan arama dizinini açılışta kurmaz).

## Notlar
- Veri: ESPN'in herkese açık futbol verisi. Resmi bir API değildir, bazı alanlar değişirse bazı ekranlar boş kalabilir.
- Tahminler garanti değildir. "Karne" sekmesi modelin geçmişte gerçekte ne kadar tutturduğunu gösterir.
- Bazı ligler kapalı: Türkiye 1. Lig, Kore, Polonya, Çekya, Finlandiya (ESPN'de veri yok).
- Ücretsiz Render planında uygulama bir süre kullanılmazsa uyur, ilk açılış 30-60 saniye sürebilir. Liderler sekmesi bir ligi ilk açışta birkaç dakika veri toplar.
