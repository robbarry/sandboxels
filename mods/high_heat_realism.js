// High Heat Realism
// Fixes materials that are missing realistic high-temperature behavior

// At extreme temperatures, matter ionizes into plasma.
const IONIZATION_TEMP = 10000;
const PLASMA_MIXING_CHANCE = 0.4;
const PLASMA_MIXING_FRACTION = 0.2;
const PLASMA_MAX_COMPONENTS = 4;
const PLASMA_MIN_COMPONENT = 0.03;
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

function canonicalizePlasmaSource(elementName) {
    if (typeof elementName !== "string") {
        return null;
    }
    if (elementName.startsWith("molten_")) {
        const baseName = elementName.slice(7);
        if (elements[baseName]) {
            return baseName;
        }
    }
    if (elements[elementName]) {
        return elementName;
    }
    return null;
}

function normalizePlasmaComposition(composition) {
    if (!composition || typeof composition !== "object") {
        return null;
    }

    const entries = [];
    for (const name in composition) {
        const canonicalName = canonicalizePlasmaSource(name);
        const share = Number(composition[name]);
        if (!canonicalName || !Number.isFinite(share) || share <= 0) {
            continue;
        }
        entries.push([canonicalName, share]);
    }

    if (!entries.length) {
        return null;
    }

    const merged = {};
    for (let i = 0; i < entries.length; i++) {
        const name = entries[i][0];
        merged[name] = (merged[name] || 0) + entries[i][1];
    }

    const mergedEntries = Object.entries(merged).sort(function(a, b) {
        return b[1] - a[1];
    }).slice(0, PLASMA_MAX_COMPONENTS);

    let total = 0;
    for (let i = 0; i < mergedEntries.length; i++) {
        total += mergedEntries[i][1];
    }
    if (!(total > 0)) {
        return null;
    }

    const normalized = {};
    for (let i = 0; i < mergedEntries.length; i++) {
        const entry = mergedEntries[i];
        const fraction = entry[1] / total;
        if (fraction >= PLASMA_MIN_COMPONENT) {
            normalized[entry[0]] = fraction;
        }
    }

    const keys = Object.keys(normalized);
    if (!keys.length) {
        const top = mergedEntries[0];
        normalized[top[0]] = 1;
    }

    let renormalizedTotal = 0;
    for (const name in normalized) {
        renormalizedTotal += normalized[name];
    }
    for (const name in normalized) {
        normalized[name] /= renormalizedTotal;
    }
    return normalized;
}

function getDominantCompositionElement(composition) {
    let dominantElement = null;
    let dominantFraction = -1;
    for (const name in composition) {
        if (composition[name] > dominantFraction) {
            dominantFraction = composition[name];
            dominantElement = name;
        }
    }
    return dominantElement;
}

function setPlasmaComposition(pixel, composition) {
    const normalized = normalizePlasmaComposition(composition);
    if (!normalized) {
        delete pixel.hhrPlasmaComposition;
        return null;
    }
    pixel.hhrPlasmaComposition = normalized;
    const dominant = getDominantCompositionElement(normalized);
    if (dominant) {
        pixel.hhrIonizedFrom = dominant;
    }
    return normalized;
}

function ensurePlasmaComposition(pixel) {
    if (!pixel || pixel.element !== "plasma") {
        return null;
    }
    if (pixel.hhrPlasmaComposition) {
        return setPlasmaComposition(pixel, pixel.hhrPlasmaComposition);
    }

    const sourceElement = canonicalizePlasmaSource(pixel.hhrIonizedFrom);
    if (!sourceElement) {
        return null;
    }
    const composition = {};
    composition[sourceElement] = 1;
    return setPlasmaComposition(pixel, composition);
}

function isMatterDerivedPlasma(pixel) {
    return !!(
        pixel &&
        pixel.element === "plasma" &&
        (
            pixel.hhrIonizedFrom !== undefined ||
            pixel.hhrPlasmaComposition !== undefined
        )
    );
}

function blendCompositions(compositionA, compositionB, blendFraction) {
    const keys = new Set(Object.keys(compositionA).concat(Object.keys(compositionB)));
    const mixedA = {};
    const mixedB = {};

    keys.forEach(function(name) {
        const a = compositionA[name] || 0;
        const b = compositionB[name] || 0;
        mixedA[name] = a * (1 - blendFraction) + b * blendFraction;
        mixedB[name] = b * (1 - blendFraction) + a * blendFraction;
    });

    return [mixedA, mixedB];
}

