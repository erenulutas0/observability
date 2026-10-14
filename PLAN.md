# Express gözlemlenebilirlik middleware'i (express-observe) — plan

Kişisel, açık kaynak proje. Genel amaçlı; herhangi bir şirket koduna, verisine veya anahtarına dayanmaz.

Bu dosya yol haritasıdır. Tasarım ayrıntıları `ARCHITECTURE.md`'de, iş listesi `TODO.md`'de, kararların gerekçesi `docs/decisions/`'da tutulur. Aynı bilgiyi iki yerde yazmayız.

## Ne yapacak? (v0.1 kapsamı)

Express 4 uygulamasına tek satırla eklenen bir middleware. Her istekte:

1. **İstek kimliği:** `crypto.randomUUID()` ile üretir, `req.id` olarak handler'lara verir, `X-Request-Id` yanıt başlığına yazar. Gelen `X-Request-Id` yalnızca `trustIncoming` açıksa ve doğrulamadan geçerse (uzunluk 1–128, `[A-Za-z0-9._-]`) kabul edilir; geçersizse sessizce yenisi üretilir, istek asla reddedilmez. Kabul edilen istemci kimliği güvenilir ya da benzersiz sayılmaz; kayıtta `requestIdSource` ile kaynağı belirtilir. Önceden ayarlanmış `req.id` ezilmez.
2. **Server-Timing:** Başlıklar gönderilmeden hemen önce (`on-headers` kancasıyla) `Server-Timing: app;dur=12.3` yazılır. `app` = middleware girişinden başlıkların gönderilmesine kadar geçen süre; toplam istek süresi değil. İsteğe bağlı ek ölçümler: `res.serverTiming.start('db')` / `.end('db')`. Bitmemiş ölçümler başlığa girmez, başlık gönderildikten sonra yapılan çağrılar sessizce yok sayılır, giriş sayısı sınırlıdır.
3. **Tek satır JSON kayıt:** İstek sonlandığında bir kez: `schemaVersion, timestamp, requestId, requestIdSource, service, release, method, route, status, headerDurationMs, durationMs, termination`. `route` gerçek URL değil şablondur (`/users/:id`); güvenle belirlenemiyorsa `null`. `status`, başlıklar hiç gönderilmediyse `null` (Node'un varsayılan 200'ü başarı sayılmaz). `headerDurationMs` (girişten başlık yazımına) ile `durationMs` (girişten sonlanmaya) ayrı tutulur; "geç başlık" ile "yavaş gövde" böyle ayrışır (ADR-0002).
4. **Sonlanma:** `termination: "finished"` (yanıt tamamen yazıldı) veya `"interrupted"` (`finish` gelmeden `close` geldi). Her `close` iptal değildir; sınıflandırma `res.writableFinished` ile yapılır. `next(err)` ile gelen hatalar Express'in kendi akışına bırakılır; middleware uygulama hatasını yutmaz, kendi hatasını da isteğe yansıtmaz.
5. **Sink:** Varsayılan `stdout`'a JSON satırı. `sink: (record) => logger.info(record)` ile mevcut altyapıya bağlanır; sink'e nesne verilir, serileştirme sink'in işidir. Sink hataları (senkron throw / promise reject) yakalanır, hız sınırlı uyarıyla stderr'e yazılır, isteği etkilemez. Tampon, yeniden deneme ve teslim garantisi yoktur.

### Varsayılan olarak ASLA loglanmayanlar
İstek/yanıt gövdesi, ham URL ve query string, başlıklar ve yetki token'ları, çerezler, IP adresi, kullanıcı kimlikleri, hata mesajı ve stack trace. Ek alan eklemek açıkça opt-in (`log.extend`) ve uygulamanın sorumluluğundadır.

### v0.1'de OLMAYACAKLAR
OpenTelemetry SDK, dağıtık iz yayılımı, Prometheus/metrik sunucusu, dashboard, otomatik DB/Redis ölçümü, profiling, kök neden analizi, mobil SDK, bulut dağıtımı. Sonraki sürüm fikirleri `TODO.md` → "Later" bölümünde.

## Klasör yapısı
```
ev-projesi-observability/
├─ packages/
│  └─ express-observe/          # yayınlanacak paket
│     ├─ src/
│     │  ├─ index.js            # observe(options) → middleware
│     │  ├─ request-id.js       # üretme + doğrulama + trust politikası
│     │  ├─ server-timing.js    # ölçüm kaydı, sınırlar, başlık biçimi
│     │  ├─ logger.js           # kayıt nesnesi, varsayılan stdout sink, sink hata izolasyonu
│     │  └─ route-template.js   # req.route / mounts / açık etiketten güvenli şablon
│     ├─ test/
│     ├─ package.json
│     └─ README.md
├─ demo/
│  └─ app.js                    # diagnostic-lab: aynı belirtiyi farklı mekanizmalarla üreten senaryolar (L0–L8); dış servis yok
├─ bench/
│  └─ results/                  # tarihli ham ölçüm çıktıları
├─ docs/
│  └─ decisions/                # ADR'ler (0001-...)
├─ AGENTS.md                    # geliştirme kuralları
├─ ARCHITECTURE.md              # uygulanan mimari ([implemented] / [proposed] / [idea])
├─ TODO.md                      # iş listesi + geçmiş
└─ PLAN.md                      # bu dosya
```

Kök `package.json` npm workspaces kullanır (`packages/*`).

