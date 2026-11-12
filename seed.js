'use strict';
// Default kitchen layout (matches the floor plan) and a few example recipes.

const defaultSettings = () => ({
  kitchenName: 'Cookie Kitchen',
  mixStations: ['Mix Station #1', 'Mix Station #2', 'Mix Station #3', 'Mix Station #4'],
  chillLocations: ['Fridge', 'Outdoor Chiller'],
  prepStations: 1, // people panning dough at Cookie Prep at the same time
  prepMinutesPerPan: 4, // default when a recipe doesn't say
  ovens: [
    { id: 'oven1', name: 'Island Oven' },
    { id: 'oven2', name: 'Corner Oven' },
  ],
  ovenPansPerLoad: 2,
  defaultPansPerBatch: 4, // planning estimate until Cookie Prep has reported real counts for a recipe
  preheatMinutes: 15, // cold oven to temp
  heatUpMinutesPer25F: 3,
  coolDownMinutesPer25F: 6,
  coolingAreas: ['Cooling & Packing – Center', 'Cooling & Packing – Right Wall', 'Cooling & Packing – Front'],
});

const step = (text, minutes = null) => ({ text, minutes });

const recipes = () => [
  {
    id: 'r-choc-chip',
    name: 'Chocolate Chip',
    color: '#b5733c',
    yieldPerBatch: 48,
    mixMinutes: 20,
    ingredients: ['2 cups (454 g) butter, softened', '1½ cups brown sugar', '1 cup granulated sugar', '4 eggs', '1 Tbsp vanilla', '5 cups flour', '2 tsp baking soda', '2 tsp salt', '4 cups chocolate chips'],
    mixSteps: [step('Cream butter and sugars until fluffy', 3), step('Beat in eggs one at a time, then vanilla'), step('Whisk flour, baking soda and salt in a separate bowl'), step('Mix dry into wet on low just until combined'), step('Fold in chocolate chips')],
    chillMinutes: 60,
    chillNotes: 'Cover bowl with plastic wrap. Label with batch number.',
    prepMinutesPerPan: 4,
    prepSteps: [step('Line pans with parchment'), step('Scoop 1½ Tbsp balls (#40 scoop), 12 per pan, 2" apart'), step('Sprinkle flaky salt on top'), step('Set pans on the Oven Staging Rack')],
    ovenTempF: 350,
    bakeMinutes: 11,
    bakeSteps: [step('Rotate pans front-to-back', 6), step('Pull when edges are golden and centers look slightly underdone', 11)],
    coolMinutes: 20,
    finishSteps: [step('Let cookies set on the pan, then move to the cooling rack', 5)],
    packMinutes: 15,
    packSteps: [step('Check cookies are fully cool to the touch'), step('Bag 6 per bag, seal'), step('Label with flavor and date')],
    notes: '',
  },
  {
    id: 'r-sugar',
    name: 'Iced Sugar Cookies',
    color: '#e58fb0',
    yieldPerBatch: 36,
    mixMinutes: 15,
    ingredients: ['1½ cups butter, softened', '2 cups sugar', '4 eggs', '1 tsp vanilla', '5 cups flour', '2 tsp baking powder', '1 tsp salt'],
    mixSteps: [step('Cream butter and sugar', 3), step('Beat in eggs and vanilla'), step('Mix in dry ingredients on low'), step('Divide dough into 2 discs, wrap in plastic')],
    chillMinutes: 90,
    chillNotes: 'Discs must be firm before rolling.',
    prepMinutesPerPan: 7,
    prepSteps: [step('Roll dough ¼" thick on floured surface'), step('Cut shapes, 12 per pan'), step('Re-roll scraps once only')],
    ovenTempF: 375,
    bakeMinutes: 8,
    bakeSteps: [step('Pull as soon as edges just start to color', 8)],
    coolMinutes: 30,
    finishSteps: [step('Move cookies to the cooling rack', 3), step('Pipe royal icing outlines (cookies must be fully cool)', 30), step('Flood with icing')],
    packMinutes: 35,
    packSteps: [step('Let icing set before boxing', 20), step('Box in a single layer, 12 per box'), step('Label with flavor and date')],
    notes: 'Icing must be fully set before stacking.',
  },
  {
    id: 'r-snickerdoodle',
    name: 'Snickerdoodles',
    color: '#d9a441',
    yieldPerBatch: 36,
    mixMinutes: 15,
    ingredients: ['1 cup butter', '1½ cups sugar', '2 eggs', '2¾ cups flour', '2 tsp cream of tartar', '1 tsp baking soda', '¼ tsp salt', 'Rolling: ¼ cup sugar + 1 Tbsp cinnamon'],
    mixSteps: [step('Cream butter and sugar', 2), step('Beat in eggs'), step('Mix in dry ingredients'), step('Mix cinnamon sugar in a shallow bowl for prep')],
    chillMinutes: 0,
    chillNotes: '',
    prepMinutesPerPan: 5,
    prepSteps: [step('Roll 1½" balls'), step('Roll each ball in cinnamon sugar'), step('12 per pan, 2" apart')],
    ovenTempF: 400,
    bakeMinutes: 9,
    bakeSteps: [step('Rotate pans', 5)],
    coolMinutes: 15,
    finishSteps: [step('Move cookies to the cooling rack', 2)],
    packMinutes: 12,
    packSteps: [step('Bag 6 per bag, seal'), step('Label with flavor and date')],
    notes: '',
  },
  {
    id: 'r-oatmeal',
    name: 'Oatmeal Raisin',
    color: '#8a6a4f',
    yieldPerBatch: 48,
    mixMinutes: 18,
    ingredients: ['1 cup butter', '1 cup brown sugar', '½ cup sugar', '2 eggs', '1 tsp vanilla', '1½ cups flour', '1 tsp baking soda', '1 tsp cinnamon', '3 cups oats', '1½ cups raisins'],
    mixSteps: [step('Cream butter and sugars', 3), step('Beat in eggs and vanilla'), step('Mix in flour, soda, cinnamon'), step('Stir in oats and raisins')],
    chillMinutes: 0,
    chillNotes: '',
    prepMinutesPerPan: 4,
    prepSteps: [step('Scoop 2 Tbsp balls, 12 per pan'), step('Flatten slightly with palm')],
    panChillMinutes: 20,
    panChillNotes: 'Chill scooped dough on the pans so the cookies don\'t spread.',
    ovenTempF: 350,
    bakeMinutes: 12,
    bakeSteps: [step('Rotate pans', 6)],
    coolMinutes: 20,
    finishSteps: [step('Move cookies to the cooling rack', 5)],
    packMinutes: 15,
    packSteps: [step('Bag 6 per bag, seal'), step('Label with flavor and date')],
    notes: '',
  },
];

const seedState = () => ({
  version: 1,
  settings: defaultSettings(),
  recipes: recipes(),
  batches: [],
  ovens: {},
  counters: {},
  // recipeId -> pans actually filled, as entered at Cookie Prep (starting guesses here)
  panHistory: { 'r-choc-chip': [4], 'r-sugar': [3], 'r-snickerdoodle': [3], 'r-oatmeal': [4] },
});

module.exports = { seedState, defaultSettings };
