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

        // Stone & minerals
        rock:             7,
        gravel:           6,
        sand:             7,
        glass:            7,
        diamond:          4,
        limestone:        7,
        basalt:           7,
        calcium:          5,

        // Organic
        wood:             14,
        charcoal:         8,
        coal:             10,
        oil:              16,
        wax:              20,

        // Gases
        oxygen:           7,
        hydrogen:         114,   // hydrogen is extreme IRL
        nitrogen:         8,
        carbon_dioxide:   7,
        helium:           42,

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
        soil:             6,
        dirt:             6,
        fire:             1,
        plasma:           1,
    };

    for (var name in overrides) {
        if (elements[name]) {
            elements[name].heatCapacity = overrides[name];
        }
    }
});
