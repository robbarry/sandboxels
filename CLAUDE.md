# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sandboxels is a browser-based falling sand simulation game with 500+ elements, featuring heat simulation, chemical reactions, fire, density, and electricity. It runs entirely client-side with no build system.

## Development

**Running the game**: Open `index.html` directly in a browser. No build step or dependencies required.

**Architecture**: The entire game is a single 691KB `index.html` file containing all JavaScript, CSS, and HTML inline. This monolithic design is intentional for simplicity and PWA offline support.

**Lite version**: `lite.html` is a simplified 62KB version with reduced features.

## Code Structure

### Key Global Objects

- `elements` - Object containing all 500+ element definitions
- `behaviors` - Predefined behavior patterns (POWDER, LIQUID, GAS, WALL, etc.)
- `pixelMap` - 2D array representing the canvas grid
- `pixelTicks` - Current simulation frame counter
- `settings` - User preferences (persisted to localStorage)

### Behavior System

Elements use a behavior matrix (3x3 grid representing relative positions) or behavior functions:

```javascript
// Matrix notation: M=move, D=delete, C=clone, S=swap, X=nothing
behaviors.POWDER: [
    "XX|XX|XX",
    "XX|XX|XX",
    "M2|M1|M2"  // M1=move priority 1, M2=move priority 2
]

// Function notation for complex behaviors
behaviors.LIQUID: function(pixel) {
    if (tryMove(pixel, pixel.x, pixel.y+1) !== true) {
        // horizontal spread logic
    }
    doDefaults(pixel);
}
```

### Element Definition Pattern

```javascript
elements.water = {
    color: "#2167ff",
    behavior: behaviors.LIQUID,
    tempHigh: 100,           // Boiling point
    stateHigh: "steam",      // What it becomes when heated
    tempLow: 0,              // Freezing point
    stateLow: "ice",         // What it becomes when cooled
    category: "liquids",     // UI category
    density: 997,            // For liquid layering
    reactions: {             // Chemical reactions with other elements
        "salt": { elem1: "salt_water", elem2: null }
    },
    state: "liquid",
    conduct: 0.02,           // Electrical conductivity
    extinguish: true         // Can put out fires
};
```

### Behavior Matrix DSL

The 3x3 behavior matrix represents positions relative to the pixel (top row, middle row, bottom row). Codes are pipe-separated:

```
Position grid:          Example: behaviors.POWDER
[-1,-1] [0,-1] [1,-1]   "XX|XX|XX"      (top: do nothing)
[-1, 0] [0, 0] [1, 0]   "XX|XX|XX"      (middle: do nothing)
[-1,+1] [0,+1] [1,+1]   "M2|M1|M2"      (bottom: move down-center first, then diagonals)
```

**Movement codes:**
- `M1`, `M2` - Move with priority (lower = tried first)
- `XX` - Do nothing
- `DB` - Die in bounds (delete if at edge)

**Interaction codes:**
- `CR:element%chance` - Create element (e.g., `CR:foam%2` = 2% chance to create foam)
- `CH:elem1,elem2%chance` - Change self to one of listed elements
- `SW:elem1,elem2%chance` - Swap with adjacent element if it matches list
- `DL%chance` - Delete self
- `EX:radius` - Explode

**Conditionals:**
- Codes can be combined with `AND` (e.g., `CR:steam%5 AND M1`)
- `%` suffix sets probability (e.g., `M1%50` = 50% chance to move)

### Core Functions

- `createPixel(element, x, y)` - Create a new pixel
- `deletePixel(x, y)` - Remove a pixel
- `changePixel(pixel, newElement)` - Transform pixel to different element
- `tryMove(pixel, x, y)` - Attempt to move pixel (returns success)
- `doDefaults(pixel)` - Apply default behaviors (heat, burning, etc.)
- `isEmpty(x, y, orite)` - Check if position is empty (orOutOfBounds if true)
- `pixelTempCheck(pixel)` - Apply temperature state changes
- `chargePixel(pixel)` - Apply electrical charge
- `adjacentCoords` - Array of [dx,dy] offsets for 8 neighbors: `[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]`

## Modding

**Contribution policy**: Changes to `index.html` are ignored. This repository accepts community mods only (in `/mods/`).

**Mod structure**: Mods are plain JavaScript files that extend the `elements` object:

```javascript
elements.my_element = {
    color: "#ff0000",
    behavior: behaviors.POWDER,
    category: "land",
    // ... properties
};

// Extend existing elements
if (!elements.water.reactions) elements.water.reactions = {};
elements.water.reactions.my_element = { elem1: "steam", elem2: null };
```

**Mod hooks available**:
- `runEveryTick(fn)` - Execute code each simulation tick
- `runPerPixel(fn)` - Execute code for each pixel each tick
- `renderPrePixel(fn)` - Custom rendering before pixels
- `renderPostPixel(fn)` - Custom rendering after pixels
- `keybinds["KeyX"] = fn` - Custom keyboard shortcuts

**Modding documentation**: https://sandboxels.wiki.gg/wiki/Modding

**Useful mod patterns:**
```javascript
// Run code after all elements loaded (for modifying existing elements)
runAfterLoad(function() {
    elements.water.reactions.my_element = { elem1: "steam", elem2: null };
});

// Shift-click configuration (like cloner, spout, thermostat)
elements.my_machine = {
    onShiftSelect: function(element) {
        promptInput("Enter value:", function(r) {
            currentElementProp = { myProp: r };
        });
    },
    // ... rest of element
};
```

## File Layout

```
index.html          # Main game (all code inline)
lite.html           # Lightweight version
style.css           # Additional styles
service-worker.js   # PWA offline support
mods/               # 500+ community mods
lang/               # 51 language translation files
icons/              # Favicons and app icons
```

## Testing Controls

When testing in browser:
- **Left Click** = Draw, **Right Click** = Erase, **Middle Click** = Pick element
- **Space/P** = Pause, **>** = Single step frame
- **Shift + Click** = Draw line
- **Shift + Heat/Cool/Shock** = Intensify effect
- **E** = Select element by name, **I or /** = Element info
- **1234** = Change view mode (normal, heat, debug, etc.)

## Git Remotes

- `origin` - Upstream repo (R74nCom/sandboxels) - read-only
- `fork` - Rob's fork (robbarry/sandboxels) - push here
- **GitHub Pages**: https://robbarry.github.io/sandboxels/
- **Mods URL**: https://robbarry.github.io/sandboxels/mods/

## Custom Mods

### `mods/thermostat.js`

Biosphere tools mod with:

- **thermostat**: Heats/cools neighbors to a target temperature (shift-click to set). Unlike the built-in heater, it stops when target is reached.
- **producer**: Like spout but for any element. Shift-click to set element and rate.
- **fan_up/down/left/right**: Wind with inverse-square falloff. Adds velocity (requires `velocity.js`). Shift-click to set force.

Enable with `velocity.js` for physics-based fan behavior.

### `mods/pressure_mvp.js`

Pressure gameplay MVP with:

- **Physics model**: Persistent pressure field with diffusion, hydrostatic liquid depth pressure, and compressibility/viscosity-aware momentum updates.
- **pressure_pump**: Directional compressor with discharge and suction sides (shift-select sets direction, power, range).
- **pressure_vent**: Lower-force airflow tool for steering and boundary-layer behavior.
- **pressure_valve**: Directional valve with aperture and max-throughput limits; electricity pulses it open.
- **barometer**: Reads local pressure (and dynamic local flow speed) with color-coded intensity.
- **Pressure view (9)**: Visualizes pressure field with red for high pressure and cyan for low pressure.
