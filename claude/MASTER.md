# Speedy Insurance Agency — Master Project
**Last updated: September 5, 2026 · maintained by Saif + Claude**
**Standing rule: Claude keeps this file current as work happens, so any new chat can pick up seamlessly.**

> **THIS IS THE ONLY COPY.** On Aug 28 the project held **six separate documents
> all named `Speedy_Insurance_Master_Project.md`** (Aug 21 ×4, Aug 24, Aug 28).
> They were not version history — they were independent docs sharing a filename,
> and a new session opened a stale one and correctly reported that August 28's
> work did not exist. All six were deleted and this single file written in their
> place. **Never create a second doc at this path.** `project_write` to this exact
> path replaces it; that is the only correct way to update it.

**Owner/CEO:** Tony Dabouqi · **Management:** Lana D. (CC on significant comms)
**IT Admin / Claude operator:** Saif Ayoob — speedyinsadmin@gmail.com
**Business:** Independent insurance agency, 5 branches. Specialty: auto, SR-22, DUI/non-standard, DMV services.

## Branches & hours
- Moreno Valley — 12625 Frederick St #I-1 · (951) 472-0927 · Mgr: Sammy Rodriguez
- Riverside Van Buren — **2995 Van Buren Blvd Ste A7** · Mgr: Yasmin Alfaro — *corrected Aug 28; this file said 2955 for months and was wrong*
- Riverside Magnolia — 7010 Magnolia Ave · Mgr: Alejandra E. Salas
- Lake Elsinore — 32285 Mission Trail P5 · Yolanda Hernandez
- Colton — 1047 N Mount Vernon Ave · (909) 587-6001 · Mgr: Christian Aguilar
**HOURS:** Mon–Fri 9am–7pm, Sat 10am–5pm. **Sundays: ONLY Moreno Valley open 10am–5pm.**

## Big picture
Building the **Speedy Platform** — a proprietary AMS to eventually replace HawkSoft — while running agency IT. Own the money first, then clients/intake, then carrier data, then policy mgmt, compliance last. HawkSoft runs in parallel until each capability is replaced.

**Companion docs:** `Speedy_Platform_Build_Map.md` (phase map A–E) · `claude/Speedy_Workspace_Setup.md` (**the systems index — every link, every ID, the full Clover picture, scheduled tasks**).

---

## HOW TO CONTINUE IN A NEW CHAT
1. Start the new task **inside the Speedy Insurance project**, and **attach the GitHub repos** (`speedy-website`, `speedy-dashboard`) using the repository picker when the task is created. Without that, Claude can read the repos but **cannot push** — see open item #55.
2. Claude reads THIS file, then `Speedy_Workspace_Setup.md`.
3. **Ops Console** (the one dashboard): https://claude.ai/code/artifact/13f422b8-9364-4783-b68b-879eba93a781

---

## ⛔ DO FIRST

### 1. ~~Apply the phone-search fix~~ **DONE Aug 29** (`dbacd6e9`) — both sites
Also full-name search (`6070c22d`). Ask an agent to search a full number WITH the
area code, and a full name — neither had ever worked and neither is confirmed from
the floor yet.

### 1b. CREATE THE PRIVATE BLOB STORE — Saif, in Vercel
See "DOCUMENT STORAGE" below. Everything else in the document queue is behind it.

### 2. Portal is not showing open invoices (REPORTED, NOT DIAGNOSED)
Charge page shows them, portal does not. **Both code paths traced end to end and they are identical** — same `charge_lookup` action, same `clientId` payload, same server handler, same `openInvoices` field, same render. NOT the recurring missing-`select` bug.

The one difference: **`charge.html` sends an `x-admin-key` header when that box is filled; the portal never does.**

**The check that settles it:** portal → DevTools → Network → the `/api/hawksoft` call → Response → read `result.openInvoices`.
- Array with items, nothing on screen → render bug in the portal
- Empty or missing → the server returned nothing; the portal is not at fault

Claude will not ship a fix to a money page on a theory it could not test.

### 3. Verify the Aug 24 document fix (commit `c6225e2a`)
Open an **audited** payment → `+ Add more documents` → upload → **read the Pol column in HawkSoft.** Must read **1**, not 0. If 0, check whether that client has two records sharing a policy number — then the resolver correctly refused to guess.

### 4. `Pol 1` — PARTIALLY PROVEN, finish it
ZZTEST #26081 showed three **charge** rows at **Pol 1**, but those were CHARGE-page cash on the test client, not a PORTAL-launched card charge. **Alejandra's real card charge on client #21937 is the candidate** — ask which button she used, then read Pol on all three rows. **Not client 16810** (duplicate policy numbers).

---

## AUG 29 — ELEVEN COMMITS. THE SAME BUG THREE TIMES.

**One root cause produced three separate outages, all shipped fixed today: a value
transformed on one side and compared against the untransformed other.**

### 1. Melisa could not sign in — and I broke her twice
`melisa@speedyins.com` (Melisa Hernandez, MSH, Moreno Valley) was in no roster in
the repo. Added to six sites: both `AGENT_ALLOWLIST`s, `AGENT_NAME`,
`STAFF_EMAILS`, and the `STAFF` maps in `hawksoft.js`, `portal.html`,
`charge.html`, `platform.html` (`719adcf9`).

**Then two later commits silently reverted her.** `edf9912b` and `dbacd6e9` wrote
`hawksoft.js` and `platform.js` from copies downloaded BEFORE that commit. Both
pushes were clean fast-forwards that happened to contain a revert; she was locked
out again and nobody knew. Restored in `0d5fab52`.

> **NEW RULE, learned the hard way: re-fetching the base SHA is not enough.**
> The SHA was fresh and the FILE BODY was stale, so git had no conflict to raise.
> **Re-fetch the file CONTENT immediately before patching, not just the ref.**
> Post-push verification is what caught it — grep for a marker that must still be
> there, not only for the one you just added.

