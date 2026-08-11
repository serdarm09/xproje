# 🚨 Crypto Alarm Monitörü

Üç kaynağı aynı anda izleyen, sesli + popup bildirim veren Node.js scripti.

## İzlenen Kaynaklar

| Kaynak | Ne İzleniyor | Yöntem |
|--------|-------------|--------|
| `anvil.clutch.market` | YARD projesi çıktığında | Playwright (15s) |
| `stonkbrokers.io/launcher` | Yeni proje eklenmesi | Playwright (15s) |
| `@clockincoin` (X/Twitter) | CA adresi içeren tweet | Nitter scraping (15s) |

## Başlatmak

```bash
cd /Users/serdar/Desktop/xproje
node monitor.js
```

## Alarm Tetikleyiciler

- `YARD` kelimesi Anvil market kartında görünürse → 🟢 Alarm
- StonkBrokers'ta bilmediğimiz yeni proje eklenirse → 🚀 Alarm  
- `@clockincoin` `0x...` CA adresi veya "live/launched" içeren tweet atarsa → ⚡ Alarm

## Ayarlar (`config.json`)

```json
{
  "clockincoin_username": "clockincoin",
  "web_poll_interval_seconds": 15,
  "yard_keywords": ["YARD"],
  "stonk_known_projects": ["DERP", "MANCER"],
  "alert_sound": true,
  "alert_popup": true,
  "alert_open_browser": true
}
```

## Log

Tüm alarmlar `alerts.log` dosyasına da yazılır.

## Twitter Bearer Token Notu

Token `client-not-enrolled` hatası veriyorsa:
1. [developer.twitter.com](https://developer.twitter.com) → Projects & Apps
2. Mevcut App'i bir Project'e bağla (ücretsiz)
3. Token'ı yenile

Token olmadan da sistem Nitter üzerinden çalışır.
