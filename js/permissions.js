// iPhone povolí senzory pohybu a kameru jen přímo v obsluze klepnutí. Blazor ale klepnutí obslouží asynchronně
// (a modul windowseat.js se teprve načítá), takže o povolení požádáme hned tady a windowseat.js převezme výsledky.

window.windowSeatRequestPermissions = () => ({
    motion: typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'
        ? DeviceOrientationEvent.requestPermission().catch(e => 'chyba: ' + e.message)
        : Promise.resolve('ok'),
    camera: navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
        })
        : Promise.reject(new Error('nepodporováno')),
});

// Zachycení ještě před Blazorem, dokud klepnutí platí.
document.addEventListener('click', e => {
    if (e.target.closest?.('.start button') && !window.windowSeatPermissions) {
        window.windowSeatPermissions = window.windowSeatRequestPermissions();
        window.windowSeatPermissions.camera.catch(() => { }); // chybu ukáže až start()
    }
}, true);
