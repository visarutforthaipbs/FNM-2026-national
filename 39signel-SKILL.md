---
name: signal39-design
description: Apply the Signal 39 cognitive design framework when creating any UI, dashboard, data visualization, portfolio, or communication artifact. Use this skill whenever the user asks to design, build, or critique interfaces, visualizations, civic tech platforms (Factories Near Me, Tan Fun Tan Fai, Mines Near Me), reports, presentations, or any product where human attention is the scarce resource. Also trigger when the user mentions "cognitive load," "information design," "data viz," "public intelligence," or asks to make something "cleaner," "clearer," or "easier to understand." This skill encodes the Signal 39 principle: every design decision is a withdrawal from the user's 184 KB daily cognitive budget — spend it only on Surprisal.
---

# Signal 39 Design Skill

Cognitive Architect standard for all UI, data visualization, and communication design. Every design decision is a **cognitive budget transaction**. The user's conscious attention runs at **39 bps** — design to maximize Surprisal ROI, never waste bits.

---

## Core Mental Model Before Writing Any Code

Answer these before touching layout or color:

1. **Who is the receiver?** (Crisis user? Civic stakeholder? Recruiter? Technical team?)
2. **What is their cognitive state?** (Anxious users in a crisis drop to <30 bps. Adjust density accordingly.)
3. **What is the single highest-Surprisal fact?** (The "Data Archaeology" result — one artifact from the 11M bps firehose.)
4. **What is their budget context?** (A dashboard seen 10x/day costs less per view. A long report is a one-time 6 KB spend.)

---

## The 3-Layer Production Funnel

Every interface must be designed across all three layers simultaneously.

### Layer 1 — Subconscious Hook (Zero Conscious Tax)
**Target:** 11M bps sensory channel. Pre-attentive attributes only.

- **Color** encodes status, priority, or category before the eye focuses. Never decorative.
- **Spatial grouping** communicates hierarchy without text.
- **Motion** draws attention to change, not to decoration.
- **Test:** Cover all text. Can the user read priority, category, and urgency in <300ms? If no → Layer 1 has failed.

**Implementation rules:**
- Use a maximum of 3 distinct hue families per interface.
- Status colors (danger/caution/safe) must never be swapped for aesthetic reasons.
- For environmental/civic data (PM2.5, mine proximity): color IS the data. Treat it as a quantitative axis, not a theme.
- Animate state changes (not entry animations). Change = new information.

### Layer 2 — Chunked Gateway (5–10 bps)
**Target:** Reduce "Search Noise." Group variables into semantic containers.

