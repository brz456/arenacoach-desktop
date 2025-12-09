/**
 * OBSPreviewManager - Manages OBS preview overlay for the Scene tab
 * Handles preview display creation, positioning, and lifecycle
 */

import { BrowserWindow } from 'electron';
import * as osn from 'obs-studio-node';
import { IScene } from 'obs-studio-node';

/**
 * Preview bounds interface matching renderer calculations
 */
export interface PreviewBounds {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Manages OBS preview display for Scene tab
 */
export class OBSPreviewManager {
  private static readonly PREVIEW_NAME = 'scene-preview';
  private static readonly OFFSCREEN_X = 50000;
  private static readonly OFFSCREEN_Y = 50000;
  
  private mainWindow: BrowserWindow | null = null;
  private scene: IScene | null = null;
  private previewCreated = false;
  private isVisible = false;

  /**
   * Set the main window reference for native handle access
   */
  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
    console.log('[OBSPreviewManager] Main window set');
  }

  /**
   * Set the scene to preview
   */
  public setScene(scene: IScene): void {
    this.scene = scene;
    console.log('[OBSPreviewManager] Scene set:', scene.name);
  }

  /**
   * Show the preview at specified bounds
   */
  public async showPreview(bounds: PreviewBounds): Promise<void> {
    if (!this.mainWindow || !this.scene) {
      const error = new Error('Preview not initialized: missing window or scene');
      (error as any).code = 'PREVIEW_NOT_INITIALIZED';
      throw error;
    }

    // Create preview display if needed
    if (!this.previewCreated) {
      await this.createPreviewDisplay();
    }

    // Make visible
    this.isVisible = true;
    
    osn.NodeObs.OBS_content_moveDisplay(
      OBSPreviewManager.PREVIEW_NAME,
      bounds.x,
      bounds.y
    );
    
    osn.NodeObs.OBS_content_resizeDisplay(
      OBSPreviewManager.PREVIEW_NAME,
      bounds.width,
      bounds.height
    );
    
    console.log('[OBSPreviewManager] Preview shown at:', bounds);
  }

  /**
   * Update preview bounds (for resize events)
   */
  public async updatePreviewBounds(bounds: PreviewBounds): Promise<void> {
    if (!this.previewCreated || !this.isVisible) {
      return;
    }
    
    osn.NodeObs.OBS_content_moveDisplay(
      OBSPreviewManager.PREVIEW_NAME,
      bounds.x,
      bounds.y
    );
    
    osn.NodeObs.OBS_content_resizeDisplay(
      OBSPreviewManager.PREVIEW_NAME,
      bounds.width,
      bounds.height
    );
  }

  /**
   * Hide the preview (move offscreen)
   */
  public hidePreview(): void {
    if (!this.previewCreated) {
      return;
    }

    this.isVisible = false;
    
    // Move preview offscreen instead of destroying
    osn.NodeObs.OBS_content_moveDisplay(
      OBSPreviewManager.PREVIEW_NAME,
      OBSPreviewManager.OFFSCREEN_X,
      OBSPreviewManager.OFFSCREEN_Y
    );
    
    console.log('[OBSPreviewManager] Preview hidden');
  }

  /**
   * Move the preview display offscreen (for shutdown)
   */
  public destroyPreview(): void {
    if (!this.previewCreated) {
      return;
    }

    try {
      // Avoid destroying the display; move it offscreen and mark as inactive.
      osn.NodeObs.OBS_content_moveDisplay(
        OBSPreviewManager.PREVIEW_NAME,
        OBSPreviewManager.OFFSCREEN_X,
        OBSPreviewManager.OFFSCREEN_Y
      );
      this.isVisible = false;
      this.previewCreated = false;
      console.log('[OBSPreviewManager] Preview deactivated');
    } catch (error) {
      console.error('[OBSPreviewManager] Error deactivating preview:', error);
    }
  }

  /**
   * Create the preview display
   */
  private async createPreviewDisplay(): Promise<void> {
    if (!this.mainWindow || !this.scene) {
      const error = new Error('Cannot create preview: missing window or scene');
      (error as any).code = 'PREVIEW_NOT_INITIALIZED';
      throw error;
    }

    try {
      // Get native window handle
      const windowHandle = this.mainWindow.getNativeWindowHandle();
      
      // Create preview display with scene NAME (not id)
      osn.NodeObs.OBS_content_createSourcePreviewDisplay(
        windowHandle,
        this.scene.name,  // Use scene NAME, not id
        OBSPreviewManager.PREVIEW_NAME
      );
      
      // Initialize display settings
      osn.NodeObs.OBS_content_resizeDisplay(OBSPreviewManager.PREVIEW_NAME, 0, 0);
      osn.NodeObs.OBS_content_setShouldDrawUI(OBSPreviewManager.PREVIEW_NAME, false);
      osn.NodeObs.OBS_content_setPaddingSize(OBSPreviewManager.PREVIEW_NAME, 0);
      osn.NodeObs.OBS_content_setPaddingColor(OBSPreviewManager.PREVIEW_NAME, 0, 0, 0);
      
      this.previewCreated = true;
      console.log('[OBSPreviewManager] Preview display created');
    } catch (error) {
      console.error('[OBSPreviewManager] Failed to create preview display:', error);
      const createError = new Error('Failed to create OBS preview display');
      (createError as any).code = 'PREVIEW_CREATION_FAILED';
      throw createError;
    }
  }
}