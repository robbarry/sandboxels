// Biosphere Tools - Thermostat, Fans, and Producer
// Shift-click to configure before placing

// ============ PRODUCER ============
// Like spout but for any element

var producerSettings = {
    element: "water",
    rate: 0.1  // chance per tick per adjacent cell
};

function producerTick(pixel) {
    var elem = pixel.produceElement || producerSettings.element;
    var rate = pixel.produceRate || producerSettings.rate;

    for (var i = 0; i < adjacentCoords.length; i++) {
        if (Math.random() > rate) continue;
        var x = pixel.x + adjacentCoords[i][0];
        var y = pixel.y + adjacentCoords[i][1];
        if (isEmpty(x, y)) {
            createPixel(elem, x, y);
        }
    }
}

elements.producer = {
    color: "#606378",
    behavior: behaviors.WALL,
    onShiftSelect: function(el) {
        promptInput("Element to produce:", function(e) {
            if (!elements[e]) {
                console.log("Unknown element: " + e);
                return;
            }
            producerSettings.element = e;
            promptInput("Rate (0-1, chance per tick):", function(r) {
                r = parseFloat(r);
                if (isNaN(r) || r <= 0 || r > 1) return;
                producerSettings.rate = r;
            }, "0.1");
        }, "water");
    },
    tick: producerTick,
    properties: {
        produceElement: "water",
        produceRate: 0.1
    },
    onPlace: function(pixel) {
        pixel.produceElement = producerSettings.element;
        pixel.produceRate = producerSettings.rate;
    },
    category: "machines",
    movable: false,
    desc: "Produces any element. Shift-click to configure."
};

// Pre-configured producers for mobile/convenience
function makeProducer(element, color, rate) {
    return {
        color: color,
        behavior: behaviors.WALL,
        tick: producerTick,
        properties: {
            produceElement: element,
            produceRate: rate || 0.1
        },
        category: "machines",
        movable: false,
        desc: "Produces " + element + "."
    };
}

elements.co2_producer = makeProducer("carbon_dioxide", "#445566");
elements.oxygen_producer = makeProducer("oxygen", "#6688aa");
elements.helium_producer = makeProducer("helium", "#ffccee");
elements.nitrogen_producer = makeProducer("nitrogen", "#556677");
elements.steam_producer = makeProducer("steam", "#aabbcc");
elements.water_producer = makeProducer("water", "#3377bb");
elements.fire_producer = makeProducer("fire", "#cc4422", 0.2);

// ============ THERMOSTAT ============

elements.thermostat = {
    color: "#884422",
    temp: 100,
    onShiftSelect: function(element) {
        promptInput("Enter target temperature (Celsius).", function(r) {
            r = parseFloat(r);
            if (isNaN(r)) return;
            elements.thermostat.temp = r;
        }, "100");
    },
    tick: function(pixel) {
        var target = pixel.targetTemp !== undefined ? pixel.targetTemp : elements.thermostat.temp;

        for (var i = 0; i < adjacentCoords.length; i++) {
            var x = pixel.x + adjacentCoords[i][0];
            var y = pixel.y + adjacentCoords[i][1];
            if (isEmpty(x, y, true)) continue;

            var neighbor = pixelMap[x][y];
            if (elements[neighbor.element].insulate) continue;

            var diff = target - neighbor.temp;
            if (Math.abs(diff) < 1) continue;

            var change = Math.sign(diff) * Math.min(Math.abs(diff), 5);
            neighbor.temp += change;
            pixelTempCheck(neighbor);
        }
    },
    properties: {
        targetTemp: 100
    },
    onPlace: function(pixel) {
        pixel.targetTemp = elements.thermostat.temp;
    },
    category: "machines",
    insulate: true,
    movable: false,
    desc: "Heats or cools neighbors to target temp. Shift-click to set target."
};

// ============ FANS ============
// Requires velocity.js for physics-based movement

// Shared fan settings
var fanSettings = {
    force: 1.0      // force at the source (falls off with distance²)
};

