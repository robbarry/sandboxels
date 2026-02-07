// High Heat Realism
// Fixes materials that are missing realistic high-temperature behavior

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
});
