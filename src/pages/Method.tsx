import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Footer } from '../shell/Layout';
import { toast } from '../components/ui';
import { copyText } from '../lib/util';
import { useApp } from '../store/app';

const TOC = [
  { id: 'overview', label: 'How the twin works' },
  { id: 'pipeline', label: 'The eight modules' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'demand', label: 'Demand and calibration' },
  { id: 'simulator', label: 'The simulator' },
  { id: 'webster', label: 'Webster baseline' },
  { id: 'controller', label: 'The controller' },
  { id: 'vac', label: 'Vehicle-actuated control' },
  { id: 'fairness', label: 'The fairness guarantee' },
  { id: 'evaluation', label: 'Evaluation' },
  { id: 'limits', label: 'Limitations and future work' },
];

function H({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id}>
      {children}
      <button
        className="copy-link"
        aria-label={`Copy link to ${children}`}
        onClick={async () => {
          const ok = await copyText(`${location.origin}${location.pathname}#${id}`);
          toast(ok ? 'Link copied.' : 'Copy failed.', ok ? 'info' : 'error');
        }}
      >
        Copy link
      </button>
    </h2>
  );
}

export default function Method() {
  const [active, setActive] = useState('overview');
  const p = useApp((s) => s.params);
  useEffect(() => {
    const els = TOC.map((t) => document.getElementById(t.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id);
      },
      { rootMargin: '-90px 0px -65% 0px' },
    );
    els.forEach((e) => io.observe(e));
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    return () => io.disconnect();
  }, []);
  const bound = p.maxGreen + p.yellow + 2 * p.allRed;
  return (
    <>
      <div className="page">
        <header className="page-header">
          <h1>Method</h1>
          <p className="page-lede">How SignalTwin turns a video into a tested signal plan, and exactly what each step assumes.</p>
        </header>
        <div className="method-grid">
          <nav className="toc" aria-label="On this page">
            {TOC.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={active === t.id ? 'is-active' : ''} onClick={() => setActive(t.id)}>
                {t.label}
              </a>
            ))}
          </nav>
          <article className="prose">
            <H id="overview">How the twin works</H>
            <p>SignalTwin turns a traffic video of one intersection into three things: a measurement of real traffic demand, a calibrated simulation of that intersection, and an adaptive signal plan that is tested against the existing plan on identical traffic before it is recommended.</p>
            <p>A video can only show what happened under the signal that was already installed. A true before and after comparison therefore cannot be measured from the video alone. SignalTwin uses the video as a sensor and a simulator as the testing ground. That makes every before and after number repeatable.</p>
            <p>SignalTwin recommends a plan. It does not control any signal, and it does not need a live camera feed.</p>

            <H id="pipeline">The eight modules</H>
            <ol>
              <li>Setup: junction geometry, stop lines, upstream lines, queue zones and calibration points.</li>
              <li>Perception: detections, tracks, counts, queues and speeds.</li>
              <li>Demand: arrival rates in PCU, class mix and saturation flow.</li>
              <li>Digital twin: a stochastic simulator of the junction.</li>
              <li>Baseline: the observed plan and a Webster fixed-time plan.</li>
              <li>SignalTwin controller: an adaptive plan with a fairness guard.</li>
              <li>Evaluation: metrics, scenarios, seeds and ablations.</li>
              <li>Dashboard and report: what you see here and what you download.</li>
            </ol>
            <p>Perception runs once on the video and saves a time-stamped file of detections and counts. The console replays that file in step with the simulation. The same code can later run frame by frame on a live feed.</p>

            <H id="glossary">Glossary</H>
            <dl>
              <dt>Approach</dt>
              <dd>One direction of traffic arriving at the junction: North, South, East or West.</dd>
              <dt>Phase</dt>
              <dd>A set of approaches that get green together without conflict. With two phases, NS is one and EW is the other.</dd>
              <dt>Cycle</dt>
              <dd>One full rotation through all phases.</dd>
              <dt>Saturation flow</dt>
              <dd>The maximum rate at which a queue discharges during green. About 1800 PCU per hour per lane is a typical starting value, and SignalTwin measures it from the video when it can.</dd>
              <dt>PCU, passenger car unit</dt>
              <dd>A common unit so different vehicles can be added up. A car is 1.0, a two-wheeler uses less road, a bus or truck uses more.</dd>
              <dt>Queue</dt>
              <dd>Vehicles stopped or crawling behind the stop line waiting for green.</dd>
              <dt>Hysteresis</dt>
              <dd>A margin the best phase must beat the current phase by before the controller switches, because every switch wastes time in yellow, all-red and startup.</dd>
              <dt>VAC, vehicle-actuated control</dt>
              <dd>The standard detector-based logic. It skips a phase with nobody waiting, extends a green while vehicles keep arriving, and ends it when the gap between vehicles is longer than the passage time or the maximum green is reached.</dd>
              <dt>Standing queue</dt>
              <dd>The vehicles waiting in a queue zone at the moment its green begins. Queue clearance holds the green until exactly these vehicles have left.</dd>
              <dt>Platoon</dt>
              <dd>A tight group of vehicles travelling together, usually released by an upstream signal.</dd>
              <dt>Common random numbers</dt>
              <dd>Using the same random traffic for two plans, so differences come from the plan and not from luck.</dd>
              <dt>Jain's fairness index</dt>
              <dd>
                (sum of x) squared divided by (n times the sum of x squared), over per-approach average delays. 1.0 means every approach waits equally.
              </dd>
            </dl>

            <H id="demand">Demand and calibration</H>
            <p>Counts at the upstream line are grouped into short bins, by approach and class, and weighted by PCU. An exponentially weighted moving average smooths them into an arrival rate for each approach. The class mix is estimated the same way.</p>
            <p>Saturation flow is measured from stop-line crossings while a queue discharges. It equals 1 divided by the average headway, converted to PCU. If the clip is too short, documented defaults are used and flagged on the Demand page.</p>
            <p>Short clips can be repeated to build a longer scenario, and a load multiplier creates heavier versions. This is a modelling choice and is stated in every report.</p>
            <p>Traffic here drives on the left, as in India, so inbound lanes sit on the left of each approach as seen by the driver.</p>

            <H id="simulator">The simulator</H>
            <p>The simulator is a custom queue-based model that advances in one-second steps. It is not a car-following model. That is a deliberate trade-off: it is fast, fully controlled, easy to debug and enough to compare signal plans.</p>
            <p>Each second, in this order:</p>
            <ol>
              <li>New vehicles arrive from the demand profile as a Poisson process, with classes drawn from the measured mix.</li>
              <li>Vehicles whose travel time is complete join the queue.</li>
              <li>The active controller keeps or changes the phase, respecting minimum green, yellow and all-red.</li>
              <li>On green, after the startup lost time, the queue discharges at the saturation rate. A fractional accumulator handles rates that are not whole vehicles per second.</li>
              <li>Every queued vehicle adds one second of delay, and departures are logged.</li>
            </ol>
            <p>The random generator is seeded, and the same seed produces the same arrivals for every plan. Any difference in results comes from the signal plan alone.</p>

            <H id="webster">Webster baseline</H>
            <p>A strong baseline matters, otherwise an improvement means nothing. Two baselines are used: the observed plan, and a Webster-optimised fixed-time plan computed from the busiest minute of measured demand.</p>
            <p>For each phase take the critical flow ratio y, the flow divided by the saturation flow of the busiest approach. Sum them to get Y. With total lost time L per cycle, the optimal cycle length is:</p>
            <div className="math" role="math" aria-label="C zero equals open parenthesis 1.5 L plus 5 close parenthesis divided by open parenthesis 1 minus Y close parenthesis">
              <i>C</i>
              <sub>0</sub> = (1.5 <i>L</i> + 5) / (1 − <i>Y</i>)
            </div>
            <p>The effective green is shared in proportion to y, so the green of a phase is (C0 − L) × y / Y. If Y is close to or above 1 the junction is over capacity and the formula breaks down. This is itself the argument against fixed plans in oversaturation, and SignalTwin caps the cycle at 120 s there and says so.</p>

            <H id="controller">The controller</H>
            <p>Every second the controller scores each candidate phase p:</p>
            <div className="math" role="math" aria-label="score of p equals the sum over approaches a in p of Q sub a plus beta times E sub a plus gamma times A sub a">
              score(<i>p</i>) = Σ<sub><i>a</i> ∈ <i>p</i></sub> [ <i>Q</i>
              <sub>a</sub> + <i>β</i> · <i>E</i>
              <sub>a</sub> + <i>γ</i> · <i>A</i>
              <sub>a</sub> ]
            </div>
            <ul>
              <li>
                <strong>Q</strong> is the weighted queue. In vehicle mode it is PCU. In people mode it is people waiting, so a full bus outranks a car.
              </li>
              <li>
                <strong>E</strong> is the PCU expected to reach the stop line in the next 8 to 10 s, from the look-ahead at the upstream line.
              </li>
              <li>
                <strong>A</strong> is aging: the red time of the approach times its arrival rate, a queue-equivalent of how long it has waited.
              </li>
              <li>
                <strong>β and γ</strong> are weights found by grid search in the simulator. The current defaults are {p.beta} and {p.gamma}.
              </li>
            </ul>
            <p>It switches only if the best other phase beats the current phase by the switching margin. The project notes suggest about 15 percent. In this queue model a margin of {Math.round(p.hysteresis * 100)} percent switched less often and gave lower delay, so that is the default. You can change it on the Controller page. It never exceeds the maximum green, and it holds a green for an arriving platoon instead of cutting it off.</p>
            <p>Because this is one isolated junction there is no downstream queue to subtract, so the pressure reduces to a weighted queue. The contribution is the combination of calibration, look-ahead, person weighting and the fairness guarantee, not the formula alone.</p>
            <p>Why not reinforcement learning as the core? Pressure control needs no training, can be explained line by line, has known throughput guarantees and can enforce a hard fairness cap, which a learned policy cannot guarantee.</p>
            <p>When an emergency vehicle is detected, a green already serving it is extended until it clears. Otherwise the current green ends after its minimum, through the normal yellow and all-red, and the emergency approach is served. Safety clearance is never skipped.</p>

            <H id="vac">Vehicle-actuated control and queue clearance</H>
            <p>A fixed plan gives every road its green whether anyone is there or not. The result seen in the sample feed is a full queue on one road while the other road sits empty on green. Vehicle-actuated control, VAC, fixes this by reading detectors.</p>
            <ol>
              <li>A phase with no vehicles waiting or arriving is skipped.</li>
              <li>When a green starts, the controller records the vehicles that are standing in the queue zone. It holds the green until every one of them has left. Vehicles that arrive later do not make it hold longer than the passage time allows.</li>
              <li>After that the green is extended only while detectors keep seeing vehicles and no other road is waiting. If another road is waiting, the green ends (a gap-out) and the road with the longest waiting queue is served.</li>
              <li>The minimum green, the maximum green, emergency priority and the fairness cap still apply.</li>
            </ol>
            <p>Clearing the standing queue matters. In this simulator, VAC without it switched back and forth before queues could drain and averaged about twice the delay of the observed fixed plan. With it, VAC beats both fixed plans in the balanced scenario. The SignalTwin plan uses the same rule before it considers a switch, and you can switch it off on the Controller page.</p>
            <H id="fairness">The fairness guarantee</H>
            <p>The guard has two layers. The soft layer is the aging term, which steadily raises the priority of any approach that has waited. The hard layer tracks red time per approach and, when an approach is within one clearance period of the cap, forces a switch to serve it and ignores the scores.</p>
            <p>With two phases the longest any approach can go without green is the other phase's maximum green plus one yellow plus two all-red periods, since an approach's own all-red before the other green also counts as red. With your current settings that is {p.maxGreen} + {p.yellow} + 2 × {p.allRed} = {bound} s, held under the {p.fairnessCap} s cap by the guard.</p>
            <p>The project notes round this to the other phase's maximum green plus the clearance counted once, 55 s in their example. This page reports the exact figure, {bound} s with the defaults.</p>
            <p>One honest caveat. This caps time without a green signal. In heavy oversaturation an individual vehicle may still wait through more than one green. Both numbers are reported: the red-time cap and the longest individual vehicle wait.</p>

            <H id="evaluation">Evaluation</H>
            <p>There are two scenarios. Scenario A is balanced, about 70 percent of capacity. Scenario B raises one approach for a few minutes so that it goes past capacity while the others stay normal, which tests changing density and fairness together.</p>
            <p>Each scenario runs with {p.seeds} random seeds. Every plan uses the same seeds. Results are the mean with a 95 percent confidence interval from the t distribution, and differences are paired seed by seed.</p>
            <p>Metrics: average delay per vehicle and per person, 95th percentile delay, longest red time, longest vehicle wait, throughput in vehicles and people per hour, maximum queue and Jain's index.</p>
            <p>The ablation removes the fairness guard, look-ahead, PCU weighting and hysteresis one at a time. The noise test corrupts what the controller sees by 0, 10, 20 and 30 percent and checks whether SignalTwin still beats the baseline at about 20 percent.</p>
            <p>No number is shown unless a completed run in this app produced it, and it is labelled Sample run or Your run.</p>

            <H id="limits">Limitations and future work</H>
            <ul>
              <li>The simulator is queue based and does not model lane changing or car following.</li>
              <li>Left and right turn movements are simplified.</li>
              <li>One junction only. Corridors and networks, with true max-pressure and downstream queues, are future work.</li>
              <li>PCU and occupancy values are assumptions to tune locally.</li>
              <li>Camera angle, weather and night conditions affect detection.</li>
              <li>Future work: SUMO co-simulation, learned demand forecasting, multi-junction coordination, and integration with real controllers under proper safety certification.</li>
            </ul>
            <p>
              See also the <Link to="/terms">Terms of service</Link> and the <Link to="/privacy">Privacy policy</Link>.
            </p>
          </article>
        </div>
      </div>
      <Footer />
    </>
  );
}