## Fazlar
| Faz | İş | Bitti sayılması için |
|---|---|---|
| 1 | Mimari, riskler, bağımlılık kararı, kabul kriterleri | `docs/decisions/0001` onaylandı |
| 2 | `request-id` + `server-timing` + `index` (log yok) + testler | ID testleri (geçersiz/uzun/injection/1000 eşzamanlı) ve başlık testleri (streaming, erken flush, bitmemiş ölçüm, sınır) yeşil |
| 3 | JSON kayıt + route şablonu + sonlanma + sink + testler | 200 / `next(err)` / eşleşmeyen 404 (`route: null`) / eşleşen handler'dan 404 (etiket korunur) / gerçek soketle iptal: her biri tam olarak bir kayıt; gizlilik taraması yeşil; sink hatası isteği etkilemiyor |
| 4 | Demo (`diagnostic-lab`) + README | `node demo/app.js` dış servis olmadan çalışır; L0 normal, L1 başlık öncesi bekleme, L2 hızlı başlık/yavaş gövde, L7 erken socket kapanışı, L8 bozuk sink senaryoları doğru kayıt üretir; README kurulum, seçenekler, şema, ölçüm sözlüğü, gizlilik, sınırlar |
| 5 | Ek yük ölçümü | autocannon ile 4 varyant (middleware'siz / ID+timing / tam log / pino-http), en az 3 tekrar, her koşu için `bench/results/MANIFEST_TEMPLATE.md` doldurulmuş; "sıfır maliyet" iddiası yok |

## Ölçüm sözlüğü (kısa)
`headerDurationMs` ve `durationMs` sunucu gerçeğidir; `termination` HTTP sonucudur, kullanıcı niyeti değildir. `clientAttemptMs` ve `operationMs` istemci tarafı isimlerdir, middleware bunları üretmez. İstemci − sunucu farkı "ağ süresi" diye adlandırılmaz. Veri yetmiyorsa cevap "bilinmiyor"dur. Ayrıntı: `ARCHITECTURE.md` §9.

## Test yaklaşımı
- **Birim + entegrasyon:** Jest 30 + Supertest 7. Dışarıdan gözlenen davranış (başlık, status, üretilen kayıt) test edilir; iç detay değil.
- **Kenar durumlar:** 10 KB URL, unicode/CRLF içeren ID, 1.000 eşzamanlı istekte ID benzersizliği, yanıt gönderildikten sonra fırlatılan hata, streaming sırasında `serverTiming.end`, gerçek `net` soketiyle başlık öncesi ve gövde ortasında kopma.
- **Gizlilik:** Body'de şifre, header'da token, query'de e-posta, bilinen IP içeren isteklerde serileştirilmiş kayıtta bu değerlerin hiçbiri yok (sentinel değerlerle).
- **Arıza:** Sink throw/reject ederken yanıt ve sonraki kayıtlar normal.
- Başarısız testi zayıflatarak/silerek yeşile çevirmek yasak; sözleşme değişecekse önce ADR.

## Tasarım ilkeleri
- **Minimum bağımlılık, HTTP doğruluğundan ödün yok:** Çalışma zamanında yalnızca `on-headers` (jshttp). `on-finished` ölçüm sonrası kaldırıldı. Gerekçe: ADR-0001 ve ADR-0007.
- **İsteği asla bozmasın:** Middleware'in kendi hataları yutulur ve isteğe yansımaz; uygulamanın hataları ise aynen Express'e bırakılır.
- **Varsayılan gizli:** Kişisel veri loglamak açıkça opt-in.
- **Mevcut log altyapısına uysun:** Varsayılan stdout; `sink` ile pino/winston vb.

## Sonraki adımlar (v0.1 sonrası, sırayla)
1. `diagnostic-lab` ikinci dalga: L3 sınırlı CPU işi, L4 önceden üretilmiş büyük sentetik JSON, L5 hızlı API + yavaş istemci işi, L6 aynı mantıksal işlemde birden çok fiziksel deneme. Küçük bir Node istemci betiği ile `clientAttemptMs` / `operationMs` ölçülür; kabul koşulu: sunucu verisinden istemci kök nedeni "kesinleştirilmez".
2. `express-observe analyze`: JSON log dosyasından route bazında istek sayısı, hata oranı, p50/p95/p99 (`headerDurationMs` ve `durationMs` ayrı) çıkaran CLI. Girdi yalnız log dosyasıdır; senaryo etiketi gizli ipucu olarak verilmez. **Uygulandı (2026-10-14, ADR-0004).**
3. `express-observe doctor`: middleware sırası, header varlığı, çift kayıt gibi entegrasyon kontrolleri (sunucuya müdahale sınırları ayrıca tasarlanacak). **Uygulandı (2026-10-14, ADR-0005): dışarıdan HTTP ile, yalnız loopback, yalnız GET, sınırlı istek ve süre.**
4. React Native korelasyon demosu: istemcide `X-Request-Id` + `Server-Timing` okuyup "hissedilen gecikme" ile backend süresini ayıran örnek; `trustIncoming: true` burada açıkça açılır. Yalnızca gerçek RN istemci zamanı ayrılırsa; web demosu mobil kanıt sayılmaz. **Uygulandı (2026-10-14, ADR-0006): korelasyon mantığı Node'da test edildi, Expo uygulaması Android emülatöründe çalıştırıldı; fiziksel telefon ve iOS henüz denenmedi.**
5. Express 5 uyumluluğu (**uygulandı 2026-10-14, ADR-0008**: tüm test seti Express 4 ve 5'e karşı çalışıyor); isteğe bağlı OpenTelemetry trace-id korelasyonu.

## Not
Bu proje iyi çalışır ve ölçümleri sağlam olursa iş yerinde kullanılması ayrıca, normal PR ve onay süreciyle konuşulur.
