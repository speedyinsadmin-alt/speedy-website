# Speedy Workspace — systems, links, and where everything lives
**Set up August 27, 2026 · updated August 28 · this is the index; the master file is the work log**

> **Nothing has been deleted yet** except `ticket.html` (removed from
> `speedy-dashboard` Aug 27, commit `b00c3ba`). Notion and the other surfaces are
> still live; removal happens only after Saif confirms, item by item.

## The three docs in this project — and why there are only three

| Doc | Holds |
|---|---|
| `Speedy_Insurance_Master_Project.md` | The work log — bugs, fixes, decisions, open items, lessons. **Source of truth.** |
| `Speedy_Platform_Build_Map.md` | The A–E phase plan to replace HawkSoft |
| `Speedy_Workspace_Setup.md` (this) | The index — every system, every ID, every link, how the workspace runs |

If a fourth doc starts to look necessary, it probably belongs inside one of these.

---

## CLOVER — the full picture, established Aug 28, 2026

### The headline: terminal charging has NEVER run. Not once.
Three independent checks agree:
- `clover_tokens` in Supabase — **empty, zero rows**
- `events` where kind matches terminal — **zero rows**
- `bridge_ledger` terminal charges — **zero rows**

`getCloverToken()` has **no fallback**: no OAuth row means it returns
`"Terminal not authorized for this branch yet"` before ever calling Clover. There
is no path where a terminal charge could have succeeded and left no trace.

**What was tested previously was the ecommerce CARD path**, which works and has 39
real charges behind it. Both live on the same page, which is how they got
conflated. The code comment says it plainly: *"Ecommerce tokens currently exist
for Moreno Valley (main) only."*

### The code is complete — the configuration is not
`charge.html` has the Terminal method, branch picker and SEND TO TERMINAL button.
`api/hawksoft.js` has `terminal_config` and `terminal_charge`: REST Pay Display,
`X-Clover-Device-Id` per charge, safety-net ledger write before receipt, decline
handling, branded receipt PDF, HawkSoft filing. All built.

`portal.html:1334` still renders a disabled **"Terminal — soon"** button — the
portal doesn't have it yet (Merge Stage 1). **The charge page does.**

### Branch registry — four separate Clover merchants
From `api/hawksoft.js`, confirmed with Saif 7/20/2026:

| Branch | Merchant ID | Device | Model |
|---|---|---|---|
| Moreno Valley | `1K7NR5V6K1ER1` | C045UT33351057 | Flex 3 |
| Riverside — Van Buren | `YQK002AEVXRF1` | C042UQ93960695 | **Flex (Gen 1)** |
| Riverside — Magnolia | `9SQRE50EMSDF1` | C045UT32440358 | Flex 3 |
| Lake Elsinore | `RC02YN4Q370Z1` | C046UG50362404 | Flex 4 |

Excluded legacy businesses (not in service): `VEX5X0YZBMVB1`, `5G1JARVY3MP91`.

**Each branch needs its own OAuth run.** Even the day the app is approved,
terminal payments stay dead until `/api/clover_oauth` has been run for all four.

### ⚠️ Van Buren's terminal will never work — confirmed Aug 28
The sandbox app's own App Type reads:
**Semi-Integrated — Android (Flex 2nd Gen, Flex 3rd Gen, Flex 4th Gen), REST Clients.**

**Gen 1 is not in the supported list.** Van Buren's `C042UQ93960695` is a Gen 1
Flex. This is no longer an inference from the May 15 2026 End-of-App-Update date —
it is the app's own device list. **Van Buren needs a replacement terminal.** That
is a spend decision for Tony.

### Apps
| | Production | Sandbox |
|---|---|---|
| App ID | `9PSNNM5VC2456` | `3772EDF6956JY` |
| Name | — | Speedy Payment Bridge |
| Status | **In review since Jul 23, 2026** | **Draft**, 0 installs |
| RAID | — | `PX7C6ZHG8QD7P.3772EDF6956JY` |

