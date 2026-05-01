# Signal 39 Design Quick Reference

**Use this checklist when creating or reviewing any UI component for Factory Near Me.**

---

## ✅ Pre-Implementation Questions

Before writing code, answer:

1. **Who is this for?** (Concerned citizen / Community leader / Researcher)
2. **What's their mental state?** (Anxious about pollution? Exploring? Researching?)
3. **What's the ONE highest-value fact?** (Distance + Risk level, not just "factory exists")
4. **How often will they see this?** (First visit vs daily user)

---

## 🎯 The 3-Layer Checklist

### Layer 1: Subconscious Hook (Zero Tax)
Can the user understand priority WITHOUT reading text?

- [ ] Status uses color (green = safe, red = high-risk type 3)
- [ ] Spatial grouping shows hierarchy (cards, sections, whitespace)
- [ ] Animation shows state change only (not decoration)
- [ ] **Blur Test**: Blur all text → can you still see priority?

### Layer 2: Chunked Gateway (Low Tax)
Is navigation chunked into digestible groups?

- [ ] Max 3 primary actions/filters visible at once
- [ ] Icons + labels (not labels alone)
- [ ] Semantic grouping (related items together)
- [ ] **Rule of Three**: Count visible options — more than 3? Group them.

### Layer 3: Deep Dive (High Tax)
Is detailed info hidden until requested?

- [ ] Progressive disclosure (click/hover to reveal)
- [ ] Show non-obvious facts only (not common sense)
- [ ] One insight per screen/card
- [ ] **Surprisal Test**: Could user predict this? If yes → delete or demote

---

## 🏭 Factory Near Me Component Patterns

### FactoryCard
```
✅ GOOD:
• Risk dot (Layer 1: 8px, green/red)
• Name + Distance (Layer 2: semibold, one line)
• Owner details (Layer 3: expand on click)

❌ BAD:
• No color indicator
• All details visible by default
• Long address text up front
```

### Sidebar Filters
```
✅ GOOD:
• Search input (large, prominent)
• Province dropdown (sorted by count)
• 3 filter pills max (High-Risk, Radius, Type)

❌ BAD:
• 5+ filter checkboxes
• Province as searchable autocomplete
• Filters hidden in collapsed menu
```

### MapWrapper
```
✅ GOOD:
• Choropleth shows density without reading
• Selected factory has pulse animation
• Max 200 markers displayed (performance)

❌ BAD:
• All 63k markers render at once
• No visual distinction for selected
• Clustering hides geographic patterns
```

---

## 🚫 Anti-Patterns to Avoid

| Don't Do This | Why It Fails | Do This Instead |
|---------------|--------------|-----------------|
| Show all factory details in list | Cognitive overload | Show name + distance, expand on click |
| Use decorative shadows/gradients | No semantic meaning | Use color for status, borders for grouping |
| 5+ filter options visible | Doubles cognitive tax | Group into 3 categories, hide rest |
| Autoplay animations on load | Wastes Layer 1 bandwidth | Animate only state changes |
| Full data table as primary view | Forces serial search | Cards with visual hierarchy |
| Modal for non-critical info | Context switching tax | Inline panels, progressive disclosure |

---

## 📱 Mobile Optimization

Mobile users have **30% less cognitive bandwidth** (multitasking, small screen):

- [ ] Sidebar becomes overlay (not side-by-side)
- [ ] Touch targets ≥ 44px (reduce precision tax)
- [ ] Auto-close sidebar on selection (reduce cleanup work)
- [ ] Reduce info density by 30% (larger text, more whitespace)
- [ ] Primary action always visible (no hamburger hunting)

---

## 🧪 Testing Protocol

### Before Marking PR Ready

**1. Blur Test** (Layer 1)
- Screenshot → apply blur → can you identify:
  - [ ] High-risk vs safe factories?
  - [ ] Selected vs unselected items?
  - [ ] Primary action button?

**2. 5-Second Test** (Layer 2)
- Show to a new user for 5 seconds → can they answer:
  - [ ] "What does this do?"
  - [ ] "What's the first action?"
  - [ ] "What's dangerous/important?"

**3. Cognitive Budget Test** (Layer 3)
- Time a typical user flow (15-45 seconds)
- At 39 bps, 30 seconds = ~150 bytes of conscious processing
- [ ] Primary insight delivered? (e.g., "3 high-risk factories 2km from me")
- [ ] Budget justified? (Is this actionable information?)

---

## 🎨 Color Usage Guidelines

### Semantic Colors (Layer 1)
```typescript
// Risk indicators (DO NOT use for decoration)
safe/low-risk:     #10B981 (green)
high-risk/type-3:  #EF4444 (red)
user-location:     #F59E0B (orange)
selected:          #1A365D (industrial blue)
```

### Neutral Colors (Structure)
```typescript
background:        #F8FAFC (slate.50)
text-primary:      #1E293B (slate.800)
text-muted:        #94A3B8 (slate.400)
borders:           #E2E8F0 (slate.200)
```

### Rules
- [ ] Max 3 hue families per interface
- [ ] Status colors never swap for aesthetics
- [ ] Color encodes data (not decoration)
- [ ] Sufficient contrast (4.5:1 minimum)

---

## 💡 Quick Wins

**If design feels "too busy":**
1. Run Data Archaeology: strip to ONE key fact
2. Check Layer 1: is color doing its job?
3. Delete decorative elements (shadows, gradients, borders)
4. Apply Breath Rule: double the whitespace

**If users say "I can't find X":**
1. Failed Layer 1: add color/position cue
2. Failed Layer 2: reduce options to ≤3
3. Failed Layer 3: make it visible by default

**If mobile feels cramped:**
1. Reduce density by 30%
2. Increase font size 1-2 steps
3. Convert sidebar to overlay
4. Enlarge touch targets to 44px minimum

---

## 📊 Success Metrics

A well-designed component achieves:

- ✅ **Time to insight**: <5 seconds (user sees risk level + distance)
- ✅ **Zero training**: No tutorial needed, Layer 1 guides behavior
- ✅ **Mobile parity**: Mobile users get same insights (no feature hiding)
- ✅ **Crisis readiness**: Works at 30% normal cognitive capacity

If any metric fails → design fails, regardless of aesthetics.

---

## 🔗 References

- **Full Skill**: `.agents/skills/signal39-design/SKILL.md`
- **Design System**: `design_system.md`
- **Client Patterns**: `client/39design.md`
- **Project Context**: `CLAUDE.md`

---

**Remember**: Every pixel is a withdrawal from the user's 184 KB daily budget.  
**Spend it only on Surprisal.**
