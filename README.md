# rHUD

Hand-tracked HUD in the browser. A phone (via macOS Continuity Camera) films the
hands from a POV angle; MediaPipe tracks them and three.js draws reticles locked
onto each hand. Gestures map to named actions. A WebXR path targets Quest 3.

## Run

```bash
npm install          # also fetches MediaPipe wasm + model into public/
npm run dev          # http://localhost:5173
npm run dev:lan      # https on the LAN, for headset testing
npm run build        # typecheck + production build
```

Keys: `S` skeleton, `H` debug panel, `F` blank feed, `R` re-pick camera.

Status: phases 0-5 and 7 built; not yet validated against a real camera. See `ROADMAP.md`.