Developer account `0EFKFNBWHCSAM`. Global developer platform (not the legacy
sandbox): https://www.clover.com/global-developer-home — one login with a
sandbox/production toggle.

**Sandbox app config as it stands:** Requested permissions — Read and Write:
Payments, Read: Merchant. **REST Configuration: not set.** Android APKs: none
(correct — Semi-Integrated needs no custom APK; the device runs Clover's own
payment app and we drive it over REST Pay Display). Webhooks: not set.

**Test merchant:** `P3CNFM3N9Z871` (US) — already exists.
**Dev Kits: none on the account.** Pay Display sends to a physical terminal, so
whether the Android emulator suffices for a card-present demo recording is an
open question — asked of DevRel Aug 28.

> The sandbox App Secret is visible in the REST Configuration dialog. It is
> sandbox-only and is deliberately **not** recorded in any project doc.

### Why nothing can be tested yet — and the correct order
Clover requires a functional video showing *"the full functionality of your
working app integration"* for approval. But the integration can't run until
merchants install the app, which needs approval. The documented way out is to
**install to a test merchant in sandbox** and record there.

**⚠️ Do these in order. Every Site URL change triggers a Clover review**, so
setting it wrong once costs a cycle:

1. **Make base URLs env-aware.** `clover_oauth.js` is hardcoded to
   `https://www.clover.com/oauth/v2/authorize` and
   `https://api.clover.com/oauth/v2/token`; `hawksoft.js` uses
   `https://api.clover.com` and `https://scl.clover.com`. Sandbox is a different
   host. `REDIRECT` is hardcoded to `https://www.speedyins.com/api/clover_oauth`.
2. **Deploy to a Vercel preview branch** — gives a stable preview URL.
3. **Sandbox `CLOVER_APP_ID` / `CLOVER_APP_SECRET` on that preview only** — never
   on production.
4. **Then** set the sandbox app's REST Configuration Site URL to the preview URL.
   Fields are Site URL*, Alternate Launch Path*, CORS Domain (optional). Leave
   Default OAuth Response on **Code**, not "Token (Testing Only)".
5. Install the app to test merchant `P3CNFM3N9Z871`, run OAuth.
6. Film the charge-page terminal flow for the submission video.

⚠️ **Never use the Vercel `deploy_to_vercel` tool on these projects** — it
deploys a raw file tree with no git metadata, the exact signature of the empty
deploy that 404'd the dashboard for a week in August.

⚠️ **Do not change the production app's type or configuration while it is in
review** — it could reset the queue. Private-app selection is also one-way.

### Contact
**developer-relations@devrel.clover.com** — Clover's documented DevRel address.
Allowlist `devrel.clover.com` and check spam; their docs warn replies get
filtered. Email sent Aug 28 asking: (1) confirm Gen 1 Flex unsupported,
(2) does an emulator sandbox recording satisfy functional review or is a Dev Kit
required, (3) is the video what's holding the review.

---

## Scheduled tasks

**Weekly Google review replies — Speedy Insurance**
`trig_01SpeYWep68T7gyJPL6ZGBq4` · Mondays 10:00 AM Pacific (`0 17 * * 1` UTC) ·
first run Mon Aug 31, 2026 · push + email on. Bound to Saif's computer.

Drives Chrome to `business.google.com/reviews` and replies to unanswered **4- and
5-star** reviews, **25 per run**, in the agency's established voice. Hard rules:
never 1–3 star · never the paid-review accusations · never confirms policy
details or client status · replies in the reviewer's language · verifies each
post landed. Reports what it posted, what remains, and every low-star review found.

> ⚠️ **Its prompt still says Van Buren is 2955.** Written before the address was
> confirmed as 2995. Editing a device-bound task's content requires a device
> proof and was refused from the cloud session — delete and recreate to fix.
> Low practical risk: the task references branches by name, not address.

