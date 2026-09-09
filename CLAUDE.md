# Speedy Insurance — speedy-website

**`claude/MASTER.md` is the source of truth. Read it before writing any code.**
It holds the history, open items, and every lesson — keep it current, it is the ONLY
copy. `claude/WORKSPACE.md` is the systems index beside it.

## Branches (5)
| # | Branch | Address | Manager |
|---|---|---|---|
| 1 | Moreno Valley | 12625 Frederick St #I-1 · (951) 472-0927 | Sammy Rodriguez |
| 2 | Riverside Van Buren | **2995** Van Buren Blvd Ste A7 | Yasmin Alfaro |
| 3 | Riverside Magnolia | 7010 Magnolia Ave | Alejandra E. Salas |
| 4 | Lake Elsinore | 32285 Mission Trail P5 | Yolanda Hernandez |
| 5 | Colton | 1047 N Mount Vernon Ave · (909) 587-6001 | Christian Aguilar |

Numbers are HawkSoft's own office ids, verified live. `0` is agency-level and is
never offered in a picker.
**Hours:** Mon–Fri 9am–7pm, Sat 10am–5pm. **Sunday: Moreno Valley only, 10am–5pm.**

## Hard rules
- **No client PII in chat.** Client numbers yes; names, phones, documents, no.
- **Secrets live in Vercel env only.** Never in a file, never in a commit.
- **All three repos are PUBLIC** — `speedy-website`, `speedy-dashboard`, `speedy-hub`.
  Anything committed is world-readable, including the staff emails already in
  `portal.html` / `charge.html` / `platform.html`.
- **NEVER use the Vercel `deploy_to_vercel` MCP tool on these projects.** It pushes a
  raw file tree with no git metadata. An empty deploy promoted to production that way
  left the dashboard 404ing for a week, hidden behind the SSO gate. Deploy by pushing
  a git commit.
- **A gate must never be able to lock the owner out of the tool used to fix it.**
  Admin lists are ADDITIVE from the database; code is the floor.
- **During a live outage, revert first and diagnose after.** Aug 30: a hotfix on an
  unconfirmed theory did not work, and only then came the revert.

## The scope error — the mistake that keeps shipping
Four outages in one week, one shape: **new code calling a name it did not define, in a
scope where that name is invisible.** It locked Tony out of the Console, took
Submit-to-audit down for 3 hours (16 permanent duplicate receipts), and shipped two
tabs that had never once worked.

- **Measure the brace depth of the definition and of the use BEFORE pushing.** If depth
  returns to 0 between them they are in different blocks and the name is invisible.
  The one-pass counter is in `MASTER.md` under "The rule".
- **`node --check` is the floor, not the gate.** It only parses — it passes on a call
  to a function that does not exist. Execute the real handler in a DOM complete enough
  to load the page; extracting a function and hand-feeding it its variables is exactly
  what HIDES a scope bug.
- **Grep EVERY use of a name before deleting it**, and verify an insertion anchor is
  the RIGHT occurrence — `if (payment_id) {` appears many times.

## How Saif works
- **One item at a time.** Ask one question, wait for the answer, then ask the next.
- **Show the plan before deploying**, and UI mockups before building. Ship one thing,
  say exactly what to test, wait.
- **Money pages get the plan, a mockup, and the real logic run against real data
  shapes before any push.**
- **When Saif reports a bug from the floor, check the data before doubting it.** Phone
  search, full-name search, the missing audit button — every time the floor was right.
- Be brief: answer the question, show the numbers, ask the one thing that blocks.
- Tony reviews significant/spend decisions; Lana is CC'd.
