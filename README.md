# hermes-loop

یک رلهٔ دو-رانره روی GitHub Actions: هر رانر ۹روتر را پشت قفل خروجی VPN بالا می‌آورد،
Hermes را به تلگرام وصل می‌کند، حدود ۵ ساعت و ۱۵ دقیقه سرویس می‌دهد و پیش از پایان
۶ ساعت، رانر بعدی را صدا می‌زند. رانر بعدی همان وضعیت را از بکاپ رمزنگاری‌شده برمی‌گرداند.

```
runner a ──dispatch──► runner b ──dispatch──► runner a ──► ...
   ▲                                                │
   └────────────── watchdog (هر ۳۰ دقیقه) ───────────┘
```

هیچ تونل/دامنه/پورت عمومی وجود ندارد. Hermes از طریق `127.0.0.1:20128` با ۹روتر حرف
می‌زند و خودِ Hermes مسئول اتصال تلگرام است.

## چیدمان

| مسیر | کار |
| --- | --- |
| `.github/workflows/hermes-loop.yml` | یک نیمه از رله: نصب، اجرا، بکاپ، dispatch بعدی |
| `.github/workflows/watchdog.yml` | اگر هیچ رانری فعال نبود، رله را از نو روشن می‌کند |
| `scripts/runner-router/` | ۹روتر + VPN (awmvpn) + zen-proxy + قفل خروجی uid |
| `scripts/runner-router-foxy/login.mjs` | تازه‌سازی ورود FoxyVPN |
| `scripts/freestyle-router/bootstrap.sh` | نصب ۹روتر و unit سیستم‌د |
| `scripts/hermes/boot.sh` | نصب/بازیابی/پیکربندی/استارت Hermes |
| `scripts/hermes/extras.sh` | نصب ابزارهای هر سشن (ffmpeg، whisper.cpp) روی رانر تازه |
| `scripts/hermes/state.mjs` | بکاپ و بازیابی رمزنگاری‌شدهٔ `~/.hermes` |
| `scripts/hermes/nine-key.mjs` | خواندن یا ساختِ کلید ثابت ۹روتر |
| `scripts/hermes/fallback.mjs` | ساخت/به‌روزرسانی combo فالبک در ۹روتر |
| `scripts/hermes/env.mjs` | نوشتن امن مقادیر حساس در `~/.hermes/.env` |

## وضعیت‌ها کجا ذخیره می‌شوند

دو asset رمزنگاری‌شده در Release‌های همین ریپو (نه در گیت):

* تگ `hermes-state` → `hermes-state.zip.enc` و نسخهٔ قبلی `.prev`
  (کل `~/.hermes`: حافظه، سشن‌ها، مهارت‌ها، config، .env، `state.db`)
* تگ `router-backup` → `9router-state.tar.gz.enc`
  (دیتابیس ۹روتر + `jwt-secret`؛ همان کلید API همیشه حفظ می‌شود)

هر دو با `BACKUP_ENCRYPTION_KEY` و AES-256-GCM مهر می‌شوند. Release عمومی است، اما
بدون کلید قابل استفاده نیست.

**هر ۱۵ دقیقه یک اسنپ‌شات Hermes گرفته می‌شود.** در طول جلسه یک حلقهٔ پس‌زمینه
`hermes backup` را تکرار می‌کند (`SNAPSHOT_INTERVAL_SECONDS`)، و در لحظهٔ تحویل هم
یک‌بار دیگر. این‌طور اگر رانر ناگهانی بمیرد (کنسل، خطای VM، kill شش‌ساعته) حداکثر
۱۵ دقیقه از وضعیت از دست می‌رود، نه کل جلسه. `flock` تضمین می‌کند نوشتن دوره‌ای و
نوشتن نهایی هرگز همزمان روی asset نروند.

**بکاپ ۹روتر هر بار بازنویسی نمی‌شود.** اولین اسنپ‌شات ساخته می‌شود و بعد از آن
دست‌نخورده می‌ماند تا کلید API عوض نشود. فقط اگر در یک اجرا کلید تازه ساخته شده باشد
(`NINE_KEY_MINTED=1`) اسنپ‌شات به‌روز می‌شود. برای چرخش دستی:

```bash
NINE_ROTATE_BACKUP=1 NINE_KEY_MINTED=1 node scripts/runner-router/router.mjs stop
```

## ابزارهای هر سشن (extras)

هر رانر یک VM تازه است، پس هر چیزی بیرون از `~/.hermes` با تحویل رانر از بین می‌رود.
`scripts/hermes/extras.sh` در ابتدای boot (بعد از restore) این‌ها را idempotent نصب
می‌کند:

* `ffmpeg` — اگر روی image نباشد، از apt
* `whisper.cpp` در `/opt/whisper.cpp` + مدل `ggml-base.bin` + دستور `whisper <audio>`

نصب غیرمرگبار است: شکست هر کدام فقط `::warning::` می‌دهد و سشن بالا می‌آید. برای
خاموش کردن کل این مرحله `HERMES_EXTRAS=0` را در env ورک‌فلو بگذارید. ابزار جدید را
با همان الگوی `have <binary>` به انتهای فایل اضافه کنید؛ مدل‌های بزرگ را داخل
`~/.hermes` نگذارید، چون هر ۱۵ دقیقه آپلود می‌شوند.

