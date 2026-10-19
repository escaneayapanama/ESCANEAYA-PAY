// Service Worker para Firebase Cloud Messaging (FCM)
// EscaneaYa Pay — notificaciones push

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDEMO_REPLACE_WITH_REAL_KEY",
  authDomain: "escaneayapay.firebaseapp.com",
  projectId: "escaneayapay",
  storageBucket: "escaneayapay.appspot.com",
  messagingSenderId: "REPLACE_WITH_SENDER_ID",
  appId: "REPLACE_WITH_APP_ID"
});

const messaging = firebase.messaging();

// Manejar notificaciones cuando la app está en segundo plano o cerrada
messaging.onBackgroundMessage(function(payload) {
  console.log('[SW] Notificación en background:', payload);

  var title = payload.notification?.title || 'EscaneaYa Pay';
  var body  = payload.notification?.body  || 'Tienes una nueva actividad';
  var icon  = '/icons/icon-192.png';
  var badge = '/icons/icon-192.png';
  var data  = payload.data || {};

  var options = {
    body: body,
    icon: icon,
    badge: badge,
    vibrate: [200, 100, 200],
    data: data,
    actions: [
      { action: 'open', title: '📊 Ver dashboard' }
    ]
  };

  self.registration.showNotification(title, options);
});

// Clic en la notificación → abre el dashboard
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = 'https://escaneayapay.com/dashboard-eyp.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes('dashboard-eyp') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
