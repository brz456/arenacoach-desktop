// ArenaCoach Desktop App - Renderer Process
// This file handles UI interactions and communicates with the main process
// Following modular architecture as recommended by zen consensus

// Fix for Electron drag region ReferenceError - must be defined before HTML processing
window.dragEvent = null;

// Prevent drag events from causing errors in the title bar drag area
document.addEventListener('dragstart', (e) => {
    // Prevent default drag behavior on elements that shouldn't be dragged
    if (!e.target.closest('.title-bar-drag-area')) {
        e.preventDefault();
    }
});

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Create a single namespace to avoid global namespace pollution
    window.app = {};
    window.app.renderer = new ArenaCoachRenderer();
    // NavigationManager is now created inside ArenaCoachRenderer after all components are ready
    window.app.navigation = window.app.renderer.navigationManager;
});