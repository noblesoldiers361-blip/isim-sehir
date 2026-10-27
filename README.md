# İsim Şehir

Odalı, çok oyunculu İsim-Şehir-Hayvan. Bağımlılık yok, sadece Node 18+.

Çalıştır: `BASLAT.bat` (veya `node server.js`) → http://localhost:3000
Telefondan: aynı Wi-Fi'de `http://<PC-IP>:3000`.
Deploy: render.yaml hazır (Render, Node web service).

Puan: aynı cevap 5, tek cevap 10, boş/yanlış 0.
Sözlükte olmayan cevaplar oyuncu oyuyla kabul/ret edilir; kabul edilenler data/learned.json'a öğrenilir.
Test: `npm test`
