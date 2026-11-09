# Product

## Register

product

## Users

Two groups share the same portal:

- **Ordinary people** who built a small app with an AI chat (a shopping list, a quote calculator, a training diary) and want it to live somewhere real. They are not developers. They open the portal on their own PC or on a small server, often only a few times a month, to see their apps, get the connector set up, or check that something is still online.
- **Self-hosting enthusiasts and small teams** who install Apprua on a server and publish many apps. They come back often and want speed and precision.

The job on the main screen: *see my apps and whether they are fine, open one, and (the first time) get from zero to the first published app.*

## Product Purpose

Apprua gives apps built with AI a real address on the user's own server or PC, with one sentence to their AI app ("Publish this app on Apprua"). The portal is where people create their personal key, connect their AI app, and look after what they published. Success: a non-technical person goes from install to their first app online without reading documentation, and feels their apps are in safe hands.

## Brand Personality

**Calm, precise, welcoming.** A lighthouse: orderly and trustworthy, never anxious or loud. Plain everyday words instead of technical jargon ("personal key", "what's happening", not "token", "logs"). Small human touches are allowed at the right moments (the lighthouse lights up when the first app goes online), never as decoration. Visually it is a risograph print in four inks (see DESIGN.md "Bicromia"): it should never look like a generic AI-made interface. References: Things and Apple apps for calm and care; Linear and Raycast for precision; Notion and Arc for warmth.

## Anti-references

- The generic "AI-made dashboard": dark developer panel, three identical cards with icons, purple/indigo gradients, glassmorphism, cream backgrounds with terracotta, uppercase eyebrows over every heading, emoji as icons, Inter everywhere.
- Hosting control panels (Coolify, cPanel, typical PaaS dashboards): walls of buttons, technical status codes, commit hashes and build jargon in the user's face.
- Error-red for normal states (an app that is paused is not a failure).

## Design Principles

1. **Speak human.** Name things by what people recognise; hide internals (commit IDs, engine names) unless asked.
2. **One obvious next step.** Every screen and every app row has one primary action; the rest is one click away in a menu.
3. **Calm by default.** State is shown quietly and truthfully; alarm colours only for real problems.
4. **Teach once, then get out of the way.** First-run guidance is a checklist that disappears when done.
5. **Works anywhere, owns nothing outside.** Offline, on localhost, no external fonts or scripts: everything ships with Apprua.

## Accessibility & Inclusion

WCAG 2.2 AA: text contrast ≥ 4.5:1 (large text ≥ 3:1) in both light and dark themes, visible keyboard focus, every action reachable by keyboard, labels on all controls. The typeface (Atkinson Hyperlegible Next) is chosen for low-vision legibility. Motion is short and functional and turns off with `prefers-reduced-motion`. Italian and English, with room for longer translated strings.
