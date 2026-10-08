# Button audit

Every button, toggle, slider, link and form control, with what it calls and what the user sees. The end-to-end script `scripts/e2e.mjs` exercises the ones marked with a star, and `scripts/e2e-backend.mjs` exercises the ones marked with a dagger against the real back end. No control is inert. Controls that need the back end are disabled with the reason when it is not connected.

"Store" means the saved state in `src/store/app.ts`. "Runner" means the live simulation in `src/engine/live.ts`.

## Shell, on every page

| Control | Handler | Result |
| --- | --- | --- |
| Skip to content link | Browser anchor | Focus moves to the main region |
| Wordmark link * | Router | Goes to Home |
| Junction select, with four example videos * | `loadDemo`, `leaveDemo` | Loads the example's drawing, video, saved analysis and demand so every page shows its real results. Asks before replacing your own junction |
| Junction select (sample) | `setJunction(SAMPLE_JUNCTION)` | Switches to the sample junction and shows a toast |
| Back end badge † | Opens the Back end dialog | Shows connected, checking, needs a model or not connected |
| Back end dialog: address, access key, Check again † | `setUrl`, `setApiKey`, `check` | Saves the address, re-runs the health check, shows version, model, queue, limits |
| Back end dialog: Where simulations run † | `setSimulation` | Browser (default) or back end. Same numbers either way |
| Keyboard shortcuts button * | Opens dialog | Lists every shortcut. Escape closes |
| Theme button * | `ThemeContext.toggle` | Switches light and dark, saved in the browser |
| Navigation links (ten) * | Router | Goes to the page and marks it current |
| Bottom navigation (under 768 px) | Router | Same links as icons |
| Terms and Privacy links | Router | Opens the legal pages |
| Keys: Space, [, ], R, E, G then letter, ? * | `emit()` events and `useCommands` | Play or pause, speed, restart, emergency, go to page, help |

## Home

| Control | Handler | Result |
| --- | --- | --- |
| Open the console, Set up your junction * | Router | Goes to Console or Setup |
| Scenario A or B * | `setHs` | Rebuilds both simulations for that scenario |
| Restart, Step, Play or Pause * | Runner | Restarts, advances one second, toggles playback |
| Speed 1x to 8x * | `runner.setSpeed` | Changes playback speed |
| Pipeline steps (six) * | `setStep` | Swaps the panel for that step |
| Video only, Video plus twin * | `setMode` | Shows one line or two |
| Traffic seed field | `setSeed` | Redraws the chart on new traffic |
| New traffic * | Random seed | Redraws the chart |
| North surge slider * | `setMult` | Recomputes the red-time chart and the guard counts |
| Read the full method | Router | Opens Method |

## Setup

| Control | Handler | Result |
| --- | --- | --- |
| Import JSON * | Opens dialog | Validates with Zod, shows the first problem or loads the junction |
| Export JSON * | `downloadText` | Downloads the junction as JSON |
| Step buttons (five) | `go(n)` | Moves, or shows why the step cannot be skipped |
| Video drop zone and Choose file | `onVideo` | Checks type, size and length, reads metadata, loads the video |
| Counts drop zone and Choose file * | `onCsv` | Parses with row-level error messages |
| Download the template | `downloadText` | Downloads a sample CSV |
| Use the sample junction * | `useSample` | Loads the sample draft |
| Drawing tools (select, stop, upstream, zone) * | `setTool` | Changes what pointer input does |
| Undo, Redo * | History stack | Restores the previous or next drawing |
| Approach selector | `setAp` | Chooses which approach is drawn |
| Clear approach * | `setGeometry` | Removes that approach's shapes |
| Video play, step, frame slider | Video element | Chooses the frame to draw on |
| Drawing area: drag, click, handles, arrows, Delete, Enter, Escape * | `GeometryEditor` | Draws, moves and removes shapes. Keyboard works |
| Calibration tools, Clear points * | `setCalPoints` | Places or clears the four points |
| Distance fields (four) | `setDists` | Updates the fit, error and top-down preview |
| Phase count | `setTiming` | Two or four phases |
| Green, yellow, all red fields | `setTiming` | Validated against the minimum green |
| Mark green start and end, Use for phase | Stopwatch | Times a green from the video clock or the real clock and fills a field |
| Junction name field | `setName` | Required to save |
| Back, Continue * | `go` | Moves, with the reason shown when disabled |
| Save draft | `saveDraft` | Stores the draft in the browser |
| Reset step | `resetStep` | Confirms, then clears the step |
| Save junction * | `save` | Writes the junction to the store |
| Analyse video † | `AnalysePanel.start` | Asks for consent once, uploads with progress, queues, shows stages and time left, then stores the result |
| Upload and analyse (consent notice) † | `giveUploadConsent` | Records the answer in this browser and starts |
| Cancel (during an analysis) † | `AbortController.abort` | Stops the upload or job and tells the server to cancel |
| Try again, Analyse again † | `start` | Repeats the analysis, answered from cache when nothing changed |
| Open Perception, Use in Demand | Router | Opens the page that uses the result |

