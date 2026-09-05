/* રિમોટ વિડિયો કંટ્રોલ — PWA helper
   - Service Worker રજીસ્ટર કરે (ઇન્સ્ટોલ/ઓફલાઇન માટે)
   - "ઇન્સ્ટોલ કરો" બટન (Android/Chrome: beforeinstallprompt; iPhone: સૂચના)
   - રૂમ કોડ/રોલ યાદ રાખે (localStorage) */
(function () {
  'use strict';

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  // ---- Service Worker ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  // ---- Install prompt ----
  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    document.querySelectorAll('[data-rvc-install]').forEach(function (b) {
      b.style.display = '';
    });
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    document.querySelectorAll('[data-rvc-install]').forEach(function (b) {
      b.style.display = 'none';
    });
  });

  function installIOSHint() {
    alert('iPhone માં ઇન્સ્ટોલ કરવા માટે:\n\n1) નીચે સફરશી (Share) ⬆️ બટન દબાવો\n2) "Add to Home Screen" / "હોમ સ્ક્રીનમાં ઉમેરો" પસંદ કરો\n3) Add દબાવો — હોમ સ્ક્રીનમાં એપ આવી જશે.');
  }

  // બટન પર click handler લગાવો
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-rvc-install]').forEach(function (b) {
      // iOS માં hint બટન હંમેશા બતાવો; Android માં install-prompt મળે તો જ
      if ((isIOS && !deferredPrompt) || deferredPrompt) b.style.display = '';
      b.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
        } else if (isIOS) {
          installIOSHint();
        }
      });
    });
  });

  // ---- રૂમ/રોલ યાદ રાખો ----
  window.rvcSaveSession = function (room, role) {
    try { localStorage.setItem('rvc-room', room || ''); localStorage.setItem('rvc-role', role || ''); } catch (e) {}
  };
  window.rvcGetSession = function () {
    try { return { room: localStorage.getItem('rvc-room') || '', role: localStorage.getItem('rvc-role') || '' }; }
    catch (e) { return { room: '', role: '' }; }
  };
})();
