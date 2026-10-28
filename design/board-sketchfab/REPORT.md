# Sketchfab search: split-flap / departures board (reference and render sources)

Fetched 2026-10-28 via the public Sketchfab API (no login, no token). Thumbnails are the largest image each API result offered, in `thumbs/` (named by first 8 chars of the model uid). Raw search JSON is in `data/`.

Result: the public catalogue has very few real split-flap boards. Every download endpoint returned HTTP 401 (needs a signed-in Sketchfab session), so **nothing was downloaded and no renders were made**. Use the URLs below in your own signed-in Chrome if you want any of them.

Licence note: "None" means the author set no CC licence (all rights reserved) and the model is not downloadable. Skip those for rendering; they are only usable as visual reference by looking at them on Sketchfab. "Standard / Free Standard" is Sketchfab's own licence: use allowed commercially and in derivative works, but you may not redistribute the model file itself.

| Rank | Title | Author | URL | Licence | Tris | Downloadable | Fit for a heavy steel board hung on two rods, front view |
|---|---|---|---|---|---|---|---|
| 1 | Airport Departure Sign (thumb 9f07d8d1) | assetfactory | https://sketchfab.com/3d-models/airport-departure-sign-9f07d8d1db624a0b90c49a453f15e6b8 | Free Standard | 1,354 | yes, needs login | Closest layout: two-panel amber-on-dark board hung from two vertical rods, steel-grey frame. Very low poly and flat/cartoon shading, so reference for proportions and rod layout only, not a hero render. |
| 2 | Digital train information board (a2266d78) | Sousinho | https://sketchfab.com/3d-models/digital-train-information-board-a2266d78e8f24a5ab4ffba19528ed581 | Standard | 5,376 | no | Two boards on hanging rods with a believable dark worn finish and amber text. Best realism for rods and brackets, but it is an LED board, not flaps, and cannot be downloaded. Reference only. |
| 3 | New Flight Information Sign (42693cc3) | ArtSize3D | https://sketchfab.com/3d-models/new-flight-information-sign-42693cc3680046c3a495c438de0b6a2e | None | 14,656 | no | Real departures-board look (amber type on dark glass, thick frame), tilted view. Reference only. |
| 4 | Animated Split-flap Display, rigged (2db73247) | IZ.MdVerz | https://sketchfab.com/3d-models/animated-split-flap-display-rigged-glb-fbx-blend-2db7324712994dad8b95e8c3836aac62 | None | 275,578 | no | Genuine split-flap grid with real flap geometry and a black body. Great flap-detail reference; no frame or rods. Not downloadable. |
| 5 | Modular Rigged Split Flap Display Segment (91079055) | IZ.MdVerz | https://sketchfab.com/3d-models/modular-rigged-split-flap-display-segment-91079055b5a54d3b92f459c8a219fe0e | None | 6,880 | no | One flap drum segment, shows the flap stack. Reference only. |
| 6 | Split Flap Counter (0bc03ff7) | jvvince | https://sketchfab.com/3d-models/split-flap-counter-0bc03ff797b04c0499b4acea003669bb | CC-BY 4.0 | 41,932 | yes, needs login | Single character module, clean, good detail of the flap pivot and housing. Could be duplicated into a grid, but it is plastic-black with no steel frame. Credit required. |
| 7 | Split Flap Counter (47d77b1f) | jvin | https://sketchfab.com/3d-models/split-flap-counter-47d77b1f6c2c4aeca0ef1a37d218b40c | CC-BY 4.0 | 41,932 | yes, needs login | Same model as rank 6 by a second account. Same verdict. |
| 8 | Split-flap (23d412e6) / Split flap (e45f36e8) | jvvince / jvin | https://sketchfab.com/3d-models/split-flap-23d412e6aa0e46babd8eeeba3da768aa , https://sketchfab.com/3d-models/split-flap-e45f36e8cf4a4c99a69b099ccc741c33 | None | 121,536 | no | Higher-detail version of the same single module. Reference only. |
| 9 | Departure Board - Asset (0437ba00) | Madison Riley | https://sketchfab.com/3d-models/departure-board-asset-0437ba00278346b89e2cb89b97b0c7bb | None | 128 | no | Amber dot-matrix board with two top rods; worn metal look in the thumbnail. Reference only. |
| 10 | Airport Departure Board (82849aeb) | Ellis Fossett | https://sketchfab.com/3d-models/airport-departure-board-82849aebd85c4c3c85b455c1e9f41037 | CC-BY 4.0 | 140 | yes, needs login | A flat yellow-header sign with blank black panels. Not a flap board, no rods. Only useful as a plain slab. |
| 11 | FlipDot Frame (006c6c46) | Jorge Dennis Goytia Valdivia | https://sketchfab.com/3d-models/flipdot-frame-006c6c468ef7427589861be02ee2c104 | None | 88,798 | no | Real industrial steel frame hardware (flip-dot, not flap). Reference for rivets and frame construction. |
| 12 | a hanging wrought iron bracket (53b8ff4e) | Cici.Andersen | https://sketchfab.com/3d-models/a-hanging-wrought-iron-bracket-53b8ff4e1e934fb9803caf00eabaea6d | None | 351,734 | no | Ornate scroll bracket, wrong style and over the poly budget. Skip. |

Also seen and rejected: Minimal Flip Clock (1b0084bf, CC-BY, 720 tris, toy-like white plastic), Deutsche Bahnhof Kehl (a building).

## Attribution text, for the CC-BY items if used
- "Split Flap Counter" by jvvince (https://sketchfab.com/3d-models/split-flap-counter-0bc03ff797b04c0499b4acea003669bb) is licensed under CC BY 4.0 (http://creativecommons.org/licenses/by/4.0/).
- "Split Flap Counter" by jvin (https://sketchfab.com/3d-models/split-flap-counter-47d77b1f6c2c4aeca0ef1a37d218b40c), CC BY 4.0.
- "Airport Departure Board" by Ellis Fossett (https://sketchfab.com/3d-models/airport-departure-board-82849aebd85c4c3c85b455c1e9f41037), CC BY 4.0.

## Downloaded / rendered
None. All `/v3/models/<uid>/download` calls returned 401 without a login.

## Recommendation
No model on Sketchfab matches "heavy steel split-flap board on two rods" well enough to use as a render source. Look at ranks 1, 2 and 4 on Sketchfab for reference (rod layout, worn finish, flap detail). If you want a source for flap hardware, the CC-BY Split Flap Counter (rank 6) is the only clean, permissive, sensible-poly one: log in yourself, download the glTF, and tile it in Blender inside a self-built steel frame with two rods. Building the frame and rods from scratch will beat any of these.
