// Výpočty pro lyžařský areál mimo hlavní vlákno (prototyp): po změně polohy spočítá, které body sjezdovek,
// vleků, turistických tras, rozcestníků a vrcholů jsou vidět, a profil obzoru dokola. Kreslení každý snímek pak jen promítá hotová čísla.

const EARTH_RADIUS = 6371000;
const CURVATURE = 0.87 / (2 * EARTH_RADIUS);   // zakřivení Země s běžnou refrakcí (k = 0,13)
const DENSIFY_METERS = 20;                     // body čar zhruba po kroku terénní mřížky
const LIFT_CABLE_METERS = 8;                   // lano vleku nad terénem
const PISTE_LIFT_METERS = 1;
const HORIZON_STEP_DEGREES = 0.25;
const HORIZON_RANGE_METERS = 16000;
const GUIDEPOST_RANGE_METERS = 4000;

let grid = null;      // { heights: Int16Array, north, west, stepLat, stepLon, rows, cols, scale }
let points = null;    // zhuštěné body všech čar: lat, lon, výška nad terénem, čára
let peaks = [];
let guideposts = [];

onmessage = e => {
    const message = e.data;
    if (message.type === 'init') {
        grid = { ...message.terrain, heights: new Int16Array(message.heights) };
        points = densify(message.lines);
        peaks = message.peaks;
        guideposts = message.guideposts ?? [];
        postMessage({ type: 'ready', points: points.count, lineOf: points.line });
    } else if (message.type === 'position') {
        postMessage(compute(message.lat, message.lon, message.eye), []);
    }
};

/** Výška terénu bilineárně z mřížky; mimo mřížku NaN. */
function height(lat, lon) {
    const fy = (grid.north - lat) / grid.stepLat;
    const fx = (lon - grid.west) / grid.stepLon;
    if (fy < 0 || fx < 0 || fy >= grid.rows - 1 || fx >= grid.cols - 1)
        return NaN;
    const y0 = fy | 0, x0 = fx | 0, ty = fy - y0, tx = fx - x0;
    const i = y0 * grid.cols + x0, h = grid.heights;
    return ((h[i] * (1 - tx) + h[i + 1] * tx) * (1 - ty) + (h[i + grid.cols] * (1 - tx) + h[i + grid.cols + 1] * tx) * ty) * grid.scale;
}

function densify(lines) {
    const lat = [], lon = [], lift = [], line = [];
    lines.forEach((l, index) => {
        const c = l.coords;
        const kyLocal = Math.PI / 180 * EARTH_RADIUS, kxLocal = kyLocal * Math.cos(c[0] * Math.PI / 180);
        const above = l.kind === 'lift' ? LIFT_CABLE_METERS : PISTE_LIFT_METERS;
        for (let i = 0; i + 2 < c.length; i += 2) {
            const n = Math.max(1, Math.round(Math.hypot((c[i + 2] - c[i]) * kyLocal, (c[i + 3] - c[i + 1]) * kxLocal) / DENSIFY_METERS));
            for (let k = 0; k < n; k++) {
                lat.push(c[i] + (c[i + 2] - c[i]) * k / n);
                lon.push(c[i + 1] + (c[i + 3] - c[i + 1]) * k / n);
                lift.push(above);
                line.push(index);
            }
        }
        lat.push(c[c.length - 2]); lon.push(c[c.length - 1]); lift.push(above); line.push(index);
    });
    return { lat: Float64Array.from(lat), lon: Float64Array.from(lon), lift: Float32Array.from(lift), line: Int32Array.from(line), count: lat.length };
}

/**
 * Viditelnost bodu: paprsek od oka k bodu nesmí cestou nikde narazit do terénu. Porovnávají se sklony
 * (převýšení / vzdálenost) včetně zakřivení Země; malá rezerva, ať sjezdovka po povrchu nebliká.
 */