- **Rule of Three:** Maximum 3 primary navigation items, 3 data categories, 3 CTA options. Every additional choice doubles the Bit-Tax (Hick's Law).
- **Icons as semantic containers:** An icon + label costs less than a label alone because the icon is processed by Layer 1.
- **Chunking pattern for complex data (e.g., Thai PBS dashboards):** Group diverse variables into no more than 3 high-level "Pillars" visible at a glance.
- **Avoid:** Long dropdown lists, flat navigation with 6+ items, tables without visual grouping.

### Layer 3 — Conscious Deep-Dive (39 bps)
**Target:** High-Entropy (High Surprisal) information only.

- Reserve Layer 3 for the "Aha!" moment. One key insight per screen.
- **Progressive Disclosure:** Hide secondary detail behind interaction (click, hover, expand). Do not pre-load the 39 bps budget with information the user didn't request.
- **Never spend bits on predictable information.** If a data point is common sense, move it to Layer 1 (background color) or delete it entirely.
- For investigative content: lead with the finding, not the methodology. The finding is Surprisal; the methodology is noise.

---

## Standard Operating Procedures

### The Switching Tax Protocol
Every time a user switches context (map → text, chart → table, page → page), they burn bits clearing and reloading working memory.

- **Prefer integrated data viz** over linked views.
- If a number needs a map to make sense, the number and map must coexist on the same viewport.
- Never make the user toggle between "data view" and "insight view."
- For civic platforms (Factories Near Me, Local Admin Near Me): geographic context must always be visible while reading the attribute data.

### Visual Parallelism Rule
Audio and visual must be 100% synced. Splitting the 39 bps budget between reading one thing and hearing another causes immediate cognitive starvation.

- Never put a voiceover that says different things than what's on screen.
- Subtitle text must match narration word-for-word.
- Animation timing must align with narrative beats, not run independently.

### The Breath Rule
After delivering a major insight, insert 3–5 seconds of low-bitrate space.

- In UI: a visual pause — generous whitespace, a single stat, no competing elements.
- In video: a beat of ambient audio, no new text.
- In documents: a one-sentence summary paragraph followed by a section break.
- **Purpose:** Allows the 39 bps budget to encode the insight into long-term memory rather than being overwritten by the next sentence.

### Information Density Audit
Every word is a tax. Every chart element is a tax. Audit before shipping.

- Run **Data Archaeology**: strip the content to its single most impactful fact. Build back up only what earns its bit-cost.
- Formula: `(Seconds of Engagement) × 39 = Bit Cost`. Ask: does this insight justify X% of a 184 KB daily budget?
- **Ruthlessly delete:** legends that duplicate axis labels, titles that repeat the chart, tooltips that explain obvious data.

---

## The 184 KB Pre-Flight Audit

Run all three checks before any design is considered complete.

### Check 1 — Mute/Blur Test (Layer 1)
Blur all text to unreadable. Can the viewer still identify:
- [ ] The topic/category of the content?
- [ ] The priority level (urgent / normal / background)?
- [ ] Where to look first?

If any answer is no → redesign Layer 1.

### Check 2 — Surprisal Test (Layer 3)
Ask: "Could the user have predicted this information before opening the interface?"
- If yes (probability P = 1.0) → Bit cost is 0. This is noise. Delete or demote to Layer 1.
- If no → This earns its place in Layer 3.

### Check 3 — Budget Estimate
Calculate the total bit cost of the experience:
- `Total Bit Cost = (Engagement seconds) × 39`
- Compare against the 184 KB daily budget context.
- Ask: is this a "high-Surprisal investment" or "expensive noise"?

---

## Context-Specific Design Patterns

### Civic Tech Dashboards (Mines Near Me, Factories Near Me, Tan Fun Tan Fai)
- **Layer 1:** Map color = status. Must work without any text.
- **Layer 2:** Maximum 3 filter categories. Proximity, severity, type.
- **Layer 3:** One facility/event card with the single most non-obvious fact surfaced first.
- Crisis mode (user is stressed): reduce total information density by 30%. Increase whitespace. Limit to 2 actions max.

### Portfolio / Personal Brand (visarutsankham.com)
- **Layer 1:** The "vibe" of the work communicates before any text is read.
- **Layer 2:** 3 career pillars maximum. Recruiters must not be asked to self-categorize.
- **Layer 3:** One specific, unexpected achievement per pillar — not a job description.
- Signal 39 framing for client pitches: "I reduce the Meaning Tax on your stakeholders so they have bits left to make a decision."

### Investigative / Long-form Reports
- Lead with the single highest-Surprisal finding — the title IS the finding, not a topic label.
- Use the Breath Rule between every major section.
- Every chart must answer exactly one question. If it answers two, split it.
- "If a 21-minute article costs 6 KB, it must contain enough Surprisal to justify the spend."

### Documentary / Video Communication
- Visual Parallelism is non-negotiable.
- Layer 1 = shot composition and color grade.
- Layer 2 = lower-third categorization (max 3 recurring graphic templates).
- Layer 3 = the one quote or data point that the entire piece was built around.

---

## Anti-Patterns (Information Violence)

These waste the user's cognitive budget. Never ship with these present:

| Anti-Pattern | Why It Fails |
|---|---|
| Full data tables as the primary view | Forces serial search instead of chunked meaning |
| 5+ navigation items flat | Doubles Bit-Tax per Hick's Law |
| Decorative animations on idle state | Consumes Layer 1 channel with zero Surprisal |
| Chart titles that repeat axis labels | Costs bits, adds zero Surprisal |
| Color used only for aesthetics | Wastes the highest-bandwidth free channel |
| Information presented without context of "so what" | P = 1.0, bit cost = 0, delete it |
| Modal dialogs for non-critical info | Forces context switch, burns clearing cost |
| Auto-playing audio without visual sync | Splits 39 bps budget, causes data starvation |

---

## Output Quality Standard

A Signal 39-compliant design can be described with this sentence:

> "A user at maximum cognitive depletion, in a noisy environment, on a mobile screen, can extract the highest-value insight within 5 seconds — at zero conscious tax."

If you cannot write that sentence truthfully about a design, it is not done.
