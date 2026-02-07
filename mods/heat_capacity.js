// Heat Capacity Mod
// Re-enables the commented-out heatCapacity system in doHeat so that
// materials with high heat capacity resist temperature change (thermal mass)
// and materials with low heat capacity change temperature quickly.
//
// heatCapacity >= 1. Default is 1 (original game behavior = instant averaging).
// Higher = slower to heat/cool (more thermal inertia).
// 1 = fastest heat transfer (metals).
//
// Values are scaled from real-world specific heats so that the lowest
// (metals ~0.12 J/gK) maps to ~1 and everything else scales up.

// ── Override doHeat with weighted averaging ────────────────────────────

doHeat = function(pixel) {
    var weight1 = elements[pixel.element].heatCapacity || 1;
    var changed = false;
    for (var i = 0; i < biCoords.length; i++) {
        var x = pixel.x + biCoords[i][0];
        var y = pixel.y + biCoords[i][1];
        if (isEmpty(x, y, true) === false) {
            var newPixel = pixelMap[x][y];
            if (pixel.temp === newPixel.temp || elements[newPixel.element].insulate === true) {
                continue;
            }
            var avg = (pixel.temp + newPixel.temp) / 2;
            var weight2 = elements[newPixel.element].heatCapacity || 1;
            pixel.temp += (avg - pixel.temp) / weight1;
            newPixel.temp += (avg - newPixel.temp) / weight2;
            changed = true;
            pixelTempCheck(newPixel);
        }
    }
    if (changed === true) pixelTempCheck(pixel);
};

// ── Assign heatCapacity values ─────────────────────────────────────────
//
// Scaled so metals ≈ 1 (fastest, like original game) and everything
// else is proportionally higher. Real-world values × 8.

runAfterLoad(function() {

    // Defaults by state
    var stateDefaults = {
        solid:  6,    // rock-like
        liquid: 16,   // generic liquid
        gas:    8     // generic gas
    };

    for (var name in elements) {
        var el = elements[name];
        if (el.heatCapacity !== undefined) continue;
        if (el.insulate === true) continue;
        var s = el.state;
        if (s && stateDefaults[s]) {
            el.heatCapacity = stateDefaults[s];
        }
    }

    // Real-world specific heats × 8 (so 0.12 J/gK → ~1)
    var overrides = {
        // Water & ice
        water:            33,
        ice:              17,
        snow:             17,
        steam:            16,
        salt_water:       31,
        sugar_water:      31,
        dirty_water:      32,
        pool_water:       33,
        seltzer:          33,
        blood:            30,    // close to water
        milk:             31,
        juice:            31,
        soda:             33,
        vinegar:          33,
        honey:            19,
        sap:              16,
        alcohol:          19,
        mercury:          1,     // liquid metal

        // Metals — fastest conductors, ≈ 1
        tungsten:         1,
        molten_tungsten:  1,
        gold:             1,
        molten_gold:      1,
        lead:             1,
        silver:           2,
        tin:              2,
        copper:           3,
        brass:            3,
        bronze:           4,
        nickel:           4,
        iron:             4,
        molten_iron:      7,
        steel:            4,
        aluminum:         7,
        zinc:             3,
        titanium:         4,
        gallium:          3,
        magnesium:        8,
        sodium:           10,
        potassium:        6,
        metal_scrap:      4,     // generic scrap iron
        rust:             5,
        slag:             6,

        // Stone, minerals & construction
        rock:             7,
        rock_wall:        7,
        gravel:           6,
        sand:             7,
        packed_sand:      7,
        wet_sand:         12,    // sand + water mix
        color_sand:       7,
        glass:            7,
        stained_glass:    7,
        glass_shard:      7,
        diamond:          4,
        limestone:        7,
        basalt:           7,
        calcium:          5,
        concrete:         7,
        brick:            7,
        adobe:            7,
        porcelain:        6,
        baked_clay:       7,
        tuff:             7,
        mudstone:         7,
        sulfur:           6,
        borax:            8,
        salt:             7,

        // Organic solids
        wood:             14,
        bamboo:           11,
        sawdust:          14,
        paper:            11,
        cloth:            11,
        straw:            14,
        charcoal:         8,
        coal:             10,
        oil:              16,
        lamp_oil:         16,
        nut_oil:          16,
        wax:              20,
        plastic:          12,
        bone:             10,
        ash:              6,
        tinder:           11,
        rubber:           16,    // if present

        // Food (mostly high water content ≈ 25-30)
        potato:           27,
        tomato:           32,
        lettuce:          33,
        grape:            30,
        corn:             27,
        bread:            20,
        toast:            14,    // dried out
        dough:            22,
        flour:            14,
        rice:             10,
        wheat:            13,
        egg:              27,
        cheese:           13,
        butter:           17,
        sugar:            10,
        candy:            10,
        chocolate:        11,
        beans:            27,
        pumpkin:          32,
        pickle:           33,    // mostly water
        nut:              13,
        coffee_bean:      10,

        // Liquids
        liquid_hydrogen:  75,    // extreme, like gas form
        liquid_nitrogen:  8,
        caramel:          15,
        glue:             14,
        slime:            25,
        ink:              30,
        dye:              30,
        mayo:             24,
        ketchup:          30,
        sauce:            28,
        yogurt:           30,
        molasses:         15,
        cement:           7,

        // Gases
        oxygen:           7,
        hydrogen:         114,   // hydrogen is extreme IRL
        nitrogen:         8,
        carbon_dioxide:   7,
        helium:           42,
        neon:             8,
        methane:          17,
        propane:          13,
        chlorine:         4,
        smoke:            8,
        smog:             8,

        // Radioactive (from chem.js) — metals, so fast
        actinium:         1,
        molten_actinium:  1,
        francium:         1,
        molten_francium:  1,
        radium:           1,
        molten_radium:    1,
        uranium:          1,
        thorium:          1,
        plutonium:        1,
        polonium:         1,
        molten_polonium:  1,

        // Misc
        magma:            12,
        lava:             12,
        mud:              11,
        clay:             7,
        clay_soil:        7,
        soil:             6,
        dirt:             6,
        mulch:            12,
        permafrost:       15,    // frozen soil + ice
        fire:             1,
        plasma:           1,
        amber:            11,
        dry_ice:          7,
    };

    for (var name in overrides) {
        if (elements[name]) {
            elements[name].heatCapacity = overrides[name];
        }
    }
});
