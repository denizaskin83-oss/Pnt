# PENIONTALE — Gerçek Multiplayer + Gizli AI Paneli

Bu paket, `Peniontale_Multiplayer.html` istemcisini Node.js + Socket.IO server'a bağlar
ve oyunun içine gizli, AI destekli bir yönetici paneli ekler.

## Kurulum (yerel test)

Node.js 18+ kurulu olmalı.

```bash
npm install
npm start
```

Sonra tarayıcıdan: `http://localhost:3000`

## Render.com'a deploy

1. Bu klasörü bir GitHub reposuna yükle.
2. Render'da "New +" → "Web Service" → repo'yu seç.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. **Environment** sekmesinden şu değişkenleri ekle:
   - `GEMINI_API_KEY` — Google Gemini API anahtarın (aistudio.google.com'dan, ücretsiz, kredi kartı istemez). **Bu olmadan AI panel çalışmaz** — anahtar yoksa panel, yazdığın metni yorumlamadan ham ilan olarak ekler (sistem çökmez ama AI devre dışı kalır).
   - `ADMIN_PASS` (opsiyonel) — gizli panelin şifresi. Boş bırakılırsa varsayılan `peniontale` kullanılır. **Client'taki (`Peniontale_Multiplayer.html` içinde `ADMIN_PASS` sabiti) şifreyle aynı olmalı**, yoksa panel açılır ama sunucu komutu reddeder.
   - `GEMINI_MODEL` (opsiyonel) — varsayılan `gemini-2.5-flash`. Güncel model isimlerini ai.google.dev'den kontrol edebilirsin.

## Gizli panel nasıl çalışır?

- Oyunun başlık ekranındaki büyük başlığa (veya oyun içindeyken mini haritanın etiketine) **5 saniye içinde 5 kez** tıklarsan şifre ekranı açılır.
- Doğru şifre ile panel açılır. Panelin metin kutusuna ne istersen Türkçe yaz, "Gönder"e bas.
- Sunucu bu metni Gemini API'ye gönderir, Gemini onu oyuna uygulanabilecek bir eyleme çevirir:
  - Çoğu komut → haritada kalıcı, tıklanabilir bir **ilan panosu (✦)** olarak eklenir (AI, yazdığın şeyi kısa bir duyuru metnine çevirir).
  - "geceye çevir" gibi açık komutlar → gece/gündüz değişir.
  - "panoyu temizle" gibi açık komutlar → tüm ilanlar silinir.
- Eklenen her şey `world-state.json` dosyasına kalıcı olarak yazılır (sunucu yeniden başlasa bile kaybolmaz) ve o an bağlı olan **herkese anında** yayılır; sonradan giren oyuncular da ilanları oyuna girer girmez görür.
- Panelden çıkman ya da başka biri oyunda olması fark etmez — ilanlar sunucu tarafında sürekli durur, sadece bir admin "panoyu temizle" deyene kadar.

## Güvenlik notu

Şifre client kodunda (görülebilir) tutulur, bu yüzden bu proje **herkese açık, kritik olmayan bir hobi oyunu** için uygundur — üretim/ticari bir site değilse sorun değildir. Sunucu, AI'nin üretebileceği eylemleri kasıtlı olarak küçük ve güvenli bir listeyle sınırlar (ilan ekle / gece-gündüz / panoyu temizle) — yani panel, sunucuda keyfi kod çalıştırma imkânı vermez, sadece bu üç güvenli eylemi uygular.

## Şu an senkronize edilenler

- Her oyuncunun konumu, yönü, adı, bağlanma/ayrılma
- Ortak gece-gündüz durumu
- Menction Star'ların ortak toplanması
- Oyuncu etkileşim bildirimi
- **Yeni:** Gizli panelden AI ile eklenen kalıcı ilan panoları (`world-state.json`)

## Mimari

- `Peniontale_Multiplayer.html`: client (gizli panel dahil)
- `server.js`: ortak dünya, gerçek zamanlı bağlantı, Gemini API entegrasyonu, kalıcılık
- `world-state.json`: sunucu ilk komutta otomatik oluşturur, kalıcı dünya durumunu tutar
- `Socket.IO`: WebSocket tabanlı iletişim; admin komutları `admin:command` event'i + ack callback ile gönderilir

## Sonraki aşama fikirleri

Yeni NPC ekleme, mevcut NPC diyaloglarını AI ile düzenleme, oda sistemi, harita üzerine obje/bina ekleme gibi daha güçlü eylemler; bunlar için `server.js` içindeki `ALLOWED_ACTIONS` listesine ve `applyAction` fonksiyonuna yeni eylem tipleri eklemek yeterli.
