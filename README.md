# Off-axis projection viewer

Head-coupled "window into a box" in Three.js, following `base plan.txt`
(Kooima's generalized perspective projection, real units: 1 unit = 1 m).

```sh
npm install
npm run dev      # http://localhost:5173
```

Pick a model under **Model → View** (or `[` / `]`). Every `.glb` placed under
`models/` is picked up automatically; one model is shown at a time.

| Key | Action |
|---|---|
| `1` `2` `3` | Mouse / auto-orbit / webcam head tracking |
| `C` | Calibrate physical size (bank card or display diagonal) |
| `F` | Fullscreen (the most accurate mode: canvas = whole display) |
| `D` / `H` / `W` / `G` | Debug view / HUD / webcam view / settings panel |

Changes apply live; **Settings → Save** stores them (one saved instance; the back-wall
image goes to IndexedDB). **Revert to saved** / **Reset to defaults** switch back. Card
calibration is saved immediately. The URL can override any setting, e.g.
`?tracker=auto&model=__test__&debugView=false`.

## Layout

| File | Role |
|---|---|
| `src/offaxis.js` | `OffAxisScreen` + `updateOffAxisCamera()` |
| `src/eye/` | `MouseTracker`, `AutoTracker`, `FaceTracker` (MediaPipe, self-hosted WASM + `public/face_landmarker.task`). File names avoid "track": ad blockers block such URLs. |
| `src/HeadFilter.js` | One-Euro smoothing, hold-then-ease-back on tracking loss |
| `src/AlignmentBox.js` | Grid-textured calibration room behind the screen |
| `src/DebugView.js` | Third-person viewport with frustum, eye and webcam markers |
| `src/ModelStage.js` | Loads/disposes a single model and fits it to the room |
| `src/Calibration.js` | Card-matching / diagonal calibration dialog |
