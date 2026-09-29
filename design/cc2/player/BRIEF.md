# CC-01 player: build brief for Claude Code

Jeremy approved this 3D music player in Cowork, and it replaces the now-playing sheet. The reference page is
`design/cc2/player/cc01.html`. It's a working three.js page, so open it in a browser first and lift code from it
rather than rewriting it. Build it as one step, commit, then stop and show Jeremy. Don't push or deploy until he says so.

## What it is
- A 3D player in the CC-01 design:
  - a white front with a clear coat, and a polished steel back with the CC tile (Sligoil, first C `#E6E6E6`, second C `#FF4D00`) plus "CC-01" and small print
  - a big screen and a click wheel with ☰ ⏮ ⏭ ▶❙❙
  - an orange hold switch
- Lighting: physically based materials (MeshPhysicalMaterial + RoomEnvironment). A custom tone-map and halftone block (`FILMIC`) keeps them matched to the app's black stage with its halftone dots.
- Motion to keep exactly as in the reference:
  - the idle float drawn "on twos" (12 fps)
  - the slight off-register colour (the post pass)
  - the wheel rocking and the pressed icon flashing orange
  - the loading line with animated dots (. → .. → ... → .)
- Finishes: Classic / Ink / Signal / Paper, remembered in localStorage `cc01.look`.

## Wire it to the real data (replace the made-up `TRACKS` / `S` state)
Use the existing Spotify code in `dashboard.source.html` (`startSpotify`, `pollSpotify`, `spotifyDo`, `setVol`, `/api/spotify/now`, `/api/spotify/control`).
- Screen: song, artist, cover art (draw the real cover into the square where the halftone placeholder art is now), progress, and "PAUSED" when paused.
- Center button: play / pause. Right / left: next / previous. Top (☰): opens the library list on the screen.
  - For now the list shows the last few played or queued songs if the API gives them. Otherwise just the current song.
- Spinning the wheel changes volume: one detent is 15°, and clockwise turns it up.
  - Send volume through the same debounced `/api/spotify/control {action:"volume"}` call `setVol` uses, and keep the "don't snap back mid-drag" hold.
  - When the device can't set volume, the screen says so instead of showing the bar.
- Like: long-press the center button (a 600 ms hold) to like or unlike. Flash the ring orange when it takes.
- Not connected: the screen shows "Connect Spotify" and the center button goes to `/auth/spotify`.

## Where it lives
- The album circle on Today opens it as the full-height sheet, in place of `#npsheet`. Keep the close control and the sheet behavior.
- Lazy-load three.js (the same jsDelivr importmap as the reference) only when the sheet first opens, so Today stays fast.
  - Show the loading line with the dots meanwhile.
- If WebGL isn't available, fall back to the current 2D now-playing sheet (keep it in the code for that).
- `prefers-reduced-motion`: no idle float, and less colour shift, as the reference already does.
- iPhone PWA: test at 390×844 and 430×932. The finish chips must fit on one row.

## Free-tier check
No new services and no new API calls beyond what the Spotify sheet already makes. Everything else is static assets.
