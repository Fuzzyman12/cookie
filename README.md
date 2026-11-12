# 🍪 Cookie Flow

A real-time cookie production orchestrator. Each station in the kitchen gets its
own tablet showing exactly what to do next; all tablets stay in sync live.

```
Recipes → Mixing → Chilling (if needed) → Cookie Prep → Baking → Cooling & Packing
```

## Run it

```bash
docker compose up -d --build
```

Then open `http://<server-ip>:8080` on each tablet and pick its station.
Bookmark (or "Add to Home Screen") the station URL:

| Station | URL |
|---|---|
| Mixing (all Mix Stations) | `/#/mixing` |
| One mix station only (1st, 2nd, …) | `/#/mixing/1`, `/#/mixing/2` |
| Chilling (Fridge, Outdoor Chiller) | `/#/chilling` |
| Cookie Prep (all prep stations) | `/#/prep` |
| One prep station only (1st, 2nd, …) | `/#/prep/1`, `/#/prep/2` |
| Baking (ovens + Oven Staging Rack) | `/#/baking` |
| Cooling & Packing | `/#/cooling` |
| Manager overview / timeline | `/#/overview` |
| End of day report (printable) | `/#/report` |
| Recipes / Settings | `/#/recipes`, `/#/settings` |

Data (recipes, batches, settings) is saved to the `cookie-data` Docker volume.
Set `TZ` in `docker-compose.yml` to your time zone.

Without Docker: `npm install && npm start` (Node 20+). Run `npm test` for the end-to-end test.

## How the day works

