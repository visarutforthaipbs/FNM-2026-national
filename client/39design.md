# SIGNAL 39: Universal Cognitive Design System
**Version:** 2.0 (Cognitive Resource Accounting)
**Objective:** To build human-synchronous interfaces that optimize "Meaning ROI" and respect the biological limits of human attention.

---

## 1. CORE PHILOSOPHY: COGNITIVE ASSET MANAGEMENT
This project does not compete for "Time spent on page." It competes on **Cognitive Absorption**. We treat user attention as a finite currency called **Attention Cost (ค่าความสนใจ)**.

* **The Biological Limit:** The human brain processes conscious meaning at a strict maximum of **39 bits per second (bps)**, while the subconscious processes 11,000,000 bps.
* **The Daily Wealth:** The average user has a net high-value cognitive budget of roughly **184 KB per day**. 
* **The Prime Directive:** Never tax the user's 184 KB budget for predictable, decorative, or noisy elements. Maximize "Surprisal" (High Entropy) while minimizing the "Decoding Tax".

---

## 2. THE 3-LAYER UI ARCHITECTURE
Every page, component, and user journey must be structured through these three layers:

### LAYER 1: Subconscious Hook (11M bps / Zero Tax)
* **Target:** Instant status, priority, or "vibe" before reading.
* **Execution:** Use pre-attentive attributes (color coding, spatial grouping, scale).
* **Rule:** If a user must read text to understand the *hierarchy* or *threat level*, Layer 1 has failed. 
* **Color Palette:** Use muted, low-contrast "background" colors for structure, and high-contrast "signal" colors strictly for anomalies or primary actions.

### LAYER 2: Chunked Gateway (5-10 bps / Low Tax)
* **Target:** Categorization and pathfinding without cognitive overwhelm.
* **Execution:** Use minimalist iconography and micro-copy (max 3-5 words). 
* **Rule of Three:** Group variables into a maximum of three or four logical "Chunks." Avoid infinite lists. Use visual boundaries (cards, soft borders) to contain semantic meaning.

### LAYER 3: Conscious Deep-Dive (39 bps / High Tax)
* **Target:** Delivering the high-entropy core value (data, narrative, action).
* **Execution:** Progressive Disclosure. Hide complex data tables, long-form text, or secondary settings behind toggles, modals, or "read more" states.
* **Rule:** Only activate the 39 bps pipe when the user explicitly requests the deep dive. 

---

## 3. UI/UX "ANTI-NOISE" RULES (STRICT SOP)

1.  **Zero Decorative Pixels:** If a border, shadow, or gradient does not carry specific data or semantic meaning, delete it. 
2.  **The "Cognitive Breather" (Whitespace):** Use generous padding and margins (e.g., `p-8`, `gap-6` in Tailwind) between different semantic chunks. Do not cram data together; the brain needs space to encode information into memory.
3.  **Typography Constraints:** Limit to 2 font families. Restrict font weights to 3 variables (e.g., normal, medium, bold).
4.  **Visual Parallelism:** Icons must semantically match the text exactly. Do not use generic icons. 
5.  **Minimize Context Switching Tax:** Avoid forcing the user to jump between separate pages for related data. Use side-panels, slide-overs, or integrated data visualizations to keep the user's mental model intact.

---

## 4. UNIVERSAL COGNITIVE COMPONENTS (CRA)
When applicable, implement **Cognitive Resource Accounting (CRA)** features:

* **The Cognitive Price Tag:** Replace "Read Time" or "Complexity" with an upfront Attention Cost estimate (e.g., `Attention Cost: 1.2 KB`).
    * *Formula:* `(Seconds of engagement * 39 bps) / 8192 = KB Cost`
* **Entropy Indicators:** Use subtle progress bars or heatmaps to indicate where the "high-density" information lives on a page.
* **Meaning ROI Summaries:** At the end of a long user flow (checkout, article, data report), provide a "Receipt" summarizing the value extracted versus the cognitive tax paid.

---

## 5. SYSTEM INSTRUCTIONS FOR AI ASSISTANTS
When generating code, components, or copy for this project, you MUST adhere to the following:
* **Prioritize Signal-to-Noise:** Always choose the simplest HTML/CSS structure.
* **Use Tailwind CSS:** Rely on utility classes for precise, consistent whitespace.
* **Use Lucide-React (or equivalent):** For minimalist, semantic iconography.
* **Self-Correction:** Before outputting a UI component, perform the "Mute/Blur Test". If the text is blurred out, does the visual hierarchy still convey the purpose of the component? If no, redesign.