## Perception

| Control | Handler | Result |
| --- | --- | --- |
| Import perception file * | Opens dialog | Validates against the schema and loads detections |
| Detection source: Sample feed, Imported file, Back end *† | `setSource` | Switches the view. Back end is disabled with the reason until the server is connected |
| Signal logic on this feed: VAC, Fixed plan as recorded, SignalTwin * | `setLogic` | Rebuilds the sample feed with that signal logic. VAC is the default |
| Layer checkboxes (five) * | `setLayers` | Show or hide boxes, track numbers, counting lines, queue zones, speeds |
| Transport and scrubber * | Runner | Plays, steps and seeks the sample feed |
| View as table (each chart) | `ChartFrame` | Swaps the chart for its numbers |
| Remove the current file | `setPerception(null)` | Clears the imported detections |
| Video controls on your video † | Video element | Plays and scrubs. Boxes follow the frame on screen. Lines and zones are drawn from your drawing |

## Demand

| Control | Handler | Result |
| --- | --- | --- |
| Recompute * | `setTick` | Re-runs the estimate |
| Export demand CSV * | `downloadText` | Downloads the profile |
| Apply to junction * | `setDemand`, `setParams` | Saves the profile, and optionally the measured saturation flow |
| Bin size * | `setBin` | Re-bins the counts |
| Smoothing slider | `setAlpha` | Changes the moving average |
| Approach checkboxes, Show raw bins | `setShow`, `setRaw` | Show or hide lines |
| PCU and people fields, Reset to defaults | `setParams` | Edits the vehicle table |
| Use measured saturation flow | `setUseSat` | Includes it when applying |
| Scenario length, load sliders, surge window fields | Local state | Updates the live preview |

## Twin

| Control | Handler | Result |
| --- | --- | --- |
| Transport, Twin seed | Runner | Plays the twin and changes its seed |
| Calibration fields (four) * | Local state | Re-runs the validation and the verdict |
| Accept calibration * | `setParams`, `setCalibrated` | Saves the values as the parameters |
| Revert inputs | Local state | Returns to the saved values |

## Controller

| Control | Handler | Result |
| --- | --- | --- |
| Plan shown: SignalTwin or VAC * | `setPlan` | Switches the run. VAC shows what the detectors see instead of phase scores |
| Transport and scrubber * | Runner | Scrubs to any second. The score panel follows |
| Beta, gamma, horizon, margin sliders | `setParams` | Changes the controller and rebuilds the run |
| Minimum green, maximum green, fairness cap fields | `setParams` | Same, and updates the guarantee text |
| Objective, look-ahead, emergency priority, fairness guard, clear standing queue first | `setObjective`, `setOptions` | Same |
| VAC passage time | `setParams` | Changes the detector gap that ends a vehicle-actuated green |
| Reset to tuned defaults * | `setParams` | Restores the defaults |
| Run grid search, Cancel * | `startExperiment` | Sweeps beta and gamma in the worker, fills the table |
| Apply the best weights * | `setParams` | Saves the best pair |
| Log filter, search * | Local state | Filters the decision log |
| Export CSV | `downloadText` | Downloads the log |
| Log row hover | `highlight` ref | Lights the approach on the junction |

