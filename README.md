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
| Mixing (Mix Stations #1–#4) | `/#/mixing` |
| Chilling (Fridge, Outdoor Chiller) | `/#/chilling` |
| Cookie Prep | `/#/prep` |
| Baking (ovens + Oven Staging Rack) | `/#/baking` |
| Cooling & Packing | `/#/cooling` |
| Manager overview / timeline | `/#/overview` |
| Recipes / Settings | `/#/recipes`, `/#/settings` |

Data (recipes, batches, settings) is saved to the `cookie-data` Docker volume.
Set `TZ` in `docker-compose.yml` to your time zone.

Without Docker: `npm install && npm start` (Node 20+). Run `npm test` for the end-to-end test.

## How the day works

1. **Recipes** – enter each recipe once: ingredients, mixing steps, chill time,
   pans per batch and prep steps, oven temp, bake time and mid-bake reminders
   (e.g. "rotate pans at 6 min"), cooling time, post-bake prep (icing, glaze),
   and packing steps. Any step can carry a timer.
2. **Overview** – queue batches ("3 × Chocolate Chip"). Mark a batch *Rush* to
   force it to the front.
3. **Stations** – each tablet shows an "Up next" card, checklists, and live
   timers. Tapping *Done* sends the batch to the next station, and tells the
   person where to put it ("Put it in the Outdoor Chiller", "Move 2 pans to
   Cooling & Packing – Center").
4. **Alerts** – tablets beep, vibrate and flash when chilling, baking (and
   bake reminders), cooling, oven preheats or step timers finish. Tap the
   screen once after loading the page to enable sound (browser rule).

## How the scheduling works

On every change (and every 20 s) the server simulates the rest of the day:

- **Mix stations** – how many batches can mix at once.
- **Chill** – timed, doesn't hold up a station.
- **Prep** – `prepStations` people, `prep minutes per pan × pans`.
- **Ovens** – each holds `pans per load`. Changing temperature costs time
  (preheat from cold, minutes per 25°F up or down), so the planner groups loads
  by temperature and tells the baker when to change an oven and to what.
- **Cooling / packing** – timed.

It tries several mixing orders (longest chill first, grouped by oven temp,
first-in-first-out, the previous plan) and then improves the best one by moving
batches around, choosing whatever finishes everything soonest with the fewest
oven temperature changes. Stations follow the plan but can always go out of
order. The plan just recalculates.

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
