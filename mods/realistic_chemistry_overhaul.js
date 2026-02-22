// Realistic Chemistry Overhaul
// Ground-up chemistry simulation lane intended to run without velocity/gravity/chem legacy mods.

(function() {
    "use strict";

    var modName = "mods/realistic_chemistry_overhaul.js";
    var RS_PREFIX = "rs_";
    var RS_IONIZATION_TEMP = 9000;
    var LEGACY_CATEGORY = "legacy_hidden";
    var AUTO_MIGRATE_LEGACY_PIXELS = true;

    var CONFLICTING_MODS = [
        "mods/velocity.js",
        "mods/gravity.js",
        "mods/pressure_mvp.js",
        "mods/chem.js",
        "mods/chemLegacy.js"
    ];

    var LEGACY_MIGRATION_MAP = {
        hydrogen: "rs_hydrogen",
        oxygen: "rs_oxygen",
        nitrogen: "rs_nitrogen",
        steam: "rs_water_vapor",
        water: "rs_water",
        salt_water: "rs_water",
        dirty_water: "rs_water",
        ice: "rs_ice",
        snow: "rs_ice",
        dirt: "rs_silicate",
        sand: "rs_silicate",
        rock: "rs_silicate",
        basalt: "rs_silicate",
        molten_dirt: "rs_silicate_melt",
        magma: "rs_silicate_melt",
        molten_rock: "rs_silicate_melt",
        iron: "rs_iron",
        steel: "rs_iron",
        rust: "rs_iron_oxide",
        molten_iron: "rs_molten_iron",
        uranium: "rs_uranium",
        molten_uranium: "rs_molten_uranium",
        plasma: "rs_plasma"
    };

    var RS_REACTIONS = [
        {
            id: "water_formation",
            reactants: { rs_hydrogen: 2, rs_oxygen: 1 },
            products: ["rs_water_vapor", "rs_water_vapor", "rs_heat"],
            tempMin: 900,
            chance: 0.08,
            exothermic: 400
        },
        {
            id: "steam_dissociation",
            reactants: { rs_water_vapor: 2 },
            products: ["rs_hydrogen", "rs_oxygen"],
            tempMin: 3500,
            chance: 0.015,
            endothermic: 250
        },
        {
            id: "slagging",
            reactants: { rs_silicate_melt: 1, rs_molten_iron: 1 },
            products: ["rs_slag", "rs_molten_iron"],
            tempMin: 1500,
            chance: 0.04,
            exothermic: 40
        },
        {
            id: "iron_oxidation",
            reactants: { rs_iron: 1, rs_oxygen: 1 },
            products: ["rs_iron_oxide", "rs_oxygen"],
            tempMin: 300,
            chance: 0.03,
            exothermic: 15
        }
    ];

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    function isRsElementName(name) {
        return typeof name === "string" && name.indexOf(RS_PREFIX) === 0;
    }

    function chooseWeighted(candidates) {
        var total = 0;
        for (var i = 0; i < candidates.length; i++) {
            total += candidates[i].w;
        }
        if (total <= 0) {
            return null;
        }

        var roll = Math.random() * total;
        for (var j = 0; j < candidates.length; j++) {
            roll -= candidates[j].w;
            if (roll <= 0) {
                return candidates[j];
            }
        }
        return candidates[candidates.length - 1];
    }

    function applyGasMovement(pixel, info) {
        var density = typeof info.density === "number" ? info.density : 1;
        var thermalLift = clamp((pixel.temp - 25) / 2500, -1, 1);
        var densityLift = clamp((1.25 - density) / 1.25, -1.2, 1.2);
        var buoyancy = clamp(thermalLift + densityLift, -1.5, 1.5);

        var upBias = clamp(0.6 + buoyancy * 0.35, 0.05, 0.95);
        var sideBias = clamp(0.3 + Math.abs(buoyancy) * 0.12, 0.1, 0.65);
        var downBias = clamp(1 - (upBias + sideBias), 0.02, 0.45);

        var first = chooseWeighted([
            { dx: 0, dy: -1, w: upBias },
            { dx: -1, dy: 0, w: sideBias * 0.5 },
            { dx: 1, dy: 0, w: sideBias * 0.5 },
            { dx: 0, dy: 1, w: downBias }
        ]);

        if (first && tryMove(pixel, pixel.x + first.dx, pixel.y + first.dy)) {
            return;
        }

        var fallback = [
            [0, -1], [-1, -1], [1, -1],
            [-1, 0], [1, 0],
            [0, 1], [-1, 1], [1, 1]
        ];
        shuffleArray(fallback);
        for (var i = 0; i < fallback.length; i++) {
            if (tryMove(pixel, pixel.x + fallback[i][0], pixel.y + fallback[i][1])) {
                return;
            }
        }
    }

    function reactionInvolvesElement(rule, name) {
        return rule.reactants[name] !== undefined;
    }

    function countMapFromPixels(pixels) {
        var counts = {};
        for (var i = 0; i < pixels.length; i++) {
            var name = pixels[i].element;
            counts[name] = (counts[name] || 0) + 1;
        }
        return counts;
    }

    function countsSatisfyRule(counts, reactants) {
        for (var reactant in reactants) {
            if ((counts[reactant] || 0) < reactants[reactant]) {
                return false;
            }
        }
        return true;
    }

    function gatherReactionNeighborhood(centerPixel) {
        var pixels = [centerPixel];
        for (var i = 0; i < adjacentCoords.length; i++) {
            var x = centerPixel.x + adjacentCoords[i][0];
            var y = centerPixel.y + adjacentCoords[i][1];
            if (outOfBounds(x, y) || isEmpty(x, y, true)) {
                continue;
            }
            pixels.push(pixelMap[x][y]);
        }
        return pixels;
    }

    function chooseReactantPixels(pool, reactants) {
        var selected = [];
        for (var reactant in reactants) {
            var needed = reactants[reactant];
            for (var i = 0; i < pool.length && needed > 0; i++) {
                var px = pool[i];
                if (px.element !== reactant || px.rsReactionTick === pixelTicks) {
                    continue;
                }
                selected.push(px);
                needed--;
            }
            if (needed > 0) {
                return null;
            }
        }
        return selected;
    }

    function applyReactionProducts(selectedPixels, rule) {
        if (rule.products.length !== selectedPixels.length) {
            return false;
        }

        shuffleArray(selectedPixels);
        for (var i = 0; i < selectedPixels.length; i++) {
            var px = selectedPixels[i];
            changePixel(px, rule.products[i], false);
            px.rsReactionTick = pixelTicks;
            if (rule.exothermic) {
                px.temp += rule.exothermic;
            }
            if (rule.endothermic) {
                px.temp -= rule.endothermic;
            }
            pixelTempCheck(px);
        }
        return true;
    }

    function attemptStoichiometricReaction(pixel) {
        if (!isRsElementName(pixel.element)) {
            return;
        }
        if (pixel.rsReactionTick === pixelTicks) {
            return;
        }

        var neighborhood = gatherReactionNeighborhood(pixel);
        var counts = countMapFromPixels(neighborhood);

        for (var i = 0; i < RS_REACTIONS.length; i++) {
            var rule = RS_REACTIONS[i];
            if (!reactionInvolvesElement(rule, pixel.element)) {
                continue;
            }
            if (pixel.temp < rule.tempMin || Math.random() >= rule.chance) {
                continue;
            }
            if (!countsSatisfyRule(counts, rule.reactants)) {
                continue;
            }

            var reactantPixels = chooseReactantPixels(neighborhood, rule.reactants);
            if (!reactantPixels) {
                continue;
            }
            if (applyReactionProducts(reactantPixels, rule)) {
                return;
            }
        }
    }

    function setIonizationHook(elementName) {
        var info = elements[elementName];
        if (
            !info ||
            info._rsIonizationHook ||
            elementName === "rs_plasma" ||
            elementName === "rs_heat" ||
            info.category === "energy" ||
            !["solid", "liquid", "gas"].includes(info.state)
        ) {
            return;
        }

        var previousOnStateHigh = info.onStateHigh;
        info.onStateHigh = function(pixel) {
            if (pixel.element === "rs_plasma" && pixel.temp >= RS_IONIZATION_TEMP) {
                pixel.rsSourceElement = elementName;
            }
            if (previousOnStateHigh) {
                previousOnStateHigh(pixel);
            }
        };
        info._rsIonizationHook = true;

        if (typeof info.tempHigh !== "number") {
            info.tempHigh = RS_IONIZATION_TEMP;
            info.stateHigh = "rs_plasma";
            return;
        }

        if (info.stateHigh === null || info.stateHigh === undefined) {
            return;
        }

        if (!info.extraTempHigh) {
            info.extraTempHigh = {};
        }
        info.extraTempHigh[RS_IONIZATION_TEMP] = "rs_plasma";
    }

    function installPlasmaCoolingHook() {
        if (!elements.rs_plasma || elements.rs_plasma._rsCoolingHook) {
            return;
        }

        var previousOnStateLow = elements.rs_plasma.onStateLow;
        elements.rs_plasma.onStateLow = function(pixel) {
            var source = pixel.rsSourceElement;
            if (source && elements[source]) {
                delete pixel.rsSourceElement;
                changePixel(pixel, source, false);
                pixelTempCheck(pixel);
            }
            if (previousOnStateLow) {
                previousOnStateLow(pixel);
            }
        };
        elements.rs_plasma._rsCoolingHook = true;
    }

    function hideLegacyElements() {
        for (var name in elements) {
            if (isRsElementName(name)) {
                continue;
            }
            var info = elements[name];
            if (!info) {
                continue;
            }
            if (info.category === "tools" || info.category === "special") {
                continue;
            }
            info.hidden = true;
            info.excludeRandom = true;
            info.category = LEGACY_CATEGORY;
        }
    }

    function migrateLegacyPixels() {
        for (var i = 0; i < currentPixels.length; i++) {
            var px = currentPixels[i];
            if (!px || px.del) {
                continue;
            }
            var mapped = LEGACY_MIGRATION_MAP[px.element];
            if (!mapped || !elements[mapped]) {
                continue;
            }
            changePixel(px, mapped, false);
        }
    }

    function removeConflictingMods() {
        var removed = [];
        for (var i = 0; i < CONFLICTING_MODS.length; i++) {
            var mod = CONFLICTING_MODS[i];
            var idx = enabledMods.indexOf(mod);
            if (idx !== -1) {
                enabledMods.splice(idx, 1);
                removed.push(mod);
            }
        }

        if (!removed.length) {
            return;
        }

        localStorage.setItem("enabledMods", JSON.stringify(enabledMods));
        alert("realistic_chemistry_overhaul removed conflicting mods:\n" + removed.join("\n") + "\nReloading now.");
        window.location.reload();
    }

    function defineRsElements() {
        elements.rs_heat = {
            color: ["#ffcc55", "#ff9b3d", "#ffd87a"],
            behavior: behaviors.GAS,
            temp: 1800,
            tempLow: 600,
            stateLow: null,
            category: "energy",
            state: "gas",
            density: 0.2,
            hidden: true
        };

        elements.rs_hydrogen = {
            color: ["#dce9ff", "#c8deff", "#edf4ff"],
            behavior: function(pixel) {
                applyGasMovement(pixel, elements.rs_hydrogen);
                doDefaults(pixel);
            },
            temp: 20,
            tempLow: -253,
            stateLow: "rs_liquid_hydrogen",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic gases",
            state: "gas",
            density: 0.09,
            conduct: 0.02
        };

        elements.rs_liquid_hydrogen = {
            color: ["#d7f0ff", "#c4e8ff"],
            behavior: behaviors.LIQUID,
            temp: -260,
            tempHigh: -253,
            stateHigh: "rs_hydrogen",
            category: "realistic liquids",
            state: "liquid",
            density: 70
        };

        elements.rs_oxygen = {
            color: ["#d4f2ff", "#bde9ff", "#e5f8ff"],
            behavior: function(pixel) {
                applyGasMovement(pixel, elements.rs_oxygen);
                doDefaults(pixel);
            },
            temp: 20,
            tempLow: -183,
            stateLow: "rs_liquid_oxygen",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic gases",
            state: "gas",
            density: 1.43,
            conduct: 0.08
        };

        elements.rs_liquid_oxygen = {
            color: ["#9fd8ff", "#8ecdf8"],
            behavior: behaviors.LIQUID,
            temp: -190,
            tempHigh: -183,
            stateHigh: "rs_oxygen",
            category: "realistic liquids",
            state: "liquid",
            density: 1140
        };

        elements.rs_nitrogen = {
            color: ["#e0ecff", "#d2e2ff", "#edf3ff"],
            behavior: function(pixel) {
                applyGasMovement(pixel, elements.rs_nitrogen);
                doDefaults(pixel);
            },
            temp: 20,
            tempLow: -196,
            stateLow: "rs_liquid_nitrogen",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic gases",
            state: "gas",
            density: 1.25,
            conduct: 0.01
        };

        elements.rs_liquid_nitrogen = {
            color: ["#bfd9ff", "#abd0fa"],
            behavior: behaviors.LIQUID,
            temp: -205,
            tempHigh: -196,
            stateHigh: "rs_nitrogen",
            category: "realistic liquids",
            state: "liquid",
            density: 807
        };

        elements.rs_water_vapor = {
            color: ["#f3f8ff", "#e8f1ff", "#ddeaff"],
            behavior: function(pixel) {
                applyGasMovement(pixel, elements.rs_water_vapor);
                doDefaults(pixel);
            },
            temp: 120,
            tempLow: 100,
            stateLow: "rs_water",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic gases",
            state: "gas",
            density: 0.6,
            extinguish: true
        };

        elements.rs_water = {
            color: ["#4f90ff", "#2b74ee", "#6aa8ff"],
            behavior: behaviors.LIQUID,
            temp: 20,
            tempLow: 0,
            stateLow: "rs_ice",
            tempHigh: 100,
            stateHigh: "rs_water_vapor",
            category: "realistic liquids",
            state: "liquid",
            density: 997,
            conduct: 0.02,
            extinguish: true
        };

        elements.rs_ice = {
            color: ["#c7e6ff", "#d6eeff", "#b8dcf8"],
            behavior: behaviors.WALL,
            temp: -10,
            tempHigh: 0,
            stateHigh: "rs_water",
            tempLow: -218,
            stateLow: "rs_ice",
            category: "realistic solids",
            state: "solid",
            density: 917
        };

        elements.rs_silicate = {
            color: ["#8b7f72", "#7f756a", "#9a8c7e"],
            behavior: behaviors.POWDER,
            temp: 20,
            tempHigh: 1650,
            stateHigh: "rs_silicate_melt",
            category: "realistic solids",
            state: "solid",
            density: 2600
        };

        elements.rs_silicate_melt = {
            color: ["#ffb061", "#ff8f4f", "#f7c071"],
            behavior: behaviors.MOLTEN,
            temp: 1700,
            tempLow: 1550,
            stateLow: "rs_silicate",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic liquids",
            state: "liquid",
            density: 2400,
            viscosity: 45000
        };

        elements.rs_iron = {
            color: ["#9b9fa3", "#8f9398", "#b0b5ba"],
            behavior: behaviors.WALL,
            temp: 20,
            tempHigh: 1538,
            stateHigh: "rs_molten_iron",
            category: "realistic solids",
            state: "solid",
            density: 7870,
            conduct: 0.8
        };

        elements.rs_molten_iron = {
            color: ["#ffb45e", "#ff8a39", "#ffc16f"],
            behavior: behaviors.MOLTEN,
            temp: 1600,
            tempLow: 1538,
            stateLow: "rs_iron",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic liquids",
            state: "liquid",
            density: 6980,
            viscosity: 8500,
            conduct: 0.85
        };

        elements.rs_iron_oxide = {
            color: ["#965946", "#a0654f", "#7f4637"],
            behavior: behaviors.POWDER,
            temp: 20,
            tempHigh: 1565,
            stateHigh: "rs_slag",
            category: "realistic solids",
            state: "solid",
            density: 5240
        };

        elements.rs_uranium = {
            color: ["#8e9f5b", "#7f9250", "#9aae63"],
            behavior: behaviors.WALL,
            temp: 20,
            tempHigh: 1132,
            stateHigh: "rs_molten_uranium",
            category: "realistic solids",
            state: "solid",
            density: 19050,
            conduct: 0.3
        };

        elements.rs_molten_uranium = {
            color: ["#d8d067", "#c9c05c", "#e2da72"],
            behavior: behaviors.MOLTEN,
            temp: 1200,
            tempLow: 1132,
            stateLow: "rs_uranium",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic liquids",
            state: "liquid",
            density: 17300,
            viscosity: 16000
        };

        elements.rs_slag = {
            color: ["#6e5e53", "#7b675a", "#8a7565"],
            behavior: behaviors.MOLTEN,
            temp: 1550,
            tempLow: 1200,
            stateLow: "rs_silicate",
            tempHigh: RS_IONIZATION_TEMP,
            stateHigh: "rs_plasma",
            category: "realistic liquids",
            state: "liquid",
            density: 3200,
            viscosity: 90000
        };

        elements.rs_plasma = {
            color: ["#ffdd8a", "#ffd05a", "#ffe8ad"],
            behavior: function(pixel) {
                applyGasMovement(pixel, elements.rs_plasma);
                doHeat(pixel);
                doElectricity(pixel);
            },
            temp: 11000,
            tempLow: 6500,
            stateLow: "rs_heat",
            category: "energy",
            state: "gas",
            density: 0.12,
            conduct: 1,
            glow: true
        };
    }

    defineRsElements();

    runAfterLoad(function() {
        removeConflictingMods();

        for (var name in elements) {
            if (!isRsElementName(name)) {
                continue;
            }
            setIonizationHook(name);
        }
        installPlasmaCoolingHook();

        hideLegacyElements();

        if (AUTO_MIGRATE_LEGACY_PIXELS) {
            migrateLegacyPixels();
        }

        console.log("[realistic_chemistry_overhaul] active; legacy elements hidden, rs_* chemistry enabled");
    });

    runPerPixel(function(pixel) {
        if (!pixel || pixel.del || !isRsElementName(pixel.element)) {
            return;
        }
        attemptStoichiometricReaction(pixel);
    });
})();
