// Velocity physics - smoother version with gentler friction
// Pixels can have vx/vy properties that persist and decay gradually

runAfterLoad(function(){

var FRICTION = 0.98;  // velocity multiplier per tick (0.98 = 2% loss)
var MIN_VELOCITY = 0.1;  // velocities below this are zeroed

doVelocity = function(pixel) {
    if (!(pixel.vx || pixel.vy) || !elements[pixel.element].movable) return;

    // Handle horizontal velocity
    if (pixel.vx) {
        var moveAmount = Math.floor(Math.abs(pixel.vx));
        var direction = Math.sign(pixel.vx);

        for (var i = 0; i < moveAmount; i++) {
            var x = pixel.x + direction;
            var y = pixel.y;

            if (!tryMove(pixel, x, y)) {
                if (!isEmpty(x, y, true)) {
                    var newPixel = pixelMap[x][y];
                    if (elements[newPixel.element].movable) {
                        // Transfer momentum
                        newPixel.vx = (newPixel.vx || 0) + pixel.vx * 0.5;
                    }
                }
                pixel.vx = 0;
                break;
            }
        }

        // Apply friction
        if (pixel.vx) {
            pixel.vx *= FRICTION;
            if (Math.abs(pixel.vx) < MIN_VELOCITY) pixel.vx = 0;
        }
    }

    // Handle vertical velocity
    if (pixel.vy) {
        var moveAmount = Math.floor(Math.abs(pixel.vy));
        var direction = Math.sign(pixel.vy);

        for (var i = 0; i < moveAmount; i++) {
            var x = pixel.x;
            var y = pixel.y + direction;

            if (!tryMove(pixel, x, y)) {
                if (!isEmpty(x, y, true)) {
                    var newPixel = pixelMap[x][y];
                    if (elements[newPixel.element].movable) {
                        // Transfer momentum
                        newPixel.vy = (newPixel.vy || 0) + pixel.vy * 0.5;
                    }
                }
                pixel.vy = 0;
                break;
            }
        }

        // Apply friction
        if (pixel.vy) {
            pixel.vy *= FRICTION;
            if (Math.abs(pixel.vy) < MIN_VELOCITY) pixel.vy = 0;
        }
    }
}

runPerPixel(doVelocity);

})

// Explosion function with velocity
explodeAt = function(x, y, radius, fire="fire") {
    if (fire.indexOf(",") !== -1) {
        fire = fire.split(",");
    }
    var coords = circleCoords(x, y, radius);
    var power = radius / 10;

    for (var i = 0; i < coords.length; i++) {
        var damage = Math.random() + (Math.floor(Math.sqrt(Math.pow(coords[i].x - x, 2) + Math.pow(coords[i].y - y, 2)))) / radius;
        damage = 1 - damage;
        if (damage < 0) damage = 0;
        damage *= power;

        if (isEmpty(coords[i].x, coords[i].y)) {
            if (damage < 0.02) { }
            else if (damage < 0.2) {
                createPixel("smoke", coords[i].x, coords[i].y);
            }
            else {
                var elem = Array.isArray(fire) ? fire[Math.floor(Math.random() * fire.length)] : fire;
                createPixel(elem, coords[i].x, coords[i].y);
            }
        }
        else if (!outOfBounds(coords[i].x, coords[i].y)) {
            var pixel = pixelMap[coords[i].x][coords[i].y];
            var info = elements[pixel.element];

            if (info.hardness) {
                if (info.hardness < 1) {
                    damage *= Math.pow((1 - info.hardness), info.hardness);
                }
                else { damage = 0; }
            }

            if (damage > 0.9) {
                var newfire = Array.isArray(fire) ? fire[Math.floor(Math.random() * fire.length)] : fire;
                changePixel(pixel, newfire);
                continue;
            }
            else if (damage > 0.25) {
                if (info.breakInto !== undefined) {
                    breakPixel(pixel);
                    continue;
                }
                else {
                    var newfire = Array.isArray(fire) ? fire[Math.floor(Math.random() * fire.length)] : fire;
                    if (elements[pixel.element].onBreak !== undefined) {
                        elements[pixel.element].onBreak(pixel);
                    }
                    changePixel(pixel, newfire);
                    continue;
                }
            }

            if (damage > 0.75 && info.burn) {
                pixel.burning = true;
                pixel.burnStart = pixelTicks;
            }

            pixel.temp += damage * radius * power;
            pixelTempCheck(pixel);

            // Apply explosion velocity
            if (!elements[pixel.element].excludeRandom) {
                var angle = Math.atan2(pixel.y - y, pixel.x - x);
                pixel.vx = (pixel.vx || 0) + Math.cos(angle) * (radius * power / 10);
                pixel.vy = (pixel.vy || 0) + Math.sin(angle) * (radius * power / 10);
            }
        }
    }
}