// Force falloff: inverse square gives realistic air physics
// At distance 1: full force
// At distance 2: 1/4 force
// At distance 5: 1/25 force
// etc.
function getFalloffForce(baseForce, distance) {
    if (distance <= 0) return baseForce;
    return baseForce / (distance * distance);
}

function fanTickHorizontal(pixel, direction) {
    var force = pixel.fanForce || fanSettings.force;

    for (var i = 1; ; i++) {
        var x = pixel.x + (i * direction);
        var y = pixel.y;

        if (outOfBounds(x, y)) break;

        // Calculate force with distance falloff
        var effectiveForce = getFalloffForce(force, i);

        // Stop when force becomes negligible
        if (effectiveForce < 0.001) break;

        if (isEmpty(x, y)) continue;

        var target = pixelMap[x][y];
        if (!target) continue;
        if (!elements[target.element].movable) continue;

        // Initialize velocity if needed
        if (target.vx === undefined) target.vx = 0;

        // Add force in direction
        target.vx += effectiveForce * direction;
    }
}

function fanTickVertical(pixel, direction) {
    var force = pixel.fanForce || fanSettings.force;

    for (var i = 1; ; i++) {
        var x = pixel.x;
        var y = pixel.y + (i * direction);

        if (outOfBounds(x, y)) break;

        // Calculate force with distance falloff
        var effectiveForce = getFalloffForce(force, i);

        // Stop when force becomes negligible
        if (effectiveForce < 0.001) break;

        if (isEmpty(x, y)) continue;

        var target = pixelMap[x][y];
        if (!target) continue;
        if (!elements[target.element].movable) continue;

        // Initialize velocity if needed
        if (target.vy === undefined) target.vy = 0;

        // Add force in direction
        target.vy += effectiveForce * direction;
    }
}

elements.fan_right = {
    color: "#7799cc",
    behavior: behaviors.WALL,
    onShiftSelect: function(element) {
        promptInput("Force at source (falls off with distance²):", function(f) {
            f = parseFloat(f);
            if (isNaN(f) || f <= 0) return;
            fanSettings.force = f;
        }, "1");
    },
    tick: function(pixel) {
        fanTickHorizontal(pixel, 1);
    },
    properties: {
        fanForce: 1.0
    },
    onPlace: function(pixel) {
        pixel.fanForce = fanSettings.force;
    },
    category: "machines",
    movable: false,
    desc: "Wind with inverse-square falloff. Shift-click to set force. Requires velocity.js"
};

elements.fan_left = {
    color: "#cc9977",
    behavior: behaviors.WALL,
    onShiftSelect: elements.fan_right.onShiftSelect,
    tick: function(pixel) {
        fanTickHorizontal(pixel, -1);
    },
    properties: {
        fanForce: 1.0
    },
    onPlace: function(pixel) {
        pixel.fanForce = fanSettings.force;
    },
    category: "machines",
    movable: false,
    desc: "Wind with inverse-square falloff. Shift-click to set force. Requires velocity.js"
};

elements.fan_up = {
    color: "#99cc77",
    behavior: behaviors.WALL,
    onShiftSelect: elements.fan_right.onShiftSelect,
    tick: function(pixel) {
        fanTickVertical(pixel, -1);
    },
    properties: {
        fanForce: 1.0
    },
    onPlace: function(pixel) {
        pixel.fanForce = fanSettings.force;
    },
    category: "machines",
    movable: false,
    desc: "Wind with inverse-square falloff. Shift-click to set force. Requires velocity.js"
};

elements.fan_down = {
    color: "#cc77cc",
    behavior: behaviors.WALL,
    onShiftSelect: elements.fan_right.onShiftSelect,
    tick: function(pixel) {
        fanTickVertical(pixel, 1);
    },
    properties: {
        fanForce: 1.0
    },
    onPlace: function(pixel) {
        pixel.fanForce = fanSettings.force;
    },
    category: "machines",
    movable: false,
    desc: "Wind with inverse-square falloff. Shift-click to set force. Requires velocity.js"
};
