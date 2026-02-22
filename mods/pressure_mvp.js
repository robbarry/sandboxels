// Pressure MVP (realism pass) - Optimized
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

    // Optimization: Reused variables for choosePressureRedirect to avoid GC
    var _bestX = 0, _bestY = 0, _bestScore = -999999;
    var _baseScore = -999999;
    var _visitedMask = new Int8Array(9); // 3x3 local grid mask

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    function sign(n) {
        return n > 0 ? 1 : (n < 0 ? -1 : 0);
    }

    function indexOfCoord(x, y) {
        return y * pressureMvp.stride + x;
    }

    function ensureField() {
        if (typeof width === 'undefined' || typeof height === 'undefined') return false;

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
        // Inlining clamp for speed
        var sx = x < 0 ? 0 : (x >= pressureMvp.stride ? pressureMvp.stride - 1 : x);
        var sy = y < 0 ? 0 : (y >= pressureMvp.height ? pressureMvp.height - 1 : y);

        if (sx < pressureMvp.minX) pressureMvp.minX = sx;
        if (sy < pressureMvp.minY) pressureMvp.minY = sy;
        if (sx > pressureMvp.maxX) pressureMvp.maxX = sx;
        if (sy > pressureMvp.maxY) pressureMvp.maxY = sy;
    }

    function addPressureAt(x, y, value) {
        if (!pressureMvp.field) return;
        if (x < 0 || y < 0 || x >= pressureMvp.stride || y >= pressureMvp.height) return;
        pressureMvp.field[y * pressureMvp.stride + x] += value;
        markBounds(x, y);
    }

    function getPressureAt(x, y) {
        if (!pressureMvp.field) return 0;
        if (x < 0 || y < 0 || x >= pressureMvp.stride || y >= pressureMvp.height) return 0;
        return pressureMvp.field[y * pressureMvp.stride + x];
    }

    function isFlowInfo(info) {
        // Fast check for liquid/gas
        return !!(info && info.movable === true && (info.state === "liquid" || info.state === "gas"));
    }

    function isFlowPixel(pixel) {
        if (!pixel || pixel.del) return false;
        var info = elements[pixel.element];
        return isFlowInfo(info);
    }

    function hasExternalVelocityMod() {
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

    function getReferenceAirDensity() {
        if (typeof airDensity === "number" && isFinite(airDensity) && airDensity > 0) {
            return airDensity;
        }
        return 1.225;
    }

    function getGasBuoyancyFactor(info) {
        var rho = getElementDensity(info);
        var rhoAir = getReferenceAirDensity();
        // Inline clamp
        var val = (rhoAir - rho) / rhoAir;
        return val < -1.8 ? -1.8 : (val > 1.8 ? 1.8 : val);
    }

    function getPixelGasLift(pixel, info) {
        var lift = getGasBuoyancyFactor(info);
        // Matter-derived plasma should not behave like an endlessly rising hot-air balloon.
        if (pixel && pixel.element === "plasma" && pixel.hhrIonizedFrom !== undefined) {
            lift *= 0.12;
        }
        return lift;
    }

    function getDensityScale(info) {
        var density = getElementDensity(info);
        if (info.state === "gas") {
            var val = density / 1.6;
            return val < 0.14 ? 0.14 : (val > 3.2 ? 3.2 : val);
        }
        var val = density / 1000;
        return val < 0.35 ? 0.35 : (val > 4 ? 4 : val);
    }

    function getViscosityDrag(info) {
        var base = info.state === "gas" ? 0.9 : 0.62;
        if (info.viscosity === undefined) return base;

        var visc = Math.log(info.viscosity + 1) / 10;
        var drag = base - visc * (info.state === "gas" ? 0.28 : 0.15);
        var min = info.state === "gas" ? 0.35 : 0.32;
        return drag < min ? min : (drag > 0.95 ? 0.95 : drag);
    }

    function getCompressibility(info, densityScale) {
        if (info.state === "gas") {
            var val = 1.9 - densityScale * 0.25;
            return val < 0.85 ? 0.85 : (val > 2.2 ? 2.2 : val);
        }
        var val = 0.08 + 0.05 / densityScale;
        return val < 0.06 ? 0.06 : (val > 0.18 ? 0.18 : val);
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
        var p = value < -4 ? -4 : (value > 6 ? 6 : value);
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

        return "rgb(" + (r < 0 ? 0 : (r > 255 ? 255 : r)) + "," + 
                        (g < 0 ? 0 : (g > 255 ? 255 : g)) + "," + 
                        (b < 0 ? 0 : (b > 255 ? 255 : b)) + ")";
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
        // Optimization: Access pixelMap directly and minimize redundant checks
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
                if (!info || info.state !== "liquid" || !info.movable) {
                    columnHead = 0;
                    continue;
                }

                var densityScale = getDensityScale(info);
                columnHead += 0.028 * densityScale;
                
                // Direct array access for speed
                var idx = y * pressureMvp.stride + x;
                pressureMvp.field[idx] += columnHead;
            }
        }
        markBounds(minX, minY);
        markBounds(maxX, maxY);
    }

    function diffusePressureField(minX, minY, maxX, maxY) {
        if (maxX <= minX || maxY <= minY) return;

        var d = pressureMvp.physics.diffuse;
        var passes = pressureMvp.physics.diffusePasses;
        var stride = pressureMvp.stride;
        var field = pressureMvp.field;
        var scratch = pressureMvp.scratch;
        
        // Pre-calculate indices to avoid repeated multiplies
        for (var pass = 0; pass < passes; pass++) {
            for (var y = minY; y <= maxY; y++) {
                var row = y * stride;
                for (var x = minX; x <= maxX; x++) {
                    var idx = row + x;
                    
                    // Optimization: Check flow eligibility without function call overhead if possible
                    // But isFluidCell handles bounds and empty checks safely.
                    if (!isFluidCell(x, y)) {
                        scratch[idx] = field[idx] * 0.9;
                        continue;
                    }
                    
                    var center = field[idx];
                    var sum = 0;
                    var count = 0;

                    // Unrolled neighbor checks
                    // Left
                    if (x > 0 && isFluidCell(x - 1, y)) {
                        sum += field[idx - 1];
                        count++;
                    }
                    // Right
                    if (x < stride - 1 && isFluidCell(x + 1, y)) {
                        sum += field[idx + 1];
                        count++;
                    }
                    // Up
                    if (y > 0 && isFluidCell(x, y - 1)) {
                        sum += field[idx - stride];
                        count++;
                    }
                    // Down
                    if (y < pressureMvp.height - 1 && isFluidCell(x, y + 1)) {
                        sum += field[idx + stride];
                        count++;
                    }

                    if (count === 0) {
                        scratch[idx] = center;
                    } else {
                        var avg = sum / count;
                        scratch[idx] = center + (avg - center) * d;
                    }
                }
            }

            // Swap buffers or copy back. Copy back is safer for maintaining 'field' as primary.
            // Using a block copy would be faster but Float32Array doesn't support 2D sub-rect copies easily.
            for (var yy = minY; yy <= maxY; yy++) {
                var rowOffset = yy * stride;
                var start = rowOffset + minX;
                var end = rowOffset + maxX + 1;
                // TypedArray.prototype.set is faster than a loop
                field.set(scratch.subarray(start, end), start);
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
            
            // Optimization: Inline isFluidCell logic for neighbors or trust getPressureAt returns 0?
            // getPressureAt returns 0 if OOB, but doesn't check for fluid.
            // If neighbor is solid, pressure is technically 0 at that wall for gradient calculation?
            // Or should we use pCenter (Neumann boundary)? Using pCenter is safer for stability.
            
            var pRight = isFluidCell(x + 1, y) ? getPressureAt(x + 1, y) : pCenter;
            var pLeft = isFluidCell(x - 1, y) ? getPressureAt(x - 1, y) : pCenter;
            var pDown = isFluidCell(x, y + 1) ? getPressureAt(x, y + 1) : pCenter;
            var pUp = isFluidCell(x, y - 1) ? getPressureAt(x, y - 1) : pCenter;

            var gradX = pRight - pLeft;
            var gradY = pDown - pUp;

            var vx = (pixel.flowVx || 0) * drag;
            var vy = (pixel.flowVy || 0) * drag;

            // F = -grad(P)
            var accelX = -gradX * physics.gradientScale * compressibility / Math.max(0.2, densityScale);
            var accelY = -gradY * physics.gradientScale * compressibility / Math.max(0.2, densityScale);

            if (info.state === "gas") {
                accelY -= physics.gasBuoyancy * getPixelGasLift(pixel, info);
            } else {
                accelY += physics.liquidGravity * densityScale;
                accelX *= 0.34;
                accelY *= 0.72;
            }

            if (pressureMvp.compat.externalVelocity) {
                pixel.flowVx = (pixel.flowVx || 0) * 0.55;
                pixel.flowVy = (pixel.flowVy || 0) * 0.55;
                if (Math.abs(pixel.flowVx) < 0.02) pixel.flowVx = 0;
                if (Math.abs(pixel.flowVy) < 0.02) pixel.flowVy = 0;
                pixel.pressure = getPressureAt(x, y);
                continue;
            }

            vx += accelX;
            vy += accelY;

            // No-slip boundary approximation
            if (info.state === "liquid") {
                var wallContacts = 0;
                // Unroll adjacentCoords for speed
                if (!isEmpty(x+0, y-1, true) && !isFlowPixel(pixelMap[x+0][y-1])) wallContacts++;
                if (!isEmpty(x+0, y+1, true) && !isFlowPixel(pixelMap[x+0][y+1])) wallContacts++;
                if (!isEmpty(x-1, y+0, true) && !isFlowPixel(pixelMap[x-1][y+0])) wallContacts++;
                if (!isEmpty(x+1, y+0, true) && !isFlowPixel(pixelMap[x+1][y+0])) wallContacts++;
                
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
            pixel.flowVx = vx < -cap ? -cap : (vx > cap ? cap : vx);
            pixel.flowVy = vy < -cap * 1.15 ? -cap * 1.15 : (vy > cap * 1.15 ? cap * 1.15 : vy);

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
        
        // Fast decay
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
                
                // Inline neighbor check
                if (!isEmpty(pixel.x, pixel.y-1, true)) crowd++;
                if (!isEmpty(pixel.x, pixel.y+1, true)) crowd++;
                if (!isEmpty(pixel.x-1, pixel.y, true)) crowd++;
                if (!isEmpty(pixel.x+1, pixel.y, true)) crowd++;

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

                applyDirectionalSource(pixel.x, pixel.y, pumpX, pumpY, pumpPower * pumpBoost, pumpRange, 0.42);
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

    // Optimization: Allocation-free candidate checking
    function checkCandidate(pixel, cx, cy, info, sourcePressure, externalVelocity, speed, vx, vy) {
        if (outOfBounds(cx, cy)) return;
        
        // Local mask check
        // relative coords: dx = cx - pixel.x, dy = cy - pixel.y
        // dx in [-1, 1], dy in [-1, 1]
        // map to index 0..8: (dx+1) + (dy+1)*3
        var dx = cx - pixel.x;
        var dy = cy - pixel.y;
        
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return;
        
        var maskIdx = (dx + 1) + (dy + 1) * 3;
        if (_visitedMask[maskIdx]) return;
        _visitedMask[maskIdx] = 1;

        if (dx === 0 && dy === 0) return;

        var candidatePressure = getPressureAt(cx, cy);
        var pressureScale = externalVelocity ? (info.state === "liquid" ? 0.45 : 0.25) : 1;
        var score = (sourcePressure - candidatePressure) * 2.8 * pressureScale;
        
        var occupant = null;
        if (!isEmpty(cx, cy, true)) {
            occupant = pixelMap[cx][cy];
        }

        if (speed > 0.001) {
            score += ((dx * vx + dy * vy) / (speed + 0.001)) * 1.25;
        }

        if (info.state === "gas") {
            var gasLift = getPixelGasLift(pixel, info);
            score += (-dy) * 0.28 * gasLift;

            var thisDensity = getElementDensity(info);
            if (occupant && isFlowPixel(occupant)) {
                var occInfo = elements[occupant.element];
                if (occInfo && occInfo.state === "gas") {
                    var occDensity = getElementDensity(occInfo);
                    var densityDelta = thisDensity - occDensity;

                    if (dy < 0 && densityDelta > 0.08) {
                        score -= 2.8 + densityDelta * 0.8;
                        if (externalVelocity && sourcePressure - candidatePressure < 1.2) return;
                    }
                    if (dy > 0 && densityDelta < -0.08) {
                        score -= 2.3 + Math.abs(densityDelta) * 0.7;
                        if (externalVelocity && sourcePressure - candidatePressure < 1.2) return;
                    }
                    if (dy > 0 && densityDelta > 0.08) score += 1.35 + densityDelta * 0.4;
                    if (dy < 0 && densityDelta < -0.08) score += 1.2 + Math.abs(densityDelta) * 0.35;
                }
            }
        } else {
            score += dy * 0.52;
            if (dy < 0) {
                score -= 2.6;
                if (!(vy < -0.55 && sourcePressure - candidatePressure > 0.55)) return;
            }
            if (dy === 0 && isEmpty(pixel.x, pixel.y + 1, true)) score -= 1.35;
            if (externalVelocity && dy === 0 && sourcePressure - candidatePressure < 0.35) return;
        }

        if (occupant) {
            if (occupant.element === "pressure_valve") {
                score += occupant.open ? -0.2 : -2.8;
            } else if (!isFlowPixel(occupant)) {
                score += -1.8;
            } else {
                score += -0.45;
            }
        }

        if (info.viscosity && info.viscosity > 500 && dy === 0) {
            score -= Math.min(0.7, Math.log(info.viscosity) / 12);
        }

        if (score > _bestScore) {
            _bestScore = score;
            _bestX = cx;
            _bestY = cy;
        }
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

        _bestX = nx;
        _bestY = ny;
        _bestScore = -999999;
        
        // Reset mask
        for(var i=0; i<9; i++) _visitedMask[i] = 0;

        // 1. Check original target first to set base score
        // We simulate "checking" it to populate baseScore
        checkCandidate(pixel, nx, ny, info, sourcePressure, externalVelocity, speed, vx, vy);
        _baseScore = _bestScore; 
        
        // 2. Check diagonals and momentum-biased directions
        checkCandidate(pixel, pixel.x + stepX, pixel.y + stepY, info, sourcePressure, externalVelocity, speed, vx, vy);
        checkCandidate(pixel, pixel.x + stepX, pixel.y, info, sourcePressure, externalVelocity, speed, vx, vy);
        checkCandidate(pixel, pixel.x, pixel.y + stepY, info, sourcePressure, externalVelocity, speed, vx, vy);
        checkCandidate(pixel, pixel.x - moveDy, pixel.y + moveDx, info, sourcePressure, externalVelocity, speed, vx, vy);
        checkCandidate(pixel, pixel.x + moveDy, pixel.y - moveDx, info, sourcePressure, externalVelocity, speed, vx, vy);

        // 3. Check verticals based on state (buoyancy/gravity)
        if (info.state === "gas") {
            checkCandidate(pixel, pixel.x, pixel.y - 1, info, sourcePressure, externalVelocity, speed, vx, vy);
            checkCandidate(pixel, pixel.x - 1, pixel.y - 1, info, sourcePressure, externalVelocity, speed, vx, vy);
            checkCandidate(pixel, pixel.x + 1, pixel.y - 1, info, sourcePressure, externalVelocity, speed, vx, vy);
        } else {
            checkCandidate(pixel, pixel.x, pixel.y + 1, info, sourcePressure, externalVelocity, speed, vx, vy);
            checkCandidate(pixel, pixel.x - 1, pixel.y + 1, info, sourcePressure, externalVelocity, speed, vx, vy);
            checkCandidate(pixel, pixel.x + 1, pixel.y + 1, info, sourcePressure, externalVelocity, speed, vx, vy);
        }

        // Stability check for compression
        var targetPressure = getPressureAt(_bestX, _bestY);
        var pressureRise = targetPressure - sourcePressure;
        if (pressureRise > 0) {
            var densityScale = getDensityScale(info);
            var resistance = info.state === "gas" ? (2.7 + getCompressibility(info, densityScale)) : (1.1 + densityScale * 0.8);
            var compressLimit = info.state === "gas" ? (externalVelocity ? 1.2 : 0.9) : (externalVelocity ? 0.12 : 0.22);
            
            if ((pressureRise / Math.max(0.1, resistance)) > compressLimit) {
                return false;
            }
        }

        if (_bestX !== nx || _bestY !== ny) {
            if (_bestScore > _baseScore + 0.05) {
                return [_bestX, _bestY];
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
                var tvx = (target.flowVx || 0) + dirX * impulse;
                var tvy = (target.flowVy || 0) + dirY * impulse;
                target.flowVx = tvx < -3 ? -3 : (tvx > 3 ? 3 : tvx);
                target.flowVy = tvy < -3.2 ? -3.2 : (tvy > 3.2 ? 3.2 : tvy);
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
