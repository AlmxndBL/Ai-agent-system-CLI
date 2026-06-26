# AI Agent System CLI 🤖

ระบบ AI Coding Agent รันในเครื่อง (Local-first) ที่รองรับการรับคำสั่งผ่าน Telegram Bot, การบันทึกความจำระยะยาวในรูปแบบ Knowledge Graph ใน Obsidian, และรักษาความปลอดภัยระดับสูงสุดด้วย 2FA TOTP และ Sandbox Watchdog

---

## 🛠️ ขั้นตอนการติดตั้ง (Setup Instructions)

### 1. ติดตั้ง Dependencies
เปิด Terminal ในโฟลเดอร์โปรเจกต์แล้วรันคำสั่ง:
```bash
npm install
```

### 2. ตั้งค่าไฟล์ Environment (`.env`)
คัดลอกไฟล์ต้นแบบและนำมาตั้งค่ารายละเอียดของคุณ:
```bash
cp .env.example .env
```

เปิดไฟล์ `.env` แล้วระบุค่าต่าง ๆ ให้ครบถ้วน:
```env
# ตั้งค่าผู้ให้บริการโมเดลหลัก (แนะนำ: deepseek)
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# ที่เก็บความรู้ความจำ Obsidian ( Knowledge Graph )
OBSIDIAN_VAULT_PATH=./vault

# Telegram Gateway สำหรับสั่งการระยะไกล
TELEGRAM_TOKEN=your_telegram_bot_token_here
OWNER_TELEGRAM_ID=your_telegram_user_id_here

# 2FA TOTP Security Secret (ใช้รหัสผ่าน Base32 ความยาว 32 ตัวอักษร)
# สามารถใช้ค่าดีฟอลต์ หรือสุ่มสร้างใหม่เพื่อเพิ่มความปลอดภัย
TOTP_SECRET=AUIKJGBNHTEQZXGIOPLHGRDVJUIKNFGS
```

> **💡 วิธีเชื่อมต่อ TOTP กับ Authenticator App (Google Authenticator):**
> นำรหัสผ่านในฟิลด์ `TOTP_SECRET` ไปกรอกในแอป Google Authenticator บนมือถือผ่านตัวเลือก **"Enter a setup key" (ป้อนคีย์การตั้งค่า)** เพื่อรับรหัส OTP 6 หลักสำหรับยืนยันสิทธิ์

---

## 🚀 วิธีเปิดใช้งานระบบ (Execution)

### 1. รันโหมดตอบคำถามใน Terminal REPL (สำหรับ Dev/Test)
ทดสอบการทำงานของ Agent ในเครื่องโดยตรง (ไม่ต้องเชื่อม Telegram):
```bash
npm run dev
```

### 2. รันระบบทดสอบความปลอดภัย (Security Regression Test)
ตรวจสอบความสมบูรณ์ของระบบจำกัดสิทธิ์ คีย์ความปลอดภัย และฟังก์ชันความลับ:
```bash
npx tsx src/test-security.ts
```

### 3. รันโหมดรีโมท Telegram (ผ่านระบบเฝ้าระวัง Watchdog)
เปิดใช้เกตเวย์เชื่อมต่อรับคำสั่งจาก Telegram Bot ค้างไว้ 24/7 โดยทำงานร่วมกับตัวควบคุมอัจฉริยะ (Supervisor):
```bash
npx tsx src/supervisor.ts
```

---

## 🛡️ คำสั่งควบคุมบน Telegram (Telegram Commands)

เมื่อบอทออนไลน์ใน Telegram เฉพาะ **Owner** (เจ้าของที่ระบุ `OWNER_TELEGRAM_ID`) เท่านั้นที่จะพิมพ์คุยกับบอทได้ โดยรองรับคำสั่งแอดมินดังนี้:

*   **พิมพ์ถามตอบทั่วไป**: ส่งข้อความหาบอทตรง ๆ บอทจะเริ่มคิดและเรียกใช้ไฟล์ตามที่มอบหมาย
*   **`/status`**: เช็กสถานะการทำงาน ตัวแปรแฝง (Taint) และสถานะ Kill-switch ของ Daemon
*   **`/panic`**: สั่งล็อกดาวน์ (Kill-switch) แช่แข็งบอททันที บอทจะปฏิเสธทุกเครื่องมือจนกว่าจะปลดล็อก
*   **`/unpanic <รหัส TOTP>`**: ปลดล็อกสถานะล็อกดาวน์คืนสู่สถานะปกติ โดยต้องป้อนรหัส 6 หลักจากแอป Authenticator เช่น `/unpanic 123456`
*   **`/clear_taint`**: ล้างหน่วยความจำแฝงที่ปนเปื้อนความเสี่ยง (Taint) ของเซสชันปัจจุบัน
*   **ระบบ Mutate (แก้ไขไฟล์/รันคำสั่งเครื่อง)**: บอทจะระงับการทำงานชั่วคราวและพิมพ์ส่งข้อความมาถามรหัส TOTP บน Telegram เพื่อยืนยันสิทธิ์ก่อนทำงานจริงทุกครั้ง
