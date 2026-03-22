// Skill Capped Verification Module
class SkillCappedVerifyUI {
    constructor() {
        this.isAuthenticated = false;
        this.isPremium = false;
        this.billingEnabled = undefined;
        this.setupElements();
        this.setupEvents();
        this.refreshBillingEnabled();
    }

    setupElements() {
        this.verifyBtn = document.getElementById('skillcapped-verify-btn');
        this.verifyBtnLabel = this.verifyBtn?.querySelector('.filter-label');
        this.verifyBtnIcon = this.verifyBtn?.querySelector('.filter-icon');
        this.modal = null;
    }

    setupEvents() {
        this.verifyBtn?.addEventListener('click', async () => {
            const refreshResult = await this.refreshBillingEnabled();
            if (!refreshResult?.success) {
                NotificationManager.show(
                    refreshResult?.error || 'Failed to check premium options. Please try again.',
                    'error'
                );
                return;
            }
            const billingEnabled = this.billingEnabled === true;
            if (!this.isAuthenticated) {
                // Show toast when not logged in
                NotificationManager.show('Please log in with Battle.net first', 'info');
                return;
            }

            if (this.isPremium) {
                // Already premium - just show confirmation
                NotificationManager.show('Premium is already active on your account!', 'success');
                return;
            }

            // Disable button and show loading state during check
            const originalText = this.verifyBtnLabel?.textContent || (billingEnabled ? 'Get Premium' : 'Verify Skill Capped');
            const wasDisabled = this.verifyBtn.disabled;
            this.verifyBtn.disabled = true;
            this.verifyBtn.setAttribute('aria-busy', 'true');
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = 'Checking...';
            }

            let isPremiumOnServer = false;
            let shouldRestoreButtonState = true;
            try {
                if (billingEnabled) {
                    const refreshStatus = await window.arenaCoach.refreshBillingStatus();
                    if (!refreshStatus?.success) {
                        this.updateButtonState();
                        NotificationManager.show(
                            refreshStatus?.error || 'Failed to refresh billing status.',
                            'error'
                        );
                        shouldRestoreButtonState = false;
                        return;
                    }
                    this.updateButtonState();

                    if (this.isPremium) {
                        isPremiumOnServer = true;
                        NotificationManager.show('Premium is already active on your account!', 'success');
                        return;
                    }

                    const stillAuthed = await window.arenaCoach.auth.isAuthenticated();
                    if (!stillAuthed) {
                        this.updateButtonState();
                        NotificationManager.show('Session expired. Please log in again.', 'info');
                        shouldRestoreButtonState = false;
                        return;
                    }

                    const loginResult = await window.arenaCoach.auth.getWebLoginUrl();
                    if (loginResult?.success && loginResult.url) {
                        window.arenaCoach.window.openExternal(loginResult.url);
                        return;
                    }
                    NotificationManager.show(
                        loginResult?.error || 'Failed to open premium signup.',
                        'error'
                    );
                } else {
                    const statusResult = await window.arenaCoach.auth.getSkillCappedStatus();

                    if (statusResult.success && statusResult.verified) {
                        // Server confirms already verified
                        isPremiumOnServer = true;
                        // The main process will emit auth:success which updates UI state
                        // We just show the notification here
                        NotificationManager.show('Premium is already active on your account!', 'success');
                    } else {
                        // Re-check auth via IPC (authoritative, 401 may have triggered logout)
                        const stillAuthed = await window.arenaCoach.auth.isAuthenticated();
                        if (!stillAuthed) {
                            this.updateButtonState();
                            NotificationManager.show('Session expired. Please log in again.', 'info');
                            shouldRestoreButtonState = false;
                            return;
                        }
                        // Not verified on server - show verification modal
                        this.showVerificationModal();
                    }
                }
            } catch (error) {
                console.error('Failed to check premium status:', error);
                // Re-check auth via IPC before reporting error
                const stillAuthed = await window.arenaCoach.auth.isAuthenticated();
                if (!stillAuthed) {
                    this.updateButtonState();
                    NotificationManager.show('Session expired. Please log in again.', 'info');
                    shouldRestoreButtonState = false;
                    return;
                }
                NotificationManager.show('Failed to check premium status. Please try again.', 'error');
            } finally {
                this.verifyBtn.removeAttribute('aria-busy');
                if (isPremiumOnServer) {
                    // Explicitly set verified state (don't rely on auth:success which may not fire)
                    this.isPremium = true;
                    this.verifyBtn.disabled = false;
                    this.verifyBtn.title = 'Premium Active';
                    if (this.verifyBtnLabel) {
                        this.verifyBtnLabel.textContent = 'Premium Active';
                    }
                    this.verifyBtn.classList.add('verified');
                } else if (shouldRestoreButtonState && !this.isPremium) {
                    // Restore pre-click state (not verified, not logged out)
                    this.verifyBtn.disabled = wasDisabled;
                    if (this.verifyBtnLabel) {
                        this.verifyBtnLabel.textContent = originalText;
                    }
                }
                // If logged out, updateButtonState() already set correct state
            }
        });
    }

    async refreshBillingEnabled() {
        try {
            const result = await window.arenaCoach.getBillingEnabled();
            if (!result?.success) {
                this.billingEnabled = undefined;
                this.updateButtonState();
                return { success: false, error: result?.error || 'Failed to fetch billing settings.' };
            }
            this.billingEnabled = result.billingEnabled === true;
            this.updateButtonState();
            return { success: true };
        } catch (error) {
            this.billingEnabled = undefined;
            this.updateButtonState();
            return { success: false, error: 'Failed to fetch billing settings.' };
        }
    }

    updateButtonState() {
        // Get current auth state from AuthUI
        const authUI = window.app?.renderer?.authUI;
        this.isAuthenticated = !!authUI?.isAuthenticated;
        // Preserve undefined vs false distinction for truthful UI
        const verifiedStatus = authUI?.currentUser?.is_premium;
        const billingEnabled = this.billingEnabled;
        const billingKnown = billingEnabled === true || billingEnabled === false;
        this.isPremium = verifiedStatus === true;
        const isUnknown = verifiedStatus === undefined && this.isAuthenticated;

        if (!this.verifyBtn) return;

        // Swap icon when billing is enabled
        if (this.verifyBtnIcon && billingEnabled) {
            this.verifyBtnIcon.src = 'images/crown.svg';
        }

        if (!this.isAuthenticated) {
            // Not logged in state - button still clickable to show toast
            this.verifyBtn.disabled = false;
            if (!billingKnown) {
                this.verifyBtn.title = 'Log in with Battle.net to manage premium';
            } else {
                this.verifyBtn.title = billingEnabled
                    ? 'Log in with Battle.net to get premium'
                    : 'Log in with Battle.net to verify';
            }
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = billingKnown
                    ? (billingEnabled ? 'Get Premium' : 'Verify Skill Capped')
                    : 'Premium';
            }
            this.verifyBtn.classList.remove('verified');
        } else if (this.isPremium) {
            // Premium state - green text
            this.verifyBtn.disabled = false;
            this.verifyBtn.title = 'Premium Active';
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = 'Premium Active';
            }
            this.verifyBtn.classList.add('verified');
        } else if (isUnknown) {
            // Unknown state - keep copy aligned with available billing options
            this.verifyBtn.disabled = false;
            if (!billingKnown) {
                this.verifyBtn.title = 'Premium status unknown';
                if (this.verifyBtnLabel) {
                    this.verifyBtnLabel.textContent = 'Premium';
                }
            } else if (billingEnabled) {
                this.verifyBtn.title = 'Click to get premium';
                if (this.verifyBtnLabel) {
                    this.verifyBtnLabel.textContent = 'Get Premium';
                }
            } else {
                this.verifyBtn.title = 'Click to verify your Skill Capped account';
                if (this.verifyBtnLabel) {
                    this.verifyBtnLabel.textContent = 'Verify Skill Capped';
                }
            }
            this.verifyBtn.classList.remove('verified');
        } else {
            // Not verified state (explicitly false)
            this.verifyBtn.disabled = false;
            if (!billingKnown) {
                this.verifyBtn.title = 'Premium status unknown';
            } else {
                this.verifyBtn.title = billingEnabled
                    ? 'Click to get premium'
                    : 'Click to verify your Skill Capped account';
            }
            if (this.verifyBtnLabel) {
                this.verifyBtnLabel.textContent = billingKnown
                    ? (billingEnabled ? 'Get Premium' : 'Verify Skill Capped')
                    : 'Premium';
            }
            this.verifyBtn.classList.remove('verified');
        }
    }

    showVerificationModal() {
        // Remove existing modal if any
        if (this.modal) {
            this.modal.remove();
        }

        // Hide native OBS preview so modal is visible above it
        this._previewHidePromise = window.arenaCoach?.obs?.preview?.hide?.()
            ?.catch?.(err => console.warn('[SkillCappedVerifyUI] Failed to hide preview:', err));

        // Use unified modal structure (same as delete confirmation)
        this.modal = document.createElement('div');
        this.modal.className = 'app-modal';

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'modal-dialog';

        const title = document.createElement('h3');
        title.textContent = 'Verify Skill Capped Account';

        const instructions = document.createElement('p');
        instructions.textContent = 'Enter your Skill Capped verification code:';

        // Code input (uses unified modal-dialog input styles)
        const codeInput = document.createElement('input');
        codeInput.type = 'text';
        codeInput.placeholder = 'Enter verification code';
        codeInput.style.marginTop = '2px';

        const helpText = document.createElement('p');
        helpText.className = 'modal-help-text';
        const skillCappedLink = document.createElement('a');
        skillCappedLink.href = '#';
        skillCappedLink.textContent = 'Skill-Capped';
        skillCappedLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.arenaCoach.window.openExternal(
                'https://www.skill-capped.com/wow/pricing/plans#arenacoach'
            );
        });

        helpText.appendChild(document.createTextNode("Don't have a code? Subscribe on "));
        helpText.appendChild(skillCappedLink);

        // Error message container (only visible when there's an error)
        const errorMsg = document.createElement('div');
        errorMsg.className = 'modal-error';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this.closeModal());

        const verifyBtn = document.createElement('button');
        verifyBtn.className = 'btn';
        verifyBtn.textContent = 'Verify';
        verifyBtn.addEventListener('click', async () => {
            const code = codeInput.value.trim();
            if (!code) {
                errorMsg.textContent = 'Please enter a verification code';
                return;
            }

            // Disable form while submitting
            codeInput.disabled = true;
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Verifying...';
            errorMsg.textContent = '';

            try {
                // Call IPC to verify
                const result = await window.arenaCoach.auth.verifySkillCapped(code);

                if (result.success) {
                    // Success! Close modal immediately
                    this.closeModal();

                    // Show success notification
                    NotificationManager.show('Skill Capped account verified successfully!', 'success');

                    // The auth:success event from main.ts will handle:
                    // - Updating AuthUI state
                    // - Updating button states
                    // - Refreshing UI components
                    // This prevents duplicate updates and notifications
                } else {
                    // Show error
                    errorMsg.textContent = result.error || 'Verification failed. Please check your code.';
                    codeInput.disabled = false;
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'Verify';
                }
            } catch (error) {
                console.error('Verification error:', error);
                errorMsg.textContent = 'An error occurred. Please try again.';
                codeInput.disabled = false;
                verifyBtn.disabled = false;
                verifyBtn.textContent = 'Verify';
            }
        });

        // Enter key support
        codeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !verifyBtn.disabled) {
                verifyBtn.click();
            }
        });

        // Close on backdrop click
        backdrop.addEventListener('click', () => this.closeModal());

        actions.append(cancelBtn, verifyBtn);
        dialog.append(title, instructions, codeInput, helpText, errorMsg, actions);
        this.modal.append(backdrop, dialog);

        document.body.appendChild(this.modal);

        // Focus input
        codeInput.focus();
    }

    closeModal() {
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        // Re-show native OBS preview after hide has settled (if scene is still active)
        const showPreview = () => {
            const sceneUI = window.app?.renderer?.sceneUI;
            if (!sceneUI?.isVisible || !sceneUI.previewInitialized) return;
            try {
                const bounds = sceneUI.getPreviewBounds();
                window.arenaCoach?.obs?.preview?.show?.(bounds)
                    ?.catch?.(err => console.warn('[SkillCappedVerifyUI] Failed to show preview:', err));
            } catch (err) {
                console.warn('[SkillCappedVerifyUI] Failed to get preview bounds:', err);
            }
        };
        if (this._previewHidePromise) {
            this._previewHidePromise.finally(showPreview);
            this._previewHidePromise = null;
        } else {
            showPreview();
        }
    }

    // Called when auth state changes
    onAuthStateChange() {
        this.updateButtonState();
        // Close modal if logged out (prevents stale verification UI)
        if (!this.isAuthenticated) {
            this.closeModal();
        }
    }
}
