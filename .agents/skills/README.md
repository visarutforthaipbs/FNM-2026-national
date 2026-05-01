# Factory Near Me — Agent Skills

This directory contains custom skills for Claude Code agents working on the Factory Near Me project.

## Available Skills

### signal39-design
**Path:** `.agents/skills/signal39-design/SKILL.md`

**When to use:**
- Designing or reviewing any UI component
- Building data visualizations or dashboards
- Optimizing for cognitive load and user attention
- Making interfaces "cleaner" or "easier to understand"
- Mobile optimization decisions
- Color palette and typography choices

**Key principles:**
- **39 bps conscious bandwidth:** Users process meaning at 39 bits/second
- **184 KB daily budget:** Respect users' limited cognitive capacity
- **3-Layer Architecture:** Subconscious Hook → Chunked Gateway → Deep Dive
- **Surprisal ROI:** Every design element must earn its cognitive cost

**Invocation:**
The skill triggers automatically when discussing:
- UI/UX design
- Information architecture
- Data visualization
- Cognitive load reduction
- User experience optimization
- "Make it cleaner/clearer/simpler"

**Quick checklist for any new component:**
1. ✅ Layer 1: Does color/position communicate status without reading?
2. ✅ Layer 2: Are choices grouped into max 3 categories?
3. ✅ Layer 3: Is detailed info hidden until requested?
4. ✅ Blur Test: Can you understand priority when text is blurred?
5. ✅ 5-Second Test: Can new users grasp purpose in 5 seconds?

## Adding New Skills

To add a new skill:

```bash
mkdir -p .agents/skills/[skill-name]
```

Create `SKILL.md` with YAML frontmatter:

```yaml
---
name: skill-name
description: When to use this skill and what it does
---

# Skill Content Here
```

## References

- [CLAUDE.md](../../CLAUDE.md) - Project context for Claude
- [design_system.md](../../design_system.md) - Visual design system
- [39design.md](../../client/39design.md) - Client-specific design patterns