function visible(lat0, lon0, eye, kx, ky, dx, dy, z) {
    const distance = Math.hypot(dx, dy);
    if (distance < 30)
        return true;
    const target = (z - eye - distance * distance * CURVATURE + 3) / distance;
    // Krok paprsku roste se vzdáleností: zblízka po 20 m (krok mřížky), v 6 km po 30 m.
    const step = Math.max(20, distance / 200);
    for (let s = 20; s < distance - 20; s += step) {
        const t = s / distance;
        const h = height(lat0 + dy * t / ky, lon0 + dx * t / kx);
        if ((h - eye - s * s * CURVATURE) / s > target)
            return false;
    }
    return true;
}

function compute(lat0, lon0, eyeAboveGround) {
    const started = performance.now();
    const ground = height(lat0, lon0);
    const eye = (isNaN(ground) ? 0 : ground) + eyeAboveGround;
    const ky = Math.PI / 180 * EARTH_RADIUS, kx = ky * Math.cos(lat0 * Math.PI / 180);

    // Body čar: poloha vůči oku v metrech (východ, sever, nahoru, už se zakřivením) a jestli je vidět.
    const n = points.count;
    const east = new Float32Array(n), north = new Float32Array(n), up = new Float32Array(n);
    const seen = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const dx = (points.lon[i] - lon0) * kx, dy = (points.lat[i] - lat0) * ky;
        const z = height(points.lat[i], points.lon[i]) + points.lift[i];
        east[i] = dx; north[i] = dy; up[i] = z - eye - (dx * dx + dy * dy) * CURVATURE;
        seen[i] = isNaN(z) ? 0 : visible(lat0, lon0, eye, kx, ky, dx, dy, z) ? 1 : 0;
    }
    const linesMs = performance.now() - started;

    // Vrcholy a rozcestníky jen viditelné; rozcestník je cedule kousek nad zemí, nemá smysl ho kreslit zdaleka.
    const sights = (list, above, useElevation, maxDistance) => {
        const result = [];
        for (const p of list) {
            const dx = (p.lon - lon0) * kx, dy = (p.lat - lat0) * ky, d = Math.hypot(dx, dy);
            const ground = height(p.lat, p.lon);
            const z = (useElevation ? Math.max(ground, p.ele || 0) : ground) + above;
            if (isNaN(z) || d < 50 || d > maxDistance || !visible(lat0, lon0, eye, kx, ky, dx, dy, z))
                continue;
            result.push({ name: p.name, ele: p.ele, distance: d, east: dx, north: dy, up: z - eye - d * d * CURVATURE });
        }
        return result;
    };
    const peakSights = sights(peaks, 0, true, Infinity);
    const guidepostSights = sights(guideposts, 2, false, GUIDEPOST_RANGE_METERS);

    // Obzor: pro každý směr nejvyšší úhel terénu nad vodorovnou rovinou oka.
    const count = Math.round(360 / HORIZON_STEP_DEGREES);
    const horizon = new Float32Array(count);
    for (let a = 0; a < count; a++) {
        const azimuth = a * HORIZON_STEP_DEGREES * Math.PI / 180;
        const sin = Math.sin(azimuth), cos = Math.cos(azimuth);
        let best = -Infinity;
        for (let s = 30; s < HORIZON_RANGE_METERS; s += s < 1000 ? 10 : s < 4000 ? 25 : 60) {
            const h = height(lat0 + s * cos / ky, lon0 + s * sin / kx);
            if (isNaN(h))
                break;
            const slope = (h - eye - s * s * CURVATURE) / s;
            if (slope > best)
                best = slope;
        }
        horizon[a] = Math.atan(best);
    }

    return {
        type: 'computed',
        ground, eye,
        east, north, up, seen,
        peaks: peakSights,
        guideposts: guidepostSights,
        horizon, horizonStep: HORIZON_STEP_DEGREES,
        linesMs, totalMs: performance.now() - started,
    };
}
