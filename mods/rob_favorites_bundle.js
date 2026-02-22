// Rob Favorites Bundle
// Enable this one mod to restore Rob's preferred gameplay stack.

(function() {
    "use strict";

    var MOD_NAME = "mods/rob_favorites_bundle.js";
    var OVERHAUL_MOD = "mods/realistic_chemistry_overhaul.js";
    var FAVORITE_MODS = [
        "mods/chem.js",
        "mods/spring.js",
        "mods/thermostat.js",
        "mods/heat_capacity.js",
        "mods/high_heat_realism.js",
        "mods/kelp_food.js",
        "mods/boiling_things.js",
        "mods/ticking_temp_stuff.js",
        "mods/gravity.js",
        "mods/velocity2.js",
        "mods/coldblooded.js",
        "mods/heatglow.js",
        "mods/nature_Mod.js",
        "mods/pressure_mvp.js"
    ];

    function ensureFavoriteStack() {
        var changed = false;

        var overhaulIndex = enabledMods.indexOf(OVERHAUL_MOD);
        if (overhaulIndex !== -1) {
            enabledMods.splice(overhaulIndex, 1);
            changed = true;
        }

        for (var i = 0; i < FAVORITE_MODS.length; i++) {
            var modPath = FAVORITE_MODS[i];
            if (!enabledMods.includes(modPath)) {
                enabledMods.push(modPath);
                changed = true;
            }
        }

        if (!changed) {
            return;
        }

        localStorage.setItem("enabledMods", JSON.stringify(enabledMods));
        alert("rob_favorites_bundle synced your favorite mod stack. Reloading now.");
        window.location.reload();
    }

    ensureFavoriteStack();

    runAfterLoad(function() {
        console.log("[rob_favorites_bundle] active", {
            mod: MOD_NAME,
            favorites: FAVORITE_MODS.length
        });
    });
})();
