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
    if (!info || !["solid", "liquid", "gas"].includes(info.state)) {
        return;
    }
    if (HIGH_HEAT_EXCLUDE.has(name)) {
        return;
    }
    if (info.category === "tools" || info.category === "special") {
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
            pixelTempCheck(pixel);
        }
        if (previousOnStateLow) {
            previousOnStateLow(pixel);
        }
    };
    elements.plasma._hhrDeionizationHook = true;
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

    for (const name in elements) {
        addIonizationTransition(name, elements[name]);
    }
    installPlasmaDeionizationHook();
});
