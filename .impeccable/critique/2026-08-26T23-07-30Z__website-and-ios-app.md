---
target: website and iOS app
total_score: 30
p0_count: 0
p1_count: 3
timestamp: 2026-08-26T23-07-30Z
slug: website-and-ios-app
---
## Design Health Score

### Website

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Strong skeletons, busy states, banners, queued-refresh feedback, cached-data disclosure, and archive undo. |
| 2 | Match System / Real World | 4 | Carrier, delivery, pickup, customs, archive, and timeline language are natural. |
| 3 | User Control and Freedom | 3 | Cancel/back, clear filters, archive undo, and explicit delete confirmation are present. |
| 4 | Consistency and Standards | 2 | The current source and deployed public authentication surface present visibly different design systems. |
| 5 | Error Prevention | 4 | Parsing, confidence-based carrier confirmation, carrier-specific constraints, disabled submit, and destructive confirmation are excellent. |
| 6 | Recognition Rather Than Recall | 3 | Most actions are labeled, but compact header and mobile filter actions become icon-led. |
| 7 | Flexibility and Efficiency | 3 | Search, filtering, sorting, paste, share target, swipe, and accessible action menus are available. |
| 8 | Aesthetic and Minimalist Design | 3 | The current core is restrained; the public auth surface is templated, and signed-in chrome exposes too many action paths. |
| 9 | Error Recovery | 3 | Actionable retries and preserved forms are solid. |
| 10 | Help and Documentation | 1 | Helpful microcopy exists, but there is no discoverable task help or explanation of tracking/status behavior. |
| **Total** |  | **29/40** | **Good foundation** |

### iOS app

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Native progress indicators, alerts, inline notices, toasts, and busy states are thorough. |
| 2 | Match System / Real World | 4 | Strong carrier language and native platform metaphors. |
| 3 | User Control and Freedom | 3 | Native back, Cancel/Done, sheet dismissal, archive undo, and “Not now” are present. |
| 4 | Consistency and Standards | 3 | Mostly HIG-conformant; custom card stacks and incomplete Reduce Motion handling are exceptions. |
| 5 | Error Prevention | 4 | Smart parsing/defaults, constrained inputs, disabled save, confirmation alerts, and typed account deletion are strong. |
| 6 | Recognition Rather Than Recall | 3 | SF Symbols and standard controls help, but four icon-only toolbar actions ask first-timers to infer meaning. |
| 7 | Flexibility and Efficiency | 3 | Search, filters, sorting, swipe, paste, scan, sharing, and pull-to-refresh are available. |
| 8 | Aesthetic and Minimalist Design | 2 | Four toolbar icons, persistent search, the hero, and Add compete; Add and Detail overuse rounded cards. |
| 9 | Error Recovery | 3 | Alerts preserve state and recovery is generally clear. |
| 10 | Help and Documentation | 2 | Good onboarding and field hints, but no persistent help surface. |
| **Total** |  | **30/40** | **Good foundation** |

**Combined: 59/80 (29.5/40 equivalent).** Strongest in real-world fit and error prevention; weakest in focused hierarchy, entry-point consistency, and help.

## Anti-Patterns Verdict

**LLM assessment:** The current working-tree core app largely passes the product slop test. Swiss yellow, restrained surfaces, familiar controls, semantic status treatments, and mature states feel intentional. The deployed public sign-in surface fails the first-impression test: a cream glow, centered rounded white card, tiny tracked uppercase eyebrow, and oversized carrier-list headline read as a generic AI authentication template. The native app is recognizably iOS, though repeated rounded-card sections in Add and Detail occasionally feel like web UI rebuilt in SwiftUI.

**Deterministic scan:** The Impeccable detector ran exactly once over `src`, exited 0, and returned `[]`: zero rule hits, zero file locations, and no false positives. This supports the assessment that the current web source avoids the banned slop families. The result does not cover the deployed public build or SwiftUI.

**Visual overlays:** No reliable user-visible overlay exists. The supplied localhost port served a different product, a repository fallback build hit a Next.js module-resolution error, the browser later disconnected before the public-site evidence pass, and the Mac lock blocked Simulator access. Assessment A still inspected the public sign-in and an isolated current-source sign-in build before the browser became unavailable; native visual and accessibility conclusions remain source-based.

## Overall Impression

This is a good product with unusually mature state handling and a distinct, appropriate visual identity. The biggest opportunity is not a redesign; it is editorial discipline. Reduce top-level choices, make the public entry point match the stronger current system, and close concrete mobile accessibility gaps.

## What's Working

