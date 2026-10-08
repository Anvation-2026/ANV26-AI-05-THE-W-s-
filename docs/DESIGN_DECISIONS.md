# Design decisions

## Direction

The visual language comes from the subject: road signage, road paint and plan drawings. It is not a SaaS template.

- Palette. Wet-concrete ground, graphite ink, guide-sign green as the one action and data colour, pavement-paint yellow for selection and focus only, asphalt and lane-marking white for the junction drawing. Signal red, amber and green appear only on lamps and phase timelines. Dark theme uses the same roles on a green-grey ground. No cream, no clay accent, no purple, no gradients, no shadows.
- Type. Overpass for headings because it descends from US highway signage. Atkinson Hyperlegible Next for the interface. Overpass Mono for the decision log only. All numbers use tabular figures.
- Shape. Square panels and 2 px controls. Layers are separated by tone, not shadow. Layouts are asymmetric and left aligned. Lines stay under about 70 characters.
- One bold element. The live plan-view junction. Everything else is quiet.

## Choices and the reasons

| Choice | Reason |
| --- | --- |
| React and Vite, not Streamlit | The brief needs custom drawing, canvas animation and fine motion control. Streamlit cannot reach that. The back end can still be Python. |
| Canvas for the junction, SVG for charts and the drawing editor | Canvas keeps 200 moving vehicles at 60 fps. SVG gives focusable handles and text for the editor and charts. |
| Left-hand traffic | The product is aimed at Indian junctions. The drawing, the lane offsets and the method page agree. |
| Simulation in the browser, behind `SignalTwinApi` | Every button works now, and the back end replaces one object later. |
| Same seed gives the same arrivals for every plan | Arrivals are generated per approach from the seed before any controller runs. Tests enforce it. |
| Chart colour rule | Exactly two series colours. The old plan is muted ink and dashed, SignalTwin is sign green and solid. Anything else uses line style, patterns and direct labels. |
| Pattern fills, not hues, for stacked parts | Keeps the page to one accent and stays readable without colour. |
| Lamp state never by colour alone | Lamp position and a text label are drawn next to every signal head. Timeline bars also change height. |
| Motion only answers an action | Dialogs, toasts, step changes and tab changes use short transitions. The single orchestrated moment is the Home load. Hover is a functional state change. Reduced motion removes movement. |
| Skeletons shaped like the content | They use the real boxes and a slow opacity pulse, no shimmer gradient. |
| A real demo on Home | The page runs the same engine as the Console on the sample junction. No sign-up. |

## Vehicle-actuated control and queue clearance

The first feedback on the sample feed was a full queue on one road while the other road sat empty on green. Vehicle-actuated control (VAC) was added as a fourth plan, with one rule at its centre: when a green starts, remember the vehicles standing in the queue zone and hold the green until they have left. Without that rule VAC thrashed between roads. SignalTwin uses the same rule. The Perception sample feed now runs VAC by default so the behaviour is visible there, and the fixed plan as recorded is one click away.

## Tuning

The controller defaults were found by grid search (`scripts/sweep.ts`). The documented 15 percent switching margin was worse here, so the default is 60 percent. The Controller page lets the user change it, and the Method page explains why.

The twin validation compares the cycle-averaged queue over six random seeds. Comparing second-by-second queues against one random day cannot reach a close match even with perfect calibration, because the clip and the twin draw different random arrivals.

## Known limits

- Detection is mocked for uploaded video. Importing a perception file is the bridge until the back end exists.
- A 2 hour video is accepted by the validation rules but was not exercised in the browser. A 4 second clip was.
- Print to PDF uses the browser print dialog with a print stylesheet. There is no server-side PDF.
- The first Lighthouse accessibility run was not performed. Axe reports no violations on 14 routes in both themes.
