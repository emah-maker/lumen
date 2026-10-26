# Screen recording

Record the current tab, or a whole screen or one window, to a video file. It is meant for class demos and bug reports: record the steps, then attach the file.

## Start

Open **⋯ → Record** (**File → Record** on a Mac), or press Ctrl+K and type "record" (**Record tab**, **Record screen**, **Stop recording**):

- **Record this tab** records the page in the tab you are looking at, including its sound.
- **Record screen or window…** shows the same menu of screens and windows as sharing your screen. Pick one, or close the menu to cancel.
- **Include sound from the tab or PC** (on by default). For a tab it is that tab's sound; for a whole screen on Windows it is what the PC is playing. A single window has no sound.
- **Include the microphone** (off by default). Tick it to add your voice. If Windows does not let Lumen use the microphone, Lumen says so and does not start; untick it to record without.

- **Save as MP4 instead of WebM** appears only when Lumen's built-in recorder can write MP4 on your computer. Off by default.

The switches apply to the next recording you start.

## While it records

A small bar appears at the top of the screen with a timer, **Pause** (then **Resume**) and **Stop**. The bar is not part of a screen recording. The ⋯ → Record menu shows **Pause** and **Stop recording** while one is running.

A recording also ends by itself when the tab you were recording closes, when you stop sharing the window, or when you quit Lumen. What was recorded so far is kept.

## When you stop

The video is saved in your Downloads folder (or the folder you chose in Settings → Downloads and files) as a `.webm` file named for what it shows and when:

- `Lumen tab recording - example.com - 2026-10-19 14-32-05.webm`
- `Lumen screen recording 2026-10-19 14-32-05.webm`

It appears at the top of the Downloads list, and the bar changes to "Saved …" with **Show in folder**. It stays for a few seconds; the Downloads panel has the same Open and Show in folder buttons afterwards. A second recording never overwrites the first: it gets "(1)", "(2)", and so on.

The format is WebM: VP9 video and Opus sound. MP4 (H.264) is offered as an option only where the built-in recorder supports it. Chrome, Edge, Firefox, VLC and most editors play it; the Windows Movies & TV app may not. The file is written while you record, so a long recording does not fill memory.

## Privacy

Nothing is uploaded. The video is only written to your Downloads folder. Lumen's own recorder window is the only page that may capture for this, and only while a recording is starting; websites keep asking for their own camera, microphone and screen as before. The microphone is used only if you ticked it, and only while a recording runs.

## For developers

The code is `src/features/screen-recorder.js` (main process, loaded the first time you record), `src/renderer/recorder.html` and `recorder.js` (the recorder window: MediaRecorder and the bar) and `src/preload/recorder-preload.js`. A tab is handed to the recorder by the display-media handler in `src/main.js`; a screen or window goes through the screen-sharing picker. Tests: `test/units/screen-recorder-units.js` (plain Node) and `test/e2e/screen-recorder.js` (a tab recording of a local page in a hidden window; it never captures the real screen).