> The cron is stored in UTC, so the local fire time shifts an hour when Pacific
> leaves daylight time. Adjust to `0 18 * * 1` if the 10am slot matters.

**Golden Square duplicate — decision due**
`trig_01Jakrpg4EQLnoTpzcayC1H1` · one-shot, **Fri Sept 4, 2026, 10:00 AM PT**.
Saif parked the decision on Aug 28 and asked to be re-asked.

> **An older reply automation exists that is NOT on this account** —
> `list_triggers` shows nothing else. It replied to dozens of reviews on ~Aug 22,
> warmly and in correct Spanish. Likely a Cowork desktop-local task. **Find it
> before Monday or the two will collide.**

---

## Every link

### Live pages
- Health checks / live monitor — https://speedyins.com/admin
- Agent portal (v3.0) — https://speedyins.com/admin/portal.html
- Charge page (v2.37) — https://speedyins.com/admin/charge.html
- Platform console (v6.0) — https://speedyins.com/admin/platform.html
- Carrier audit — https://speedyins.com/admin/carrier.html
- Agent ticket form (v1.1, public by design) — https://speedyins.com/admin/ticket.html

### Google Business Profile
- GBP Dashboard — https://speedy-dashboard-speedyinsadmin-8075s-projects.vercel.app/gbp.html
- Posts & review replies — https://speedy-dashboard-speedyinsadmin-8075s-projects.vercel.app/posts.html
- Google Business Profile itself — https://business.google.com

### Public site
- https://speedyins.com · Spanish: https://speedyins.com/es.html
- Quote (TurboRater): https://speedyins.com/quote.html
- Speedy Hub: https://speedy-hub.vercel.app

### Infrastructure
- Supabase project `huvpitgappdqgavrqbud` — https://supabase.com/dashboard/project/huvpitgappdqgavrqbud
- Vercel team slug `speedyinsadmin-8075s-projects` (Pro)
  - speedy-website — https://vercel.com/speedyinsadmin-8075s-projects/speedy-website
  - speedy-dashboard — https://vercel.com/speedyinsadmin-8075s-projects/speedy-dashboard
  - speedy-hub — https://vercel.com/speedyinsadmin-8075s-projects/speedy-hub
- Clover global developer home — https://www.clover.com/global-developer-home

### Code — all three repos are PUBLIC
- https://github.com/speedyinsadmin-alt/speedy-website
- https://github.com/speedyinsadmin-alt/speedy-dashboard
- https://github.com/speedyinsadmin-alt/speedy-hub

> **GitHub access:** `GITHUB_TOKEN` authenticates as `speedyinsadmin-alt` and a
> shallow clone works, but **`git push` is refused by the session's git proxy** —
> repos are not in the session's authorized set and no `add_repo` tool is exposed.
> Fix: select the repo when the task/session is created. Account-level GitHub
> connection is necessary but not sufficient.

### ITC / TurboRater (Zywave)
- TurboRater login — https://turborater.zywave.com/support/account/login.aspx/1000
- Support portal — https://turborater.zywave.com/support/ · (800) 383-3482
- Product page — https://www.zywave.com/products/turborater/ · sales (855) 454-6100
- Third-party rating integration (AL3 / TT2 routes) —
  https://turborater.zywave.com/products/websites/features/third-party-rating-integration

ITC was acquired by **Zywave** in Nov 2020. Ask for the **Personal Lines Quoting
API** by name. Zywave publishes no developer docs, keys or requirements — every
public route is "request a demo", so the account rep is the only mechanism.
Contract: TurboRater for Websites, Q-182382, $145/mo, auto-renews on 60-day
notice — **remind April 2027**.

### Vendors
- Tawk.to — https://dashboard.tawk.to
- RingCentral — https://service.ringcentral.com

### This project
- Ops Console — https://claude.ai/code/artifact/13f422b8-9364-4783-b68b-879eba93a781
- Drive backup folder — https://drive.google.com/drive/folders/1B0NQ21kiJtEd5pRcOQMzekN_Mj3HLVTI

