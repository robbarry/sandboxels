// Makes porcelain conduct heat slowly (like real ceramic insulator)
// and melt at 1800°C into molten glass

runAfterLoad(function() {
    elements.porcelain.tempHigh = 1800;
    elements.porcelain.stateHigh = "molten_glass";
    elements.porcelain.conduct = 0.005;

    elements.porcelain_shard.tempHigh = 1800;
    elements.porcelain_shard.stateHigh = "molten_glass";
    elements.porcelain_shard.conduct = 0.005;
});
