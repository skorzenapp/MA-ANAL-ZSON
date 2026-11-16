# Maç Analiz (tek klasörlü sürüm)

Futbol istatistik ve tahmin uygulaması. Tüm dosyalar tek klasörde, telefondan GitHub'a yüklemek kolay olsun diye.

## Neler var
- Maçlar · Günün tablosu · Liderler · Karşılaştır (oyuncu ve takım) · Karne
- Üstteki arama kutusunda oyuncu ve takım arama, takım sayfası
- Favori takımlar (bu cihazda saklanır) ve "Favorilerim" filtresi
- Günün tablosu: bugünkü tüm maçlar için model olasılığı, piyasa oranı ve aradaki fark
- Takım karşılaştırma: model tahmini, form, maç başı istatistikler
- Canlı maçta skor ve dakikaya göre güncellenen olasılıklar
- Oyuncu olasılıkları (gol, isabetli şut, kart) — deneysel
- Karne: modelin geçmiş isabeti ve lig bazında kendini ayarlama sonucu

## İnternete açmak (telefon veya bilgisayar)
1. GitHub'da yeni bir depo aç, bu klasördeki TÜM dosyaları depoya yükle (klasör yok, hepsi yan yana).
2. render.com → GitHub ile giriş → New + → Blueprint (veya Web Service → Language: Docker → Free) → depoyu seç.
3. Yeşil "Live" yazısı çıkınca verilen adresi aç. Telefonda "Ana ekrana ekle" ile uygulama gibi kur.
Güncelleme için: GitHub'da dosyaların üzerine yeni dosyaları yükle (aynı isimdekiler değişir). Eski `index-....js` ve `extras-....css` dosyalarını depodan sil.

## Bilgisayarda çalıştırmak
Node.js 18+ kur, bu klasörde `npm start` yaz, http://localhost:8080 adresini aç.

## Ayarlar (isteğe bağlı ortam değişkenleri)
PORT (8080), DATA_DIR (./data), FG_CONCURRENCY (8), BG_CONCURRENCY (6), WARM (0 yaparsan arama dizinini açılışta kurmaz).

## Notlar
- Veri: ESPN'in herkese açık futbol verisi. Resmi bir API değildir, bazı alanlar değişirse bazı ekranlar boş kalabilir.
- Tahminler garanti değildir. "Karne" sekmesi modelin geçmişte gerçekte ne kadar tutturduğunu gösterir. Piyasa farkı otomatik olarak "değerli bahis" demek değildir.
- Hakem verisi yok: ESPN hakem bilgisini vermiyor.
- Bazı ligler kapalı: Türkiye 1. Lig, Kore, Polonya, Çekya, Finlandiya (ESPN'de veri yok).
- Oyuncu olasılıkları basit bir orantı yöntemidir, deneyseldir.
- Ücretsiz Render planında uygulama bir süre kullanılmazsa uyur, ilk açılış 30-60 saniye sürebilir. Liderler ve Günün tablosu ilk açılışta birkaç dakika veri toplayabilir.
