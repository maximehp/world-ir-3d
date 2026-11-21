# WorldIR 3D: 1-minute demo script

Open the studio and select each saved world from **Worlds**. Use **R** to ride along and **V** for first-person view.

---

**[1 · Text]** (~10s)
"AI tools today generate pixels. We generate *worlds*: persistent 3D scenes you can walk through and edit. Here's one sentence: *a coastal village at sunset*. Gemini compiled it into a full 3D world with buildings, a lighthouse, sculpture and seagulls."

**[2 · 2D Video]** (~10s)
"It also takes a 2D video. OpenCV tracks everything that moves, Gemini rebuilds the scene and the camera, and each bird now flies its real tracked path in 3D." *(press R: ride the bird)*

**[3 · Plan + Photo]** (~12s)
"Now a real landmark. We gave it a site plan, a photo and one line of text. The plan decides *where* things go, the photo decides *how they look*." *(click Plan View: it matches the drawing)*

**[4 · Neon] → [5 · Reclaimed] → [6 · Lava]** (~15s)
"And because it's a real world, not a picture, we can remix it. One mood board: Neon Agra 2099. Another: five hundred years later, reclaimed by the jungle. Another: forged from a volcano. Same layout, same objects. Only the style changes."

**Architecture** (~13s)
"Under the hood: Gemini compiles every input into **WorldIR**, a typed scene graph. That graph is built from four kinds of geometry: terrain, parametric architecture, sculpted SDF meshes, and animated agents. Nano Banana generates the textures, and edits are surgical diffs with instant undo. Three.js renders it live in the browser."

---

### Backup lines if asked
- **Is it real 3D?** Walk in with **F**, or ride with **R**. Every view is rendered from the same scene graph.
- **How long does generation take?** About 1–3 minutes per world. These were pre-generated for time.
- **What's it for?** Architecture concepts from a sketch + mood board, game and film previz, synthetic training data for robotics.
