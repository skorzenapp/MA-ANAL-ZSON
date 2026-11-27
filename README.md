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
- Lig profilleri: her ligin ev/beraberlik/deplasman oranı, gol ortalaması, 2.5 üst, KG; ligin korner ve kart ortalamaları, öne çıkan takımlar
- Trendler ve seriler: takım sayfasında ve maçın Form & H2H sekmesinde "5 maçtır yenilmiyor", "4 maçtır 2.5 üst" gibi seriler, son 5/10 maç oranları
- Kilit oyuncu eksik uyarısı: maçın Tahmin sekmesinde, takımın en önemli oyuncularından biri sakat veya cezalıysa uyarı
- Paylaş butonu: maçın tahminini metin ve bağlantı olarak paylaşır (paylaşım menüsü yoksa panoya kopyalar)
- Günün tablosunda süzgeçler: 2.5 üst, karşılıklı gol, favori olasılığı, piyasadan fark, sadece başlamamış maçlar
- Hızlı açılış: uygulama telefonda bir kez açıldıktan sonra önbellekten anında açılır, internet yokken bile son görülen maçlar ve takımlar görünür
- Daha fazla pazar (Tahmin sekmesinin altı): Asya ve Avrupa handikapı, ilk yarı / ikinci yarı sonucu ve golleri, İY/MS, ilk gol, gol aralığı, tek/çift, maç farkı, maç sonucu + 2.5 ve KG + 2.5 kombineleri. Hepsi adil oranıyla
- Eksiklere göre ayarlı tahmin: kilit oyuncu eksikse "Ana tahmin / Eksiklerle" karşılaştırması. Etki katsayısı ligin geçmiş maçlarından ölçülür; anlamlı çıkmazsa "doğrulanmadı" etiketiyle gösterilir
- Karne'de korner ve kart karnesi (her maç sadece öncesindeki verilerle tahmin edilip lig ortalamasıyla kıyaslanır) ve eksik oyuncu etkisi analizi. İlk seferde bir ligin son 400 maçının ayrıntısı okunur, birkaç dakika sürebilir
- Şut bazlı güç (xG benzeri): şut ve isabetli şuttan beklenen gol çıkarılır, modele katılması denenir. Seçimde belirgin iyileşme ve dışarıda (son 120 gün) kötüleşmeme koşulu sağlanmazsa KULLANILMAZ. Karne'de ve Model ayarı panelinde sonucu görürsün
- Günün korner ve kart tablosu (Günün tablosunun üstündeki "Korner ve kart" sekmesi): bugünkü tüm maçlar için beklenen korner/kart ve çizgi olasılıkları, lige ve olasılığa göre süzgeç, sıralama. İlk açılışta takımların son maçları okunur, satırlar geldikçe görünür
- İlk yarı payı: gollerin kaçının ilk yarıda atıldığı ligden ölçülür (varsayılan %46 yerine). Karne'de "İlk yarı payı ve pazar karnesi": ilk yarı, İY/MS, maç farkı, gol aralığı, handikap, ilk gol, tek/çift pazarları geçmiş maçlarda kalibrasyon ve "Doğrulandı / farkı anlamlı değil" kararıyla
- Dinlenme ve maç yoğunluğu: son maçından 3,6 günden az dinlenen takımın gol beklentisi değişiyor mu ölçülür (lig, yerel kupa ve Avrupa/kıta kupası maçları dahil). Anlamlıysa (kendi ligi ya da birleşik ölçüm) ayarlı tahmine katılır, değilse sadece bilgi olarak gösterilir
- Takıma özel ev avantajı: her takımın kendi sahasındaki farkı (ligin ortalamasına doğru çekilerek) ölçülür. Seçimde iyileşme ve dışarıda (son 120 gün) kötüleşmeme şartı aranır; sağlanmazsa herkese aynı ev avantajı kullanılır. Model ayarı panelinde sonucu görürsün
- Kupa ve eleme: iki maçlı turlarda ve tek maçlık eleme maçlarında "tur atlama olasılığı" (Tahmin sekmesi): toplam skor + uzatma + penaltı. Penaltı 50-50, deplasman golü kuralı yok sayılır, uzatmada gol hızı yeterli uzatmalı maç varsa ölçülür, yoksa varsayım (doğrulanmadı etiketiyle)
- Motivasyon: sezon sonunda puan durumunda yeri matematiksel olarak belli olan ("işi bitmiş": şampiyonluk, Avrupa sınırları ve küme düşme çizgisinin hiçbirinde yeri değişemez) takımın gol beklentisi değişiyor mu ölçülür (lig + birleşik ölçüm). Anlamlıysa ayarlı tahmine katılır, değilse sadece bilgi
- Hava durumu: Open-Meteo'dan (ücretsiz, anahtarsız) maç saatindeki sıcaklık, yağmur ve rüzgâr alınır; her durumun gol beklentisine etkisi ölçülür (z ≥ 2,5 + genel test). Sadece anlamlı olanlar ayarlı tahmine katılır. Hava verisine ulaşılamazsa uygulama normal çalışır, Karne'de neden yapılamadığı yazar
- Model ve piyasa (v1.6): maç sayfasında modelin ve bahis oranlarının olasılığı yan yana. Karışım (model + piyasa) yürüyen testte modelden anlamlı iyi çıkarsa "Karışık" sütunu da gösterilir (ağırlık ilk %60'ta seçilir, son %40'ta sınanır, z ≥ 1,64)
- Sanal kâr/zarar testi (v1.6, Karne): model piyasadan 3, 5, 8, 12 puan farklı düşündüğü maçlara oynansaydı geçmişte kâr eder miydi? Bahis şirketi marjı hesaba katılır; "kanıtlı kâr" için en az 40 bahis ve z ≥ 2,2 aranır. Çoğu ligde "kanıt yok" ya da "kanıtlı zarar" çıkması beklenir, bu normal
- Kırmızı kartın canlı etkisi (v1.6): 10 kişi kalan takımın ve rakibinin kalan dakikalardaki gol beklentisi ölçülür (kırmızı kart dakikalarına göre parçalanmış Poisson regresyon, lig + ligler arası birleşik ölçüm, z ≥ 2,2). Anlamlıysa canlı olasılıklara uygulanır ve "kırmızısız olsaydı" değeri gösterilir; değilse kutu sadece uyarır
- Hakem etkisi (v1.6): hakemin maçlarındaki sarı kart sayısı kart modelinin beklentisinden sapıyor mu, yürüyen testle ölçülür. ESPN çoğu ligde hakem adını VERMEDİĞİ için şu an çoğu ligde "ölçülemedi" yazar; veri gelirse kendiliğinden çalışır
- İlk 11 ile otomatik ayar (v1.6): kadro açıklanınca kilit oyuncu eksiği sakatlık listesine göre değil gerçek ilk 11'e göre hesaplanır (18'de yoksa tam, yedekteyse yarım eksik); sakat listesindeki oyuncu ilk 11'de başlıyorsa uyarı kalkar. Maça 4 saatten az kala sayfa 2 dakikada bir kendini yeniler
- Ölçüm özeti (v1.6, adres: /olcum ya da ana sayfadaki "Ölçüm özeti" bağlantısı): her etki için kaç ligde doğrulandı, kaç ligde anlamlı çıkmadı, kaç ligde ölçülemedi; ligler arası birleşik ölçümler ve lig × etki tablosu. Hesaplanmamış ligleri 3'er 3'er hesaplatan düğme var
- Tahmin defteri (v1.7, adres: /defter ya da ana sayfadaki "Tahmin defteri" bağlantısı): maç sayfasındaki "📒 Deftere ekle" düğmesi ve Günün tablosundaki toplu ekleme tahmini BU TELEFONDA saklar (otomatik kayıt açıktır: açtığın maçlar ve Günün tablosundaki başlamamış maçlar maç başlayana kadar güncellenerek kaydedilir; kapatabilirsin). Maç bitince sonuç sunucudan çekilir ve gerçek isabet, Brier skoru, model–piyasa karşılaştırması (eşli z testi, en az 30 maç), 2.5 üst / KG isabeti ve kalibrasyon tablosu gösterilir. 100 biten maçtan azında "örnek az" uyarısı çıkar. Kayıtlar başka telefona geçmez: yedeği kopyala / geri yükle düğmeleri var. Uzatmaya giden ve ertelenen maçlar sayılmaz
- İkinci veri kaynağı (v1.8): football-data.co.uk'un ücretsiz CSV dosyaları. Anahtar, kayıt ya da ayar GEREKMEZ; sunucu kendisi çeker (lig başına en çok 2 dosya, 3 saatte bir; yaklaşan maçlar için fixtures.csv 90 dakikada bir) ve önbelleğe alır. Ne sağlar: (1) bahis şirketlerinin ortalama oranı (geçmiş maçlarda KAPANIŞ ortalaması, yaklaşan maçlarda güncel ortalama) → ESPN'in oran vermediği liglerde model–piyasa karışımı ve sanal kâr/zarar ölçülebilir olur, oran verdiği liglerde bu kaynak kullanılır ve kaynak adı yazar; (2) hakem adı → ESPN'in hakem vermediği ligde hakem etkisi ölçülebilir, yaklaşan maçlarda hakem görünür. Maçlar tarih + skor ile eşleşir, takım adları skor eşleşmelerinden öğrenilir. Kapsam: İngiltere (1-5. lig), İskoçya, Almanya, İtalya, İspanya, Fransa, Hollanda, Belçika, Portekiz, Türkiye, Yunanistan (hakem + oran), ek liglerden Arjantin, Avusturya, Brezilya, Çin, Danimarka, Japonya, Meksika, Norveç, Rusya, İsveç, ABD (yalnızca oran). ÖNEMLİ: site verisini yalnızca kişisel kullanım için sunar; uygulamayı herkese açık ya da ticari yapma. Kapatmak için ortam değişkeni FD=0. Durumu Ölçüm özeti sayfasındaki "İkinci kaynak" kutusunda ve /api/health içinde görürsün. Analizler 12 saat önbellekli olduğu için yeni veri, ligin analizi yeniden hesaplanınca görünür.
- Kaydırma hatası (v1.8): sayfayı aşağı kaydırırken yeniden yükleme sırasında bir ağ hatası olursa sayfa yukarı atıyordu; artık eldeki veri ekranda kalıyor.
- Uzak deplasman ve derbi (v1.7): takımın ev şehri ile maçın şehri arasındaki kuş uçuşu mesafe (≥ 600 km "uzak") ve aynı şehir derbisi, deplasman takımının golü, ev sahibinin golü ve derbide iki takımın golü için ayrı ayrı ölçülür (hava ölçümüyle aynı yöntem: Poisson regresyon, z ≥ 2,5, lig + ligler arası birleşik ölçüm, etkinin %70'i uygulanır). Anlamlı çıkmazsa maç sayfasındaki kutu sadece bilgi verir. Takım şehirlerinin koordinatı Open-Meteo'dan gelir; model takım güçlerini zaten maç sonuçlarından öğrendiği için bu etkinin ayrıca görünmesi çoğu ligde beklenmez. Karne sayfasında ve Ölçüm özetinde (Mesafe sütunu) görünür
- 90'dan fazla turnuva: İngiltere 3-4-5. lig, İskoçya 2. lig, Rusya, Meksika 2, ABD USL, Arjantin 2-3, Brezilya 2, Uruguay, Peru, Paraguay, Ekvador, Venezuela, Bolivya, Honduras, Kosta Rika, Guatemala, El Salvador, Hindistan 1-2, Güney Afrika ve ulusal kupalar (FA Cup, Copa del Rey, Coppa Italia, Fransa ve Almanya kupaları vb.)

## İnternete açmak (telefon veya bilgisayar)
1. GitHub'da yeni bir depo aç, bu klasördeki TÜM dosyaları depoya yükle (klasör yok, hepsi yan yana).
2. render.com → GitHub ile giriş → New + → Blueprint (veya Web Service → Language: Docker → Free) → depoyu seç.
3. Yeşil "Live" yazısı çıkınca verilen adresi aç. Telefonda "Ana ekrana ekle" ile uygulama gibi kur.
Güncelleme için: GitHub'da dosyaların üzerine yeni dosyaları yükle (aynı isimdekiler değişir). Eski `index-....js` ve `extras-....css` dosyalarını depodan sil (silmesen de çalışır, sadece yer kaplar). Yeni gelen dosyaları da yüklemeyi unutma: `fdata.js` (v1.8, yeni), `travel.js` (v1.7), `betting.js`, `referee.js`, `redcard.js` (v1.6'dan; v1.5'ten gelen `glm.js`, `tie.js`, `stakes.js`, `weather.js` de yüklü olmalı), ayrıca `espn.js`, `store.js`, `model.js`, `spmodel.js`, `absence.js`, `index.js`, `index.html`, `sw.js` ve yeni `index-....js` / `extras-....css`.

## Bilgisayarda çalıştırmak
Node.js 18+ kur, bu klasörde `npm start` yaz, http://localhost:8080 adresini aç.

## Ayarlar (isteğe bağlı ortam değişkenleri)
PORT (8080), DATA_DIR (./data), FG_CONCURRENCY (8), BG_CONCURRENCY (6), WARM (0 yaparsan arama dizinini açılışta kurmaz). Hava için WX_GEO, WX_ARCHIVE, WX_FORECAST (Open-Meteo adresleri; normalde dokunma).

## Notlar
- Veri: ESPN'in herkese açık futbol verisi. Resmi bir API değildir, bazı alanlar değişirse bazı ekranlar boş kalabilir.
- Tahminler garanti değildir. "Karne" sekmesi modelin geçmişte gerçekte ne kadar tutturduğunu gösterir. Piyasa farkı otomatik olarak "değerli bahis" demek değildir.
- Hakem verisi: ESPN maç özetlerinde çoğu ligde hakem adı yok (Premier Lig, Süper Lig, Şampiyonlar Ligi, MLS örneklerinde yoktu). Hakem etkisi bu yüzden çoğu ligde ölçülemez.
- Bazı ligler kapalı: Türkiye 1. Lig, Kore, İsviçre, Polonya, Çekya, Finlandiya (ESPN'de veri yok ya da boş).
- Alt ligler ve küçük ülke ligleri: ESPN bazılarında sadece skor verir. Korner, kart ve oyuncu ayrıntısı olmayabilir, o zaman ilgili bölüm boş görünür ya da gizlenir.
- Önbellek sorun çıkarırsa adresin sonuna `?nosw=1` ekleyip aç: çevrimdışı önbellek temizlenir.
- Oyuncu olasılıkları basit bir orantı yöntemidir, deneyseldir.
- Ücretsiz Render planında uygulama bir süre kullanılmazsa uyur, ilk açılış 30-60 saniye sürebilir. Liderler ve Günün tablosu ilk açılışta birkaç dakika veri toplayabilir.