Her home branch is **Moreno Valley**. Note: RingCentral has her extension
(`62433465023`, formerly Fernando's until Aug 18) in the **Van Buren** office
group, so `call_log.office_id` says Van Buren and is WRONG. **`office_id` is not a
home-branch signal** — agents move between branches and the extension does not.

### 2. Phone search — 0 / 500 (`dbacd6e9`)
The Aug 28 fix, finally deployed, at BOTH sites. Old code 0/500 on real rows, new
code 500/500. Collision cost measured: 32 of 25,207 phones ambiguous (0.13%),
worst case is the placeholder `999-9999`; real collisions top out at 9 clients.

### 3. Full-name search had never worked either (`6070c22d`)
Reported from the floor: `SAMUEL RODRIGUEZ` finds nothing, his phone finds him.
He is stored split — `first_name` Samuel, `last_name` Rodriguez — and the filter
asked each column whether it contained the whole phrase. No column ever holds both.

| | old | new |
|---|---|---|
| "First Last" | 14 / 25,629 | **25,629 / 25,629** |
| "Last First" | 0 / 25,629 | **25,629 / 25,629** |

Multi-word queries seed the request with the LONGEST word (most selective — garcia,
the worst common surname, is 536 rows of 25,638) and apply the rest in JS. This
keeps the proven `or=()` syntax instead of nesting `and=(or(...),or(...))`, which
**cannot be tested from the sandbox** and would break search outright if wrong.
Both sites now share ONE helper, `buildClientSearch` — the phone logic had already
been duplicated and was drifting.

### 4. Ownership decided by comparing an email to a display name (`93570a67`)
Client 20723: a $541 payment reads "needs proof", the banner says it needs YOUR
proof, and the card offers no button. `portal_client` sends `charged_by` as a
DISPLAY NAME and the card tested:

```js
String(p.charged_by).toLowerCase().includes(EMAIL.split('@')[0])
```

For `info@speedyins.com` that asks whether `"tony dabouqi"` contains `"info"`.
**2 of 17 agents broken — `info@` and `lfigueroa@`. The other 15 passed by
coincidence**, because their display name happens to contain their email's local
part. Laura has 3,857 clients and never reported it.

`charged_by_email` is now sent and identifiers are compared to identifiers. The
two questions are also separated, because they were never the same one:
**who EARNS it** decides who finishes the audit; **who TOOK it** decides who may
help with paperwork. Owner gets the full audit; anyone else gets documents-only,
because `save_carrier_leg` is guarded server-side by `mayTouchPayment` and would
refuse them AFTER the work.

### 5. The receipt vault was handed a policy and threw it away (`5f891b80`)
`storeReceiptVault` has taken `policyGuid` since day one and never wrote it.

| doc type | rows since Aug 24 fix | with a policy |
|---|---|---|
| `carrier_receipt` (carrier.js) | 46 | 38 |
| `client_receipt` (this vault) | 49 | **0** |

**The resolver was never the problem** — one path was never wired to it. 43 had
exactly one matching policy with a GUID on the right client. Same commit fixes
`filed_hawksoft` (false on all 49 although `fileReceiptPdf` posts to HawkSoft
BEFORE the vault write and already holds the result) and stores the RefId.

**Backfill done: 82 rows matched, 0 on the wrong client, 28 genuinely unresolvable**
(23 no policy chosen at the charge, 5 number not on that client). Zero ambiguous.

### 6. RefId is an enforced idempotency key — proved, not assumed
Probe on ZZTEST (`edf9912b`): two attachments sharing one RefId → the second came
back **500 Conflict, SQL unique violation**. Control pair with separate RefIds both
200. So:
- **Grouping attachments onto one log row by RefId is impossible.** Dead end, closed.
- **RefId IS worth storing** — it is what makes a retry safe instead of filing twice.
  99 charges to date stored none.

### 7. HawkSoft cannot link logs from the API — settled
`LINK LOG` is CMS-only. The v4 API has three write endpoints (Log Note, Attachment,
Create Receipts); **none has a link field, and HawkSoft returns no id for anything
it creates** — the receipts response echoes only our own `refId` and a code.
**We DO create HawkSoft receipts** (98 posted, 0 failures) — that was never a
ceiling. The real ceilings stay: no receipt-modify, no invoice-create, no
attachment-modify.

**Still open from this:** each charge posts THREE rows to HawkSoft (receipt +
attachment + a text-only summary log). The summary is redundant and ours to delete;
folding it into the attachment's LogNote takes it to two. Mocked up, **parked by
Saif**.

### 8. Portal v3.1 → v3.3
- **v3.1 (`ff6371f7`) Refresh from HawkSoft** on the client card and the charge
  sheet. Sammy created a DMV tab and could not charge it. `portal_refresh_clients`
  ALREADY syncs policies as well as clients — it was only rendered in the "no
  clients found" state. Placement, not plumbing. The charge-sheet button sits
  OUTSIDE `#chgPolWrap` on purpose: the wrap is hidden when a client has no
  policies, which is exactly when a new tab needs pulling in. A skipped sync still
  re-reads the client — the 60s cooldown is shared by thirteen agents.
- **v3.2 (`e737a4b3`) policy accordion.** Client 6402 has fourteen tabs and
  "See full details" expanded all of them. Now one row per policy, one open at a
  time, DMV records included. Measured: 48,006 chars of markup → 14,326.
- **v3.3 (`93570a67`)** ownership fix above.

### 9. Producer codes mapped (`ea05d748`)
From HawkSoft User Setup: **MSH** Melisa · **MCR** Malcolm · **IAH** Irene ·
**LND** Lana · **GGR** Gabriela. Display only — no access, no commission change.
**SAA is Saif's HawkSoft test account on a gmail — deliberately excluded.**
**NRR (2,326 clients), TTD (949), LSN (953) and the rest are departed staff and are
deliberately left unmapped** — mapping them would make the charge sheet offer to
hand commission to someone who left. 40 codes exist in the data against 17 users;
**27% of the book (6,282 of 23,181) has a producer we cannot name, and that is
correct.**

### 10. Audit completion is now recorded (`7e921fae`) — step 1 of opening it up
`audit_completed_by` has existed since the ledger was built: **73 audits complete,
1 row populated, zero writers.** Now written on completion only. The owner is told
via a new `audit.completed_by_other` event and the bell shows the carrier cost that
was set, because that number is what their commission is worked out from.

`portal_share_due` had a real gap: it only looked at who RAN the charge, so an agent
who FINISHED the audit was invisible to the share flow and the owner was never
asked. `helperOf()` now considers both and prefers the auditor.

**Commission never moves on its own** — completing an audit does not touch
`commission_to`. Saif confirmed: the owner earns it unless he chooses to share.

---

## AUG 29 EVENING — DOCUMENT STORAGE MOVED, AND EVERYTHING ELSE SHIPPED

### Storage: Supabase, not Vercel — and Saif caught the mistake
All 212 attachments were base64 inside Postgres, 28 MB, `blob_url` NULL on every
row. I went to Vercel Blob because `blobPut()` was already half-written for it and
never stepped back to ask whether the storage **we already pay for** was better.
Saif asked "doesn't Supabase do this?" and it does:

- **Supabase Pro includes 100 GB of file storage**, unused
- the service-role key is already in the environment — no new credential, and no
  waiting for an env var to reach a deployment
- Vercel public blob URLs are *"unique and hard to guess"*, which is obscurity, not
  access control

**Bucket `client-documents` — PRIVATE.** 5 MB cap (matches HawkSoft's own limit),
MIME allowlist. Verified at the database level: **RLS is on `storage.objects` with
ZERO policies**, so `anon` and `authenticated` can read nothing; only the
service-role key, which bypasses RLS and never leaves the server.

**No signed URLs, deliberately.** Once minted they work for anyone holding them
until expiry — weaker than the Google SSO + allowlist already in front of
`portal_doc`. `blob_url` holds an object PATH and is never sent to the browser.
`attachment_get` WAS returning it: harmless while the column was NULL everywhere,
a leak the moment storage went live. Closed in the same commit.

**Dual write.** `file_b64` stays until documents have demonstrably been read from
storage for a month. `portal_doc` returns a `served` field (`storage` / `inline`)
so the switchover is measurable rather than assumed.

> **⏰ IN A MONTH:** confirm `served: "storage"`, then drop `file_b64` and reclaim
> the 28 MB from Postgres.

### The migration bug — a retryable write needs a deterministic key
First attempt did 25 uploads + 25 read-backs per batch on files up to 3 MB. The
function hit its time limit mid-batch: objects landed, rows never got their path,
the next batch re-selected the same rows and — because the object name was a fresh
**random uuid** — uploaded them again. Measured: **118 orphaned objects against
exactly 118 rows still inline.** It could never finish.

Fixed by keying the migration object on the **attachment id** and upserting, so a
retry overwrites. The live upload path keeps a random uuid, because there each
upload is genuinely new. Batch 25 → 8.

**Final state: 216 documents, 216 in storage, 0 broken paths, 0 orphans, inline
copy kept on every one.** 119 orphans swept after proving zero were referenced.

> **LESSON: any write that might be retried needs a deterministic key.** Same
> family as the RefId finding this morning.

### Everything else shipped tonight
- **Policy documents** (`52a246bc`) — "＋ Documents" on an open policy row. Reuses
  `carrier.html?docs=1`. One server change: `add_document` auto-attached a
  `payment_id` when the client had exactly one open payment, which would have
  stapled an ID card to an unrelated charge. `nopay=1` says which case it is.
- **Charge this policy** (`01640c2f`, v3.5) — preselects that policy in the picker.
  **ONE SHOT**, cleared the line after it is read; left set, the next charge would
  open on a policy nobody chose and the receipt prints whatever is selected.
- **Help list** (`eb1b8365`, v3.6) — other agents' open audits, built from rows
  `portal_home` already holds. Carries **no money at all**.
- **save_carrier_leg OPENED to helpers** (`e1896c46`) — **approved by Tony.** Any
  agent may finish an OPEN audit. Once **complete**, only the owner or admin may
  change the numbers. Also fixed the server mirror of the ownership bug: the guard
  read `agent` (who charged) not `commission_to` (who earns), so an owner was
  refused on their own audit — 1 of 31 open audits.
- **v3.7** (`e57e4263`) — two floor-reported bugs within minutes of v3.6: the help
  sheet had no `#helpSheet` in the overlay CSS rule so it would not scroll (the
  CSS-assumed-to-exist pattern, hit again), and `helpWith` called `addDocsFor`,
  sending agents to the "already audited" screen for an OPEN audit.
- **v3.8** (`8ff141c8`) — the bell only repainted inside `loadHome()`. Events were
  written, unread counts were right, and an agent sitting on the portal was never
  told. Now polls every 3 min and on window focus, never mid-charge.
- **v3.9** (`176f05b2`) — tap "Earned this month" for the lines behind it, plus a
  **"You helped on N"** section for work done on payments the agent does not earn.
  Helped lines carry no fee, carrier cost or commission.

---

## AUG 30–31 — LIGHT MODE, A ROSTER TABLE, AND THREE BUGS I CAUSED OR FOUND

### Shipped
- **v4.0 light mode** (`7016eda9`). Toggle beside sign out, per DEVICE in
  localStorage, applied before first paint. `--amber` is a button background AND
  warning text, so text got `--amber-ink`; `--blue-l` and `--green` are substituted,
  not lightened. Four hairlines and the sheet backdrop became `--hair` / `--scrim`.
  **portal.html only** — charge/carrier/Console still dark.
- **daisy@ added** (`59185635`) — Daisy Hurtado, **DHT**, Riverside Van Buren.
- **v4.1** (`d65c59e6`) — see the month bug below, plus a period picker and a real
  scroll fix.
- **`me` scope fix** (`d9dc30fd`) — see below.

### ⚠️ THE MONTH BUG — every agent read $0.00 for 24 hours, every month
`monthStart` was `Date.UTC(...)`. At 17:53 Pacific on Aug 31 it is already Sept 1 in
UTC, so the boundary moved to September while agents were still working August.
Sammy: **50 completed August payments, $9,496.23 of fees**, all behind the boundary,
showing as nothing.

Now Pacific, with the offset **MEASURED** for the date: midday UTC is the same
calendar day everywhere, so formatting it in Pacific and subtracting gives 7 (PDT) or
8 (PST). My first attempt guessed PST and compared only the DATE — which passes for
PDT dates too, since 08:00 UTC is 1am PDT — and the harness caught it.

`portal_home` now takes `period=this|last|YYYY-MM-DD:YYYY-MM-DD`. Current month is
open-ended; last month and ranges are bounded with an **exclusive next-midnight end**
so the final day is included. The server returns the period it used, so the tile label
cannot disagree with the number under it.

### ⚠️ portal_news AND portal_share_due THREW ON EVERY CALL FOR 18 DAYS
```
ReferenceError: me is not defined
count=169  users=3  first=2026-08-14  routes=/api/platform
```
`me` was declared inside `portal_home`'s own if-block; both sibling views used it.
**That is the real reason the bell never worked** — not, as I said on Aug 30, that
the events were addressed to sammy@. That was true but incomplete and stated too
confidently. `portal_news` was 500ing for everyone. The v3.8 polling was polling an
endpoint that could only fail. `portal_share_due` has **never once** asked an owner
about sharing.

> **LESSON: check Vercel runtime errors before theorising about a UI symptom.**
> `get_runtime_errors` had the answer the whole time.

### ⚠️ I LOCKED TONY OUT OF THE CONSOLE
Moving the roster to a table, `syncRoster` **replaced** `ADMIN_ALLOWLIST` with
whatever the table returned. Actual cause: `loadRoster` was inserted just above
`const portalViews`, which is INSIDE the handler — so it was invisible to
`syncRoster` at module scope. `ReferenceError: loadRoster is not defined`.

`node --check` cannot see a scope error, and my harness extracted the two functions
and ran them together, which is exactly where a scope bug hides.

Then I shipped a hotfix on an unconfirmed theory, it did not work, and only then did
I revert. **The revert should have been first.**

> **RULES, both earned the hard way:**
> - **A gate must never be able to lock the owner out of the tool used to fix it.**
>   Admin lists are ADDITIVE from a database; code is the floor.
> - **Verify scope by measuring brace depth, not by reading indentation.**
> - **During a live outage, revert first and diagnose after.**

### ⚠️ SHEETS NOT SCROLLING — reported TWICE, my fault twice
All six sheets were in the overlay rule with `overflow-y:auto`, which is why I thought
v3.7 settled it. Fixed structurally in v4.1: the **card** is capped and scrolls, using
**`100dvh` not `100vh`** — on mobile `100vh` excludes browser chrome, so the last rows
sit under the address bar. That is most likely what he hit both times.

### ✅ RESOLVED SEP 1 — THE "Tendered 0.00" FINDING WAS WRONG. I WAS WRONG.

**What I claimed on Aug 30:** every bridge receipt records Tendered 0.00, so real
Clover money sits in trust accounting as uncollected. I said the arithmetic proved it
— the 801.13 gap in the 08/28 report matching our three receipts exactly. I filed it
as the highest-value open item.

**It is false.** Proven on two REAL clients, Sep 1:

| Client | Receipt | Pay Time | Invoiced | Tendered | Created By |
|---|---|---|---|---|---|
| 26310 Rudy | **RCT00114750** | 6:08 PM | 320.00 | **320.00** | *(blank — Private API)* |
| 26310 Rudy | RCT00114749 | — | 320.00 | 0.00 | **EHA** |
| 26310 Rudy | RCT00114751 | 6:09 PM | 320.00 | 320.00 | **EHA** |
| 13001 Victor | **RCT00114754** | 6:55 PM | 0.00 | **210.00** | *(blank — Private API)* |
| 13001 Victor | RCT00114755 | — | 210.00 | 0.00 (Credit Used 210.00) | **EHA** |

**Our receipts record the money correctly, in Tendered.** The zero-tender rows are
HAND-KEYED. Esmeralda keyed Rudy's $320 twice on top of ours, one minute apart, and
one of her own attempts recorded nothing.

**Esmeralda has confirmed she was duplicating.**

> **HOW I GOT IT WRONG — the reasoning error, not the conclusion:**
> The end-of-period report had **no Created By column.** I inferred which receipts
> were ours from the Tendered pattern, then used that same pattern as proof that our
> receipts don't tender. Circular. The moment a Created By column was visible the
> whole thing inverted. **Never infer the identifying attribute from the pattern you
> are trying to explain — find a column that states it.**

**The probe was still worth running** and its result stands: variant A (`total` +
`payMethod: Cash`, exactly what we send) recorded **1.11 tendered**; variant B with no
payMethod recorded 1.22 and defaulted to 'Other'; variant C with **no `total`**
recorded nothing. So `total` carries the amount despite being absent from the
documented field table, and our payload is right.

*(Note: ZZTEST is full of manual junk from many sources — Saif's warning. Do not draw
conclusions from client 26081. Use real clients.)*

### ⛔ THE REAL PROBLEM — agents cannot tell the bridge already posted the receipt
Nothing is missing from trust accounting; things are recorded TWICE. After a bridge
charge the agent gets no clear signal that HawkSoft already holds the receipt, so they
create one by hand. That is the Aug 29 observation about three log rows per charge,
which I chased past.

**Next step is a conversation, not code:** ask Esmeralda what she sees on screen after
a bridge charge and what would have stopped her keying it again. She is the person who
can answer it. Candidate fixes once we know: the receipt number visible in the portal
after a charge, a clearer confirmation, and the redundant third log row merged.

---

### public.agents — the table exists, nothing reads it
Seeded 18 rows and verified equal to code in BOTH directions before switching. That
check caught a real discrepancy: **gabriela@ had a producer code but was never in
AGENT_ALLOWLIST**, so seeding her active would have silently granted portal access.
Seeded inactive.

That drew the line the design needs: **`active` gates SIGN-IN ONLY.** Names and
producer codes must include inactive people — a departed agent's name must still
render on the payments they wrote.

**The wiring is reverted; the table is untouched.** Retry rules:
1. Admins ADDITIVE, never replaced.
2. Declare helpers at true module scope — verify with brace depth.
3. Test against a real request before it goes near `verifyGoogle`.

---

## SEP 1 — COMMISSION BY APPROVAL DATE, FEE-ONLY, AND TWO OUTAGES I CAUSED

### Shipped
- **`audit_completed_at`** (`69593c45`) — commission is earned in the month the audit
  is **APPROVED**, Tony's rule. A closed month can never move afterwards. Backfilled
  116/116 from `carrier_leg.completed`; none approved before charged. One agent moved:
  Sammy's August fee base 9,496.23 → 9,888.65.
- **Fee-only** (`1ba56a46`, `f3849d91`) — "This is a fee — no carrier payment" on the
  carrier page. Sets amount 0, waives the receipt, keeps `carrier_zero_ack`.
- **Existing receipt counts** (`5665bb83`) — the page reads receipts already attached
  and stops demanding a re-upload.
- **`admin/ops.html`** (`b77c4c7e`, `f647d9f4`) — the ops console, out of the artifact
  and into the repo. Empty shell; everything from the gated `ops_summary`.
- **`claude/MASTER.md` + WORKSPACE + BUILD_MAP** in the repo (`f30fe573`, `5af209c5`).
  Project files are down to one PDF. **No more uploads.**

### ⚠️ OUTAGE 1 — Submit to audit threw for 3 hours. My scope error.
Adding `audit_completed_at`, I inserted `const nowIso` before the FIRST
`if (payment_id) {` in the file — which is inside `resolvePolicyGuid`, not
`save_carrier_leg`. The completion branch referenced a free variable, so the whole
PATCH threw before running.

**Save & finish later worked; Submit to audit did not** — the partial save never
evaluates the completion branch. Three agents blocked. Five audits half-written.
**They retried, and each retry uploaded another carrier receipt: 16 across 5
payments, two with five each.** HawkSoft has no attachment-delete endpoint, so every
duplicate is permanent.

Hotfix `d06ea9c5`: timestamp computed inline. **Second time this exact mistake hit
production** — `loadRoster` on Aug 30 was the same thing.

> **RULE: an anchor that matches a common line must be verified to be the RIGHT
> occurrence before writing.** `if (payment_id) {` appears many times.

### ⚠️ OUTAGE 2 — the fee-only toggle called `recalc()`, which does not exist
The function is `recalcFee()`. The handler threw on its first line, so the fee stayed
em-dash and Submit never enabled. Third name-resolution error in one day.

> **RULE, and this one changed how I work: PARSING IS NOT ENOUGH for a page whose
> behaviour lives in handlers.** `node --check` and `new Function()` both pass on a
> call to a function that does not exist. The harness now EXECUTES the real handlers
> in a DOM complete enough to load the whole page — URL params, auto-created
> elements, `getComputedStyle` — and reproduces the exact reported case. That is the
> standard for carrier.html and portal.html from now on. It caught the next bug
> immediately.

### ✅ The "refresh from HawkSoft is broken" report — it is not
Sammy, client **23822** ARQUELAO AREVALO LEMUS. His 16:41 refresh **worked**: 4
clients, 22 policies, and his new ANCHOR GENERAL tab landed in `policies`.

**It has no policy number yet, and the picker filters on `p.policy_number`.** So it
syncs, stores, and is then hidden. To the agent that is indistinguishable from a
broken refresh.

**429 unnumbered policies across 373 clients.** Not an edge case.

### ⛔ NEXT: unnumbered policies — DO NOT SHIP HALF OF THIS
Showing them in the picker is easy. Making them FILE is not: the charge resolves the
policy by matching the NUMBER against HawkSoft's live list —

```js
const hit = pols.find(pl => pl.policyNumber.toUpperCase() === want);
```

— so no number means no match and the receipt silently files at client level with
`policyLink: 'no policy # given'`. **Showing the option without fixing filing is
WORSE than hiding it**: the agent picks it, believes it filed to the tab, and it did
not.

Doing it properly = the charge path accepts a policy **GUID** directly and skips the
number match. That is `hawksoft.js`, money path, and needs the executing harness plus
a ZZTEST run before any real client.

**Agent workaround meanwhile:** pick "No policy — file at client level", take the
payment, link once the carrier issues the number.

**Also agreed for that piece:** group the picker by status (active, new, DMV,
cancelled last), and **no preselect above 3 tabs** — a glance at a pre-filled field is
how a receipt lands on a policy HawkSoft cannot move it off. Average is 1.8 tabs;
only 119 of 25,648 clients exceed 10; worst is 63.

**A picker SHEET was mocked up and deliberately declined for now** — 99.5% of charges
are 1–2 tabs, and replacing a control used on every charge was not worth it the same
day I broke the system twice. Revisit if agents complain about picking; its real
advantage is search.

### Roles and the agents table — agreed, not built
`is_admin` → `role`: **agent / admin / owner**. Admin gets Console + audit approval;
owner gets commission overrides, deactivation, changing another admin. `tony@` is
`is_admin` in the table but NOT in code — correct that when wiring.

**info@ is the ONLY admin** (Saif, Sep 1). All other `@speedyins.com` agents get
portal + charge. Portal keeps the **explicit allowlist**, not a domain gate — a
departed agent keeps access until their Google account is disabled, and NRR (2,326
clients) shows that does not happen reliably.

**Then an Agents panel in the Console** — list, add, change branch, deactivate. Never
"invite": the Workspace mailbox already exists, we only grant access. Guardrails: it
cannot remove the last admin or demote yourself; `active=false` never deletes; every
change writes to `events`.

### Two-stage audit — agreed, blocked on Tony
Stage 1 money (carrier cost + receipt, exists today). Stage 2 file (required documents
present and approved by Tony). Green today means only stage 1, which is why nobody can
tell if a charge is genuinely finished.

**Blocked on the document checklist per purpose** — new business needs signed policy,
charge receipt, broker fee agreement, car photos; an endorsement needs something else.
Without that list Tony is typing free text at people. **Saif: keep it open until Tony's
approval design is studied.**

### Tony's by-agent commission tab — agreed, not built
By agent, by period, every payment with the full math: charged, carrier cost, fee,
percentage, commission, shares. So "why did Sammy make that much" is read, not asked.

---

## SEP 2–3 — UNNUMBERED POLICIES, RETRO-LINKING, AND A RECEIPT ON THE WRONG TAB

### Shipped
- **Fee-only carrier fix** (`ec18b795`) — the gate still demanded the NAME of a
  carrier that was not paid. Sammy on 23822 had nothing to select and no way forward.
- **Four document types** (`b2ac1537`) — ID card, HawkSoft endo, Carrier endo,
  Cancellation. And the multi-file review sheet finally lets "Other" say what it is:
  it never had the text box the single-file path has, and its `DOCS.push` carried **no
  `doc_label` at all**, so a description would have been dropped anyway. Laura hit it.
  `ID CARD.pdf` was also being guessed `driver_license` — the licence rule matched any
  word "id". In insurance an ID card is the proof-of-insurance card; `id_card` now wins.
- **Unnumbered policies chargeable** (`558ac86f`) — see below.
- **Retro-linking down payments** (`2a0c9d4d`, `505b4987`, `42840261`) — see below.
- **Picker grouped by status** (`aa5970cc`) — see below.
- **`note_wrong_policy`** (`7af8e9ce`) — admin action, writes to BOTH tabs.

### A POLICY WITH NO NUMBER YET — 429 across 373 clients
Sammy, 23822: he created an ANCHOR GENERAL tab, the refresh **worked**, and the picker
hid it because it filtered on `policy_number`. A brand-new policy has none until the
carrier issues one — which is exactly the policy a down payment is taken against.

Explicitly **not** shipped as display-only: the charge resolves by matching the NUMBER,
so showing the option alone would have filed at client level while the agent believed
it went to the tab. **All THREE charge paths** — live, cash, pay link — now accept a
policy GUID. The anchor matched 3 times, which is the Sep 1 lesson working.

The GUID is **verified, not trusted**: well-formed uuid AND present in HawkSoft's own
policy list for that client. An id from a browser is a claim.

### CHARGE FIRST, POLICY AFTER — I had the model backwards
I proposed warning when a client has no policy. Saif: *"the whole idea of the charge is
that the agency charges before buying the policy."* The data agrees — **all 9 unlinked
charges are Down payments, nothing else.** It is the signature of new business, not an
error, and a warning would fire on every one.

So the receipt files at client level, permanently (no receipt-modify endpoint). What we
can do is make OUR record true when the policy arrives, and leave a note.

**Matching uses CLIENT AND TIMING, NOT AMOUNT** — Saif's correction, and the right one:
two down payments can be the same figure. Single New policy effective −3/+14 days of the
charge. All 9 real cases: **7 resolve to exactly one candidate, 0 ambiguous**, 2 had no
policy yet. One candidate or abstain.

**Three places, one per reader:** ledger says `linked retroactively by sync` (never plain
`linked`); an `events` row carries the EVIDENCE; a HawkSoft log note so an auditor can
follow the money.

> **Two mistakes on this, both mine, both caught by Saif asking "where?":**
> 1. I hung the linker off *clients the sync touched*. Every real case had its policy
>    synced days earlier, so the watermark had moved past them and it could never fire.
>    Now `sweepUnlinkedPayments` drives from **unlinked payments**.
> 2. All nine HawkSoft notes were **rejected** — I wrapped the body in an ARRAY;
>    `hawksoft.js` has posted a single OBJECT for months. I rewrote working code
>    instead of copying it. And a bare `catch {}` hid it, so the sync reported success.
>    **The same silent-catch mistake as loadRoster on Aug 30, in the same file.**
>    Now: status checked, `payment.note_failed` event, counts on the sync event.

### ⚠️ A RECEIPT ON THE WRONG POLICY — client 7941
Sammy took $191.88 of new business and it filed onto `CAN23006496-00`, an ONWARD policy
from 2023 that **expired March 2024**. The one he wanted was tab 6, ASPIRE, effective
that day. **Not a wiring fault** — the system filed exactly where he pointed it.

The picker was a flat list of six tabs: two 2020/2021 DMV records sharing a number, an
expired 2023 policy, a cancelled 2026 one, and today's policy at the bottom.

Now grouped **Active → New (no number yet) → DMV → Cancelled & expired**, newest tab
first, dead ones labelled on the line. **Above three tabs nothing is preselected** —
the field reads "Choose the policy… (6 tabs)". At or below three, unchanged: average is
1.8 tabs and 99% of clients have one or two.

`note_wrong_policy` writes to **both** tabs — the one holding the receipt says it does
not belong there, the one that should have it says where it sits. One note alone leaves
the other tab lying.

### Standing facts worth not relearning
- **A log note CAN carry `policyId` and land on the tab.** The bridge has done it for
  months. Saif pointed this out when I was about to probe a capability in daily use —
  the nine notes went to client level only because I dropped `policyId` from the resend.
- **HawkSoft cannot move a receipt or delete an attachment or a log note.** Every wrong
  file and every duplicate is permanent. This is why gates abstain rather than guess.

---

## SEP 3 EVENING — BACK, A NEW CLIENT, AND A TAGGED RESTORE POINT

### 🔖 RESTORE POINT — `working-2026-09-03` → `e54daf2b`
Tag **and** branch `backup/working-2026-09-03`, verified byte-for-byte against main
across all 9 tracked files. Everything below was working and tested at that commit.

```
git checkout working-2026-09-03          # inspect
git checkout -b fix backup/working-2026-09-03   # work from it
```

### Shipped
- **Back on carrier.html** (`39dcc3e6`, `cff1ba6a`, `1c01182d`, `2139f7e3`) — four
  commits for one button. See below; each miss was a layer deeper.
- **Create a walk-in client from the portal** (`9a579268`).
- **New charge helps instead of scolding; New client always visible** (`e54daf2b`).

### The Back button took FOUR attempts, and that is the lesson
| Attempt | Where it landed | Why |
|---|---|---|
| 1 | Portal home | I sent it to `portal.html` |
| 2 | Sign-in screen | portal never read the handoff; carrier DELETED the token on arrival |
| 3 | A charge sheet | `?client=N` is the **HawkLink launch** format and ARMS a charge |
| 4 | Office picker | the office was never persisted at all |

> **LESSON: trace the whole path the agent walks, once, before fixing any hop of it.**
> I fixed one hop at a time and shipped four times for one button.

Now: `?open=N` shows the card only; the session is handed back and verified for
expiry BEFORE the gate is hidden; the office is restored, but only on a handoff
return, only for a KNOWN staff member, and only for an office in the list. Sign-out
clears both, or the next person on a shared branch machine inherits them.

### ⚠️ THE X COULD NOT CLOSE A LAUNCH-OPENED CLIENT
`HL.client` is a **String**; every other caller passes a number; `closeTab` compares
with `!==`. So `"26081" !== 26081` was true for every row and nothing was ever
removed. **The named recurring bug** — a value transformed on one side and compared
against the untransformed other, same as the phone search and the full-name search.
`openClient` now normalises at the door.

### Creating a client already existed — I said it did not
Saif asked on Sep 2 whether we could add a client to HawkSoft. I said it was not
built. **It has been in `charge.html` for months** (`charge_create_client`). A grep
would have answered it. The real gap was that it lived only on the HawkSoft-launched
page, not in the portal where agents work.

Now offered beside the search box permanently — a walk-in is a known situation before
anyone searches, not something discovered by failing to find them. Reuses the same
action rather than adding a third implementation.

### ⛔ HAWKSOFT HAS ONLY FOUR OFFICES — the agency has five branches
```
0  speedy insurance agency (primary)
1  Moreno Valley
2  Riverside 1 — Van Buren
3  Riverside 2 — Magnolia
```
**Lake Elsinore and Colton do not exist in HawkSoft.** So the hard-coded `[1,2,3]`
was never stale — the AGENCY is ahead of HawkSoft by two branches. Any client created
at those branches is filed under the closest one, and office-based reporting is wrong
for them.

> **⏰ TONY: add Lake Elsinore and Colton in HawkSoft CMS → Setup → Offices.**
> Remind Saif every session until done.

> **🔑 ROTATE THE ADMIN KEY.** It appeared in a chat screenshot on Sep 3 and it reaches
> every HawkSoft write endpoint. The Clover App Secret is still outstanding too.

### Agreed with Saif, not yet built
- **Write a log from the portal to HawkSoft.** The strongest adoption lever raised so
  far — agents live in the logs, and if they can log a call from the client card the
  portal becomes where they work. **Open question: which channels to offer.** A phone
  call logged as a walk-in is a false record, and a HawkSoft log note cannot be edited
  or deleted, so it needs a confirm showing exactly what will be written and where.
- **Read logs on the client card.** We do not sync logs and there is no `logs` table,
  so this is a HawkSoft call per client and a busy client has hundreds of entries.
  **Fetch on demand behind a Logs section, never on card render** — performance is the
  first priority. **Open question: should every agent read every note?** Logs carry
  complaints, payment problems, personal circumstances.

---

## SEP 4 — AUDIT VISIBILITY, AND A BROKEN CALLS TAB I DID NOT FIX

### 🚩 START HERE NEXT SESSION
1. **CALLS TAB IS DOWN.** Diagnosed, not fixed. See below — the fix is a view rewrite.
2. **Carrier receipt ⇒ carrier cost becomes MANDATORY** (Saif's rule, agreed, not built).
3. Then: roles, the Agents panel, Tony's by-agent tab.

### ⛔ CALLS TAB — `call_sessions` takes 8.06 SECONDS, so the function times out
`EXPLAIN ANALYZE` on the exact query the Console runs:

```
Execution Time: 8057 ms
SubPlan 2 → 369 loops, each scanning all 35,742 rows of the `legs` CTE
Buffers: temp read = 2,153,712 blocks  (~16 GB of temp I/O for 369 result rows)
```

The view builds a CTE of **every** call leg, then re-scans that whole CTE **once per
session** for "who answered", "which office", "longest customer leg". Quadratic, so it
has been degrading as `call_log` grows (35,742 rows now) and has just crossed the
10-second function limit. Vercel then returns an HTML error page, `r.json()` throws,
and the page shows a generic failure.

**NOT caused by any recent change.** It has been getting slower for weeks.

**The fix:** push the date filter INTO the CTE so it builds a few thousand legs
instead of all of them — on "Today" that is ~400 rows rather than 35,742, making the
per-session re-scans ~90× smaller — and turn the correlated subqueries into aggregates
computed once. The view is 4,927 chars; its OUTPUT COLUMNS MUST NOT CHANGE.

> **I misdiagnosed this three times before measuring**: blamed my own audit_list
> change, then HTTP cache, then an expired session. Each was plausible, each was
> wrong. **A timeout-shaped failure — generic error, no server exception logged —
> should go straight to EXPLAIN ANALYZE.**

Two of the three changes made while chasing it are worth keeping and are shipped:
- **`/admin/*.html` is now `no-store`** (`e0097a21`). There is no service worker, so an
  app window left open was running whatever HTML it last fetched. That is also how an
  agent hits a bug fixed hours ago.
- **An expired sign-in now says so** (`2fc134f8`). `api()` had NO 401 handling, so a
  dead token rendered as each tab's generic error. Tokens last ~1 hour; the Console is
  left open far longer.

### Shipped — the audit is now honest about what is unfinished
- **`PT_DAY is not defined`** (`2f353148`) — the Pacific helpers were declared inside
  the transactions renderer while `renderAgentView` is a sibling top-level function, so
  the by-agent tab had NEVER worked. Found by measuring brace depth: the scope returns
  to 0 at line 853, between the use and the definition.
- **audit_list was 6 sequential queries** (`1ce34e63`, hotfix `75e80547`) — one of them
  against `audit_tasks`, an EMPTY table with no writer in either API, so `task` was
  always undefined. Now two parallel waves. The hotfix: I deleted the declaration and
  missed a SECOND use, taking the tab down. **Grep every use of a name before deleting
  it.**
- **A half-finished audit no longer reports success** (`5de08482`). Melisa left three
  audits at carrier_pending and pressed save THREE TIMES IN SEVEN SECONDS on client
  9014 — Submit was disabled because the carrier cost was missing, so the only button
  was *Save & finish later*, which replied **"✓ Saved as pending"**. A green tick on an
  unfinished audit. ~$45 of her commission unclaimed with nothing on screen saying why.
  Now names what is missing, in amber. **Green is reserved for an actual completion.**
- **Sort by what is missing** (`b462d842`, `09e40c40`, `3a77d2d8`) — three commits,
  because the first two got the definition wrong. Final: buckets use the SAME test as
  the badge — is there a carrier receipt (or a `*_no_payment` doc, which IS the proof
  on a fee-only charge)? `doc_count` counts ANY document and a client receipt is not
  proof, so rows showing "1 file · no receipt" were sorting into the carrier-cost
  bucket. Also: "+ proof" was a BUTTON, not a status, shown on every unfinished audit —
  it now says "+ carrier cost" when the receipt is already there. And blue meant "not
  green", which is not a meaning: a completed fee-only charge wore the same badge as an
  audit missing its receipt.

### Client 26371 — documents at client level, and it is NOT the upload code
Alejandra uploaded four documents at 10:46–10:58. The policy did not reach OUR database
until **11:03:33**. There was no policy row on the card, so no tab to file against.

**"+ Documents" on a policy row DOES file to that tab** — it passes `hs_policy_guid`
and `resolvePolicyGuid` takes it first. The gap is sync latency on brand-new business,
not the upload path.

**Candidate fix (not built):** when an agent opens a client whose card shows NO
policies at all, refresh from HawkSoft automatically. Zero policies means brand new or
stale, and one call fixes both.

### Data worth keeping
- Charge → completed audit: **median 17 minutes**, 78 of 160 within 15 min. But **47 of
  160 took over 4 hours and 33 took over 2 days** — so "waiting on the carrier" is a
  real workflow and a partial save must stay possible. That is why the rule is *receipt
  ⇒ cost mandatory*, not *cost always mandatory*.

---

## SEP 5 — CALLS TAB FIXED, AND SMS WORKS END TO END

### ✅ CALLS TAB FIXED — 8,057ms → 310ms
`call_sessions` re-scanned a materialised CTE of every call leg **once per session**
for `customer_number` and the `office_id` fallback: 369 loops over 35,742 rows,
**2,153,712 temp block reads** to produce 369 rows. Quadratic, so it degraded as
`call_log` grew and finally crossed the function limit. Vercel returned an HTML error
page, `r.json()` threw, and the tab showed a generic failure.

Those correlated subqueries are now aggregates in the `GROUP BY` that already existed,
and the CTE stopped carrying `raw_event`, `tasks`, `score`, `recording_url` and other
columns nothing reads. Temp reads: **2,153,712 → 1,974**.

> **ONE DELIBERATE BEHAVIOUR CHANGE.** The old fallbacks were an unordered `LIMIT 1` —
> arbitrary, and it could return a different answer on repeat runs. They now take the
> FIRST leg by `started_at`, which is where the call arrived. This changes the office
> on ~20 of 692 recent rows, **every one a call that rang at multiple offices** (one
> had offices 1, 2 and 3) and so had no correct answer before. The answering agent's
> office still wins whenever there is one.

### ✅ SMS WORKS — sent and received on a real phone (Sep 5)
`api/sms.js`. Auth, token cache and the 5-per-60s rate-limit hint are **copied from
rc-subscribe.js**, not rewritten.

- `action:capabilities` — lists every number and which report `SmsSender`
- `action:send` — 10-digit US number or refused; **every send writes `sms.sent` or
  `sms.failed`** to events with number, length, purpose and message id

**Proven Sep 5:** message id 3791309147023, Queued, and it arrived.

### ⛔ THE NUMBER PROBLEM — only a DirectNumber can text
```
+1 747 229 2938   sms:TRUE    DirectNumber        ← the only one
+1 951 695 1500   sms:false   MainCompanyNumber
+1 800 453 9616   sms:false   CompanyNumber
+1 866 744 0999   sms:false   CompanyNumber
+1 951 268 9900   sms:false   CompanyFaxNumber
+1 951 353 9900   sms:false   CompanyNumber (Liberty Express)
```
**A MainCompanyNumber cannot send SMS** — it routes into the auto-attendant, which is
a menu with no inbox for replies. There is no toggle; this is how RingCentral works.

So texts currently come from a **747 (Los Angeles) area code** while the branches are
951 and 909. A Riverside client is likely to read that as spam.

> **⏰ ASK RINGCENTRAL (Charmaine / Grace), two things in one message:**
> 1. A **951 direct number on a shared extension** as a dedicated texting line — the
>    clean answer, since replies need an inbox that is not one agent's.
> 2. **A2P 10DLC registration.** Business texting from a 10-digit number needs a brand
>    and campaign registered with the carriers. Unregistered traffic is accepted, comes
>    back "Queued", and is then silently dropped. Our test arrived, but that does not
>    prove registration — confirm it before agents use this with clients.

Swapping the number later is one env var: `RC_SMS_FROM`.

### ✅ CALL RECORDING — legal approved, agents signed (Saif, Sep 5)
Attorney review is DONE and the agents have signed.

> **STILL OPEN, and it is a different thing:** the agents signing covers the AGENTS.
> California all-party consent also covers the **CUSTOMER**. That is normally a
> recorded announcement at the start of the call, not a signature. Confirm that
> announcement exists before recordings are used for scoring.

### What agent scoring would actually need
`call_log` has `recording_id`, `transcript`, `summary` and `score` columns — **all four
are 0% populated across 36,966 legs.** Designed for and never wired. The reason is one
line in `rc-subscribe.js`:

```js
const EVENT_FILTERS = ['/restapi/v1.0/account/~/telephony/sessions'];
```

Call state only. No recordings, no messages.

**Available today with no new plumbing:** answer rate, talk time, missed calls,
transfers, rang-but-colleague-took-it — 8,027 answered agent legs across 18 agents
since Aug 7.

**Needs work:** anything based on what was *said* — recording scope, a fetch step,
transcription, and a scoring rubric that Tony defines. Do not start this before the
customer-announcement question above is settled.

---

## AGREED, DESIGNED, NOT YET BUILT (Aug 29)
In this order, after the Blob store exists:
1. **Upload documents from the policy row** — `add_document` in `carrier.js`
   already does 90% of it (takes a policy, resolves server-side, sends `PolicyId`
   so it lands on the policy tab). **One change needed:** it auto-attaches a
   `payment_id` when the client has exactly one open payment — right for the audit
   flow, wrong here, it would staple an ID card to an unrelated payment. Needs an
   explicit no-payment flag.
2. **Charge that exact policy from the policy row** — `renderPolicyPicker(keepValue)`
   already accepts a preselect; `openCharge` needs one more argument. ~10 lines.
3. **"Payments needing proof (help)" list on the dashboard**, under the bell.
   48 open audits across 5 agents right now — a real list, not a wall.
4. **Open `save_carrier_leg` to helpers.** Now defensible because
   `audit_completed_by` is recorded and the owner is notified.
   ⚠️ **This changes who can affect another agent's commission — Tony should be
   told.**

**Visibility rule agreed with Saif:** every agent sees everything EXCEPT commission;
commission shows only to the agent who earns it. Half-implemented — `portal_home`
is correct, but `portal_client` still returns `fee_amount`, `service_cost` and
`commission_to` on every payment to whoever is looking. **Must be stripped
server-side, not hidden in the browser.** Open question: is the FEE sensitive, or
only the commission? Keep the owner's NAME visible — the "not mine, change" flow
needs it.

**Also agreed:** agent can click their earnings and see the lines behind it —
charge, carrier receipt, commission, client id, carrier name. `portal_home` already
computes per-row; it just does not return the rows. No new query.

### Unmatched documents — smaller than it looked
Saif proposed a HawkSoft-style unmatched queue. After the vault fix it is **28 rows,
not 171**, and should stay near zero. **Wait a week and see what accumulates before
building UI.** Hard limit if we do: HawkSoft has no attachment-modify endpoint, so
matching an already-filed document fixes OUR record only — the HawkSoft copy stays
at client level forever unless re-uploaded, which duplicates it.

### Multi-document upload before submit ALREADY EXISTS
`carrier.html` takes `<input multiple>` plus drag-and-drop and opens a review sheet
— "N files — what is each one?" — with per-file types, `guessType()` from the
filename, a set-all control and client-side downscaling. If agents are not using it
that is discoverability, not a missing feature. **One real seam:** dropping several
files on the CARRIER RECEIPT slot silently keeps only the first
(`carrier.html:411`); the review sheet only opens from the Documents zone.

---

## AUG 28 — THE CLIENT SEARCH HAS NEVER FOUND ANYONE BY PHONE

**Reported by Saif:** an agent searched a phone number that exists in HawkSoft and got nothing.

**It is not intermittent and it is not the agent. Phone search with an area code has never worked for anybody.**

### The mechanism
Phones are stored as **`(AAA)BBB-CCCC`** — 25,197 of 25,216 rows, no space after the paren. `portal_search` in `api/platform.js` builds its pattern with:

```js
const like = `*${q.replace(/[,()*]/g, '')}*`;
```

It **strips parentheses from the QUERY but not from the DATA**. So `(951)472-0927` becomes `951472-0927`, which cannot occur inside `(951)472-0927`. Same for `9514720927` and `951-472-0927`. Only a fragment without the area code — `472-0927` — ever matched, which is exactly why it looked random.

**Measured on 500 real rows:**

| Approach | Hits |
|---|---|
| Current code, full number typed | **0 / 500** |
| Rebuild `(AAA)BBB-CCCC` from digits | 499 / 499 |
| Last seven digits as `BBB-CCCC` | 499 / 499 |

### The fix (written and tested Aug 28, NOT deployed)
Replace the single `` `phone.ilike.${like}` `` term in the `ors` array. Keep name/email/client_no untouched:

```js
      const dg = q.replace(/\D/g, '');
      if (dg.length >= 7) {
        const t = dg.length > 10 ? dg.slice(-10) : dg;
        ors.push(`phone.ilike.*${t.slice(-7, -4)}-${t.slice(-4)}*`);
      } else {
        ors.push(`phone.ilike.${like}`);
      }
```

**Why the last-seven form and not the full number:** rebuilding `(AAA)BBB-CCCC` also scores 499/499, but it puts literal parentheses inside a PostgREST `or=()` filter, which needs value double-quoting (same quirk as `in.()`). The paren-free form needs no quoting and carries no syntax risk. Short queries (<7 digits) keep the old behaviour.

**Verified:** `node --check` passes; the patched expression was extracted **from the file** and run against 7 realistic input formats — `(951)472-0927`, `9514720927`, `951-472-0927`, `951 472 0927`, `+1 951 472 0927`, `472-0927`, `4720927` — all 7 match.

**Trade-off accepted:** a seven-digit search can now return clients in another area code with the same local number. Results show phone and branch and are capped at 25, so the agent picks. Zero results was the worse failure.

### Second finding: `client_phone_index` exists and search never reads it
23,979 rows, normalised `phone10` column, plus `client_number`, `display_name`, `office_id`, `contact_type`. Read by `screenpop.js` and `rc-webhook.js` for caller ID — **never by portal search**. 42 numbers are findable only through it. Every row is `contact_type: 'primary'`, one number per client, so a client's **cell** number may not be searchable at all if HawkSoft holds it separately. That is the deeper version of this bug.

### Data quality, separate from the code
About **ten client records have an email address in the phone field**. A few have 9, 13 or 14 digits. HawkSoft data entry, not a bug in ours.

---

## AUG 28 — CLOVER: THE TERMINAL HAS NEVER RUN

Full detail, all IDs and the step order live in **`Speedy_Workspace_Setup.md`**. Summary:

**Three independent checks agree that a terminal charge has never succeeded:** `clover_tokens` is empty (zero rows), `events` has zero terminal rows, `bridge_ledger` has zero terminal charges. `getCloverToken()` has no fallback — no OAuth row means it errors before calling Clover.

**What was tested previously was the ecommerce CARD path** (39 real charges), not the terminal path. Both live on the same page, which is how they were conflated.

**The code is complete; the configuration is not.** `charge.html` has SEND TO TERMINAL; `api/hawksoft.js` has `terminal_config` and `terminal_charge` with REST Pay Display, safety net, decline handling, receipt and HawkSoft filing. `portal.html:1334` still shows a disabled "Terminal — soon" — the **portal** lacks it, the charge page does not.

**⚠️ Van Buren's terminal will never work.** The app's own type reads *Semi-Integrated — Android (Flex 2nd Gen, Flex 3rd Gen, Flex 4th Gen), REST Clients*. **Gen 1 is not on the list**, and Van Buren's `C042UQ93960695` is a Gen 1 Flex. Not an inference from the EOAU date any more — it is the app's supported-device list. **Van Buren needs a replacement terminal. Tony's spend decision.**

**Four branch merchants, four separate OAuth runs needed** — even the day approval lands, terminal stays dead until `/api/clover_oauth` runs for each.

**Sandbox is the way out of the chicken-and-egg** (Clover wants a video of a working integration; the integration can't work until the app is installed). Test merchant `P3CNFM3N9Z871` already exists. No Dev Kit on the account. **The base URLs are hardcoded to production and must be made env-aware first** — and every Site URL change triggers a Clover review, so the order matters.

**Email sent Aug 28** to `developer-relations@devrel.clover.com`: confirm Gen 1 unsupported · does an emulator sandbox recording satisfy functional review or is a Dev Kit needed · is the video what's holding the review.

---

## AUG 27–28 — GOOGLE BUSINESS PROFILE

Full detail in `Speedy_Workspace_Setup.md`. Summary:

**Google holds SIX verified profiles for FIVE branches.** The sixth is **Golden Square Insurance** at the old Lake Elsinore address — verified and live, splitting reviews and ranking. **Parked by Saif to Fri Sept 4** (`trig_01Jakrpg4EQLnoTpzcayC1H1`). Close or merge; **never delete**, or its reviews go too.

**Colton was never missing from Google** — claimed, verified, taking five-star reviews. It was missing from `gbp.html` and `posts.json`. Fixed Aug 27.

**Twelve unanswered 5-star reviews replied to Aug 27.** A **weekly task** now runs Mondays 10am PT (`trig_01SpeYWep68T7gyJPL6ZGBq4`), 25 replies per run, positives only. ⚠️ **Its prompt still says Van Buren is 2955** — editing a device-bound task needs a device proof; delete and recreate to fix.

⚠️ **An older reply automation exists that is NOT on this account.** It replied to dozens of reviews ~Aug 22. Likely a Cowork desktop-local task. **Find it or the two collide.**

**The post cadence has never run** — `posts_log.json` is `"published": []`; only one post ever published (Jul 10). The "4/4 posts live this week" KPI was fabricated by the page; corrected Aug 27.

**Moreno Valley's Sunday hours are correct** — checked live Aug 28, Google shows Sunday 10–5. The July "Sunday: Closed" screenshot is stale.

### ⚠️ ESCALATED TO TONY
**Four reviewers across 2019–2025 allege the agency pays for reviews** (Starbucks gift cards ×2, "offered a discount", "fake accounts"). Breaches Google's review policy; a four-witness pattern is what gets reviews stripped. **No replies posted.** Business decision, not a template.

### What the negatives say
All unanswered negatives are older than six months, so per Saif's rule they are left alone. **Nobody answers the phone** — five reviewers; the RingCentral review measured **1,062 missed calls in April, an 18% miss rate**. Same problem, two views. Also: the old "open 24 hours" hours bug reached customers; leaflets on cars are generating 1-stars at two branches.

**Saif's reply rule (Aug 27):** reply to positives; negatives older than six months are ignored; anything more recent gets asked about first.

---

## AUG 25 — THE RECEIPT LINK AND THE TIMEZONE

### 1. Client receipts were losing their `payment_id` (commit `7d79b95d`)
Since **Aug 17**, 67% of client receipts were written with `payment_id` NULL — 28 orphans. The PATCH branch assigned a **boolean**:

```js
auditSaved = pr.status === 200 || pr.status === 204;
```

and the next block needs an object: `if (auditSaved && auditSaved.id && …)`. `true.id` is `undefined`, so the link silently never ran. **No error, no log, eight days.** Cash was never affected — it calls `audit()` directly and always gets a real row. That is the 67/33 split.

**Fix:** `auditSaved = (…) ? { id: safetyLedgerId } : false;` at both sites (card ~995, terminal ~1385). We already HOLD the id being patched, so there is no lookup and no matching.

**Verified** 7/7 including a case running the OLD expression and confirming it did not link. **Backfill of 28 rows done** — matched on client number, the amount parsed from the FILENAME, and a <3s gap; declined kinds excluded. Post-write: **0 orphans, 0 double-linked, 0 amount mismatches, 0 client mismatches** across 78 receipts. The 28 already filed into HawkSoft stay at client level — no modify endpoint.

### 2. The Console ran on UTC while the agency runs on Pacific (commit `765d5925`, v6.0)
`inPeriod` built both sides with `toISOString()`, always UTC. From 5pm PT the UTC day had rolled over, so the Audit tab went blank **for the last two hours of the business day and all evening, every day.** Offices are open until 7pm.

**Fix:** one `PT_TZ = 'America/Los_Angeles'` constant plus `PT_DAY`/`PT_STAMP`/`PT_TODAY`/`PT_DAY_MINUS`, declared **above** `inPeriod`. Named explicitly, not browser-local. `en-CA` yields `YYYY-MM-DD` so string comparisons are unchanged. `Intl` handles DST. Yesterday steps a **calendar date**, not `−86400000ms`. Display sites moved to Pacific too. **Verified 16/16** with the clock pinned to `01:12Z`.

**Still open:** `platform.html` ~439 and ~578 use a UTC `today` for policy expiry — a policy flips to expired seven hours early.

---

## AGENT TICKET FORM — RESOLVED AUG 24/25
`speedy-dashboard` is SSO-gated, so every Submit-a-Ticket link 302'd and **no agent could file in either language.** Copied to the public `speedy-website`; it could not be a straight copy because it held a machine-readable **name → email → extension map for all 13 staff** and the repo is public. It also could not simply be gated — *Login / Password* is a ticket category, so a locked-out agent must still be able to file.

Shipped at `speedyins.com/admin/ticket.html` (v1.1): `AGENTS` map and `autoFill()` deleted, extension field removed, names-only dropdown (**so this copy cannot drift about where anyone works**), branch list corrected, back-link repointed to the Hub. Staged deliberately — website first, real Formspree test, then the four Hub refs.

**The old copy in `speedy-dashboard` was deleted Aug 27, commit `b00c3ba`.** Note git history still contains it; making the repo private is the real remedy.

---

## THE DASHBOARD WAS DEAD FOR A WEEK (fixed Aug 25)
404 on every path. **An empty deploy was promoted to production on Aug 17** carrying **no git metadata**, 86 minutes after a real commit. The pattern appears twice, so it is not a one-off. **The SSO gate hid it** — every attempt bounced to login and nobody saw the 404 underneath.

Fixed by promoting the Aug 17 commit deploy (`5c540afa`), after verifying GitHub `main` HEAD is the same commit. ⚠️ **Promoting re-applied the project's protection default**, so Vercel Authentication turned itself back on.

**Aug 28 candidate for the cause:** the Vercel MCP `deploy_to_vercel` tool does exactly this — raw file tree, no git metadata. **Never use it on these projects.**

---

## SECURITY POSTURE — AUDITED AUG 25
**Verified clean:** all three repos scanned for API keys, tokens, service-role keys and Clover secrets. Secrets-in-Vercel-env-only has held.

**All three repos are PUBLIC**, and that is the exposure. `portal.html` / `charge.html` carry 14 staff emails each, `platform.html` 12. `speedy-dashboard` also exposes the cost table and revenue figures with no credentials.

**Priority:** ~~delete `ticket.html`~~ **DONE Aug 27** · **make `speedy-dashboard` private** (free; but the weekly GBP task pulls 34 graphics from `raw.githubusercontent.com` and will break — **token the task first**) · **`api/hawksoft.js` allowlist** (the money API uses only a `@speedyins.com` domain gate while `carrier.js` and `platform.js` carry explicit arrays) · regenerate RingCentral and Clover secrets.

**Vercel password protection is $150/mo** — nearly double the entire fixed cost. Rejected. Vercel Authentication is free and stronger. **A client-side gate on a static page is theatre** — the HTML is served before any JS runs.

---

## THE WEBSITE
**The chat widget says "closed" during business hours — not a code bug.** The site carries correct hours; the Tawk scheduler is correct (Pacific, Sunday 10–5). **By elimination it is agent availability** — the 25% missed-chat problem from the July desktop rollout. **The review evidence agrees: five reviewers say nobody answers the phone either.**

**Still to fix in Tawk:** the offline message says `Sat 9am-5pm` (should be 10am), runs words together, never mentions Sunday. **Domain Restriction is disabled** and the widget ID sits in a public repo — anyone could paste it on their own site and Speedy agents would answer their visitors.

**Dead code removed (`4a5ac668`):** an orphaned `submitQuoteToChat()` claiming Tawk wiring that actually built an `sms:` link. Also corrected 5 strings per file still claiming 4 locations — the blog was telling a Colton customer that DMV service runs at "all four branches."

**Open:** `es.html` blog articles are still in **English**, plus a mixed heading *Same-Day Service at All 5 Sucursales*.

---

## THE MERGE — charge.html into the portal (Stage 0 DONE Aug 20)
**Parallel run, not a deletion.** Stage 1 next: `charge_create_client` first, then Terminal. Stage 2 repoints Sammy only for two weeks. Stage 3 repoints the rest.

**Why BOTH buttons stay:** no way to charge someone not yet in HawkSoft, and Terminal renders disabled. Agents are told: *use PORTAL normally; go back to the CHARGE globe for terminal payments and for anyone not in HawkSoft yet.*

### HawkSoft External Tools — facts learned by testing, not docs
- **CMS appends its own `?`.** Arguments must NOT start with one.
- **`$(CustID)` is ZERO-PADDED.** 26081 arrives as `00026081`; stripped once in `readLaunch()`.
- **`$(PolicyNumber)` is EMPTY on a client-level launch.**
- Resolves to `www.speedyins.com`, not the apex.

**Only three macros are used, deliberately** — first name, email, cell and address all work and would put client PII into the URL, browser history and server logs on a shared branch machine. **`$(Carrier)` is deliberately unused** — HawkSoft emits `ANCHOR DIAMOND`, a program, not a carrier.

**PORTAL button Arguments:** `client=$(CustID)&policy=$(PolicyNumber)&last=$(LastName)`
**CHARGE button Arguments: empty** — `charge.html` reads zero URL params and needs the HawkLink field mapping per machine. **PORTAL needs no mapping.**

**Who has what:** Saif (both) · Jorge (both) · Alejandra (charging actively) · Sammy and Jesus still CHARGE-only.

---

## PAYMENT / CHARGE SYSTEM — LIVE
- Charge page **v2.37** · 6 purposes, 6 methods
- **SAFETY NET (locked):** every card/terminal charge writes `charge_captured` the INSTANT Clover confirms, BEFORE receipt/HawkSoft
- **ONE shared receipt engine** serves card, cash, terminal, pay link
- **`parseMoney()`** — `parseFloat("1,602.40")` returned **1**
- The receipt links to its ledger row by `linkReceiptToPayment(out.vault.id, auditSaved.id)`. **`auditSaved` must be a ROW, never a boolean.**

## AGENT PORTAL — v3.0 LIVE
Sign-in, office lock, client search, multi-client tabs, policy detail, charging inside the portal (sheet lives OUTSIDE `#clientPanel` so tab switching never unmounts the Clover iframes), unfinished-payment list, commission ownership/sharing/correction/notifications.

- **v2.0** `onAuthExpired()` is the single 401 handler. Reads retry; **writes are NEVER retried automatically**
- **v2.1** update detection — OFFERS a reload, never takes one
- **v2.5** fixed the picker vanishing on launch (cold-cache race): `openCharge` now awaits `loadClient` when the cache is empty
- **v2.6** DMV records restored to the picker — a DMV charge could never be scoped to its DMV record
- **v2.7** HawkSoft tab numbers; **v2.8** fixed the v2.7 temporal-dead-zone regression
- **v3.0** `+ Add more documents`; uploader name on every chip

**The office auto-lock** applies the agent's home branch with no picker, which made the staff directory load-bearing. Escape hatch is a `prompt()` box — ugly, deliberately small on a money page.

---

## DOCUMENTS FILED AT CLIENT LEVEL — FIXED AUG 24 (`c6225e2a`)
Charge rows read Pol 1; every receipt row read **Pol 0**. **0 of 107 attachments had ever carried a policy; 47 were already in HawkSoft at client level.**

The charge path resolves the policy server-side; the **document path trusted the PAGE** — `charge.html:435` read `c.policyGuid || c.policyId`, **neither of which is written anywhere in charge.html.**

**Fix — stop trusting the browser.** `resolvePolicyGuid()` in `api/carrier.js`: GUID from the page → ledger row by `payment_id` → `policies` by client + number → **only on exactly ONE match**. Two matches returns null; filing on the wrong policy is worse than client level. **Fail-soft by construction.**

**Documents-only mode** is open to ANY agent — adding paperwork is follow-up finishing, not a money change, and every chip names its uploader. **No time limit**; carriers ask months later.

**The 72-hour rule is NOT a commission gate.** If Tony wants it to gate money that is a **new rule and his call.** Claude's recommendation on record: don't — it punishes the exact behaviour we want.

---

## CLIENT SYNC
Portal search reads the **Supabase `clients` table**, not HawkSoft. **HawkSoft has NO webhooks** — polling only. Cron runs `0 9 * * *` UTC = **2am Pacific**; 40–100 clients change per day. `portal_refresh_clients` is the agent-callable escape hatch — cooldown lives in the **database, not memory** (Vercel runs many instances). HawkSoft only exposes a client once the file has been **SAVED in CMS**.

## CARRIER PAID
**`carrier_directory` view** groups the 178 carriers in Postgres (~5 KB; counting in JS would have pulled 46,000 rows per page load). Program is **shown read-only**, never asked for. "Other" stays on the payment and does NOT join the list. **CONFIRMED BY TONY: `ANCHOR DIAMOND` is a PROGRAM under `ANCHOR GENERAL`.**

## POLICY NUMBERS
**`POLICY_NUM_MAX = 60`**, replacing eight hardcoded `slice(0, 25)` calls — five policies are exactly 25 characters. **HawkSoft has no receipt-modify endpoint, so a sent receipt cannot be corrected.** That is why the preview exists.

## PLATFORM CONSOLE — v6.0
Audit tab, document viewer, by-agent grouping. **All dates `America/Los_Angeles`.** **Health tab — 12 checks**, each drawn from a bug that reached production. Check 9 (test charge counted as real money) deliberately does NOT filter `is_test`. **Candidate #13:** `client_receipt` with `payment_id` NULL.

## PWA / AUTH
Service worker rules locked: `/api/` **never** cached, only `portal.html` handled network-first. **There is no session** — the Google ID token IS the session, one hour, in one JS variable. **Page refresh signs you out. Branch machines are shared — do not "fix" this.**

## CONFIRMATION EMAILS
`GMAIL_USER` = `info@speedyins.com` via nodemailer. **Changing that account's password revokes the app password.** It failed silently for a day while receipts, PDFs and logs all reported OK.

## RINGCENTRAL → HAWKSOFT CALL LOGGING — LIVE
**UNBLOCKED Aug 2026.** The attorney cleared recording under **CA Penal Code 632** with an **automated announcement at the start of every call** — continuing the call is consent. **The columns stay empty until the announcement is live and verified.**

**Before go-live:**
1. **Every route needs it** — direct extensions, each IVR branch, after-hours, transfers, and outbound. Any path without the notice cannot lawfully be recorded, and the flag cannot tell the difference.
2. **Bilingual.** A large share of callers are Spanish-speaking; an English-only notice arguably gives no notice to the person 632 protects.
3. **Retention and access decided up front** — how long, who can play them, CCPA deletion. Recordings carry payment and personal data.

Context: **1,062 missed calls in April, 18% miss rate.** Five Google reviewers say nobody answers.

## TURBORATER — DEPLOYED
Q-182382, $145/mo. **Auto-renews on 60-day notice — remind April 2027.** ITC is now **Zywave**; ask for the **Personal Lines Quoting API** by name. No public docs or keys — the account rep is the only route. **Possible shortcut:** Zywave's integration page says raters exchange **AL3 / TT2** files and our `.tt2x` generator already exists — that path may need no approval at all.

## INFRASTRUCTURE
Vercel PRO ($20/mo), team slug `speedyinsadmin-8075s-projects` · Supabase Pro ($25/mo), `huvpitgappdqgavrqbud` · repos `speedy-website`, `speedy-dashboard`, `speedy-hub` — **all PUBLIC** · 13 of 100 functions.

---

## CARRIER PAID $0.00 — BUILT AUG 21 (`15000eb0`)
An **endorsement can cost the agency nothing.** The form refused zero, so Jesus typed `0.01` and the fee came out a penny wrong. **It was FOUR gates, not one** — `> 0`, a falsy-`0` ternary that blanked the fee at exactly the moment it equalled the whole charge, `Number(...)||null` turning a confirmed `0.00` into NULL, and a required card field when nothing was paid.

Shipped: `#zeroAck` shown only on an exact `0`, **no purpose gate**, "Not applicable" payment method, `carrier_zero_ack` + events row, doc slot relabelled from the purpose. **Longest label 35 chars — HawkSoft `Desc` caps at 41.**

**Rows cleaned:** 23127 (`0.01`→`0.00`, fee 189.87→189.88) · 1979 (a $1.00 test on a real client, `is_test` false, counting as real revenue with commission since Aug 4).

---

## THE RECURRING BUG (name it, watch for it)
**A value that exists and is thrown away, read from the wrong place, or transformed on one side only.**
- `audit_status` defaulted to `client_paid` — declines inherited "money received" (13 rows)
- `is_test` defaulted to false and was written by NO code (15 rows)
- `policyLink` written on one path and not the others
- `policyCarrier` / `policyProgram` resolved at charge time and thrown away
- `charge_lookup` returned everything about the policy except the GUID
- `$(PolicyNumber)` arrived in the launch URL and was ignored
- `#carrier` vs `effCarrier()` — payload correct, gate reading the demoted element
- `commission_to` absent from the safety-net insert
- `policy_number` missing from the `portal_client` payments select
- `carrier_extras.policyIndex` unused since sync began
- `policy_guid` sent by the portal on every charge and **never read**
- `carrier_amount` `||null` — a confirmed `0.00` written as NULL
- `is_test` false on a $1.00 test charge, real revenue for 17 days
- `c.policyGuid` — read in ONE place, written in NONE. **0 of 107 documents** ever carried a policy
- `uploaded_by` on every attachment row, never in the portal select
- `extra.office` — 2 of 79 real rows, **0 of 39 card charges**
- `payment_id` — written on cash, silently dropped on card and terminal. 28 receipts, eight days
- `posts_log.json` — the GBP task's record of what it published. **Empty array**, and `gbp.html` reported "4/4 posts live" without reading it
- **`portal_search` stripped `( )` from the QUERY but not from the DATA — phone search returned 0/500 on real rows and had never worked with an area code (Aug 28)**
- **`client_phone_index` — 23,979 normalised rows, read by caller-ID, never by the search that needed it (Aug 28)**
- **Full-name search asked each column for the WHOLE phrase — names are stored split, so 25,615 of 25,629 people were unfindable by "First Last" and all 25,629 by "Last First" (Aug 29)**
- **`storeReceiptVault` took `policyGuid` as a parameter and never wrote it — 0 of 49 client receipts carried a policy while carrier receipts carried 38 of 46 (Aug 29)**
- **`filed_hawksoft` — `fileReceiptPdf` posts to HawkSoft BEFORE the vault write and holds the outcome; the flag read false on all 49 rows anyway (Aug 29)**
- **`audit_completed_by` — column on the ledger since it was built. 73 completions, 1 row, ZERO writers anywhere (Aug 29)**
- **RefId — generated inline on every HawkSoft call and discarded. 99 charges, none stored, and it is an ENFORCED unique key (Aug 29)**
- **`charged_by` display name compared against an email local part to decide ownership — 2 of 17 agents got no button on their own payment; the other 15 passed by coincidence (Aug 29)**
- **`blob_url` — read path prefers it, no store ever existed, so all 212 files sit as base64 in Postgres (Aug 29)**

**Rule: when you add a column or accept a new input, confirm something writes it AND something reads it before shipping. When you transform a query, confirm the data was transformed the same way.**

---

## DATABASE SECURITY (Aug 18)
**Only ONE table was actually exposed: `agent_prefs`** (three columns, zero rows), fixed with RLS. **Still open:** `system_health()` is SECURITY DEFINER and `anon`-callable · `call_sessions` view is SECURITY DEFINER · two functions have mutable search_path.

---

## RECURRING COSTS
| Service | $/mo |
|---|---|
| Vercel Pro | $20 |
| Supabase Pro | $25 |
| TurboRater for Websites | $145 |
| Anthropic API | usage (UPDATE MONTHLY) |
**Fixed: $190/mo + Anthropic usage.**

---

## OPEN ITEMS
1. ~~Deploy the phone-search fix~~ **DONE Aug 29** — and full-name search too
2. **Portal open invoices** — DevTools check at the top of this file
3. **Portal branded email** — charge page sends it, portal does not
4. **Saif's browser checks** — the Aug 24 document fix, and finishing `Pol 1`
5. **Make `speedy-dashboard` private** — token the GBP task's raw GitHub URLs first
6. **`api/hawksoft.js` allowlist** — money API on a domain gate only
7. **Merge Stage 1** — `charge_create_client`, then Terminal
8. **GUID matching on the CHARGE path** — the portal sends `policy_guid` and the server ignores it, re-deriving by string match in **FOUR** copies. 16810's duplicate `4CQF020` is still ambiguous
9. **Policy-expiry dates still UTC** — `platform.html` ~439 and ~578
10. **Sweep for other `return=minimal` + `.id` pairs**
11. **`extra.office` written on almost nothing** — 0 of 39 card charges
12. **`select=*` on policies** — 551 MB across the book vs 200 MB trimmed
13. **`service_path` NULL on all ledger rows** — written by nothing, read by nothing
14. **Carrier alias grouping** — a client sees `ANCHOR DIAMOND`, a program, as the carrier
15. Normalise the 13 stray `carrier_name` rows
16. Malcolm follow-up commit — name, branch, producer code
17. **Tawk:** offline message (Sat 10am, spacing, no Sunday) + enable Domain Restriction
18. **Tawk agent coverage** — nobody online at 6pm. Habit, not settings
19. **Clover DevRel** — emailed Aug 28, awaiting reply
20. **Find what runs `vercel deploy` from an empty folder** — likely the Vercel MCP `deploy_to_vercel` tool. Never use it here
21. `es.html` blog articles are in English
22. **Shared stylesheet + staff directory** — `STAFF` duplicated across SIX files and drifting. Aug 29 proved the cost: adding one agent meant six edits, and two later commits reverted two of them without a conflict
58. ~~Create the blob store~~ **DONE** — private Supabase bucket `client-documents`, all 216 documents migrated, 0 orphans
67. **Earnings breakdown needs more detail and a search** — Saif, Aug 29: show the charge and the payment alongside the commission, and make the list searchable/filterable. Currently one flat list of up to 60 lines
68. **⚠️ NOTIFICATIONS STILL NOT SHOWING IN THE PORTAL** — events fire correctly (3 `audit.completed_by_other` rows for sammy@, unread count right, filter and render branch both live), and v3.8 added polling, but Saif reports the bell still does not appear. **NOT diagnosed. First thing tomorrow.** Check: does `#newsBell` unhide, is `loadNews()` returning items, is the agent's browser on v3.9
69. ~~Run receipt_tender_probe~~ **DONE Sep 1 — the finding it was chasing was wrong. Bridge receipts tender correctly**
69c. ~~Unnumbered policies~~ **DONE Sep 2** (`558ac86f`)
69h. **7941's $191.88 sits on an expired 2023 policy** — permanent. Note written to both tabs
69i. ~~Back button on carrier.html~~ **DONE Sep 3** — four attempts, see above
69k. **⏰ TONY: add Lake Elsinore and Colton as HawkSoft offices** (Setup → Offices). Until then those clients file under the closest branch
69l. **🔑 Rotate the admin key** — exposed in a Sep 3 screenshot. Clover App Secret still outstanding too
69o. ~~Calls tab down~~ **FIXED Sep 5** — 8,057ms → 310ms
69r. **⏰ ASK RINGCENTRAL: a 951 direct number for SMS, and A2P 10DLC registration.** Texts currently come from a 747 LA number
69s. **Customer-side recording consent** — agents signed, but all-party consent covers the customer too. Confirm the call announcement exists
69t. **Receive SMS** — add `/restapi/v1.0/account/~/extension/~/message-store` to EVENT_FILTERS; the webhook already exists
69u. **Agent scoring on call metrics** — answer rate, talk time, transfers. Available today, no new plumbing
69p. **Carrier receipt ⇒ carrier cost mandatory** — Saif's rule. Prevents the state instead of chasing it
69q. **Auto-refresh a client with zero policies** — would have put the tab on screen before Alejandra uploaded
69m. **Write a log from the portal to HawkSoft** — biggest adoption lever. Needs a channel decision
69n. **Read logs on the client card** — on demand only, never on render. Needs a visibility decision

69d. **Roles: agent/admin/owner**, then the Agents panel in the Console
69e. **Tony's by-agent commission tab**
69f. **Jorge's 25185 ($351.26)** still needs its carrier cost — never had one
69g. **15 duplicate carrier receipts in HawkSoft** from the Sep 1 outage. No delete endpoint; permanent
69b. **⛔ DUPLICATE RECEIPTS — agents re-key what the bridge already posted.** Esmeralda confirmed. Ask her what she sees after a charge before building anything
70. **Finish the roster table** — `public.agents` is seeded and verified; nothing reads it. See the retry rules above
71. **Earnings breakdown needs more detail + search** — Saif, Aug 31: show the charge and the payment beside the commission, make it searchable
72. **Light mode is portal.html only** — charge.html, carrier.html, platform.html still dark
73. **Reverse the ZZTEST probe receipts** — 1.11 / 1.22 / 1.33 / 1.44, posted twice on Sep 1
74. **In a month: drop `file_b64`** once `portal_doc` shows `served: "storage"`. Reclaims 28 MB from Postgres
59. **`portal_client` leaks money to every agent** — `fee_amount`, `service_cost`, `commission_to` are returned to whoever opens the client. Agreed rule: everyone sees everything EXCEPT commission. Must be stripped SERVER-side
60. **Merge the redundant third HawkSoft log row** — each charge posts receipt + attachment + a text-only summary. Mocked up, parked by Saif
61. **Malcolm's home branch still unknown** — deliberately no `STAFF` entry, so he gets the visible branch picker. Do NOT infer it from `call_log.office_id`; that was wrong for Melisa
62. **Melisa's RingCentral extension sits in the Van Buren office group** — she works Moreno Valley. Cosmetic until the call-log by-agent view is built, then it misattributes her calls
63. **`carrier.html:411` silently drops files** — several files dropped on the carrier-receipt slot keep only the first
64. **28 unmatched documents** — wait a week before building a matching queue; the number should stay near zero now
65. **Agent earnings drill-down** — `portal_home` already computes per-row, it just does not return the rows
66. **Producer codes for departed staff** — NRR (2,326 clients), TTD, LSN and others deliberately unmapped. Do not "fix" this
23. Ask Sammy and Jesus what else looked stuck
24. `hlChangeOffice()` is a `prompt()` box
25. Raise the sync cron cadence once the refresh button shows demand
26. Portal light theme — approved, not built
27. Partial payments — designed, not built
28. Vercel Blob — `blob_url` null on every attachment
29. ~~Attorney, CA Penal Code 632~~ **DONE** — announcement required, three go-live conditions above
30. Regenerate RingCentral + Clover secrets
31. **72h as a commission gate** — Tony's call. Claude recommends no
32. TurboRater premium-return blocker — raise with the API request
33. IVANS: Brian Marable re AL3 / Speedy as sender
34. Website backlog: Tawk routing, SEO, GA/GSC, reviews, legal/SMS opt-in
35. Wix Ascend + Premium Core cancellations still pending
36. Supabase leftovers from the Aug 18 alert
37. **Search `client_phone_index` too** — a client's cell may be unsearchable today
38. **~10 clients have an email address in the phone field** — HawkSoft data entry
39. **Golden Square duplicate** — parked to Sept 4, close or merge, never delete
40. **Lake Elsinore listing reads "Mission Trial"** — should be Trail
41. **One business name** — Van Buren is "Speedy Insurance", four others "…Agency"
42. **Store codes missing** on MV, Magnolia, Lake Elsinore
43. **Magnolia points at `cheapinsuranceriverside.com`** — SEO or drift?
44. Service areas flagged broad — MV and Lake Elsinore
45. Branch photos — only MV refreshed; Colton never listed
46. ~~Spanish reply templates~~ **DONE Aug 27** — 4/3/1–2 star and suspected-fake
47. **Colton rating and review count** still blank on `gbp.html`
48. **Find the pre-existing reply automation** before it collides with the Monday task
49. **Fix the weekly task's prompt** — still says Van Buren 2955; needs delete-and-recreate
50. **Leaflets on cars** are generating 1-stars — marketing decision
51. **MV's categories include "Department of motor vehicles"** — may draw DMV-searchers
52. **Van Buren needs a replacement terminal** — Gen 1 Flex is not supported. **Tony's spend decision**
53. **Clover sandbox: make base URLs env-aware**, deploy to a preview, then set Site URL once
54. **Run `/api/clover_oauth` for all four branch merchants** — terminal stays dead without it
55. **Attach the repos when starting a task** — read works, `git push` is refused by the session's git proxy
56. **Update the project instructions** — still say 4 branches and a HawkLink pre-phase. Only Saif can edit that field
57. **Refresh the Drive backup** — the mirror is still the Aug 27 snapshot

---

## KEY LESSONS (locked)

### Trusting sources
- **When an external system disagrees with our records, do not assume our records are right.** The Van Buren address was wrong in this file, the project instructions, `gbp.html` and `posts.json` — four internal sources agreeing, all copied from each other. Google had it right.
- **A KPI that is not read from data is decoration.** `gbp.html` printed "4/4 posts live" while `posts_log.json` was empty.
- **"We tested it" needs a row to prove it.** Terminal charging was believed tested; three tables say it never ran once.
- **Do not state a guess as a finding.** On Aug 27 Claude called the six same-named project docs "version history, nothing to lose" without checking. They were six independent documents, and a later session read a stale one and correctly reported that a day's work did not exist. **Verify the shape of a store before reassuring anyone about it.**

### Guards and identifiers
- **A guard that tests `x.id` passes silently on ANY truthy `x`.** `true.id` is `undefined`, not an error.
- **Prefer the identifier you already hold over one you look up** — then the wrong match is structurally impossible.
- **A resolver that guesses is worse than one that abstains.**
- **Make new resolution paths FAIL-SOFT** — a miss behaves exactly as before.
- **Backfill on independent keys and prove one-to-one both ways.**

### Verification
- **`node --check` is the floor, not the gate.** It only parses; a `const` used above its declaration is a runtime error — that shipped as v2.7.
- **Extract the expression FROM THE FILE, never retype it into the test.**
- **Pin the clock when testing anything time-dependent.**
- **Test the OLD code too.** A suite that only proves the new code passes has not proven the diagnosis.
- **When a harness test fails, prove it is the code before believing it.**
- **A check that returns zero hits is unproven, not passing.**
- **Deploy discipline:** ONE atomic commit via the GitHub Git Data API, re-fetching the base SHA immediately before building the tree. **Verify what deployed, not what you pushed.**
- **RE-FETCH THE FILE CONTENT, NOT JUST THE SHA (Aug 29).** Two commits reverted a
  morning's work because the base SHA was fresh while the file body in hand was
  stale. Git saw a clean fast-forward and raised nothing. Always diff the live file
  against the copy being patched before building the tree.
- **Post-push, grep for markers that must STILL be there, not only the one just
  added.** That is what caught the revert.
- **A tautological assertion is not a test.** Aug 29 shipped a harness containing
  `|| true`; it was replaced with a real count. A check that cannot fail proves nothing.
- **When a harness fails, prove it is the code first.** Four harness bugs on Aug 29
  looked like code bugs: a script declaring its own `api()` and `renderPanel()` that
  shadowed the stubs, a `<select>` stub that did not reset `.value` when options were
  replaced, a brace matcher that latched onto a destructured parameter list, and an
  object spread in an argument position.
- **Check the cutoff before calling something a live bug.** Aug 29: 68 rows looked
  like a post-fix failure; the filter was date-only and the fix had deployed at 21:03.
- **A retryable write needs a DETERMINISTIC key (Aug 29).** The document migration
  named each object with a random uuid, so when the function timed out mid-batch the
  next pass re-uploaded the same file under a new name — 118 orphans against 118
  remaining rows, and it could never finish. Key on the row id and upsert.
- **Ask what we already pay for before adding a vendor.** I chose Vercel Blob because
  a half-written helper pointed there; Supabase Pro already included 100 GB of file
  storage, the credential was already in the environment, and Saif had to point it out.
- **A correlated subquery in a view SELECT runs once per output row (Sep 5).** In
  `call_sessions` that meant 369 full scans of a 35,742-row CTE. If a value can be
  computed in a GROUP BY that already exists, put it there.
- **A timeout-shaped failure goes straight to EXPLAIN ANALYZE (Sep 4).** Generic error,
  no server exception logged, works in one window and not another — I guessed three
  times before measuring, and the measurement answered it immediately.
- **Grep every use of a name before deleting it (Sep 4).** Removing a dead query, I
  deleted the declaration and one use, missed a second, and took the audit tab down.
- **The order and the colours must be computed by the SAME test (Sep 4).** Two
  definitions of "needs proof" made the sort contradict the badges.
- **Trace the whole path before fixing any hop of it (Sep 3).** Four commits for one
  Back button: portal home, sign-in screen, charge sheet, office picker. Each fix was
  correct and each revealed the next layer.
- **Grep before saying something is not built (Sep 3).** Creating a HawkSoft client
  had existed in charge.html for months when I said it did not exist.
- **Do not rewrite working code from scratch — COPY it (Sep 3).** I wrote a HawkSoft
  log note from memory, wrapped it in an array, and all nine were rejected.
  `hawksoft.js` had the correct shape three files away.
- **A bare `catch {}` on a write is how a failure reports success (Sep 3).** Second
  time in five days. Check the status, record the failure, count it.
- **Ask whether a capability is already in use before building a probe for it (Sep 3).**
- **PARSING IS NOT ENOUGH (Sep 1).** `node --check` and `new Function()` both pass on
  a call to a function that does not exist. Execute the real handlers in a DOM real
  enough to load the page, and reproduce the reported case exactly.
- **An anchor matching a common line must be verified to be the RIGHT occurrence
  (Sep 1).** `if (payment_id) {` appears many times; inserting at the first one put a
  declaration in the wrong function and took Submit to audit down for three hours.
- **A gate that refuses a legitimate case gets satisfied in the smallest way that
  passes.** The $0.01 problem, and then an agent uploading a non-receipt on a $102
  endorsement because the audit would not close without one.
- **Showing an option that cannot work is worse than hiding it.** An unnumbered policy
  in the picker would file to client level and say nothing.
- **Never infer the identifying attribute from the pattern you are trying to explain
  (Sep 1).** I decided which receipts were ours from the Tendered column, then used
  Tendered as proof about our receipts. Find a column that STATES ownership — Created
  By inverted the whole conclusion in one screenshot.
- **Test accounts prove nothing.** ZZTEST holds months of manual entries from many
  people. Verify on real clients.
- **Check Vercel `get_runtime_errors` BEFORE theorising about a UI symptom (Aug 31).**
  A ReferenceError had been firing 169 times for 18 days while I reasoned about
  notification routing.
- **`node --check` cannot see a scope error.** A harness that extracts functions and
  runs them together cannot either. Measure brace depth.
- **Revert first, diagnose after, when production is down.**
- **A gate must never be able to lock the owner out of the tool used to fix it.**
- **`100dvh`, not `100vh`, for anything full-height on mobile.**
- **Compute date boundaries in Pacific and MEASURE the offset for that date.**
- **A private bucket is not the same as a private URL.** Public object URLs are
  "unique and hard to guess" — obscurity. Serve bytes through our own gated function
  and never hand the browser a path.

### Infrastructure
- **A deployment gate can HIDE an outage.** The dashboard 404'd for a week behind an SSO redirect.
- **Promoting a deployment re-applies the project's protection default.**
- **NEVER deploy a raw file tree to these projects** — no git metadata is what killed the dashboard.
- **A client-side gate on a static page is theatre.**
- **Claude's sandbox cannot reach speedyins.com or *.vercel.app.** A 403 from the sandbox is the proxy. The Vercel MCP `web_fetch_vercel_url` tool CAN reach them.
- **A published Claude artifact cannot request outside hosts** — it can read connectors but never fetch a URL.
- **`project_delete` by path removes the NEWEST doc at that path**, not the oldest. With duplicates, the only safe cleanup is to delete every copy and write one fresh.

### Product and process
- **A gate that refuses a legitimate case makes the agent lie to it** in the smallest increment that passes. Allow the case, require an acknowledgement, record it.
- **When one gate is found, look for its siblings.** The zero gate was one of FOUR.
- **Performance first.** Group in Postgres, not JavaScript.
- **Every page has its own helpers.** `carrier.html` has no `esc()` — it has `escHtml`/`escAttr`, declared late.
- **Declare state ABOVE its first writer.**
- **Public replies are irreversible in practice.** Never auto-reply to a negative or suspected-fake review.

### Platform specifics
- **PostgREST `in.()` needs dotted values double-quoted.** It CAN alias JSON keys: `policy_number:extra->>policyNumber`. **Values containing `( )` inside an `or=()` filter need quoting too** — which is why the phone fix uses the paren-free form.
- **PostgREST returns `numeric` as a STRING.** Always `Number()` first.
- **Money inputs:** strip commas before `Number()`.
- **HawkSoft v4:** no invoice-creation, policy-update, receipt-modify or delete. Log channels 29 receipts, 32 bridge, 21 cash. Attachment Desc 41-char max. **Pol 0 = client level, 1+ = scoped to the policy.**
- **HawkSoft v4 has THREE write endpoints and none of them links records.** Log Note,
  Attachment, Create Receipts. No link field, no `ReceiptId` on attachments, and
  **no id is ever returned** — the receipts response echoes our own `refId` and a
  code. `LINK LOG` is CMS-only. **We DO create receipts** (98 posted, 0 failures).
- **RefId is an ENFORCED unique key.** Proved on ZZTEST: a duplicate returns
  500 Conflict, SQL unique violation. So it cannot group attachments onto one log
  row — and it is exactly what makes a retry safe.
- **Vercel Blob public URLs are public.** "Unique and hard to guess" is obscurity,
  not access control. Client documents require a PRIVATE store; private blobs
  cannot be fetched by URL and must be served through our own function.

## KEY IDS
Full list — Clover merchants and devices, GBP store codes, app IDs, scheduled tasks — is in **`Speedy_Workspace_Setup.md`**.
- Vercel team `team_lkyrTQ7Sej5RqdPBVe58kwL4` · speedy-website `prj_phlhnHAmKtGavgpfyJm9IIDiR3GD`
- Supabase `huvpitgappdqgavrqbud` · **`ZZTEST` fixture = client #26081** (auto `is_test`; now has a policy). **Never test policy matching on 16810.**
- HawkSoft Partner API contract 15112
- **Documents: private Supabase bucket `client-documents`** (RLS on, zero policies). Object path `clientNo/uuid.ext`; the migration used `clientNo/attachmentId.ext`. Admin probes: `blob_probe`, `doc_migrate`, `doc_orphans` on `/api/carrier` (x-id-token, not the admin key).
- **Producer codes:** SSM Sammy · JEV Jesus · THD Tony · AES Alejandra · YVA Yasmin · LIF Laura · JLR Jorge · CMA Christian · YYH Yolanda · FSS Fernando · EHA Esmeralda · **MSH Melisa · MCR Malcolm · IAH Irene · LND Lana · GGR Gabriela** (added Aug 29)
- **SAA = Saif's HawkSoft test account (gmail) — never map it.** NRR / TTD / LSN / KER / ABD and the rest are departed staff and stay unmapped on purpose.

### Rollback points (newest last)
`15000eb0` carrier $0.00 · `2fc2b9c0` portal v2.9 · `c6225e2a` policy resolver + portal v3.0 · `15e8752d` public ticket form · `4a5ac668` dead quote handler · `7d79b95d` receipt payment_id fix · `765d5925` Console v6.0 Pacific dates

**Aug 29, in order:** `719adcf9` melisa access · `edf9912b` refid probe · `dbacd6e9` phone search · `0d5fab52` **restore melisa after my own revert** · `ff6371f7` portal v3.1 refresh · `ea05d748` producer codes · `6070c22d` name search · `e737a4b3` portal v3.2 accordion · `5f891b80` receipt vault policy · `93570a67` portal v3.3 ownership · `7e921fae` audit_completed_by · `e1329bdb` blob probe · `1ea946e9` **documents to private Supabase bucket** · `7850e558` migration · `4f7c7c23` migration idempotent + orphan sweep · `52a246bc` policy documents · `01640c2f` portal v3.5 charge-this-policy · `eb1b8365` v3.6 help list · `e1896c46` **save_carrier_leg opened to helpers** · `e57e4263` v3.7 help sheet fixes · `8ff141c8` v3.8 bell polling · `176f05b2` v3.9 earnings breakdown

**Aug 30-31:** `7016eda9` v4.0 light mode · `1554abeb` tender probe · `59185635` daisy@ · `bdea98a1` roster table (REVERTED) · `2f99ba89` additive admins · `32b4bfa5` **revert roster, restore Console** · `d9dc30fd` `me` scope fix · `d65c59e6` v4.1 Pacific month + period picker + scroll

**Sep 1:** `f30fe573` MASTER.md to repo · `5af209c5` WORKSPACE + BUILD_MAP · `b77c4c7e` ops.html · `f647d9f4` ops full · `69593c45` **approval-date commission** · `d06ea9c5` **hotfix nowIso scope** · `1ba56a46` fee-only · `f3849d91` **hotfix recalcFee** · `5665bb83` existing receipt counts

**Sep 2-3:** `ec18b795` fee-only carrier fix · `b2ac1537` doc types + Other label · `558ac86f` **unnumbered policies chargeable** · `2a0c9d4d` retro-link · `505b4987` sweep all unlinked · `42840261` note payload fix · `aa5970cc` **picker grouped, no preselect >3 tabs** · `7af8e9ce` note_wrong_policy · `39dcc3e6` back control · `cff1ba6a` session handoff · `1c01182d` ?open= + tab close · `2139f7e3` office restore · `9a579268` new client from portal · `e54daf2b` = TAG `working-2026-09-03` (verified restore point)

**Sep 4:** `2f353148` PT_DAY scope · `1ce34e63` audit parallel + `75e80547` hotfix · `5de08482` **partial save tells the truth** · `b462d842`/`09e40c40`/`3a77d2d8` sort by what is missing · `e0097a21` admin HTML no-store · `2fc134f8` expired sign-in banner

**Sep 5:** migration `rewrite_call_sessions_no_correlated_subqueries` **(8,057ms → 310ms)** · **`86767870` api/sms.js — SMS proven end to end (current)**
`speedy-dashboard` production: `5c540afa`, then Aug 27 — Colton + address + KPI fixes, and `b00c3ba` ticket.html deleted. **Do not promote the metadata-less deploys.**

## WORKING STYLE (Saif)
Concise, directive, one item at a time — **ask one question, wait for the answer, then ask the next.** Confirm plan briefly before deploying. SHOW UI mockups before building. Verify with real data. Tony reviews significant/spend decisions; Lana CC'd. **No client PII in chat.** Secrets → Vercel env only.

**Give the complete current version in one block** when handing over a config or instruction.
**When Saif says "ok" to a message containing a fork, confirm which branch before acting.**
**When Saif reports something changed, check the commit history AND the data before answering.** Aug 25 he believed a change removed the receipt from the Audit tab; the commits proved otherwise but the data proved he was right that something was broken — and worse than reported.
**When Saif reports a bug from the floor, check the data before doubting it.** Aug 28: an agent could not find a client by phone. The search had never worked that way for anyone. Aug 29, twice more: a full name found nobody, and a payment offered no button. Every time, the floor was right and the code was wrong.
**Saif asks for brevity — he has said so explicitly.** Answer the question, show the numbers, ask the one thing that is actually blocking. Do not narrate.
**Saif tests each step before the next is built.** Ship one thing, say exactly what to test, wait.