---

## Google Business Profile — read live from Google, Aug 27–28, 2026

**Google holds SIX verified profiles. Speedy has five branches.**

| Profile name | Address on the listing | Store code | Reading |
|---|---|---|---|
| Speedy Insurance Agency | 12625 Frederick St. #i-1, Moreno Valley 92553 | — | Correct |
| Speedy Insurance Agency | 7010 Magnolia Avenue, Riverside 92506 | — | Correct |
| **Speedy Insurance** *(name differs)* | 2995 Van Buren Blvd STE A7, Riverside 92503 | 4930998492325700581 | **Correct — our records were wrong** |
| Speedy Insurance Agency | 32285 Mission **Trial** P5, Lake Elsinore 92530 | — | "Trial" — typo for Trail |
| Speedy Insurance Agency | 1047 N Mt Vernon Ave, Colton 92324 | 08230756854716284611 | Live · was absent from gbp.html |
| **Golden Square Insurance** | 31948 Mission Trail Ste B, Lake Elsinore 92530 | 05077851404532952769 | **Duplicate · old address** |

**Colton was never missing from Google.** Claimed, verified, taking five-star
reviews. It was missing from `gbp.html` and `posts.json` — a dashboard blind
spot, not a Google gap. **Fixed Aug 27**; Colton is now branch `co` in
`posts.json` and has a card on `gbp.html`.

Reported totals (4 tracked branches): 2,184 reviews, 4.9★ —
MV 898 / 4.8★ · Magnolia 777 / 4.9★ · Van Buren 433 / 4.9★ · LE 76 / 5.0★.

### RESOLVED
- **Van Buren address** — it is **2995**, confirmed by Saif Aug 28. Google was
  right; this file, the project instructions, `gbp.html` and `posts.json` all
  said 2955. Repo fixed Aug 27.
- **Moreno Valley Sunday hours** — checked live Aug 28: Google shows
  **Sunday 10:00 AM–5:00 PM**, Mon–Fri 9–7, Sat 10–5. Correct. The July
  "Sunday: Closed" screenshot is stale.
- **Colton missing from the dashboard** — added Aug 27.
- **`ticket.html` in the public repo** — deleted Aug 27, commit `b00c3ba`.

### Still open
1. **Golden Square duplicate** — close or merge, never delete. Parked to Sept 4.
2. **Lake Elsinore reads "Mission Trial"** — should be Trail.
3. **One business name, not three** — Van Buren is "Speedy Insurance"; four
   others are "Speedy Insurance Agency".
4. **Store codes missing** on MV, Magnolia and Lake Elsinore.
5. **Magnolia points at `cheapinsuranceriverside.com`** — deliberate SEO or drift?
6. **Service areas flagged broad** — MV and Lake Elsinore.
7. **Branch photos** — only MV refreshed (Jul 9). VB, Magnolia, LE pending;
   Colton never listed.
8. **Colton rating and review count** — still `—` on `gbp.html`, and it is
   excluded from the bar chart. Fill in from Google.
9. **Moreno Valley's categories include "Department of motor vehicles"** — can
   surface Speedy for people searching for the actual DMV. Two 1-stars are DMV
   complaints. Worth a decision.

### ESCALATED TO TONY — do not reply, do not draft
**Four separate reviewers across 2019–2025 allege the agency pays for reviews.**
Kay and DRMSL name Starbucks gift cards; The Lion and Lioness says "I was offered
a discount"; Abby F. says the reviews are fake accounts. Incentivized reviews
breach Google's review policy — a four-witness pattern is what gets reviews
stripped or a profile actioned. A business decision, not a template.

### What the negative reviews say (50 read, sorted lowest-rating)
All unanswered negatives are older than six months, so per Saif's rule they are
left alone. Concentrated at Moreno Valley, then Van Buren, then Magnolia.
- **Nobody answers the phone** — five reviewers. The RingCentral review measured
  **1,062 missed calls in April, an 18% miss rate**. Same problem, two views.
