// High Heat Realism
// Fixes materials that are missing realistic high-temperature behavior

// At extreme temperatures, matter ionizes into plasma.
const IONIZATION_TEMP = 10000;
const HIGH_HEAT_EXCLUDE = new Set([
    "plasma",
    "fire",
    "cold_fire",
    "light",
    "liquid_light",
    "laser",
    "pointer",
    "sun",
    "supernova",
    "explosion",
    "n_explosion",
    "pop",
    "radiation",
    "electric",
    "neutron",
    "proton",
    "positron",
    "void",
    "flash",
    "bless",
    "god_ray",
    "heat_ray",
    "freeze_ray"
]);

const DEIONIZATION_OXIDIZER_STRENGTH = {
    oxygen: 0.45,
    ozone: 0.6,
    steam: 0.18,
    water: 0.12,
    salt_water: 0.15,
    sugar_water: 0.1,
    dirty_water: 0.13,
    pool_water: 0.13,
    seltzer: 0.15,
    acid_cloud: 0.2,
    cloud: 0.08,
    rain_cloud: 0.1
};

const EXPLICIT_OXIDATION_PRODUCTS = {
    iron: "rust",
    steel: "rust",
    molten_iron: "rust",
    molten_steel: "rust",
    galvanized_steel: "rust",
    molten_galvanized_steel: "rust",
    copper: "oxidized_copper",
    bronze: "oxidized_copper",
    molten_copper: "oxidized_copper",
    molten_bronze: "oxidized_copper",
    calcium: "quicklime",
    molten_calcium: "quicklime"
};

const NON_OXIDATION_PRODUCTS = new Set([
    "fire",
    "cold_fire",
    "plasma",
    "smoke",
    "steam",
    "hydrogen",
    "oxygen",
    "ozone",
    "carbon_dioxide",
    "flash",
    "explosion",
    "n_explosion",
    "pop",
    "light",
    "electric"
]);

function isPlasmaResult(result) {
    if (result === "plasma") {
        return true;
    }
    if (Array.isArray(result) && result.includes("plasma")) {
        return true;
    }
    return false;
}

function hasPlasmaTransition(info) {
    if (isPlasmaResult(info.stateHigh)) {
        return true;
    }
    if (info.extraTempHigh) {
        for (const threshold in info.extraTempHigh) {
            if (isPlasmaResult(info.extraTempHigh[threshold])) {
                return true;
            }
        }
    }
    return false;
}

function addIonizationTransition(name, info) {
    if (!info) {
        return;
    }
    if (HIGH_HEAT_EXCLUDE.has(name)) {
        return;
    }
    if (info.category === "tools" || info.category === "special") {
        return;
    }
    const hasPhysicalState = ["solid", "liquid", "gas"].includes(info.state);
    const isMoltenPhase = typeof name === "string" && name.startsWith("molten_");
    if (!hasPhysicalState && !isMoltenPhase) {
        return;
    }
    if (hasPlasmaTransition(info)) {
        return;
    }

    if (typeof info.tempHigh !== "number") {
        info.tempHigh = IONIZATION_TEMP;
        info.stateHigh = "plasma";
        attachIonizationSourceHook(name, info);
        return;
    }

    if (info.stateHigh === null || info.stateHigh === undefined) {
        return;
    }

    if (!info.extraTempHigh) {
        info.extraTempHigh = {};
    }
    info.extraTempHigh[IONIZATION_TEMP] = "plasma";
    attachIonizationSourceHook(name, info);
}

function attachIonizationSourceHook(sourceElement, info) {
    if (info._hhrIonizationHook) {
        return;
    }
    const previousOnStateHigh = info.onStateHigh;
    info.onStateHigh = function(pixel) {
        if (
            pixel.element === "plasma" &&
            pixel.temp >= IONIZATION_TEMP &&
            pixel.hhrIonizedFrom === undefined
        ) {
            pixel.hhrIonizedFrom = sourceElement;
        }
        if (previousOnStateHigh) {
            previousOnStateHigh(pixel);
        }
    };
    info._hhrIonizationHook = true;
}

function installPlasmaDeionizationHook() {
    if (!elements.plasma || elements.plasma._hhrDeionizationHook) {
        return;
    }
    const previousOnStateLow = elements.plasma.onStateLow;
    elements.plasma.onStateLow = function(pixel) {
        const sourceElement = pixel.hhrIonizedFrom;
        if (sourceElement && elements[sourceElement]) {
            delete pixel.hhrIonizedFrom;
            changePixel(pixel, sourceElement, false);
            maybeOxidizeDeionizedPixel(pixel, sourceElement);
            pixelTempCheck(pixel);
        }
        if (previousOnStateLow) {
            previousOnStateLow(pixel);
        }
    };
    elements.plasma._hhrDeionizationHook = true;
}

