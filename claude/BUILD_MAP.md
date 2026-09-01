# Speedy Platform — Full Build Map (replace HawkSoft)
**Drafted July 21, 2026 · for phase-by-phase discussion with Claude · owner sign-off: Tony**

## Vision
One Speedy-owned system that runs the agency: clients, policies, payments, documents, tasks, carrier data, reporting. HawkSoft runs in parallel until each capability is replaced, then becomes read-only history. Strategy: own the **money** first, then **clients/intake**, then **carrier data**, then **policy management**, compliance last-but-always.

## What we already own (foundation, live today)
- **Payment engine** — charge page v2.24 + pay.html: cards, cash, pay links, Apple/Google Pay, branded PDFs, $1k cap
- **bridge_ledger (Supabase)** — every payment event dual-written to OUR database (verified, awaiting first row)
- **AI intake** — api/intake.js (claude-sonnet-4-6) extracts docs → structured data; created real HawkSoft client #26094
- **HawkSoft Partner API access** — full read of clients/policies/invoices; our sync source during parallel-run
- **Clover rails** — 4 branch merchants mapped, terminal dev app awaiting approval, ecomm live
- **Infra** — Vercel (site+APIs), Supabase (Postgres), Blob storage, Google Workspace auth, GitHub, Claude API
- **IVANS account** — YE69R belongs to Speedy, not HawkSoft (portable)

## Build phases — each # = one discussion session before building

### PHASE A — Money (now → 30 days)
- **A1. Ledger verification + backfill** ✅ built, verify first rows; optionally backfill from blob audits
- **A2. Reports & reconciliation dashboard** — Tony view on OUR data: revenue by branch/agent/day/method, unmatched queue, Clover-vs-ledger reconciliation. *Discuss: which reports Tony actually wants.*
- **A3. Our invoices** — invoice table in Supabase; charge creates OUR invoice always (HawkSoft's too when their API arrives). *Discuss: numbering scheme, what counts as an invoice legally.*
- **A4. Terminal charging** — when Clover approves (already in motion)
- **A5. Per-branch settlement** — VB/MG/LE ecomm tokens + branch-aware routing. *Discuss with Tony: does he want per-branch books?*

### PHASE B — Clients & intake (30–90 days)
- **B1. Clients table** — our client registry; bulk-seed via Partner API read; HawkSoft # = just a field. *Discuss: dedupe rules, what fields are canonical.*
- **B2. Intake to production** — AI extraction writes to OUR clients + HawkSoft simultaneously; agent review screen
- **B3. Leads pipeline** — website quote form (TurboRater embed) → our leads table → assignment → conversion tracking. *Replaces the CRM decision (InsuredMine/HubSpot may become unnecessary.)*
- **B4. Communication log** — link RingCentral/GoTo call+SMS records and sent emails to client records. *Depends on phone-vendor decision.*

### PHASE C — Policies & carrier data (90–180 days)
- **C1. Policies table** — synced nightly from HawkSoft reads: carrier, term, premium, renewal, status
- **C2. IVANS direct feed** — THE independence unlock. Ask Brian Marable: can our platform consume the AL3 mailbox directly + can Speedy be a sender. Build AL3 parser → policy updates flow into OUR system. *Discuss: parallel to HawkSoft's feed or replacing it; AL3 parsing scope (start with personal auto).* 
- **C3. Renewal engine** — renewal lists, reminders, agent tasks from OUR policy data (Phase 2 automation goals land here)
- **C4. Document vault** — all attachments/dec pages/PDFs in our storage, AI-indexed, linked to client+policy

### PHASE D — Operations (180–365 days)
- **D1. Tasks & workflow** — our task system (bridge tasks land here first)
- **D2. Agent portal** — one screen: client + policies + payments + docs + tasks; charge page grows into it; per-agent auth via Workspace
- **D3. Quoting bridge** — TurboRater .tt2x generator already exists; extend to feed OUR system
- **D4. Trust accounting** — full double-entry: receipts, disbursements, carrier payables, commission tracking. *Heaviest lift; needs bookkeeper at the table.*
- **D5. Commissions** — statements (IVANS Direct Bill Commission feed) → agent splits

### PHASE E — Compliance & cutover (12–24 months)
- **E1. Compliance layer** — E&O audit trails, CCPA retention/deletion, record-keeping standards, ACORD form generation. *Insurance attorney/E&O carrier consult before cutover.*
- **E2. Backup/DR** — Supabase PITR, exports, tested restores
- **E3. Parallel-run audit** — months of both systems; automated diff reports (our data vs HawkSoft) until gaps = zero
- **E4. Cutover** — HawkSoft to read-only; cancel when history export is secured

## Standing decisions needed from Tony
1. Bless the direction (build-to-replace vs build-alongside-forever)
2. $1,000 charge cap · per-branch settlement · legacy Clover businesses
3. Budget: Supabase Pro (~$25/mo) + Vercel Pro (~$20/mo) when scale demands; attorney consult at Phase E
4. Phone vendor (RingCentral vs GoTo) — affects B4

## Risks (honest)
- **Compliance is the real moat** — software is the easy half; running an agency's books/records on it legally is the hard half
- **IVANS/AL3** — carrier data formats are old and quirky; C2 is the most technically uncertain build
- **Key-person** — the platform is Saif+Claude; document everything (this file, memory, repo)
- **HawkSoft dependency during parallel-run** — API terms/pricing could change; keep exports current

## How to use this map
New chat → "Let's discuss [item #] from the platform map" → we design that piece, agree scope, then build. One item at a time, everything logged to our system, nothing breaks the working agency.