1. **State design is unusually complete.** Loading, cached data, authentication expiry, sync errors, empty/no-result states, queued refresh, archive undo, restore, and permanent deletion are all explicitly handled.
2. **Parcel capture reduces real work.** Paste/scan/link parsing, confidence-based carrier confirmation, carrier-specific fields, and remembered DPD postcode prevent mistakes without making every user fill every field.
3. **The platforms speak the same product language.** Swiss yellow, status tones, parcel glyph, progress, timeline, localization, errors, and archive semantics create recognition without excessive decoration.

## Priority Issues

### [P1] The public web entry point and current source look like different products

**Why it matters:** Users meet the weakest and most AI-looking design first. Release drift also makes the design system difficult to trust and test.

**Fix:** Deploy the current authentication shell, retire the cream radial background/eyebrow/floating-card treatment, and add viewport visual regression coverage for auth, list, detail, and Add.

**Suggested command:** `$impeccable polish`

### [P1] The current web header clips at a common 390 px viewport

**Why it matters:** The language selector is cropped on a common iPhone-width first impression, making the product look unfinished and potentially blocking locale selection.

**Fix:** Give the brand copy `min-width: 0`, allow controlled truncation, and switch to the compact language control near 430 px rather than only at 360 px. Test 375, 390, 393, and 430 px in every language.

**Suggested command:** `$impeccable adapt`

### [P1] Several native actions miss the 44 pt iOS touch-target minimum

**Why it matters:** The 34 pt filter-removal chips and caption-sized banner/toast actions are harder to hit for users with motor impairments and in distracted one-handed use.

**Fix:** Preserve the compact visual size but expand the interactive frame/content shape to at least 44×44 pt, then verify with the Accessibility Inspector.

**Suggested command:** `$impeccable harden`

### [P2] Top-level actions exceed the interface's attention budget

**Why it matters:** The iOS list exposes account, notifications, filter, refresh, search, next parcel, and Add—seven paths. The web chrome has a similar competition problem. First-timers must infer icon meanings before they can focus on the next delivery.

**Fix:** Remove the iOS refresh toolbar item because pull-to-refresh already exists. Keep one primary action plus at most two secondary actions; consolidate settings/account destinations where appropriate.

**Suggested command:** `$impeccable distill`

### [P2] The iOS Add flow is over-cardified, motion-heavy, and teaches a different order than web

**Why it matters:** Contents, tracking, carrier, URL, and postcode read as a stack of separate tasks. iOS starts with contents while web starts with tracking, so users learn two mental models. Unconditional `.snappy`, moving transitions, and bounce effects ignore Reduce Motion in a core flow.

**Fix:** Make tracking the canonical first field on both platforms. Keep contents optional and secondary, use native Form/grouped sections, reveal carrier requirements after parsing, and replace movement/bounce with crossfades or instant changes under Reduce Motion.

**Suggested command:** `$impeccable onboard`

No P0 issues were found.

## Persona Red Flags

**Jordan (first-timer):** Four unlabeled iOS toolbar icons require interpretation. The web progress treatment communicates position but not why a parcel is stalled. Carrier-dependent fields appearing after input can feel like the form changed the rules.

**Casey (distracted mobile user):** The 390 px web header clips a control. iOS account, notification, filter, and refresh actions all sit in the least reachable top zone. Fixed-bottom Add and paste/scan are strong compensating choices.

**Sam (accessibility-dependent user):** ARIA labels, focus rings, semantic controls, Dynamic Type styles, and reduced-motion work are strong in much of the code. Risks remain in 9–11 px web microcopy, 34 pt native chips, undersized inline actions, color-heavy status accents, and unconditional motion in Add. VoiceOver, Dark Mode, large Dynamic Type, and Reduce Motion could not be verified live.

## Minor Observations

- Web carrier labels, tracking labels, and helper text sometimes fall to 9–11 px; use a 12 px secondary-text floor.
- The web “Next up” control looks almost passive; the native chevron communicates navigation more clearly.
- Archived disclosure, filter chips, clear-all behavior, native Forms, and swipe actions are well judged.
- Full-screen notification onboarding includes “Not now,” but should appear only after enough user value has been demonstrated.
- No `PRODUCT.md` or `DESIGN.md` exists, so audience, tonal intent, and cross-platform hierarchy rules are not recorded.

## Questions to Consider

- Is the product primarily “tell me what needs attention now” or “manage every parcel”? If it is the former, why do settings, notifications, filters, and refresh receive comparable weight to the next delivery?
- Is the canonical add model “paste a tracking number” or “name what I’m expecting”? Pick one and teach it identically.
- Is the public cream-card sign-in intentional, or simply deployment drift?
- What chrome can disappear once background refresh and pull-to-refresh are trusted?