- **"Shows open 24 hours but they are not — false advertising"** (Van Buren) —
  the hours bug `gbp.html` records as fixed. It reached customers first.
- **Leaflets left on cars** in apartment complexes — two reviewers, two branches.
- Refund and cancellation disputes; broker fees; SR-22 pricing.

### Reply protocol
Reply within 48 hours · reply in the language the review was written in · use the
reviewer's first name · **never confirm policy details, client status or any PII,
even to defend the agency** · 1–2 star and suspected-fake are drafted and
escalated, never auto-sent. **Saif's rule (Aug 27):** reply to positives;
negatives older than six months are ignored; anything more recent gets asked
about first.

### The post cadence has never run
`posts_log.json` contains `"published": []`. Only one Google post has ever been
published (Free Quote, Jul 10 2026). The "4 / 4 posts live this week" KPI was
fabricated by the page — **corrected Aug 27** to "1 post ever published".

### Where GBP content lives
`posts.json` (copy, themes, branches) · `img/posts/` (34 graphics) ·
`POSTS_TASK.md` (weekly task spec) · `posts_log.json` (what went out) — all in
`speedy-dashboard`. Change `posts.json` and both the page and the task pick it up.

### Dependency
Making `speedy-dashboard` private **breaks the GBP graphics** — the task pulls
all 34 from `raw.githubusercontent.com`. Token the task first, then flip the repo.

---

## The `/admin` health page

`speedyins.com/admin` is a live monitor with *Re-run checks* and *Lock* controls.
It was missing from the master file entirely until Aug 27.

**Four live checks:** homepage `index.html` · Spanish page `es.html` · logo asset
· Tawk.to reachability. The Tawk check proves the **script** is live — not that an
agent is online, which is the actual 6pm coverage problem.

**Supabase panel:** plan, compute, CPU, RAM, DB size, region, Postgres version,
status. The page notes the plan is *inferred from compute size* — the API does
not report the org plan.

## Supabase — full detail

- Project `speedy-insurance` · ref `huvpitgappdqgavrqbud` · created Jun 30, 2026
- **Pro plan active since Jul 8, 2026 · $25/mo flat**
- Micro compute · 2-core · 1 GB RAM — compute covered by the $10/mo plan credit
- Spend cap **ON** · daily backups, 7-day retention · auto-pause **disabled**
- Region `us-west-1` · Postgres `17.6.1.127` · status `ACTIVE_HEALTHY`
- Billed under the **speedyinsadmin-alt** org

**Two numbers, one database.** Postgres reports MiB (1024-based); `/admin` prints
MB (1000-based). 354 MiB and 370.8 MB are the same database.

---

## How the workspace runs

1. Claude **reads** the master file at the start of every session.
2. Claude **writes** to it as work happens — no asking, no pasting.
3. On every master-file change Claude **republishes the Ops Console** to the same
   URL and **mirrors the file to Drive**.
4. The console is a *view*. If it disagrees with the master file, the master file
   is right.

### What the console can and cannot do
- **Can:** read Supabase live through the connector, with the viewer's credentials.
- **Cannot:** run the four uptime checks — a published artifact is blocked from
  requesting outside hosts. Those stay at `/admin`.
- **Consequence:** the connector grant means the console can no longer be shared
  publicly. Private to Saif.

### Deliberate exclusions from the console
Credentials, API client IDs, merchant IDs, widget IDs, app secrets and staff
emails are not on it. It has a URL, and a URL is one share away from public.

### Why the backlog must not move onto `/admin`
`speedy-website` is a public repo and the admin HTML is publicly fetchable — the
gate protects the API responses, not the page. Putting the backlog, cost table or
security list there would publish the agency's operational posture.

---

## Still to inventory
Anything else running in production that lives only in a bookmark or in Saif's
head — crons, scripts, integrations, one-off pages. `/admin`, `gbp.html` and the
existing reply automation were all missing from this list before Aug 27.
