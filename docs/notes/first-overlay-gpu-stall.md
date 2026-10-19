# The first overlay's GPU stall (unsolved)

Status: not fixed. A one-time frame stall of about 150-250 ms the first time anything takes the focus from the address bar in a window. Low
user impact (once per window, a single dropped frame), but it makes `test/files-perf.js` fail ("browser UI picker-open: 1 missed frame, a
100-120 ms frame") on a clean machine, because the test's first picker open is the first focus change in its window.

## What it looks like

- The first Ctrl+Shift+F (Files picker) or Ctrl+Shift+A (tab search) in a fresh window. Later opens are clean. Not part of the picker: tab search shows it too.
- A plain `document.activeElement.blur()` on the address bar reproduces it with no overlay at all. So does focusing any other input.
- A frame gap of 130-230 ms (rAF interval), about 450 ms after the focus change; about 200 ms after it when CSS transitions are off.
  The renderer main thread is not busy: no script in the long-animation-frame entry, `renderStart` equals the frame's duration.
- It only happens once per window; the address bar is focused when a new window starts, so the first time it lets go is the first time.

## Trace evidence

Chromium trace of the UI renderer, GPU process and viz around the stall (Tracing via `webContents.debugger`, categories
`devtools.timeline,blink,cc,gpu,viz,skia`):

- one `GPUTask` of 130-210 ms on the GPU main thread (`GpuChannel::ExecuteDeferredRequest` > `RendererRasterWorker` >
  `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`);
- inside it, two `ANGLEPlatformImpl::RunWorkerTask` entries of 36-40 ms each, which looks like a shader compile the first time a draw needs a new program;
- the renderer's frame waits on it. A freeze capture (`viz::mojom::CopyOutputResultSender::SendResult`) comes about 400 ms before, but see below: freezing is not the trigger.

## Ruled out (each tried in a fresh session, gap-based, 2-3 runs unless noted)

- The Files picker: its own CSS (shadow, radius, scrim, footer, results, input), lazy loading of its script and stylesheet, a see-through pre-draw of the panel (with and without rows).
- The page freeze (`freezePage`/`thawPage`, `view:freeze`): a freeze alone, and a freeze/thaw warm-up beforehand, do not remove or cause it; opening with `freezePage` stubbed out still shows it.
- Edge-colour computation (`edgeColor`, `createImageBitmap`) stubbed out.
- Focusing a text box in advance (a hidden see-through input, 300 x 38, 15 px): does not remove it. A *blur of the address bar* (or a new input taking the focus from it) is what triggers it.
- CSS: `.omnibox` transitions (background / box-shadow / scale) removed, `will-change: transform`, scale removed, the ring as an opacity-faded `::after`,
  the focused input's fade-in removed, `.omnibox-end` / `.omnibox::after` transitions removed, `* { transition: none; animation: none }`.
  The stall stays; with transitions off it only arrives sooner (about 200 ms instead of 450 ms), so it is not the end of an animation.
  One early reading that "transition: none" was clean came from counting only long animation frames; the rAF gaps showed it was still there.
- Resting-state elements of the bar hidden in turn (`.omnibox-end`, `.security`, `text-overflow`, shadow and background).
- A see-through, inert clone of the bar at rest drawn at idle after start.
- Moving the real focus at start (blur and refocus the bar at 3 s): rejected on accessibility and typing-safety grounds, and it was not tried as a shipped fix.

## Last experiment (inconclusive)

Stubbing the blur handler's calls (`window.hideSuggestions = () => {}`, `window.showAddress = () => {}`) before a plain blur left only a 33 ms gap in
the runs that finished (hideSuggestions: 2 of 2, showAddress: 1 of 1; the combined stub was cut off). That points at the work the address `blur`
listener starts (`hideSuggestions()` 150 ms later, `showAddress()`), but main's `hideSuggestions` is a no-op while the dropdown view does not
exist, and `showAddress` only sets the field's value and the lock. Samples are small and the stall also varies from run to run (a clean run
now and then), so this needs more runs before it is believed.

## Next ideas

1. Repeat the stub experiment with 5+ runs each, and add a stub of only the `showAddress` call inside the blur listener versus only the `hideSuggestions` timeout.
2. Trace with `gpu.service` and `skia` categories at the stall and read the `GrGLProgramBuilder` / shader names to learn which draw needs the program; `chrome://gpu` or `--enable-gpu-service-logging` with `--use-angle=d3d11` may name it.
3. Check whether the test machine's graphics mode (`graphicsMode`, #518) changes it (software GL vs ANGLE D3D11): run with `--disable-gpu` and with the default.
4. If it is a program compile, prime it where it can be drawn without a focus change: draw the address bar's focus ring or `:focus-visible` outline (`outline: auto`) on a see-through inert element once at idle; the clone experiment above did not cover the focused look, which a clone cannot get without taking the focus.
5. As a fallback for the perf test only (not for users): have `files-perf` open and close the picker once before measuring, as a warm-up phase that is reported. That changes what the test measures and would need the owner's agreement.

Measurement scripts used (not committed): a rig that launches the app through playwright-core with a throwaway profile, records
`PerformanceObserver` `long-animation-frame` entries plus rAF gaps over 25 ms, and performs one action (key, blur, focus, freeze) per fresh session.