## Console

| Control | Handler | Result |
| --- | --- | --- |
| Scenario, Compare against (Observed, Webster, VAC), Objective * | State and store | Rebuilds both simulations |
| Clear standing queue first * | `setOptions` | Holds green until the vehicles in the queue zone at the start of the green have left |
| Fairness cap, Detection noise sliders * | `setParams`, `setNoise` | Same |
| Seed field * | `setSeed` | Same, and updates the address |
| Platoon look-ahead * | `setOptions` | Same |
| Emergency approach and Send * | `runner.triggerEmergency` | Adds the vehicle to both runs and logs the response |
| Load by approach and four sliders * | `setMult` | Switches to Custom and rebuilds |
| Transport and scrubber * | Runner | Play, step, restart, seek, speed |
| Panel splitter, mouse and arrow keys * | `setSplit` | Resizes the decision and proof panels |
| Tabs under 1280 px | `setTab` | Shows one panel at a time |
| Run 20 seeds, Cancel * | `startExperiment` | Fills the comparison table and saves the run |
| Download this run * | `downloadText` | Downloads decisions and metrics |
| Open these results in Experiments | Router | Opens Experiments |

## Experiments

| Control | Handler | Result |
| --- | --- | --- |
| Seeds per run * | `setSeeds` | Sets the number of seeds for every run |
| Tabs: Scenarios, Ablation, Noise, Fairness * | `setTab` | Switches the view |
| Scenario definition sliders | `setScA`, `setScB` | Edits the scenarios |
| Run both, Run A only, Run B only * | `runScenarios` | Runs and fills the tables |
| Cancel * | `job.cancel` | Stops the run |
| Reset definitions | `setScA`, `setScB` | Restores A and B |
| Scenario A or B result tabs * | `setView` | Switches the table |
| Run ablation, Run noise test * | `runAblation`, `runNoise` | Runs and fills the table or chart |
| Export CSV (each tab) | `downloadText` | Downloads that tab's data |
| Restore, Clear history * | `setCmp`, `clearRuns` | Brings back or removes saved runs |

## Report

| Control | Handler | Result |
| --- | --- | --- |
| Section checkboxes (six) * | `setOn` | Shows or hides sections |
| Scenario tabs | `setView` | Switches the report scenario |
| Download CSV * | `downloadCsvFile` | Downloads the selected sections |
| Download PDF * | `window.print` | Opens the print dialog with a print stylesheet |
| Copy summary as text * | `copyText` | Copies a plain summary |
| Download all raw data * | `downloadBlob` | Downloads the junction, parameters and runs as JSON |
| Go to the Console | Router | Opens Console |

## Parameters

| Control | Handler | Result |
| --- | --- | --- |
| Import, Export * | `importFile`, `downloadText` | Loads or saves parameters as JSON, with range checks |
| Reset all * | `resetParams` | Confirms, then restores every default |
| Search, Clear search * | `setQ` | Filters the parameters |
| Every value field * | `setParams` | Edits the value and marks it Changed |
| Reset group buttons * | `resetGroup` | Restores one group |
| Four-phase toggle | `setParams` | Switches phase mode |
| Reset vehicle classes | `setParams` | Restores the table |
| Reset to the sample junction | `resetSample` | Confirms, then restores the sample |

## Method, Terms, Privacy, 404, error

| Control | Handler | Result |
| --- | --- | --- |
| Contents links * | Anchors | Scroll to the section and mark it current |
| Copy link on headings * | `copyText` | Copies the link to that heading |
| Delete my video and results † | `deleteMyVideoAndResults` | Confirms, deletes the video, analyses and results on the server, then the saved result in this browser |
| Delete all data * | `clearAllLocalData` | Confirms, deletes the server copy first if there is one, then removes everything stored and resets to the sample |
| 404 links | Router | Console, Setup, Method, Home |
| Error page: Copy details, Reload page, Reset local data | Clipboard, reload, `clearAllLocalData` | Copies the error, reloads, or wipes local data |

## Dialogs and toasts

Every dialog traps focus, closes with Escape and returns focus to the control that opened it. Every action that changes saved data shows a toast that repeats the action name.
