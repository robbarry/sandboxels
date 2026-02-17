// Pressure MVP (realism pass)
// - Persistent pressure field with diffusion
// - Hydrostatic depth pressure for liquids
// - Compressibility + viscosity-aware momentum
// - Directional valves with throughput limits
// - Pump/vent tools + barometer
// - View 9 = pressure visualization

(function() {
    var pressureMvp = {
        enabled: true,
        stride: 0,
        height: 0,
        field: null,
        scratch: null,
        minX: 0,
        minY: 0,
        maxX: -1,
        maxY: -1,
        defaults: {
            pump: { dirX: 1, dirY: 0, power: 3.2, range: 12 },
            vent: { dirX: 1, dirY: 0, power: 1.8, range: 9 },
            valve: { open: false, dirX: 1, dirY: 0, aperture: 1, maxFlow: 5 }
        },
        compat: {
            externalVelocity: false
        },
        physics: {
            retention: 0.8,
            diffuse: 0.2,
            diffusePasses: 3,
            gradientScale: 0.08,
            gasBuoyancy: 0.045,
            liquidGravity: 0.009
        }
    };

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function sign(n) {
        if (n > 0) return 1;
        if (n < 0) return -1;
        return 0;
    }

    function indexOfCoord(x, y) {
        return y * pressureMvp.stride + x;
    }

    function ensureField() {
        if (width === undefined || height === undefined) return false;

        var targetStride = width + 1;
        var targetHeight = height + 1;
        var total = targetStride * targetHeight;

        if (
            pressureMvp.field === null ||
            pressureMvp.stride !== targetStride ||
            pressureMvp.height !== targetHeight ||
            pressureMvp.field.length !== total
        ) {
            pressureMvp.stride = targetStride;
            pressureMvp.height = targetHeight;
            pressureMvp.field = new Float32Array(total);
            pressureMvp.scratch = new Float32Array(total);
        }

        return true;
    }

    function resetBounds() {
        pressureMvp.minX = pressureMvp.stride - 1;
        pressureMvp.minY = pressureMvp.height - 1;
        pressureMvp.maxX = 0;
        pressureMvp.maxY = 0;
    }

    function markBounds(x, y) {
        if (!pressureMvp.field) return;
        x = clamp(x, 0, pressureMvp.stride - 1);
        y = clamp(y, 0, pressureMvp.height - 1);

        if (x < pressureMvp.minX) pressureMvp.minX = x;
        if (y < pressureMvp.minY) pressureMvp.minY = y;
        if (x > pressureMvp.maxX) pressureMvp.maxX = x;
        if (y > pressureMvp.maxY) pressureMvp.maxY = y;
    }

    function addPressureAt(x, y, value) {
        if (!pressureMvp.field) return;
        if (x < 0 || y < 0 || x >= pressureMvp.stride || y >= pressureMvp.height) return;
        pressureMvp.field[indexOfCoord(x, y)] += value;
        markBounds(x, y);
    }

    function getPressureAt(x, y) {
        if (!pressureMvp.field) return 0;
        if (x < 0 || y < 0 || x >= pressureMvp.stride || y >= pressureMvp.height) return 0;
        return pressureMvp.field[indexOfCoord(x, y)];
    }

    function isFlowInfo(info) {
        return !!(info && info.movable === true && (info.state === "liquid" || info.state === "gas"));
    }

    function isFlowPixel(pixel) {
        if (!pixel || pixel.del) return false;
        var info = elements[pixel.element];
        return isFlowInfo(info);
    }

    function hasExternalVelocityMod() {
        // gravity2.js and similar velocity mods generally expose one or more of these globals.
        return (
            typeof doVelocity === "function" ||
            typeof gravityPull !== "undefined" ||
            typeof velocityMod !== "undefined"
        );
    }

    function getElementDensity(info) {
        if (!info) return 1;
        if (info.density !== undefined) return info.density;
        return info.state === "liquid" ? 1000 : 1;
    }

    function getDensityScale(info) {
        var density = getElementDensity(info);
        if (info.state === "gas") {
            return clamp(density / 1.6, 0.14, 3.2);
        }
        return clamp(density / 1000, 0.35, 4);
    }

    function getViscosityDrag(info) {
        var base = info.state === "gas" ? 0.9 : 0.62;
        if (info.viscosity === undefined) return base;

        // 0..1 where 1 = almost no drag, 0 = very viscous.
        var visc = Math.log(info.viscosity + 1) / 10;
        var drag = base - visc * (info.state === "gas" ? 0.28 : 0.15);
        return clamp(drag, info.state === "gas" ? 0.35 : 0.32, 0.95);
    }

    function getCompressibility(info, densityScale) {
        // Higher value = easier to compress and accelerate from pressure gradients.
        if (info.state === "gas") {
            return clamp(1.9 - densityScale * 0.25, 0.85, 2.2);
        }
        return clamp(0.08 + 0.05 / densityScale, 0.06, 0.18);
    }

    function isFluidCell(x, y) {
        if (outOfBounds(x, y)) return false;
        if (isEmpty(x, y, true)) return false;
        var p = pixelMap[x][y];
        return !!(p && isFlowPixel(p));
    }

    function directionFromName(name) {
        if (!name) return null;
        var value = String(name).toLowerCase().trim();
        if (value === "up") return [0, -1];
        if (value === "down") return [0, 1];
        if (value === "left") return [-1, 0];
        if (value === "right") return [1, 0];
        return null;
    }

    function directionName(dx, dy) {
        if (dx === 0 && dy === -1) return "up";
        if (dx === 0 && dy === 1) return "down";
        if (dx === -1 && dy === 0) return "left";
        return "right";
    }

    function pressureColor(value) {
        var p = clamp(value, -4, 6);
        var r = 24;
        var g = 35;
        var b = 55;

        if (p >= 0) {
            var hot = p / 6;
            r += Math.round(225 * hot);
            g += Math.round(60 * hot);
            b += Math.round(75 * (1 - hot));
        } else {
            var cold = Math.abs(p) / 4;
            r += Math.round(35 * cold);
            g += Math.round(170 * cold);
            b += Math.round(190 * cold);
        }

        r = clamp(r, 0, 255);
        g = clamp(g, 0, 255);
        b = clamp(b, 0, 255);
        return "rgb(" + r + "," + g + "," + b + ")";
    }

    function applyDirectionalSource(x, y, dx, dy, power, range, spread) {
        if (!dx && !dy) return;

        var sideX = -dy;
        var sideY = dx;

        for (var step = 1; step <= range; step++) {
            var tx = x + dx * step;
            var ty = y + dy * step;
            if (outOfBounds(tx, ty)) break;

            var falloff = power / (1 + (step - 1) * 0.6);

            var blocked = false;
            if (!isEmpty(tx, ty, true)) {
                var occupant = pixelMap[tx][ty];
                if (occupant) {
                    if (occupant.element === "pressure_valve") {
                        if (!occupant.open) blocked = true;
                    } else if (!isFlowPixel(occupant)) {
                        blocked = true;
                    }
                }
            }

            addPressureAt(tx, ty, falloff);
            if (spread !== 0) {
                var sideFalloff = (falloff * spread) / (1 + step * 0.35);
                if (Math.abs(sideFalloff) > 0.004) {
                    addPressureAt(tx + sideX, ty + sideY, sideFalloff);
                    addPressureAt(tx - sideX, ty - sideY, sideFalloff);
                }
            }

            if (blocked) break;
        }

        markBounds(x - range - 1, y - range - 1);
        markBounds(x + range + 1, y + range + 1);
    }

    function applyHydrostaticPressure(minX, minY, maxX, maxY) {
        for (var x = minX; x <= maxX; x++) {
            var columnHead = 0;

            for (var y = maxY; y >= minY; y--) {
                if (isEmpty(x, y, true)) {
                    columnHead = 0;
                    continue;
                }

                var pixel = pixelMap[x][y];
                if (!pixel || pixel.del) {
                    columnHead = 0;
                    continue;
                }

                var info = elements[pixel.element];
                if (!isFlowInfo(info) || info.state !== "liquid") {
                    columnHead = 0;
                    continue;
                }

                var densityScale = getDensityScale(info);
                columnHead += 0.028 * densityScale;
                addPressureAt(x, y, columnHead);
            }
        }
    }

    function diffusePressureField(minX, minY, maxX, maxY) {
        if (maxX <= minX || maxY <= minY) return;

        var d = pressureMvp.physics.diffuse;
        var passes = pressureMvp.physics.diffusePasses;
        var stride = pressureMvp.stride;
        var field = pressureMvp.field;
        var scratch = pressureMvp.scratch;

        for (var pass = 0; pass < passes; pass++) {
            for (var y = minY; y <= maxY; y++) {
                var row = y * stride;
                for (var x = minX; x <= maxX; x++) {
                    var idx = row + x;
                    var center = field[idx];
                    if (!isFluidCell(x, y)) {
                        scratch[idx] = center * 0.9;
                        continue;
                    }

                    var sum = 0;
                    var count = 0;
                    if (isFluidCell(x - 1, y)) {
                        sum += field[idx - 1];
                        count++;
                    }
                    if (isFluidCell(x + 1, y)) {
                        sum += field[idx + 1];
                        count++;
                    }
                    if (isFluidCell(x, y - 1)) {
                        sum += field[idx - stride];
                        count++;
                    }
                    if (isFluidCell(x, y + 1)) {
                        sum += field[idx + stride];
                        count++;
                    }

                    if (count === 0) {
                        scratch[idx] = center;
                        continue;
                    }

                    var avg = sum / count;
                    scratch[idx] = center + (avg - center) * d;
                }
            }

            for (var yy = minY; yy <= maxY; yy++) {
                var rowCopy = yy * stride;
                for (var xx = minX; xx <= maxX; xx++) {
                    var copyIdx = rowCopy + xx;
                    field[copyIdx] = scratch[copyIdx];
                }
            }
        }
    }

    function updateFlowMomentum() {
        var physics = pressureMvp.physics;
        var stride = pressureMvp.stride;
        var maxX = stride - 1;
        var maxY = pressureMvp.height - 1;

        for (var i = 0; i < currentPixels.length; i++) {
            var pixel = currentPixels[i];
            if (!pixel || pixel.del) continue;

            var info = elements[pixel.element];
            if (!isFlowInfo(info)) continue;

            var x = pixel.x;
            var y = pixel.y;

            if (x <= 0 || y <= 0 || x >= maxX || y >= maxY) {
                pixel.flowVx = (pixel.flowVx || 0) * 0.6;
                pixel.flowVy = (pixel.flowVy || 0) * 0.6;
                pixel.pressure = getPressureAt(x, y);
                continue;
            }

            var densityScale = getDensityScale(info);
            var compressibility = getCompressibility(info, densityScale);
            var drag = getViscosityDrag(info);
            var pCenter = getPressureAt(x, y);
            var pRight = isFluidCell(x + 1, y) ? getPressureAt(x + 1, y) : pCenter;
            var pLeft = isFluidCell(x - 1, y) ? getPressureAt(x - 1, y) : pCenter;
            var pDown = isFluidCell(x, y + 1) ? getPressureAt(x, y + 1) : pCenter;
            var pUp = isFluidCell(x, y - 1) ? getPressureAt(x, y - 1) : pCenter;

            var gradX = pRight - pLeft;
            var gradY = pDown - pUp;

            var vx = (pixel.flowVx || 0) * drag;
            var vy = (pixel.flowVy || 0) * drag;

            var accelX = -gradX * physics.gradientScale * compressibility / Math.max(0.2, densityScale);
            var accelY = -gradY * physics.gradientScale * compressibility / Math.max(0.2, densityScale);

            if (info.state === "gas") {
                accelY -= physics.gasBuoyancy * clamp(1.45 / densityScale, 0.7, 2.3);
            } else {
                accelY += physics.liquidGravity * densityScale;
                accelX *= 0.34;
                accelY *= 0.72;
            }

            if (pressureMvp.compat.externalVelocity) {
                // Let external velocity/gravity mods own kinetic transport.
                pixel.flowVx = (pixel.flowVx || 0) * 0.55;
                pixel.flowVy = (pixel.flowVy || 0) * 0.55;
                if (Math.abs(pixel.flowVx) < 0.02) pixel.flowVx = 0;
                if (Math.abs(pixel.flowVy) < 0.02) pixel.flowVy = 0;
                pixel.pressure = getPressureAt(x, y);
                continue;
            }

            vx += accelX;
            vy += accelY;

            if (info.state === "liquid") {
                // No-slip boundary approximation: liquids damp hard near solid walls.
                var wallContacts = 0;
                for (var w = 0; w < adjacentCoords.length; w++) {
                    var wx = x + adjacentCoords[w][0];
                    var wy = y + adjacentCoords[w][1];
                    if (outOfBounds(wx, wy)) {
                        wallContacts++;
                        continue;
                    }
                    if (isEmpty(wx, wy, true)) continue;
                    var near = pixelMap[wx][wy];
                    if (!near || !isFlowPixel(near)) wallContacts++;
                }
                var wallDrag = 1 - Math.min(0.42, wallContacts * 0.08);
                vx *= wallDrag;
                vy *= wallDrag;
            } else {
                var speed = Math.sqrt(vx * vx + vy * vy);
                var reynoldsLike = speed * densityScale / Math.max(0.15, 1 - drag + 0.05);
                if (reynoldsLike > 2.8 && Math.random() < 0.28) {
                    vx += (Math.random() - 0.5) * 0.04;
                    vy += (Math.random() - 0.5) * 0.04;
                }
            }

            var cap = info.state === "gas" ? 2.9 : 1.1;
            pixel.flowVx = clamp(vx, -cap, cap);
            pixel.flowVy = clamp(vy, -cap * 1.15, cap * 1.15);

            if (Math.abs(pixel.flowVx) < 0.015) pixel.flowVx = 0;
            if (Math.abs(pixel.flowVy) < 0.015) pixel.flowVy = 0;

            pixel.pressure = getPressureAt(x, y);
        }
    }

    function rebuildPressureField() {
        if (!pressureMvp.enabled) return;
        if (!ensureField()) return;

        var field = pressureMvp.field;
        var retention = pressureMvp.physics.retention;

        for (var i = 0; i < field.length; i++) {
            field[i] *= retention;
        }

        resetBounds();

        if (!currentPixels || currentPixels.length === 0) return;

        for (var j = 0; j < currentPixels.length; j++) {
            var pixel = currentPixels[j];
            if (!pixel || pixel.del) continue;

            var info = elements[pixel.element];
            if (!info) continue;

            if (isFlowInfo(info)) {
                var densityScale = getDensityScale(info);
                var crowd = 0;
                for (var n = 0; n < adjacentCoords.length; n++) {
                    var nx = pixel.x + adjacentCoords[n][0];
                    var ny = pixel.y + adjacentCoords[n][1];
                    if (!isEmpty(nx, ny, true)) crowd++;
                }

                var staticPressure;
                if (info.state === "liquid") {
                    staticPressure = 0.035 + 0.12 * densityScale + crowd * 0.006;
                } else {
                    var t = pixel.temp || 20;
                    var tempFactor = 1 + clamp((t - 20) / 500, -0.35, 1.25);
                    staticPressure = (0.06 + 0.18 * densityScale + crowd * 0.05) * tempFactor;
                }

                var vx = pixel.flowVx || 0;
                var vy = pixel.flowVy || 0;
                var dynamicPressure = (vx * vx + vy * vy) * densityScale * (info.state === "gas" ? 0.08 : 0.04);

                addPressureAt(pixel.x, pixel.y, staticPressure + dynamicPressure);
                continue;
            }

            if (pixel.element === "pressure_pump") {
                var pumpPower = pixel.power || pressureMvp.defaults.pump.power;
                var pumpRange = Math.max(2, Math.round(pixel.range || pressureMvp.defaults.pump.range));
                var pumpX = pixel.dirX || 1;
                var pumpY = pixel.dirY || 0;
                var pumpBoost = pixel.charge ? 1.4 : 1;

                // Discharge direction
                applyDirectionalSource(pixel.x, pixel.y, pumpX, pumpY, pumpPower * pumpBoost, pumpRange, 0.42);
                // Suction side
                applyDirectionalSource(
                    pixel.x,
                    pixel.y,
                    -pumpX,
                    -pumpY,
                    -(pumpPower * 0.5 * pumpBoost),
                    Math.max(2, Math.floor(pumpRange * 0.75)),
                    0.25
                );
                continue;
            }

            if (pixel.element === "pressure_vent") {
                var ventPower = pixel.power || pressureMvp.defaults.vent.power;
                var ventRange = Math.max(2, Math.round(pixel.range || pressureMvp.defaults.vent.range));
                var ventX = pixel.dirX || 1;
                var ventY = pixel.dirY || 0;
                var ventBoost = pixel.charge ? 1.25 : 1;
                applyDirectionalSource(pixel.x, pixel.y, ventX, ventY, ventPower * ventBoost, ventRange, 0.3);
                continue;
            }

            if (pixel.element === "pressure_valve" && pixel.open) {
                var aperture = clamp(pixel.aperture === undefined ? 1 : pixel.aperture, 0.05, 1);
                addPressureAt(pixel.x, pixel.y, -0.3 * aperture);
            }
        }

        if (pressureMvp.maxX < pressureMvp.minX || pressureMvp.maxY < pressureMvp.minY) return;

        var minX = clamp(pressureMvp.minX - 1, 1, pressureMvp.stride - 2);
        var minY = clamp(pressureMvp.minY - 1, 1, pressureMvp.height - 2);
        var maxX = clamp(pressureMvp.maxX + 1, 1, pressureMvp.stride - 2);
        var maxY = clamp(pressureMvp.maxY + 1, 1, pressureMvp.height - 2);

        applyHydrostaticPressure(minX, minY, maxX, maxY);
        diffusePressureField(minX, minY, maxX, maxY);
        updateFlowMomentum();
    }

    function choosePressureRedirect(pixel, nx, ny, info) {
        var sourcePressure = getPressureAt(pixel.x, pixel.y);
        var externalVelocity = pressureMvp.compat.externalVelocity;
        var vx = pixel.flowVx || 0;
        var vy = pixel.flowVy || 0;
        var speed = Math.sqrt(vx * vx + vy * vy);

        var stepX = sign(vx);
        var stepY = sign(vy);
        var moveDx = sign(nx - pixel.x);
        var moveDy = sign(ny - pixel.y);

        var candidates = [
            [nx, ny],
            [pixel.x + stepX, pixel.y + stepY],
            [pixel.x + stepX, pixel.y],
            [pixel.x, pixel.y + stepY],
            [pixel.x - moveDy, pixel.y + moveDx],
            [pixel.x + moveDy, pixel.y - moveDx]
        ];

        if (info.state === "gas") {
            candidates.push([pixel.x, pixel.y - 1]);
            candidates.push([pixel.x - 1, pixel.y - 1]);
            candidates.push([pixel.x + 1, pixel.y - 1]);
        } else {
            candidates.push([pixel.x, pixel.y + 1]);
            candidates.push([pixel.x - 1, pixel.y + 1]);
            candidates.push([pixel.x + 1, pixel.y + 1]);
        }

        var bestX = nx;
        var bestY = ny;
        var bestScore = -999999;
        var baseScore = -999999;
        var seen = {};

        for (var i = 0; i < candidates.length; i++) {
            var cx = candidates[i][0];
            var cy = candidates[i][1];

            if (cx === pixel.x && cy === pixel.y) continue;
            if (Math.abs(cx - pixel.x) > 1 || Math.abs(cy - pixel.y) > 1) continue;
            if (outOfBounds(cx, cy)) continue;

            var key = cx + "," + cy;
            if (seen[key]) continue;
            seen[key] = true;

            var dx = cx - pixel.x;
            var dy = cy - pixel.y;
            var candidatePressure = getPressureAt(cx, cy);
            var pressureScale = externalVelocity ? (info.state === "liquid" ? 0.45 : 0.65) : 1;
            var score = (sourcePressure - candidatePressure) * 2.8 * pressureScale;

            if (speed > 0.001) {
                score += ((dx * vx + dy * vy) / (speed + 0.001)) * 1.25;
            }

            if (info.state === "gas") {
                score += (-dy) * 0.28;
            } else {
                score += dy * 0.52;
                if (dy < 0) {
                    score -= 2.6;
                    if (!(vy < -0.55 && sourcePressure - candidatePressure > 0.55)) {
                        continue;
                    }
                }
                if (dy === 0 && isEmpty(pixel.x, pixel.y + 1, true)) {
                    // Liquids should fall first before spreading sideways.
                    score -= 1.35;
                }
                if (externalVelocity && dy === 0 && sourcePressure - candidatePressure < 0.35) {
                    continue;
                }
            }

            if (!isEmpty(cx, cy, true)) {
                var occupant = pixelMap[cx][cy];
                if (occupant && occupant.element === "pressure_valve") {
                    score += occupant.open ? -0.2 : -2.8;
                } else if (occupant && !isFlowPixel(occupant)) {
                    score += -1.8;
                } else {
                    score += -0.45;
                }
            }

            if (info.viscosity && info.viscosity > 500 && dy === 0) {
                score -= Math.min(0.7, Math.log(info.viscosity) / 12);
            }

            if (cx === nx && cy === ny) baseScore = score;
            if (score > bestScore) {
                bestScore = score;
                bestX = cx;
                bestY = cy;
            }
        }

        var targetPressure = getPressureAt(bestX, bestY);
        var pressureRise = targetPressure - sourcePressure;
        if (pressureRise > 0) {
            var densityScale = getDensityScale(info);
            var resistance = info.state === "gas" ? (2.7 + getCompressibility(info, densityScale)) : (1.1 + densityScale * 0.8);
            var compressionRatio = pressureRise / Math.max(0.1, resistance);
            var compressLimit;
            if (info.state === "gas") {
                compressLimit = externalVelocity ? 1.2 : 0.9;
            } else {
                compressLimit = externalVelocity ? 0.12 : 0.22;
            }
            if (compressionRatio > compressLimit) {
                return false;
            }
        }

        if (bestX !== nx || bestY !== ny) {
            if (bestScore > baseScore + 0.05) {
                return [bestX, bestY];
            }
        }

        return null;
    }

    function nudgeMomentumTowardMove(pixel, toX, toY, info) {
        if (pressureMvp.compat.externalVelocity) return;
        var dx = sign(toX - pixel.x);
        var dy = sign(toY - pixel.y);
        if (!dx && !dy) return;

        var inertia = info.state === "gas" ? 0.7 : 0.78;
        var gain = info.state === "gas" ? 0.38 : 0.3;

        pixel.flowVx = (pixel.flowVx || 0) * inertia + dx * gain;
        pixel.flowVy = (pixel.flowVy || 0) * inertia + dy * gain;
    }

    function machinePushTick(pixel, strengthScale) {
        var dirX = pixel.dirX || 1;
        var dirY = pixel.dirY || 0;
        var power = (pixel.power || 1) * strengthScale;
        var range = Math.max(2, Math.round(pixel.range || 6));

        for (var step = 1; step <= range; step++) {
            var x = pixel.x + dirX * step;
            var y = pixel.y + dirY * step;
            if (outOfBounds(x, y)) break;
            if (isEmpty(x, y, true)) continue;

            var target = pixelMap[x][y];
            if (!isFlowPixel(target)) continue;

            var impulse = (power / (step + 1)) * 0.35;
            if (elements[target.element].state === "liquid") {
                impulse *= 0.28;
            } else {
                impulse *= 0.8;
            }

            if (!pressureMvp.compat.externalVelocity) {
                target.flowVx = clamp((target.flowVx || 0) + dirX * impulse, -3, 3);
                target.flowVy = clamp((target.flowVy || 0) + dirY * impulse, -3.2, 3.2);
            }

            addPressureAt(target.x, target.y, impulse * 0.45);

            var pushChance = elements[target.element].state === "liquid" ? Math.min(0.08, impulse * 0.06) : Math.min(0.2, impulse * 0.1);
            if (!pressureMvp.compat.externalVelocity && Math.random() < pushChance) {
                tryMove(target, target.x + dirX, target.y + dirY);
            }
        }
    }

    function configureMachineDefaults(kind) {
        var defaults = pressureMvp.defaults[kind];
        var label = kind === "pump" ? "pump" : "vent";

        promptInput(
            "Direction for " + label + " (up/down/left/right)",
            function(dirText) {
                var dir = directionFromName(dirText);
                if (!dir) return;
                defaults.dirX = dir[0];
                defaults.dirY = dir[1];

                promptInput(
                    "Power for " + label + " (0.1 - 8)",
                    function(powerText) {
                        var power = parseFloat(powerText);
                        if (!isNaN(power)) {
                            defaults.power = clamp(power, 0.1, 8);
                        }

                        promptInput(
                            "Range for " + label + " (2 - 20)",
                            function(rangeText) {
                                var range = parseInt(rangeText, 10);
                                if (!isNaN(range)) {
                                    defaults.range = clamp(range, 2, 20);
                                }
                            },
                            String(defaults.range)
                        );
                    },
                    String(defaults.power)
                );
            },
            directionName(defaults.dirX, defaults.dirY)
        );
    }

    function configureValveDefaults() {
        var defaults = pressureMvp.defaults.valve;

        promptInput(
            "Valve direction (up/down/left/right)",
            function(dirText) {
                var dir = directionFromName(dirText);
                if (!dir) return;
                defaults.dirX = dir[0];
                defaults.dirY = dir[1];

                promptInput(
                    "Valve aperture (0.1 - 1.0)",
                    function(apText) {
                        var aperture = parseFloat(apText);
                        if (!isNaN(aperture)) {
                            defaults.aperture = clamp(aperture, 0.1, 1);
                        }

                        promptInput(
                            "Valve max flow per tick (1 - 30)",
                            function(flowText) {
                                var maxFlow = parseInt(flowText, 10);
                                if (!isNaN(maxFlow)) {
                                    defaults.maxFlow = clamp(maxFlow, 1, 30);
                                }

                                promptInput(
                                    "Default valve state (open/closed)",
                                    function(stateText) {
                                        var state = String(stateText || "").toLowerCase().trim();
                                        if (state === "open") defaults.open = true;
                                        if (state === "closed") defaults.open = false;
                                    },
                                    defaults.open ? "open" : "closed"
                                );
                            },
                            String(defaults.maxFlow)
                        );
                    },
                    String(defaults.aperture)
                );
            },
            directionName(defaults.dirX, defaults.dirY)
        );
    }

    function valveAllowsFlow(valve, passDx, passDy) {
        if (!valve.open) return false;
        if (passDx !== 0 && passDy !== 0) return false;
        if (passDx === 0 && passDy === 0) return false;

        var axisX = Math.abs(valve.dirX || 0);
        var axisY = Math.abs(valve.dirY || 0);
        if (axisX === 0 && axisY === 0) {
            axisX = 1;
            axisY = 0;
        }

        if (passDx !== 0 && axisX !== 1) return false;
        if (passDy !== 0 && axisY !== 1) return false;

        var aperture = clamp(valve.aperture === undefined ? 1 : valve.aperture, 0.05, 1);
        var baseCapacity = clamp(valve.maxFlow || 5, 1, 30);
        var capacity = Math.max(1, Math.round(baseCapacity * aperture * (valve.charge ? 1.4 : 1)));

        if (valve.flowTick !== pixelTicks) {
            valve.flowTick = pixelTicks;
            valve.flowUsed = 0;
        }

        if ((valve.flowUsed || 0) >= capacity) return false;
        valve.flowUsed = (valve.flowUsed || 0) + 1;
        return true;
    }

    elements.pressure_pump = {
        color: "#3f6b93",
        behavior: behaviors.WALL,
        category: "machines",
        movable: false,
        insulate: true,
        conduct: 1,
        properties: {
            dirX: 1,
            dirY: 0,
            power: 3.2,
            range: 12
        },
        onShiftSelect: function() {
            configureMachineDefaults("pump");
        },
        onPlace: function(pixel) {
            pixel.dirX = pressureMvp.defaults.pump.dirX;
            pixel.dirY = pressureMvp.defaults.pump.dirY;
            pixel.power = pressureMvp.defaults.pump.power;
            pixel.range = pressureMvp.defaults.pump.range;
        },
        tick: function(pixel) {
            machinePushTick(pixel, pixel.charge ? 1.45 : 1);
        },
        desc: "Directional compressor with discharge and suction sides. Shift-select to set direction, power, and range."
    };

    elements.pressure_vent = {
        color: "#5f889f",
        behavior: behaviors.WALL,
        category: "machines",
        movable: false,
        insulate: true,
        conduct: 0.8,
        properties: {
            dirX: 1,
            dirY: 0,
            power: 1.8,
            range: 9
        },
        onShiftSelect: function() {
            configureMachineDefaults("vent");
        },
        onPlace: function(pixel) {
            pixel.dirX = pressureMvp.defaults.vent.dirX;
            pixel.dirY = pressureMvp.defaults.vent.dirY;
            pixel.power = pressureMvp.defaults.vent.power;
            pixel.range = pressureMvp.defaults.vent.range;
        },
        tick: function(pixel) {
            machinePushTick(pixel, pixel.charge ? 1.2 : 0.75);
        },
        desc: "Lower-force directional airflow for steering and boundary layers."
    };

    elements.pressure_valve = {
        color: "#b04a4a",
        behavior: behaviors.WALL,
        category: "machines",
        movable: false,
        insulate: true,
        conduct: 1,
        properties: {
            open: false,
            manualOpen: false,
            dirX: 1,
            dirY: 0,
            aperture: 1,
            maxFlow: 5,
            pulseUntil: 0,
            flowUsed: 0,
            flowTick: -1
        },
        onShiftSelect: function() {
            configureValveDefaults();
        },
        onPlace: function(pixel) {
            var defaults = pressureMvp.defaults.valve;
            pixel.manualOpen = !!defaults.open;
            pixel.open = !!defaults.open;
            pixel.dirX = defaults.dirX;
            pixel.dirY = defaults.dirY;
            pixel.aperture = defaults.aperture;
            pixel.maxFlow = defaults.maxFlow;
            pixel.pulseUntil = 0;
            pixel.flowUsed = 0;
            pixel.flowTick = -1;
        },
        tick: function(pixel) {
            if (pixel.manualOpen === undefined) pixel.manualOpen = false;
            if (pixel.aperture === undefined) pixel.aperture = 1;
            if (pixel.maxFlow === undefined) pixel.maxFlow = 5;

            if (pixel.charge) {
                pixel.open = true;
                pixel.pulseUntil = pixelTicks + 12;
            } else if (pixel.pulseUntil && pixelTicks <= pixel.pulseUntil) {
                pixel.open = true;
            } else {
                pixel.open = !!pixel.manualOpen;
                pixel.pulseUntil = 0;
            }

            if (pixel.flowTick !== pixelTicks) {
                pixel.flowUsed = 0;
            }

            var aperture = clamp(pixel.aperture, 0.1, 1);
            if (pixel.open) {
                var green = Math.round(130 + 90 * aperture);
                pixel.color = "rgb(80," + green + ",95)";
            } else {
                var red = Math.round(140 + 70 * aperture);
                pixel.color = "rgb(" + red + ",72,72)";
            }
        },
        desc: "Directional valve with aperture and throughput. Open state can be pulsed by electricity."
    };

    elements.barometer = {
        color: "#2f8b93",
        behavior: behaviors.WALL,
        category: "machines",
        movable: false,
        insulate: true,
        properties: {
            reading: 0,
            velocity: 0
        },
        tick: function(pixel) {
            var reading = getPressureAt(pixel.x, pixel.y);
            pixel.reading = Math.round(reading * 100) / 100;

            var totalSpeed = 0;
            var samples = 0;
            for (var i = 0; i < adjacentCoords.length; i++) {
                var x = pixel.x + adjacentCoords[i][0];
                var y = pixel.y + adjacentCoords[i][1];
                if (isEmpty(x, y, true)) continue;
                var nearby = pixelMap[x][y];
                if (!isFlowPixel(nearby)) continue;
                var svx = nearby.flowVx || 0;
                var svy = nearby.flowVy || 0;
                totalSpeed += Math.sqrt(svx * svx + svy * svy);
                samples++;
            }
            var speed = samples ? totalSpeed / samples : 0;
            pixel.velocity = Math.round(speed * 100) / 100;
            pixel.color = pressureColor(reading);
        },
        desc: "Reads local pressure field (and dynamic flow speed on the pixel)."
    };

    runAfterLoad(function() {
        pressureMvp.compat.externalVelocity = hasExternalVelocityMod();

        validateMoves(function(pixel, nx, ny) {
            if (!pressureMvp.enabled || !pixel || pixel.del) return;
            if (!ensureField()) return;

            var info = elements[pixel.element];
            if (!info) return;

            if (!outOfBounds(nx, ny) && !isEmpty(nx, ny, true)) {
                var blocker = pixelMap[nx][ny];
                if (blocker && blocker.element === "pressure_valve") {
                    if (!isFlowInfo(info)) return false;

                    var passDx = sign(nx - pixel.x);
                    var passDy = sign(ny - pixel.y);
                    if (!valveAllowsFlow(blocker, passDx, passDy)) return false;

                    var passX = nx + passDx;
                    var passY = ny + passDy;
                    if (outOfBounds(passX, passY)) return false;

                    // Prevent chaining through multiple valves in one move.
                    if (!isEmpty(passX, passY, true)) {
                        var beyond = pixelMap[passX][passY];
                        if (beyond && beyond.element === "pressure_valve") return false;
                    }

                    var aperture = clamp(blocker.aperture === undefined ? 1 : blocker.aperture, 0.05, 1);
                    pixel.flowVx = (pixel.flowVx || 0) * (0.55 + 0.4 * aperture);
                    pixel.flowVy = (pixel.flowVy || 0) * (0.55 + 0.4 * aperture);
                    nudgeMomentumTowardMove(pixel, passX, passY, info);
                    return [passX, passY];
                }
            }

            if (!isFlowInfo(info)) return;

            var redirect = choosePressureRedirect(pixel, nx, ny, info);
            if (redirect === false) return false;
            if (Array.isArray(redirect)) {
                nudgeMomentumTowardMove(pixel, redirect[0], redirect[1], info);
                return redirect;
            }
        });

        runEveryTick(function() {
            if (!pressureMvp.compat.externalVelocity && hasExternalVelocityMod()) {
                pressureMvp.compat.externalVelocity = true;
            }
            rebuildPressureField();
        });

        viewInfo[9] = {
            name: "pressure",
            effects: false,
            colorEffects: false,
            pixel: function(pixel, ctx) {
                drawSquare(ctx, pressureColor(getPressureAt(pixel.x, pixel.y)), pixel.x, pixel.y);
            }
        };
    });
})();