1. **Recipes** – enter each recipe once: ingredients, mixing steps, chill time,
   prep steps, oven temp, bake time and mid-bake reminders
   (e.g. "rotate pans at 6 min"), cooling time, post-bake prep (icing, glaze),
   and packing steps. Any step can carry a timer. For post-bake prep, the
   minutes mean "this long after the pans come out of the oven" (e.g. "move to
   cooling rack at 5 min").
   Editing a recipe updates every batch still in progress, including a load
   that's already in the oven. Checkmarks are kept unless that section's steps
   changed.
2. **Overview** – queue batches ("3 × Chocolate Chip"). Mark a batch *Rush* to
   force it to the front.
3. **Stations** – each tablet shows an "Up next" card, checklists, and live
   timers. Tapping *Done* sends the batch to the next station, and tells the
   person where to put it ("Put it in the Outdoor Chiller", "Move 2 pans to
   Cooling & Packing – Center").
4. **Pan counts** – when Cookie Prep finishes a batch they enter how many pans
   they actually filled, and the ovens are loaded from that real count. Until
   then the planner estimates pans from the last 5 counts prep entered for that
   recipe (or the *Pans per batch estimate* in Settings for a brand-new recipe).
   Estimated counts show with a `~`.
5. **Mixing the day before** – for doughs with long or overnight chills, tick
   *Mix the day before* on the recipe. New batches of it default to **Bake
   tomorrow** (Overview → Add batches has a bake-day choice for any recipe).
   Today, they show on the Mixing tablet under *🌙 Mix today, bake tomorrow*,
   planned after today's work. Once mixed they chill overnight on the Chilling
   tablet, with no alarm and no push to prep. They're left out of today's prep,
   ovens and timeline. When the date changes they join the plan as chilled dough
   ready for prep, and go into the ovens following the usual low → high rules.
   Overview lists *🌙 Tomorrow and later* batches, and any batch can be moved to
   tomorrow or pulled into today. The day boundary uses the container's time
   zone, so set `TZ` in `docker-compose.yml`.
6. **Chilling after prep** – for doughs that should chill on the pans before
   baking, set *Chill pans after prep* on the recipe. Cookie Prep then sends
   the finished pans to the Fridge or Outdoor Chiller instead of the staging
   rack, and the Chilling tablet counts them down. The Baking tablet shows them
   on the staging rack with where they are and when they'll be ready, and the
   planner holds those loads until the chill is done. The baker can load them
   early with a confirmation.
7. **Baking** – an oven holds up to *pans per oven* (Settings). If there's room
   left and other dough at the same temperature is ready, the oven card shows
   **Fill with …** buttons, and the staging rack shows **Add to …**. Batches
   at a different temperature can't share. Each batch in the oven has its own
   timer, bake reminders, **+1 / +5 / +10 min** and custom add-time buttons,
   and **Unload** button, so it comes out on its own schedule.
8. **Cooling** – pans go into cooling the moment they're unloaded, even if
   the rest of the batch is still baking. Each oven load gets its own group on
   the Cooling & Packing tablet ("Pans 1–2, out of Island Oven at 10:42") with
   its own cooling timer and its own post-bake checklist and timers. When every
   group has cooled, tap **All cooled → Pack**.
9. **Packing & shares** – set the *Number of shares* in Settings and
   *Cookies per container* on each recipe (0 = not part of shares). Each
   share gets one container of every cookie, so the goal is shares × cookies
   per container (e.g. 10 shares × 6 = 60 chocolate chip). When a batch is
   packed, the packer must enter the containers actually packed and the
   cookies per container. The estimate (cookies per batch ÷ per container) is
   shown only as a hint. The Cooling & Packing and Overview tablets show
   packed vs. goal for each cookie, what's still needed, a projection
   including batches in progress, and how many batches to add if you'll fall
   short. *Clear finished batches* keeps the packed counts. Settings →
   *Reset packed counts (new day)* zeroes them.
10. **End of day report** – Overview → *🖨 End of day report* (or `/#/report`)
   opens a printable page. It shows totals (batches, cookies and containers
   packed, pans baked, first mix to last pack), each cookie's shares result
   (met or short by how many), every packed batch with how long each step
   actually took (mix, chill, prep, pan chill, bake, cool, pack, total), and
   what didn't get finished. Tap *Print report* or use the browser's print.
   It's built from the packed counts, so print it before *Reset packed counts
   (new day)*.
11. **Alarms** – when a chill, bake, bake reminder, oven preheat, cooling,
   post-bake or step timer finishes, the tablet shows a red alarm and beeps
   every few seconds until someone taps **OK**. An alarm also stops by itself
   when it's handled: pans unloaded, time added, step checked off, batch moved
   on. Tapping OK on any tablet silences that alarm on every tablet, and a
   tablet opened later won't raise it again. Tap the screen once after loading
   the page to enable sound (browser rule).

## How the scheduling works

On every change (and every 20 s) the server simulates the rest of the day:

- **Mix stations** – how many batches can mix at once.
- **Chill** – timed, doesn't hold up a station.
- **Prep** – the plan uses one batch at a time at each prep station
  (Settings → Prep stations), each taking `prep minutes per pan × pans`. A
  station's *batches at once* only lets staff start extra batches there by
  hand. The plan then waits until all of them are done.
- **Ovens** – each holds `pans per oven`. Pans from different batches share an
  oven when they bake at the same temperature, and each batch keeps its own
  bake time. Changing temperature costs time (preheat from cold, minutes per
  25°F up or down). The planner tells the baker when to change an oven and to
  what.
- **Cooling / packing** – timed.

The planner's priorities, in order:

1. **Fewest oven temperature changes.** Same-temperature dough is grouped and
   shares ovens.
2. **Low → high.** Lower-temperature recipes bake first and higher ones later.
   Turning an oven *down* is slow, so the plan avoids it unless the only other
   choice is a long wait.
3. **Keep the ovens busy.** It works backward from the oven plan: given each
   recipe's mix, chill, prep (one batch at a time per prep station) and pan
   chill times, it works out when each batch must be mixed so the dough is
   ready just as an oven frees up. A no-chill, high-temperature recipe may be
   held ("⏳ Not needed yet — planned to start at 3:40") instead of being mixed
   early and sitting around.

The order batches were added doesn't matter (except *Rush*). The planner
compares this backward plan with several "mix everything now" orders and
keeps whichever finishes soonest with the fewest temperature changes. Stations
follow the plan but can always go out of order. The plan just recalculates.

The **Overview** timeline shows every batch's planned mix → chill → prep →
bake → cool → pack, and each oven's loads and temperature changes.

Adjust capacities and timings to match your kitchen in **Settings**.

## Tips

- Snap a batch back if someone taps the wrong button: Overview → change its
  stage (manager override).
- Recipes are copied into a batch when it's queued, so editing a recipe
  mid-day won't affect batches already in progress.
- Export and import recipes as JSON from the Recipes page.
- Screen wake lock (keeps tablets awake) only works over HTTPS or localhost.
  Otherwise, set the tablet's auto-lock to "Never".
