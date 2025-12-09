// Asset Mapping Utilities for Card-Based UI
class AssetManager {
    static getMapImagePath(mapId) {
        if (!mapId) return null;

        const mapKey = window.AssetMappings?.getMapImageFilename?.(mapId);
        return mapKey ? `images/maps/${mapKey}.webp` : null;
    }

    static getSpecIconPath(specId) {
        if (!specId) return null;

        const specKey = window.AssetMappings?.getSpecIconFilename?.(specId);
        return specKey ? `images/specs/${specKey}.jpg` : null;
    }

    static getClassIconPath(className) {
        if (!className) return 'images/classes/wow_icon.png';

        const classMapping = {
            'deathknight': 'dk',
            'demonhunter': 'dh'
        };

        const classKey = classMapping[className.toLowerCase()] || className.toLowerCase();
        return `images/classes/${classKey}.webp`;
    }

    static getRatingIconPath(rating) {
        const numRating = Number(rating);
        if (!Number.isFinite(numRating) || numRating < 1400) return null;

        if (numRating >= 2400) return 'images/ranks/elite.webp';
        if (numRating >= 2100) return 'images/ranks/duelist.webp';
        if (numRating >= 1800) return 'images/ranks/rival.webp';
        if (numRating >= 1600) return 'images/ranks/challenger.webp';
        return 'images/ranks/combatant.webp';
    }

    /**
     * Create SVG icon with consistent attributes and secure DOM construction
     * @param {Object} options - SVG configuration options
     * @param {string} options.pathData - SVG path data for the icon
     * @param {number} [options.width=14] - SVG width
     * @param {number} [options.height=14] - SVG height
     * @param {string} [options.viewBox='0 0 24 24'] - SVG viewBox
     * @param {string} [options.fill='currentColor'] - SVG fill color
     * @returns {SVGElement} Configured SVG element
     */
    static createSvgIcon({ pathData, width = 14, height = 14, viewBox = '0 0 24 24', fill = 'currentColor' }) {
        // Create SVG using secure DOM construction
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', width.toString());
        svg.setAttribute('height', height.toString());
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('fill', fill);

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);

        svg.appendChild(path);
        return svg;
    }
}

// Make AssetManager globally available for VideoPlayer
window.AssetManager = AssetManager;
