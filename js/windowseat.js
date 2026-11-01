// Prohlížečová vrstva Lookabout: kamera, senzory, GPS, dotyk a kreslení scény na plátno.
// Co a kam nakreslit, počítá C# (SceneComposer ze sdílené knihovny); tady jen vstupy a kreslení.

let dotnet = null;
let video = null;
let canvas = null;
let ctx = null;
let statusLine = null;
let running = false;
let lastFrame = 0;
let startedAt = 0;
let ski = null;      // lyžařský areál (prototyp, ?areal=…), jinak null

// Natočení telefonu jako čtveřice [x, y, z, w] (telefon → svět, východ/sever/nahoru).
let gyro = null;      // bez kompasu (Android: deviceorientation, iPhone: deviceorientation)
let compass = null;   // s kompasem (Android: deviceorientationabsolute)
let heading = null;   // iPhone: webkitCompassHeading (stupně od magnetického severu)

const FRAME_MS = 1000 / 30;
const font = (size) => `bold ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const measureCache = new Map();

/** Šířka textu tučným písmem dané velikosti; volá ji C# při skládání popisků. */
window.windowSeatMeasure = (text, size) => {
    const key = size + '|' + text;
    let width = measureCache.get(key);
    if (width === undefined) {
        ctx.font = font(size);
        width = ctx.measureText(text).width;
        measureCache.set(key, width);
    }
    return width;
};

/**
 * Spuštění po klepnutí na tlačítko (o povolení senzorů a kamery už při klepnutí požádal permissions.js).
 * Vrací, co se povedlo a co ne, ať to stránka může ukázat.
 */
export async function start(dotnetRef, videoElement, canvasElement, statusElement, area) {
    dotnet = dotnetRef;
    video = videoElement;
    canvas = canvasElement;
    statusLine = statusElement;
    ctx = canvas.getContext('2d');

    const result = { motion: 'ok', camera: 'ok', location: 'ok' };

    // O povolení se žádá už při klepnutí (permissions.js); jinak teď, třeba na Androidu to projde i bez klepnutí.
    const permissions = window.windowSeatPermissions ?? window.windowSeatRequestPermissions();
    result.motion = await permissions.motion;

    window.addEventListener('deviceorientation', onOrientation, true);
    window.addEventListener('deviceorientationabsolute', onAbsoluteOrientation, true);

    try {
        video.srcObject = await permissions.camera;
        await video.play();
    } catch (e) {
        result.camera = 'chyba: ' + e.message;
    }

    // Chrome na Androidu náhled pozastaví, když se stránka schová (přepnutí aplikace, zhasnutý displej),
    // a sám ho nerozjede: zůstal by černý obraz, i když kamera běží.
    const resume = () => {
        if (video.srcObject && video.paused && document.visibilityState === 'visible')
            video.play().catch(() => { });
    };
    document.addEventListener('visibilitychange', resume);
    video.addEventListener('pause', () => setTimeout(resume, 300));

    if (area) {
        // Polohu v areálu řídí ski.js: GPS, nebo ukázkové stanoviště, když jsi jinde.
        ski = await import('./ski.js');
        await ski.init(dotnet, area, video);
    } else if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(
            p => dotnet.invokeMethod('OnLocation', p.coords.latitude, p.coords.longitude, p.coords.altitude, p.coords.accuracy, p.coords.speed),
            e => dotnet.invokeMethod('OnLocationError', e.message),
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    } else {
        result.location = 'nepodporováno';
    }

    // Ať displej při míření nezhasne.
    try {
        await navigator.wakeLock?.request('screen');
    } catch {
        // Bez zámku displeje to funguje taky.
    }

    resize();
    window.addEventListener('resize', resize);
    setupPointer();

    running = true;
    startedAt = performance.now();
    requestAnimationFrame(loop);
    return result;
}

function onOrientation(e) {
    if (e.alpha === null)
        return;

    gyro = quaternion(e.alpha, e.beta, e.gamma);

    // iPhone posílá kompas přímo v této události.
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading))
        heading = e.webkitCompassHeading;

    // Prohlížeče bez samostatné absolutní události: absolutní hodnota přijde tady.
    if (e.absolute === true)
        compass = gyro;
}

function onAbsoluteOrientation(e) {
    if (e.alpha !== null)
        compass = quaternion(e.alpha, e.beta, e.gamma);
}

/**
 * Čtveřice z úhlů alfa, beta, gama (pořadí Z-X'-Y'' podle specifikace W3C); výsledek obrazovka → svět.
 * Senzory dávají natočení telefonu; když prohlížeč stránku otočí na šířku, osy obrazovky jsou vůči telefonu
 * pootočené o úhel obrazovky, a ten se tu odečte.
 */
function quaternion(alpha, beta, gamma) {
    const d = Math.PI / 180;
    const x = beta * d / 2, y = gamma * d / 2, z = alpha * d / 2;
    const cx = Math.cos(x), cy = Math.cos(y), cz = Math.cos(z);
    const sx = Math.sin(x), sy = Math.sin(y), sz = Math.sin(z);
    const device = [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ];

    const angle = (screen.orientation?.angle ?? window.orientation ?? 0) * d;
    return multiply(device, [0, 0, Math.sin(-angle / 2), Math.cos(-angle / 2)]);
}

/** Součin čtveřic [x, y, z, w]: nejdřív b, pak a. */
function multiply(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function loop(time) {
    if (!running)
        return;

    requestAnimationFrame(loop);

    // Areál na počítači bez senzorů: telefon „drží“ simulace, ať jde výpočet a kreslení vyzkoušet i tam.
    if (!gyro && ski && time - startedAt > 1500) {
        // Simulace drží obrazovku rovně: otočení obrazovky, které quaternion() odečítá, se zase přičte.
        const a = ski.simulatedAngles();
        const angle = (screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI / 180;
        gyro = multiply(quaternion(a.alpha, a.beta, a.gamma), [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
    }
    if (time - lastFrame < FRAME_MS || !gyro)
        return;
    lastFrame = time;

    const scene = dotnet.invokeMethod('Frame', gyro, compass, heading, canvas.clientWidth, canvas.clientHeight);
    draw(scene);
}

// ---------- Dotyk: klepnutí vybere místo, tažení do stran posune popisky (kalibrace) ----------

function setupPointer() {
    let start = null;
    let dragging = false;

    canvas.addEventListener('pointerdown', e => {
        start = { x: e.clientX, y: e.clientY };
        dragging = false;
    });
    canvas.addEventListener('pointermove', e => {
        if (!start)
            return;
        const dx = e.clientX - start.x;
        if (!dragging && Math.abs(dx) > 12)
            dragging = true;
        if (dragging)
            dotnet.invokeMethod('OnDrag', dx, false);
    });
    canvas.addEventListener('pointerup', e => {
        if (!start)
            return;
        if (dragging)
            dotnet.invokeMethod('OnDrag', e.clientX - start.x, true);
        else
            dotnet.invokeMethodAsync('OnTap', e.clientX, e.clientY);
        start = null;
        dragging = false;
    });
}

// ---------- Kreslení scény ----------

function draw(scene) {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ski?.draw(ctx, scene.camera, canvas.clientWidth, canvas.clientHeight);

    for (const polygon of scene.water)
        drawPolygon(polygon, 'rgba(55,138,221,0.35)', 'rgba(255,255,255,0.55)', 1);
    for (const polygon of scene.bridges)
        drawPolygon(polygon, polygon.highlighted ? 'rgba(216,90,48,0.78)' : 'rgba(255,255,255,0.6)',
            polygon.highlighted ? '#712B13' : 'rgba(68,68,65,0.8)', polygon.highlighted ? 2 : 1);

    // Tenké čáry od rozestoupených ikonek vějíře ke skutečné poloze.
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    for (const m of scene.markers) {
        if (m.tx === null)
            continue;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.tx, m.ty);
        ctx.stroke();
    }

    for (const m of scene.markers)
        drawMarker(m);

    for (const l of scene.labels) {
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(l.ax, l.ay - 12);
        ctx.lineTo(l.ax, l.bottom + 2);
        ctx.stroke();
        outlinedText(l.text, l.cx, l.baseline, 15, 'black');
    }

    drawRing(scene);
    if (scene.focus)
        drawFocus(scene);

    if (scene.vibrate && navigator.vibrate)
        navigator.vibrate(15);
    if (statusLine && statusLine.textContent !== scene.status)
        statusLine.textContent = scene.status;
}

function drawPolygon(polygon, fill, stroke, width) {
    ctx.beginPath();
    for (const ring of polygon.rings) {
        ctx.moveTo(ring[0], ring[1]);
        for (let i = 2; i < ring.length; i += 2)
            ctx.lineTo(ring[i], ring[i + 1]);
        ctx.closePath();
    }
    ctx.fillStyle = fill;
    ctx.fill('evenodd');
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
}

function drawMarker(m) {
    ctx.globalAlpha = m.opacity;
    const s = m.size / 2;
    const x = m.x, y = m.y;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const fillShape = (points) => {
        ctx.beginPath();
        ctx.moveTo(x + points[0][0] * s, y + points[0][1] * s);
        for (const [px, py] of points.slice(1))
            ctx.lineTo(x + px * s, y + py * s);
        ctx.closePath();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.fillStyle = m.color;
        ctx.fill();
    };

    switch (m.kind) {
        case 'Peak':
            fillShape([[0, -1], [1, 0.8], [-1, 0.8]]);
            break;
        case 'Tower':
            fillShape([[0, -1.2], [0.4, -0.6], [0.4, 1], [-0.4, 1], [-0.4, -0.6]]);
            break;
        case 'Castle':
            fillShape([[-1, 0.8], [-1, -0.8], [-0.5, -0.8], [-0.5, -0.3], [-0.2, -0.3], [-0.2, -0.8], [0.2, -0.8], [0.2, -0.3],
                [0.5, -0.3], [0.5, -0.8], [1, -0.8], [1, 0.8]]);
            break;
        case 'Church':
            strokeLines([[[0, -1], [0, 1]], [[-0.6, -0.35], [0.6, -0.35]]], x, y, s, m.color, s * 0.45);
            break;
        case 'Bridge':
            ctx.beginPath();
            ctx.moveTo(x - s, y + s * 0.5);
            ctx.quadraticCurveTo(x, y - s * 1.1, x + s, y + s * 0.5);
            ctx.strokeStyle = 'white';
            ctx.lineWidth = s * 0.4 + 4;
            ctx.stroke();
            ctx.strokeStyle = m.color;
            ctx.lineWidth = s * 0.4;
            ctx.stroke();
            break;
        case 'CelestialBody':
            ctx.beginPath();
            ctx.arc(x, y, s + 2, 0, Math.PI * 2);
            ctx.fillStyle = 'white';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, s, 0, Math.PI * 2);
            ctx.fillStyle = m.color;
            ctx.fill();
            break;
        default:
            fillShape([[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]]);
            break;
    }
    ctx.globalAlpha = 1;

    // Kolik dalších míst se pod ikonkou schovalo.
    if (m.hidden > 0) {
        const bx = x + s + 4, by = y - s - 2;
        ctx.fillStyle = 'white';
        roundRect(bx - 2, by - 8, 26, 16, 8);
        ctx.fill();
        ctx.fillStyle = '#444441';
        ctx.font = font(11);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+' + m.hidden, bx + 11, by);
    }
}

function strokeLines(lines, x, y, s, color, width) {
    for (const [stroke, w] of [['white', width + 4], [color, width]]) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = w;
        for (const [[x1, y1], [x2, y2]] of lines) {
            ctx.beginPath();
            ctx.moveTo(x + x1 * s, y + y1 * s);
            ctx.lineTo(x + x2 * s, y + y2 * s);
            ctx.stroke();
        }
    }
}

function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawRing(scene) {
    const focused = scene.focus !== null;
    const width = focused ? 3 : 2;
    ctx.beginPath();
    ctx.arc(scene.cx, scene.cy, scene.ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = width + 2;
    ctx.stroke();
    ctx.strokeStyle = focused ? scene.focusColor : 'white';
    ctx.lineWidth = width;
    ctx.stroke();
}

function drawFocus(scene) {
    const f = scene.focus;
    const r = scene.ringRadius;
    outlinedText(f.name, scene.cx, scene.cy + r + 28, f.nameSize, scene.focusTextColor);
    outlinedText(f.detail, scene.cx, scene.cy + r + 50, 15, 'black');

    const dx = f.x - scene.cx, dy = f.y - scene.cy;
    const length = Math.hypot(dx, dy);
    if (length > r) {
        ctx.strokeStyle = scene.focusColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(scene.cx + dx / length * r, scene.cy + dy / length * r);
        ctx.lineTo(f.x, f.y);
        ctx.stroke();
    }
}

/** Písmo bez podkladu: bílý obrys a barevná výplň, čitelné na obloze i ve stínu. */
function outlinedText(text, x, baseline, size, color) {
    ctx.font = font(size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 4;
    ctx.strokeText(text, x, baseline);
    ctx.fillStyle = color;
    ctx.fillText(text, x, baseline);
}