function coolPlasmaToMaterial(pixel) {
    const composition = ensurePlasmaComposition(pixel);
    if (!composition) {
        return canonicalizePlasmaSource(pixel.hhrIonizedFrom);
    }

    const entries = Object.entries(composition);
    if (!entries.length) {
        return canonicalizePlasmaSource(pixel.hhrIonizedFrom);
    }
    if (entries.length === 1) {
        return entries[0][0];
    }

    let totalWeight = 0;
    const weightedEntries = [];
    for (let i = 0; i < entries.length; i++) {
        const name = entries[i][0];
        const fraction = entries[i][1];
        const weight = Math.pow(fraction, 1.35);
        if (!(weight > 0)) {
            continue;
        }
        weightedEntries.push([name, weight]);
        totalWeight += weight;
    }

    if (!(totalWeight > 0)) {
        return getDominantCompositionElement(composition);
    }

    let roll = Math.random() * totalWeight;
    for (let i = 0; i < weightedEntries.length; i++) {
        roll -= weightedEntries[i][1];
        if (roll <= 0) {
            return weightedEntries[i][0];
        }
    }
    return weightedEntries[weightedEntries.length - 1][0];
}

function mixIonizedPlasma(pixel) {
    if (!isMatterDerivedPlasma(pixel) || Math.random() >= PLASMA_MIXING_CHANCE) {
        return;
    }
    if (pixel.temp <= elements.plasma.tempLow) {
        return;
    }

    const composition = ensurePlasmaComposition(pixel);
    if (!composition) {
        return;
    }

    const coord = adjacentCoords[Math.floor(Math.random() * adjacentCoords.length)];
    const nx = pixel.x + coord[0];
    const ny = pixel.y + coord[1];
    if (outOfBounds(nx, ny) || isEmpty(nx, ny, true)) {
        return;
    }

    const other = pixelMap[nx][ny];
    if (!isMatterDerivedPlasma(other)) {
        return;
    }

    const otherComposition = ensurePlasmaComposition(other);
    if (!otherComposition) {
        return;
    }

    const mixed = blendCompositions(composition, otherComposition, PLASMA_MIXING_FRACTION);
    setPlasmaComposition(pixel, mixed[0]);
    setPlasmaComposition(other, mixed[1]);
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
    const canonicalSource = canonicalizePlasmaSource(sourceElement);
    info.onStateHigh = function(pixel) {
        if (
            pixel.element === "plasma" &&
            pixel.temp >= IONIZATION_TEMP &&
            canonicalSource
        ) {
            if (pixel.hhrIonizedFrom === undefined) {
                pixel.hhrIonizedFrom = canonicalSource;
            }
            if (!pixel.hhrPlasmaComposition) {
                const composition = {};
                composition[canonicalSource] = 1;
                setPlasmaComposition(pixel, composition);
            }
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
        const sourceElement = coolPlasmaToMaterial(pixel);
        if (sourceElement && elements[sourceElement]) {
            delete pixel.hhrIonizedFrom;
            delete pixel.hhrPlasmaComposition;
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
        if (isMatterDerivedPlasma(pixel)) {
            // Preserve mass for matter-derived plasma so it can cool back down,
            // but skip built-in air-density lift to avoid unbounded rise.
            shuffleArray(adjacentCoordsShuffle);
            let moved = false;
            for (let i = 0; i < adjacentCoordsShuffle.length; i++) {
                const coords = adjacentCoordsShuffle[i];
                if (tryMove(pixel, pixel.x + coords[0], pixel.y + coords[1])) {
                    moved = true;
                    break;
                }
            }
            if (moved === false) {
                shuffleArray(diagonalCoordsShuffle);
                for (let i = 0; i < diagonalCoordsShuffle.length; i++) {
                    const coords = diagonalCoordsShuffle[i];
                    if (tryMove(pixel, pixel.x + coords[0], pixel.y + coords[1])) {
                        break;
                    }
                }
            }
            if (pixel.del !== true) {
                doHeat(pixel);
                doBurning(pixel);
                doElectricity(pixel);
            }
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

function coolIonizedPlasma(pixel) {
    if (!isMatterDerivedPlasma(pixel)) {
        return;
    }
    if (pixel.temp <= elements.plasma.tempLow) {
        return;
    }

    const overTemp = pixel.temp - elements.plasma.tempLow;
    // Strong T-dependent cooling keeps ionized plumes transient at extreme temperatures.
    const radiativeLoss = Math.min(120000, Math.max(120, 30 + overTemp * 0.06));
    pixel.temp -= radiativeLoss;
    pixelTempCheck(pixel);
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

runPerPixel(function(pixel) {
    mixIonizedPlasma(pixel);
    coolIonizedPlasma(pixel);
});
