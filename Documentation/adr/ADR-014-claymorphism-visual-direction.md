# ADR-014: Visual Design Direction — Restrained Claymorphism on Blueprint Foundations

| Field | Value |
|---|---|
| Status | **ACCEPTED** |
| Date | 2026-10-16 |
| Deciders | Founder (Jeet), Technical lead |
| Decision ref | D-14 (approved via founder instruction "Use Claymorphism") |

## Context
The UI/UX Blueprint v1 (§8) specifies a "calm, precise, operational" visual direction with fixed color tokens, and warns against "excessive gradients, glowing AI effects, or playful chatbot styling in operational screens." The founder has directed that the product use **claymorphism** (soft 3D "clay" surfaces: rounded shapes, dual inner+outer soft shadows, gentle depth). These can conflict if claymorphism is applied at full intensity; the founder's directive takes precedence as product owner, implemented in a restrained form that keeps operational screens readable and professional.

## Decision
Apply **restrained claymorphism** layered on top of the blueprint's design tokens (do not replace them):

1. **Keep** the blueprint's color tokens as the base palette: navy `#14233B`, primary blue `#246BFD`, teal `#11A6A0` (AI accents), canvas `#F4F6FA`, surface `#FFFFFF`, border `#D9E1EC`, success `#16845B`, warning `#B76E00`, error `#B42318`, spacing scale 4/8/12/16/24/32, typography (Aptos/Inter-like sans serif).
2. **Increase radii:** inputs 10–12 px, cards/panels 16–20 px, buttons/pills 12–14 px or fully rounded, chat bubbles 16–18 px (blueprint's 6/10/14 becomes the *minimum*).
3. **Clay depth:** every raised element gets the clay double-shadow recipe — a soft outer shadow (e.g., `0 8px 20px rgba(20,35,59,.10)`) combined with a subtle **inset top highlight + inset bottom shade** (light source consistently from top-left). Pressed/active states invert the inset.
4. **Muted surfaces:** clay cards use white or very light tinted surfaces (≤6% tint of navy/teal); no heavy gradients. Status colors stay blueprint-defined and always paired with text/icon (never color alone — accessibility rule stands).
5. **Intensity tiers:** full clay treatment on primary actions, KPI cards, chat widget (customer-facing, can be friendlier); **reduced** clay (flatter shadows, smaller radii) on dense operational surfaces — inbox lists, data tables, audit log, analytics charts — to honor the blueprint's "operational clarity" principle.
6. **AI accents** keep teal with soft clay rounding; avoid glow effects.
7. All clay shadows/motion values live in design tokens (CSS variables) so intensity is tunable per surface; motion respects `prefers-reduced-motion`.
8. Accessibility unchanged: WCAG 2.2 AA contrast, visible focus, keyboard support. Clay shadows must not be the *only* affordance cue.

## Consequences
- (+) Distinct, modern, approachable product identity consistent across admin, agent workspace, and widget; token-driven so it is cheap to tune.
- (−) Heavier visual treatment than flat design requires discipline to keep dense screens scannable — mitigated by the intensity tiers.
- (−) Diverges from the blueprint's literal styling guidance; the blueprint remains authoritative for IA, flows, states, and content — this ADR governs only visual treatment.
- Review during P3/P7 UI work with real usability checks before pilot.