function installPlasmaStabilityHook() {
    if (!elements.plasma || elements.plasma._hhrBehaviorHook) {
        return;
    }
    const defaultBehavior = elements.plasma.behavior;
    elements.plasma.behavior = function(pixel) {
        if (pixel.hhrIonizedFrom !== undefined) {
            // Preserve mass for matter-derived plasma so it can cool back down.
            behaviors.GAS(pixel);
            return;
        }
        if (typeof defaultBehavior === "function") {
            defaultBehavior(pixel);
            return;
        }
        behaviors.DGAS(pixel);
    };
    elements.plasma._hhrBehaviorHook = true;
}

function pickResult(value) {
    if (Array.isArray(value)) {
        return value[Math.floor(Math.random() * value.length)];
    }
    return value;
}

function getOxidationProduct(sourceElement) {
    const explicit = EXPLICIT_OXIDATION_PRODUCTS[sourceElement];
    if (explicit && elements[explicit]) {
        return explicit;
    }

    const sourceInfo = elements[sourceElement];
    if (!sourceInfo || !sourceInfo.reactions) {
        return null;
    }

    const oxygenReaction = sourceInfo.reactions.oxygen || sourceInfo.reactions.ozone;
    if (!oxygenReaction || oxygenReaction.elem1 === undefined) {
        return null;
    }

    const candidate = pickResult(oxygenReaction.elem1);
    if (typeof candidate !== "string" || !elements[candidate]) {
        return null;
    }
    if (NON_OXIDATION_PRODUCTS.has(candidate)) {
        return null;
    }
    return candidate;
}

function getDeionizationOxidationChance(pixel) {
    let chance = 0.02; // weak ambient oxidation in normal air
    let ambientAirCells = 0;

    for (let i = 0; i < adjacentCoords.length; i++) {
        const x = pixel.x + adjacentCoords[i][0];
        const y = pixel.y + adjacentCoords[i][1];
        if (isEmpty(x, y, true)) {
            ambientAirCells++;
            continue;
        }

        const neighborElement = pixelMap[x][y].element;
        chance += DEIONIZATION_OXIDIZER_STRENGTH[neighborElement] || 0;
    }

    chance += Math.min(ambientAirCells * 0.01, 0.04);

    if (pixel.temp >= 3500) {
        chance += 0.2;
    }
    else if (pixel.temp >= 2000) {
        chance += 0.12;
    }
    else if (pixel.temp >= 1000) {
        chance += 0.06;
    }

    return Math.min(chance, 0.95);
}

function maybeOxidizeDeionizedPixel(pixel, sourceElement) {
    const oxidationProduct = getOxidationProduct(sourceElement);
    if (!oxidationProduct) {
        return;
    }

    if (Math.random() < getDeionizationOxidationChance(pixel)) {
        changePixel(pixel, oxidationProduct, false);
    }
}

function applyHighHeatRealismTransitions() {
    for (const name in elements) {
        addIonizationTransition(name, elements[name]);
    }
    installPlasmaDeionizationHook();
    installPlasmaStabilityHook();
}

// -- Porcelain --
// Real porcelain is an excellent thermal insulator (spark plugs, kiln
// linings) that melts around 1800°C into a viscous ceramic liquid.
// Re-solidified, it becomes glassy — not porcelain again.

elements.molten_porcelain = {
    color: ["#f5c87a", "#e8b05c", "#dba04e"],
    behavior: behaviors.MOLTEN,
    tempLow: 1800,
    stateLow: "glass",
    category: "liquids",
    state: "liquid",
    density: 2300,
    hidden: true
};

runAfterLoad(function() {
    elements.porcelain.tempHigh = 1800;
    elements.porcelain.stateHigh = "molten_porcelain";
    elements.porcelain.conduct = 0.005;

    elements.porcelain_shard.tempHigh = 1800;
    elements.porcelain_shard.stateHigh = "molten_porcelain";
    elements.porcelain_shard.conduct = 0.005;

    applyHighHeatRealismTransitions();
});

runAfterAutogen(function() {
    applyHighHeatRealismTransitions();
});
