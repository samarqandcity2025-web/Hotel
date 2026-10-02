# Mehmonxona — Vercel'ga o'rnatish (bir marta)

Kerak bo'ladi: **Supabase** (bepul baza), **Vercel** (sayt), **cron-job.org** (har daqiqada taymerlarni tekshirish).

## 1. Supabase — ma'lumotlar bazasi
1. https://supabase.com → **Start your project** → GitHub bilan kiring.
2. **New project** → nom: `mehmonxona`, parol o'ylab toping, Region: **Frankfurt (eu-central-1)** → Create.
3. Chap menyu → **SQL Editor** → **New query** → `supabase.sql` faylidagi matnni qo'ying → **Run**.
4. Chap menyu → **Project Settings → API** (yoki **API Keys**):
   - **Project URL** ni nusxalang (masalan `https://abcd.supabase.co`)
   - **service_role** (yoki **Secret key**) ni nusxalang. ⚠️ Bu kalitni hech kimga bermang.

## 2. Vercel — muhit o'zgaruvchilari
Vercel → loyihangiz → **Settings → Environment Variables** → quyidagilarni qo'shing:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role / Secret key |
| `CRON_SECRET` | o'zingiz o'ylab topgan uzun so'z, masalan `mehmonxona-7f3k9q2x` |

Keyin **Deployments → oxirgi deploy → ⋯ → Redeploy**.

> Vercel loyihasining **Settings → Build & Deployment** bo'limida *Framework Preset* = **Other** bo'lsin,
> *Build Command* va *Output Directory* bo'sh qolsin (vercel.json o'zi belgilaydi).

## 3. cron-job.org — taymerlar uchun
Hech kim ilovani ochmagan paytda ham "10 daqiqada boshlamadi" ogohlantirishi ketishi uchun:
1. https://cron-job.org → bepul ro'yxatdan o'ting.
2. **Create cronjob**:
   - URL: `https://SIZNING-SAYT.vercel.app/api/tick?key=CRON_SECRET_QIYMATI`
   - Schedule: **Every 1 minute**
   - Save.

## 4. Tekshirish
- Saytni oching → login `4455`, parol `4455` → **darhol Profil'dan parolni o'zgartiring!**
- Xodimlar → tozalovchi va nazoratchilarni qo'shing.
- Har bir xodim telefonda saytni ochadi → kiradi → **🔔 Bildirishnomalarni yoqish**.
  - iPhone: avval Safari → Ulashish ⬆️ → **Bosh ekranga qo'shish**, keyin ikonkadan ochish.

## Kompyuterda sinash
`start.bat` → http://localhost:3000 (ma'lumot `data.json` faylida; telefon bildirishnomalari faqat https/Vercel'da ishlaydi).