## زنجیرهٔ فالبک مدل

`scripts/hermes/fallback.mjs` بعد از ساخت کلید، combo‌ای به نام `hermes-free` در
9router می‌سازد یا به‌روز می‌کند:

1. `oc/deepseek-v4.1-flash-free` (مدل اصلی)
2. `oc/mimo-v2.5-free`
3. `oc/glm-5.3-flash-free`

اگر مدلی در `/v1/models` نبود، با `::warning::` رد می‌شود (لیست مدل‌های free
تغییر می‌کند). مسیر combo در 9router روی **پاسخ خالی** (حتی وقتی فقط reasoning
برگشته) و روی ۴۲۹/۵۰۲/۵۰۳/۵۰۴ به مدل بعدی fallback می‌کند. Hermes فقط وقتی به
combo سوییچ می‌شود که ساختش موفق بوده باشد؛ وگرنه روی مدل اصلی می‌ماند.

تغییر لیست با env: `HERMES_PRIMARY_MODEL`، `HERMES_FALLBACK_MODELS`،
`FALLBACK_COMBO`.

## سکرت‌ها

| نام | توضیح |
| --- | --- |
| `GH_PAT` | توکن با `repo` + `workflow` (برای dispatch و assetها) |
| `NINE_ROUTER_PASSWORD` | رمز پنل ۹روتر (فقط داخلی) |
| `BACKUP_ENCRYPTION_KEY` | رمز بکاپ‌ها؛ اگر عوض شود بکاپ‌های قبلی خوانده نمی‌شوند |
| `TELEGRAM_BOT_TOKEN` | توکن ربات تلگرام |
| `TELEGRAM_ALLOWED_USERS` | آیدی عددی کاربر مجاز |
| `FXA_ACCOUNTS_TGZ_B64` یا `FOXY_REFRESH_TOKEN` | ورود VPN فایرفاکس (حداقل یکی) |

## اجرا

```bash
gh workflow run hermes-loop.yml -f runner=a
```

بعد از آن رله خودش می‌چرخد. `watchdog.yml` هر ۳۰ دقیقه بررسی می‌کند که آیا اجرایی
در جریان است؛ اگر نه، دوباره `runner=a` را صدا می‌زند.

### حالت تشخیصی بدون VPN

اگر سکرت VPN موجود نبود، می‌توان یک‌بار بدون آن تست کرد:

```bash
gh workflow run hermes-loop.yml -f runner=a -f no_vpn=yes
```

در این حالت ۹روتر مستقیم از IP خودِ رانر خارج می‌شود (بدون قفل egress). اگر
free-tier جواب بدهد، `probeFreeTier` در لاگ `HTTP 200` می‌دهد؛ اگر ۴۰۳/۴۲۹ بدهد،
یعنی VPN واقعاً لازم است. این حالت برای استفادهٔ دائمی نیست و در dispatch بعدی هم
همان `no_vpn` تکرار می‌شود.

## نکات مهم

* **یک پولر در هر لحظه.** تلگرام برای هر توکن فقط یک long-poll قبول می‌کند؛ به همین
  دلیل `concurrency: hermes-loop` رانرها را سریالی می‌کند. در فاصلهٔ تعویض (حدود
  ۳ تا ۴ دقیقه، اندازه‌گیری‌شده: ۳m۳۵s) پیام‌ها در صف تلگرام می‌مانند و با
  `drop_pending_on_cold_boot: false` تحویل داده می‌شوند.
* **سقف ۶ ساعت.** هر job حداکثر ۶ ساعت است؛ `SESSION_SECONDS` پیش‌فرض ۱۸۹۰۰ ثانیه
  (۵:۱۵) است تا برای نصب و teardown جا بماند.
* **مدل اصلی ثابت است، با یک زنجیرهٔ فالبک:** `oc/deepseek-v4.1-flash-free` با
  `context_length: 200000`. اگر پاسخ خالی/فقط-reasoning برگردد یا ۴۲۹/۵xx بدهد،
  9router روی `oc/mimo-v2.5-free` و بعد `oc/glm-5.3-flash-free` می‌رود (combo
  `hermes-free`). `auxiliary.background_review` و تولید عنوان خودکار خاموش‌اند تا
  مصرف free-tier دو برابر نشود.
* **قفل خروجی فقط برای uid کاربر `nine`** است؛ ترافیک تلگرام/گیت خود Hermes مستقیم
  می‌رود.
* **کرون watchdog بعد از ۶۰ روز بی‌فعالیتیِ ریپو خودکار خاموش می‌شود.** اگر مدتی هیچ
  commit ای نداشتید و رله خوابید، یک commit/تغییر کوچک بزنید یا watchdog را دستی
  اجرا کنید (`gh workflow run watchdog.yml`).
* **اگر رله مرد:** `gh workflow run watchdog.yml` یا
  `gh workflow run hermes-loop.yml -f runner=a`.
* استفادهٔ ۲۴/۷ از رانرهای عمومی GitHub از نظر ToS خاکستری است؛ این ریپو و ورک‌فلو
  عمومی است و هزینه‌ای روی حساب شما نمی‌گذارد، اما مسئولیتش با شماست.
