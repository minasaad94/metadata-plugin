# Arabic Unified Addon Bridge (v5.0.0)

إضافة مباشرة خفيفة وسريعة لتطبيق **Nuvio** مخصصة حصرياً لربط إضافات **Stremio Addons** الخارجية (إضافة IPTV، Arab Cinemeta، Torrentio، إلخ) تحت معرّف واحد (**TMDB ↔ IMDb**) للحفاظ على نفس الـ **Watch Progress**.

## طريقة الاستخدام
1. ارفع الملفات (`manifest.json`, `README.md`, وفولدر `providers`) على الـ Repository بتاعك على GitHub.
2. افتح `providers/arabic-unified.js`:
   - ضيف لينك إضافة الـ IPTV وباقي الإضافات جوه `STREAM_ADDONS` وخلّي `enabled: true`.
   - (اختياري) ضيف لينك **Arab Cinemeta** جوه `META_ADDONS`، ومفتاح **TMDB API Key** في `CONFIG.TMDB_API_KEY` لأفضل دقة في الأسماء العربية.
3. أضف رابط الـ Repo في Nuvio واضغط **Test** (الإضافة مفعّل فيها Torrentio افتراضياً وبتشتغل حتى بدون مفتاح TMDB عشان تنجح في الاختبار فوراً).
