// Notification System
class NotificationManager {
    static show(message, type = 'info', duration = 4000) {
        // Don't show notifications when Scene tab is active (OBS preview blocks them)
        if (window.app?.renderer?.navigationManager?.currentView === 'scene') {
            return;
        }

        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;

        // Create content structure safely
        const content = document.createElement('div');
        content.className = 'notification-content';

        const messageSpan = document.createElement('span');
        messageSpan.className = 'notification-message';
        messageSpan.textContent = message; // Use textContent to prevent XSS

        const closeBtn = document.createElement('button');
        closeBtn.className = 'notification-close';
        closeBtn.innerHTML = '&times;'; // Safe static HTML entity

        content.append(messageSpan, closeBtn);
        notification.appendChild(content);

        // Add to document
        document.body.appendChild(notification);

        // Auto-remove after duration
        const autoRemove = setTimeout(() => {
            this.remove(notification);
        }, duration);

        // Manual close button
        closeBtn.addEventListener('click', () => {
            clearTimeout(autoRemove);
            this.remove(notification);
        });

        // Trigger animation
        requestAnimationFrame(() => {
            notification.classList.add('notification-show');
        });
    }

    static remove(notification) {
        notification.classList.add('notification-hide');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }

    static clearAll() {
        const notifications = document.querySelectorAll('.notification');
        notifications.forEach(n => {
            if (n.parentNode) {
                n.parentNode.removeChild(n);
            }
        });
    }
}